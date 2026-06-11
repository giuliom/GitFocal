'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterSubmoduleStates, isSameOrDescendantPath } = require('../src/utils/repoFilters');

test('isSameOrDescendantPath accepts same path and descendants', () => {
    assert.equal(isSameOrDescendantPath('/repo', '/repo'), true);
    assert.equal(isSameOrDescendantPath('/repo', '/repo/sub/dir'), true);
});

test('isSameOrDescendantPath rejects siblings, parents, and prefixes', () => {
    assert.equal(isSameOrDescendantPath('/repo', '/other'), false);
    assert.equal(isSameOrDescendantPath('/repo/sub', '/repo'), false);
    assert.equal(isSameOrDescendantPath('/repo', '/repo-worktree'), false);
});

test('filterSubmoduleStates drops repos nested inside another repo', () => {
    const parent = { repoPath: '/repo' };
    const submodule = { repoPath: '/repo/libs/dep' };
    const unrelated = { repoPath: '/other' };
    const result = filterSubmoduleStates([parent, submodule, unrelated]);
    assert.deepEqual(result, [parent, unrelated]);
});

test('filterSubmoduleStates keeps sibling repos with a common prefix', () => {
    const a = { repoPath: '/repo' };
    const b = { repoPath: '/repo-worktree' };
    assert.deepEqual(filterSubmoduleStates([a, b]), [a, b]);
});
