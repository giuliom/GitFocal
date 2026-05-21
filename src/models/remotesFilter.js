'use strict';

const vscode = require('vscode');

const CONTEXT_KEY = 'gitfocal.remotes.hasFilter';

let _filter = '';
const _emitter = new vscode.EventEmitter();

function get() {
    return _filter;
}

function set(value) {
    const next = (value || '').trim();
    if (next === _filter) {
        return;
    }
    _filter = next;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!_filter);
    _emitter.fire(_filter);
}

function clear() {
    set('');
}

const onDidChange = _emitter.event;

module.exports = { get, set, clear, onDidChange, CONTEXT_KEY };
