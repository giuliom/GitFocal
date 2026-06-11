'use strict';

const path = require('path');
const vscode = require('vscode');
const { isWorkTreeDirtyError } = require('../git/gitService');
const {
    confirm,
    isBranchNode,
    pickRepo,
    reportGitError,
    withProgress
} = require('./commandHelpers');

function registerWorktreeCommands(ctx) {
    const { git, stateManager } = ctx;

    return [
        vscode.commands.registerCommand('gitfocal.worktree.add', async (arg) => {
            await addWorkTree(ctx, arg);
        }),

        vscode.commands.registerCommand('gitfocal.worktree.open', async (arg) => {
            const wtPath = workTreePathFromArg(arg);
            if (!wtPath) {
                return;
            }
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), { forceNewWindow: true });
        }),

        vscode.commands.registerCommand('gitfocal.worktree.addToWorkspace', async (arg) => {
            const wtPath = workTreePathFromArg(arg);
            if (!wtPath) {
                return;
            }
            addFolderToWorkspace(wtPath);
        }),

        vscode.commands.registerCommand('gitfocal.worktree.remove', async (arg) => {
            const node = workTreeNode(arg);
            if (!node || node.workTree.isMain) {
                return;
            }
            const wt = node.workTree;
            const name = path.basename(wt.path) || wt.path;
            const ok = await confirm(`Remove worktree ${name}? The folder ${wt.path} will be deleted.`, 'Remove');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Remove worktree ${name}`, () => git.removeWorkTree(node.repoPath, wt.path, false));
            } catch (err) {
                if (!isWorkTreeDirtyError(err)) {
                    reportGitError(err, `Failed to remove worktree ${name}`);
                    return;
                }
                const force = await confirm(`Worktree ${name} has uncommitted changes that will be lost. Remove anyway?`, 'Force Remove');
                if (!force) {
                    return;
                }
                try {
                    await withProgress(`Remove worktree ${name} (force)`, () => git.removeWorkTree(node.repoPath, wt.path, true));
                } catch (retryErr) {
                    reportGitError(retryErr, `Failed to remove worktree ${name}`);
                    return;
                }
            }
            await stateManager.refresh(node.repoPath);
        }),

        vscode.commands.registerCommand('gitfocal.worktree.lock', async (arg) => {
            const node = workTreeNode(arg);
            if (!node || node.workTree.isMain) {
                return;
            }
            const wt = node.workTree;
            const name = path.basename(wt.path) || wt.path;
            const reason = await vscode.window.showInputBox({
                prompt: `Reason for locking ${name} (optional)`
            });
            if (reason === undefined) {
                return;
            }
            try {
                await withProgress(`Lock worktree ${name}`,
                    () => git.lockWorkTree(node.repoPath, wt.path, reason.trim() || undefined));
                await stateManager.refresh(node.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to lock worktree ${name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.worktree.unlock', async (arg) => {
            const node = workTreeNode(arg);
            if (!node) {
                return;
            }
            const wt = node.workTree;
            const name = path.basename(wt.path) || wt.path;
            try {
                await withProgress(`Unlock worktree ${name}`, () => git.unlockWorkTree(node.repoPath, wt.path));
                await stateManager.refresh(node.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to unlock worktree ${name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.worktree.prune', async (arg) => {
            const repoPathHint = arg && typeof arg === 'object' ? arg.repoPath : undefined;
            const repo = await pickRepo(stateManager, repoPathHint);
            if (!repo) {
                return;
            }
            try {
                await withProgress('Prune worktrees', () => git.pruneWorkTrees(repo.repoPath));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Failed to prune worktrees');
            }
        }),

        vscode.commands.registerCommand('gitfocal.worktree.copyPath', async (arg) => {
            const wtPath = workTreePathFromArg(arg);
            if (!wtPath) {
                return;
            }
            await vscode.env.clipboard.writeText(wtPath);
        })
    ];
}

async function addWorkTree(ctx, arg) {
    const { git, stateManager } = ctx;
    const repoPathHint = arg && typeof arg === 'object' ? arg.repoPath : undefined;
    const repo = await pickRepo(stateManager, repoPathHint);
    if (!repo) {
        return;
    }

    // Invoked on a branch node: use that branch directly. Otherwise pick a
    // branch that isn't already checked out somewhere, or create a new one.
    let branchName;
    let newBranch = false;
    if (isBranchNode(arg) && arg.branch && !arg.branch.isRemote && !arg.branch.workTreePath) {
        branchName = arg.branch.name;
    } else {
        const candidates = repo.branches.filter(b => !b.isRemote && !b.workTreePath);
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(add) Create new branch...', isNew: true },
                ...candidates.map(b => ({ label: b.name, description: b.commitSubject || '', branch: b }))
            ],
            { placeHolder: 'Branch to check out in the new worktree' }
        );
        if (!pick) {
            return;
        }
        if (pick.isNew) {
            const name = await vscode.window.showInputBox({
                prompt: `New branch name (from ${repo.currentBranch || 'HEAD'})`,
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!name) {
                return;
            }
            branchName = name.trim();
            newBranch = true;
        } else {
            branchName = pick.branch.name;
        }
    }

    const suggested = path.join(
        path.dirname(repo.repoPath),
        `${path.basename(repo.repoPath)}-${branchName.replace(/[\\/]/g, '-')}`
    );
    const entered = await vscode.window.showInputBox({
        prompt: `Folder for the ${branchName} worktree`,
        value: suggested,
        valueSelection: [suggested.length, suggested.length],
        validateInput: v => v && v.trim() ? null : 'Enter a folder path'
    });
    if (!entered) {
        return;
    }
    const wtPath = entered.trim();

    try {
        await withProgress(`Add worktree for ${branchName}`, () =>
            git.addWorkTree(repo.repoPath, wtPath, newBranch ? { newBranch: branchName } : { branch: branchName }));
        await stateManager.refresh(repo.repoPath);
    } catch (err) {
        reportGitError(err, `Failed to add worktree for ${branchName}`);
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        `GitFocal: created worktree for ${branchName} at ${wtPath}.`,
        'Open in New Window', 'Add to Workspace'
    );
    if (choice === 'Open in New Window') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wtPath), { forceNewWindow: true });
    } else if (choice === 'Add to Workspace') {
        addFolderToWorkspace(wtPath);
    }
}

function workTreeNode(arg) {
    if (!arg || typeof arg !== 'object' || arg.kind !== 'workTree' || !arg.workTree) {
        return undefined;
    }
    return arg;
}

/** Accepts a workTree node or a branch node checked out in a worktree. */
function workTreePathFromArg(arg) {
    const node = workTreeNode(arg);
    if (node) {
        return node.workTree.path;
    }
    if (isBranchNode(arg) && arg.branch && arg.branch.workTreePath) {
        return arg.branch.workTreePath;
    }
    return undefined;
}

function addFolderToWorkspace(fsPath) {
    const folders = vscode.workspace.workspaceFolders || [];
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(fsPath) });
}

module.exports = { registerWorktreeCommands };
