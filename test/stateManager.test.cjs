'use strict';

const { vscode } = require('./helpers/bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const { StateManager } = require('../src/models/stateManager');

function fakeGit(overrides) {
    return Object.assign({
        isRepository: async () => true,
        getRepoRoot: async folderPath => folderPath,
        getGitDir: async folderPath => `${folderPath}/.git`,
        getBranches: async () => [{ name: 'main', refName: 'refs/heads/main', isRemote: false, isCurrent: true }],
        getStashes: async () => [],
        getWorkTrees: async () => [],
        getTags: async () => [],
        getCurrentBranch: async () => 'main',
        getHeadCommit: async () => 'abc1234',
        fetchRemote: async () => {}
    }, overrides);
}

function workspaceFolder(fsPath) {
    return { uri: { fsPath } };
}

async function withStateManager(git, folders, fn) {
    vscode._reset();
    // Avoid background fetch timers leaking out of the test.
    vscode._settings.set('gitfocal.autoFetchIntervalMinutes', 0);
    vscode.workspace.workspaceFolders = folders;
    const sm = new StateManager(git);
    try {
        await sm.initialize();
        await fn(sm);
    } finally {
        sm.dispose();
        vscode._reset();
    }
}

test('initialize loads state for each workspace repo', async () => {
    await withStateManager(fakeGit(), [workspaceFolder('/repo')], async sm => {
        const states = sm.getStates();
        assert.equal(states.length, 1);
        const state = states[0];
        assert.equal(state.repoPath, '/repo');
        assert.equal(state.currentBranch, 'main');
        assert.equal(state.branches.length, 1);
        assert.equal(state.error, undefined);
        assert.equal(state.version, 1);
        assert.equal(state.detachedCommit, undefined);
    });
});

test('non-repository folders are skipped', async () => {
    const git = fakeGit({ isRepository: async () => false });
    await withStateManager(git, [workspaceFolder('/not-a-repo')], async sm => {
        assert.equal(sm.getStates().length, 0);
    });
});

test('multiple workspace folders in the same repo collapse to one entry', async () => {
    const git = fakeGit({ getRepoRoot: async () => '/repo' });
    const folders = [workspaceFolder('/repo'), workspaceFolder('/repo/packages/app')];
    await withStateManager(git, folders, async sm => {
        assert.equal(sm.getStates().length, 1);
        assert.equal(sm.getStates()[0].repoPath, '/repo');
    });
});

test('detached HEAD is captured as a short commit', async () => {
    const git = fakeGit({ getCurrentBranch: async () => 'HEAD' });
    await withStateManager(git, [workspaceFolder('/repo')], async sm => {
        const state = sm.getStates()[0];
        assert.equal(state.currentBranch, 'HEAD');
        assert.equal(state.detachedCommit, 'abc1234');
    });
});

test('refresh failures keep previous data and surface the error', async () => {
    let fail = false;
    const git = fakeGit({
        getBranches: async () => {
            if (fail) {
                throw new Error('boom');
            }
            return [{ name: 'main', refName: 'refs/heads/main', isRemote: false, isCurrent: true }];
        }
    });
    await withStateManager(git, [workspaceFolder('/repo')], async sm => {
        fail = true;
        await sm.refresh('/repo');
        const state = sm.getStates()[0];
        assert.equal(state.error, 'boom');
        // Previous branches are retained.
        assert.equal(state.branches.length, 1);
        assert.equal(state.version, 2);
    });
});

test('matchRepoPath resolves nested paths to the repo root', async () => {
    await withStateManager(fakeGit(), [workspaceFolder('/repo')], async sm => {
        assert.equal(sm.matchRepoPath('/repo'), '/repo');
        assert.equal(sm.matchRepoPath('/repo/src/utils'), '/repo');
        assert.equal(sm.matchRepoPath('/elsewhere'), undefined);
    });
});

test('the git-dir watcher pattern covers linked worktree metadata', async () => {
    await withStateManager(fakeGit(), [workspaceFolder('/repo')], async () => {
        assert.equal(vscode._createdWatchers.length, 1);
        const { pattern } = vscode._createdWatchers[0];
        assert.equal(pattern.base, '/repo/.git');
        assert.ok(pattern.pattern.includes('HEAD'));
        // Linked worktrees keep their HEAD/index under <git-dir>/worktrees/.
        assert.ok(pattern.pattern.includes('worktrees/**'));
    });
});

test('dispose releases watchers', async () => {
    let watcher;
    await withStateManager(fakeGit(), [workspaceFolder('/repo')], async () => {
        watcher = vscode._createdWatchers[0];
        assert.ok(watcher);
        assert.equal(watcher.disposed, false);
    });
    assert.equal(watcher.disposed, true);
});
