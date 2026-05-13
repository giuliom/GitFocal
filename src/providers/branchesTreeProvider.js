'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons, iconNameForBranch } = require('../ui/icons');
const { formatBranchDescription, colorForBranch } = require('../ui/decorations');
const { branchUri } = require('../ui/branchDecorationProvider');
const preferences = require('../models/preferences');

class BranchesTreeProvider {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.disposables = [];

        this.disposables.push(
            this.stateManager.onDidChange(() => this._onDidChangeTreeData.fire()),
            preferences.onDidChange(() => this._onDidChangeTreeData.fire())
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
                // Remote group can be large; keep it collapsed by default.
                const collapsibleState = element.groupKey === 'remote'
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.Expanded;
                const item = new vscode.TreeItem(element.label, collapsibleState);
                item.iconPath = element.groupKey === 'local'
                    ? Icons.localGroup
                    : element.groupKey === 'worktrees'
                        ? Icons.workTreeGroup
                        : Icons.remoteGroup;
                item.contextValue = `group.${element.groupKey}`;
                return item;
            }
            case 'remoteGroup': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = Icons.remoteGroup;
                item.contextValue = 'remoteGroup';
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
            case 'branch': {
                const branch = element.branch;
                const item = new vscode.TreeItem(branch.name, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(iconNameForBranch(branch), colorForBranch(branch));
                item.description = formatBranchDescription(branch);
                item.tooltip = buildBranchTooltip(branch);
                item.resourceUri = branchUri(element.repoPath, branch.name);
                const trackingSuffix = branch.isRemote ? '' : (branch.isTracking ? '.tracking' : '.untracked');
                if (branch.isRemote) {
                    item.contextValue = 'branch.remote';
                } else if (branch.isCurrent) {
                    item.contextValue = 'branch.current' + trackingSuffix;
                } else {
                    item.contextValue = 'branch.local' + trackingSuffix;
                }
                item.command = {
                    command: 'gitfocal.checkoutBranch',
                    title: 'Checkout',
                    arguments: [element]
                };
                return item;
            }
            default:
                return new vscode.TreeItem(element.label);
        }
    }

    getChildren(element) {
        const states = this.stateManager.getStates();
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
                if (element.groupKey === 'local') {
                    return this.buildLocalBranches(state);
                }
                if (element.groupKey === 'remote') {
                    return this.buildRemoteGroups(state);
                }
                if (element.groupKey === 'worktrees') {
                    return this.buildWorkTrees(state);
                }
                return [];
            }
            case 'remoteGroup': {
                const state = this.stateManager.getState(element.repoPath);
                if (!state) {
                    return [];
                }
                return state.branches
                    .filter(b => b.isRemote && b.remoteName === element.remoteName)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(b => ({ kind: 'branch', label: b.name, repoPath: state.repoPath, branch: b }));
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
            default:
                return [];
        }
    }

    // --- helpers ---

    buildRepoChildren(state) {
        const children = this.buildLocalBranches(state);
        if (state.workTrees.length > 1) {
            children.push({ kind: 'group', label: 'Worktrees', repoPath: state.repoPath, groupKey: 'worktrees' });
        }
        return children;
    }

    buildLocalBranches(state) {
        const hideSubmodules = preferences.getHideSubmodules();

        let local = state.branches.filter(b => !b.isRemote);
        if (hideSubmodules) {
            local = local.filter(b => !b.workTreePath || b.workTreePath.startsWith(state.repoPath));
        }
        return local
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(b => ({ kind: 'branch', label: b.name, repoPath: state.repoPath, branch: b }));
    }

    buildRemoteGroups(state) {
        const remotes = new Set();
        for (const b of state.branches) {
            if (b.isRemote && b.remoteName) {
                remotes.add(b.remoteName);
            }
        }
        return Array.from(remotes).sort().map(name => ({
            kind: 'remoteGroup',
            label: name,
            repoPath: state.repoPath,
            remoteName: name
        }));
    }

    buildWorkTrees(state) {
        return state.workTrees.map(wt => ({
            kind: 'workTree',
            label: path.basename(wt.path) || wt.path,
            repoPath: state.repoPath,
            workTree: wt
        }));
    }
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
        md.appendMarkdown(`- ahead/behind: ${branch.aheadBehind.ahead}/${branch.aheadBehind.behind}\n`);
    }
    if (branch.workTreePath) {
        md.appendMarkdown(`- worktree: \`${branch.workTreePath}\`\n`);
    }
    return md;
}

module.exports = { BranchesTreeProvider };
