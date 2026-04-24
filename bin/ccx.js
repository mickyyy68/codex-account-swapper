#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCodexWrapper } = require("../lib/cdx/wrapper");

const cdxInternal = require("./cdx.js")._internal;
const {
  listSessionFilesRecursive,
  findMatchingSessionFile,
  findSessionFileById,
  readLatestSessionStateFromSessionFileAfterSize,
} = require("../lib/ccx/session-log");
const {
  sleep,
  waitForTruthyValue,
  waitForChildExit,
} = require("../lib/ccx/runtime");
const {
  extractResumeSessionId,
} = require("../lib/ccx/prompt-state");
const {
  applyInputChunk,
  chunkRequestsAbort,
  chunkRequestsEscape,
  getForwardingChunks,
  hasDraftText,
} = require("../lib/ccx/input-buffer");
const {
  createOutputPipeline,
} = require("../lib/ccx/output-pipeline");
const {
  formatSwitchingBanner,
  formatDecisionBanner,
  formatInfoBanner,
} = require("../lib/ccx/status-ui");
const {
  restoreTerminalState,
} = require("../lib/ccx/terminal-state");
const {
  formatStartupBanner,
} = require("../lib/ccx/startup-ui");
const {
  createSessionObserver,
} = require("../lib/ccx/session-observer");
const {
  ensureCurrentAuthRegistered,
} = require("../lib/ccx/current-account");
const {
  createSessionIdentityTracker,
} = require("../lib/ccx/session-identity");
const {
  createSwitchOrchestrator,
} = require("../lib/ccx/switch-orchestrator");
const {
  resolveResumeVerificationOutcome,
} = require("../lib/ccx/resume-verification");

const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME_DIR, "sessions");
const TARGET_AUTH = path.join(CODEX_HOME_DIR, "auth.json");
const CDX_STATE_DIR = path.join(os.homedir(), ".cdx");
const CDX_DEBUG_LOG = path.join(CDX_STATE_DIR, "cdx.log");
const DISCOVERY_INTERVAL_MS = 250;
const DISCOVERY_TIMEOUT_MS = 30_000;
const SESSION_ID_WAIT_TIMEOUT_MS = 30_000;
const OUTPUT_BUFFER_MAX_CHARS = 16_000;
const RESUME_OUTPUT_STABLE_DELAY_MS = 300;
const DEFAULT_LIVE_FALLBACK_INTERVAL_MS = 90_000;
const MIN_LIVE_FALLBACK_INTERVAL_MS = 15_000;

function resolveLiveFallbackIntervalMs() {
  const raw = process.env.CDX_LIVE_FALLBACK_INTERVAL_MS;
  if (raw === undefined) {
    return DEFAULT_LIVE_FALLBACK_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(MIN_LIVE_FALLBACK_INTERVAL_MS, parsed);
}

const CODEX_FLAGS_WITH_VALUE = new Set([
  "-a",
  "--ask-for-approval",
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-C",
  "--cd",
  "--output-last-message",
  "--output-schema",
  "-i",
  "--image",
  "-s",
  "--sandbox",
  "--oss",
]);

function findResumeSessionIdArg(args) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== "string") {
      continue;
    }
    if (token === "resume") {
      const next = args[index + 1];
      return typeof next === "string" ? next : "";
    }
    if (CODEX_FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (/^(?:-[a-zA-Z]|--[a-zA-Z][\w-]*)=/.test(token)) {
      continue;
    }
  }
  return "";
}

function extractAccessModeArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== "string") {
      continue;
    }
    if (token === "-s" || token === "--sandbox" || token === "-a" || token === "--ask-for-approval") {
      result.push(token);
      const next = args[index + 1];
      if (typeof next === "string") {
        result.push(next);
        index += 1;
      }
      continue;
    }
    if (/^--sandbox=.+$/.test(token) || /^--ask-for-approval=.+$/.test(token)) {
      result.push(token);
      continue;
    }
    if (/^-s.+$/.test(token) || /^-a.+$/.test(token)) {
      result.push(token);
      continue;
    }
  }
  return result;
}

function resolveActiveAccountAuthPath() {
  try {
    const activeName = cdxInternal.getActive();
    if (!activeName) {
      return "";
    }
    const accounts = cdxInternal.readAccounts();
    const entry = accounts.find((account) => account.name === activeName);
    return entry && typeof entry.path === "string" ? entry.path : "";
  } catch (_) {
    return "";
  }
}
let cachedPtyModule = null;

function loadPtyRuntimeModule() {
  if (cachedPtyModule) {
    return cachedPtyModule;
  }
  try {
    cachedPtyModule = require("node-pty");
    return cachedPtyModule;
  } catch (err) {
    die(`failed to load node-pty (${err.message}). Run \`npm.cmd install\` in this repo.`);
  }
}

function die(message) {
  process.stderr.write(`cdx: ${message}\n`);
  process.exit(1);
}

function requireTTY() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die("interactive terminal required. Run `cdx` in a TTY.");
  }
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function updateOutputBuffer(buffer, chunk) {
  const next = `${String(buffer || "")}${stripAnsi(chunk)}`;
  return next.length > OUTPUT_BUFFER_MAX_CHARS
    ? next.slice(-OUTPUT_BUFFER_MAX_CHARS)
    : next;
}

function writeDebugLog(event, fields = {}) {
  try {
    fs.mkdirSync(CDX_STATE_DIR, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      ...fields,
    });
    fs.appendFileSync(CDX_DEBUG_LOG, `${line}\n`, "utf8");
  } catch (_) {
    // ignore logging failures
  }
}

function writeStatusLine(message) {
  process.stdout.write(`\r\n${message}\r\n`);
}

async function runLocalCdxSmartSwitchJson() {
  if (!cdxInternal || typeof cdxInternal.runSmartSwitchOperation !== "function") {
    throw new Error("cdx smart-switch runtime is unavailable.");
  }
  return cdxInternal.runSmartSwitchOperation({ forceRefreshLiveLimits: true });
}

async function discoverSessionFile(cwd, startedAtMs, launchNonceRef, excludedFilePaths = []) {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (launchNonceRef.cancelled) {
      return null;
    }
    const match = findMatchingSessionFile({
      sessionsDir: SESSIONS_DIR,
      cwd,
      startedAtMs,
      excludedFilePaths,
    });
    if (match) {
      writeDebugLog("session_discovered", { sessionId: match.id, sessionFilePath: match.filePath });
      return match;
    }
    await sleep(DISCOVERY_INTERVAL_MS);
  }
  return null;
}

function createSupervisor() {
  const identityTracker = createSessionIdentityTracker();
  const identityState = identityTracker.getState();
  return {
    ptyProcess: null,
    outputTransformer: null,
    draftBuffer: "",
    lastSubmittedPrompt: "",
    outputBuffer: "",
    switching: false,
    sessionId: identityState.sessionId,
    sessionFilePath: identityState.sessionFilePath,
    sessionStateBaselineSize: identityState.sessionStateBaselineSize,
    sessionStateBaselinePendingDiscovery: identityState.sessionStateBaselinePendingDiscovery,
    sessionStatePreserveDiscoveredTail: false,
    resumeVerificationExpectedSessionId: "",
    resumeVerificationConfirmedSessionId: "",
    resumeVerificationOutputSeen: false,
    resumeVerificationFirstOutputAtMs: 0,
    sessionIdentityTracker: identityTracker,
    sessionObserver: null,
    launchNonce: 0,
    shuttingDown: false,
    initialAccessModeArgs: [],
  };
}

function syncSessionIdentityState(state) {
  if (!state || typeof state !== "object" || !state.sessionIdentityTracker) {
    return state;
  }
  const identityState = state.sessionIdentityTracker.getState();
  state.sessionId = identityState.sessionId;
  state.sessionFilePath = identityState.sessionFilePath;
  state.sessionStateBaselineSize = identityState.sessionStateBaselineSize;
  state.sessionStateBaselinePendingDiscovery = identityState.sessionStateBaselinePendingDiscovery;
  return state;
}

function getCanonicalSessionIdentityState(state) {
  if (!state || typeof state !== "object") {
    return {
      sessionId: "",
      sessionFilePath: "",
      sessionStateBaselineSize: 0,
      sessionStateBaselinePendingDiscovery: false,
    };
  }
  if (state.sessionIdentityTracker) {
    return state.sessionIdentityTracker.getState();
  }
  return {
    sessionId: state.sessionId || "",
    sessionFilePath: state.sessionFilePath || "",
    sessionStateBaselineSize: Number(state.sessionStateBaselineSize) || 0,
    sessionStateBaselinePendingDiscovery: state.sessionStateBaselinePendingDiscovery === true,
  };
}

function resolveSessionIdentityForState(state) {
  const identityState = getCanonicalSessionIdentityState(state);
  if (!identityState.sessionId && !identityState.sessionFilePath) {
    return null;
  }
  return {
    sessionId: identityState.sessionId || "",
    sessionFilePath: identityState.sessionFilePath || "",
  };
}

function resetResumeVerificationState(state) {
  if (!state || typeof state !== "object") {
    return;
  }

  state.resumeVerificationExpectedSessionId = "";
  state.resumeVerificationConfirmedSessionId = "";
  state.resumeVerificationOutputSeen = false;
  state.resumeVerificationFirstOutputAtMs = 0;
}

function ensureSessionIdentityTracker(state, options = {}) {
  if (!state || typeof state !== "object") {
    return null;
  }
  const syncFromTracker = options.syncFromTracker !== false;
  if (!state.sessionIdentityTracker) {
    const tracker = createSessionIdentityTracker();
    let shouldSync = false;
    if (state.sessionStateBaselinePendingDiscovery === true) {
      tracker.markAwaitingDiscovery();
    } else if (state.sessionId || state.sessionFilePath || state.sessionStateBaselineSize) {
      tracker.attachResumedSession({
        sessionId: state.sessionId || "",
        sessionFilePath: state.sessionFilePath || "",
        currentSize: state.sessionStateBaselineSize || 0,
      });
      shouldSync = true;
    }
    state.sessionIdentityTracker = tracker;
    if (shouldSync) {
      syncSessionIdentityState(state);
    }
    return state.sessionIdentityTracker;
  }
  if (syncFromTracker) {
    syncSessionIdentityState(state);
  }
  return state.sessionIdentityTracker;
}

function findFirstSubmitBoundaryIndex(text) {
  for (let index = 1; index <= text.length; index += 1) {
    if (applyInputChunk("", text.slice(0, index)).submitted) {
      return index;
    }
  }
  return -1;
}

function reduceInputChunkState(initialDraft, text) {
  let draft = String(initialDraft || "");
  let submittedPrompt = "";
  let sawSubmitBoundary = false;
  let remaining = String(text || "");

  while (remaining) {
    const boundaryIndex = findFirstSubmitBoundaryIndex(remaining);
    if (boundaryIndex < 0) {
      draft = applyInputChunk(draft, remaining).draft;
      break;
    }

    const boundaryState = applyInputChunk(draft, remaining.slice(0, boundaryIndex));
    if (!sawSubmitBoundary && hasDraftText(boundaryState.draft)) {
      submittedPrompt = String(boundaryState.draft || "");
    }

    sawSubmitBoundary = true;
    draft = "";
    remaining = remaining.slice(boundaryIndex);
  }

  return {
    draft,
    submittedPrompt,
    submitted: sawSubmitBoundary,
  };
}

function processInputChunkForState(state, data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const escapeRequested = chunkRequestsEscape(text);
  const chunkState = reduceInputChunkState(state.draftBuffer, text);

  if (escapeRequested) {
    state.draftBuffer = "";
  } else if (chunkState.submitted) {
    state.draftBuffer = chunkState.draft;
  } else {
    state.draftBuffer = chunkState.draft;
  }

  if (escapeRequested && state.outputTransformer && typeof state.outputTransformer.reset === "function") {
    state.outputTransformer.reset();
    state.outputBuffer = "";
  } else if (chunkState.submittedPrompt) {
    state.lastSubmittedPrompt = "";
    state.outputBuffer = "";
  }

  return {
    text,
    escapeRequested,
    submittedPrompt: chunkState.submittedPrompt,
    forwardingChunks: getForwardingChunks(text),
  };
}

function captureDeferredSessionStateBaselineForState(state) {
  const tracker = ensureSessionIdentityTracker(state, { syncFromTracker: false });
  const identityState = getCanonicalSessionIdentityState(state);
  const sessionFilePath = identityState.sessionFilePath || state.sessionFilePath || "";
  if (!tracker || !sessionFilePath || identityState.sessionStateBaselinePendingDiscovery !== true) {
    return 0;
  }
  try {
    if (state.sessionStatePreserveDiscoveredTail === true) {
      tracker.attachDiscoveredSessionIdentity({
        sessionId: identityState.sessionId || "",
        sessionFilePath,
      });
    } else {
      tracker.attachResumedSession({
        sessionId: identityState.sessionId || "",
        sessionFilePath,
        currentSize: fs.statSync(sessionFilePath).size,
      });
    }
    state.sessionStatePreserveDiscoveredTail = false;
    syncSessionIdentityState(state);
    return state.sessionStateBaselineSize;
  } catch (_) {
    tracker.attachDiscoveredSessionIdentity({
      sessionId: identityState.sessionId || "",
      sessionFilePath,
    });
    state.sessionStatePreserveDiscoveredTail = false;
    syncSessionIdentityState(state);
    return 0;
  }
}

function captureSessionStateBaselineForState(state, options = {}) {
  const tracker = ensureSessionIdentityTracker(state, { syncFromTracker: false });
  if (!tracker) {
    return 0;
  }
  const identityState = tracker.getState();
  const preserveDiscoveredTail = options && options.preserveDiscoveredTail === true;
  const sessionFilePath = identityState.sessionFilePath || state.sessionFilePath || "";
  if (!sessionFilePath) {
    tracker.markAwaitingDiscovery();
    syncSessionIdentityState(state);
    state.sessionStatePreserveDiscoveredTail = preserveDiscoveredTail;
    return 0;
  }
  if (preserveDiscoveredTail) {
    tracker.attachDiscoveredSessionIdentity({
      sessionId: identityState.sessionId || "",
      sessionFilePath,
    });
    syncSessionIdentityState(state);
    state.sessionStatePreserveDiscoveredTail = false;
    return state.sessionStateBaselineSize;
  }
  try {
    tracker.attachResumedSession({
      sessionId: identityState.sessionId || "",
      sessionFilePath,
      currentSize: fs.statSync(sessionFilePath).size,
    });
    syncSessionIdentityState(state);
    state.sessionStatePreserveDiscoveredTail = false;
    return state.sessionStateBaselineSize;
  } catch (_) {
    tracker.markAwaitingDiscovery();
    syncSessionIdentityState(state);
    state.sessionStatePreserveDiscoveredTail = preserveDiscoveredTail;
    return 0;
  }
}

function readCurrentSessionStateForState(state) {
  const identityState = getCanonicalSessionIdentityState(state);
  if (!state || typeof state !== "object" || !identityState.sessionFilePath) {
    return null;
  }

  captureDeferredSessionStateBaselineForState(state);

  try {
    return readLatestSessionStateFromSessionFileAfterSize(
      identityState.sessionFilePath,
      state.sessionStateBaselineSize,
    );
  } catch (_) {
    return null;
  }
}

function syncObservedSessionStateForState(state, sessionState) {
  if (!state || typeof state !== "object" || !sessionState || typeof sessionState !== "object") {
    return false;
  }

  if (typeof sessionState.latestUserMessage !== "string" || !sessionState.latestUserMessage) {
    return false;
  }

  state.lastSubmittedPrompt = sessionState.latestUserMessage;
  return true;
}

function shouldArmSessionObserverForState(state) {
  const sessionIdentity = resolveSessionIdentityForState(state);
  return Boolean(
    state &&
    typeof state === "object" &&
    !state.switching &&
    !state.shuttingDown &&
    sessionIdentity
  );
}

function applyObservedSessionIdentityForState(state, sessionIdentity = {}) {
  const tracker = ensureSessionIdentityTracker(state, { syncFromTracker: false });
  const currentIdentity = getCanonicalSessionIdentityState(state);
  const nextSessionId = typeof sessionIdentity.sessionId === "string" ? sessionIdentity.sessionId : "";
  const nextSessionFilePath = typeof sessionIdentity.sessionFilePath === "string" ? sessionIdentity.sessionFilePath : "";
  const preserveDiscoveredTail = sessionIdentity.preserveDiscoveredTail === true;
  const resolvedSessionFilePath = nextSessionFilePath || currentIdentity.sessionFilePath || "";
  const sessionFilePathChanged = !!resolvedSessionFilePath && resolvedSessionFilePath !== currentIdentity.sessionFilePath;

  if (tracker && nextSessionId && !sessionFilePathChanged) {
    tracker.setSessionId(nextSessionId);
  }
  if (tracker && nextSessionFilePath && !sessionFilePathChanged && nextSessionFilePath !== currentIdentity.sessionFilePath) {
    tracker.setSessionFilePath(nextSessionFilePath);
  }
  if (tracker && sessionFilePathChanged) {
    if (preserveDiscoveredTail) {
      tracker.attachDiscoveredSessionIdentity({
        sessionId: nextSessionId || currentIdentity.sessionId || "",
        sessionFilePath: resolvedSessionFilePath,
      });
    } else {
      let currentSize = currentIdentity.sessionStateBaselineSize || 0;
      try {
        currentSize = fs.statSync(resolvedSessionFilePath).size;
      } catch (_) {
        currentSize = currentIdentity.sessionStateBaselineSize || 0;
      }
      tracker.attachResumedSession({
        sessionId: nextSessionId || currentIdentity.sessionId || "",
        sessionFilePath: resolvedSessionFilePath,
        currentSize,
      });
    }
  }
  syncSessionIdentityState(state);
  if (sessionFilePathChanged) {
    captureSessionStateBaselineForState(state, { preserveDiscoveredTail });
  }
  return resolveSessionIdentityForState(state);
}

function diagnoseUsageLimitSkipReason(state) {
  if (!state || typeof state !== "object") {
    return "invalid_state";
  }
  if (state.shuttingDown === true) {
    return "shutting_down";
  }
  if (state.switching === true) {
    return "already_switching";
  }
  const sessionIdentity = resolveSessionIdentityForState(state);
  if (!sessionIdentity) {
    return "no_session_identity";
  }
  if (!sessionIdentity.sessionId) {
    return "no_session_id";
  }
  if (!sessionIdentity.sessionFilePath) {
    return "no_session_file_path";
  }
  return "unknown";
}

function shouldHandleUsageLimitEventForState(state, eventOrPrompt = "") {
  const sessionIdentity = resolveSessionIdentityForState(state);

  return Boolean(
    state &&
    typeof state === "object" &&
    !state.switching &&
    !state.shuttingDown &&
    sessionIdentity &&
    sessionIdentity.sessionId &&
    sessionIdentity.sessionFilePath
  );
}

function releaseSwitchingStateForState(state, onReleased = null) {
  if (!state || typeof state !== "object") {
    return false;
  }

  state.switching = false;
  if (typeof onReleased === "function") {
    onReleased();
  }
  return true;
}

function resolveUsageLimitPromptForState(state, event) {
  const observedPrompt = event && typeof event.prompt === "string" ? event.prompt : "";
  if (observedPrompt) {
    return observedPrompt;
  }

  const cachedPrompt = state && typeof state.lastSubmittedPrompt === "string"
    ? state.lastSubmittedPrompt
    : "";
  if (cachedPrompt) {
    return cachedPrompt;
  }

  return "";
}

async function main({ forwardedArgs }) {
  requireTTY();
  writeStatusLine(formatStartupBanner());
  const bootstrap = ensureCurrentAuthRegistered({
    cdxInternal,
    currentAuthPath: TARGET_AUTH,
  });
  if (bootstrap.message) {
    writeStatusLine(formatInfoBanner(bootstrap.message));
  }

  const state = createSupervisor();
  state.initialAccessModeArgs = extractAccessModeArgs(forwardedArgs);

  function cleanup() {
    if (state.shuttingDown) {
      return;
    }
    state.shuttingDown = true;
    process.stdin.removeListener("data", onInput);
    if (process.stdout && typeof process.stdout.removeListener === "function") {
      process.stdout.removeListener("resize", onResize);
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    restoreTerminalState(process.stdout);
    process.stdin.pause();
    if (state.ptyProcess) {
      try {
        state.ptyProcess.kill();
      } catch (_) {
        // ignore
      }
      state.ptyProcess = null;
    }
    if (state.sessionObserver) {
      state.sessionObserver.stop();
      state.sessionObserver = null;
    }
  }

  function onResize() {
    if (!state.ptyProcess || !process.stdout) {
      return;
    }
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    try {
      state.ptyProcess.resize(columns, rows);
    } catch (_) {
      // ignore
    }
  }

  function cancelUsageLimitWatch() {
    if (state.sessionObserver) {
      state.sessionObserver.stop();
      state.sessionObserver = null;
    }
  }

  function readCurrentSessionState() {
    return readCurrentSessionStateForState(state);
  }

  function updateSessionIdentityFromOutput() {
    const tracker = ensureSessionIdentityTracker(state, { syncFromTracker: false });
    const identityState = getCanonicalSessionIdentityState(state);
    const awaitingRuntimeResumeConfirmation = Boolean(
      state.resumeVerificationExpectedSessionId &&
      !state.resumeVerificationConfirmedSessionId
    );
    if (identityState && identityState.sessionId && !awaitingRuntimeResumeConfirmation) {
      return;
    }
    const resumeSessionId = extractResumeSessionId(state.outputBuffer);
    if (!resumeSessionId) {
      return;
    }
    if (tracker) {
      tracker.setSessionId(resumeSessionId);
      syncSessionIdentityState(state);
    } else {
      state.sessionId = resumeSessionId;
    }
    if (state.resumeVerificationExpectedSessionId) {
      state.resumeVerificationConfirmedSessionId = resumeSessionId;
    }
    writeDebugLog("session_id_from_output", { sessionId: resumeSessionId });
    ensureSessionObserverRunning();
  }

  function applyObservedSessionIdentity(sessionIdentity = {}) {
    applyObservedSessionIdentityForState(state, sessionIdentity);
    ensureSessionObserverRunning();
  }

  async function handleUsageLimitExceeded(event) {
    const canonicalPrompt = resolveUsageLimitPromptForState(state, event);

    state.lastSubmittedPrompt = "";
    writeDebugLog("usage_watch_triggered", {
      sessionId: state.sessionId,
      sessionFilePath: state.sessionFilePath,
      observedPrompt: event && typeof event.prompt === "string" ? event.prompt : "",
      canonicalPrompt,
      source: "session",
    });

    await reopenWithSmartSwitch();
  }

  function ensureSessionObserverRunning() {
    if (!shouldArmSessionObserverForState(state) || state.sessionObserver) {
      return;
    }

    writeDebugLog("usage_watch_armed", {
      sessionId: state.sessionId,
      sessionFilePath: state.sessionFilePath,
      pendingPrompt: state.lastSubmittedPrompt,
    });

    const observer = createSessionObserver({
      readSessionState: readCurrentSessionState,
      onSessionStateObserved: (sessionState) => {
        syncObservedSessionStateForState(state, sessionState);
      },
      onUsageLimitExceeded: (event) => {
        syncObservedSessionStateForState(state, event && event.sessionState);
        const pendingPrompt = resolveUsageLimitPromptForState(state, event);
        const source = event && event.source ? event.source : "session";
        writeDebugLog("usage_watch_completed", {
          matched: true,
          cancelled: false,
          sessionId: state.sessionId,
          sessionFilePath: state.sessionFilePath,
          pendingPrompt,
          source,
        });
        if (!shouldHandleUsageLimitEventForState(state, pendingPrompt)) {
          writeDebugLog("usage_watch_skipped", {
            source,
            reason: diagnoseUsageLimitSkipReason(state),
            sessionId: state.sessionId,
            sessionFilePath: state.sessionFilePath,
            switching: state.switching === true,
            shuttingDown: state.shuttingDown === true,
          });
          return;
        }
        observer.stop();
        if (state.sessionObserver === observer) {
          state.sessionObserver = null;
        }
        Promise.resolve(handleUsageLimitExceeded({
          ...event,
          prompt: pendingPrompt,
        })).catch((err) => {
          writeDebugLog("usage_watch_error", { message: err.message || String(err) });
          cleanup();
          die(err.message || String(err));
        });
      },
      onDebug: writeDebugLog,
      intervalMs: 100,
      getActiveAccountAuthPath: resolveActiveAccountAuthPath,
      fetchLiveRateLimitStatus: (authPath) => cdxInternal.getLiveRateLimitStatus(authPath, { forceRefresh: true }),
      liveFallbackIntervalMs: resolveLiveFallbackIntervalMs(),
    });
    state.sessionObserver = observer;
    observer.start();
  }

  async function launchCodex(args) {
    const startedAtMs = Date.now();
    state.launchNonce += 1;
    const currentLaunchNonce = state.launchNonce;
    resetResumeVerificationState(state);
    ensureSessionIdentityTracker(state, { syncFromTracker: false });
    state.sessionIdentityTracker.markAwaitingDiscovery();
    syncSessionIdentityState(state);
    state.sessionStatePreserveDiscoveredTail = false;
    state.outputBuffer = "";
    cancelUsageLimitWatch();
    const existingSessionFiles = listSessionFilesRecursive(SESSIONS_DIR);
    writeDebugLog("launch_codex", {
      args,
      existingSessionFileCount: existingSessionFiles.length,
    });

    const spec = cdxInternal.getCodexLaunchSpec(args);
    const pty = loadPtyRuntimeModule();
    const child = pty.spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: { ...process.env },
      name: process.env.TERM || "xterm-color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });

    state.ptyProcess = child;
    const outputTransformer = createOutputPipeline();
    state.outputTransformer = outputTransformer;
    child.onData((data) => {
      process.stdout.write(outputTransformer.transform(data));
      state.outputBuffer = updateOutputBuffer(state.outputBuffer, data);
      if (state.resumeVerificationExpectedSessionId) {
        if (!state.resumeVerificationOutputSeen) {
          state.resumeVerificationFirstOutputAtMs = Date.now();
        }
        state.resumeVerificationOutputSeen = true;
      }
      updateSessionIdentityFromOutput();
    });
    child.onExit(({ exitCode }) => {
      const wasSwitching = state.switching;
      const flushedOutput = outputTransformer.flush();
      if (flushedOutput) {
        process.stdout.write(flushedOutput);
      }
      if (state.outputTransformer === outputTransformer) {
        state.outputTransformer = null;
      }
      state.ptyProcess = null;
      if (wasSwitching || state.shuttingDown) {
        return;
      }
      cleanup();
      process.exit(typeof exitCode === "number" ? exitCode : 0);
    });

    const launchToken = { cancelled: false };
    const resumeSessionIdArg = findResumeSessionIdArg(args);
    if (resumeSessionIdArg) {
      state.resumeVerificationExpectedSessionId = resumeSessionIdArg;
      const resumedSession = findSessionFileById({
        sessionsDir: SESSIONS_DIR,
        sessionId: resumeSessionIdArg,
      });
      if (resumedSession) {
        applyObservedSessionIdentity({
          sessionId: resumedSession.id,
          sessionFilePath: resumedSession.filePath,
        });
        state.resumeVerificationConfirmedSessionId = resumedSession.id;
        writeDebugLog("resume_session_identity_attached", {
          sessionId: resumedSession.id,
          sessionFilePath: resumedSession.filePath,
        });
      } else {
        writeDebugLog("resume_session_file_not_found", {
          sessionId: resumeSessionIdArg,
        });
      }
    }
    discoverSessionFile(process.cwd(), startedAtMs, launchToken, existingSessionFiles)
      .then((match) => {
        if (!match || currentLaunchNonce !== state.launchNonce) {
          return;
        }
        applyObservedSessionIdentity({
          sessionId: match.id,
          sessionFilePath: match.filePath,
          preserveDiscoveredTail: true,
        });
      })
      .catch(() => {});

    return () => {
      launchToken.cancelled = true;
    };
  }

  async function reopenWithSmartSwitch() {
    if (state.switching) {
      return;
    }

    state.switching = true;
    state.draftBuffer = "";
    cancelUsageLimitWatch();

    const sessionIdentity = resolveSessionIdentityForState(state) || await waitForTruthyValue(
      () => {
        updateSessionIdentityFromOutput();
        return resolveSessionIdentityForState(state);
      },
      { timeoutMs: SESSION_ID_WAIT_TIMEOUT_MS, intervalMs: 100 },
    );

    if (!sessionIdentity) {
      throw new Error("canonical session identity is required before autoswitch");
    }

    writeDebugLog("smart_switch_started", {
      sessionId: sessionIdentity.sessionId,
      sessionFilePath: sessionIdentity.sessionFilePath,
    });

    writeStatusLine(formatSwitchingBanner());

    const orchestrator = createSwitchOrchestrator({
      closeSession: async () => {
        if (!state.ptyProcess) {
          return;
        }
        const childToClose = state.ptyProcess;
        try {
          childToClose.kill();
        } catch (_) {
          // ignore
        }
        await waitForChildExit(childToClose, { timeoutMs: 1500 });
        if (state.ptyProcess === childToClose) {
          state.ptyProcess = null;
        }
        restoreTerminalState(process.stdout);
      },
      runSmartSwitch: async () => {
        try {
          return await runLocalCdxSmartSwitchJson();
        } catch (err) {
          writeDebugLog("smart_switch_runtime_error", {
            sessionId: sessionIdentity.sessionId,
            message: err.message || String(err),
          });
          throw err;
        }
      },
      resumeSession: async (resumeSessionId) => {
        const accessModeArgs = Array.isArray(state.initialAccessModeArgs)
          ? state.initialAccessModeArgs
          : [];
        await launchCodex([...accessModeArgs, "resume", resumeSessionId]);
      },
      verifyResumedSession: async (expectedSessionId) => {
        const outcome = await waitForTruthyValue(
          () => {
            updateSessionIdentityFromOutput();
            return resolveResumeVerificationOutcome({
              expectedSessionId,
              confirmedSessionId: state.resumeVerificationConfirmedSessionId,
              outputSeen: state.resumeVerificationOutputSeen,
              firstOutputAtMs: state.resumeVerificationFirstOutputAtMs,
              nowMs: Date.now(),
              processAlive: Boolean(state.ptyProcess),
              stableDelayMs: RESUME_OUTPUT_STABLE_DELAY_MS,
            });
          },
          { timeoutMs: SESSION_ID_WAIT_TIMEOUT_MS, intervalMs: 100 },
        );
        if (!outcome || !outcome.matched) {
          return false;
        }
        const currentIdentity = resolveSessionIdentityForState(state) || {};
        applyObservedSessionIdentityForState(state, {
          sessionId: expectedSessionId,
          sessionFilePath: currentIdentity.sessionFilePath || sessionIdentity.sessionFilePath,
        });
        return true;
      },
    });

    const result = await orchestrator.handleExhaustion(sessionIdentity);

    writeDebugLog("smart_switch_result", {
      ok: true,
      reason: result.reason || "",
      from: result.from || "",
      to: result.to || "",
    });
    writeStatusLine(formatDecisionBanner(result));
    await sleep(150);
    if (result.recommendedStatus && result.recommendedStatus.lowCredits) {
      writeStatusLine(formatInfoBanner(
        `Warning: smart switch selected a low-credit account (${result.recommendedStatus.credits ? result.recommendedStatus.credits.balance : "?"}).`,
      ));
    }

    releaseSwitchingStateForState(state, ensureSessionObserverRunning);
  }

  async function onInput(data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (chunkRequestsAbort(text)) {
      writeDebugLog("interrupt_exit", {
        switching: state.switching,
        hasPty: !!state.ptyProcess,
      });
      cleanup();
      process.exit(130);
      return;
    }

    if (state.switching || !state.ptyProcess) {
      return;
    }

    writeDebugLog("input_chunk", {
      raw: JSON.stringify(text),
    });
    const {
      submittedPrompt,
      forwardingChunks,
    } = processInputChunkForState(state, data);

    if (submittedPrompt) {
      writeDebugLog("input_submit", {
        pendingPrompt: submittedPrompt,
        draftBuffer: submittedPrompt,
      });
    }

    for (const chunk of forwardingChunks) {
      state.ptyProcess.write(chunk);
    }
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("exit", () => {
    cleanup();
  });

  await launchCodex(forwardedArgs);
}

module.exports = {
  _internalMain: main,
  _internal: {
    processInputChunkForState,
    captureSessionStateBaselineForState,
    captureDeferredSessionStateBaselineForState,
    applyObservedSessionIdentityForState,
    readCurrentSessionStateForState,
    resolveSessionIdentityForState,
    syncObservedSessionStateForState,
    shouldArmSessionObserverForState,
    shouldHandleUsageLimitEventForState,
    releaseSwitchingStateForState,
    resolveUsageLimitPromptForState,
    findResumeSessionIdArg,
    extractAccessModeArgs,
    resolveActiveAccountAuthPath,
    resolveLiveFallbackIntervalMs,
    diagnoseUsageLimitSkipReason,
  },
};

if (require.main === module) {
  runCodexWrapper({
    argv: process.argv.slice(2),
    mainImpl: main,
  }).catch((err) => {
    die(err.message || String(err));
  });
}
