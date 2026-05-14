'use strict';

const vscode = require('vscode');
const { GitService } = require('./git/gitService');
const { StateManager } = require('./models/stateManager');
const { BranchesTreeProvider } = require('./providers/branchesTreeProvider');
const { StashesTreeProvider } = require('./providers/stashesTreeProvider');
const { TagsTreeProvider } = require('./providers/tagsTreeProvider');
const { BranchDecorationProvider } = require('./ui/branchDecorationProvider');
const { registerBranchCommands } = require('./commands/branchCommands');
const { registerStashCommands } = require('./commands/stashCommands');
const { registerTagCommands } = require('./commands/tagCommands');
const { registerTopCommands } = require('./commands/topCommands');
const { resetGitPathCache } = require('./utils/gitPathResolver');
const preferences = require('./models/preferences');

async function activate(context) {
    preferences.init(context);
    void vscode.commands.executeCommand('setContext', 'gitfocal.branches.hideSubmodules', preferences.getBranchesHideSubmodules());
    void vscode.commands.executeCommand('setContext', 'gitfocal.stashes.hideSubmodules', preferences.getStashesHideSubmodules());
    const git = new GitService();
    const stateManager = new StateManager(git);
    context.subscriptions.push(stateManager);

    // Construct the decoration provider BEFORE the branches tree provider so
    // its `onDidChange` handler runs first when state refreshes. That way
    // decorations are invalidated before the tree rebuilds its items, and the
    // newly rendered branch labels pick up fresh colors immediately instead of
    // briefly flashing back to the default (white) color.
    const branchDecorationProvider = new BranchDecorationProvider(stateManager);
    const branchesProvider = new BranchesTreeProvider(stateManager, git);
    const stashesProvider = new StashesTreeProvider(stateManager, git);
    const tagsProvider = new TagsTreeProvider(stateManager);
    context.subscriptions.push(branchesProvider, stashesProvider, tagsProvider, branchDecorationProvider);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('gitfocal.branches', branchesProvider),
        vscode.window.registerTreeDataProvider('gitfocal.stashes', stashesProvider),
        vscode.window.registerTreeDataProvider('gitfocal.tags', tagsProvider),
        vscode.window.registerFileDecorationProvider(branchDecorationProvider)
    );

    const cmdCtx = { git, stateManager };
    context.subscriptions.push(
        ...registerTopCommands(cmdCtx),
        ...registerBranchCommands(cmdCtx),
        ...registerStashCommands(cmdCtx),
        ...registerTagCommands(cmdCtx),
        vscode.commands.registerCommand('gitfocal.loadMoreCommits', element => branchesProvider.loadMoreCommits(element))
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
