'use strict';

const vscode = require('vscode');
const { GitService } = require('./git/gitService');
const { StateManager } = require('./models/stateManager');
const { BranchesTreeProvider } = require('./providers/branchesTreeProvider');
const { StashesTreeProvider } = require('./providers/stashesTreeProvider');
const { BranchDecorationProvider } = require('./ui/branchDecorationProvider');
const { registerBranchCommands } = require('./commands/branchCommands');
const { registerStashCommands } = require('./commands/stashCommands');
const { registerTopCommands } = require('./commands/topCommands');
const { resetGitPathCache } = require('./utils/gitPathResolver');
const preferences = require('./models/preferences');

async function activate(context) {
    preferences.init(context);
    void vscode.commands.executeCommand('setContext', 'gitfocal.hideSubmodules', preferences.getHideSubmodules());
    const git = new GitService();
    const stateManager = new StateManager(git);
    context.subscriptions.push(stateManager);

    const branchesProvider = new BranchesTreeProvider(stateManager);
    const stashesProvider = new StashesTreeProvider(stateManager);
    const branchDecorationProvider = new BranchDecorationProvider(stateManager);
    context.subscriptions.push(branchesProvider, stashesProvider, branchDecorationProvider);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('gitfocal.branches', branchesProvider),
        vscode.window.registerTreeDataProvider('gitfocal.stashes', stashesProvider),
        vscode.window.registerFileDecorationProvider(branchDecorationProvider)
    );

    const cmdCtx = { git, stateManager };
    context.subscriptions.push(
        ...registerTopCommands(cmdCtx),
        ...registerBranchCommands(cmdCtx),
        ...registerStashCommands(cmdCtx)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gitfocal.gitPath')) {
                resetGitPathCache();
                void stateManager.refresh();
            }
        })
    );

    await stateManager.initialize();
}

function deactivate() {
    // disposables handled via context.subscriptions
}

module.exports = { activate, deactivate };
