"use strict";

function buildTerminalResetSequence() {
  return [
    "\u001bc",
    "\u001b[0m",
    "\u001b[?25h",
    "\u001b[?1l",
    "\u001b>",
    "\u001b[?1000l",
    "\u001b[?1002l",
    "\u001b[?1003l",
    "\u001b[?1004l",
    "\u001b[?1006l",
    "\u001b[?1015l",
    "\u001b[?2004l",
    "\u001b[?1049l",
    "\r",
  ].join("");
}

function restoreTerminalState(stream) {
  const target = stream && typeof stream.write === "function" ? stream : process.stdout;
  target.write(buildTerminalResetSequence());
}

module.exports = {
  buildTerminalResetSequence,
  restoreTerminalState,
};
