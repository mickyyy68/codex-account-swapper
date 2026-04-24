"use strict";

function resolveResumeVerificationOutcome(options = {}) {
  const expectedSessionId = typeof options.expectedSessionId === "string"
    ? options.expectedSessionId
    : "";
  const confirmedSessionId = typeof options.confirmedSessionId === "string"
    ? options.confirmedSessionId
    : "";
  const outputSeen = options.outputSeen === true;
  const processAlive = options.processAlive === true;
  const firstOutputAtMs = Number(options.firstOutputAtMs) || 0;
  const stableDelayMs = Number(options.stableDelayMs) || 0;
  const nowMs = Number(options.nowMs) || 0;

  if (!expectedSessionId || !outputSeen || !processAlive || !firstOutputAtMs) {
    return null;
  }

  if (nowMs - firstOutputAtMs < stableDelayMs) {
    return null;
  }

  if (!confirmedSessionId) {
    return {
      matched: true,
      source: "output",
    };
  }

  return {
    matched: confirmedSessionId === expectedSessionId,
    source: "output+sessionId",
  };
}

module.exports = {
  resolveResumeVerificationOutcome,
};
