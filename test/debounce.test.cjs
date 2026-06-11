'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { debounce } = require('../src/utils/debounce');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('debounce coalesces rapid calls into one with the last args', async () => {
    const calls = [];
    const fn = debounce((...args) => calls.push(args), 10);
    fn(1);
    fn(2);
    fn(3);
    await sleep(40);
    assert.deepEqual(calls, [[3]]);
});

test('debounce fires again for calls after the delay', async () => {
    const calls = [];
    const fn = debounce(v => calls.push(v), 10);
    fn('a');
    await sleep(30);
    fn('b');
    await sleep(30);
    assert.deepEqual(calls, ['a', 'b']);
});

test('cancel prevents the pending invocation', async () => {
    const calls = [];
    const fn = debounce(v => calls.push(v), 10);
    fn('x');
    fn.cancel();
    await sleep(30);
    assert.deepEqual(calls, []);
});

test('flush invokes immediately with the last args and clears the timer', async () => {
    const calls = [];
    const fn = debounce(v => calls.push(v), 1000);
    fn('y');
    fn.flush();
    assert.deepEqual(calls, ['y']);
    await sleep(20);
    assert.deepEqual(calls, ['y']);
});

test('flush without a pending call is a no-op', () => {
    const calls = [];
    const fn = debounce(v => calls.push(v), 10);
    fn.flush();
    assert.deepEqual(calls, []);
});
