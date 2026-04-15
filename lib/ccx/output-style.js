"use strict";

const ANSI_USER_PROMPT_BACKGROUND = "\u001b[48;5;236m";
const ANSI_RESET_BACKGROUND = "\u001b[49m";
const USER_PROMPT_LINE_PATTERN = /(^|[\r\n])([ \t]*(?:›|â€º)[ \t]+\S[^\r\n]*)/g;

function highlightUserPromptLines(chunk) {
  const text = String(chunk || "");
  if (!text || !text.includes("›")) {
    return text;
  }

  return text.replace(
    USER_PROMPT_LINE_PATTERN,
    (_, prefix, line) => `${prefix}${ANSI_USER_PROMPT_BACKGROUND}${line}${ANSI_RESET_BACKGROUND}`,
  );
}

module.exports = {
  highlightUserPromptLines,
  ANSI_USER_PROMPT_BACKGROUND,
  ANSI_RESET_BACKGROUND,
};
