'use strict';

const vscode = require('vscode');
const { confirm, pickRepo, reportGitError, withProgress } = require('./commandHelpers');

function isTagNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'tag';
}

function isCommitNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'commit';
}

async function resolveTagNode(stateManager, arg) {
    if (isTagNode(arg) && arg.tag) {
        const state = stateManager.getState(arg.repoPath);
        if (state) {
            return { state, tag: arg.tag };
        }
    }
    const repo = await pickRepo(stateManager, isTagNode(arg) ? arg.repoPath : undefined);
    if (!repo) {
        return undefined;
    }
    const tags = repo.tags || [];
    if (tags.length === 0) {
        void vscode.window.showInformationMessage('GitFocal: no tags in this repository.');
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        tags.map(t => ({
            label: t.name,
            description: t.commitHash || '',
            detail: t.subject || undefined,
            tag: t
        })),
        { placeHolder: 'Select tag' }
    );
    return pick ? { state: repo, tag: pick.tag } : undefined;
}

async function promptCreateTag(git, stateManager, repo, ref, defaultName) {
    const name = await vscode.window.showInputBox({
        prompt: ref ? `New tag name (at ${ref})` : 'New tag name',
        value: defaultName,
        validateInput: v => v && v.trim() && !/\s/.test(v) ? null : 'Enter a non-empty name without spaces'
    });
    if (!name) {
        return false;
    }
    const trimmed = name.trim();
    const kind = await vscode.window.showQuickPick(
        [
            { label: 'Lightweight tag', value: 'light' },
            { label: 'Annotated tag (with message)', value: 'annotated' }
        ],
        { placeHolder: 'Tag type' }
    );
    if (!kind) {
        return false;
    }
    let message;
    if (kind.value === 'annotated') {
        message = await vscode.window.showInputBox({
            prompt: 'Tag message',
            validateInput: v => v && v.trim() ? null : 'Annotated tags require a message'
        });
        if (message === undefined) {
            return false;
        }
    }
    try {
        await withProgress(`Create tag ${trimmed}`, () =>
            git.createTag(repo.repoPath, trimmed, { ref, message }));
        await stateManager.refresh(repo.repoPath);
        return true;
    } catch (err) {
        reportGitError(err, `Failed to create tag ${trimmed}`);
        return false;
    }
}

function registerTagCommands(ctx) {
    const { git, stateManager } = ctx;

    return [
        vscode.commands.registerCommand('gitfocal.createTag', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const choice = await vscode.window.showQuickPick(
                [
                    { label: `At HEAD (${repo.currentBranch || 'current'})`, value: undefined },
                    { label: 'At another commit/branch...', value: '__pick__' }
                ],
                { placeHolder: 'Tag target' }
            );
            if (!choice) {
                return;
            }
            let ref;
            if (choice.value === '__pick__') {
                const refInput = await vscode.window.showInputBox({
                    prompt: 'Commit hash, branch, or ref to tag',
                    validateInput: v => v && v.trim() ? null : 'Enter a ref'
                });
                if (!refInput) {
                    return;
                }
                ref = refInput.trim();
            }
            await promptCreateTag(git, stateManager, repo, ref);
        }),

        vscode.commands.registerCommand('gitfocal.tagCommit', async (arg) => {
            if (!isCommitNode(arg)) {
                return;
            }
            const repo = stateManager.getState(arg.repoPath);
            if (!repo) {
                return;
            }
            const ref = arg.commit && (arg.commit.hash || arg.commit.shortHash);
            if (!ref) {
                return;
            }
            await promptCreateTag(git, stateManager, repo, ref);
        }),

        vscode.commands.registerCommand('gitfocal.deleteTag', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            const ok = await confirm(`Delete tag '${tag.name}'?`, 'Delete');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Delete tag ${tag.name}`, () =>
                    git.deleteTag(state.repoPath, tag.name));
                await stateManager.refresh(state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to delete tag ${tag.name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.renameTag', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            const newName = await vscode.window.showInputBox({
                prompt: `Rename tag '${tag.name}' to`,
                value: tag.name,
                validateInput: v => v && v.trim() && !/\s/.test(v) && v.trim() !== tag.name ? null : 'Enter a new non-empty name without spaces'
            });
            if (!newName) {
                return;
            }
            try {
                await withProgress(`Rename tag ${tag.name}`, () =>
                    git.renameTag(state.repoPath, tag.name, newName.trim()));
                await stateManager.refresh(state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to rename tag ${tag.name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.checkoutTag', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            try {
                await withProgress(`Checkout tag ${tag.name}`, () =>
                    git.checkoutBranch(state.repoPath, tag.name));
                await stateManager.refresh(state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to checkout tag ${tag.name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.pushTag', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            const remotes = await git.listRemotes(state.repoPath).catch(() => []);
            let remote = 'origin';
            if (remotes.length === 0) {
                void vscode.window.showInformationMessage('GitFocal: no remotes configured.');
                return;
            }
            if (remotes.length > 1) {
                const pick = await vscode.window.showQuickPick(remotes, { placeHolder: 'Push tag to remote' });
                if (!pick) {
                    return;
                }
                remote = pick;
            } else {
                remote = remotes[0];
            }
            try {
                await withProgress(`Push tag ${tag.name} to ${remote}`, () =>
                    git.pushTag(state.repoPath, tag.name, remote));
            } catch (err) {
                reportGitError(err, `Failed to push tag ${tag.name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.deleteRemoteTag', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            const remotes = await git.listRemotes(state.repoPath).catch(() => []);
            if (remotes.length === 0) {
                void vscode.window.showInformationMessage('GitFocal: no remotes configured.');
                return;
            }
            let remote = remotes[0];
            if (remotes.length > 1) {
                const pick = await vscode.window.showQuickPick(remotes, { placeHolder: 'Delete tag from remote' });
                if (!pick) {
                    return;
                }
                remote = pick;
            }
            const ok = await confirm(`Delete tag '${tag.name}' from remote '${remote}'?`, 'Delete');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Delete remote tag ${tag.name}`, () =>
                    git.deleteRemoteTag(state.repoPath, remote, tag.name));
                await stateManager.refresh(state.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to delete remote tag ${tag.name}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.copyTagName', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            await vscode.env.clipboard.writeText(resolved.tag.name);
        }),

        vscode.commands.registerCommand('gitfocal.copyTagCommitHash', async (arg) => {
            const resolved = await resolveTagNode(stateManager, arg);
            if (!resolved) {
                return;
            }
            const hash = resolved.tag.commitHashFull || resolved.tag.commitHash;
            if (hash) {
                await vscode.env.clipboard.writeText(hash);
            }
        })
    ];
}

module.exports = { registerTagCommands };
