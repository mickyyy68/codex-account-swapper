"use strict";

const {
  isSessionStateUsageLimitExceeded,
  hasUsageLimitMessageText,
  isUsageLimitErrorCode,
} = require("./session-log");

const DEFAULT_LIVE_FALLBACK_INTERVAL_MS = 90_000;

function coerceNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildLiveFallbackSessionState(status) {
  if (!status || status.available !== true) {
    return null;
  }

  const primaryRemaining = status.primary ? coerceNumber(status.primary.remainingPercent, 100) : 100;
  const secondaryRemaining = status.secondary ? coerceNumber(status.secondary.remainingPercent, 100) : 100;
  const credits = status.credits && typeof status.credits === "object" ? status.credits : null;
  const creditsBalance = credits && typeof credits.balance === "string" ? credits.balance : "";
  const creditsNumeric = credits ? Number.parseFloat(creditsBalance) : NaN;
  const creditsDepleted = !!(credits && credits.hasCredits === true && credits.unlimited !== true && Number.isFinite(creditsNumeric) && creditsNumeric <= 0);
  const primaryDepleted = primaryRemaining <= 0;
  const secondaryDepleted = secondaryRemaining <= 0;

  if (!primaryDepleted && !secondaryDepleted && !creditsDepleted) {
    return null;
  }

  return {
    rateLimits: {
      limitId: "live_fallback",
      planType: status.planType || "",
      primary: status.primary
        ? {
            usedPercent: Math.max(0, Math.min(100, 100 - primaryRemaining)),
            windowMinutes: 0,
            resetsAt: coerceNumber(status.primary.resetAtSeconds, 0),
          }
        : null,
      secondary: status.secondary
        ? {
            usedPercent: Math.max(0, Math.min(100, 100 - secondaryRemaining)),
            windowMinutes: 0,
            resetsAt: coerceNumber(status.secondary.resetAtSeconds, 0),
          }
        : null,
      credits: credits
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance: creditsBalance,
          }
        : null,
    },
    latestError: null,
    latestUserMessage: "",
    source: "live_fallback",
  };
}

function createSessionObserver(options = {}) {
  const readSessionState = typeof options.readSessionState === "function"
    ? options.readSessionState
    : () => null;
  const onSessionStateObserved = typeof options.onSessionStateObserved === "function"
    ? options.onSessionStateObserved
    : () => {};
  const onUsageLimitExceeded = typeof options.onUsageLimitExceeded === "function"
    ? options.onUsageLimitExceeded
    : () => {};
  const onDebug = typeof options.onDebug === "function" ? options.onDebug : null;
  const intervalMs = Number.isFinite(Number(options.intervalMs))
    ? Number(options.intervalMs)
    : 100;
  const getActiveAccountAuthPath = typeof options.getActiveAccountAuthPath === "function"
    ? options.getActiveAccountAuthPath
    : null;
  const fetchLiveRateLimitStatus = typeof options.fetchLiveRateLimitStatus === "function"
    ? options.fetchLiveRateLimitStatus
    : null;
  const liveFallbackIntervalMs = Number.isFinite(Number(options.liveFallbackIntervalMs))
    ? Number(options.liveFallbackIntervalMs)
    : DEFAULT_LIVE_FALLBACK_INTERVAL_MS;
  const liveFallbackEnabled = !!(getActiveAccountAuthPath && fetchLiveRateLimitStatus && liveFallbackIntervalMs > 0);

  let timer = null;
  let liveTimer = null;
  let liveCheckInFlight = false;
  let lastSeenUsageKey = "";
  let lastObservedSnapshotSignature = "";
  let stopped = false;

  function emitDebug(event, fields) {
    if (!onDebug) {
      return;
    }
    try {
      onDebug(event, fields || {});
    } catch (_) {
      // ignore logger failures
    }
  }

  function buildUsageKey(state) {
    if (!state || typeof state !== "object") {
      return "";
    }

    const latestError = state.latestError;
    if (latestError && isUsageLimitErrorCode(latestError.code)) {
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

  function buildSnapshotSignature(state) {
    if (!state || typeof state !== "object") {
      return "";
    }
    const errorCode = state.latestError && state.latestError.code ? state.latestError.code : "";
    const errorTs = state.latestError && state.latestError.timestamp ? state.latestError.timestamp : "";
    const errorHead = state.latestError && state.latestError.message
      ? String(state.latestError.message).slice(0, 120)
      : "";
    const primaryUsed = state.rateLimits && state.rateLimits.primary ? state.rateLimits.primary.usedPercent : "";
    const secondaryUsed = state.rateLimits && state.rateLimits.secondary ? state.rateLimits.secondary.usedPercent : "";
    const creditsBalance = state.rateLimits && state.rateLimits.credits ? state.rateLimits.credits.balance : "";
    return [errorCode, errorTs, errorHead, primaryUsed, secondaryUsed, creditsBalance].join("|");
  }

  function maybeLogSnapshot(sessionState, triggered) {
    if (!onDebug || !sessionState) {
      return;
    }
    const signature = buildSnapshotSignature(sessionState);
    if (!signature || signature === lastObservedSnapshotSignature) {
      return;
    }
    lastObservedSnapshotSignature = signature;
    emitDebug("session_state_snapshot", {
      source: sessionState.source || "jsonl",
      triggered,
      errorCode: sessionState.latestError ? sessionState.latestError.code || "" : "",
      errorMessageHead: sessionState.latestError && sessionState.latestError.message
        ? String(sessionState.latestError.message).slice(0, 200)
        : "",
      primaryUsedPercent: sessionState.rateLimits && sessionState.rateLimits.primary
        ? sessionState.rateLimits.primary.usedPercent
        : null,
      secondaryUsedPercent: sessionState.rateLimits && sessionState.rateLimits.secondary
        ? sessionState.rateLimits.secondary.usedPercent
        : null,
      creditsBalance: sessionState.rateLimits && sessionState.rateLimits.credits
        ? sessionState.rateLimits.credits.balance
        : null,
    });
  }

  function fireUsageLimit(sessionState, source) {
    const usageKey = buildUsageKey(sessionState);
    if (!usageKey || usageKey === lastSeenUsageKey) {
      return false;
    }
    lastSeenUsageKey = usageKey;
    emitDebug("usage_watch_fired", { source, usageKey });
    onUsageLimitExceeded({
      prompt: sessionState.latestUserMessage || "",
      sessionState,
      source,
    });
    return true;
  }

  function poll() {
    const sessionState = readSessionState();
    if (sessionState && typeof sessionState === "object") {
      onSessionStateObserved(sessionState);
    }
    const triggered = isSessionStateUsageLimitExceeded(sessionState);
    maybeLogSnapshot(sessionState, triggered);
    if (triggered) {
      fireUsageLimit(sessionState, "session");
    }
  }

  async function liveFallbackTick() {
    if (liveCheckInFlight || stopped) {
      return;
    }
    let authPath;
    try {
      authPath = getActiveAccountAuthPath();
    } catch (err) {
      emitDebug("live_fallback_resolve_error", { message: err && err.message ? err.message : String(err) });
      return;
    }
    if (!authPath) {
      return;
    }

    liveCheckInFlight = true;
    try {
      const status = await fetchLiveRateLimitStatus(authPath);
      if (stopped) {
        return;
      }
      emitDebug("live_fallback_check", {
        authPath,
        available: !!(status && status.available),
        errorCode: status && status.errorCode ? status.errorCode : "",
        primaryRemaining: status && status.primary ? status.primary.remainingPercent : null,
        secondaryRemaining: status && status.secondary ? status.secondary.remainingPercent : null,
        creditsBalance: status && status.credits ? status.credits.balance : null,
      });
      const synthetic = buildLiveFallbackSessionState(status);
      if (synthetic) {
        emitDebug("live_fallback_exhausted", { authPath });
        fireUsageLimit(synthetic, "live_fallback");
      }
    } catch (err) {
      emitDebug("live_fallback_error", { message: err && err.message ? err.message : String(err) });
    } finally {
      liveCheckInFlight = false;
    }
  }

  return {
    start() {
      if (timer || stopped) {
        return;
      }
      timer = setInterval(poll, Math.max(1, intervalMs));
      if (liveFallbackEnabled) {
        liveTimer = setInterval(() => {
          liveFallbackTick();
        }, Math.max(1_000, liveFallbackIntervalMs));
      }
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    },
  };
}

module.exports = {
  createSessionObserver,
  buildLiveFallbackSessionState,
  DEFAULT_LIVE_FALLBACK_INTERVAL_MS,
};
