'use strict';

const path = require('path');
const vscode = require('vscode');

const STASH_CONTENT_SCHEME = 'gitfocal-stash';

class StashDiffContentProvider {
    constructor(git) {
        this.git = git;
    }

    async provideTextDocumentContent(uri) {
        const request = parseRequest(uri);
        if (!request) {
            return 'GitFocal: invalid stash diff request.';
        }
        if (request.kind === 'stashPatch') {
            return this.git.getStashPatch(request.repoPath, request.stashId);
        }
        if (request.kind === 'stashFile') {
            return this.git.getStashFileContent(
                request.repoPath,
                request.stashId,
                request.filePath,
                request.side,
                request.originalPath
            );
        }
        return '';
    }
}

function buildStashPatchUri(repoPath, stashId) {
    return buildUri('stashPatch', repoPath, stashId, `${safeName(stashId)}.diff`);
}

function buildStashFileUri(repoPath, stashId, filePath, side, originalPath) {
    const displayedPath = side === 'left' && originalPath ? originalPath : filePath;
    return buildUri('stashFile', repoPath, stashId, path.basename(displayedPath) || 'file', {
        filePath,
        side,
        originalPath
    });
}

function buildUri(kind, repoPath, stashId, displayName, extra) {
    const request = Object.assign({ kind, repoPath, stashId }, extra || {});
    return vscode.Uri.from({
        scheme: STASH_CONTENT_SCHEME,
        path: `/${safeName(displayName)}`,
        query: encodeURIComponent(JSON.stringify(request))
    });
}

function parseRequest(uri) {
    try {
        const request = JSON.parse(decodeURIComponent(uri.query));
        if (!request || !request.kind || !request.repoPath || !request.stashId) {
            return undefined;
        }
        return request;
    } catch {
        return undefined;
    }
}

function safeName(name) {
    return String(name || 'stash').replace(/[\\/:*?"<>|]/g, '_');
}

module.exports = {
    STASH_CONTENT_SCHEME,
    StashDiffContentProvider,
    buildStashPatchUri,
    buildStashFileUri
};