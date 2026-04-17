"use strict";

const {
  isSessionStateUsageLimitExceeded,
  hasUsageLimitMessageText,
} = require("./session-log");

function hasActionableStructuredSessionState(sessionState) {
  if (!sessionState || typeof sessionState !== "object") {
    return false;
  }

  if (sessionState.latestError) {
    return true;
  }

  if (sessionState.rateLimits) {
    return true;
  }

  return typeof sessionState.latestUserMessage === "string"
    ? sessionState.latestUserMessage.trim().length > 0
    : Boolean(sessionState.latestUserMessage);
}

function createSessionObserver(options = {}) {
  const readSessionState = typeof options.readSessionState === "function"
    ? options.readSessionState
    : () => null;
  const hasStructuredSessionSignal = typeof options.hasStructuredSessionSignal === "function"
    ? options.hasStructuredSessionSignal
    : () => false;
  const readOutputUsageLimitBridge = typeof options.readOutputUsageLimitBridge === "function"
    ? options.readOutputUsageLimitBridge
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

    if (latestError && hasUsageLimitMessageText(latestError.message)) {
      return [
        "error_text",
        latestError.message || "",
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

  function buildOutputUsageKey(event) {
    if (!event || typeof event !== "object") {
      return "";
    }
    return [
      "output",
      event.prompt || "",
      event.message || "",
    ].join(":");
  }

  function poll() {
    const sessionState = readSessionState();
    if (isSessionStateUsageLimitExceeded(sessionState)) {
      const usageKey = buildUsageKey(sessionState);
      if (!usageKey || usageKey === lastSeenUsageKey) {
        return;
      }

      lastSeenUsageKey = usageKey;
      onUsageLimitExceeded({
        prompt: sessionState.latestUserMessage || "",
        sessionState,
      });
      return;
    }

    if (hasStructuredSessionSignal(sessionState)) {
      return;
    }

    const outputBridgeEvent = readOutputUsageLimitBridge();
    const usageKey = buildOutputUsageKey(outputBridgeEvent);
    if (!usageKey || usageKey === lastSeenUsageKey) {
      return;
    }

    lastSeenUsageKey = usageKey;
    onUsageLimitExceeded({
      prompt: outputBridgeEvent.prompt || "",
      source: outputBridgeEvent.source || "output",
      message: outputBridgeEvent.message || "",
      sessionState: null,
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
  hasActionableStructuredSessionState,
  createSessionObserver,
};
