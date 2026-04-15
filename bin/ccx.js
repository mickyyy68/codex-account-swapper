#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pty;
try {
  pty = require("node-pty");
} catch (err) {
  process.stderr.write(`ccx: failed to load node-pty (${err.message}). Run \`npm.cmd install\` in this repo.\n`);
  process.exit(1);
}

const cdxInternal = require("./cdx.js")._internal;
const {
  listSessionFilesRecursive,
  findMatchingSessionFile,
  readLatestSessionStateFromSessionFile,
  readLatestUserMessageFromSessionFile,
  isSessionStateUsageLimitExceeded,
} = require("../lib/ccx/session-log");
const {
  sleep,
  waitForPredicate,
  waitForTruthyValue,
  waitForChildExit,
} = require("../lib/ccx/runtime");
const {
  chooseFallbackAccount,
} = require("../lib/ccx/fallback");
const {
  resolvePendingPrompt,
  extractResumeSessionId,
  extractVisiblePromptDraft,
} = require("../lib/ccx/prompt-state");
const {
  applyInputChunk,
  chunkRequestsAbort,
  hasDraftText,
} = require("../lib/ccx/input-buffer");
const {
  createPrefillController,
} = require("../lib/ccx/prefill");
const {
  highlightUserPromptLines,
  createUserPromptOutputTransformer,
} = require("../lib/ccx/output-style");
const {
  formatSwitchingBanner,
  formatDecisionBanner,
  formatFailureBanner,
} = require("../lib/ccx/status-ui");
const {
  restoreTerminalState,
} = require("../lib/ccx/terminal-state");

const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME_DIR, "sessions");
const CDX_STATE_DIR = path.join(os.homedir(), ".cdx");
const CCX_DEBUG_LOG = path.join(CDX_STATE_DIR, "ccx.log");
const DISCOVERY_INTERVAL_MS = 250;
const DISCOVERY_TIMEOUT_MS = 30_000;
const SESSION_ID_WAIT_TIMEOUT_MS = 30_000;
const OUTPUT_BUFFER_MAX_CHARS = 16_000;

function die(message) {
  process.stderr.write(`ccx: ${message}\n`);
  process.exit(1);
}

function requireTTY() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die("interactive terminal required. Run `ccx` in a TTY.");
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

function outputLooksLikeUsageLimit(buffer) {
  const text = String(buffer || "").toLowerCase();
  return (
    text.includes("you've hit your usage limit") ||
    text.includes("you have hit your usage limit") ||
    (text.includes("usage limit") && text.includes("try again at")) ||
    (text.includes("purchase more credits") && text.includes("settings/usage"))
  );
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
    draftBuffer: "",
    lastSubmittedPrompt: "",
    outputBuffer: "",
    switching: false,
    sessionId: "",
    sessionFilePath: "",
    launchNonce: 0,
    usageLimitWatchNonce: 0,
    shuttingDown: false,
  };
}

async function main() {
  requireTTY();

  const forwardedArgs = process.argv.slice(2);
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
    state.usageLimitWatchNonce += 1;
  }

  function readCurrentSessionState() {
    if (!state.sessionFilePath) {
      return null;
    }
    try {
      return readLatestSessionStateFromSessionFile(state.sessionFilePath);
    } catch (_) {
      return null;
    }
  }

  function getCanonicalSubmittedPrompt(fallbackPrompt) {
    if (!state.sessionFilePath) {
      return fallbackPrompt;
    }
    try {
      const latestUserMessage = readLatestUserMessageFromSessionFile(state.sessionFilePath);
      return latestUserMessage || fallbackPrompt;
    } catch (_) {
      return fallbackPrompt;
    }
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
  }

  function armUsageLimitWatch(pendingPrompt) {
    cancelUsageLimitWatch();
    const watchNonce = state.usageLimitWatchNonce;
    writeDebugLog("usage_watch_armed", {
      sessionId: state.sessionId,
      sessionFilePath: state.sessionFilePath,
      pendingPrompt,
    });

    waitForPredicate(
      () => ({
        sessionState: readCurrentSessionState(),
        outputFallbackMatched: !state.sessionFilePath && outputLooksLikeUsageLimit(state.outputBuffer),
      }),
      {
        timeoutMs: 6000,
        intervalMs: 100,
        predicate: (snapshot) => {
          if (!snapshot || typeof snapshot !== "object") {
            return false;
          }
          return snapshot.outputFallbackMatched || isSessionStateUsageLimitExceeded(snapshot.sessionState);
        },
        stopWhen: () => (
          state.switching ||
          state.shuttingDown ||
          watchNonce !== state.usageLimitWatchNonce ||
          state.lastSubmittedPrompt !== pendingPrompt
        ),
      },
    ).then((result) => {
      writeDebugLog("usage_watch_completed", {
        matched: result.matched,
        cancelled: result.cancelled,
        sessionId: state.sessionId,
        sessionFilePath: state.sessionFilePath,
        pendingPrompt,
      });
      if (!result.matched || state.switching || state.lastSubmittedPrompt !== pendingPrompt) {
        return;
      }
      state.lastSubmittedPrompt = "";
      writeDebugLog("usage_watch_triggered", {
        sessionId: state.sessionId,
        sessionFilePath: state.sessionFilePath,
        pendingPrompt,
      });
      return reopenWithSmartSwitch(pendingPrompt);
    }).catch((err) => {
      writeDebugLog("usage_watch_error", { message: err.message || String(err) });
      cleanup();
      die(err.message || String(err));
    });
  }

  async function launchCodex(args, options = {}) {
    const startedAtMs = Date.now();
    state.launchNonce += 1;
    const currentLaunchNonce = state.launchNonce;
    state.sessionId = "";
    state.sessionFilePath = "";
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
    const outputTransformer = createUserPromptOutputTransformer();
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
    discoverSessionFile(process.cwd(), startedAtMs, launchToken, existingSessionFiles)
      .then((match) => {
        if (!match || currentLaunchNonce !== state.launchNonce) {
          return;
        }
        state.sessionId = match.id;
        state.sessionFilePath = match.filePath;
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

    const canonicalPrompt = getCanonicalSubmittedPrompt(pendingPrompt);

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
      const fallbackTarget = chooseFallbackAccount(cdxInternal.readAccounts(), result && result.from ? result.from : cdxInternal.getActive());
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
        `[ccx] Warning: smart switch selected a low-credit account (${result.recommendedStatus.credits ? result.recommendedStatus.credits.balance : "?"}).`,
      );
    }

    state.draftBuffer = "";
    await launchCodex(["resume", previousSessionId], {
      prefillText: canonicalPrompt,
      autoSubmitPrefill: true,
      onAutoSubmitted: (submittedPrompt) => {
        state.lastSubmittedPrompt = submittedPrompt;
        state.draftBuffer = "";
        state.outputBuffer = "";
        armUsageLimitWatch(submittedPrompt);
      },
    });
    state.switching = false;
  }

  async function maybeHandleEnter(text, pendingPrompt) {
    if (state.ptyProcess) {
      state.lastSubmittedPrompt = pendingPrompt;
      state.draftBuffer = "";
      state.ptyProcess.write(text);
      armUsageLimitWatch(pendingPrompt);
    }
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
    const inputState = applyInputChunk(state.draftBuffer, text);
    state.draftBuffer = inputState.draft;

    if (inputState.submitted) {
      const pendingPrompt = resolvePendingPrompt(state.draftBuffer, state.outputBuffer);
      writeDebugLog("input_submit", {
        pendingPrompt,
        draftBuffer: state.draftBuffer,
      });
      if (!pendingPrompt) {
        state.ptyProcess.write(text);
        return;
      }
      try {
        await maybeHandleEnter(text, pendingPrompt);
      } catch (err) {
        cleanup();
        die(err.message || String(err));
      }
      return;
    }

    state.ptyProcess.write(text);
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

main().catch((err) => {
  die(err.message || String(err));
});
