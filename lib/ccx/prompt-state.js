"use strict";

const { hasDraftText } = require("./input-buffer");

function extractVisiblePromptDraft(buffer) {
  const text = String(buffer || "");
  if (!text) {
    return "";
  }

  const matches = text.match(/(?:^|[\r\n])[ \t]*›[ \t]*([^\r\n]*)/g) || [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const raw = matches[index].replace(/^(?:[\r\n])+/, "");
    const promptText = raw.replace(/^[ \t]*›[ \t]*/, "").trim();
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
