'use strict';

class GitError extends Error {
    constructor(message, command, stderr, code) {
        super(message);
        this.name = 'GitError';
        this.code = code || 'GIT_ERROR';
        this.stderr = stderr || '';
        this.command = command || '';
    }
}

module.exports = { GitError };
