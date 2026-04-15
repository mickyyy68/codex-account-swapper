"use strict";

const ANSI_USER_PROMPT_BACKGROUND = "\u001b[48;5;236m";
const ANSI_RESET_BACKGROUND = "\u001b[49m";
const DISPLAY_PROMPT_SYMBOL = "\u203a";
const PROMPT_SYMBOLS = [
  DISPLAY_PROMPT_SYMBOL,
  "â€º",
  "Ã¢â‚¬Âº",
  "ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âº",
  "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Âº",
];

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

function skipAnsiSequence(text, startIndex) {
  if (text[startIndex] !== "\u001b") {
    return startIndex;
  }

  const next = text[startIndex + 1] || "";
  if (next === "[") {
    let cursor = startIndex + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        return cursor;
      }
      cursor += 1;
    }
    return text.length - 1;
  }

  if (next === "]") {
    let cursor = startIndex + 2;
    while (cursor < text.length) {
      if (text[cursor] === "\u0007") {
        return cursor;
      }
      if (text[cursor] === "\u001b" && text[cursor + 1] === "\\") {
        return cursor + 1;
      }
      cursor += 1;
    }
    return text.length - 1;
  }

  return Math.min(startIndex + 1, text.length - 1);
}

function findPromptStartInRaw(text) {
  const input = String(text || "");
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === "\u001b") {
      index = skipAnsiSequence(input, index) + 1;
      continue;
    }
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    break;
  }

  for (const symbol of PROMPT_SYMBOLS) {
    if (input.startsWith(symbol, index)) {
      return index;
    }
  }
  return -1;
}

function splitTrailingLineBreak(text) {
  if (text.endsWith("\r\n")) {
    return { body: text.slice(0, -2), lineBreak: "\r\n" };
  }
  if (text.endsWith("\n") || text.endsWith("\r")) {
    return { body: text.slice(0, -1), lineBreak: text.slice(-1) };
  }
  return { body: text, lineBreak: "" };
}

function analyzePromptCandidate(text) {
  const line = String(text || "");
  const whitespace = (line.match(/^[ \t]*/) || [""])[0];
  const rest = line.slice(whitespace.length);

  if (!rest) {
    return { couldBePrompt: true, ready: false };
  }

  for (const symbol of PROMPT_SYMBOLS) {
    if (symbol.startsWith(rest)) {
      return { couldBePrompt: true, ready: false };
    }
    if (rest.startsWith(symbol)) {
      const afterSymbol = rest.slice(symbol.length);
      if (!afterSymbol || /^[ \t]*$/.test(afterSymbol)) {
        return { couldBePrompt: true, ready: false };
      }
      if (/^[ \t]+\S[\s\S]*$/.test(afterSymbol)) {
        return { couldBePrompt: true, ready: true };
      }
    }
  }

  return { couldBePrompt: false, ready: false };
}

function isUserPromptLine(line) {
  return analyzePromptCandidate(String(line || "")).ready;
}

function highlightUserPromptLines(chunk) {
  const text = String(chunk || "");
  if (!text) {
    return "";
  }

  return text.replace(/(^|[\r\n])([^\r\n]*)/g, (match, prefix, line) => {
    if (!line) {
      return match;
    }
    return isUserPromptLine(line)
      ? `${prefix}${wrapPromptSegment(line)}`
      : `${prefix}${line}`;
  });
}

function createUserPromptOutputTransformer() {
  let mode = "unknown";
  let pending = "";

  function transform(chunk) {
    const input = String(chunk || "");
    if (!input) {
      return "";
    }

    let output = "";
    let index = 0;

    while (index < input.length) {
      if (mode === "plain") {
        const remainder = input.slice(index);
        const lineBreakIndex = remainder.search(/[\r\n]/);
        const promptStart = findPromptStartInRaw(remainder);

        if (promptStart !== -1 && (lineBreakIndex === -1 || promptStart < lineBreakIndex)) {
          output += remainder.slice(0, promptStart);
          const promptEnd = lineBreakIndex === -1 ? remainder.length : lineBreakIndex;
          output += wrapPromptSegment(remainder.slice(promptStart, promptEnd));
          if (lineBreakIndex === -1) {
            break;
          }
          output += remainder[promptEnd];
          index += promptEnd + 1;
          mode = "unknown";
          pending = "";
          continue;
        }

        if (lineBreakIndex === -1) {
          output += remainder;
          break;
        }
        const absoluteIndex = index + lineBreakIndex;
        output += input.slice(index, absoluteIndex + 1);
        index = absoluteIndex + 1;
        mode = "unknown";
        pending = "";
        continue;
      }

      if (mode === "prompt") {
        const lineBreakIndex = input.slice(index).search(/[\r\n]/);
        if (lineBreakIndex === -1) {
          output += wrapPromptSegment(input.slice(index));
          break;
        }
        const absoluteIndex = index + lineBreakIndex;
        const segment = input.slice(index, absoluteIndex);
        if (segment) {
          output += wrapPromptSegment(segment);
        }
        output += input[absoluteIndex];
        index = absoluteIndex + 1;
        mode = "unknown";
        pending = "";
        continue;
      }

      pending += input[index];
      index += 1;

      if (pending.endsWith("\r\n") || pending.endsWith("\n") || pending.endsWith("\r")) {
        output += highlightUserPromptLines(pending);
        pending = "";
        mode = "unknown";
        continue;
      }

      const analysis = analyzePromptCandidate(pending);
      if (analysis.ready) {
        const lineBreakIndex = input.slice(index).search(/[\r\n]/);
        if (lineBreakIndex === -1) {
          output += wrapPromptSegment(`${pending}${input.slice(index)}`);
          pending = "";
          mode = "prompt";
          break;
        }
        const absoluteIndex = index + lineBreakIndex;
        output += wrapPromptSegment(`${pending}${input.slice(index, absoluteIndex)}`);
        output += input[absoluteIndex];
        index = absoluteIndex + 1;
        pending = "";
        mode = "unknown";
        continue;
      }
      if (!analysis.couldBePrompt) {
        output += pending;
        pending = "";
        mode = "plain";
      }
    }

    return output;
  }

  function flush() {
    if (!pending) {
      return "";
    }
    const { body, lineBreak } = splitTrailingLineBreak(pending);
    pending = "";
    mode = "unknown";
    return (isUserPromptLine(body) ? wrapPromptSegment(body) : body) + lineBreak;
  }

  function reset() {
    pending = "";
    mode = "unknown";
  }

  return {
    transform,
    flush,
    reset,
  };
}

module.exports = {
  highlightUserPromptLines,
  createUserPromptOutputTransformer,
  formatHighlightedUserPrompt,
  ANSI_USER_PROMPT_BACKGROUND,
  ANSI_RESET_BACKGROUND,
};
