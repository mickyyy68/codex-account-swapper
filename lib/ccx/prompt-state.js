"use strict";

const { hasDraftText } = require("./input-buffer");

const PROMPT_MARKERS = [
  "\u203a",
  "â€º",
  "Ã¢â‚¬Âº",
  "ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âº",
  "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Âº",
];

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROMPT_MARKER_PATTERN = PROMPT_MARKERS.map(escapeRegex).join("|");
const PROMPT_MARKER_REGEX = new RegExp(`^[ \\t]*(?:${PROMPT_MARKER_PATTERN})[ \\t]*`);

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isCodexFooterLine(line) {
  const plain = stripAnsi(line).trimEnd();
  if (!plain) {
    return false;
  }
  if (!/[\\/]/.test(plain)) {
    return false;
  }
  return /^\s*\S+\s+\S+\s+.\s+.+$/.test(plain);
}

function isIgnorableTrailingLine(line) {
  const plain = stripAnsi(line).trim();
  return !plain || isCodexFooterLine(line);
}

function isPromptLine(line) {
  return PROMPT_MARKER_REGEX.test(stripAnsi(line));
}

function isPromptContinuationLine(line) {
  return /^[ \t]+\S/.test(stripAnsi(line));
}

function normalizePromptLine(line) {
  return stripAnsi(line).replace(PROMPT_MARKER_REGEX, "").trimEnd();
}

function normalizePromptContinuationLine(line) {
  return stripAnsi(line).replace(/[ \t]+$/u, "");
}

function extractVisiblePromptDraft(buffer) {
  const text = String(buffer || "");
  if (!text) {
    return "";
  }

  const lines = text.split(/\r\n|[\r\n]/);
  let endIndex = lines.length - 1;
  let sawTrailingFooterLine = false;
  let sawTrailingBlankLine = false;

  while (endIndex >= 0 && isIgnorableTrailingLine(lines[endIndex])) {
    if (isCodexFooterLine(lines[endIndex])) {
      sawTrailingFooterLine = true;
    } else if (!stripAnsi(lines[endIndex]).trim()) {
      sawTrailingBlankLine = true;
    }
    endIndex -= 1;
  }
  if (endIndex < 0) {
    return "";
  }

  const continuationLines = [];
  let cursor = endIndex;
  while (cursor >= 0 && isPromptContinuationLine(lines[cursor])) {
    continuationLines.unshift(normalizePromptContinuationLine(lines[cursor]));
    cursor -= 1;
  }

  if (continuationLines.length > 0 && !sawTrailingFooterLine && !sawTrailingBlankLine) {
    return "";
  }

  if (cursor < 0 || !isPromptLine(lines[cursor])) {
    return "";
  }

  const promptLines = [normalizePromptLine(lines[cursor]), ...continuationLines].filter(Boolean);
  if (promptLines.length === 0) {
    return "";
  }

  return promptLines.join("\n");
}

function resolvePendingPrompt(draftBuffer, outputBuffer) {
  if (hasDraftText(draftBuffer)) {
    return String(draftBuffer || "");
  }
  return extractVisiblePromptDraft(outputBuffer);
}

function extractResumeSessionId(buffer) {
  const text = String(buffer || "");
  if (!text) {
    return "";
  }

  const match = text.match(/codex\s+resume\s+([0-9a-f]{8}-[0-9a-f-]{27})/i);
  return match ? match[1] : "";
}

module.exports = {
  extractVisiblePromptDraft,
  resolvePendingPrompt,
  extractResumeSessionId,
};
