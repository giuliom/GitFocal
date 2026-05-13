'use strict';

const { execFile } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const vscode = require('vscode');

let cachedPath;

function resetGitPathCache() {
    cachedPath = undefined;
}

/**
 * Resolve the git executable path cross-platform.
 * Order:
 *   1. `gitfocal.gitPath` configuration setting (if set & exists).
 *   2. PATH lookup via `which` / `where`.
 *   3. Common Windows install paths.
 *   4. Fallback to bare "git" (relies on PATH at exec time).
 */
async function resolveGitPath() {
    if (cachedPath) {
        return cachedPath;
    }

    const config = vscode.workspace.getConfiguration('gitfocal');
    const configured = (config.get('gitPath', '') || '').trim();
    if (configured && existsSync(configured)) {
        cachedPath = configured;
        return cachedPath;
    }

    const isWindows = process.platform === 'win32';
    const lookup = isWindows ? 'where' : 'which';

    try {
        const found = await new Promise((resolve, reject) => {
            execFile(lookup, ['git'], { windowsHide: true }, (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                const first = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
                if (first && existsSync(first)) {
                    resolve(first);
                } else {
                    reject(new Error('git not found on PATH'));
                }
            });
        });
        cachedPath = found;
        return cachedPath;
    } catch {
        // ignore, fall through
    }

    if (isWindows) {
        const candidates = [
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
            path.join(process.env['LocalAppData'] || '', 'Programs', 'Git', 'cmd', 'git.exe')
        ];
        for (const c of candidates) {
            if (c && existsSync(c)) {
                cachedPath = c;
                return cachedPath;
            }
        }
    }

    cachedPath = 'git';
    return cachedPath;
}

module.exports = { resolveGitPath, resetGitPathCache };
