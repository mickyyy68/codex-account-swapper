"use strict";

function renderAccountListView({
  message,
  hint,
  state,
  options,
  cursor,
  theme = {},
}) {
  const bar = typeof theme.bar === "string" ? theme.bar : "│";
  const arrow = typeof theme.arrow === "string" ? theme.arrow : "❯";
  const idleDot = typeof theme.idleDot === "string" ? theme.idleDot : "○";
  const style = typeof theme.style === "function" ? theme.style : (text) => text;

  const lines = [];
  lines.push(`${style("cyan", bar)}`);
  lines.push(`${style("cyan", bar)}  ${message}`);

  if (state === "submit" || state === "cancel") {
    const chosen = options && options[cursor];
    const label = chosen && typeof chosen.label === "string" ? chosen.label : "";
    const decorated = state === "cancel"
      ? style("strikethrough", style("dim", label))
      : style("dim", label);
    lines.push(`${style("gray", bar)}  ${decorated}`);
    return lines.join("\n");
  }

  const list = Array.isArray(options) ? options : [];
  list.forEach((option, index) => {
    const label = option && typeof option.label === "string" ? option.label : String(option && option.value ? option.value : "");
    if (index === cursor) {
      lines.push(`${style("cyan", bar)}  ${style("cyan", arrow)} ${label}`);
    } else {
      lines.push(`${style("cyan", bar)}  ${style("dim", idleDot)} ${style("dim", label)}`);
    }
  });

  if (hint) {
    lines.push(`${style("cyan", bar)}`);
    lines.push(`${style("cyan", bar)}  ${style("dim", hint)}`);
  }
  lines.push(`${style("cyan", bar)}`);
  return lines.join("\n");
}

function classifyKeypress(info) {
  const keyInfo = info && typeof info === "object" ? info : {};
  const name = typeof keyInfo.name === "string" ? keyInfo.name.toLowerCase() : "";
  const sequence = typeof keyInfo.sequence === "string" ? keyInfo.sequence : "";

  if (name === "delete" || sequence === "\x1b[3~") {
    return "delete";
  }
  if (name === "tab" || sequence === "\t") {
    return "rename";
  }
  if (name === "space" || sequence === " ") {
    return "add";
  }
  return "";
}

async function runAccountListPrompt({
  clackCore,
  addSentinel,
  message,
  hint,
  options,
  initialValue,
  style,
  theme,
} = {}) {
  if (!clackCore || typeof clackCore.SelectPrompt !== "function") {
    throw new Error("runAccountListPrompt requires @clack/core SelectPrompt");
  }

  const list = Array.isArray(options) ? options : [];
  if (list.length === 0) {
    return { action: "cancel" };
  }

  let shortcut = null;
  const renderOptions = { message, hint, theme: { ...theme, style } };

  const prompt = new clackCore.SelectPrompt({
    options: list,
    initialValue,
    render() {
      return renderAccountListView({
        ...renderOptions,
        state: this.state,
        options: this.options,
        cursor: this.cursor,
      });
    },
  });

  prompt.on("key", (_char, info) => {
    const type = classifyKeypress(info);
    if (!type) {
      return;
    }
    const currentValue = prompt.options && prompt.options[prompt.cursor]
      ? prompt.options[prompt.cursor].value
      : "";
    if (type === "add" && currentValue === addSentinel) {
      return;
    }
    shortcut = { action: type, value: type === "add" ? "" : currentValue };
    prompt.state = "cancel";
  });

  const result = await prompt.prompt();

  if (shortcut) {
    return shortcut;
  }
  if (clackCore.isCancel(result)) {
    return { action: "cancel" };
  }
  if (result === addSentinel) {
    return { action: "add", value: "" };
  }
  return { action: "select", value: result };
}

module.exports = {
  renderAccountListView,
  classifyKeypress,
  runAccountListPrompt,
};
