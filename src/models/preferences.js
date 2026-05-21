'use strict';

const vscode = require('vscode');

const KEY_LEGACY_HIDE_SUBMODULES = 'gitfocal.hideSubmodules';
const KEY_BRANCHES_HIDE_SUBMODULES = 'gitfocal.branches.hideSubmodules';
const KEY_REMOTES_HIDE_SUBMODULES = 'gitfocal.remotes.hideSubmodules';
const KEY_STASHES_HIDE_SUBMODULES = 'gitfocal.stashes.hideSubmodules';

let _ctx;
const _emitter = new vscode.EventEmitter();

function init(ctx) {
    _ctx = ctx;
}

function getBranchesHideSubmodules() {
    return getBoolean(KEY_BRANCHES_HIDE_SUBMODULES, getBoolean(KEY_LEGACY_HIDE_SUBMODULES, false));
}

function getRemotesHideSubmodules() {
    return getBoolean(KEY_REMOTES_HIDE_SUBMODULES, getBoolean(KEY_LEGACY_HIDE_SUBMODULES, false));
}

function getStashesHideSubmodules() {
    return getBoolean(KEY_STASHES_HIDE_SUBMODULES, false);
}

async function setBranchesHideSubmodules(value) {
    await setBoolean(KEY_BRANCHES_HIDE_SUBMODULES, value);
}

async function setRemotesHideSubmodules(value) {
    await setBoolean(KEY_REMOTES_HIDE_SUBMODULES, value);
}

async function setStashesHideSubmodules(value) {
    await setBoolean(KEY_STASHES_HIDE_SUBMODULES, value);
}

async function toggleBranchesHideSubmodules() {
    const next = !getBranchesHideSubmodules();
    await setBranchesHideSubmodules(next);
    return next;
}

async function toggleRemotesHideSubmodules() {
    const next = !getRemotesHideSubmodules();
    await setRemotesHideSubmodules(next);
    return next;
}

async function toggleStashesHideSubmodules() {
    const next = !getStashesHideSubmodules();
    await setStashesHideSubmodules(next);
    return next;
}

function getBoolean(key, fallback) {
    return _ctx ? _ctx.workspaceState.get(key, fallback) : fallback;
}

async function setBoolean(key, value) {
    if (!_ctx) return;
    await _ctx.workspaceState.update(key, !!value);
    _emitter.fire({ key, value: !!value });
}

const onDidChange = _emitter.event;

module.exports = {
    KEY_BRANCHES_HIDE_SUBMODULES,
    KEY_REMOTES_HIDE_SUBMODULES,
    KEY_STASHES_HIDE_SUBMODULES,
    init,
    getBranchesHideSubmodules,
    getRemotesHideSubmodules,
    getStashesHideSubmodules,
    setBranchesHideSubmodules,
    setRemotesHideSubmodules,
    setStashesHideSubmodules,
    toggleBranchesHideSubmodules,
    toggleRemotesHideSubmodules,
    toggleStashesHideSubmodules,
    onDidChange
};
