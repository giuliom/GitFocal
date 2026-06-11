'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { normalizeFsPath, pathsEqual, pathStartsWith } = require('../src/utils/pathUtils');

const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const sep = path.sep;

test('normalizeFsPath strips trailing separators', () => {
    assert.equal(normalizeFsPath(`${sep}repo${sep}`), `${sep}repo`);
    assert.equal(normalizeFsPath(`${sep}repo`), `${sep}repo`);
});

test('normalizeFsPath preserves the filesystem root', () => {
    assert.equal(normalizeFsPath(sep), sep);
});

test('normalizeFsPath collapses redundant segments', () => {
    assert.equal(normalizeFsPath(`${sep}a${sep}.${sep}b${sep}..${sep}c`), `${sep}a${sep}c`);
});

test('normalizeFsPath passes through empty values', () => {
    assert.equal(normalizeFsPath(''), '');
    assert.equal(normalizeFsPath(undefined), undefined);
});

test('pathsEqual matches identical and trailing-slash variants', () => {
    assert.equal(pathsEqual(`${sep}a${sep}b`, `${sep}a${sep}b`), true);
    assert.equal(pathsEqual(`${sep}a${sep}b${sep}`, `${sep}a${sep}b`), true);
    assert.equal(pathsEqual(`${sep}a${sep}b`, `${sep}a${sep}c`), false);
});

test('pathsEqual rejects a single empty operand', () => {
    assert.equal(pathsEqual('', `${sep}a`), false);
    assert.equal(pathsEqual(`${sep}a`, undefined), false);
    // Identical references short-circuit before the empty check.
    assert.equal(pathsEqual(undefined, undefined), true);
});

test('pathsEqual case sensitivity follows the platform', () => {
    assert.equal(pathsEqual(`${sep}Repo`, `${sep}repo`), isCaseInsensitiveFs);
});

test('pathStartsWith accepts equal paths and descendants', () => {
    assert.equal(pathStartsWith(`${sep}a${sep}b`, `${sep}a${sep}b`), true);
    assert.equal(pathStartsWith(`${sep}a${sep}b${sep}c`, `${sep}a${sep}b`), true);
});

test('pathStartsWith rejects mere string prefixes and siblings', () => {
    // "/a/bc" is not inside "/a/b" even though the string starts with it.
    assert.equal(pathStartsWith(`${sep}a${sep}bc`, `${sep}a${sep}b`), false);
    assert.equal(pathStartsWith(`${sep}a${sep}b`, `${sep}a${sep}b${sep}c`), false);
    assert.equal(pathStartsWith(undefined, `${sep}a`), false);
});
