"use strict";

/** Minimal winston surface for @neovim/node-client logger.js (drops ~300KB+ of winston deps). */
const noop = () => {};
const fmt = () => ({});

module.exports = {
  format: {
    combine: () => ({}),
    splat: fmt,
    timestamp: () => ({}),
    printf: () => ({}),
  },
  createLogger(opts) {
    return {
      level: opts?.level,
      add: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    };
  },
  transports: {
    File: class {
      constructor() {}
    },
    Console: class {
      constructor() {}
    },
  },
};
