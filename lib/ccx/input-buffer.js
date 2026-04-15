"use strict";

function removeLastCharacter(value) {
  const chars = Array.from(String(value || ""));
  chars.pop();
  return chars.join("");
}

function removeLastWord(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  return text
    .replace(/\s+$/u, "")
    .replace(/[^\s]+$/u, "");
}

function decodeWin32InputSequence(body) {
  const parts = String(body || "")
    .split(";")
    .map((part) => Number.parseInt(part, 10));

  if (parts.length < 6 || parts.some((value) => !Number.isFinite(value))) {
    return "";
  }

  const unicodeChar = parts[2];
  const keyDown = parts[3] === 1;
  if (!keyDown) {
    return "";
  }

  if (unicodeChar === 13) {
    return "\r";
  }
  if (unicodeChar === 8) {
    return "\b";
  }
  if (unicodeChar === 23) {
    return "\u0017";
  }
  if (unicodeChar === 0) {
    return "";
  }

  try {
    return String.fromCodePoint(unicodeChar);
  } catch {
    return "";
  }
}

function normalizeChunkInput(chunk) {
  const input = String(chunk || "");
  if (!input) {
    return "";
  }

  let result = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\u001b") {
      result += char;
      continue;
    }

    const next = input[index + 1] || "";

    // CSI sequence: ESC [ ... final-byte
    if (next === "[") {
      let cursor = index + 2;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
        cursor += 1;
      }
      const final = input[cursor] || "";
      if (final === "_") {
        result += decodeWin32InputSequence(input.slice(index + 2, cursor));
      }
      index = cursor;
      continue;
    }

    // SS3 sequence. Treat ESC O M as keypad enter.
    if (next === "O") {
      const final = input[index + 2] || "";
      if (final === "M") {
        result += "\r";
      }
      index += 2;
      continue;
    }

    // OSC sequence: ESC ] ... BEL or ESC \
    if (next === "]") {
      let cursor = index + 2;
      while (cursor < input.length) {
        const current = input[cursor];
        if (current === "\u0007") {
          break;
        }
        if (current === "\u001b" && input[cursor + 1] === "\\") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }

    // Unknown escape: drop the escape itself and keep scanning remaining chars.
  }

  return result;
}

function applyInputChunk(draft, chunk) {
  const input = normalizeChunkInput(chunk);
  if (!input) {
    return { draft: String(draft || ""), submitted: false, changed: false };
  }

  let nextDraft = String(draft || "");
  let submitted = false;
  let changed = false;

  for (const char of Array.from(input)) {
    if (char === "\r" || char === "\n") {
      submitted = true;
      continue;
    }

    if (char === "\u007f" || char === "\b") {
      const shortened = removeLastCharacter(nextDraft);
      if (shortened !== nextDraft) {
        nextDraft = shortened;
        changed = true;
      }
      continue;
    }

    if (char === "\u0017") {
      const shortened = removeLastWord(nextDraft);
      if (shortened !== nextDraft) {
        nextDraft = shortened;
        changed = true;
      }
      continue;
    }

    if (char === "\u0003" || char === "\u0004") {
      continue;
    }

    const codePoint = char.codePointAt(0);
    if (!Number.isFinite(codePoint)) {
      continue;
    }
    if (char !== "\t" && codePoint < 32) {
      continue;
    }

    nextDraft += char;
    changed = true;
  }

  return {
    draft: nextDraft,
    submitted,
    changed,
  };
}

function chunkRequestsAbort(chunk) {
  const input = normalizeChunkInput(chunk);
  return input.includes("\u0003") || input.includes("\u0004");
}

function hasDraftText(draft) {
  return Array.from(String(draft || "")).length > 0;
}

module.exports = {
  applyInputChunk,
  chunkRequestsAbort,
  hasDraftText,
};
