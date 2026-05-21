'use strict';

const vscode = require('vscode');

const SCHEME = 'gitfocal-tag';

function tagUri(repoPath, name) {
    return vscode.Uri.from({
        scheme: SCHEME,
        path: '/' + encodeURIComponent(repoPath) + '/' + encodeURIComponent(name)
    });
}

function colorForTag(tag) {
    if (tag.isRemoteOnly) {
        return undefined;
    }
    switch (tag.originStatus) {
        case 'missing':
            return new vscode.ThemeColor('gitDecoration.untrackedResourceForeground');
        case 'different':
            return new vscode.ThemeColor('charts.orange');
        default:
            return undefined;
    }
}

class TagDecorationProvider {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this._sub = stateManager.onDidChange(() => this.fireForCurrentTags());
    }

    fireForCurrentTags() {
        const uris = [];
        for (const state of this.stateManager.getStates()) {
            for (const tag of state.tags || []) {
                uris.push(tagUri(state.repoPath, tag.name));
            }
        }
        this._onDidChange.fire(uris);
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== SCHEME) {
            return undefined;
        }
        let repoPath;
        let tagName;
        try {
            const raw = uri.path.replace(/^\//, '');
            const slash = raw.indexOf('/');
            if (slash < 0) {
                return undefined;
            }
            repoPath = decodeURIComponent(raw.substring(0, slash));
            tagName = decodeURIComponent(raw.substring(slash + 1));
        } catch {
            return undefined;
        }
        if (!repoPath || !tagName) {
            return undefined;
        }
        const state = this.stateManager.getState(repoPath);
        if (!state) {
            return undefined;
        }
        const tag = (state.tags || []).find(t => t.name === tagName);
        if (!tag) {
            return undefined;
        }
        const color = colorForTag(tag);
        if (!color) {
            return undefined;
        }
        return { color, propagate: false };
    }

    dispose() {
        this._sub.dispose();
        this._onDidChange.dispose();
    }
}

module.exports = { TagDecorationProvider, tagUri, colorForTag, SCHEME };
