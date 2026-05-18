'use strict';

const vscode = require('vscode');
const { pickRepo, reportGitError, withProgress } = require('./commandHelpers');
const preferences = require('../models/preferences');

const CONTEXT_BRANCHES_HIDE_SUBMODULES = 'gitfocal.branches.hideSubmodules';
const CONTEXT_BRANCHES_HIDE_REMOTES = 'gitfocal.branches.hideRemotes';
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

        vscode.commands.registerCommand('gitfocal.branches.showRemotes', async () => {
            await preferences.setBranchesHideRemotes(false);
            void vscode.commands.executeCommand('setContext', CONTEXT_BRANCHES_HIDE_REMOTES, false);
        }),

        vscode.commands.registerCommand('gitfocal.branches.hideRemotes', async () => {
            await preferences.setBranchesHideRemotes(true);
            void vscode.commands.executeCommand('setContext', CONTEXT_BRANCHES_HIDE_REMOTES, true);
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
