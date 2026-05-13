'use strict';

const vscode = require('vscode');

const KEY_HIDE_SUBMODULES = 'gitfocal.hideSubmodules';

let _ctx;
const _emitter = new vscode.EventEmitter();

function init(ctx) {
    _ctx = ctx;
}

function getHideSubmodules() {
    return _ctx ? _ctx.workspaceState.get(KEY_HIDE_SUBMODULES, false) : false;
}

async function setHideSubmodules(value) {
    if (!_ctx) return;
    await _ctx.workspaceState.update(KEY_HIDE_SUBMODULES, !!value);
    _emitter.fire({ key: KEY_HIDE_SUBMODULES, value: !!value });
}

async function toggleHideSubmodules() {
    const next = !getHideSubmodules();
    await setHideSubmodules(next);
    return next;
}

const onDidChange = _emitter.event;

module.exports = {
    init,
    getHideSubmodules,
    setHideSubmodules,
    toggleHideSubmodules,
    onDidChange
};
