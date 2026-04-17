#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCodexWrapper } = require("../lib/cdx/wrapper");

let pty;
try {
  pty = require("node-pty");
} catch (err) {
  process.stderr.write(`cdx: failed to load node-pty (${err.message}). Run \`npm.cmd install\` in this repo.\n`);
  process.exit(1);
}

const cdxInternal = require("./cdx.js")._internal;
const {
  listSessionFilesRecursive,
  findMatchingSessionFile,
  findSessionFileById,
  readLatestSessionStateFromSessionFileAfterSize,
  readLatestUserMessageFromSessionFile,
} = require("../lib/ccx/session-log");
const {
  sleep,
  waitForTruthyValue,
  waitForChildExit,
} = require("../lib/ccx/runtime");
const {
  chooseFallbackAccount,
  shouldAttemptFallbackAccount,
} = require("../lib/ccx/fallback");
const {
  extractResumeSessionId,
  extractVisiblePromptDraft,
} = require("../lib/ccx/prompt-state");
const {
  applyInputChunk,
  chunkRequestsAbort,
  chunkRequestsEscape,
  getForwardingChunks,
  hasDraftText,
} = require("../lib/ccx/input-buffer");
const {
  createPrefillController,
} = require("../lib/ccx/prefill");
const {
  createOutputPipeline,
} = require("../lib/ccx/output-pipeline");
const {
  formatHighlightedUserPrompt,
} = require("../lib/ccx/output-style");
const {
  formatSwitchingBanner,
  formatDecisionBanner,
  formatFailureBanner,
} = require("../lib/ccx/status-ui");
const {
  restoreTerminalState,
} = require("../lib/ccx/terminal-state");
const {
  formatStartupBanner,
} = require("../lib/ccx/startup-ui");
const {
  hasActionableStructuredSessionState,
  createSessionObserver,
} = require("../lib/ccx/session-observer");
const {
  ensureCurrentAuthRegistered,
} = require("../lib/ccx/current-account");

const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME_DIR, "sessions");
const TARGET_AUTH = path.join(CODEX_HOME_DIR, "auth.json");
const CDX_STATE_DIR = path.join(os.homedir(), ".cdx");
const CCX_DEBUG_LOG = path.join(CDX_STATE_DIR, "ccx.log");
const DISCOVERY_INTERVAL_MS = 250;
const DISCOVERY_TIMEOUT_MS = 30_000;
const SESSION_ID_WAIT_TIMEOUT_MS = 30_000;
const OUTPUT_BUFFER_MAX_CHARS = 16_000;

function hasOutputUsageLimitMessage(outputBuffer) {
  const text = stripAnsi(outputBuffer).toLowerCase();
  return (
    text.includes("you've hit your usage limit") ||
    text.includes("you have hit your usage limit") ||
    (text.includes("usage limit") && text.includes("try again at")) ||
    (text.includes("purchase more credits") && text.includes("settings/usage"))
  );
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
    fs.appendFileSync(CCX_DEBUG_LOG, `${line}\n`, "utf8");
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
  return {
    ptyProcess: null,
    outputTransformer: null,
    draftBuffer: "",
    lastSubmittedPrompt: "",
    outputBuffer: "",
    switching: false,
    sessionId: "",
    sessionFilePath: "",
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: false,
    sessionObserver: null,
    launchNonce: 0,
    shuttingDown: false,
  };
}

function processInputChunkForState(state, data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const escapeRequested = chunkRequestsEscape(text);
  const inputState = applyInputChunk(state.draftBuffer, text);
  const submittedPrompt = inputState.submitted && hasDraftText(inputState.draft)
    ? String(inputState.draft || "")
    : "";

  state.draftBuffer = (escapeRequested || inputState.submitted) ? "" : inputState.draft;
  if (escapeRequested && state.outputTransformer && typeof state.outputTransformer.reset === "function") {
    state.outputTransformer.reset();
    state.outputBuffer = "";
  } else if (submittedPrompt) {
    state.outputBuffer = "";
  }

  return {
    text,
    escapeRequested,
    submittedPrompt,
    forwardingChunks: getForwardingChunks(text),
  };
}

function captureDeferredSessionStateBaselineForState(state) {
  if (!state || typeof state !== "object" || !state.sessionFilePath || state.sessionStateBaselinePendingDiscovery !== true) {
    return 0;
  }
  try {
    state.sessionStateBaselineSize = fs.statSync(state.sessionFilePath).size;
    state.sessionStateBaselinePendingDiscovery = false;
    return state.sessionStateBaselineSize;
  } catch (_) {
    state.sessionStateBaselineSize = 0;
    return 0;
  }
}

function captureSessionStateBaselineForState(state) {
  if (!state || typeof state !== "object") {
    return 0;
  }
  if (!state.sessionFilePath) {
    state.sessionStateBaselineSize = 0;
    state.sessionStateBaselinePendingDiscovery = true;
    return 0;
  }
  state.sessionStateBaselinePendingDiscovery = true;
  return captureDeferredSessionStateBaselineForState(state);
}

function readCurrentSessionStateForState(state) {
  if (!state || typeof state !== "object" || !state.sessionFilePath) {
    return null;
  }

  captureDeferredSessionStateBaselineForState(state);

  try {
    return readLatestSessionStateFromSessionFileAfterSize(
      state.sessionFilePath,
      state.sessionStateBaselineSize,
    );
  } catch (_) {
    return null;
  }
}

function readOutputUsageLimitBridgeForState(state) {
  if (!state || typeof state !== "object" || !hasOutputUsageLimitMessage(state.outputBuffer)) {
    return null;
  }

  return {
    prompt: state.lastSubmittedPrompt || "",
    source: "output",
    message: "You've hit your usage limit.",
  };
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
  return Boolean(
    state &&
    typeof state === "object" &&
    !state.switching &&
    !state.shuttingDown &&
    (state.sessionId || state.sessionFilePath)
  );
}

function shouldHandleUsageLimitEventForState(state, eventOrPrompt = "") {
  const canonicalPrompt = typeof eventOrPrompt === "string"
    ? eventOrPrompt
    : resolveUsageLimitPromptForState(state, eventOrPrompt);

  return Boolean(
    state &&
    typeof state === "object" &&
    !state.switching &&
    !state.shuttingDown &&
    canonicalPrompt
  );
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

  if (!state || typeof state !== "object" || !state.sessionFilePath) {
    return "";
  }

  try {
    return readLatestUserMessageFromSessionFile(state.sessionFilePath) || "";
  } catch (_) {
    return "";
  }
}

async function main({ forwardedArgs }) {
  requireTTY();
  writeStatusLine(formatStartupBanner());
  const bootstrap = ensureCurrentAuthRegistered({
    cdxInternal,
    currentAuthPath: TARGET_AUTH,
  });
  if (bootstrap.message) {
    writeStatusLine(`[CDX] ${bootstrap.message}`);
  }

  const state = createSupervisor();

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
    if (state.sessionId) {
      return;
    }
    const resumeSessionId = extractResumeSessionId(state.outputBuffer);
    if (!resumeSessionId) {
      return;
    }
    state.sessionId = resumeSessionId;
    writeDebugLog("session_id_from_output", { sessionId: resumeSessionId });
    ensureSessionObserverRunning();
  }

  function applyObservedSessionIdentity(sessionIdentity = {}) {
    const nextSessionId = typeof sessionIdentity.sessionId === "string" ? sessionIdentity.sessionId : "";
    const nextSessionFilePath = typeof sessionIdentity.sessionFilePath === "string" ? sessionIdentity.sessionFilePath : "";
    const sessionFilePathChanged = !!nextSessionFilePath && nextSessionFilePath !== state.sessionFilePath;

    if (nextSessionId) {
      state.sessionId = nextSessionId;
    }
    if (nextSessionFilePath) {
      state.sessionFilePath = nextSessionFilePath;
    }

    if (sessionFilePathChanged) {
      captureSessionStateBaselineForState(state);
    }

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
      source: event && event.source ? event.source : "session",
    });

    await reopenWithSmartSwitch(canonicalPrompt);
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
      hasStructuredSessionSignal: hasActionableStructuredSessionState,
      onSessionStateObserved: (sessionState) => {
        syncObservedSessionStateForState(state, sessionState);
      },
      readOutputUsageLimitBridge: () => readOutputUsageLimitBridgeForState(state),
      onUsageLimitExceeded: (event) => {
        syncObservedSessionStateForState(state, event && event.sessionState);
        const pendingPrompt = resolveUsageLimitPromptForState(state, event);
        writeDebugLog("usage_watch_completed", {
          matched: true,
          cancelled: false,
          sessionId: state.sessionId,
          sessionFilePath: state.sessionFilePath,
          pendingPrompt,
        });
        if (!shouldHandleUsageLimitEventForState(state, pendingPrompt)) {
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
      intervalMs: 100,
    });
    state.sessionObserver = observer;
    observer.start();
  }

  async function launchCodex(args, options = {}) {
    const startedAtMs = Date.now();
    state.launchNonce += 1;
    const currentLaunchNonce = state.launchNonce;
    state.sessionId = "";
    state.sessionFilePath = "";
    state.sessionStateBaselineSize = 0;
    state.sessionStateBaselinePendingDiscovery = false;
    state.outputBuffer = "";
    cancelUsageLimitWatch();
    const prefillText = typeof options.prefillText === "string" ? options.prefillText : "";
    const autoSubmitPrefill = options.autoSubmitPrefill === true;
    const onAutoSubmitted = typeof options.onAutoSubmitted === "function" ? options.onAutoSubmitted : null;
    const existingSessionFiles = listSessionFilesRecursive(SESSIONS_DIR);
    writeDebugLog("launch_codex", {
      args,
      existingSessionFileCount: existingSessionFiles.length,
    });

    const spec = cdxInternal.getCodexLaunchSpec(args);
    const child = pty.spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: { ...process.env },
      name: process.env.TERM || "xterm-color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });

    state.ptyProcess = child;
    const outputTransformer = createOutputPipeline({ enableFooterBadge: true });
    state.outputTransformer = outputTransformer;
    const prefillController = createPrefillController({
      prefillText,
      autoSubmit: autoSubmitPrefill,
    });
    const canAutoSubmitPrefill = () => {
      if (!autoSubmitPrefill) {
        return true;
      }
      const visiblePrompt = extractVisiblePromptDraft(state.outputBuffer);
      return visiblePrompt === prefillText;
    };
    let outputPrefillTimer = null;
    let fallbackPrefillTimer = null;
    const schedulePrefill = () => {
      if (!prefillText || outputPrefillTimer) {
        return;
      }
      outputPrefillTimer = setTimeout(() => {
        outputPrefillTimer = null;
        prefillController.run(
          (chunk) => child.write(chunk),
          () => state.ptyProcess === child,
          (submittedPrompt) => {
            writeDebugLog("prefill_autosubmitted", {
              sessionId: state.sessionId,
              sessionFilePath: state.sessionFilePath,
              submittedPrompt,
            });
            if (onAutoSubmitted) {
              onAutoSubmitted(submittedPrompt);
            }
          },
          canAutoSubmitPrefill,
        );
      }, 250);
    };
    child.onData((data) => {
      process.stdout.write(outputTransformer.transform(data));
      state.outputBuffer = updateOutputBuffer(state.outputBuffer, data);
      updateSessionIdentityFromOutput();
      schedulePrefill();
    });
    child.onExit(({ exitCode }) => {
      const wasSwitching = state.switching;
      if (outputPrefillTimer) {
        clearTimeout(outputPrefillTimer);
      }
      if (fallbackPrefillTimer) {
        clearTimeout(fallbackPrefillTimer);
      }
      prefillController.clear();
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
    if (prefillText) {
      fallbackPrefillTimer = setTimeout(() => {
        fallbackPrefillTimer = null;
        prefillController.run(
          (chunk) => child.write(chunk),
          () => state.ptyProcess === child,
          (submittedPrompt) => {
            writeDebugLog("prefill_autosubmitted", {
              sessionId: state.sessionId,
              sessionFilePath: state.sessionFilePath,
              submittedPrompt,
            });
            if (onAutoSubmitted) {
              onAutoSubmitted(submittedPrompt);
            }
          },
          canAutoSubmitPrefill,
        );
      }, 1500);
    }

    const launchToken = { cancelled: false };
    if (Array.isArray(args) && args[0] === "resume" && typeof args[1] === "string" && args[1]) {
      const resumedSession = findSessionFileById({
        sessionsDir: SESSIONS_DIR,
        sessionId: args[1],
      });
      if (resumedSession) {
        applyObservedSessionIdentity({
          sessionId: resumedSession.id,
          sessionFilePath: resumedSession.filePath,
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
        });
      })
      .catch(() => {});

    return () => {
      launchToken.cancelled = true;
    };
  }

  async function reopenWithSmartSwitch(pendingPrompt) {
    if (state.switching) {
      return;
    }

    state.switching = true;
    cancelUsageLimitWatch();

    const sessionIdentity = state.sessionId
      ? { sessionId: state.sessionId, sessionFilePath: state.sessionFilePath }
      : await waitForTruthyValue(
        () => (
          (updateSessionIdentityFromOutput(), state.sessionId)
            ? { sessionId: state.sessionId, sessionFilePath: state.sessionFilePath }
            : null
        ),
        { timeoutMs: SESSION_ID_WAIT_TIMEOUT_MS, intervalMs: 100 },
      );

    if (!sessionIdentity) {
      state.switching = false;
      writeDebugLog("smart_switch_skipped_no_session", {});
      writeStatusLine(formatFailureBanner("Session id not available after waiting, skipping smart switch guard."));
      return;
    }

    writeDebugLog("smart_switch_started", {
      sessionId: sessionIdentity.sessionId,
      sessionFilePath: sessionIdentity.sessionFilePath,
      pendingPrompt,
    });

    const canonicalPrompt = resolveUsageLimitPromptForState(state, { prompt: pendingPrompt });

    const previousSessionId = sessionIdentity.sessionId;
    if (state.ptyProcess) {
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
    }

    writeStatusLine(formatSwitchingBanner());

    let result;
    try {
      result = await runLocalCdxSmartSwitchJson();
    } catch (err) {
      writeDebugLog("smart_switch_runtime_error", {
        sessionId: sessionIdentity.sessionId,
        message: err.message || String(err),
      });
      writeStatusLine(formatFailureBanner(`Smart switch failed: ${err.message || String(err)}`));
      await launchCodex(["resume", previousSessionId], {
        prefillText: canonicalPrompt,
      });
      state.switching = false;
      return;
    }

    if (!result || !result.ok) {
      const fallbackTarget = shouldAttemptFallbackAccount(result)
        ? chooseFallbackAccount(cdxInternal.readAccounts(), result && result.from ? result.from : cdxInternal.getActive())
        : "";
      writeDebugLog("smart_switch_result", {
        ok: !!(result && result.ok),
        reason: result && result.reason ? result.reason : "",
        from: result && result.from ? result.from : "",
        to: result && result.to ? result.to : "",
        fallbackTarget,
      });
      if (fallbackTarget) {
        try {
          const message = cdxInternal.opUse(fallbackTarget);
          result = {
            ok: true,
            switched: true,
            alreadyOptimal: false,
            allExhausted: false,
            from: result && result.from ? result.from : "",
            to: fallbackTarget,
            reason: "fallback",
            activeStatus: result ? result.activeStatus : null,
            recommendedStatus: result ? result.recommendedStatus : null,
            message,
          };
          writeDebugLog("smart_switch_fallback_applied", {
            from: result.from,
            to: fallbackTarget,
          });
        } catch (err) {
          writeDebugLog("smart_switch_fallback_failed", {
            target: fallbackTarget,
            message: err.message || String(err),
          });
        }
      }
    }

    if (!result || !result.ok) {
      writeStatusLine(formatDecisionBanner(result));
      await launchCodex(["resume", previousSessionId], {
        prefillText: canonicalPrompt,
      });
      state.switching = false;
      return;
    }

    writeDebugLog("smart_switch_result", {
      ok: true,
      reason: result.reason || "",
      from: result.from || "",
      to: result.to || "",
    });
    writeStatusLine(formatDecisionBanner(result));
    await sleep(150);
    if (result.recommendedStatus && result.recommendedStatus.lowCredits) {
      writeStatusLine(
        `[CDX] Warning: smart switch selected a low-credit account (${result.recommendedStatus.credits ? result.recommendedStatus.credits.balance : "?"}).`,
      );
    }

    state.draftBuffer = "";
    await launchCodex(["resume", previousSessionId], {
      prefillText: canonicalPrompt,
      autoSubmitPrefill: true,
      onAutoSubmitted: (submittedPrompt) => {
        state.draftBuffer = "";
        state.outputBuffer = "";
        writeStatusLine(formatHighlightedUserPrompt(submittedPrompt));
      },
    });
    state.switching = false;
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
    hasOutputUsageLimitMessage,
    processInputChunkForState,
    captureSessionStateBaselineForState,
    captureDeferredSessionStateBaselineForState,
    readCurrentSessionStateForState,
    readOutputUsageLimitBridgeForState,
    syncObservedSessionStateForState,
    shouldArmSessionObserverForState,
    shouldHandleUsageLimitEventForState,
    resolveUsageLimitPromptForState,
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
