'use strict';

/**
 * Minimal in-memory stub of the `vscode` API surface used by GitFocal.
 * Loaded in place of the real module by `bootstrap.cjs` so that src modules
 * can be unit-tested outside the extension host.
 */

class EventEmitter {
    constructor() {
        this._listeners = new Set();
    }
    get event() {
        return (listener, thisArgs) => {
            const bound = thisArgs ? listener.bind(thisArgs) : listener;
            this._listeners.add(bound);
            return { dispose: () => this._listeners.delete(bound) };
        };
    }
    fire(e) {
        for (const l of Array.from(this._listeners)) {
            l(e);
        }
    }
    dispose() {
        this._listeners.clear();
    }
}

class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class ThemeIcon {
    constructor(id, color) {
        this.id = id;
        this.color = color;
    }
}

class ThemeColor {
    constructor(id) {
        this.id = id;
    }
}

class MarkdownString {
    constructor(value) {
        this.value = value || '';
    }
    appendMarkdown(text) {
        this.value += text;
        return this;
    }
}

class RelativePattern {
    constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
    }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

const Uri = {
    from(components) {
        return {
            scheme: components.scheme || '',
            path: components.path || '',
            fsPath: components.path || '',
            toString() {
                return `${this.scheme}:${this.path}`;
            }
        };
    },
    file(fsPath) {
        return {
            scheme: 'file',
            path: fsPath,
            fsPath,
            toString() {
                return `file://${fsPath}`;
            }
        };
    }
};

// Settings store for workspace.getConfiguration; keys are `${section}.${key}`.
const _settings = new Map();
// Records of UI interactions so tests can assert on them.
const _messages = [];
const _executedCommands = [];
const _createdWatchers = [];

function makeWatcher(pattern) {
    const watcher = {
        pattern,
        onDidChange: new EventEmitter().event,
        onDidCreate: new EventEmitter().event,
        onDidDelete: new EventEmitter().event,
        disposed: false,
        dispose() {
            this.disposed = true;
        }
    };
    _createdWatchers.push(watcher);
    return watcher;
}

const workspace = {
    workspaceFolders: undefined,
    getConfiguration(section) {
        return {
            get(key, defaultValue) {
                const full = section ? `${section}.${key}` : key;
                return _settings.has(full) ? _settings.get(full) : defaultValue;
            }
        };
    },
    onDidChangeConfiguration: new EventEmitter().event,
    onDidChangeWorkspaceFolders: new EventEmitter().event,
    createFileSystemWatcher: pattern => makeWatcher(pattern),
    registerTextDocumentContentProvider: () => ({ dispose() {} })
};

const window = {
    state: { focused: true },
    showInformationMessage(message) {
        _messages.push({ kind: 'info', message });
        return Promise.resolve(undefined);
    },
    showWarningMessage(message) {
        _messages.push({ kind: 'warning', message });
        return Promise.resolve(undefined);
    },
    showErrorMessage(message) {
        _messages.push({ kind: 'error', message });
        return Promise.resolve(undefined);
    },
    showQuickPick() {
        return Promise.resolve(undefined);
    },
    showInputBox() {
        return Promise.resolve(undefined);
    },
    withProgress(_options, task) {
        return Promise.resolve(task());
    },
    registerTreeDataProvider: () => ({ dispose() {} }),
    registerFileDecorationProvider: () => ({ dispose() {} })
};

const commands = {
    executeCommand(command, ...args) {
        _executedCommands.push({ command, args });
        return Promise.resolve(undefined);
    },
    registerCommand: () => ({ dispose() {} })
};

const env = {
    clipboard: {
        writeText: () => Promise.resolve()
    }
};

const extensions = {
    getExtension: () => undefined
};

function _reset() {
    _settings.clear();
    _messages.length = 0;
    _executedCommands.length = 0;
    _createdWatchers.length = 0;
    workspace.workspaceFolders = undefined;
}

module.exports = {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    RelativePattern,
    TreeItemCollapsibleState,
    ProgressLocation,
    Uri,
    workspace,
    window,
    commands,
    env,
    extensions,
    // test hooks
    _settings,
    _messages,
    _executedCommands,
    _createdWatchers,
    _reset
};
