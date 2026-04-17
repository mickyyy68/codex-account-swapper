"use strict";

const ANSI_USER_PROMPT_BACKGROUND = "\u001b[48;5;236m";
const ANSI_RESET_BACKGROUND = "\u001b[49m";
const ANSI_BOLD_GREEN = "\u001b[1;32m";
const DISPLAY_PROMPT_SYMBOL = "\u203a";

function wrapPromptSegment(text) {
  if (!text) {
    return "";
  }
  return `${ANSI_USER_PROMPT_BACKGROUND}${text}${ANSI_RESET_BACKGROUND}`;
}

function formatHighlightedUserPrompt(prompt) {
  const text = String(prompt || "");
  if (!text) {
    return "";
  }
  return wrapPromptSegment(`${DISPLAY_PROMPT_SYMBOL} ${text}`);
}

function formatCdxFooterBadge() {
  return `${ANSI_BOLD_GREEN}CDX\u001b[0m`;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function looksLikeCodexStatusLine(line) {
  const plain = stripAnsi(line).trimEnd();
  if (!plain || plain.includes("CDX")) {
    return false;
  }
  if (!/[\\/]/.test(plain)) {
    return false;
  }
  return /^\s*\S+\s+\S+\s+.\s+.+$/.test(plain);
}

function maybeAppendFooterBadge(line) {
  if (!looksLikeCodexStatusLine(line)) {
    return line;
  }
  return `${line}  ${formatCdxFooterBadge()}`;
}

module.exports = {
  formatHighlightedUserPrompt,
  formatCdxFooterBadge,
  maybeAppendFooterBadge,
  ANSI_USER_PROMPT_BACKGROUND,
  ANSI_RESET_BACKGROUND,
};
