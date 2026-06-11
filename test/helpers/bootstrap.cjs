'use strict';

/**
 * Test bootstrap: redirects `require('vscode')` to the stub in this folder so
 * that src modules can be loaded outside the extension host. Must be required
 * before any module from `src/`. Idempotent.
 */

const Module = require('module');
const path = require('path');

const STUB_PATH = path.join(__dirname, 'vscodeStub.cjs');

if (!Module.__gitfocalVscodeStubInstalled) {
    Module.__gitfocalVscodeStubInstalled = true;
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'vscode') {
            return STUB_PATH;
        }
        return originalResolve.call(this, request, ...rest);
    };
}

module.exports = { vscode: require(STUB_PATH) };
