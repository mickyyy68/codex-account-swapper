"use strict";

function createOutputPipeline() {
  return {
    transform(chunk) {
      return String(chunk || "");
    },
    flush() {
      return "";
    },
    reset() {
      // no-op in minimal mode
    },
  };
}

module.exports = {
  createOutputPipeline,
};
