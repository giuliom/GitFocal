'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons, iconNameForBranch } = require('../ui/icons');
const { formatBranchDescription, colorForBranch } = require('../ui/decorations');
const { branchUri } = require('../ui/branchDecorationProvider');
const preferences = require('../models/preferences');
const branchesFilter = require('../models/branchesFilter');
const { filterSubmoduleStates, isSameOrDescendantPath } = require('../utils/repoFilters');

const INITIAL_COMMITS_PER_BRANCH = 5;
const COMMITS_PAGE_SIZE = 5;

class BranchesTreeProvider {
    constructor(stateManager, git) {
        this.stateManager = stateManager;
        this.git = git;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.loadedCommitCounts = new Map();
        this.disposables = [];

        this.disposables.push(
            this.stateManager.onDidChange(() => {
                this.pruneLoadedCommitCounts();
                this._onDidChangeTreeData.fire();
            }),
            preferences.onDidChange(e => {
                if (e.key === preferences.KEY_BRANCHES_HIDE_SUBMODULES) {
                    this._onDidChangeTreeData.fire();
                }
            }),
            branchesFilter.onDidChange(() => this._onDidChangeTreeData.fire()),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gitfocal.checkoutOnClick') || e.affectsConfiguration('gitfocal.branches.sortBy')) {
                    this._onDidChangeTreeData.fire();
                }
            })
        );
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
            case 'group': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = Icons.workTreeGroup;
                item.contextValue = `group.${element.groupKey}`;
                return item;
            }
            case 'workTree': {
                const wt = element.workTree;
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = Icons.workTree;
                item.contextValue = 'workTree';
                item.description = wt && wt.isMain ? '(main)' : undefined;
                item.tooltip = wt ? wt.path : undefined;
                return item;
            }
            case 'detachedHead': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
                item.contextValue = 'detachedHead';
                item.tooltip = 'HEAD is not on any branch. Checkout a branch to resume normal work.';
                return item;
            }
            case 'branch': {
                const branch = element.branch;
                const item = new vscode.TreeItem(element.label || branch.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon(iconNameForBranch(branch), colorForBranch(branch));
                item.description = formatBranchDescription(branch);
                item.tooltip = buildBranchTooltip(branch);
                item.resourceUri = branchUri(element.repoPath, branch.name);
                const trackingSuffix = branch.isRemote ? '' : (branch.isTracking && !branch.upstreamGone ? '.tracking' : '.untracked');
                if (branch.isRemote) {
                    item.contextValue = 'branch.remote';
                } else if (branch.isCurrent) {
                    item.contextValue = 'branch.current' + trackingSuffix;
                } else {
                    item.contextValue = 'branch.local' + trackingSuffix;
                }
                if (vscode.workspace.getConfiguration('gitfocal').get('checkoutOnClick', true)) {
                    item.command = {
                        command: 'gitfocal.checkoutBranch',
                        title: 'Checkout',
                        arguments: [element]
                    };
                }
                return item;
            }
            case 'commit': {
                const c = element.commit;
                const tags = element.tags || [];
                const item = new vscode.TreeItem(c.subject || c.shortHash, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('git-commit');
                const tagPrefix = tags.length > 0
                    ? tags.map(t => `\u{1F3F7} ${t.name}`).join(' ') + ' \u2022 '
                    : '';
                item.description = `${tagPrefix}${c.shortHash} \u2022 ${c.relativeDate}`;
                item.tooltip = buildCommitTooltip(c, tags);
                item.contextValue = tags.length > 0 ? 'commit.tagged' : 'commit';
                return item;
            }
            case 'commitMore': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('ellipsis');
                item.contextValue = 'commitMore';
                if (element.branchElement) {
                    item.command = {
                        command: 'gitfocal.loadMoreCommits',
                        title: 'Load More Commits',
                        arguments: [element]
                    };
                }
                return item;
            }
            default:
                return new vscode.TreeItem(element.label);
        }
    }

    getChildren(element) {
        const states = this.getVisibleStates();
        if (!element) {
            if (states.length === 0) {
                return [];
            }
            if (states.length === 1) {
                return this.buildRepoChildren(states[0]);
            }
            return states.map(s => ({
                kind: 'repo',
                label: path.basename(s.repoPath),
                repoPath: s.repoPath
            }));
        }

        switch (element.kind) {
            case 'repo': {
                const state = this.stateManager.getState(element.repoPath);
                if (!state) {
                    return [];
                }
                return this.buildRepoChildren(state);
            }
            case 'group': {
                const state = this.stateManager.getState(element.repoPath);
                if (!state) {
                    return [];
                }
                if (element.groupKey === 'worktrees') {
                    return this.buildWorkTrees(state);
                }
                return [];
            }
            case 'workTree': {
                const state = this.stateManager.getState(element.repoPath);
                if (!state) {
                    return [];
                }
                const wtPath = element.workTree.path;
                return state.branches
                    .filter(b => b.workTreePath === wtPath)
                    .map(b => ({ kind: 'branch', label: b.name, repoPath: state.repoPath, branch: b }));
            }
            case 'branch': {
                return this.buildBranchCommits(element);
            }
            default:
                return [];
        }
    }

    // --- helpers ---

    getVisibleStates() {
        const states = this.stateManager.getStates();
        return preferences.getBranchesHideSubmodules() ? filterSubmoduleStates(states) : states;
    }

    buildRepoChildren(state) {
        const children = this.buildLocalBranches(state);
        if (state.detachedCommit) {
            children.unshift({
                kind: 'detachedHead',
                label: `Detached HEAD at ${state.detachedCommit}`,
                repoPath: state.repoPath
            });
        }
        if (state.workTrees.length > 1) {
            children.push({ kind: 'group', label: 'Worktrees', repoPath: state.repoPath, groupKey: 'worktrees' });
        }
        return children;
    }

    buildLocalBranches(state) {
        const hideSubmodules = preferences.getBranchesHideSubmodules();
        const filter = branchesFilter.get().toLowerCase();
        const sortBy = vscode.workspace.getConfiguration('gitfocal').get('branches.sortBy', 'name');

        let local = state.branches.filter(b => !b.isRemote);
        if (hideSubmodules) {
            local = local.filter(b => !b.workTreePath || isSameOrDescendantPath(state.repoPath, b.workTreePath));
        }
        if (filter) {
            local = local.filter(b => b.name.toLowerCase().includes(filter));
        }
        const sorted = local.slice().sort(sortBy === 'commitDate'
            ? (a, b) => (b.committerDate || 0) - (a.committerDate || 0) || a.name.localeCompare(b.name)
            : (a, b) => a.name.localeCompare(b.name));
        return sorted.map(b => ({ kind: 'branch', label: b.name, repoPath: state.repoPath, branch: b }));
    }

    buildWorkTrees(state) {
        return state.workTrees.map(wt => ({
            kind: 'workTree',
            label: path.basename(wt.path) || wt.path,
            repoPath: state.repoPath,
            workTree: wt
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
        const state = this.stateManager.getState(element.repoPath);
        const tagsByCommit = buildTagsByCommit(state);
        try {
            // Request one extra to detect whether more commits are available.
            const commits = await this.git.getBranchCommits(element.repoPath, ref, desired + 1);
            const hasMore = commits.length > desired;
            const visible = hasMore ? commits.slice(0, desired) : commits;
            const items = visible.map(c => ({
                kind: 'commit',
                label: c.subject || c.shortHash,
                repoPath: element.repoPath,
                branch,
                commit: c,
                tags: tagsByCommit.get(c.hash) || []
            }));
            if (hasMore) {
                items.push({
                    kind: 'commitMore',
                    label: `Load more`,
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

function buildCommitTooltip(commit, tags) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${commit.subject || commit.shortHash}**\n\n`);
    md.appendMarkdown(`- hash: \`${commit.hash}\`\n`);
    if (commit.author) {
        md.appendMarkdown(`- author: ${commit.author}\n`);
    }
    if (commit.relativeDate) {
        md.appendMarkdown(`- date: ${commit.relativeDate}\n`);
    }
    if (tags && tags.length > 0) {
        md.appendMarkdown(`- tags: ${tags.map(t => `\`${t.name}\``).join(', ')}\n`);
    }
    return md;
}

function buildTagsByCommit(state) {
    const map = new Map();
    if (!state || !Array.isArray(state.tags)) {
        return map;
    }
    for (const tag of state.tags) {
        const key = tag.commitHashFull || tag.commitHash;
        if (!key) {
            continue;
        }
        const list = map.get(key);
        if (list) {
            list.push(tag);
        } else {
            map.set(key, [tag]);
        }
    }
    return map;
}

function buildBranchTooltip(branch) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${branch.name}**\n\n`);
    md.appendMarkdown(`- ref: \`${branch.refName}\`\n`);
    md.appendMarkdown(`- commit: \`${branch.commitHash}\`\n`);
    if (branch.commitSubject) {
        md.appendMarkdown(`- subject: ${branch.commitSubject}\n`);
    }
    if (branch.upstream) {
        md.appendMarkdown(`- upstream: \`${branch.upstream}\`\n`);
        if (branch.upstreamGone) {
            md.appendMarkdown(`- upstream: deleted on remote\n`);
        } else {
            md.appendMarkdown(`- ahead/behind: ${branch.aheadBehind.ahead}/${branch.aheadBehind.behind}\n`);
        }
    }
    if (branch.workTreePath) {
        md.appendMarkdown(`- worktree: \`${branch.workTreePath}\`\n`);
    }
    return md;
}

module.exports = { BranchesTreeProvider };
