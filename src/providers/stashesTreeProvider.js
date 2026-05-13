'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons } = require('../ui/icons');

class StashesTreeProvider {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.disposables = [];

        this.disposables.push(
            this.stateManager.onDidChange(() => this._onDidChangeTreeData.fire())
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
        const stash = element.stash;
        const label = stash.subject || stash.description || stash.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = Icons.stash;
        item.description = stash.branch || '';
        item.tooltip = buildStashTooltip(stash);
        item.contextValue = 'stash';
        return item;
    }

    getChildren(element) {
        const states = this.stateManager.getStates();
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
        return [];
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
