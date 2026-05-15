'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { GitError } = require('./gitTypes');
const { resolveGitPath } = require('../utils/gitPathResolver');
const { normalizeFsPath } = require('../utils/pathUtils');

const REMOTE_TAG_CACHE_TTL_MS = 30 * 1000;

/**
 * Direct git CLI wrapper. Uses only Node.js built-ins (`child_process`).
 */
class GitService {
    constructor() {
        this.remoteTagCache = new Map();
    }

    /** Execute a git command and return stdout. Throws GitError on failure. */
    async exec(repoPath, args, opts) {
        const options = opts || {};
        const gitPath = await resolveGitPath();
        return new Promise((resolve, reject) => {
            execFile(
                gitPath,
                args,
                {
                    cwd: repoPath,
                    maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
                    windowsHide: true,
                    env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' })
                },
                (err, stdout, stderr) => {
                    if (err) {
                        if (options.allowFailure) {
                            resolve((stdout || '') + (stderr || ''));
                            return;
                        }
                        const msg = (stderr || err.message || '').trim();
                        reject(new GitError(msg || 'git command failed', `git ${args.join(' ')}`, stderr || ''));
                        return;
                    }
                    resolve(stdout);
                }
            );
        });
    }

    async isRepository(repoPath) {
        try {
            const out = await this.exec(repoPath, ['rev-parse', '--is-inside-work-tree']);
            return out.trim() === 'true';
        } catch {
            return false;
        }
    }

    async getRepoRoot(repoPath) {
        const out = await this.exec(repoPath, ['rev-parse', '--show-toplevel']);
        return normalizeFsPath(out.trim());
    }

    async getGitDir(repoPath) {
        const out = await this.exec(repoPath, ['rev-parse', '--git-common-dir']);
        const trimmed = out.trim();
        // git may return a relative path when run inside the work tree.
        const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(repoPath, trimmed);
        return normalizeFsPath(absolute);
    }

    async getCurrentBranch(repoPath) {
        const out = await this.exec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        return out.trim();
    }

    async getBranches(repoPath) {
        const SEP = '\x1f';
        const REC = '\x1e';
        const fmt = [
            '%(refname)',
            '%(refname:short)',
            '%(HEAD)',
            '%(objectname)',
            '%(objectname:short)',
            '%(upstream:short)',
            '%(upstream:track)',
            '%(contents:subject)'
        ].join(SEP) + REC;

        const out = await this.exec(repoPath, [
            'for-each-ref',
            `--format=${fmt}`,
            'refs/heads',
            'refs/remotes'
        ]);

        const records = out.split(REC).map(r => r.trim()).filter(Boolean);
        const branches = [];

        for (const rec of records) {
            const fields = rec.split(SEP);
            if (fields.length < 8) {
                continue;
            }
            const refName = fields[0];
            const shortName = fields[1];
            const isCurrent = fields[2].trim() === '*';
            const commitHashFull = fields[3];
            const commitHash = fields[4];
            const upstream = fields[5] || undefined;
            const track = fields[6] || '';
            const subject = fields[7] || undefined;

            const isRemote = refName.startsWith('refs/remotes/');
            if (isRemote && shortName.endsWith('/HEAD')) {
                continue;
            }

            let remoteName;
            if (isRemote) {
                const slash = shortName.indexOf('/');
                remoteName = slash > 0 ? shortName.substring(0, slash) : undefined;
            }

            branches.push({
                name: shortName,
                refName,
                isRemote,
                isCurrent,
                isTracking: !!upstream,
                upstream,
                upstreamGone: !!upstream && track.includes('[gone]'),
                aheadBehind: parseAheadBehind(track),
                commitHash,
                commitHashFull,
                commitSubject: subject,
                remoteName
            });
        }

        try {
            const worktrees = await this.getWorkTrees(repoPath);
            for (const wt of worktrees) {
                if (!wt.branch) {
                    continue;
                }
                const b = branches.find(br => br.refName === wt.branch);
                if (b) {
                    b.workTreePath = wt.path;
                }
            }
        } catch {
            // worktree info is best-effort
        }

        return branches;
    }

    async getStashes(repoPath) {
        const SEP = '\x1f';
        const out = await this.exec(repoPath, [
            'stash', 'list',
            `--format=%gd${SEP}%gs${SEP}%s`
        ], { allowFailure: true });

        const stashes = [];
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            const fields = line.split(SEP);
            const id = fields[0];
            const reflogSubject = fields[1] || '';
            const subject = fields[2] || '';

            const indexMatch = id.match(/stash@\{(\d+)\}/);
            const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

            let branch;
            const m = reflogSubject.match(/^(?:WIP )?[Oo]n ([^:]+):/);
            if (m) {
                branch = m[1];
            }

            const cleanedSubject = subject.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, '');
            const cleanedReflog = reflogSubject.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, '');

            stashes.push({
                id,
                index,
                description: cleanedReflog || cleanedSubject,
                branch,
                subject: cleanedSubject
            });
        }
        return stashes;
    }

    async getBranchCommits(repoPath, refName, limit) {
        const SEP = '\x1f';
        const REC = '\x1e';
        const max = Math.max(1, limit || 10);
        const fmt = ['%H', '%h', '%s', '%an', '%ar'].join(SEP) + REC;
        const out = await this.exec(repoPath, [
            'log',
            `-n${max}`,
            `--format=${fmt}`,
            refName,
            '--'
        ], { allowFailure: true });

        const records = out.split(REC).map(r => r.trim()).filter(Boolean);
        const commits = [];
        for (const rec of records) {
            const fields = rec.split(SEP);
            if (fields.length < 5) {
                continue;
            }
            commits.push({
                hash: fields[0],
                shortHash: fields[1],
                subject: fields[2],
                author: fields[3],
                relativeDate: fields[4]
            });
        }
        return commits;
    }

    async getStashFiles(repoPath, stashId) {
        const out = await this.getStashNameStatus(repoPath, stashId);

        const files = [];
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            // Format: "<status>\t<path>" or for renames/copies
            // "R<score>\t<old>\t<new>" / "C<score>\t<old>\t<new>".
            const parts = line.split('\t');
            if (parts.length < 2) {
                continue;
            }
            const status = parts[0].trim();
            const head = (status || '').charAt(0);
            const originalPath = ((head === 'R' || head === 'C') && parts.length >= 3
                ? parts[1]
                : undefined);
            const filePath = ((head === 'R' || head === 'C') && parts.length >= 3
                ? parts[2]
                : parts[1]).trim();
            if (!filePath) {
                continue;
            }
            files.push({ status, path: filePath, originalPath });
        }
        return files;
    }

    async getStashNameStatus(repoPath, stashId) {
        try {
            return await this.exec(repoPath, [
                'stash', 'show', '--name-status', '--include-untracked', stashId
            ]);
        } catch (err) {
            if (!isUnsupportedStashShowOption(err)) {
                throw err;
            }
            return this.exec(repoPath, [
                'stash', 'show', '--name-status', stashId
            ]);
        }
    }

    async getStashPatch(repoPath, stashId) {
        try {
            return await this.exec(repoPath, [
                'stash', 'show', '--patch', '--stat', '--include-untracked', stashId
            ]);
        } catch (err) {
            if (!isUnsupportedStashShowOption(err)) {
                throw err;
            }
            return this.exec(repoPath, [
                'stash', 'show', '--patch', '--stat', stashId
            ]);
        }
    }

    async getStashFileContent(repoPath, stashId, filePath, side, originalPath) {
        const targetPath = side === 'left' && originalPath ? originalPath : filePath;
        const revisions = side === 'left' ? [`${stashId}^1`] : [stashId, `${stashId}^3`];
        for (const revision of revisions) {
            try {
                return await this.exec(repoPath, ['show', `${revision}:${targetPath}`]);
            } catch {
                // Missing paths are represented as empty documents in VS Code's diff editor.
            }
        }
        return '';
    }

    async getWorkTrees(repoPath) {
        const out = await this.exec(repoPath, ['worktree', 'list', '--porcelain']);
        const records = out.split(/\r?\n\r?\n/).map(r => r.trim()).filter(Boolean);
        const worktrees = [];
        let isFirst = true;
        for (const rec of records) {
            const lines = rec.split(/\r?\n/);
            let p = '';
            let head;
            let branch;
            let isDetached = false;
            let isLocked = false;
            let isPrunable = false;
            for (const line of lines) {
                if (line.startsWith('worktree ')) {
                    p = line.substring('worktree '.length).trim();
                } else if (line.startsWith('HEAD ')) {
                    head = line.substring('HEAD '.length).trim();
                } else if (line.startsWith('branch ')) {
                    branch = line.substring('branch '.length).trim();
                } else if (line.trim() === 'detached') {
                    isDetached = true;
                } else if (line.startsWith('locked')) {
                    isLocked = true;
                } else if (line.startsWith('prunable')) {
                    isPrunable = true;
                }
            }
            if (p) {
                worktrees.push({
                    path: p,
                    branch,
                    head,
                    isDetached,
                    isLocked,
                    isPrunable,
                    isMain: isFirst
                });
                isFirst = false;
            }
        }
        return worktrees;
    }

    // --- Branch operations ---

    async checkoutBranch(repoPath, branch) {
        await this.exec(repoPath, ['checkout', '--end-of-options', branch]);
    }

    async checkoutRemoteAsLocal(repoPath, remoteBranch, localName) {
        await this.exec(repoPath, ['checkout', '-b', localName, '--track', '--end-of-options', remoteBranch]);
    }

    async createBranch(repoPath, name, from) {
        const args = ['branch', '--end-of-options', name];
        if (from) {
            args.push(from);
        }
        await this.exec(repoPath, args);
    }

    async deleteBranch(repoPath, branch, force) {
        await this.exec(repoPath, ['branch', force ? '-D' : '-d', '--end-of-options', branch]);
    }

    async deleteRemoteBranch(repoPath, remote, branch) {
        await this.exec(repoPath, ['push', '--delete', '--end-of-options', remote, branch]);
    }

    async mergeBranch(repoPath, branch) {
        await this.exec(repoPath, ['merge', '--end-of-options', branch]);
    }

    async rebaseBranch(repoPath, onto) {
        await this.exec(repoPath, ['rebase', '--end-of-options', onto]);
    }

    async cherryPick(repoPath, hash) {
        await this.exec(repoPath, ['cherry-pick', '--end-of-options', hash]);
    }

    async fetchRemote(repoPath, remote) {
        const args = ['fetch'];
        if (remote) {
            args.push(remote);
        } else {
            args.push('--all');
        }
        args.push('--prune');
        await this.exec(repoPath, args);
    }

    async pull(repoPath) {
        await this.exec(repoPath, ['pull', '--ff-only']);
    }

    async push(repoPath, setUpstream, branchName) {
        const args = ['push'];
        if (setUpstream) {
            const branch = branchName || await this.getCurrentBranch(repoPath);
            args.push('-u', 'origin', branch);
        }
        await this.exec(repoPath, args);
    }

    async squashCommits(repoPath, count, message) {
        if (count < 2) {
            throw new GitError('Squash count must be >= 2', 'gitfocal squash', '');
        }
        // We must avoid `--edit` here: execFile has no TTY and git would hang waiting
        // for an editor. The caller is responsible for prompting the user for a message.
        const commitMessage = message && message.trim() ? message : `Squashed ${count} commits`;
        await this.exec(repoPath, ['reset', '--soft', `HEAD~${count}`]);
        await this.exec(repoPath, ['commit', '-m', commitMessage]);
    }

    async resetBranch(repoPath, target, mode) {
        await this.exec(repoPath, ['reset', `--${mode}`, '--end-of-options', target]);
    }

    async setUpstream(repoPath, branch, upstream) {
        await this.exec(repoPath, ['branch', `--set-upstream-to=${upstream}`, '--end-of-options', branch]);
    }

    async listRemotes(repoPath) {
        const out = await this.exec(repoPath, ['remote']);
        return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    }

    async getRemoteTags(repoPath, remote) {
        const normalizedRepoPath = normalizeFsPath(repoPath);
        const cacheKey = `${normalizedRepoPath}::${remote}`;
        const cached = this.remoteTagCache.get(cacheKey);
        if (cached && (Date.now() - cached.fetchedAt) < REMOTE_TAG_CACHE_TTL_MS) {
            return cached.tags;
        }

        const out = await this.exec(repoPath, ['ls-remote', '--tags', remote]);
        const tags = new Map();
        const lines = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

        for (const line of lines) {
            const [sha, refName] = line.split(/\s+/);
            if (!sha || !refName || !refName.startsWith('refs/tags/')) {
                continue;
            }
            const isPeeled = refName.endsWith('^{}');
            const tagName = isPeeled
                ? refName.substring('refs/tags/'.length, refName.length - 3)
                : refName.substring('refs/tags/'.length);
            const current = tags.get(tagName) || {};
            if (isPeeled) {
                current.commitHashFull = sha;
            } else {
                current.objectHashFull = sha;
            }
            tags.set(tagName, current);
        }

        for (const entry of tags.values()) {
            if (!entry.commitHashFull) {
                entry.commitHashFull = entry.objectHashFull || '';
            }
        }

        this.remoteTagCache.set(cacheKey, {
            fetchedAt: Date.now(),
            tags
        });
        return tags;
    }

    invalidateRemoteTagCache(repoPath, remote) {
        const normalizedRepoPath = normalizeFsPath(repoPath);
        if (remote) {
            this.remoteTagCache.delete(`${normalizedRepoPath}::${remote}`);
            return;
        }
        for (const key of this.remoteTagCache.keys()) {
            if (key.startsWith(`${normalizedRepoPath}::`)) {
                this.remoteTagCache.delete(key);
            }
        }
    }

    // --- Stash operations ---

    async stashPush(repoPath, message, includeUntracked) {
        const args = ['stash', 'push'];
        if (includeUntracked) {
            args.push('-u');
        }
        if (message) {
            args.push('-m', message);
        }
        await this.exec(repoPath, args);
    }

    async getUntrackedPaths(repoPath, paths) {
        if (!paths || paths.length === 0) {
            return [];
        }
        const out = await this.exec(repoPath, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            ...paths
        ]);
        return out.split('\0').filter(Boolean);
    }

    async stagePaths(repoPath, paths) {
        if (!paths || paths.length === 0) {
            return;
        }
        await this.exec(repoPath, ['add', '--', ...paths]);
    }

    async unstagePaths(repoPath, paths) {
        if (!paths || paths.length === 0) {
            return;
        }
        await this.exec(repoPath, ['reset', '--', ...paths]);
    }

    async stashPushPaths(repoPath, paths, message, options) {
        const opts = options || {};

        // Path-less form: behaves like the regular stash variants.
        if (!paths || paths.length === 0) {
            const args = ['stash', 'push'];
            if (opts.staged) args.push('--staged');
            if (opts.keepIndex) args.push('--keep-index');
            if (opts.includeUntracked) args.push('-u');
            if (message) args.push('-m', message);
            await this.exec(repoPath, args);
            return;
        }

        // `git stash push -- <pathspec>` is NOT actually scoped to the pathspec
        // for the index portion of the stash entry: git always snapshots the
        // full index. So if other files are staged/modified/untracked, they end
        // up captured by the stash too (and would be re-applied on pop).
        //
        // To produce a stash that contains *only* the selected paths, we:
        //   1. Temporarily stash every OTHER changed path (with -u so untracked
        //      ones are included).
        //   2. Stash the selected paths in isolation.
        //   3. Pop the temp stash with --index to restore the prior
        //      staged/unstaged/untracked state of the unaffected files.
        const selectedSet = new Set(paths);
        const allChanged = await this.getChangedPaths(repoPath);
        const others = allChanged.filter(p => !selectedSet.has(p));

        let tempStashed = false;
        if (others.length > 0) {
            const tempArgs = ['stash', 'push', '-u', '-m', 'gitfocal: temporary (stash selected)', '--', ...others];
            await this.exec(repoPath, tempArgs);
            tempStashed = true;
        }

        try {
            // -u ensures any selected untracked files are also captured. With a
            // pathspec, -u only includes untracked entries that match it, so
            // unrelated untracked files (already moved to the temp stash) are
            // not pulled in.
            const args = ['stash', 'push', '-u'];
            if (message) args.push('-m', message);
            args.push('--', ...paths);
            try {
                await this.exec(repoPath, args);
            } catch (err) {
                // The selected paths may have no changes (e.g. user picked a
                // file that wasn't actually modified). Treat that as a no-op
                // rather than an error so we can still restore the temp stash.
                const msg = err instanceof Error ? err.message : String(err || '');
                if (!/no local changes to save/i.test(msg)) {
                    throw err;
                }
            }
        } catch (err) {
            if (tempStashed) {
                // Restore the others we set aside before re-throwing.
                try {
                    await this.exec(repoPath, ['stash', 'pop', '--index', 'stash@{0}']);
                } catch {
                    // Best-effort; preserve the original failure for the user.
                }
            }
            throw err;
        }

        if (tempStashed) {
            // After step 2 the temp stash is at index 1 (selected stash at 0).
            await this.exec(repoPath, ['stash', 'pop', '--index', 'stash@{1}']);
        }
    }

    async getChangedPaths(repoPath) {
        const out = await this.exec(repoPath, [
            'status', '-z', '--porcelain', '--untracked-files=all'
        ], { allowFailure: true });
        if (!out) return [];
        const tokens = out.split('\0');
        const paths = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (!tok || tok.length < 4) continue;
            const xy = tok.substring(0, 2);
            const filePath = tok.substring(3);
            // Renames/copies are emitted as "XY <new>\0<old>\0"; consume the
            // old-path token so it isn't mistaken for the next entry.
            if (xy.charAt(0) === 'R' || xy.charAt(0) === 'C') {
                i++;
            }
            if (filePath) {
                paths.push(filePath);
            }
        }
        return paths;
    }

    async stashAllChanges(repoPath, message) {
        const args = ['stash', 'push', '-u'];
        if (message) {
            args.push('-m', message);
        }
        await this.exec(repoPath, args);
    }

    async stashStagedChanges(repoPath, message) {
        const args = ['stash', 'push', '--staged'];
        if (message) {
            args.push('-m', message);
        }
        await this.exec(repoPath, args);
    }

    async stashUnstagedChanges(repoPath, message) {
        // Use `--keep-index`: stash all changes (staged + unstaged) but reset the
        // working tree to match the index afterwards. The net effect is that only
        // the unstaged work is removed from the working tree, while staged hunks
        // remain intact in the index. This is the standard git idiom for "stash
        // only the unstaged changes" and correctly handles files that have both
        // staged and unstaged hunks (which a path-based `git stash push -- <path>`
        // would silently stash in full, dropping the user's staged work).
        const args = ['stash', 'push', '--keep-index'];
        if (message) {
            args.push('-m', message);
        }
        await this.exec(repoPath, args);
    }

    async stashApply(repoPath, id) {
        await this.exec(repoPath, ['stash', 'apply', id]);
    }

    async stashApplyFile(repoPath, id, filePath) {
        // Restore a single file from the stash into the working tree.
        await this.exec(repoPath, ['checkout', id, '--', filePath]);
    }

    async stashPop(repoPath, id) {
        await this.exec(repoPath, ['stash', 'pop', id]);
    }

    async stashDrop(repoPath, id) {
        await this.exec(repoPath, ['stash', 'drop', id]);
    }

    async stashRename(repoPath, id, newMessage) {
        const shaOut = await this.exec(repoPath, ['rev-parse', id]);
        const sha = shaOut.trim();
        if (!sha) {
            throw new GitError(`Could not resolve ${id}`, `git rev-parse ${id}`, '');
        }
        // Store the renamed entry BEFORE dropping the old one. `git stash store`
        // pushes a new stash referencing the same commit object; if it fails the
        // original stash is untouched. If the subsequent drop fails the user
        // sees a duplicate entry rather than losing the stash.
        await this.exec(repoPath, ['stash', 'store', '-m', newMessage, sha]);
        try {
            await this.exec(repoPath, ['stash', 'drop', id]);
        } catch (err) {
            // Best-effort: try to remove the duplicate we just created so we
            // don't leave the user with two copies of the same stash.
            try {
                await this.exec(repoPath, ['stash', 'drop', 'stash@{0}']);
            } catch {
                // swallow; the original entry is still present
            }
            throw err;
        }
    }

    async renameBranch(repoPath, oldName, newName) {
        await this.exec(repoPath, ['branch', '-m', '--end-of-options', oldName, newName]);
    }

    // --- Tag operations ---

    async getTags(repoPath) {
        const SEP = '\x1f';
        const REC = '\x1e';
        // For annotated tags: %(taggername)/%(taggerdate:relative)/%(contents:subject)
        // For lightweight tags: those tagger fields are empty; fall back to the commit's
        // metadata via *fields (which dereference to the target commit).
        const fmt = [
            '%(refname)',
            '%(refname:short)',
            '%(objecttype)',
            '%(objectname)',
            '%(*objectname)',
            '%(*objectname:short)',
            '%(taggername)',
            '%(taggerdate:relative)',
            '%(contents:subject)',
            '%(*authorname)',
            '%(*authordate:relative)',
            '%(*subject)'
        ].join(SEP) + REC;

        const out = await this.exec(repoPath, [
            'for-each-ref',
            `--format=${fmt}`,
            '--sort=-creatordate',
            'refs/tags'
        ], { allowFailure: true });

        const records = out.split(REC).map(r => r.trim()).filter(Boolean);
        const tags = [];
        for (const rec of records) {
            const f = rec.split(SEP);
            if (f.length < 12) {
                continue;
            }
            const objectType = f[2];
            const isAnnotated = objectType === 'tag';
            // For annotated tags, %(objectname) is the tag object SHA and %(*objectname)
            // is the dereferenced commit. For lightweight tags, %(*objectname) is empty
            // and %(objectname) is already the commit.
            const commitHashFull = f[4] || f[3];
            const commitHash = f[5] || (commitHashFull ? commitHashFull.substring(0, 7) : '');
            tags.push({
                name: f[1],
                refName: f[0],
                isAnnotated,
                commitHash,
                commitHashFull,
                tagger: isAnnotated ? (f[6] || undefined) : (f[9] || undefined),
                taggerDate: isAnnotated ? (f[7] || undefined) : (f[10] || undefined),
                subject: isAnnotated ? (f[8] || undefined) : (f[11] || undefined)
            });
        }

        const remotes = await this.listRemotes(repoPath).catch(() => []);
        if (remotes.length === 0) {
            return tags.map(tag => ({
                ...tag,
                originStatus: 'no-remote',
                canPushTag: false
            }));
        }

        if (!remotes.includes('origin')) {
            return tags.map(tag => ({
                ...tag,
                originStatus: 'no-origin',
                canPushTag: true
            }));
        }

        let remoteTags;
        try {
            remoteTags = await this.getRemoteTags(repoPath, 'origin');
        } catch {
            return tags.map(tag => ({
                ...tag,
                originStatus: 'unavailable',
                canPushTag: true
            }));
        }

        return tags.map(tag => {
            const remoteTag = remoteTags.get(tag.name);
            if (!remoteTag) {
                return {
                    ...tag,
                    originStatus: 'missing',
                    canPushTag: true
                };
            }

            const localCommitHashFull = tag.commitHashFull || tag.commitHash || '';
            const originCommitHashFull = remoteTag.commitHashFull || remoteTag.objectHashFull || '';
            const sameCommit = !!localCommitHashFull && !!originCommitHashFull && localCommitHashFull === originCommitHashFull;

            return {
                ...tag,
                originStatus: sameCommit ? 'same' : 'different',
                originCommitHashFull: originCommitHashFull || undefined,
                originCommitHash: originCommitHashFull ? originCommitHashFull.substring(0, 7) : undefined,
                canPushTag: !sameCommit
            };
        });
    }

    async createTag(repoPath, name, options) {
        const opts = options || {};
        const args = ['tag'];
        if (opts.force) {
            args.push('-f');
        }
        if (opts.message) {
            args.push('-a', name, '-m', opts.message);
        } else {
            args.push(name);
        }
        if (opts.ref) {
            args.push(opts.ref);
        }
        await this.exec(repoPath, args);
    }

    async deleteTag(repoPath, name) {
        await this.exec(repoPath, ['tag', '-d', '--end-of-options', name]);
    }

    async renameTag(repoPath, oldName, newName) {
        // Preserve the original tag object (annotated or lightweight) by moving the ref
        // rather than re-creating it (which would dereference to the commit).
        await this.exec(repoPath, ['update-ref', `refs/tags/${newName}`, `refs/tags/${oldName}`]);
        await this.exec(repoPath, ['update-ref', '-d', `refs/tags/${oldName}`]);
    }

    async pushTag(repoPath, name, remote, options) {
        const opts = options || {};
        const r = remote || 'origin';
        const args = ['push'];
        if (opts.force) {
            args.push('--force');
        }
        args.push(r, `refs/tags/${name}`);
        await this.exec(repoPath, args);
        this.invalidateRemoteTagCache(repoPath, r);
    }

    async deleteRemoteTag(repoPath, remote, name) {
        await this.exec(repoPath, ['push', remote, '--delete', `refs/tags/${name}`]);
        this.invalidateRemoteTagCache(repoPath, remote);
    }
}

function isUnsupportedStashShowOption(err) {
    const detail = err instanceof Error ? `${err.message}\n${err.stderr || ''}` : String(err || '');
    return /include-untracked|unknown option/i.test(detail);
}

function parseAheadBehind(track) {
    const result = { ahead: 0, behind: 0 };
    if (!track) {
        return result;
    }
    const aheadMatch = track.match(/ahead (\d+)/);
    if (aheadMatch) {
        result.ahead = parseInt(aheadMatch[1], 10);
    }
    const behindMatch = track.match(/behind (\d+)/);
    if (behindMatch) {
        result.behind = parseInt(behindMatch[1], 10);
    }
    return result;
}

module.exports = { GitService };
