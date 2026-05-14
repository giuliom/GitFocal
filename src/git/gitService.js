'use strict';

const { execFile } = require('child_process');
const { GitError } = require('./gitTypes');
const { resolveGitPath } = require('../utils/gitPathResolver');

/**
 * Direct git CLI wrapper. Uses only Node.js built-ins (`child_process`).
 */
class GitService {
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
        return out.trim();
    }

    async getGitDir(repoPath) {
        const out = await this.exec(repoPath, ['rev-parse', '--git-common-dir']);
        return out.trim();
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
        const out = await this.exec(repoPath, [
            'stash', 'show', '--name-status', stashId
        ], { allowFailure: true });

        const files = [];
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            // Format: "<status>\t<path>" e.g. "M\tsrc/foo.js"
            const tab = line.indexOf('\t');
            if (tab < 0) {
                continue;
            }
            const status = line.substring(0, tab).trim();
            const filePath = line.substring(tab + 1).trim();
            if (!filePath) {
                continue;
            }
            files.push({ status, path: filePath });
        }
        return files;
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
        await this.exec(repoPath, ['checkout', branch]);
    }

    async checkoutRemoteAsLocal(repoPath, remoteBranch, localName) {
        await this.exec(repoPath, ['checkout', '-b', localName, '--track', remoteBranch]);
    }

    async createBranch(repoPath, name, from) {
        const args = ['branch', name];
        if (from) {
            args.push(from);
        }
        await this.exec(repoPath, args);
    }

    async deleteBranch(repoPath, branch, force) {
        await this.exec(repoPath, ['branch', force ? '-D' : '-d', branch]);
    }

    async deleteRemoteBranch(repoPath, remote, branch) {
        await this.exec(repoPath, ['push', remote, '--delete', branch]);
    }

    async mergeBranch(repoPath, branch) {
        await this.exec(repoPath, ['merge', branch]);
    }

    async rebaseBranch(repoPath, onto) {
        await this.exec(repoPath, ['rebase', onto]);
    }

    async cherryPick(repoPath, hash) {
        await this.exec(repoPath, ['cherry-pick', hash]);
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

    async push(repoPath, setUpstream) {
        const args = ['push'];
        if (setUpstream) {
            const branch = await this.getCurrentBranch(repoPath);
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
        await this.exec(repoPath, ['reset', `--${mode}`, target]);
    }

    async setUpstream(repoPath, branch, upstream) {
        await this.exec(repoPath, ['branch', `--set-upstream-to=${upstream}`, branch]);
    }

    async listRemotes(repoPath) {
        const out = await this.exec(repoPath, ['remote']);
        return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
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

    async stashPushPaths(repoPath, paths, message, options) {
        const opts = options || {};
        const args = ['stash', 'push'];
        if (opts.staged) {
            args.push('--staged');
        }
        if (opts.keepIndex) {
            args.push('--keep-index');
        }
        if (opts.includeUntracked) {
            args.push('-u');
        }
        if (message) {
            args.push('-m', message);
        }
        if (paths && paths.length > 0) {
            args.push('--');
            for (const p of paths) {
                args.push(p);
            }
        }
        await this.exec(repoPath, args);
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
        const unstagedOut = await this.exec(repoPath, ['diff', '--name-only'], { allowFailure: true });
        const untrackedOut = await this.exec(repoPath, ['ls-files', '--others', '--exclude-standard'], { allowFailure: true });
        const paths = [
            ...unstagedOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
            ...untrackedOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        ];
        if (paths.length === 0) {
            throw new GitError('No unstaged changes to stash', 'git stash unstaged', '');
        }
        const args = ['stash', 'push', '-u'];
        if (message) {
            args.push('-m', message);
        }
        args.push('--');
        for (const p of paths) {
            args.push(p);
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
        // Capture the original commit subject so we can rollback if `stash store` fails.
        let originalMessage = '';
        try {
            originalMessage = (await this.exec(repoPath, ['log', '-1', '--format=%s', sha])).trim();
        } catch {
            // best-effort; rollback may not be possible
        }
        await this.exec(repoPath, ['stash', 'drop', id]);
        try {
            await this.exec(repoPath, ['stash', 'store', '-m', newMessage, sha]);
        } catch (err) {
            if (originalMessage) {
                try {
                    await this.exec(repoPath, ['stash', 'store', '-m', originalMessage, sha]);
                } catch {
                    // swallow; the SHA remains reachable via reflog/object db
                }
            }
            throw err;
        }
    }

    async renameBranch(repoPath, oldName, newName) {
        await this.exec(repoPath, ['branch', '-m', oldName, newName]);
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
        return tags;
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
        await this.exec(repoPath, ['tag', '-d', name]);
    }

    async renameTag(repoPath, oldName, newName) {
        // Preserve the original tag object (annotated or lightweight) by moving the ref
        // rather than re-creating it (which would dereference to the commit).
        await this.exec(repoPath, ['update-ref', `refs/tags/${newName}`, `refs/tags/${oldName}`]);
        await this.exec(repoPath, ['update-ref', '-d', `refs/tags/${oldName}`]);
    }

    async pushTag(repoPath, name, remote) {
        const r = remote || 'origin';
        await this.exec(repoPath, ['push', r, `refs/tags/${name}`]);
    }

    async deleteRemoteTag(repoPath, remote, name) {
        await this.exec(repoPath, ['push', remote, '--delete', `refs/tags/${name}`]);
    }
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
