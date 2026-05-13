'use strict';

const vscode = require('vscode');
const { colorForBranch } = require('./decorations');

const SCHEME = 'gitfocal-branch';

function branchUri(repoPath, name) {
    return vscode.Uri.from({
        scheme: SCHEME,
        authority: encodeURIComponent(repoPath),
        path: '/' + encodeURIComponent(name)
    });
}

class BranchDecorationProvider {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this._sub = stateManager.onDidChange(() => this._onDidChange.fire(undefined));
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== SCHEME) {
            return undefined;
        }
        let repoPath;
        let branchName;
        try {
            repoPath = decodeURIComponent(uri.authority);
            branchName = decodeURIComponent(uri.path.replace(/^\//, ''));
        } catch {
            return undefined;
        }
        if (!repoPath || !branchName) {
            return undefined;
        }
        const state = this.stateManager.getState(repoPath);
        if (!state) {
            return undefined;
        }
        const branch = state.branches.find(b => !b.isRemote && b.name === branchName);
        if (!branch) {
            return undefined;
        }
        const color = colorForBranch(branch);
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

module.exports = { BranchDecorationProvider, branchUri, SCHEME };
