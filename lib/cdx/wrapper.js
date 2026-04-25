"use strict";

async function runCodexWrapper(options = {}) {
  const {
    mainImpl,
    argv,
  } = options;

  return mainImpl({
    forwardedArgs: Array.isArray(argv) ? argv : [],
  });
}

module.exports = {
  runCodexWrapper,
};
