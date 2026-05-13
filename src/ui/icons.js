'use strict';

const vscode = require('vscode');

const Icons = {
    branch: new vscode.ThemeIcon('git-branch'),
    branchRemote: new vscode.ThemeIcon('cloud'),
    stash: new vscode.ThemeIcon('archive'),
    workTree: new vscode.ThemeIcon('folder-opened'),
    repo: new vscode.ThemeIcon('repo'),
    remoteGroup: new vscode.ThemeIcon('cloud'),
    localGroup: new vscode.ThemeIcon('git-branch'),
    workTreeGroup: new vscode.ThemeIcon('multiple-windows')
};

function iconNameForBranch(branch) {
    if (branch.isCurrent) {
        return 'check';
    }
    if (branch.isRemote) {
        return 'cloud';
    }
    if (branch.isTracking) {
        const { ahead, behind } = branch.aheadBehind;
        if (ahead > 0 && behind > 0) {
            return 'arrow-swap';
        }
        if (ahead > 0) {
            return 'arrow-up';
        }
        if (behind > 0) {
            return 'arrow-down';
        }
    }
    return 'git-branch';
}

function iconForBranch(branch) {
    return new vscode.ThemeIcon(iconNameForBranch(branch));
}

module.exports = { Icons, iconForBranch, iconNameForBranch };
