'use strict';

function createRepositoryState(init) {
    const state = {
        repoPath: init.repoPath,
        branches: Object.freeze([...init.branches]),
        stashes: Object.freeze([...init.stashes]),
        workTrees: Object.freeze([...init.workTrees]),
        currentBranch: init.currentBranch,
        lastRefreshed: init.lastRefreshed != null ? init.lastRefreshed : Date.now(),
        version: init.version != null ? init.version : 1,
        error: init.error
    };
    return Object.freeze(state);
}

function emptyRepositoryState(repoPath) {
    return createRepositoryState({
        repoPath,
        branches: [],
        stashes: [],
        workTrees: [],
        currentBranch: '',
        version: 0
    });
}

module.exports = { createRepositoryState, emptyRepositoryState };
