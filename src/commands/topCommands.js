'use strict';

const vscode = require('vscode');
const { pickRepo, reportGitError, withProgress } = require('./commandHelpers');
const preferences = require('../models/preferences');
const remotesFilter = require('../models/remotesFilter');
const tagsFilter = require('../models/tagsFilter');

const CONTEXT_BRANCHES_HIDE_SUBMODULES = 'gitfocal.branches.hideSubmodules';
const CONTEXT_REMOTES_HIDE_SUBMODULES = 'gitfocal.remotes.hideSubmodules';
const CONTEXT_STASHES_HIDE_SUBMODULES = 'gitfocal.stashes.hideSubmodules';

function registerTopCommands(ctx) {
    const { git, stateManager } = ctx;

    return [
        vscode.commands.registerCommand('gitfocal.refresh', async () => {
            await stateManager.refresh();
        }),

        vscode.commands.registerCommand('gitfocal.createBranch', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const fromCurrent = await vscode.window.showQuickPick(
                [
                    { label: `From current (${repo.currentBranch || 'HEAD'})`, value: undefined },
                    { label: 'From another branch...', value: '__pick__' }
                ],
                { placeHolder: 'Base for new branch' }
            );
            if (!fromCurrent) {
                return;
            }

            let from;
            if (fromCurrent.value === '__pick__') {
                const pick = await vscode.window.showQuickPick(
                    repo.branches.map(b => ({ label: b.name, description: b.upstream || '' })),
                    { placeHolder: 'Base branch' }
                );
                if (!pick) {
                    return;
                }
                from = pick.label;
            }
            const name = await vscode.window.showInputBox({
                prompt: 'New branch name',
                validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
            });
            if (!name) {
                return;
            }
            const trimmedName = name.trim();
            try {
                await withProgress(`Create branch ${trimmedName}`, () => git.createBranch(repo.repoPath, trimmedName, from));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to create branch ${trimmedName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.checkoutRemoteBranch', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const remoteBranches = repo.branches.filter(branch => branch.isRemote);
            if (remoteBranches.length === 0) {
                void vscode.window.showInformationMessage('GitFocal: no remote branches found.');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                remoteBranches.map(branch => ({
                    label: branch.name,
                    description: branch.commitSubject || 'remote',
                    branch
                })),
                { placeHolder: 'Remote branch to checkout' }
            );
            if (!pick) {
                return;
            }
            const branchName = pick.branch.name;
            const slash = branchName.indexOf('/');
            const suggested = slash >= 0 ? branchName.substring(slash + 1) : branchName;
            const localName = await vscode.window.showInputBox({
                prompt: 'Local branch name',
                value: suggested,
                validateInput: value => value && value.trim() && !/\s/.test(value) ? null : 'Enter a non-empty name without spaces'
            });
            if (!localName) {
                return;
            }
            const trimmedLocalName = localName.trim();
            try {
                await withProgress(`Checkout ${branchName}`, () =>
                    git.checkoutRemoteAsLocal(repo.repoPath, branchName, trimmedLocalName));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to checkout ${branchName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.fetchAll', async () => {
            const states = stateManager.getStates();
            if (states.length === 0) {
                return;
            }
            try {
                await withProgress('Fetch all repositories', async () => {
                    for (const s of states) {
                        try {
                            await git.fetchRemote(s.repoPath);
                        } catch (err) {
                            reportGitError(err, `Fetch failed for ${s.repoPath}`);
                        }
                    }
                });
                await stateManager.refresh();
            } catch (err) {
                reportGitError(err, 'Fetch all failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashChanges', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const message = await vscode.window.showInputBox({
                prompt: 'Stash message (optional)'
            });
            if (message === undefined) {
                return;
            }
            const includeUntracked = await vscode.window.showQuickPick(
                [
                    { label: 'Tracked changes only', value: false },
                    { label: 'Include untracked files', value: true }
                ],
                { placeHolder: 'Stash scope' }
            );
            if (!includeUntracked) {
                return;
            }
            try {
                await withProgress('Stash changes',
                    () => git.stashPush(repo.repoPath, message || undefined, includeUntracked.value));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Stash failed');
            }
        }),

        vscode.commands.registerCommand('gitfocal.branches.toggleHideSubmodules', async () => {
            const next = await preferences.toggleBranchesHideSubmodules();
            void vscode.commands.executeCommand('setContext', CONTEXT_BRANCHES_HIDE_SUBMODULES, next);
        }),

        vscode.commands.registerCommand('gitfocal.branches.showSubmodules', async () => {
            await preferences.setBranchesHideSubmodules(false);
            void vscode.commands.executeCommand('setContext', CONTEXT_BRANCHES_HIDE_SUBMODULES, false);
        }),

        vscode.commands.registerCommand('gitfocal.branches.hideSubmodules', async () => {
            await preferences.setBranchesHideSubmodules(true);
            void vscode.commands.executeCommand('setContext', CONTEXT_BRANCHES_HIDE_SUBMODULES, true);
        }),

        vscode.commands.registerCommand('gitfocal.remotes.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter remote branches by name (leave empty to clear)',
                placeHolder: 'substring match on branch name',
                value: remotesFilter.get()
            });
            if (value === undefined) {
                return;
            }
            remotesFilter.set(value);
        }),

        vscode.commands.registerCommand('gitfocal.remotes.clearFilter', () => {
            remotesFilter.clear();
        }),

        vscode.commands.registerCommand('gitfocal.tags.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter tags by name (leave empty to clear)',
                placeHolder: 'substring match on tag name',
                value: tagsFilter.get()
            });
            if (value === undefined) {
                return;
            }
            tagsFilter.set(value);
        }),

        vscode.commands.registerCommand('gitfocal.tags.clearFilter', () => {
            tagsFilter.clear();
        }),

        vscode.commands.registerCommand('gitfocal.remotes.toggleHideSubmodules', async () => {
            const next = await preferences.toggleRemotesHideSubmodules();
            void vscode.commands.executeCommand('setContext', CONTEXT_REMOTES_HIDE_SUBMODULES, next);
        }),

        vscode.commands.registerCommand('gitfocal.remotes.showSubmodules', async () => {
            await preferences.setRemotesHideSubmodules(false);
            void vscode.commands.executeCommand('setContext', CONTEXT_REMOTES_HIDE_SUBMODULES, false);
        }),

        vscode.commands.registerCommand('gitfocal.remotes.hideSubmodules', async () => {
            await preferences.setRemotesHideSubmodules(true);
            void vscode.commands.executeCommand('setContext', CONTEXT_REMOTES_HIDE_SUBMODULES, true);
        }),

        vscode.commands.registerCommand('gitfocal.remotes.add', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const existing = new Set(
                repo.branches
                    .filter(b => b.isRemote && b.remoteName)
                    .map(b => b.remoteName)
            );
            const name = await vscode.window.showInputBox({
                prompt: 'New remote name',
                placeHolder: 'origin',
                validateInput: v => {
                    const t = (v || '').trim();
                    if (!t) return 'Enter a non-empty name';
                    if (/\s/.test(t)) return 'No spaces allowed';
                    if (existing.has(t)) return `Remote ${t} already exists`;
                    return null;
                }
            });
            if (!name) {
                return;
            }
            const url = await vscode.window.showInputBox({
                prompt: `URL for remote ${name.trim()}`,
                placeHolder: 'https://... or git@...',
                validateInput: v => (v && v.trim()) ? null : 'Enter a URL'
            });
            if (!url) {
                return;
            }
            const trimmedName = name.trim();
            try {
                await withProgress(`Add remote ${trimmedName}`, () => git.addRemote(repo.repoPath, trimmedName, url.trim()));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to add remote ${trimmedName}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.remotes.copyName', async (element) => {
            const name = element && (element.remoteName || element.label);
            if (!name) {
                return;
            }
            await vscode.env.clipboard.writeText(String(name));
        }),

        vscode.commands.registerCommand('gitfocal.remotes.copyUrl', async (element) => {
            const name = element && (element.remoteName || element.label);
            const repoPath = element && element.repoPath;
            if (!name || !repoPath) {
                return;
            }
            try {
                const url = await git.getRemoteUrl(repoPath, name);
                if (!url) {
                    void vscode.window.showInformationMessage(`GitFocal: remote ${name} has no URL.`);
                    return;
                }
                await vscode.env.clipboard.writeText(url);
            } catch (err) {
                reportGitError(err, `Failed to read URL for remote ${name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashes.toggleHideSubmodules', async () => {
            const next = await preferences.toggleStashesHideSubmodules();
            void vscode.commands.executeCommand('setContext', CONTEXT_STASHES_HIDE_SUBMODULES, next);
        }),

        vscode.commands.registerCommand('gitfocal.stashes.showSubmodules', async () => {
            await preferences.setStashesHideSubmodules(false);
            void vscode.commands.executeCommand('setContext', CONTEXT_STASHES_HIDE_SUBMODULES, false);
        }),

        vscode.commands.registerCommand('gitfocal.stashes.hideSubmodules', async () => {
            await preferences.setStashesHideSubmodules(true);
            void vscode.commands.executeCommand('setContext', CONTEXT_STASHES_HIDE_SUBMODULES, true);
        })
    ];
}

module.exports = { registerTopCommands };
