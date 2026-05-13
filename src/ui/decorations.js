'use strict';

const vscode = require('vscode');

/**
 * Status categories drive both the single-word description and the label color:
 *   - 'synced'      → white (theme default)         no text
 *   - 'no-upstream' → green                         "local"
 *   - 'ahead'       → light blue                    "ahead"
 *   - 'behind'      → pale yellow                   "behind"
 *   - 'diverged'    → orange                        "diverged"
 */
function branchStatus(branch) {
    if (!branch.isTracking) {
        return 'no-upstream';
    }
    const { ahead, behind } = branch.aheadBehind;
    if (ahead > 0 && behind > 0) {
        return 'diverged';
    }
    if (ahead > 0) {
        return 'ahead';
    }
    if (behind > 0) {
        return 'behind';
    }
    return 'synced';
}

function colorForBranch(branch) {
    switch (branchStatus(branch)) {
        case 'no-upstream': return new vscode.ThemeColor('gitDecoration.untrackedResourceForeground');
        case 'ahead':       return new vscode.ThemeColor('charts.blue');
        case 'behind':      return new vscode.ThemeColor('charts.yellow');
        case 'diverged':    return new vscode.ThemeColor('charts.orange');
        default:            return undefined; // synced → theme default (white-ish)
    }
}

function formatBranchStatus(branch) {
    const s = branchStatus(branch);
    if (s === 'no-upstream') {
        return 'local';
    }
    if (s === 'ahead' || s === 'behind' || s === 'diverged') {
        return s;
    }
    return ''; // 'synced' \u2192 no status word
}

function formatBranchDescription(branch) {
    const segments = [];
    const status = formatBranchStatus(branch);
    if (status) {
        segments.push(`(${status})`);
    }
    if (branch.upstream) {
        segments.push(`\u2192 ${branch.upstream}`);
    }
    segments.push(branch.commitHash);
    return segments.join(' ');
}

module.exports = { branchStatus, colorForBranch, formatBranchStatus, formatBranchDescription };
