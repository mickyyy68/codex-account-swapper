"use strict";

const {
  isSessionStateUsageLimitExceeded,
} = require("./session-log");

function createSessionObserver(options = {}) {
  const readSessionState = typeof options.readSessionState === "function"
    ? options.readSessionState
    : () => null;
  const onUsageLimitExceeded = typeof options.onUsageLimitExceeded === "function"
    ? options.onUsageLimitExceeded
    : () => {};
  const intervalMs = Number.isFinite(Number(options.intervalMs))
    ? Number(options.intervalMs)
    : 100;

  let timer = null;
  let lastSeenUsageKey = "";

  function buildUsageKey(state) {
    if (!state || typeof state !== "object") {
      return "";
    }

    const latestError = state.latestError;
    if (latestError && latestError.code === "usage_limit_exceeded") {
      return [
        "error",
        latestError.code,
        latestError.timestamp || "",
        state.latestUserMessage || "",
      ].join(":");
    }

    if (state.rateLimits) {
      return [
        "rate_limits",
        state.rateLimits.limitId || "",
        state.rateLimits.primary ? state.rateLimits.primary.resetsAt : "",
        state.rateLimits.secondary ? state.rateLimits.secondary.resetsAt : "",
        state.rateLimits.credits ? state.rateLimits.credits.balance : "",
        state.latestUserMessage || "",
      ].join(":");
    }

    return "";
  }

  function poll() {
    const sessionState = readSessionState();
    if (!isSessionStateUsageLimitExceeded(sessionState)) {
      return;
    }

    const usageKey = buildUsageKey(sessionState);
    if (!usageKey || usageKey === lastSeenUsageKey) {
      return;
    }

    lastSeenUsageKey = usageKey;
    onUsageLimitExceeded({
      prompt: sessionState.latestUserMessage || "",
      sessionState,
    });
  }

  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(poll, Math.max(1, intervalMs));
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  createSessionObserver,
};
