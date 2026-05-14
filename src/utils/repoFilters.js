'use strict';

const path = require('path');

function filterSubmoduleStates(states) {
    return states.filter(state => !states.some(other => other !== state && isDescendantPath(other.repoPath, state.repoPath)));
}

function isSameOrDescendantPath(parentPath, childPath) {
    return parentPath === childPath || isDescendantPath(parentPath, childPath);
}

function isDescendantPath(parentPath, childPath) {
    const relative = path.relative(parentPath, childPath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

module.exports = {
    filterSubmoduleStates,
    isSameOrDescendantPath
};