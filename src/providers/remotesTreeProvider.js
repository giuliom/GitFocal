'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons } = require('../ui/icons');
const remotesFilter = require('../models/remotesFilter');
const preferences = require('../models/preferences');
const { filterSubmoduleStates, isSameOrDescendantPath } = require('../utils/repoFilters');

const INITIAL_COMMITS_PER_BRANCH = 5;
const COMMITS_PAGE_SIZE = 5;

class RemotesTreeProvider {
    constructor(stateManager, git) {
        this.stateManager = stateManager;
        this.git = git;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.loadedCommitCounts = new Map();
        this.disposables = [
            this.stateManager.onDidChange(() => {
                this.pruneLoadedCommitCounts();
                this._onDidChangeTreeData.fire();
            }),
            remotesFilter.onDidChange(() => this._onDidChangeTreeData.fire()),
            preferences.onDidChange(e => {
                if (e.key === preferences.KEY_REMOTES_HIDE_SUBMODULES) {
                    this._onDidChangeTreeData.fire();
                }
            })
        ];
    }

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this._onDidChangeTreeData.dispose();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        switch (element.kind) {
            case 'repo': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = Icons.repo;
                item.contextValue = 'repo';
                item.tooltip = element.repoPath;
                return item;
            }
            case 'remote': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = Icons.remoteGroup;
                item.contextValue = 'remote';
                item.description = `${element.branchCount} branch${element.branchCount === 1 ? '' : 'es'}`;
                return item;
            }
            case 'branch': {
                const b = element.branch;
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = Icons.branch;
                item.description = b.commitSubject || b.commitHash;
                item.tooltip = buildRemoteBranchTooltip(b);
                item.contextValue = 'remoteBranch';
                return item;
            }
            case 'commit': {
                const c = element.commit;
                const item = new vscode.TreeItem(c.subject || c.shortHash, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('git-commit');
                item.description = `${c.shortHash} \u2022 ${c.relativeDate}`;
                item.tooltip = buildCommitTooltip(c);
                item.contextValue = 'commit';
                return item;
            }
            case 'commitMore': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('ellipsis');
                item.contextValue = 'commitMore';
                if (element.branchElement) {
                    item.command = {
                        command: 'gitfocal.remotes.loadMoreCommits',
                        title: 'Load More Commits',
                        arguments: [element]
                    };
                }
                return item;
            }
            case 'empty': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
            default:
                return new vscode.TreeItem(element.label || '');
        }
    }

    getChildren(element) {
        const states = this.getVisibleStates();
        if (!element) {
            if (states.length === 0) {
                return [];
            }
            if (states.length === 1) {
                return this.buildRemotes(states[0]);
            }
            return states.map(s => ({
                kind: 'repo',
                label: path.basename(s.repoPath),
                repoPath: s.repoPath
            }));
        }
        if (element.kind === 'repo') {
            const state = this.stateManager.getState(element.repoPath);
            return state ? this.buildRemotes(state) : [];
        }
        if (element.kind === 'remote') {
            const state = this.stateManager.getState(element.repoPath);
            return state ? this.buildBranches(state, element.remoteName) : [];
        }
        if (element.kind === 'branch') {
            return this.buildBranchCommits(element);
        }
        return [];
    }

    getVisibleStates() {
        const states = this.stateManager.getStates();
        return preferences.getRemotesHideSubmodules() ? filterSubmoduleStates(states) : states;
    }

    buildRemotes(state) {
        const hideSubmodules = preferences.getRemotesHideSubmodules();
        const grouped = new Map();
        for (const b of state.branches) {
            if (!b.isRemote || !b.remoteName) {
                continue;
            }
            if (hideSubmodules && b.workTreePath && !isSameOrDescendantPath(state.repoPath, b.workTreePath)) {
                continue;
            }
            let list = grouped.get(b.remoteName);
            if (!list) {
                list = [];
                grouped.set(b.remoteName, list);
            }
            list.push(b);
        }
        if (grouped.size === 0) {
            return [{ kind: 'empty', label: 'No remotes' }];
        }
        const filter = remotesFilter.get();
        return Array.from(grouped.keys()).sort().map(name => {
            const branches = grouped.get(name);
            const visible = filter
                ? branches.filter(b => matchesFilter(b, name, filter))
                : branches;
            return {
                kind: 'remote',
                label: name,
                repoPath: state.repoPath,
                remoteName: name,
                branchCount: visible.length
            };
        });
    }

    buildBranches(state, remoteName) {
        const hideSubmodules = preferences.getRemotesHideSubmodules();
        const filter = remotesFilter.get();
        const list = state.branches
            .filter(b => b.isRemote && b.remoteName === remoteName)
            .filter(b => !hideSubmodules || !b.workTreePath || isSameOrDescendantPath(state.repoPath, b.workTreePath))
            .filter(b => !filter || matchesFilter(b, remoteName, filter))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (list.length === 0) {
            return [{ kind: 'empty', label: filter ? 'No matches' : 'No branches' }];
        }
        return list.map(b => ({
            kind: 'branch',
            label: b.name.substring(remoteName.length + 1),
            repoPath: state.repoPath,
            branch: b
        }));
    }

    async buildBranchCommits(element) {
        if (!this.git) {
            return [];
        }
        const branch = element.branch;
        const ref = branch && (branch.refName || branch.name);
        if (!ref) {
            return [];
        }
        const key = branchCommitsKey(element.repoPath, ref);
        const desired = this.loadedCommitCounts.get(key) || INITIAL_COMMITS_PER_BRANCH;
        try {
            const commits = await this.git.getBranchCommits(element.repoPath, ref, desired + 1);
            const hasMore = commits.length > desired;
            const visible = hasMore ? commits.slice(0, desired) : commits;
            const items = visible.map(c => ({
                kind: 'commit',
                label: c.subject || c.shortHash,
                repoPath: element.repoPath,
                branch,
                commit: c
            }));
            if (hasMore) {
                items.push({
                    kind: 'commitMore',
                    label: 'Load more',
                    repoPath: element.repoPath,
                    branchElement: element,
                    branchKey: key
                });
            }
            return items;
        } catch {
            return [{
                kind: 'commitMore',
                label: 'Failed to load commits',
                repoPath: element.repoPath
            }];
        }
    }

    loadMoreCommits(element) {
        if (!element || !element.branchKey || !element.branchElement) {
            return;
        }
        const current = this.loadedCommitCounts.get(element.branchKey) || INITIAL_COMMITS_PER_BRANCH;
        this.loadedCommitCounts.set(element.branchKey, current + COMMITS_PAGE_SIZE);
        this._onDidChangeTreeData.fire(element.branchElement);
    }

    pruneLoadedCommitCounts() {
        if (this.loadedCommitCounts.size === 0) {
            return;
        }
        const live = new Set();
        for (const state of this.stateManager.getStates()) {
            for (const b of state.branches) {
                if (!b.isRemote) {
                    continue;
                }
                const ref = b.refName || b.name;
                if (ref) {
                    live.add(branchCommitsKey(state.repoPath, ref));
                }
            }
        }
        for (const key of Array.from(this.loadedCommitCounts.keys())) {
            if (!live.has(key)) {
                this.loadedCommitCounts.delete(key);
            }
        }
    }
}

function branchCommitsKey(repoPath, refName) {
    return `${repoPath}\x1f${refName}`;
}

function matchesFilter(branch, remoteName, filter) {
    const needle = filter.toLowerCase();
    const short = branch.name.substring(remoteName.length + 1).toLowerCase();
    return short.includes(needle) || branch.name.toLowerCase().includes(needle);
}

function buildRemoteBranchTooltip(b) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${b.name}**\n\n`);
    md.appendMarkdown(`- ref: \`${b.refName}\`\n`);
    md.appendMarkdown(`- commit: \`${b.commitHash}\`\n`);
    if (b.commitSubject) {
        md.appendMarkdown(`- subject: ${b.commitSubject}\n`);
    }
    return md;
}

function buildCommitTooltip(commit) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${commit.subject || commit.shortHash}**\n\n`);
    md.appendMarkdown(`- hash: \`${commit.hash}\`\n`);
    if (commit.author) {
        md.appendMarkdown(`- author: ${commit.author}\n`);
    }
    if (commit.relativeDate) {
        md.appendMarkdown(`- date: ${commit.relativeDate}\n`);
    }
    return md;
}

module.exports = { RemotesTreeProvider };
