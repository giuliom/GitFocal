'use strict';

const vscode = require('vscode');

async function pickRepo(stateManager, preferredPath) {
    const states = stateManager.getStates();
    if (states.length === 0) {
        void vscode.window.showInformationMessage('GitFocal: no git repositories found in workspace.');
        return undefined;
    }
    if (preferredPath) {
        const found = states.find(s => s.repoPath === preferredPath);
        if (found) {
            return found;
        }
    }
    if (states.length === 1) {
        return states[0];
    }
    const pick = await vscode.window.showQuickPick(
        states.map(s => ({ label: s.repoPath, description: `${s.branches.length} branches`, state: s })),
        { placeHolder: 'Select repository' }
    );
    return pick ? pick.state : undefined;
}

async function resolveBranchNode(stateManager, arg, options) {
    const opts = options || {};
    if (isBranchNode(arg) && arg.branch) {
        const state = stateManager.getState(arg.repoPath);
        if (state) {
            return { state, branchName: arg.branch.name, isRemote: arg.branch.isRemote };
        }
    }
    const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
    if (!repo) {
        return undefined;
    }
    let candidates = repo.branches;
    if (opts.localOnly) {
        candidates = candidates.filter(b => !b.isRemote);
    }
    if (opts.remoteOnly) {
        candidates = candidates.filter(b => b.isRemote);
    }
    const pick = await vscode.window.showQuickPick(
        candidates.map(b => ({
            label: b.name,
            description: b.upstream ? `→ ${b.upstream}` : (b.isRemote ? 'remote' : 'local'),
            branch: b
        })),
        { placeHolder: opts.placeHolder || 'Select branch' }
    );
    if (!pick) {
        return undefined;
    }
    return { state: repo, branchName: pick.branch.name, isRemote: pick.branch.isRemote };
}

function isBranchNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'branch';
}

function isStashNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'stash';
}

function reportGitError(err, fallback) {
    const detail = err instanceof Error ? err.message : (err ? String(err) : '');
    const message = detail ? `GitFocal: ${fallback}: ${detail}` : `GitFocal: ${fallback}`;
    void vscode.window.showErrorMessage(message);
}

async function withProgress(title, task) {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title },
        task
    );
}

async function confirm(message, destructiveAction) {
    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        destructiveAction
    );
    return choice === destructiveAction;
}

module.exports = {
    pickRepo,
    resolveBranchNode,
    isBranchNode,
    isStashNode,
    reportGitError,
    withProgress,
    confirm
};
