'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons } = require('../ui/icons');
const preferences = require('../models/preferences');
const { filterSubmoduleStates } = require('../utils/repoFilters');

class StashesTreeProvider {
    constructor(stateManager, git) {
        this.stateManager = stateManager;
        this.git = git;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.disposables = [];

        this.disposables.push(
            this.stateManager.onDidChange(() => this._onDidChangeTreeData.fire()),
            preferences.onDidChange(e => {
                if (e.key === preferences.KEY_STASHES_HIDE_SUBMODULES) {
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
        if (element.kind === 'repo') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = Icons.repo;
            item.contextValue = 'repo';
            item.tooltip = element.repoPath;
            return item;
        }
        if (element.kind === 'stashFile') {
            const item = new vscode.TreeItem(path.basename(element.file.path), vscode.TreeItemCollapsibleState.None);
            item.description = element.file.path;
            item.tooltip = `${statusLabel(element.file.status)}: ${element.file.path}`;
            item.iconPath = iconForStatus(element.file.status);
            item.contextValue = 'stashFile';
            item.resourceUri = vscode.Uri.file(path.join(element.repoPath, element.file.path));
            return item;
        }
        if (element.kind === 'stashFileMore') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('ellipsis');
            return item;
        }
        const stash = element.stash;
        const label = stash.subject || stash.description || stash.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = Icons.stash;
        item.description = stash.branch ? `on ${stash.branch}` : '';
        item.tooltip = buildStashTooltip(stash);
        item.contextValue = 'stash';
        return item;
    }

    getChildren(element) {
        const states = this.getVisibleStates();
        if (!element) {
            if (states.length === 0) {
                return [];
            }
            if (states.length === 1) {
                return this.buildStashes(states[0]);
            }
            return states.map(s => ({
                kind: 'repo',
                label: path.basename(s.repoPath),
                repoPath: s.repoPath
            }));
        }
        if (element.kind === 'repo') {
            const state = this.stateManager.getState(element.repoPath);
            if (!state) {
                return [];
            }
            return this.buildStashes(state);
        }
        if (element.kind === 'stash') {
            return this.buildStashFiles(element);
        }
        return [];
    }

    getVisibleStates() {
        const states = this.stateManager.getStates();
        return preferences.getStashesHideSubmodules() ? filterSubmoduleStates(states) : states;
    }

    buildStashes(state) {
        return state.stashes
            .slice()
            .sort((a, b) => a.index - b.index)
            .map(s => ({
                kind: 'stash',
                label: s.id,
                repoPath: state.repoPath,
                stash: s
            }));
    }

    async buildStashFiles(element) {
        if (!this.git) {
            return [];
        }
        try {
            const files = await this.git.getStashFiles(element.repoPath, element.stash.id);
            if (files.length === 0) {
                return [{ kind: 'stashFileMore', label: '(no files)', repoPath: element.repoPath }];
            }
            return files.map(f => ({
                kind: 'stashFile',
                label: f.path,
                repoPath: element.repoPath,
                stash: element.stash,
                file: f
            }));
        } catch {
            return [{ kind: 'stashFileMore', label: 'Failed to load files', repoPath: element.repoPath }];
        }
    }
}

function statusLabel(status) {
    switch ((status || '').charAt(0)) {
        case 'A': return 'Added';
        case 'M': return 'Modified';
        case 'D': return 'Deleted';
        case 'R': return 'Renamed';
        case 'C': return 'Copied';
        case 'U': return 'Unmerged';
        case 'T': return 'Type changed';
        default: return status || 'Changed';
    }
}

function iconForStatus(status) {
    switch ((status || '').charAt(0)) {
        case 'A': return new vscode.ThemeIcon('diff-added');
        case 'D': return new vscode.ThemeIcon('diff-removed');
        case 'R': return new vscode.ThemeIcon('diff-renamed');
        case 'M':
        default: return new vscode.ThemeIcon('diff-modified');
    }
}

function buildStashTooltip(stash) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${stash.id}**\n\n`);
    if (stash.branch) {
        md.appendMarkdown(`- branch: \`${stash.branch}\`\n`);
    }
    if (stash.subject) {
        md.appendMarkdown(`- subject: ${stash.subject}\n`);
    }
    md.appendMarkdown(`- description: ${stash.description}\n`);
    return md;
}

module.exports = { StashesTreeProvider };
