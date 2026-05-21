'use strict';

const path = require('path');
const vscode = require('vscode');
const { Icons } = require('../ui/icons');
const { tagUri } = require('../ui/tagDecorationProvider');
const tagsFilter = require('../models/tagsFilter');

class TagsTreeProvider {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.disposables = [];

        this.disposables.push(
            this.stateManager.onDidChange(() => this._onDidChangeTreeData.fire())
        );
        this.disposables.push(
            tagsFilter.onDidChange(() => this._onDidChangeTreeData.fire())
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
        if (element.kind === 'empty') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            return item;
        }
        const tag = element.tag;
        const item = new vscode.TreeItem(tag.name, vscode.TreeItemCollapsibleState.None);
        if (tag.isRemoteOnly) {
            item.iconPath = new vscode.ThemeIcon('cloud');
        } else {
            item.iconPath = tag.isAnnotated ? Icons.tagAnnotated : Icons.tag;
        }
        item.resourceUri = tagUri(element.repoPath, tag.name);
        const parts = [];
        if (tag.commitHash) {
            parts.push(tag.commitHash);
        }
        const originStatus = formatOriginStatus(tag);
        if (originStatus) {
            parts.push(originStatus);
        }
        if (tag.taggerDate) {
            parts.push(tag.taggerDate);
        }
        item.description = parts.join(' \u2022 ');
        item.tooltip = buildTagTooltip(tag);
        item.contextValue = tag.isRemoteOnly
            ? 'tag.remoteOnly'
            : (tag.canPushTag ? 'tag.pushable' : 'tag.synced');
        return item;
    }

    getChildren(element) {
        const states = this.stateManager.getStates();
        if (!element) {
            if (states.length === 0) {
                return [];
            }
            if (states.length === 1) {
                return this.buildTags(states[0]);
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
            return this.buildTags(state);
        }
        return [];
    }

    buildTags(state) {
        const all = state.tags || [];
        const filter = tagsFilter.get().toLowerCase();
        const tags = filter
            ? all.filter(t => t.name.toLowerCase().includes(filter))
            : all;
        if (tags.length === 0) {
            return [{ kind: 'empty', label: filter ? 'No tags match filter' : 'No tags' }];
        }
        return tags.map(t => ({
            kind: 'tag',
            label: t.name,
            repoPath: state.repoPath,
            tag: t
        }));
    }
}

function buildTagTooltip(tag) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${tag.name}**${tag.isAnnotated ? ' _(annotated)_' : ''}\n\n`);
    if (tag.commitHashFull) {
        md.appendMarkdown(`- commit: \`${tag.commitHashFull}\`\n`);
    }
    const originStatus = formatOriginStatus(tag);
    if (originStatus) {
        md.appendMarkdown(`- origin: ${originStatus}\n`);
    }
    if (tag.originStatus === 'different' && tag.originCommitHashFull) {
        md.appendMarkdown(`- origin commit: \`${tag.originCommitHashFull}\`\n`);
    }
    if (tag.subject) {
        md.appendMarkdown(`- subject: ${tag.subject}\n`);
    }
    if (tag.tagger) {
        md.appendMarkdown(`- tagger: ${tag.tagger}\n`);
    }
    if (tag.taggerDate) {
        md.appendMarkdown(`- date: ${tag.taggerDate}\n`);
    }
    return md;
}

function formatOriginStatus(tag) {
    switch (tag.originStatus) {
        case 'same':
            return 'same commit on origin';
        case 'different':
            return tag.originCommitHash
                ? `different commit on origin (${tag.originCommitHash})`
                : 'different commit on origin';
        case 'missing':
            return 'not on origin';
        case 'remote-only':
            return 'only on origin';
        case 'no-origin':
            return 'no origin remote';
        case 'no-remote':
            return 'no remotes';
        case 'unavailable':
            return 'origin unavailable';
        default:
            return '';
    }
}

module.exports = { TagsTreeProvider };
