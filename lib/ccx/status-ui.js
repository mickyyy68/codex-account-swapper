"use strict";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD_YELLOW = "\u001b[1;33m";
const ANSI_BOLD_GREEN = "\u001b[1;32m";
const ANSI_BOLD_RED = "\u001b[1;31m";

function colorize(color, text) {
  return `${color}${text}${ANSI_RESET}`;
}

function renderDecisionMessage(result) {
  if (!result) {
    return "Smart switch failed.";
  }
  if (result.allExhausted) {
    return "All eligible accounts are exhausted right now.";
  }
  if (result.reason === "no_accounts") {
    return "No accounts configured.";
  }
  if (result.reason === "no_recommendation") {
    return "No smart-switch account is available.";
  }
  if (result.switched) {
    return result.from
      ? `SWITCHED '${result.from}' -> '${result.to}'. Reopening session...`
      : `SWITCHED to '${result.to}'. Reopening session...`;
  }
  if (result.alreadyOptimal) {
    return `SWITCHED '${result.to}'. Reopening session...`;
  }
  return "Smart switch completed.";
}

function formatSwitchingBanner() {
  return colorize(ANSI_BOLD_YELLOW, "[ccx] SWITCHING ACCOUNT...");
}

function formatDecisionBanner(result) {
  const color = result && result.ok ? ANSI_BOLD_GREEN : ANSI_BOLD_RED;
  return colorize(color, `[ccx] ${renderDecisionMessage(result)}`);
}

function formatFailureBanner(message) {
  return colorize(ANSI_BOLD_RED, `[ccx] ${String(message || "Smart switch failed.")}`);
}

module.exports = {
  formatSwitchingBanner,
  formatDecisionBanner,
  formatFailureBanner,
  renderDecisionMessage,
};
