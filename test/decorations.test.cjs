'use strict';

require('./helpers/bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const { branchStatus, colorForBranch, formatBranchStatus, formatBranchDescription } = require('../src/ui/decorations');

function branch(overrides) {
    return Object.assign({
        name: 'main',
        isRemote: false,
        isCurrent: false,
        isTracking: false,
        upstream: undefined,
        upstreamGone: false,
        aheadBehind: { ahead: 0, behind: 0 },
        commitHash: 'abc1234'
    }, overrides);
}

test('branchStatus categorizes tracking states', () => {
    assert.equal(branchStatus(branch()), 'no-upstream');
    assert.equal(branchStatus(branch({ isTracking: true })), 'synced');
    assert.equal(branchStatus(branch({ isTracking: true, upstreamGone: true })), 'upstream-gone');
    assert.equal(branchStatus(branch({ isTracking: true, aheadBehind: { ahead: 2, behind: 0 } })), 'ahead');
    assert.equal(branchStatus(branch({ isTracking: true, aheadBehind: { ahead: 0, behind: 3 } })), 'behind');
    assert.equal(branchStatus(branch({ isTracking: true, aheadBehind: { ahead: 1, behind: 1 } })), 'diverged');
});

test('formatBranchStatus maps categories to short labels', () => {
    assert.equal(formatBranchStatus(branch()), 'local');
    assert.equal(formatBranchStatus(branch({ isRemote: true })), '');
    assert.equal(formatBranchStatus(branch({ isTracking: true })), '');
    assert.equal(formatBranchStatus(branch({ isTracking: true, upstreamGone: true })), 'gone');
    assert.equal(formatBranchStatus(branch({ isTracking: true, aheadBehind: { ahead: 1, behind: 0 } })), 'ahead');
});

test('colorForBranch returns theme colors per status and none for remote/synced', () => {
    assert.equal(colorForBranch(branch({ isRemote: true })), undefined);
    assert.equal(colorForBranch(branch({ isTracking: true })), undefined);
    assert.equal(colorForBranch(branch()).id, 'gitDecoration.untrackedResourceForeground');
    assert.equal(colorForBranch(branch({ isTracking: true, upstreamGone: true })).id, 'gitfocal.upstreamGoneForeground');
    assert.equal(colorForBranch(branch({ isTracking: true, aheadBehind: { ahead: 1, behind: 0 } })).id, 'charts.blue');
    assert.equal(colorForBranch(branch({ isTracking: true, aheadBehind: { ahead: 0, behind: 1 } })).id, 'charts.yellow');
    assert.equal(colorForBranch(branch({ isTracking: true, aheadBehind: { ahead: 1, behind: 1 } })).id, 'charts.orange');
});

test('formatBranchDescription combines upstream, status, and commit hash', () => {
    const b = branch({
        isTracking: true,
        upstream: 'origin/main',
        aheadBehind: { ahead: 2, behind: 0 }
    });
    assert.equal(formatBranchDescription(b), '→ origin/main (ahead) abc1234');
});

test('formatBranchDescription marks branches busy in another worktree', () => {
    const b = branch({
        checkedOutInOtherWorktree: true,
        workTreePath: '/repos/app-feature'
    });
    assert.equal(formatBranchDescription(b), '(local) ⌂ app-feature abc1234');
});

test('formatBranchDescription omits the worktree marker for the current worktree', () => {
    const b = branch({
        checkedOutInOtherWorktree: false,
        workTreePath: '/repos/app'
    });
    assert.equal(formatBranchDescription(b), '(local) abc1234');
});
