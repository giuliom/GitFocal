'use strict';

const vscode = require('vscode');
const { debounce } = require('../utils/debounce');
const { createRepositoryState, emptyRepositoryState } = require('./repositoryState');
const { normalizeFsPath, pathsEqual, pathStartsWith } = require('../utils/pathUtils');

/**
 * Manages per-workspace-folder repository state with FileSystemWatcher-driven refresh.
 */
class StateManager {
    constructor(git) {
        this.git = git;
        this.entries = new Map();
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
        this.disposables = [];

        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(e => this.handleWorkspaceFoldersChanged(e)),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gitfocal.refreshDebounceMs')) {
                    this.rebuildAllWatchers();
                }
                if (e.affectsConfiguration('gitfocal.autoFetchIntervalMinutes')) {
                    this.rebuildAllAutoFetch();
                }
            })
        );
    }

    async initialize() {
        const folders = vscode.workspace.workspaceFolders || [];
        for (const f of folders) {
            await this.addFolder(f);
        }
        this.subscribeToGitExtension();
    }

    getStates() {
        return Array.from(this.entries.values()).map(e => e.state);
    }

    getState(repoPath) {
        const e = this.entries.get(repoPath);
        return e ? e.state : undefined;
    }

    async refresh(repoPath) {
        if (repoPath) {
            await this.refreshRepo(repoPath);
        } else {
            for (const key of this.entries.keys()) {
                await this.refreshRepo(key);
            }
        }
    }

    dispose() {
        for (const e of this.entries.values()) {
            e.refreshDebounced.cancel();
            if (e.watcher) {
                e.watcher.dispose();
            }
            if (e.autoFetchTimer) {
                clearInterval(e.autoFetchTimer);
            }
        }
        this.entries.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChange.dispose();
    }

    // --- Private ---

    async handleWorkspaceFoldersChanged(e) {
        for (const removed of e.removed) {
            this.removeFolder(normalizeFsPath(removed.uri.fsPath));
        }
        for (const added of e.added) {
            await this.addFolder(added);
        }
    }

    async addFolder(folder) {
        const folderPath = normalizeFsPath(folder.uri.fsPath);
        let repoRoot;
        try {
            if (!(await this.git.isRepository(folderPath))) {
                return;
            }
            repoRoot = await this.git.getRepoRoot(folderPath);
        } catch {
            return;
        }

        // Entries are keyed by repo root so that multiple workspace folders inside the
        // same repository collapse to a single entry. Track each contributing folder
        // so that removing one folder does not unregister the entry while another
        // still maps to it.
        const existing = this.entries.get(repoRoot);
        if (existing) {
            existing.folderPaths.add(folderPath);
            return;
        }

        const debounceMs = vscode.workspace.getConfiguration('gitfocal').get('refreshDebounceMs', 500);
        const refreshDebounced = debounce(() => {
            void this.refreshRepo(repoRoot);
        }, debounceMs);

        const entry = {
            state: emptyRepositoryState(repoRoot),
            refreshDebounced,
            folderPaths: new Set([folderPath])
        };
        this.entries.set(repoRoot, entry);

        try {
            const gitDir = await this.git.getGitDir(repoRoot);
            const pattern = new vscode.RelativePattern(gitDir, '{HEAD,refs/**,packed-refs,index,MERGE_HEAD,REBASE_HEAD,stash}');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            const onAny = () => entry.refreshDebounced();
            watcher.onDidChange(onAny);
            watcher.onDidCreate(onAny);
            watcher.onDidDelete(onAny);
            entry.watcher = watcher;
        } catch {
            // best-effort
        }

        this.startAutoFetch(entry, repoRoot);

        await this.refreshRepo(repoRoot);
    }

    removeFolder(folderPath) {
        for (const [root, entry] of this.entries) {
            if (!entry.folderPaths || entry.folderPaths.size === 0) {
                // Legacy entries with no tracked contributors fall back to the
                // historical "root under removed folder" heuristic.
                if (pathStartsWith(root, folderPath)) {
                    this.disposeEntry(entry);
                    this.entries.delete(root);
                }
                continue;
            }
            // Drop any contributing folder that was equal to or nested under the
            // removed workspace folder. Only unregister the repo when no
            // contributing folder remains.
            for (const fp of Array.from(entry.folderPaths)) {
                if (pathStartsWith(fp, folderPath)) {
                    entry.folderPaths.delete(fp);
                }
            }
            if (entry.folderPaths.size === 0) {
                this.disposeEntry(entry);
                this.entries.delete(root);
            }
        }
    }

    disposeEntry(entry) {
        entry.refreshDebounced.cancel();
        if (entry.watcher) {
            entry.watcher.dispose();
        }
        if (entry.autoFetchTimer) {
            clearInterval(entry.autoFetchTimer);
        }
    }

    rebuildAllWatchers() {
        const folders = Array.from(this.entries.keys());
        for (const root of folders) {
            const e = this.entries.get(root);
            if (e) {
                this.disposeEntry(e);
            }
            this.entries.delete(root);
        }
        for (const folder of vscode.workspace.workspaceFolders || []) {
            void this.addFolder(folder);
        }
    }

    rebuildAllAutoFetch() {
        for (const [root, entry] of this.entries) {
            if (entry.autoFetchTimer) {
                clearInterval(entry.autoFetchTimer);
                entry.autoFetchTimer = undefined;
            }
            this.startAutoFetch(entry, root);
        }
    }

    startAutoFetch(entry, repoRoot) {
        const minutes = vscode.workspace.getConfiguration('gitfocal').get('autoFetchIntervalMinutes', 5);
        if (!minutes || minutes <= 0) {
            return;
        }
        const intervalMs = minutes * 60 * 1000;
        entry.autoFetchTimer = setInterval(() => {
            // Skip background fetches while the window is unfocused to avoid
            // needless network traffic; the next focused tick catches up.
            if (!vscode.window.state.focused) {
                return;
            }
            void this.autoFetch(repoRoot);
        }, intervalMs);
    }

    async autoFetch(repoRoot) {
        try {
            await this.git.fetchRemote(repoRoot);
        } catch {
            // best-effort; refresh anyway in case of partial success
        }
        await this.refreshRepo(repoRoot);
    }

    subscribeToGitExtension() {
        try {
            const ext = vscode.extensions.getExtension('vscode.git');
            if (!ext) {
                return;
            }
            const activate = ext.isActive ? Promise.resolve(ext.exports) : ext.activate();
            void Promise.resolve(activate).then(exports => {
                if (!exports || typeof exports.getAPI !== 'function') {
                    return;
                }
                const api = exports.getAPI(1);
                if (!api) {
                    return;
                }
                // Track per-repository subscriptions so that closed repositories
                // release their listener instead of accumulating for the lifetime
                // of the extension host.
                const repoSubs = new Map();
                const keyOf = (repository) => {
                    const u = repository && repository.rootUri;
                    return u ? u.toString() : undefined;
                };
                const subscribe = (repository) => {
                    if (!repository || !repository.state || typeof repository.state.onDidChange !== 'function') {
                        return;
                    }
                    const key = keyOf(repository);
                    if (key && repoSubs.has(key)) {
                        return;
                    }
                    const repoFsPath = repository.rootUri && repository.rootUri.fsPath;
                    const sub = repository.state.onDidChange(() => {
                        const target = this.matchRepoPath(repoFsPath);
                        if (target) {
                            const entry = this.entries.get(target);
                            if (entry) {
                                entry.refreshDebounced();
                            }
                        }
                    });
                    if (key) {
                        repoSubs.set(key, sub);
                    }
                    this.disposables.push(sub);
                };
                const unsubscribe = (repository) => {
                    const key = keyOf(repository);
                    if (!key) {
                        return;
                    }
                    const sub = repoSubs.get(key);
                    if (sub) {
                        sub.dispose();
                        repoSubs.delete(key);
                    }
                };
                for (const r of api.repositories || []) {
                    subscribe(r);
                }
                if (typeof api.onDidOpenRepository === 'function') {
                    this.disposables.push(api.onDidOpenRepository(subscribe));
                }
                if (typeof api.onDidCloseRepository === 'function') {
                    this.disposables.push(api.onDidCloseRepository(unsubscribe));
                }
                // Ensure all per-repo subscriptions are released on dispose even
                // if the close event never fires.
                this.disposables.push({
                    dispose: () => {
                        for (const sub of repoSubs.values()) {
                            try { sub.dispose(); } catch { /* ignore */ }
                        }
                        repoSubs.clear();
                    }
                });
            }).catch(() => { /* best-effort */ });
        } catch {
            // git extension not available
        }
    }

    matchRepoPath(fsPath) {
        if (!fsPath) {
            return undefined;
        }
        const target = normalizeFsPath(fsPath);
        for (const root of this.entries.keys()) {
            if (pathsEqual(root, target) || pathStartsWith(target, root) || pathStartsWith(root, target)) {
                return root;
            }
        }
        return undefined;
    }

    async refreshRepo(repoPath) {
        const entry = this.entries.get(repoPath);
        if (!entry) {
            return;
        }
        try {
            const [branches, stashes, workTrees, tags, currentBranch] = await Promise.all([
                this.git.getBranches(repoPath),
                this.git.getStashes(repoPath),
                this.git.getWorkTrees(repoPath),
                this.git.getTags(repoPath).catch(() => []),
                this.git.getCurrentBranch(repoPath).catch(() => '')
            ]);
            // `rev-parse --abbrev-ref HEAD` prints the literal "HEAD" when detached.
            const detachedCommit = currentBranch === 'HEAD'
                ? await this.git.getHeadCommit(repoPath).catch(() => undefined)
                : undefined;
            entry.state = createRepositoryState({
                repoPath,
                branches,
                stashes,
                workTrees,
                tags,
                currentBranch,
                detachedCommit,
                version: entry.state.version + 1
            });
            this._onDidChange.fire(entry.state);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            entry.state = createRepositoryState({
                repoPath,
                branches: entry.state.branches,
                stashes: entry.state.stashes,
                workTrees: entry.state.workTrees,
                tags: entry.state.tags,
                currentBranch: entry.state.currentBranch,
                detachedCommit: entry.state.detachedCommit,
                version: entry.state.version + 1,
                error: message
            });
            this._onDidChange.fire(entry.state);
        }
    }
}

module.exports = { StateManager };
