"use strict";

const ANSI_USER_PROMPT_BACKGROUND = "\u001b[48;5;236m";
const ANSI_RESET_BACKGROUND = "\u001b[49m";
const PROMPT_SYMBOLS = ["›", "â€º", "Ã¢â‚¬Âº"];

function wrapPromptSegment(text) {
  if (!text) {
    return "";
  }
  return `${ANSI_USER_PROMPT_BACKGROUND}${text}${ANSI_RESET_BACKGROUND}`;
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
        const lineBreakIndex = input.slice(index).search(/[\r\n]/);
        if (lineBreakIndex === -1) {
          output += input.slice(index);
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

  return {
    transform,
    flush,
  };
}

module.exports = {
  highlightUserPromptLines,
  createUserPromptOutputTransformer,
  ANSI_USER_PROMPT_BACKGROUND,
  ANSI_RESET_BACKGROUND,
};
