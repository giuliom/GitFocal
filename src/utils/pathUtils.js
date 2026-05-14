'use strict';

const path = require('path');

const isWindows = process.platform === 'win32';

/**
 * Normalize a filesystem path to the platform's canonical form so that paths
 * obtained from different sources (git CLI vs VS Code URIs) compare equal.
 *
 * - Converts to the platform separator (`\` on Windows, `/` elsewhere).
 * - Trims trailing separators (except for root).
 * - Uppercases the drive letter on Windows.
 */
function normalizeFsPath(p) {
    if (!p) {
        return p;
    }
    let normalized = path.normalize(String(p));
    // Strip trailing separator unless it's a root like "/" or "C:\"
    if (normalized.length > 1) {
        const last = normalized.charAt(normalized.length - 1);
        if ((last === '/' || last === '\\') && !/^[A-Za-z]:[\\/]$/.test(normalized)) {
            normalized = normalized.slice(0, -1);
        }
    }
    if (isWindows && /^[a-z]:/.test(normalized)) {
        normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
    return normalized;
}

/**
 * Compare two filesystem paths for equality. Case-insensitive on Windows.
 */
function pathsEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    const na = normalizeFsPath(a);
    const nb = normalizeFsPath(b);
    return isWindows ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Returns true when `child` is equal to or contained within `parent`.
 * Case-insensitive on Windows.
 */
function pathStartsWith(child, parent) {
    if (!child || !parent) {
        return false;
    }
    const nc = normalizeFsPath(child);
    const np = normalizeFsPath(parent);
    const a = isWindows ? nc.toLowerCase() : nc;
    const b = isWindows ? np.toLowerCase() : np;
    if (a === b) {
        return true;
    }
    return a.startsWith(b + path.sep);
}

module.exports = { normalizeFsPath, pathsEqual, pathStartsWith, isWindows };
