'use strict';

const vscode = require('vscode');
const { confirm, pickRepo, reportGitError, withProgress } = require('./commandHelpers');

function isTagNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'tag';
}

function isCommitNode(arg) {
    return !!arg && typeof arg === 'object' && arg.kind === 'commit';
}

function isTagAlreadyExistsError(err) {
    const detail = err instanceof Error ? err.message : (err ? String(err) : '');
    return /tag '.*' already exists/i.test(detail);
}

function getOverwriteTagPrompt(name, ref, existingTag) {
    const currentTarget = existingTag && (existingTag.commitHash || existingTag.commitHashFull)
        ? ` at ${existingTag.commitHash || existingTag.commitHashFull}`
        : '';
    const replacementTarget = ref ? ` at ${ref}` : ' at HEAD';
    return `Tag '${name}' already exists${currentTarget}. Overwrite it${replacementTarget}?`;
}

async function resolveTagNode(stateManager, arg, options) {
    const opts = options || {};
    if (isTagNode(arg) && arg.tag) {
        const state = stateManager.getState(arg.repoPath);
        if (state) {
            if (opts.localOnly && arg.tag.isRemoteOnly) {
                void vscode.window.showInformationMessage(`GitFocal: tag '${arg.tag.name}' only exists on the remote.`);
                return undefined;
            }
            return { state, tag: arg.tag };
        }
    }
    const repo = await pickRepo(stateManager, isTagNode(arg) ? arg.repoPath : undefined);
    if (!repo) {
        return undefined;
    }
    const tags = opts.localOnly
        ? (repo.tags || []).filter(tag => !tag.isRemoteOnly)
        : (repo.tags || []);
    if (tags.length === 0) {
        void vscode.window.showInformationMessage(opts.localOnly
            ? 'GitFocal: no local tags in this repository.'
            : 'GitFocal: no tags in this repository.');
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
    const existingTag = (repo.tags || []).find(tag => tag.name === trimmed);
    let force = false;
    if (existingTag) {
        force = await confirm(getOverwriteTagPrompt(trimmed, ref, existingTag), 'Overwrite');
        if (!force) {
            return false;
        }
    }
    const runCreateTag = () => withProgress(
        `${force ? 'Overwrite' : 'Create'} tag ${trimmed}`,
        () => git.createTag(repo.repoPath, trimmed, { ref, message, force })
    );
    try {
        await runCreateTag();
        await stateManager.refresh(repo.repoPath);
        return true;
    } catch (err) {
        if (!force && isTagAlreadyExistsError(err)) {
            force = await confirm(getOverwriteTagPrompt(trimmed, ref, existingTag), 'Overwrite');
            if (!force) {
                return false;
            }
            try {
                await runCreateTag();
                await stateManager.refresh(repo.repoPath);
                return true;
            } catch (forceErr) {
                reportGitError(forceErr, `Failed to overwrite tag ${trimmed}`);
                return false;
            }
        }
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
            const resolved = await resolveTagNode(stateManager, arg, { localOnly: true });
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
            const resolved = await resolveTagNode(stateManager, arg, { localOnly: true });
            if (!resolved) {
                return;
            }
            const { state, tag } = resolved;
            const existingLocalTags = (state.tags || [])
                .filter(candidate => !candidate.isRemoteOnly && candidate.name !== tag.name)
                .map(candidate => candidate.name);
            const newName = await vscode.window.showInputBox({
                prompt: `Rename tag '${tag.name}' to`,
                value: tag.name,
                validateInput: v => {
                    const trimmed = v && v.trim();
                    if (!trimmed || /\s/.test(trimmed) || trimmed === tag.name) {
                        return 'Enter a new non-empty name without spaces';
                    }
                    return existingLocalTags.includes(trimmed) ? `Tag '${trimmed}' already exists` : null;
                }
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
            const resolved = await resolveTagNode(stateManager, arg, { localOnly: true });
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
            if (remotes.length === 0) {
                void vscode.window.showInformationMessage('GitFocal: no remotes configured.');
                return;
            }

            let remote;
            if (remotes.includes('origin')) {
                remote = 'origin';
            } else if (remotes.length === 1) {
                remote = remotes[0];
            } else {
                const pick = await vscode.window.showQuickPick(remotes, { placeHolder: 'Push tag to remote' });
                if (!pick) {
                    return;
                }
                remote = pick;
            }

            const force = remote === 'origin' && tag.originStatus === 'different';
            if (force) {
                const ok = await confirm(
                    `Replace tag '${tag.name}' on origin (${tag.originCommitHash || 'different commit'}) with local ${tag.commitHash || 'commit'}?`,
                    'Force Push'
                );
                if (!ok) {
                    return;
                }
            }

            try {
                await withProgress(`${force ? 'Force push' : 'Push'} tag ${tag.name} to ${remote}`, () =>
                    git.pushTag(state.repoPath, tag.name, remote, { force }));
                await stateManager.refresh(state.repoPath);
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
        }),

        vscode.commands.registerCommand('gitfocal.pushAllTags', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            const remotes = await git.listRemotes(repo.repoPath).catch(() => []);
            if (remotes.length === 0) {
                void vscode.window.showInformationMessage('GitFocal: no remotes configured.');
                return;
            }
            let remote = remotes.includes('origin') ? 'origin' : remotes[0];
            if (remotes.length > 1) {
                const pick = await vscode.window.showQuickPick(remotes, { placeHolder: 'Push all tags to remote' });
                if (!pick) {
                    return;
                }
                remote = pick;
            }
            const ok = await confirm(`Push all local tags to '${remote}'?`, 'Push Tags');
            if (!ok) {
                return;
            }
            try {
                await withProgress(`Push all tags to ${remote}`, () =>
                    git.pushAllTags(repo.repoPath, remote));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, `Failed to push tags to ${remote}`);
            }
        }),

        vscode.commands.registerCommand('gitfocal.fetchTags', async () => {
            const repo = await pickRepo(stateManager);
            if (!repo) {
                return;
            }
            try {
                await withProgress('Fetch tags', () => git.fetchTags(repo.repoPath));
                await stateManager.refresh(repo.repoPath);
            } catch (err) {
                reportGitError(err, 'Failed to fetch tags');
            }
        })
    ];
}

module.exports = { registerTagCommands };
