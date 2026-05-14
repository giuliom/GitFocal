'use strict';

const vscode = require('vscode');
const { colorForBranch } = require('./decorations');

const SCHEME = 'gitfocal-branch';

function branchUri(repoPath, name) {
    // NOTE: encode into the URI path (not authority) because VS Code lowercases
    // the authority component, which would corrupt repo paths containing
    // uppercase characters and break the lookup in `provideFileDecoration`.
    return vscode.Uri.from({
        scheme: SCHEME,
        path: '/' + encodeURIComponent(repoPath) + '/' + encodeURIComponent(name)
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
            const raw = uri.path.replace(/^\//, '');
            const slash = raw.indexOf('/');
            if (slash < 0) {
                return undefined;
            }
            repoPath = decodeURIComponent(raw.substring(0, slash));
            branchName = decodeURIComponent(raw.substring(slash + 1));
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
