"use strict";

const { formatCdxFooterBadge } = require("./output-style");

const FOOTER_SEPARATOR_PATTERN = /[·•]/;
const MODEL_TOKEN_PATTERN = /^[a-z][a-z0-9.-]*\d[a-z0-9.-]*$/i;
const TIER_TOKEN_PATTERN = /^[a-z][a-z0-9._-]*$/i;

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isFooterPathToken(text) {
  return /[\\/]/.test(text);
}

function parseFooterLine(text) {
  const plain = stripAnsi(text);
  if (!/^\s{2,}/.test(plain) || plain.includes("CDX")) {
    return null;
  }

  const trimmed = plain.trim();
  const separatorMatch = trimmed.match(/\s([·•])\s/);
  if (!separatorMatch) {
    return null;
  }

  const separatorIndex = separatorMatch.index;
  const left = trimmed.slice(0, separatorIndex).trim();
  const right = trimmed.slice(separatorIndex + separatorMatch[0].length).trim();
  if (!left || !right || !isFooterPathToken(right)) {
    return null;
  }

  const leftParts = left.split(/\s+/);
  if (leftParts.length !== 2) {
    return null;
  }
  if (!MODEL_TOKEN_PATTERN.test(leftParts[0]) || !TIER_TOKEN_PATTERN.test(leftParts[1])) {
    return null;
  }

  return {
    model: leftParts[0],
    tier: leftParts[1],
    path: right,
  };
}

function looksLikeFooterPrefix(text) {
  const plain = stripAnsi(text);
  if (!plain || /[\r\n]/.test(plain) || plain.includes("CDX") || !/^\s{2,}/.test(plain)) {
    return false;
  }

  const trimmed = plain.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 0 || parts.length > 2) {
    return false;
  }

  if (!MODEL_TOKEN_PATTERN.test(parts[0])) {
    return false;
  }
  if (parts.length === 2 && !TIER_TOKEN_PATTERN.test(parts[1])) {
    return false;
  }

  return true;
}

function maybeAppendFooterBadge(line) {
  if (!parseFooterLine(line)) {
    return line;
  }
  return `${line}  ${formatCdxFooterBadge()}`;
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

    const input = pendingFooter ? `${pendingFooter}${nextChunk}` : nextChunk;
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
      if (parseFooterLine(tail) || looksLikeFooterPrefix(tail)) {
        pendingFooter = tail;
      } else {
        // If a buffered footer candidate is disproven by the next chunk, emit
        // the combined text plainly and leave the badge out entirely.
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
