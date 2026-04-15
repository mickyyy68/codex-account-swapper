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

function extractVisiblePromptDraft(buffer) {
  const text = String(buffer || "");
  if (!text) {
    return "";
  }

  const matches = text.match(new RegExp(`(?:^|[\\r\\n])[ \\t]*(?:${PROMPT_MARKER_PATTERN})[ \\t]*([^\\r\\n]*)`, "g")) || [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const raw = matches[index].replace(/^(?:[\r\n])+/, "");
    const promptText = raw.replace(new RegExp(`^[ \\t]*(?:${PROMPT_MARKER_PATTERN})[ \\t]*`), "").trim();
    if (promptText) {
      return promptText;
    }
  }

  return "";
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
