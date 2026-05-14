'use strict';

const { execFile } = require('child_process');
const { existsSync, statSync } = require('fs');
const path = require('path');
const vscode = require('vscode');

let cachedPath;
let notFoundWarned = false;

function resetGitPathCache() {
    cachedPath = undefined;
    notFoundWarned = false;
}

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function isExecutableFile(p) {
    try {
        if (!p || !existsSync(p)) {
            return false;
        }
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

function verifyGit(executable) {
    return new Promise(resolve => {
        try {
            execFile(executable, ['--version'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err) {
                    resolve(false);
                    return;
                }
                resolve(/^git version /i.test((stdout || '').trim()));
            });
        } catch {
            resolve(false);
        }
    });
}

function lookupOnPath() {
    const lookup = isWindows ? 'where' : 'which';
    const arg = isWindows ? 'git.exe' : 'git';
    return new Promise(resolve => {
        try {
            execFile(lookup, [arg], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err) {
                    resolve(undefined);
                    return;
                }
                const lines = (stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                for (const line of lines) {
                    if (isExecutableFile(line)) {
                        resolve(line);
                        return;
                    }
                }
                resolve(undefined);
            });
        } catch {
            resolve(undefined);
        }
    });
}

async function fromVSCodeGitExtension() {
    try {
        const ext = vscode.extensions.getExtension('vscode.git');
        if (!ext) {
            return undefined;
        }
        const exports = ext.isActive ? ext.exports : await ext.activate();
        if (!exports || typeof exports.getAPI !== 'function') {
            return undefined;
        }
        const api = exports.getAPI(1);
        // The built-in git extension exposes the git path it auto-detected
        // (honoring the `git.path` setting). Use it as a hint.
        const candidate = api && api.git && api.git.path;
        if (typeof candidate === 'string' && isExecutableFile(candidate)) {
            return candidate;
        }
    } catch {
        // ignore
    }
    return undefined;
}

function platformCandidates() {
    if (isWindows) {
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = process.env['LocalAppData'] || '';
        const list = [
            path.join(programFiles, 'Git', 'cmd', 'git.exe'),
            path.join(programFiles, 'Git', 'bin', 'git.exe'),
            path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
            path.join(programFilesX86, 'Git', 'bin', 'git.exe')
        ];
        if (localAppData) {
            list.push(path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'));
            list.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'));
        }
        return list;
    }
    if (isMac) {
        return [
            '/opt/homebrew/bin/git',                         // Apple Silicon Homebrew
            '/usr/local/bin/git',                            // Intel Homebrew / manual install
            '/usr/bin/git',                                  // Xcode Command Line Tools shim
            '/Library/Developer/CommandLineTools/usr/bin/git'
        ];
    }
    // Linux / other Unix
    return [
        '/usr/bin/git',
        '/usr/local/bin/git',
        '/bin/git',
        '/snap/bin/git'
    ];
}

async function pickFirstWorking(candidates) {
    for (const c of candidates) {
        if (c && isExecutableFile(c) && await verifyGit(c)) {
            return c;
        }
    }
    return undefined;
}

/**
 * Resolve the git executable path cross-platform.
 * Order:
 *   1. `gitfocal.gitPath` configuration setting (if set & valid).
 *   2. VS Code built-in git extension (`api.git.path`).
 *   3. `which` / `where git` lookup on PATH.
 *   4. Common platform install paths (Homebrew, Xcode CLT, /usr/bin, Program Files, ...).
 *   5. Fallback to bare "git" so PATH is consulted again at exec time.
 */
async function resolveGitPath() {
    if (cachedPath) {
        return cachedPath;
    }

    const config = vscode.workspace.getConfiguration('gitfocal');
    const configured = (config.get('gitPath', '') || '').trim();
    if (configured) {
        if (isExecutableFile(configured) && await verifyGit(configured)) {
            cachedPath = configured;
            return cachedPath;
        }
        if (!notFoundWarned) {
            notFoundWarned = true;
            void vscode.window.showWarningMessage(
                `GitFocal: configured 'gitfocal.gitPath' (${configured}) is not a working git executable. Falling back to auto-detection.`
            );
        }
    }

    const fromExt = await fromVSCodeGitExtension();
    if (fromExt && await verifyGit(fromExt)) {
        cachedPath = fromExt;
        return cachedPath;
    }

    const fromPath = await lookupOnPath();
    if (fromPath && await verifyGit(fromPath)) {
        cachedPath = fromPath;
        return cachedPath;
    }

    const fromCandidates = await pickFirstWorking(platformCandidates());
    if (fromCandidates) {
        cachedPath = fromCandidates;
        return cachedPath;
    }

    if (!notFoundWarned) {
        notFoundWarned = true;
        void vscode.window.showWarningMessage(
            'GitFocal: could not locate a working git executable. Set "gitfocal.gitPath" in settings to point to your git binary.'
        );
    }
    cachedPath = isWindows ? 'git.exe' : 'git';
    return cachedPath;
}

module.exports = { resolveGitPath, resetGitPathCache };
