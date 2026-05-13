'use strict';

const vscode = require('vscode');
const {
    confirm,
    isBranchNode,
    pickRepo,
    reportGitError,
    resolveBranchNode,
    withProgress
} = require('./commandHelpers');

function registerBranchCommands(ctx) {
    const { git, stateManager } = ctx;

    return [
        vscode.commands.registerCommand('gitfocal.checkoutBranch', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: 'Checkout branch' });
            if (!resolved) {
                return;
            }
            const { state, branchName, isRemote } = resolved;
            try {
                if (isRemote) {
                    const slash = branchName.indexOf('/');
                    const suggested = slash >= 0 ? branchName.substring(slash + 1) : branchName;
                    const localName = await vscode.window.showInputBox({
                        prompt: 'Local branch name',
                        value: suggested
                    });
                    if (!localName) {
                        return;
                    }
                    await withProgress(`Checkout ${branchName}`, () =>
                        git.checkoutRemoteAsLocal(state.repoPath, branchName, localName));
                } else {
                    await withProgress(`Checkout ${branchName}`, () =>
                        git.checkoutBranch(state.repoPath, branchName));
                }
                await stateManager.refresh(state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to checkout ${branchName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.createBranchFrom', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            const fromBranch = isBranchNode(arg) && arg.branch ? arg.branch.name : undefined;
            const name = await vscode.window.showInputBox({
                prompt: fromBranch ? `New branch name (from ${fromBranch})` : 'New branch name'
            });
            if (!name) {
                return;
            }
            try {
                await withProgress(`Create branch ${name}`, () =>
                    git.createBranch(repo.repoPath, name, fromBranch));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to create branch ${name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.deleteBranch', async (arg) => {
            await deleteBranch(ctx, arg, false);
        }),

        vscode.commands.registerCommand('gitfocal.deleteBranchForce', async (arg) => {
            await deleteBranch(ctx, arg, true);
        }),

        vscode.commands.registerCommand('gitfocal.fetch', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            const remote = isBranchNode(arg) && arg.branch && arg.branch.remoteName ? arg.branch.remoteName : undefined;
            try {
                await withProgress(remote ? `Fetch ${remote}` : 'Fetch all remotes',
                    () => git.fetchRemote(repo.repoPath, remote));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Fetch failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.pull', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            try {
                await withProgress('Pull', () => git.pull(repo.repoPath));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Pull failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.push', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            try {
                await withProgress('Push', () => git.push(repo.repoPath, false));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Push failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.pushSetUpstream', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            try {
                await withProgress('Push (set upstream)', () => git.push(repo.repoPath, true));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Push failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.merge', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: 'Merge branch into current' });
            if (!resolved) {
                return;
            }
            try {
                await withProgress(`Merge ${resolved.branchName}`,
                    () => git.mergeBranch(resolved.state.repoPath, resolved.branchName));
                await stateManager.refresh(resolved.state.repoPath);
            } catch (err) {
                reportGitError(err, `Merge ${resolved.branchName} failed`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.rebase', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: 'Rebase current onto...' });
            if (!resolved) {
                return;
            }
            const ok = await confirm(`Rebase current branch onto ${resolved.branchName}?`, 'Rebase');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Rebase onto ${resolved.branchName}`,
                    () => git.rebaseBranch(resolved.state.repoPath, resolved.branchName));
                await stateManager.refresh(resolved.state.repoPath);
            } catch (err) {
                reportGitError(err, `Rebase onto ${resolved.branchName} failed`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.squash', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            const countStr = await vscode.window.showInputBox({
                prompt: 'Number of commits to squash',
                value: '2',
                validateInput: v => /^[2-9]\d*$/.test(v.trim()) ? null : 'Enter an integer >= 2'
            });
            if (!countStr) {
                return;
            }
            const count = parseInt(countStr, 10);
            const message = await vscode.window.showInputBox({
                prompt: 'Squashed commit message (leave empty for default)'
            });
            if (message === undefined) {
                return;
            }
            const ok = await confirm(`Squash the last ${count} commits?`, 'Squash');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Squash ${count} commits`,
                    () => git.squashCommits(repo.repoPath, count, message || undefined));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Squash failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.reset', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: 'Reset current to...' });
            if (!resolved) {
                return;
            }
            const mode = await vscode.window.showQuickPick(
                [
                    { label: 'soft', description: 'Keep index and working tree' },
                    { label: 'mixed', description: 'Keep working tree, reset index' },
                    { label: 'hard', description: 'Discard all changes (destructive)' }
                ],
                { placeHolder: 'Reset mode' }
            );
            if (!mode) {
                return;
            }
            if (mode.label === 'hard') {
                const ok = await confirm(`Hard reset will discard all uncommitted changes. Reset to ${resolved.branchName}?`, 'Reset --hard');
                if (!ok) {
                    return;
                }
            }
            try {
                await withProgress(`Reset --${mode.label} to ${resolved.branchName}`,
                    () => git.resetBranch(resolved.state.repoPath, resolved.branchName, mode.label));
                await stateManager.refresh(resolved.state.repoPath);
            } catch (err) {
                reportGitError(err, 'Reset failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.changeUpstream', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, {
                localOnly: true,
                placeHolder: 'Branch whose upstream to change'
            });
            if (!resolved) {
                return;
            }
            const remoteCandidates = resolved.state.branches.filter(b => b.isRemote);
            const upstreamPick = await vscode.window.showQuickPick(
                remoteCandidates.map(b => ({ label: b.name })),
                { placeHolder: 'New upstream branch' }
            );
            if (!upstreamPick) {
                return;
            }
            try {
                await withProgress(`Set upstream of ${resolved.branchName}`,
                    () => git.setUpstream(resolved.state.repoPath, resolved.branchName, upstreamPick.label));
                await stateManager.refresh(resolved.state.repoPath);
            } catch (err) {
                reportGitError(err, 'Set upstream failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.copyName', async (arg) => {
            if (!isBranchNode(arg) || !arg.branch) {
                return;
            }
            await vscode.env.clipboard.writeText(arg.branch.name);
            void vscode.window.showInformationMessage(`Copied: ${arg.branch.name}`);
        }),

        vscode.commands.registerCommand('gitfocal.copyUpstream', async (arg) => {
            if (!isBranchNode(arg) || !arg.branch || !arg.branch.upstream) {
                void vscode.window.showInformationMessage('No upstream set for this branch.');
                return;
            }
            await vscode.env.clipboard.writeText(arg.branch.upstream);
            void vscode.window.showInformationMessage(`Copied: ${arg.branch.upstream}`);
        }),

        vscode.commands.registerCommand('gitfocal.copyCommitHash', async (arg) => {
            if (!isBranchNode(arg) || !arg.branch) {
                return;
            }
            await vscode.env.clipboard.writeText(arg.branch.commitHashFull);
            void vscode.window.showInformationMessage(`Copied: ${arg.branch.commitHashFull}`);
        }),

        vscode.commands.registerCommand('gitfocal.renameBranch', async (arg) => {
            const resolved = await resolveBranchNode(stateManager, arg, {
                localOnly: true,
                placeHolder: 'Rename branch'
            });
            if (!resolved) {
                return;
            }
            const newName = await vscode.window.showInputBox({
                prompt: `Rename branch ${resolved.branchName} to`,
                value: resolved.branchName,
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!newName || newName.trim() === resolved.branchName) {
                return;
            }
            try {
                await withProgress(`Rename ${resolved.branchName} \u2192 ${newName}`,
                    () => git.renameBranch(resolved.state.repoPath, resolved.branchName, newName.trim()));
                await stateManager.refresh(resolved.state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to rename ${resolved.branchName}`);
            }
        })
    ];
}

async function deleteBranch(ctx, arg, force) {
    const { git, stateManager } = ctx;
    const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: force ? 'Force delete branch' : 'Delete branch' });
    if (!resolved) {
        return;
    }
    const { state, branchName, isRemote } = resolved;

    if (isRemote) {
        const slash = branchName.indexOf('/');
        if (slash < 0) {
            void vscode.window.showErrorMessage(`Cannot parse remote/branch from "${branchName}".`);
            return;
        }
        const remote = branchName.substring(0, slash);
        const remoteRef = branchName.substring(slash + 1);
        const ok = await confirm(`Delete remote branch ${branchName}? This will run \`git push ${remote} --delete ${remoteRef}\`.`, 'Delete');
        if (!ok) {
            return;
        }
        try {
            await withProgress(`Delete ${branchName}`, () => git.deleteRemoteBranch(state.repoPath, remote, remoteRef));
            await stateManager.refresh(state.repoPath);
        } catch (err) {
            reportGitError(err, `Failed to delete remote branch ${branchName}`);
        }
        return;
    }

    const ok = await confirm(`Delete${force ? ' (force)' : ''} local branch ${branchName}?`, force ? 'Force Delete' : 'Delete');
    if (!ok) {
        return;
    }
    try {
        await withProgress(`Delete ${branchName}`, () => git.deleteBranch(state.repoPath, branchName, force));
        await stateManager.refresh(state.repoPath);
    } catch (err) {
        reportGitError(err, `Failed to delete branch ${branchName}`);
    }
}

module.exports = { registerBranchCommands };
