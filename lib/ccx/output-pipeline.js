"use strict";

const { maybeAppendFooterBadge } = require("./output-style");

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function looksLikeFooterPrefix(text) {
  const plain = stripAnsi(text);
  if (!plain || /[\r\n]/.test(plain) || plain.includes("CDX")) {
    return false;
  }
  if (!/^\s{2,}/.test(plain)) {
    return false;
  }

  const trimmed = plain.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return false;
  }

  const modelToken = parts[0];
  if (!/[0-9]/.test(modelToken)) {
    return false;
  }

  return true;
}

function createOutputPipeline(options = {}) {
  const enableFooterBadge = options.enableFooterBadge === true;
  let pendingFooter = "";

  function transform(chunk) {
    const nextChunk = String(chunk || "");
    if (!nextChunk) {
      return "";
    }

    if (!enableFooterBadge) {
      return nextChunk;
    }

    const input = `${pendingFooter}${nextChunk}`;
    pendingFooter = "";
    let output = "";
    let cursor = 0;

    while (cursor < input.length) {
      const lineBreakIndex = input.slice(cursor).search(/[\r\n]/);
      if (lineBreakIndex === -1) {
        break;
      }

      const absoluteIndex = cursor + lineBreakIndex;
      let lineBreak = input[absoluteIndex];
      let nextIndex = absoluteIndex + 1;
      if (lineBreak === "\r" && input[nextIndex] === "\n") {
        lineBreak = "\r\n";
        nextIndex += 1;
      }

      output += `${maybeAppendFooterBadge(input.slice(cursor, absoluteIndex))}${lineBreak}`;
      cursor = nextIndex;
    }

    const tail = input.slice(cursor);
    if (tail) {
      if (looksLikeFooterPrefix(tail)) {
        pendingFooter = tail;
      } else {
        output += tail;
      }
    }

    return output;
  }

  function flush() {
    const output = pendingFooter ? maybeAppendFooterBadge(pendingFooter) : "";
    pendingFooter = "";
    return output;
  }

  function reset() {
    pendingFooter = "";
  }

  return {
    transform,
    flush,
    reset,
  };
}

module.exports = {
  createOutputPipeline,
};
