#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const {
  parseSessionMetaLine,
  parseTokenCountLine,
  parseSessionErrorLine,
  readSessionMeta,
  findMatchingSessionFile,
  readLatestRateLimitsFromSessionFile,
  readLatestSessionStateFromSessionFile,
  readLatestUserMessageFromSessionFile,
  isRateLimitsExhausted,
  isSessionStateUsageLimitExceeded,
} = require("../lib/ccx/session-log");
const {
  waitForTruthyValue,
  waitForPredicate,
  waitForUsageLimitSignal,
} = require("../lib/ccx/runtime");
const {
  chooseFallbackAccount,
} = require("../lib/ccx/fallback");
const {
  extractVisiblePromptDraft,
  resolvePendingPrompt,
  extractResumeSessionId,
} = require("../lib/ccx/prompt-state");
const {
  applyInputChunk,
  chunkRequestsAbort,
  chunkRequestsEscape,
  getForwardingChunks,
  getForwardingOverride,
  hasDraftText,
} = require("../lib/ccx/input-buffer");
const {
  formatSwitchingBanner,
  formatDecisionBanner,
  formatFailureBanner,
} = require("../lib/ccx/status-ui");
const {
  buildTerminalResetSequence,
} = require("../lib/ccx/terminal-state");
const {
  createPrefillController,
  PREFILL_AUTOSUBMIT_DELAY_MS,
} = require("../lib/ccx/prefill");
const {
  highlightUserPromptLines,
  createUserPromptOutputTransformer,
  ANSI_USER_PROMPT_BACKGROUND,
  ANSI_RESET_BACKGROUND,
  formatHighlightedUserPrompt,
} = require("../lib/ccx/output-style");
const {
  formatStartupBanner,
} = require("../lib/ccx/startup-ui");

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exit(1);
  }
}

function writeSessionFile(filePath, meta, lines = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = [
    JSON.stringify({
      timestamp: meta.loggedAt || meta.timestamp,
      type: "session_meta",
      payload: {
        id: meta.id,
        timestamp: meta.timestamp,
        cwd: meta.cwd,
        originator: "codex-tui",
      },
    }),
    ...lines,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, body, "utf8");
}

async function main() {
  await run("parses session meta lines", async () => {
    const parsed = parseSessionMetaLine(
      JSON.stringify({
        timestamp: "2026-04-15T16:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-123",
          timestamp: "2026-04-15T16:00:00.000Z",
          cwd: "C:\\repo",
        },
      }),
    );

    assert.deepEqual(parsed, {
      id: "sess-123",
      cwd: "C:\\repo",
      timestamp: "2026-04-15T16:00:00.000Z",
      cliVersion: "",
      filePath: "",
    });
  });

  await run("reads long session meta lines beyond the first 4KB", async () => {
    const sessionsRoot = mkTempDir("ccx-test-session-meta-long-");
    const sessionFile = path.join(sessionsRoot, "2026", "04", "15", "rollout.jsonl");
    const longText = "x".repeat(10 * 1024);

    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-15T17:08:09.906Z",
          type: "session_meta",
          payload: {
            id: "sess-long",
            timestamp: "2026-04-15T17:08:05.566Z",
            cwd: "C:\\Users\\filmd\\Documents\\codex-account-switcher",
            originator: "codex-tui",
            cli_version: "0.120.0",
            base_instructions: { text: longText },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const meta = readSessionMeta(sessionFile);
    assert.equal(meta.id, "sess-long");
    assert.equal(meta.cwd, "C:\\Users\\filmd\\Documents\\codex-account-switcher");
    assert.equal(meta.cliVersion, "0.120.0");
  });

  await run("parses token_count lines and detects exhaustion", async () => {
    const line = JSON.stringify({
      timestamp: "2026-04-15T16:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          plan_type: "plus",
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1776271935 },
          secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1776525708 },
          credits: null,
        },
      },
    });
    const parsed = parseTokenCountLine(line);

    assert.equal(parsed.rateLimits.planType, "plus");
    assert.equal(parsed.rateLimits.primary.usedPercent, 100);
    assert.equal(isRateLimitsExhausted(parsed.rateLimits), true);
  });

  await run("finds the matching session file by cwd and timestamp", async () => {
    const sessionsRoot = mkTempDir("ccx-test-sessions-");
    const targetCwd = "C:\\Users\\filmd\\Documents\\codex-account-switcher";
    const oldFile = path.join(sessionsRoot, "2026", "04", "14", "old.jsonl");
    const newFile = path.join(sessionsRoot, "2026", "04", "15", "new.jsonl");

    writeSessionFile(oldFile, {
      id: "sess-old",
      timestamp: "2026-04-15T12:00:00.000Z",
      cwd: targetCwd,
    });
    writeSessionFile(newFile, {
      id: "sess-new",
      timestamp: "2026-04-15T12:05:00.000Z",
      cwd: targetCwd,
    });

    const match = findMatchingSessionFile({
      sessionsDir: sessionsRoot,
      cwd: targetCwd,
      startedAtMs: Date.parse("2026-04-15T12:04:30.000Z"),
      slackMs: 0,
    });

    assert.equal(match.id, "sess-new");
    assert.equal(match.filePath, newFile);
  });

  await run("ignores known pre-launch session files when matching the current session", async () => {
    const sessionsRoot = mkTempDir("ccx-test-session-snapshot-");
    const targetCwd = "C:\\Users\\filmd\\Documents\\codex-account-switcher";
    const existingFile = path.join(sessionsRoot, "2026", "04", "15", "existing.jsonl");
    const launchedFile = path.join(sessionsRoot, "2026", "04", "15", "launched.jsonl");

    writeSessionFile(existingFile, {
      id: "sess-existing",
      timestamp: "2026-04-15T12:05:00.000Z",
      cwd: targetCwd,
    });
    writeSessionFile(launchedFile, {
      id: "sess-launched",
      timestamp: "2026-04-15T12:05:01.000Z",
      cwd: targetCwd,
    });

    const match = findMatchingSessionFile({
      sessionsDir: sessionsRoot,
      cwd: targetCwd,
      startedAtMs: Date.parse("2026-04-15T12:04:30.000Z"),
      slackMs: 0,
      excludedFilePaths: [existingFile],
    });

    assert.equal(match.id, "sess-launched");
    assert.equal(match.filePath, launchedFile);
  });

  await run("reads the latest token_count from a session file tail", async () => {
    const sessionsRoot = mkTempDir("ccx-test-session-tail-");
    const sessionFile = path.join(sessionsRoot, "2026", "04", "15", "rollout.jsonl");

    writeSessionFile(
      sessionFile,
      {
        id: "sess-tail",
        timestamp: "2026-04-15T12:05:00.000Z",
        cwd: "C:\\repo",
      },
      [
        JSON.stringify({
          timestamp: "2026-04-15T12:05:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 10, window_minutes: 300, resets_at: 1 },
              secondary: { used_percent: 20, window_minutes: 10080, resets_at: 2 },
              credits: null,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-15T12:05:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: { used_percent: 55, window_minutes: 300, resets_at: 3 },
              secondary: { used_percent: 60, window_minutes: 10080, resets_at: 4 },
              credits: { has_credits: true, unlimited: false, balance: "7" },
            },
          },
        }),
      ],
    );

    const rateLimits = readLatestRateLimitsFromSessionFile(sessionFile);
    assert.equal(rateLimits.primary.usedPercent, 55);
    assert.equal(rateLimits.secondary.usedPercent, 60);
    assert.deepEqual(rateLimits.credits, { hasCredits: true, unlimited: false, balance: "7" });
    assert.equal(isRateLimitsExhausted(rateLimits), false);
  });

  await run("parses structured usage-limit session errors", async () => {
    const parsed = parseSessionErrorLine(
      JSON.stringify({
        timestamp: "2026-04-15T16:14:02.232Z",
        type: "event_msg",
        payload: {
          type: "error",
          message: "You've hit your usage limit.",
          codex_error_info: "usage_limit_exceeded",
        },
      }),
    );

    assert.deepEqual(parsed, {
      timestamp: "2026-04-15T16:14:02.232Z",
      message: "You've hit your usage limit.",
      code: "usage_limit_exceeded",
    });
  });

  await run("reads usage-limit state from the latest session tail", async () => {
    const sessionsRoot = mkTempDir("ccx-test-session-state-");
    const sessionFile = path.join(sessionsRoot, "2026", "04", "15", "rollout.jsonl");

    writeSessionFile(
      sessionFile,
      {
        id: "sess-state",
        timestamp: "2026-04-15T16:13:57.632Z",
        cwd: "C:\\repo",
      },
      [
        JSON.stringify({
          timestamp: "2026-04-15T16:14:02.231Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              limit_id: "premium",
              primary: null,
              secondary: null,
              credits: { has_credits: false, unlimited: false, balance: "0" },
              plan_type: null,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-15T16:14:02.232Z",
          type: "event_msg",
          payload: {
            type: "error",
            message: "You've hit your usage limit. Try again later.",
            codex_error_info: "usage_limit_exceeded",
          },
        }),
      ],
    );

    const sessionState = readLatestSessionStateFromSessionFile(sessionFile);
    assert.equal(sessionState.rateLimits.limitId, "premium");
    assert.equal(sessionState.latestError.code, "usage_limit_exceeded");
    assert.equal(isSessionStateUsageLimitExceeded(sessionState), true);
  });

  await run("reads the latest submitted user prompt from a session file", async () => {
    const sessionsRoot = mkTempDir("ccx-test-user-message-");
    const sessionFile = path.join(sessionsRoot, "2026", "04", "15", "rollout.jsonl");

    writeSessionFile(
      sessionFile,
      {
        id: "sess-message",
        timestamp: "2026-04-15T16:13:57.632Z",
        cwd: "C:\\repo",
      },
      [
        JSON.stringify({
          timestamp: "2026-04-15T16:14:02.231Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "leggi questo progetto",
            images: [],
            local_images: [],
            text_elements: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-15T16:14:03.231Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Explain this codebase",
            images: [],
            local_images: [],
            text_elements: [],
          },
        }),
      ],
    );

    const message = readLatestUserMessageFromSessionFile(sessionFile);
    assert.equal(message, "Explain this codebase");
  });

  await run("waits for a late usage-limit signal from a polling source", async () => {
    let reads = 0;
    const result = await waitForPredicate(
      async () => {
        reads += 1;
        if (reads < 3) {
          return { latestError: null, rateLimits: null };
        }
        return {
          latestError: { code: "usage_limit_exceeded", message: "You've hit your usage limit." },
          rateLimits: null,
        };
      },
      {
        timeoutMs: 200,
        intervalMs: 10,
        predicate: isSessionStateUsageLimitExceeded,
      },
    );

    assert.equal(result.matched, true);
    assert.ok(reads >= 3);
    assert.equal(result.value.latestError.code, "usage_limit_exceeded");
  });

  await run("waits briefly for a late session id to become available", async () => {
    let reads = 0;
    const result = await waitForTruthyValue(
      async () => {
        reads += 1;
        return reads >= 3 ? { sessionId: "sess-late", sessionFilePath: "C:\\session.jsonl" } : null;
      },
      { timeoutMs: 200, intervalMs: 10 },
    );

    assert.deepEqual(result, { sessionId: "sess-late", sessionFilePath: "C:\\session.jsonl" });
    assert.ok(reads >= 3);
  });

  await run("waits for a late usage-limit signal after a long discovery delay", async () => {
    let reads = 0;
    const result = await waitForUsageLimitSignal(
      async () => {
        reads += 1;
        if (reads < 10) {
          return { sessionState: null, outputFallbackMatched: false };
        }
        return {
          sessionState: { latestError: { code: "usage_limit_exceeded" } },
          outputFallbackMatched: false,
        };
      },
      {
        timeoutMs: 200,
        intervalMs: 5,
        isMatch: (snapshot) => Boolean(
          snapshot &&
          (
            snapshot.outputFallbackMatched ||
            (snapshot.sessionState && snapshot.sessionState.latestError && snapshot.sessionState.latestError.code === "usage_limit_exceeded")
          )
        ),
      },
    );

    assert.equal(result.matched, true);
    assert.ok(reads >= 10);
  });

  await run("chooses a pinned fallback account before other eligible accounts", async () => {
    const account = chooseFallbackAccount([
      { name: "1" },
      { name: "2", pinned: true },
      { name: "3" },
    ], "1");

    assert.equal(account, "2");
  });

  await run("skips excluded and active accounts when choosing a fallback account", async () => {
    const account = chooseFallbackAccount([
      { name: "1" },
      { name: "2", excludedFromRecommendation: true },
      { name: "3" },
    ], "1");

    assert.equal(account, "3");
  });

  await run("tracks draft input with append, backspace, and submit", async () => {
    let state = applyInputChunk("", "hel");
    assert.deepEqual(state, { draft: "hel", submitted: false, changed: true });

    state = applyInputChunk(state.draft, "lo");
    assert.deepEqual(state, { draft: "hello", submitted: false, changed: true });

    state = applyInputChunk(state.draft, "\b");
    assert.deepEqual(state, { draft: "hell", submitted: false, changed: true });

    state = applyInputChunk(state.draft, "\r");
    assert.deepEqual(state, { draft: "hell", submitted: true, changed: false });
    assert.equal(hasDraftText(state.draft), true);
  });

  await run("ignores terminal navigation escape sequences in the draft buffer", async () => {
    const state = applyInputChunk("hello", "\u001b[D");
    assert.deepEqual(state, { draft: "hello", submitted: false, changed: false });
  });

  await run("captures bracketed paste content instead of discarding it", async () => {
    const state = applyInputChunk("", "\u001b[200~leggi il progetto\u001b[201~");
    assert.deepEqual(state, { draft: "leggi il progetto", submitted: false, changed: true });
  });

  await run("keeps text and submit when ANSI wrappers share the same chunk", async () => {
    const state = applyInputChunk("", "\u001b[200~leggi il progetto\u001b[201~\r");
    assert.deepEqual(state, { draft: "leggi il progetto", submitted: true, changed: true });
  });

  await run("treats SS3 keypad enter as submit instead of dropping it", async () => {
    const state = applyInputChunk("leggi il progetto", "\u001bOM");
    assert.deepEqual(state, { draft: "leggi il progetto", submitted: true, changed: false });
  });

  await run("strips generic CSI wrappers while preserving following text", async () => {
    const state = applyInputChunk("", "\u001b[?25hleggi il progetto");
    assert.deepEqual(state, { draft: "leggi il progetto", submitted: false, changed: true });
  });

  await run("parses win32-input-mode enter as submit on key-down only", async () => {
    const state = applyInputChunk("leggi il progetto", "\u001b[13;28;13;1;0;1_\u001b[13;28;13;0;0;1_");
    assert.deepEqual(state, { draft: "leggi il progetto", submitted: true, changed: false });
  });

  await run("parses win32-input-mode text input from unicode char field", async () => {
    const state = applyInputChunk("", "\u001b[76;38;108;1;0;1_\u001b[76;38;108;0;0;1_");
    assert.deepEqual(state, { draft: "l", submitted: false, changed: true });
  });

  await run("treats win32 ctrl+w as delete previous word", async () => {
    const state = applyInputChunk(
      "ci",
      "\u001b[17;29;0;1;8;1_\u001b[87;17;23;1;8;1_\u001b[87;17;23;0;8;1_\u001b[17;29;0;0;0;1_",
    );
    assert.deepEqual(state, { draft: "", submitted: false, changed: true });
  });

  await run("detects ctrl+c as an abort request", async () => {
    assert.equal(chunkRequestsAbort("\u0003"), true);
    assert.equal(
      chunkRequestsAbort("\u001b[67;46;3;1;8;1_\u001b[67;46;3;0;8;1_"),
      true,
    );
    assert.equal(chunkRequestsAbort("leggi il progetto"), false);
  });

  await run("detects escape as a local draft-reset control without treating it as abort", async () => {
    assert.equal(
      chunkRequestsEscape("\u001b[27;1;0;1;0;1_\u001b[27;1;0;0;0;1_"),
      true,
    );
    assert.equal(chunkRequestsAbort("\u001b[27;1;0;1;0;1_\u001b[27;1;0;0;0;1_"), false);
    assert.equal(chunkRequestsEscape("leggi il progetto"), false);
  });

  await run("forwards win32 escape as a plain ESC character", async () => {
    assert.equal(
      getForwardingOverride("\u001b[27;1;0;1;0;1_\u001b[27;1;0;0;0;1_"),
      "\u001b",
    );
    assert.equal(
      getForwardingOverride("\u001b[27;1;27;1;0;1_\u001b[27;1;27;0;0;1_"),
      "\u001b",
    );
    assert.equal(getForwardingOverride("leggi il progetto"), "");
  });

  await run("forwards both raw and plain ESC for win32 escape sequences", async () => {
    assert.deepEqual(
      getForwardingChunks("\u001b[27;1;0;1;0;1_\u001b[27;1;0;0;0;1_"),
      ["\u001b[27;1;0;1;0;1_\u001b[27;1;0;0;0;1_", "\u001b"],
    );
    assert.deepEqual(getForwardingChunks("\u001b"), ["\u001b"]);
    assert.deepEqual(getForwardingChunks("leggi il progetto"), ["leggi il progetto"]);
  });

  await run("extracts the latest visible prompt text from Codex output", async () => {
    const prompt = extractVisiblePromptDraft(
      [
        "something earlier",
        "› vecchio prompt",
        "",
        "■ You've hit your usage limit.",
        "› leggi il progetto",
      ].join("\n"),
    );

    assert.equal(prompt, "leggi il progetto");
  });

  await run("falls back to visible prompt text when draft buffer is empty", async () => {
    const pendingPrompt = resolvePendingPrompt("", "header\n› leggi il progetto\n");
    assert.equal(pendingPrompt, "leggi il progetto");
  });

  await run("extracts a resume session id from codex output", async () => {
    const sessionId = extractResumeSessionId(
      "You've hit your usage limit.\nTo continue this session, run codex resume 019d9225-c874-7032-b848-e467229fd7cd\n",
    );
    assert.equal(sessionId, "019d9225-c874-7032-b848-e467229fd7cd");
  });

  await run("formats a yellow switching banner", async () => {
    const banner = formatSwitchingBanner();
    assert.match(banner, /\u001b\[1;33m/);
    assert.match(banner, /\[ccx\] SWITCHING ACCOUNT\.\.\./);
    assert.match(banner, /\u001b\[0m/);
  });

  await run("formats a green switched banner with source and destination", async () => {
    const banner = formatDecisionBanner({
      ok: true,
      switched: true,
      from: "1",
      to: "4",
    });
    assert.match(banner, /\u001b\[1;32m/);
    assert.match(banner, /\[ccx\] SWITCHED '1' -> '4'\. Reopening session\.\.\./);
  });

  await run("formats a red failure banner", async () => {
    const banner = formatFailureBanner("All eligible accounts are exhausted right now.");
    assert.match(banner, /\u001b\[1;31m/);
    assert.match(banner, /\[ccx\] All eligible accounts are exhausted right now\./);
  });

  await run("highlights only user prompt lines with a subtle background", async () => {
    const output = highlightUserPromptLines([
      "header",
      "› leggi il progetto",
      "assistant output",
    ].join("\n"));

    assert.match(output, /\u001b\[48;5;236m› leggi il progetto\u001b\[49m/);
    assert.match(output, /assistant output/);
    assert.doesNotMatch(output, /\u001b\[48;5;236massistant output\u001b\[49m/);
  });

  await run("highlights prompt lines that use the real codex prompt symbol", async () => {
    const output = highlightUserPromptLines("header\n› leggi il progetto\nassistant output");
    assert.match(output, /\u001b\[48;5;236m› leggi il progetto\u001b\[49m/);
  });

  await run("formats an explicitly highlighted user prompt line", async () => {
    const output = formatHighlightedUserPrompt("leggi il progetto");
    assert.match(output, /\u001b\[48;5;236m› leggi il progetto\u001b\[49m/);
  });

  await run("keeps prompt highlighting when the user line arrives across multiple chunks", async () => {
    const transformer = createUserPromptOutputTransformer();
    const outputA = transformer.transform("header\nâ€º ");
    const outputB = transformer.transform("leggi il progetto");
    const outputC = transformer.transform("\nassistant output");

    assert.equal(outputA, "header\n");
    assert.match(outputB, /\u001b\[48;5;236mâ€º leggi il progetto\u001b\[49m/);
    assert.equal(outputC, "\nassistant output");
  });

  await run("highlights user prompt lines even when ansi redraw codes precede the prompt", async () => {
    const transformer = createUserPromptOutputTransformer();
    const output = transformer.transform("\u001b[2K\rÃ¢â‚¬Âº leggi il progetto");

    assert.match(output, /\u001b\[48;5;236m/);
    assert.match(output, /leggi il progetto/);
  });

  await run("keeps prompt highlighting when a plain chunk is followed by ansi redraw and prompt", async () => {
    const transformer = createUserPromptOutputTransformer();
    const outputA = transformer.transform("⚠ warning without newline");
    const outputB = transformer.transform("\u001b[1G\u001b[2KÃ¢â‚¬Âº leggi il progetto");

    assert.equal(outputA, "⚠ warning without newline");
    assert.match(outputB, /\u001b\[48;5;236m/);
    assert.match(outputB, /leggi il progetto/);
  });

  await run("resets prompt-highlighting state after escape-like redraw interruptions", async () => {
    const transformer = createUserPromptOutputTransformer();
    const outputA = transformer.transform("\u203a leggi");
    transformer.reset();
    const outputB = transformer.transform("\u203a il progetto\n");

    assert.match(outputA, /\u001b\[48;5;236m/);
    assert.match(outputB, /\u001b\[48;5;236m› il progetto\u001b\[49m/);
  });

  await run("builds a terminal reset sequence that disables sticky tty modes", async () => {
    const sequence = buildTerminalResetSequence();
    assert.match(sequence, /\u001bc/);
    assert.match(sequence, /\u001b\[\?1049l/);
    assert.match(sequence, /\u001b\[\?1l/);
    assert.match(sequence, /\u001b>/);
    assert.match(sequence, /\u001b\[\?2004l/);
    assert.match(sequence, /\u001b\[\?25h/);
    assert.match(sequence, /\u001b\[0m/);
  });

  await run("prefill controller writes text and autosubmits once", async () => {
    const timers = [];
    const writes = [];
    const submitted = [];
    const controller = createPrefillController({
      prefillText: "leggi il progetto",
      autoSubmit: true,
      schedule: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length - 1;
      },
      clearScheduled: () => {},
    });

    assert.equal(
      controller.run(
        (chunk) => writes.push(chunk),
        () => true,
        (prompt) => submitted.push(prompt),
      ),
      true,
    );
    assert.deepEqual(writes, ["leggi il progetto"]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, PREFILL_AUTOSUBMIT_DELAY_MS);

    timers[0].fn();
    assert.deepEqual(writes, ["leggi il progetto", "\r"]);
    assert.deepEqual(submitted, ["leggi il progetto"]);

    assert.equal(
      controller.run(
        (chunk) => writes.push(chunk),
        () => true,
        (prompt) => submitted.push(prompt),
      ),
      false,
    );
  });

  await run("prefill controller waits until the prompt is ready before autosubmitting", async () => {
    const timers = [];
    const writes = [];
    const submitted = [];
    let ready = false;
    const controller = createPrefillController({
      prefillText: "leggi il progetto",
      autoSubmit: true,
      schedule: (fn, delay) => {
        timers.push({ fn, delay });
        return timers.length - 1;
      },
      clearScheduled: () => {},
    });

    assert.equal(
      controller.run(
        (chunk) => writes.push(chunk),
        () => true,
        (prompt) => submitted.push(prompt),
        () => ready,
      ),
      true,
    );
    assert.deepEqual(writes, ["leggi il progetto"]);
    assert.equal(timers.length, 1);

    timers[0].fn();
    assert.deepEqual(writes, ["leggi il progetto"]);
    assert.deepEqual(submitted, []);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, PREFILL_AUTOSUBMIT_DELAY_MS);

    ready = true;
    timers[1].fn();
    assert.deepEqual(writes, ["leggi il progetto", "\r"]);
    assert.deepEqual(submitted, ["leggi il progetto"]);
  });

  await run("prefill controller can prefill without autosubmit", async () => {
    const writes = [];
    const controller = createPrefillController({
      prefillText: "leggi il progetto",
      autoSubmit: false,
      schedule: () => {
        throw new Error("should not schedule autosubmit");
      },
      clearScheduled: () => {},
    });

    assert.equal(
      controller.run((chunk) => writes.push(chunk), () => true),
      true,
    );
    assert.deepEqual(writes, ["leggi il progetto"]);
  });

  await run("extracts the latest visible prompt text with the real prompt symbol", async () => {
    const prompt = extractVisiblePromptDraft(
      [
        "something earlier",
        "\u203a vecchio prompt",
        "",
        "\u25a0 You've hit your usage limit.",
        "\u203a leggi il progetto",
      ].join("\n"),
    );

    assert.equal(prompt, "leggi il progetto");
  });

  await run("falls back to visible prompt text with the real prompt symbol", async () => {
    const pendingPrompt = resolvePendingPrompt("", "header\n\u203a leggi il progetto\n");
    assert.equal(pendingPrompt, "leggi il progetto");
  });

  await run("formats a startup banner with a large CCX header", async () => {
    const banner = formatStartupBanner();
    assert.match(banner, /CCX/);
    assert.match(banner, /____/);
    assert.doesNotMatch(banner, /\\u001b\[0m/);
  });

  await run("highlights user prompt lines with the real prompt symbol", async () => {
    const output = highlightUserPromptLines("header\n\u203a leggi il progetto\nassistant output");
    assert.match(output, /\u001b\[48;5;236m› leggi il progetto\u001b\[49m/);
  });

  await run("formats an explicitly highlighted user prompt line with the real prompt symbol", async () => {
    const output = formatHighlightedUserPrompt("leggi il progetto");
    assert.match(output, /\u001b\[48;5;236m› leggi il progetto\u001b\[49m/);
  });

  process.stdout.write("all ccx regression tests passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
