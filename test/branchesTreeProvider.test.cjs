'use strict';

const { vscode } = require('./helpers/bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const { BranchesTreeProvider } = require('../src/providers/branchesTreeProvider');
const { createRepositoryState } = require('../src/models/repositoryState');
const branchesFilter = require('../src/models/branchesFilter');

function branch(overrides) {
    return Object.assign({
        name: 'main',
        refName: 'refs/heads/main',
        isRemote: false,
        isCurrent: false,
        isTracking: false,
        upstream: undefined,
        upstreamGone: false,
        aheadBehind: { ahead: 0, behind: 0 },
        commitHash: 'abc1234',
        commitHashFull: 'abc1234abc1234abc1234abc1234abc1234abc12',
        committerDate: 0
    }, overrides);
}

function makeState(init) {
    return createRepositoryState(Object.assign({
        repoPath: '/repo',
        branches: [],
        stashes: [],
        workTrees: [],
        tags: [],
        currentBranch: 'main',
        version: 1
    }, init));
}

/** Minimal StateManager double backed by a fixed list of states. */
function fakeStateManager(states) {
    const emitter = new vscode.EventEmitter();
    return {
        onDidChange: emitter.event,
        getStates: () => states,
        getState: repoPath => states.find(s => s.repoPath === repoPath),
        _emitter: emitter
    };
}

function withProvider(states, fn) {
    const stateManager = fakeStateManager(states);
    const provider = new BranchesTreeProvider(stateManager, /* git */ undefined);
    try {
        return fn(provider, stateManager);
    } finally {
        provider.dispose();
        branchesFilter.clear();
    }
}

const TWO_WORKTREES = [
    { path: '/repo', branch: 'refs/heads/main', head: 'aaaa', isDetached: false, isBare: false, isLocked: false, isPrunable: false, isMain: true },
    { path: '/repo-feature', branch: 'refs/heads/feature/x', head: 'bbbb', isDetached: false, isBare: false, isLocked: true, lockedReason: 'wip', isPrunable: false, isMain: false }
];

test('root lists sorted local branches for a single repo', () => {
    const state = makeState({
        branches: [
            branch({ name: 'zeta', refName: 'refs/heads/zeta' }),
            branch({ name: 'alpha', refName: 'refs/heads/alpha' }),
            branch({ name: 'origin/main', refName: 'refs/remotes/origin/main', isRemote: true })
        ]
    });
    withProvider([state], provider => {
        const children = provider.getChildren();
        assert.deepEqual(children.map(c => c.kind), ['branch', 'branch']);
        assert.deepEqual(children.map(c => c.label), ['alpha', 'zeta']);
    });
});

test('root shows one node per repo when multiple repos are open', () => {
    const states = [makeState({ repoPath: '/repo-a' }), makeState({ repoPath: '/repo-b' })];
    withProvider(states, provider => {
        const children = provider.getChildren();
        assert.deepEqual(children.map(c => c.kind), ['repo', 'repo']);
        assert.deepEqual(children.map(c => c.label), ['repo-a', 'repo-b']);
    });
});

test('sortBy commitDate orders branches by most recent commit', () => {
    vscode._settings.set('gitfocal.branches.sortBy', 'commitDate');
    const state = makeState({
        branches: [
            branch({ name: 'old', refName: 'refs/heads/old', committerDate: 100 }),
            branch({ name: 'new', refName: 'refs/heads/new', committerDate: 200 })
        ]
    });
    try {
        withProvider([state], provider => {
            const children = provider.getChildren();
            assert.deepEqual(children.map(c => c.label), ['new', 'old']);
        });
    } finally {
        vscode._settings.delete('gitfocal.branches.sortBy');
    }
});

test('branches filter narrows the local branch list', () => {
    const state = makeState({
        branches: [
            branch({ name: 'feature/login', refName: 'refs/heads/feature/login' }),
            branch({ name: 'main', refName: 'refs/heads/main' })
        ]
    });
    withProvider([state], provider => {
        branchesFilter.set('login');
        const children = provider.getChildren();
        assert.deepEqual(children.map(c => c.label), ['feature/login']);
    });
});

test('detached HEAD adds a warning entry at the top', () => {
    const state = makeState({
        branches: [branch()],
        currentBranch: 'HEAD',
        detachedCommit: 'abc1234'
    });
    withProvider([state], provider => {
        const children = provider.getChildren();
        assert.equal(children[0].kind, 'detachedHead');
        assert.equal(children[0].label, 'Detached HEAD at abc1234');
    });
});

test('worktrees group appears only with more than one worktree', () => {
    const single = makeState({ workTrees: [TWO_WORKTREES[0]] });
    const multi = makeState({ workTrees: TWO_WORKTREES });
    withProvider([single], provider => {
        assert.equal(provider.getChildren().some(c => c.kind === 'group'), false);
    });
    withProvider([multi], provider => {
        const group = provider.getChildren().find(c => c.kind === 'group');
        assert.ok(group);
        assert.equal(group.groupKey, 'worktrees');
    });
});

test('worktrees group expands to one node per worktree', () => {
    const state = makeState({ workTrees: TWO_WORKTREES });
    withProvider([state], provider => {
        const group = provider.getChildren().find(c => c.kind === 'group');
        const nodes = provider.getChildren(group);
        assert.deepEqual(nodes.map(n => n.kind), ['workTree', 'workTree']);
        assert.deepEqual(nodes.map(n => n.label), ['repo', 'repo-feature']);
    });
});

test('a worktree node lists the branch checked out in it', () => {
    const state = makeState({
        branches: [
            branch({ name: 'main', workTreePath: '/repo' }),
            branch({ name: 'feature/x', refName: 'refs/heads/feature/x', workTreePath: '/repo-feature', checkedOutInOtherWorktree: true })
        ],
        workTrees: TWO_WORKTREES
    });
    withProvider([state], provider => {
        const node = { kind: 'workTree', repoPath: '/repo', workTree: TWO_WORKTREES[1] };
        const children = provider.getChildren(node);
        assert.equal(children.length, 1);
        assert.equal(children[0].kind, 'branch');
        assert.equal(children[0].label, 'feature/x');
    });
});

test('a detached worktree node shows a detached HEAD entry', () => {
    const detachedWt = { path: '/repo-detached', branch: undefined, head: 'cccc111122223333', isDetached: true, isMain: false };
    const state = makeState({ workTrees: [TWO_WORKTREES[0], detachedWt] });
    withProvider([state], provider => {
        const node = { kind: 'workTree', repoPath: '/repo', workTree: detachedWt };
        const children = provider.getChildren(node);
        assert.equal(children.length, 1);
        assert.equal(children[0].kind, 'detachedHead');
        assert.equal(children[0].label, 'Detached HEAD at cccc111');
    });
});

test('branch tree items get worktree-aware context values', () => {
    const state = makeState({});
    withProvider([state], provider => {
        const cases = [
            [branch({ isCurrent: true, isTracking: true }), 'branch.current.tracking'],
            [branch({ isTracking: true }), 'branch.local.tracking'],
            [branch({}), 'branch.local.untracked'],
            [branch({ isTracking: true, checkedOutInOtherWorktree: true, workTreePath: '/repo-feature' }), 'branch.local.worktree.tracking'],
            [branch({ checkedOutInOtherWorktree: true, workTreePath: '/repo-feature' }), 'branch.local.worktree.untracked'],
            [branch({ isRemote: true }), 'branch.remote']
        ];
        for (const [b, expected] of cases) {
            const item = provider.getTreeItem({ kind: 'branch', label: b.name, repoPath: '/repo', branch: b });
            assert.equal(item.contextValue, expected);
        }
    });
});

test('worktree tree items expose state in context value and description', () => {
    const state = makeState({ workTrees: TWO_WORKTREES });
    withProvider([state], provider => {
        const mainItem = provider.getTreeItem({ kind: 'workTree', label: 'repo', repoPath: '/repo', workTree: TWO_WORKTREES[0] });
        assert.equal(mainItem.contextValue, 'workTree.main');
        assert.equal(mainItem.description, 'main (main, current)');

        const lockedItem = provider.getTreeItem({ kind: 'workTree', label: 'repo-feature', repoPath: '/repo', workTree: TWO_WORKTREES[1] });
        assert.equal(lockedItem.contextValue, 'workTree.linked.locked');
        assert.equal(lockedItem.description, 'feature/x (locked)');
        assert.match(lockedItem.tooltip.value, /locked: wip/);

        const unlocked = Object.assign({}, TWO_WORKTREES[1], { isLocked: false, lockedReason: undefined });
        const linkedItem = provider.getTreeItem({ kind: 'workTree', label: 'repo-feature', repoPath: '/repo', workTree: unlocked });
        assert.equal(linkedItem.contextValue, 'workTree.linked');
    });
});

test('checkout-on-click can be disabled via configuration', () => {
    const state = makeState({});
    const b = branch({});
    withProvider([state], provider => {
        const withClick = provider.getTreeItem({ kind: 'branch', label: b.name, repoPath: '/repo', branch: b });
        assert.equal(withClick.command.command, 'gitfocal.checkoutBranch');
        vscode._settings.set('gitfocal.checkoutOnClick', false);
        try {
            const withoutClick = provider.getTreeItem({ kind: 'branch', label: b.name, repoPath: '/repo', branch: b });
            assert.equal(withoutClick.command, undefined);
        } finally {
            vscode._settings.delete('gitfocal.checkoutOnClick');
        }
    });
});
