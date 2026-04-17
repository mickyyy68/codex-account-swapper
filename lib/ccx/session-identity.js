"use strict";

function createSessionIdentityTracker() {
  const state = {
    sessionId: "",
    sessionFilePath: "",
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: false,
  };

  return {
    getState() {
      return { ...state };
    },
    markAwaitingDiscovery() {
      state.sessionId = "";
      state.sessionFilePath = "";
      state.sessionStateBaselineSize = 0;
      state.sessionStateBaselinePendingDiscovery = true;
    },
    setSessionId(sessionId) {
      state.sessionId = sessionId;
    },
    attachDiscoveredSession({ sessionId, sessionFilePath, preserveDiscoveredTail }) {
      state.sessionId = sessionId;
      state.sessionFilePath = sessionFilePath;
      state.sessionStateBaselineSize = preserveDiscoveredTail ? 0 : 0;
      state.sessionStateBaselinePendingDiscovery = false;
    },
    attachResumedSession({ sessionId, sessionFilePath, currentSize }) {
      state.sessionId = sessionId;
      state.sessionFilePath = sessionFilePath;
      state.sessionStateBaselineSize = Number(currentSize) || 0;
      state.sessionStateBaselinePendingDiscovery = false;
    },
    hasCanonicalIdentity() {
      return Boolean(state.sessionId && state.sessionFilePath);
    },
  };
}

module.exports = {
  createSessionIdentityTracker,
};
