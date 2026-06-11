'use strict';

require('./helpers/bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    GitService,
    isDivergentPullError,
    isPushRejectedError,
    isWorkTreeDirtyError
} = require('../src/git/gitService');
const { GitError } = require('../src/git/gitTypes');

const SEP = '\x1f';
const REC = '\x1e';

function rec(fields) {
    return fields.join(SEP) + REC;
}

/**
 * GitService with `exec` replaced by a dispatcher over canned outputs.
 * Each handler is `[predicate(args), output]`; unmatched commands throw.
 * All issued arg arrays are recorded in `git.calls`.
 */
function fakeGit(handlers) {
    const git = new GitService();
    git.calls = [];
    git.exec = async (_repoPath, args) => {
        git.calls.push(args);
        for (const [predicate, output] of handlers) {
            if (predicate(args)) {
                return typeof output === 'function' ? output(args) : output;
            }
        }
        throw new GitError(`unexpected git ${args.join(' ')}`, `git ${args.join(' ')}`, '');
    };
    return git;
}

// --- getWorkTrees ---

const WORKTREE_PORCELAIN = [
    'worktree /repo',
    'HEAD aaaa111122223333aaaa111122223333aaaa1111',
    'branch refs/heads/main',
    '',
    'worktree /repo-feature',
    'HEAD bbbb111122223333bbbb111122223333bbbb1111',
    'branch refs/heads/feature/x',
    'locked because reasons',
    '',
    'worktree /repo-detached',
    'HEAD cccc111122223333cccc111122223333cccc1111',
    'detached',
    'prunable gitdir file points to non-existent location',
    ''
].join('\n');

test('getWorkTrees parses porcelain output with flags and lock reason', async () => {
    const git = fakeGit([
        [args => args[0] === 'worktree' && args[1] === 'list', WORKTREE_PORCELAIN]
    ]);
    const worktrees = await git.getWorkTrees('/repo');

    assert.equal(worktrees.length, 3);

    const [main, feature, detached] = worktrees;
    assert.equal(main.path, '/repo');
    assert.equal(main.branch, 'refs/heads/main');
    assert.equal(main.isMain, true);
    assert.equal(main.isLocked, false);
    assert.equal(main.isDetached, false);

    assert.equal(feature.path, '/repo-feature');
    assert.equal(feature.branch, 'refs/heads/feature/x');
    assert.equal(feature.isMain, false);
    assert.equal(feature.isLocked, true);
    assert.equal(feature.lockedReason, 'because reasons');

    assert.equal(detached.branch, undefined);
    assert.equal(detached.isDetached, true);
    assert.equal(detached.isPrunable, true);
    assert.equal(detached.head, 'cccc111122223333cccc111122223333cccc1111');
});

test('getWorkTrees parses a bare main worktree', async () => {
    const out = ['worktree /repo.git', 'bare', ''].join('\n');
    const git = fakeGit([
        [args => args[0] === 'worktree', out]
    ]);
    const worktrees = await git.getWorkTrees('/repo.git');
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].isBare, true);
    assert.equal(worktrees[0].isMain, true);
});

test('getWorkTrees normalizes trailing separators in paths', async () => {
    const out = ['worktree /repo/', 'HEAD aaaa', 'branch refs/heads/main', ''].join('\n');
    const git = fakeGit([
        [args => args[0] === 'worktree', out]
    ]);
    const worktrees = await git.getWorkTrees('/repo');
    assert.equal(worktrees[0].path, '/repo');
});

// --- getBranches ---

const BRANCHES_OUT = [
    rec(['refs/heads/main', 'main', '*', 'aaaa111122223333aaaa111122223333aaaa1111', 'aaa1111', 'origin/main', '[ahead 2, behind 1]', 'main subject', '1700000000']),
    rec(['refs/heads/feature/x', 'feature/x', ' ', 'bbbb111122223333bbbb111122223333bbbb1111', 'bbb1111', 'origin/feature/x', '[gone]', 'feature subject', '1690000000']),
    rec(['refs/heads/local-only', 'local-only', ' ', 'cccc111122223333cccc111122223333cccc1111', 'ccc1111', '', '', 'local subject', '1680000000']),
    rec(['refs/remotes/origin/HEAD', 'origin/HEAD', ' ', 'aaaa111122223333aaaa111122223333aaaa1111', 'aaa1111', '', '', '', '1670000000']),
    rec(['refs/remotes/origin/main', 'origin/main', ' ', 'aaaa111122223333aaaa111122223333aaaa1111', 'aaa1111', '', '', 'main subject', '1670000000'])
].join('');

function branchesGit() {
    return fakeGit([
        [args => args[0] === 'for-each-ref' && args.includes('refs/heads'), BRANCHES_OUT],
        [args => args[0] === 'worktree', WORKTREE_PORCELAIN]
    ]);
}

test('getBranches parses local and remote branches', async () => {
    const git = branchesGit();
    const branches = await git.getBranches('/repo');

    // origin/HEAD is skipped.
    assert.deepEqual(branches.map(b => b.name), ['main', 'feature/x', 'local-only', 'origin/main']);

    const main = branches[0];
    assert.equal(main.isCurrent, true);
    assert.equal(main.isRemote, false);
    assert.equal(main.isTracking, true);
    assert.equal(main.upstream, 'origin/main');
    assert.deepEqual(main.aheadBehind, { ahead: 2, behind: 1 });
    assert.equal(main.commitHash, 'aaa1111');
    assert.equal(main.commitHashFull, 'aaaa111122223333aaaa111122223333aaaa1111');
    assert.equal(main.committerDate, 1700000000);

    const feature = branches[1];
    assert.equal(feature.upstreamGone, true);
    assert.deepEqual(feature.aheadBehind, { ahead: 0, behind: 0 });

    const localOnly = branches[2];
    assert.equal(localOnly.isTracking, false);
    assert.equal(localOnly.upstream, undefined);

    const remote = branches[3];
    assert.equal(remote.isRemote, true);
    assert.equal(remote.remoteName, 'origin');
});

test('getBranches attaches worktree paths and busy-elsewhere markers', async () => {
    const git = branchesGit();
    const branches = await git.getBranches('/repo');

    const main = branches.find(b => b.name === 'main');
    assert.equal(main.workTreePath, '/repo');
    assert.equal(main.checkedOutInOtherWorktree, false);

    const feature = branches.find(b => b.name === 'feature/x');
    assert.equal(feature.workTreePath, '/repo-feature');
    assert.equal(feature.checkedOutInOtherWorktree, true);

    const localOnly = branches.find(b => b.name === 'local-only');
    assert.equal(localOnly.workTreePath, undefined);
});

test('getBranches survives worktree listing failures', async () => {
    const git = fakeGit([
        [args => args[0] === 'for-each-ref' && args.includes('refs/heads'), BRANCHES_OUT]
        // no worktree handler: the call throws and is swallowed as best-effort
    ]);
    const branches = await git.getBranches('/repo');
    assert.equal(branches.length, 4);
    assert.equal(branches[0].workTreePath, undefined);
});

// --- getStashes ---

test('getStashes parses entries and extracts the source branch', async () => {
    const out = [
        `stash@{0}${SEP}WIP on main: abc1234 some commit${SEP}WIP on main: abc1234 some commit`,
        `stash@{1}${SEP}On feature/x: custom message${SEP}On feature/x: custom message`,
        'fatal: this stderr noise is ignored'
    ].join('\n');
    const git = fakeGit([
        [args => args[0] === 'stash' && args[1] === 'list', out]
    ]);
    const stashes = await git.getStashes('/repo');

    assert.equal(stashes.length, 2);
    assert.equal(stashes[0].id, 'stash@{0}');
    assert.equal(stashes[0].index, 0);
    assert.equal(stashes[0].branch, 'main');
    assert.equal(stashes[0].description, 'abc1234 some commit');
    assert.equal(stashes[1].branch, 'feature/x');
    assert.equal(stashes[1].description, 'custom message');
});

// --- getStashFiles ---

test('getStashFiles parses statuses including renames', async () => {
    const out = [
        'M\tsrc/app.js',
        'A\tdocs/new.md',
        'D\told.txt',
        'R100\tsrc/before.js\tsrc/after.js',
        'not-a-record'
    ].join('\n');
    const git = fakeGit([
        [args => args[0] === 'stash' && args[1] === 'show', out]
    ]);
    const files = await git.getStashFiles('/repo', 'stash@{0}');

    assert.deepEqual(files, [
        { status: 'M', path: 'src/app.js', originalPath: undefined },
        { status: 'A', path: 'docs/new.md', originalPath: undefined },
        { status: 'D', path: 'old.txt', originalPath: undefined },
        { status: 'R100', path: 'src/after.js', originalPath: 'src/before.js' }
    ]);
});

// --- getChangedPaths ---

test('getChangedPaths consumes rename old-path tokens', async () => {
    const out = [
        ' M modified.js',
        'R  renamed-new.js', 'renamed-old.js',
        '?? untracked.txt'
    ].join('\0') + '\0';
    const git = fakeGit([
        [args => args[0] === 'status', out]
    ]);
    const paths = await git.getChangedPaths('/repo');
    assert.deepEqual(paths, ['modified.js', 'renamed-new.js', 'untracked.txt']);
});

// --- getTags ---

function tagRecord(fields) {
    return rec(fields);
}

const TAGS_OUT = [
    // annotated tag: objectname is the tag object, *objectname the commit
    tagRecord(['refs/tags/v1.0', 'v1.0', 'tag', 'tagobj1111', 'commit1111commit1111commit1111commit1111', 'commit1', 'Alice', '2 days ago', 'Release 1.0', '', '', '']),
    // lightweight tag: objectname is already the commit
    tagRecord(['refs/tags/v2.0', 'v2.0', 'commit', 'commit2222commit2222commit2222commit2222', '', '', '', '', '', 'Bob', '3 days ago', 'some commit']),
    // local-only tag, missing on the remote
    tagRecord(['refs/tags/v4.0', 'v4.0', 'commit', 'commit4444commit4444commit4444commit4444', '', '', '', '', '', 'Cara', '4 days ago', 'other commit'])
].join('');

const LS_REMOTE_OUT = [
    'tagobj1111\trefs/tags/v1.0',
    'commit1111commit1111commit1111commit1111\trefs/tags/v1.0^{}',
    'feedbeef00feedbeef00feedbeef00feedbeef00\trefs/tags/v2.0',
    'remote5555remote5555remote5555remote5555\trefs/tags/v3.0'
].join('\n');

test('getTags reports no-remote status when the repo has no remotes', async () => {
    const git = fakeGit([
        [args => args[0] === 'for-each-ref' && args.includes('refs/tags'), TAGS_OUT],
        [args => args[0] === 'remote', '']
    ]);
    const tags = await git.getTags('/repo');
    assert.equal(tags.length, 3);
    for (const tag of tags) {
        assert.equal(tag.originStatus, 'no-remote');
        assert.equal(tag.canPushTag, false);
    }
    const v1 = tags.find(t => t.name === 'v1.0');
    assert.equal(v1.isAnnotated, true);
    assert.equal(v1.commitHashFull, 'commit1111commit1111commit1111commit1111');
    assert.equal(v1.tagger, 'Alice');
    const v2 = tags.find(t => t.name === 'v2.0');
    assert.equal(v2.isAnnotated, false);
    assert.equal(v2.tagger, 'Bob');
});

test('getTags computes origin sync status against ls-remote', async () => {
    const git = fakeGit([
        [args => args[0] === 'for-each-ref' && args.includes('refs/tags'), TAGS_OUT],
        [args => args[0] === 'remote' && args.length === 1, 'origin\n'],
        [args => args[0] === 'ls-remote', LS_REMOTE_OUT]
    ]);
    const tags = await git.getTags('/repo');
    const byName = new Map(tags.map(t => [t.name, t]));

    // v1.0 points at the same commit on origin (via the peeled ^{} entry).
    assert.equal(byName.get('v1.0').originStatus, 'same');
    assert.equal(byName.get('v1.0').canPushTag, false);

    // v2.0 exists on origin but at a different commit.
    assert.equal(byName.get('v2.0').originStatus, 'different');
    assert.equal(byName.get('v2.0').canPushTag, true);

    // v4.0 is local-only.
    assert.equal(byName.get('v4.0').originStatus, 'missing');
    assert.equal(byName.get('v4.0').canPushTag, true);

    // v3.0 only exists on origin.
    assert.equal(byName.get('v3.0').originStatus, 'remote-only');
    assert.equal(byName.get('v3.0').isRemoteOnly, true);
    assert.equal(byName.get('v3.0').canPushTag, false);
});

// --- command construction ---

function recordingGit() {
    return fakeGit([[() => true, '']]);
}

test('addWorkTree checks out an existing branch', async () => {
    const git = recordingGit();
    await git.addWorkTree('/repo', '/repo-feature', { branch: 'feature/x' });
    assert.deepEqual(git.calls, [
        ['worktree', 'add', '--end-of-options', '/repo-feature', 'feature/x']
    ]);
});

test('addWorkTree creates a new branch with -b', async () => {
    const git = recordingGit();
    await git.addWorkTree('/repo', '/repo-new', { newBranch: 'new-branch' });
    assert.deepEqual(git.calls, [
        ['worktree', 'add', '-b', 'new-branch', '--end-of-options', '/repo-new']
    ]);
});

test('removeWorkTree adds --force only when forced', async () => {
    const git = recordingGit();
    await git.removeWorkTree('/repo', '/repo-feature', false);
    await git.removeWorkTree('/repo', '/repo-feature', true);
    assert.deepEqual(git.calls, [
        ['worktree', 'remove', '--end-of-options', '/repo-feature'],
        ['worktree', 'remove', '--force', '--end-of-options', '/repo-feature']
    ]);
});

test('lockWorkTree passes the optional reason', async () => {
    const git = recordingGit();
    await git.lockWorkTree('/repo', '/repo-feature', 'release prep');
    await git.lockWorkTree('/repo', '/repo-feature');
    assert.deepEqual(git.calls, [
        ['worktree', 'lock', '--reason', 'release prep', '--end-of-options', '/repo-feature'],
        ['worktree', 'lock', '--end-of-options', '/repo-feature']
    ]);
});

test('unlockWorkTree and pruneWorkTrees issue the expected commands', async () => {
    const git = recordingGit();
    await git.unlockWorkTree('/repo', '/repo-feature');
    await git.pruneWorkTrees('/repo');
    assert.deepEqual(git.calls, [
        ['worktree', 'unlock', '--end-of-options', '/repo-feature'],
        ['worktree', 'prune']
    ]);
});

test('deleteBranch uses -d or -D depending on force', async () => {
    const git = recordingGit();
    await git.deleteBranch('/repo', 'feature/x', false);
    await git.deleteBranch('/repo', 'feature/x', true);
    assert.deepEqual(git.calls, [
        ['branch', '-d', '--end-of-options', 'feature/x'],
        ['branch', '-D', '--end-of-options', 'feature/x']
    ]);
});

test('pull maps modes to the right flags', async () => {
    const git = recordingGit();
    await git.pull('/repo');
    await git.pull('/repo', 'rebase');
    await git.pull('/repo', 'merge');
    assert.deepEqual(git.calls, [
        ['pull', '--ff-only'],
        ['pull', '--rebase'],
        ['pull', '--no-rebase']
    ]);
});

// --- error classifiers ---

test('isDivergentPullError matches divergence messages only', () => {
    assert.equal(isDivergentPullError(new Error('fatal: Not possible to fast-forward, aborting.')), true);
    assert.equal(isDivergentPullError(new Error('hint: You have divergent branches')), true);
    assert.equal(isDivergentPullError(new Error('fatal: repository not found')), false);
});

test('isPushRejectedError matches rejected pushes only', () => {
    assert.equal(isPushRejectedError(new Error('! [rejected] main -> main (non-fast-forward)')), true);
    assert.equal(isPushRejectedError(new Error('error: failed to push some refs')), true);
    assert.equal(isPushRejectedError(new Error('fatal: could not read from remote')), false);
});

test('isWorkTreeDirtyError matches dirty worktree removal failures only', () => {
    assert.equal(isWorkTreeDirtyError(new Error("fatal: '../wt' contains modified or untracked files, use --force to delete it")), true);
    assert.equal(isWorkTreeDirtyError(new Error('fatal: working trees containing submodules cannot be moved or removed')), false);
});
