'use strict';

/** Simple debounce utility — no external dependencies. */
function debounce(fn, delayMs) {
    let timer;
    let lastArgs;

    const wrapped = function (...args) {
        lastArgs = args;
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            if (lastArgs) {
                fn(...lastArgs);
                lastArgs = undefined;
            }
        }, delayMs);
    };

    wrapped.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        lastArgs = undefined;
    };

    wrapped.flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (lastArgs) {
            fn(...lastArgs);
            lastArgs = undefined;
        }
    };

    return wrapped;
}

module.exports = { debounce };
