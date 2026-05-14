'use strict';

const path = require('path');
const vscode = require('vscode');
const {
    confirm,
    isStashNode,
    pickRepo,
    reportGitError,
    withProgress
} = require('./commandHelpers');
const { pathsEqual, pathStartsWith } = require('../utils/pathUtils');

function registerStashCommands(ctx) {
    const { git, stateManager } = ctx;

    return [
        vscode.commands.registerCommand('gitfocal.stashApply', async (arg) => {
            const target = await pickStash(ctx, arg);
            if (!target) {
                return;
            }
            try {
                await withProgress(`Apply ${target.id}`, () => git.stashApply(target.repoPath, target.id));
                await stateManager.refresh(target.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to apply ${target.id}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashPop', async (arg) => {
            const target = await pickStash(ctx, arg);
            if (!target) {
                return;
            }
            try {
                await withProgress(`Pop ${target.id}`, () => git.stashPop(target.repoPath, target.id));
                await stateManager.refresh(target.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to pop ${target.id}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashDelete', async (arg) => {
            const target = await pickStash(ctx, arg);
            if (!target) {
                return;
            }
            const ok = await confirm(`Delete ${target.id}? This cannot be undone.`, 'Delete');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Delete ${target.id}`, () => git.stashDrop(target.repoPath, target.id));
                await stateManager.refresh(target.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to delete ${target.id}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashRename', async (arg) => {
            const target = await pickStash(ctx, arg);
            if (!target) {
                return;
            }
            const state = stateManager.getState(target.repoPath);
            const stash = state ? state.stashes.find(s => s.id === target.id) : undefined;
            const current = stash ? (stash.subject || stash.description || '') : '';
            const newName = await vscode.window.showInputBox({
                prompt: `Rename ${target.id}`,
                value: current,
                validateInput: v => v && v.trim() ? null : 'Enter a non-empty name'
            });
            if (newName === undefined || newName.trim() === current) {
                return;
            }
            try {
                await withProgress(`Rename ${target.id}`,
                    () => git.stashRename(target.repoPath, target.id, newName.trim()));
                await stateManager.refresh(target.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to rename ${target.id}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashApplyFile', async (arg) => {
            if (!arg || arg.kind !== 'stashFile' || !arg.file || !arg.stash) {
                return;
            }
            const ok = await confirm(
                `Restore "${arg.file.path}" from ${arg.stash.id}? This overwrites the file in the working tree.`,
                'Restore'
            );
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Restore ${arg.file.path} from ${arg.stash.id}`,
                    () => git.stashApplyFile(arg.repoPath, arg.stash.id, arg.file.path));
                await stateManager.refresh(arg.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to restore ${arg.file.path} from ${arg.stash.id}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.stashAllChanges', async (arg, others) => {
            await runScmStash(ctx, arg, others, 'all');
        }),

        vscode.commands.registerCommand('gitfocal.stashStagedChanges', async (arg, others) => {
            await runScmStash(ctx, arg, others, 'staged');
        }),

        vscode.commands.registerCommand('gitfocal.stashUnstagedChanges', async (arg, others) => {
            await runScmStash(ctx, arg, others, 'unstaged');
        })
    ];
}

async function runScmStash(ctx, arg, others, mode) {
    const { git, stateManager } = ctx;
    const repoPath = await resolveScmRepo(stateManager, arg, others);
    if (!repoPath) {
        void vscode.window.showWarningMessage('GitFocal: could not determine repository.');
        return;
    }
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
    if (message === undefined) {
        return;
    }
    const msg = message || undefined;
    try {
        if (mode === 'all') {
            await withProgress('Stash all changes', () => git.stashAllChanges(repoPath, msg));
        } else if (mode === 'staged') {
            await withProgress('Stash staged changes', () => git.stashStagedChanges(repoPath, msg));
        } else {
            await withProgress('Stash unstaged changes', () => git.stashUnstagedChanges(repoPath, msg));
        }
        await stateManager.refresh(repoPath);
    } catch (err) {
        reportGitError(err, 'Stash failed');
    }
}

async function resolveScmRepo(stateManager, arg, others) {
    const states = stateManager.getStates();
    if (states.length === 0) {
        return undefined;
    }

    const candidates = [];
    if (arg && arg.resourceStates && Array.isArray(arg.resourceStates)) {
        for (const r of arg.resourceStates) {
            if (r && r.resourceUri) candidates.push(r.resourceUri);
        }
    }
    for (const u of collectResources(arg, others)) {
        candidates.push(u);
    }

    for (const uri of candidates) {
        const fsPath = uri.fsPath;
        const owner = states
            .filter(s => pathsEqual(fsPath, s.repoPath) || pathStartsWith(fsPath, s.repoPath))
            .sort((a, b) => b.repoPath.length - a.repoPath.length)[0];
        if (owner) {
            return owner.repoPath;
        }
    }

    if (states.length === 1) {
        return states[0].repoPath;
    }

    const pick = await vscode.window.showQuickPick(
        states.map(s => ({ label: path.basename(s.repoPath), description: s.repoPath, repoPath: s.repoPath })),
        { placeHolder: 'Select repository' }
    );
    return pick ? pick.repoPath : undefined;
}

function collectResources(arg, others) {
    const list = [];
    if (arg && arg.resourceUri) {
        list.push(arg.resourceUri);
    } else if (arg instanceof vscode.Uri) {
        list.push(arg);
    }
    if (Array.isArray(others)) {
        for (const o of others) {
            if (o && o.resourceUri) {
                list.push(o.resourceUri);
            } else if (o instanceof vscode.Uri) {
                list.push(o);
            }
        }
    }
    return list;
}

async function pickStash(ctx, arg) {
    if (isStashNode(arg) && arg.stash) {
        return { repoPath: arg.repoPath, id: arg.stash.id };
    }
    const repo = await pickRepo(ctx.stateManager, isStashNode(arg) ? arg.repoPath : undefined);
    if (!repo) {
        return undefined;
    }
    if (repo.stashes.length === 0) {
        void vscode.window.showInformationMessage('GitFocal: no stashes in this repository.');
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        repo.stashes.map(s => ({ label: s.id, description: s.description, id: s.id })),
        { placeHolder: 'Select stash' }
    );
    if (!pick) {
        return undefined;
    }
    return { repoPath: repo.repoPath, id: pick.id };
}

module.exports = { registerStashCommands };

