'use strict';

const vscode = require('vscode');
const { isDivergentPullError, isPushRejectedError } = require('../git/gitService');
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
            if (!isRemote) {
                // Git refuses to check out a branch that is active in another
                // worktree; offer to open that worktree instead.
                const busy = findWorktreeBusyBranch(state, branchName);
                if (busy) {
                    const choice = await vscode.window.showWarningMessage(
                        `GitFocal: branch ${branchName} is already checked out in worktree ${busy.workTreePath}.`,
                        'Open in New Window'
                    );
                    if (choice === 'Open in New Window') {
                        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(busy.workTreePath), { forceNewWindow: true });
                    }
                    return;
                }
            }
            try {
                if (isRemote) {
                    const slash = branchName.indexOf('/');
                    const suggested = slash >= 0 ? branchName.substring(slash + 1) : branchName;
                    const localName = await vscode.window.showInputBox({
                        prompt: 'Local branch name',
                        value: suggested,
                        validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
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
                prompt: fromBranch ? `New branch name (from ${fromBranch})` : 'New branch name',
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!name) {
                return;
            }
            const trimmedName = name.trim();
            try {
                await withProgress(`Create branch ${trimmedName}`, () =>
                    git.createBranch(repo.repoPath, trimmedName, fromBranch));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to create branch ${trimmedName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.deleteBranch', async (arg) => {
            await deleteBranch(ctx, arg, false);
        }),

        vscode.commands.registerCommand('gitfocal.deleteBranchForce', async (arg) => {
            await deleteBranch(ctx, arg, true);
        }),

        vscode.commands.registerCommand('gitfocal.fetch', async (arg) => {
            const remoteNode = isRemoteNode(arg) ? arg : undefined;
            const preferredPath = isBranchNode(arg) || remoteNode ? arg.repoPath : undefined;
            const repo = await pickRepo(stateManager, preferredPath);
            if (!repo) {
                return;
            }
            const remote = remoteNode
                ? remoteNode.remoteName
                : (isBranchNode(arg) && arg.branch && arg.branch.remoteName ? arg.branch.remoteName : undefined);
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
            // When invoked on a non-current local branch with an upstream,
            // fast-forward that branch directly instead of pulling whatever
            // branch happens to be checked out.
            const branch = isBranchNode(arg) && arg.branch && !arg.branch.isRemote ? arg.branch : undefined;
            const upstream = branch && !branch.isCurrent && !branch.upstreamGone ? splitUpstream(branch.upstream) : undefined;
            try {
                if (upstream) {
                    await withProgress(`Update ${branch.name}`, () =>
                        git.fastForwardBranch(repo.repoPath, upstream.remote, upstream.branch, branch.name));
                } else {
                    await withProgress('Pull', () => git.pull(repo.repoPath));
                }
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                if (!upstream && isDivergentPullError(err)) {
                    const choice = await vscode.window.showWarningMessage(
                        'GitFocal: local and remote branches have diverged. How do you want to reconcile?',
                        { modal: true },
                        'Rebase', 'Merge'
                    );
                    if (!choice) {
                        return;
                    }
                    try {
                        await withProgress(`Pull (${choice.toLowerCase()})`,
                            () => git.pull(repo.repoPath, choice === 'Rebase' ? 'rebase' : 'merge'));
                        await stateManager.refresh(repo.repoPath);
                    } catch (retryErr) {
                        reportGitError(retryErr, 'Pull failed');
                    }
                    return;
                }
                reportGitError(err, 'Pull failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.push', async (arg) => {
            const repo = await pickRepo(stateManager, isBranchNode(arg) ? arg.repoPath : undefined);
            if (!repo) {
                return;
            }
            // Push the branch the command was invoked on, not whatever is
            // currently checked out.
            const branch = isBranchNode(arg) && arg.branch && !arg.branch.isRemote ? arg.branch : undefined;
            const upstream = branch && !branch.isCurrent ? splitUpstream(branch.upstream) : undefined;
            const doPush = (forceWithLease) => {
                if (upstream) {
                    return git.pushBranch(repo.repoPath, upstream.remote, branch.name, upstream.branch, { forceWithLease });
                }
                if (branch && !branch.isCurrent) {
                    // Non-current branch with no usable upstream: a bare
                    // `git push` would push the checked-out branch instead.
                    return git.push(repo.repoPath, true, branch.name, { forceWithLease });
                }
                return git.push(repo.repoPath, false, undefined, { forceWithLease });
            };
            const label = branch && !branch.isCurrent ? `Push ${branch.name}` : 'Push';
            try {
                await withProgress(label, () => doPush(false));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                if (isPushRejectedError(err)) {
                    const choice = await vscode.window.showWarningMessage(
                        'GitFocal: push was rejected because the remote has newer commits. Pull first, or overwrite the remote branch?',
                        { modal: true },
                        'Force Push (with lease)'
                    );
                    if (!choice) {
                        return;
                    }
                    try {
                        await withProgress(`${label} (force-with-lease)`, () => doPush(true));
                        await stateManager.refresh(repo.repoPath);
                    } catch (retryErr) {
                        reportGitError(retryErr, 'Force push failed');
                    }
                    return;
                }
                reportGitError(err, 'Push failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.pushSetUpstream', async (arg) => {
            // Resolve the clicked branch — Publish Branch must publish the
            // branch the user invoked the command on, not whatever happens to
            // be checked out.
            const resolved = await resolveBranchNode(stateManager, arg, {
                localOnly: true,
                placeHolder: 'Publish branch'
            });
            if (!resolved) {
                return;
            }
            try {
                await withProgress(`Publish ${resolved.branchName}`,
                    () => git.push(resolved.state.repoPath, true, resolved.branchName));
                await stateManager.refresh(resolved.state.repoPath);
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
                validateInput: v => {
                    const t = v.trim();
                    return /^\d+$/.test(t) && parseInt(t, 10) >= 2 ? null : 'Enter an integer >= 2';
                }
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
            let repoPath;
            let target;
            let targetLabel;
            if (arg && arg.kind === 'commit' && arg.commit) {
                repoPath = arg.repoPath;
                target = arg.commit.hash;
                targetLabel = arg.commit.shortHash || arg.commit.hash;
            } else {
                const resolved = await resolveBranchNode(stateManager, arg, { placeHolder: 'Reset current to...' });
                if (!resolved) {
                    return;
                }
                repoPath = resolved.state.repoPath;
                const entered = await vscode.window.showInputBox({
                    prompt: 'Reset current branch to (commit hash, branch, tag, or any revision)',
                    value: resolved.branchName,
                    validateInput: v => v && v.trim() ? null : 'Enter a target revision'
                });
                if (entered === undefined) {
                    return;
                }
                target = entered.trim();
                targetLabel = target;
            }
            const mode = await vscode.window.showQuickPick(
                [
                    { label: 'soft', description: 'Keep index and working tree' },
                    { label: 'mixed', description: 'Keep working tree, reset index' },
                    { label: 'hard', description: 'Discard all changes (destructive)' }
                ],
                { placeHolder: `Reset mode (target: ${targetLabel})` }
            );
            if (!mode) {
                return;
            }
            if (mode.label === 'hard') {
                const ok = await confirm(`Hard reset will discard all uncommitted changes. Reset to ${targetLabel}?`, 'Reset --hard');
                if (!ok) {
                    return;
                }
            }
            try {
                await withProgress(`Reset --${mode.label} to ${targetLabel}`,
                    () => git.resetBranch(repoPath, target, mode.label));
                await stateManager.refresh(repoPath);
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
        }),

        vscode.commands.registerCommand('gitfocal.copyUpstream', async (arg) => {
            if (!isBranchNode(arg) || !arg.branch || !arg.branch.upstream) {
                return;
            }
            await vscode.env.clipboard.writeText(arg.branch.upstream);
        }),

        vscode.commands.registerCommand('gitfocal.copyCommitHash', async (arg) => {
            if (!isBranchNode(arg) || !arg.branch) {
                return;
            }
            await vscode.env.clipboard.writeText(arg.branch.commitHashFull);
        }),

        vscode.commands.registerCommand('gitfocal.copyCommit', async (arg) => {
            if (!arg || arg.kind !== 'commit' || !arg.commit) {
                return;
            }
            await vscode.env.clipboard.writeText(arg.commit.hash);
        }),

        vscode.commands.registerCommand('gitfocal.cherryPickCommit', async (arg) => {
            if (!arg || arg.kind !== 'commit' || !arg.commit) {
                return;
            }
            const repo = await pickRepo(stateManager, arg.repoPath);
            if (!repo) {
                return;
            }
            const short = arg.commit.shortHash || arg.commit.hash.substring(0, 7);
            const subject = arg.commit.subject ? ` "${arg.commit.subject}"` : '';
            const ok = await confirm(`Cherry-pick ${short}${subject} onto current branch?`, 'Cherry-pick');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Cherry-pick ${short}`,
                    () => git.cherryPick(repo.repoPath, arg.commit.hash));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to cherry-pick ${short}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.revertCommit', async (arg) => {
            if (!arg || arg.kind !== 'commit' || !arg.commit) {
                return;
            }
            const repo = await pickRepo(stateManager, arg.repoPath);
            if (!repo) {
                return;
            }
            const short = arg.commit.shortHash || arg.commit.hash.substring(0, 7);
            const subject = arg.commit.subject ? ` "${arg.commit.subject}"` : '';
            const ok = await confirm(`Revert ${short}${subject} on current branch? A new commit undoing its changes will be created.`, 'Revert');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Revert ${short}`,
                    () => git.revertCommit(repo.repoPath, arg.commit.hash));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to revert ${short}`);
            }
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
        }),

        vscode.commands.registerCommand('gitfocal.remotes.checkout', async (arg) => {
            const node = remoteBranchNode(arg);
            if (!node) {
                return;
            }
            const branchName = node.branch.name;
            const slash = branchName.indexOf('/');
            const suggested = slash >= 0 ? branchName.substring(slash + 1) : branchName;
            const localName = await vscode.window.showInputBox({
                prompt: `Local branch name for ${branchName}`,
                value: suggested,
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!localName) {
                return;
            }
            try {
                await withProgress(`Checkout ${branchName}`,
                    () => git.checkoutRemoteAsLocal(node.repoPath, branchName, localName.trim()));
                await stateManager.refresh(node.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to checkout ${branchName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.remotes.createLocalFrom', async (arg) => {
            const node = remoteBranchNode(arg);
            if (!node) {
                return;
            }
            const branchName = node.branch.name;
            const slash = branchName.indexOf('/');
            const suggested = slash >= 0 ? branchName.substring(slash + 1) : branchName;
            const localName = await vscode.window.showInputBox({
                prompt: `New local branch from ${branchName}`,
                value: suggested,
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!localName) {
                return;
            }
            try {
                await withProgress(`Create branch ${localName.trim()}`,
                    () => git.createBranch(node.repoPath, localName.trim(), branchName));
                await stateManager.refresh(node.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to create branch from ${branchName}`);
            }
        })
    ];
}

function remoteBranchNode(arg) {
    if (!arg || typeof arg !== 'object' || arg.kind !== 'branch' || !arg.branch || !arg.branch.isRemote) {
        return undefined;
    }
    return arg;
}

function isRemoteNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'remote' && !!arg.remoteName;
}

/** Returns the branch record when it is checked out in another worktree. */
function findWorktreeBusyBranch(state, branchName) {
    const record = state.branches.find(b => !b.isRemote && b.name === branchName);
    return record && record.checkedOutInOtherWorktree && record.workTreePath ? record : undefined;
}

/** Split "origin/feature/x" into { remote: 'origin', branch: 'feature/x' }. */
function splitUpstream(upstream) {
    if (!upstream) {
        return undefined;
    }
    const slash = upstream.indexOf('/');
    if (slash <= 0) {
        return undefined;
    }
    return { remote: upstream.substring(0, slash), branch: upstream.substring(slash + 1) };
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

    const busy = findWorktreeBusyBranch(state, branchName);
    if (busy) {
        void vscode.window.showErrorMessage(
            `GitFocal: cannot delete ${branchName} because it is checked out in worktree ${busy.workTreePath}. Remove the worktree first.`
        );
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
