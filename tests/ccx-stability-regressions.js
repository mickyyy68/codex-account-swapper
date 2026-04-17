#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolvePendingPrompt } = require("../lib/ccx/prompt-state");
const { createOutputPipeline } = require("../lib/ccx/output-pipeline");

const pendingRuns = [];

function run(name, fn) {
  pendingRuns.push(Promise.resolve().then(fn).then(() => {
    process.stdout.write(`ok - ${name}\n`);
  }).catch((err) => {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exitCode = 1;
    throw err;
  }));
}

run("approval ui does not become a pending prompt", () => {
  const prompt = resolvePendingPrompt(
    "",
    [
      "header",
      "\u203a leggi il progetto",
      "",
      "Allow command execution?",
      "  Enter = approve",
      "  Esc = deny",
    ].join("\n"),
  );
  assert.equal(prompt, "");
});

run("visible multiline prompt survives footer lines but not approval ui", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
      ].join("\n"),
    ),
    "leggi il progetto\n  su piu righe",
  );
});

run("visible multiline prompt with footer and approval ui does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
        "",
        "Allow command execution?",
        "  Enter = approve",
        "  Esc = deny",
      ].join("\n"),
    ),
    "",
  );
});

run("visible multiline prompt with blank tail does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "",
      ].join("\n"),
    ),
    "",
  );
});

run("visible multiline prompt survives bare-cr footer lines", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
      ].join("\r"),
    ),
    "leggi il progetto\n  su piu righe",
  );
});

run("partial footer tails do not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4",
      ].join("\n"),
    ),
    "",
  );
});

run("generic indented trailing output does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  assistant output",
      ].join("\n"),
    ),
    "",
  );
});

run("transparent output lane passes normal chunks through immediately", () => {
  const pipeline = createOutputPipeline();
  assert.equal(pipeline.transform("assistant partial chunk"), "assistant partial chunk");
});

run("live output pipeline is pure pass-through in minimal mode", () => {
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("partial assistant chunk"), "partial assistant chunk");
  assert.equal(pipeline.flush(), "");
});

run("minimal wrapper no longer imports prompt restore helpers in the autoswitch path", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");

  assert.doesNotMatch(source, /createPrefillController/);
  assert.doesNotMatch(source, /formatHighlightedUserPrompt/);
});

run("autoswitch reopen branches call resume without prompt options", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");

  const reopenCallPattern = /await launchCodex\(\["resume", previousSessionId\]\);/g;
  const reopenCalls = source.match(reopenCallPattern) || [];

  assert.equal(reopenCalls.length >= 3, true);
  assert.doesNotMatch(source, /prefillText:/);
  assert.doesNotMatch(source, /autoSubmitPrefill:/);
});

run("footer-like lines stay transparent without decoration", () => {
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo\r\n"), "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo\r\n");
  assert.equal(pipeline.flush(), "");
});

run("split footer-like chunks stay transparent", () => {
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("  gpt-5.4"), "  gpt-5.4");
  assert.equal(pipeline.transform(" xhigh \u00b7 ~\\repo\r\n"), " xhigh \u00b7 ~\\repo\r\n");
  assert.equal(pipeline.flush(), "");
});

run("footer-like tails do not buffer for decoration", () => {
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("  gpt-5.4 xhigh \u00b7 ~\\repo"), "  gpt-5.4 xhigh \u00b7 ~\\repo");
  assert.equal(pipeline.flush(), "");
});

run("generic indented path lines stay transparent", () => {
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("  2026 build - /tmp foo\r\n"), "  2026 build - /tmp foo\r\n");
  assert.equal(pipeline.transform("  7 job - C:\\temp file\r\n"), "  7 job - C:\\temp file\r\n");
  assert.equal(pipeline.flush(), "");
});

run("observer emits exhaustion only from structured session state", async () => {
  const { createSessionObserver } = require("../lib/ccx/session-observer");
  let latestState = null;
  const events = [];

  const observer = createSessionObserver({
    readSessionState: () => latestState,
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 0);

  latestState = {
    latestError: {
      code: "usage_limit_exceeded",
      message: "You've hit your usage limit.",
      timestamp: "2026-04-16T12:00:00.000Z",
    },
    latestUserMessage: "leggi il progetto",
  };

  await new Promise((resolve) => setTimeout(resolve, 20));
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "leggi il progetto");
  assert.equal(events[0].sessionState.latestUserMessage, "leggi il progetto");
});

run("observer emits exhaustion from message-text-only usage-limit state", async () => {
  const { createSessionObserver } = require("../lib/ccx/session-observer");
  let latestState = null;
  const events = [];

  const observer = createSessionObserver({
    readSessionState: () => latestState,
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  latestState = {
    latestError: {
      message: "You have hit your usage limit.",
    },
    latestUserMessage: "leggi il progetto",
  };

  await new Promise((resolve) => setTimeout(resolve, 20));
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "leggi il progetto");
  assert.equal(events[0].sessionState.latestError.message, "You have hit your usage limit.");
});

run("observer ignores non-exhausted structured session state until a structured exhaustion arrives", async () => {
  const { createSessionObserver } = require("../lib/ccx/session-observer");
  const structuredStates = [
    null,
    {},
    {
      latestUserMessage: "stato strutturato",
    },
    {
      latestError: {
        code: "usage_limit_exceeded",
        message: "You've hit your usage limit.",
        timestamp: "2026-04-16T12:00:00.000Z",
      },
      latestUserMessage: "stato strutturato",
    },
  ];
  let readCount = 0;
  const observedStates = [];
  const events = [];

  const observer = createSessionObserver({
    readSessionState: () => structuredStates[Math.min(readCount++, structuredStates.length - 1)],
    onSessionStateObserved: (sessionState) => observedStates.push(sessionState),
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  const deadline = Date.now() + 100;
  while (Date.now() < deadline && events.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "stato strutturato");
  assert.deepEqual(observedStates.slice(0, 3), [
    {},
    {
      latestUserMessage: "stato strutturato",
    },
    {
      latestError: {
        code: "usage_limit_exceeded",
        message: "You've hit your usage limit.",
        timestamp: "2026-04-16T12:00:00.000Z",
      },
      latestUserMessage: "stato strutturato",
    },
  ]);
});

run("observer does not use rendered output as a core trigger", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");

  assert.doesNotMatch(source, /hasOutputUsageLimitMessage/);
  assert.doesNotMatch(source, /readOutputUsageLimitBridge/);
});

run("session state usage-limit detection falls back to historical message text", () => {
  const { isSessionStateUsageLimitExceeded } = require("../lib/ccx/session-log");

  assert.equal(
    isSessionStateUsageLimitExceeded({
      latestError: {
        code: "different_error",
        message: "You've hit your usage limit. Try again later.",
      },
    }),
    true,
  );
});

run("helper imports do not require node-pty until runtime launch", () => {
  const Module = require("node:module");
  const ccxPath = require.resolve("../bin/ccx.js");
  const originalLoad = Module._load;

  delete require.cache[ccxPath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node-pty") {
      throw new Error("node-pty import blocked");
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const ccx = require("../bin/ccx.js");
    assert.equal(typeof ccx._internal.processInputChunkForState, "function");
  } finally {
    Module._load = originalLoad;
    delete require.cache[ccxPath];
  }
});

run("delayed new-session discovery preserves the initial post-launch tail for prompt recovery", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createSessionObserver } = require("../lib/ccx/session-observer");
  const { _internal } = require("../bin/ccx.js");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-stability-delayed-discovery-"));
  const sessionFile = path.join(tempRoot, "2026", "04", "17", "rollout.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-delayed-discovery",
          timestamp: "2026-04-17T10:00:00.000Z",
          cwd: "C:\\repo",
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "retry now",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "error",
          message: "You've hit your usage limit. Try again later.",
          codex_error_info: "usage_limit_exceeded",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const state = {
    sessionFilePath: "",
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: false,
    switching: false,
    shuttingDown: false,
    lastSubmittedPrompt: "",
  };
  const events = [];

  assert.equal(typeof _internal.captureSessionStateBaselineForState, "function");
  assert.equal(typeof _internal.captureDeferredSessionStateBaselineForState, "function");
  assert.equal(typeof _internal.readCurrentSessionStateForState, "function");
  assert.equal(typeof _internal.syncObservedSessionStateForState, "function");
  assert.equal(typeof _internal.shouldHandleUsageLimitEventForState, "function");

  _internal.captureSessionStateBaselineForState(state, {
    preserveDiscoveredTail: true,
  });
  assert.equal(state.sessionStateBaselineSize, 0);
  assert.equal(state.sessionStateBaselinePendingDiscovery, true);

  const observer = createSessionObserver({
    readSessionState: () => _internal.readCurrentSessionStateForState(state),
    onSessionStateObserved: (sessionState) => {
      _internal.syncObservedSessionStateForState(state, sessionState);
    },
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 0);

  state.sessionFilePath = sessionFile;
  const discoveredBaselineSize = fs.statSync(sessionFile).size;
  _internal.captureDeferredSessionStateBaselineForState(state);

  assert.equal(discoveredBaselineSize > 0, true);
  assert.equal(state.sessionStateBaselineSize, 0);
  assert.equal(state.sessionStateBaselinePendingDiscovery, false);

  const deadline = Date.now() + 200;
  while (Date.now() < deadline && events.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "retry now");
  assert.equal(events[0].sessionState.latestError.code, "usage_limit_exceeded");
  assert.equal(state.lastSubmittedPrompt, "retry now");
  assert.equal(_internal.shouldHandleUsageLimitEventForState(state, events[0]), true);
});

run("resume baseline still ignores historical pre-launch session lines", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createSessionObserver } = require("../lib/ccx/session-observer");
  const { _internal } = require("../bin/ccx.js");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-stability-resume-baseline-"));
  const sessionFile = path.join(tempRoot, "2026", "04", "17", "resume.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-resume-baseline",
          timestamp: "2026-04-17T10:00:00.000Z",
          cwd: "C:\\repo",
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "historical prompt",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "error",
          message: "You've hit your usage limit. Try again later.",
          codex_error_info: "usage_limit_exceeded",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const state = {
    sessionFilePath: sessionFile,
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: false,
  };
  const events = [];

  _internal.captureSessionStateBaselineForState(state);
  const historicalBaselineSize = fs.statSync(sessionFile).size;
  assert.equal(state.sessionStateBaselineSize, historicalBaselineSize);
  assert.equal(state.sessionStateBaselinePendingDiscovery, false);

  const observer = createSessionObserver({
    readSessionState: () => _internal.readCurrentSessionStateForState(state),
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 0);

  fs.appendFileSync(
    sessionFile,
    [
      JSON.stringify({
        timestamp: "2026-04-17T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "fresh prompt",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "error",
          message: "You've hit your usage limit. Try again later.",
          codex_error_info: "usage_limit_exceeded",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const deadline = Date.now() + 200;
  while (Date.now() < deadline && events.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "fresh prompt");
});

run("new-session discovery preserves the post-launch tail", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const tracker = createSessionIdentityTracker();

  tracker.markAwaitingDiscovery();
  tracker.attachDiscoveredSession({
    sessionId: "sess-new",
    sessionFilePath: "C:\\tmp\\new.jsonl",
    preserveDiscoveredTail: true,
  });

  assert.equal(tracker.getState().sessionStateBaselineSize, 0);
});

run("resumed sessions baseline at eof instead of replaying historical lines", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const tracker = createSessionIdentityTracker();

  tracker.attachResumedSession({
    sessionId: "sess-resume",
    sessionFilePath: "C:\\tmp\\resume.jsonl",
    currentSize: 512,
  });

  assert.equal(tracker.getState().sessionStateBaselineSize, 512);
});

run("tracker can accept an output-derived session id without losing pending discovery", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const tracker = createSessionIdentityTracker();

  tracker.markAwaitingDiscovery();
  tracker.setSessionId("sess-from-output");

  assert.deepEqual(tracker.getState(), {
    sessionId: "sess-from-output",
    sessionFilePath: "",
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: true,
  });
});

run("deferred baseline capture keys off tracker pending discovery instead of stale wrapper mirrors", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const { _internal } = require("../bin/ccx.js");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-stability-canonical-pending-"));
  const sessionFile = path.join(tempRoot, "canonical-pending.jsonl");
  fs.writeFileSync(sessionFile, "", "utf8");

  const tracker = createSessionIdentityTracker();
  tracker.markAwaitingDiscovery();
  tracker.setSessionId("sess-from-output");

  const state = {
    sessionId: "stale-wrapper-id",
    sessionFilePath: sessionFile,
    sessionStateBaselineSize: 0,
    sessionStateBaselinePendingDiscovery: false,
    sessionStatePreserveDiscoveredTail: true,
    sessionIdentityTracker: tracker,
  };

  _internal.captureDeferredSessionStateBaselineForState(state);

  assert.equal(state.sessionId, "sess-from-output");
  assert.equal(state.sessionFilePath, sessionFile);
  assert.equal(state.sessionStateBaselineSize, 0);
  assert.equal(state.sessionStateBaselinePendingDiscovery, false);
});

run("observer arming uses canonical tracker identity instead of stale wrapper mirrors", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const { _internal } = require("../bin/ccx.js");
  const tracker = createSessionIdentityTracker();

  tracker.attachResumedSession({
    sessionId: "sess-canonical",
    sessionFilePath: "C:\\tmp\\canonical.jsonl",
    currentSize: 128,
  });

  assert.equal(
    _internal.shouldArmSessionObserverForState({
      sessionId: "",
      sessionFilePath: "",
      sessionIdentityTracker: tracker,
      switching: false,
      shuttingDown: false,
      lastSubmittedPrompt: "",
    }),
    true,
  );
});

run("identity resolution prefers the canonical tracker over stale wrapper mirrors", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const { _internal } = require("../bin/ccx.js");
  const tracker = createSessionIdentityTracker();

  tracker.attachResumedSession({
    sessionId: "sess-canonical",
    sessionFilePath: "C:\\tmp\\canonical.jsonl",
    currentSize: 128,
  });

  assert.deepEqual(
    _internal.resolveSessionIdentityForState({
      sessionId: "sess-stale",
      sessionFilePath: "C:\\tmp\\stale.jsonl",
      sessionIdentityTracker: tracker,
    }),
    {
      sessionId: "sess-canonical",
      sessionFilePath: "C:\\tmp\\canonical.jsonl",
    },
  );
});

run("sessionId-only corrections update the canonical tracker for an already-known path", () => {
  const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");
  const { _internal } = require("../bin/ccx.js");
  const tracker = createSessionIdentityTracker();

  tracker.attachResumedSession({
    sessionId: "sess-original",
    sessionFilePath: "C:\\tmp\\known.jsonl",
    currentSize: 128,
  });

  const state = {
    sessionId: "sess-stale-wrapper",
    sessionFilePath: "C:\\tmp\\known.jsonl",
    sessionStateBaselineSize: 128,
    sessionStateBaselinePendingDiscovery: false,
    sessionIdentityTracker: tracker,
  };

  _internal.applyObservedSessionIdentityForState(state, {
    sessionId: "sess-corrected",
    sessionFilePath: "C:\\tmp\\known.jsonl",
  });

  assert.deepEqual(_internal.resolveSessionIdentityForState(state), {
    sessionId: "sess-corrected",
    sessionFilePath: "C:\\tmp\\known.jsonl",
  });
  assert.equal(state.sessionId, "sess-corrected");
  assert.equal(state.sessionFilePath, "C:\\tmp\\known.jsonl");
});

run("input submit clears stale canonical prompt cache without submit-time watcher mutations", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");

  const state = {
    draftBuffer: "leggi il progetto",
    lastSubmittedPrompt: "prompt from observer",
    outputBuffer: "stale output",
    sessionStateBaselineSize: 321,
    sessionStateBaselinePendingDiscovery: true,
    sessionObserver: { active: true },
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "\r");

  assert.equal(result.submittedPrompt, "leggi il progetto");
  assert.deepEqual(result.forwardingChunks, ["\r"]);
  assert.equal(state.draftBuffer, "");
  assert.equal(state.outputBuffer, "");
  assert.equal(state.lastSubmittedPrompt, "");
  assert.equal(state.sessionStateBaselineSize, 321);
  assert.equal(state.sessionStateBaselinePendingDiscovery, true);
  assert.deepEqual(state.sessionObserver, { active: true });
});

run("empty Enter with approval-style output does not become a prompt submit at the wrapper boundary", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");

  const state = {
    draftBuffer: "",
    lastSubmittedPrompt: "observer-owned prompt",
    outputBuffer: [
      "Allow command execution?",
      "  Enter = approve",
      "  Esc = deny",
    ].join("\n"),
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "\r");

  assert.equal(result.submittedPrompt, "");
  assert.deepEqual(result.forwardingChunks, ["\r"]);
  assert.equal(state.draftBuffer, "");
  assert.equal(state.outputBuffer, [
    "Allow command execution?",
    "  Enter = approve",
    "  Esc = deny",
  ].join("\n"));
  assert.equal(state.lastSubmittedPrompt, "observer-owned prompt");
});

run("coalesced submit chunk preserves only the pre-submit prompt and keeps trailing draft bytes", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");

  const state = {
    draftBuffer: "",
    lastSubmittedPrompt: "stale observer prompt",
    outputBuffer: "stale output",
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "hello\rworld");

  assert.equal(result.submittedPrompt, "hello");
  assert.deepEqual(result.forwardingChunks, ["hello\rworld"]);
  assert.equal(state.draftBuffer, "world");
  assert.equal(state.outputBuffer, "");
  assert.equal(state.lastSubmittedPrompt, "");
});

run("coalesced repeated submit chunk submits the first prompt and leaves only post-final-submit draft state", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");

  const state = {
    draftBuffer: "",
    lastSubmittedPrompt: "stale observer prompt",
    outputBuffer: "stale output",
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "hello\rworld\r");

  assert.equal(result.submittedPrompt, "hello");
  assert.deepEqual(result.forwardingChunks, ["hello\rworld\r"]);
  assert.equal(state.draftBuffer, "");
  assert.equal(state.outputBuffer, "");
  assert.equal(state.lastSubmittedPrompt, "");
});

run("leading submit chunk keeps trailing draft bytes without inventing a submitted prompt", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");

  const state = {
    draftBuffer: "",
    lastSubmittedPrompt: "observer-owned prompt",
    outputBuffer: "approval-style output",
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "\rworld");

  assert.equal(result.submittedPrompt, "");
  assert.deepEqual(result.forwardingChunks, ["\rworld"]);
  assert.equal(state.draftBuffer, "world");
  assert.equal(state.outputBuffer, "approval-style output");
  assert.equal(state.lastSubmittedPrompt, "observer-owned prompt");
});

run("observer-owned prompt sync updates the canonical prompt cache", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.syncObservedSessionStateForState, "function");

  const state = {
    lastSubmittedPrompt: "",
  };

  _internal.syncObservedSessionStateForState(state, {
    latestUserMessage: "prompt from session state",
  });
  assert.equal(state.lastSubmittedPrompt, "prompt from session state");

  _internal.syncObservedSessionStateForState(state, {
    latestError: {
      code: "usage_limit_exceeded",
    },
  });
  assert.equal(state.lastSubmittedPrompt, "prompt from session state");
});

run("session observer arming depends on session identity not submit-time prompt state", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.shouldArmSessionObserverForState, "function");

  assert.equal(
    _internal.shouldArmSessionObserverForState({
      sessionId: "sess-1",
      sessionFilePath: "",
      lastSubmittedPrompt: "",
    }),
    true,
  );
  assert.equal(
    _internal.shouldArmSessionObserverForState({
      sessionId: "",
      sessionFilePath: "C:\\Users\\filmd\\.codex\\sessions\\2026\\04\\17\\session.jsonl",
      lastSubmittedPrompt: "",
    }),
    true,
  );
  assert.equal(
    _internal.shouldArmSessionObserverForState({
      sessionId: "",
      sessionFilePath: "",
      lastSubmittedPrompt: "submit-time prompt should not matter",
    }),
    false,
  );
});

run("usage-limit handling waits until a canonical prompt is recoverable", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.shouldHandleUsageLimitEventForState, "function");
  assert.equal(typeof _internal.resolveUsageLimitPromptForState, "function");
  assert.equal(typeof _internal.syncObservedSessionStateForState, "function");

  const earlyWindowState = {
    switching: false,
    shuttingDown: false,
    sessionId: "sess-early-window",
    sessionFilePath: "",
    lastSubmittedPrompt: "",
  };

  assert.equal(
    _internal.resolveUsageLimitPromptForState(earlyWindowState, {
      prompt: "",
    }),
    "",
  );
  assert.equal(
    _internal.shouldHandleUsageLimitEventForState(earlyWindowState, {
      prompt: "",
    }),
    false,
  );

  assert.equal(
    _internal.shouldHandleUsageLimitEventForState(earlyWindowState, {
      prompt: "prompt from observer event",
    }),
    true,
  );

  _internal.syncObservedSessionStateForState(earlyWindowState, {
    latestUserMessage: "prompt from observer cache",
  });
  assert.equal(
    _internal.shouldHandleUsageLimitEventForState(earlyWindowState, {
      prompt: "",
    }),
    true,
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-stability-handle-usage-limit-"));
  const sessionFile = path.join(tempRoot, "recoverable-session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-file-recovery",
          timestamp: "2026-04-17T10:00:00.000Z",
          cwd: "C:\\repo",
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "prompt recovered from session file",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(
    _internal.shouldHandleUsageLimitEventForState({
      switching: false,
      shuttingDown: false,
      sessionId: "sess-file-recovery",
      sessionFilePath: sessionFile,
      lastSubmittedPrompt: "",
    }, {
      prompt: "",
    }),
    false,
  );
  assert.equal(
    _internal.shouldHandleUsageLimitEventForState({
      switching: true,
      shuttingDown: false,
      sessionId: "sess-file-recovery",
      sessionFilePath: sessionFile,
      lastSubmittedPrompt: "",
    }, {
      prompt: "prompt from observer event",
    }),
    false,
  );
  assert.equal(
    _internal.shouldHandleUsageLimitEventForState({
      switching: false,
      shuttingDown: true,
      sessionId: "sess-file-recovery",
      sessionFilePath: sessionFile,
      lastSubmittedPrompt: "",
    }, {
      prompt: "prompt from observer event",
    }),
    false,
  );
});

run("usage-limit prompt resolution prefers the observer event prompt over a stale session tail reread", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.resolveUsageLimitPromptForState, "function");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-stability-prompt-resolution-"));
  const sessionFile = path.join(tempRoot, "stale-session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        timestamp: "2026-04-17T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "sess-stale-prompt",
          timestamp: "2026-04-17T10:00:00.000Z",
          cwd: "C:\\repo",
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-17T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "stale prompt from tail reread",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const state = {
    sessionFilePath: sessionFile,
    lastSubmittedPrompt: "prompt from observer cache",
  };

  assert.equal(
    _internal.resolveUsageLimitPromptForState(state, {
      prompt: "fresh prompt from observer event",
    }),
    "fresh prompt from observer event",
  );
  assert.equal(
    _internal.resolveUsageLimitPromptForState(state, {
      prompt: "",
    }),
    "prompt from observer cache",
  );
  assert.equal(
    _internal.resolveUsageLimitPromptForState(
      {
        sessionFilePath: sessionFile,
        lastSubmittedPrompt: "",
      },
      {
        prompt: "",
      },
    ),
    "",
  );
});

run("post-switch resume releases switching before re-arming the observer", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.releaseSwitchingStateForState, "function");
  assert.equal(typeof _internal.shouldArmSessionObserverForState, "function");

  const state = {
    switching: true,
    shuttingDown: false,
    sessionId: "sess-rearm",
    sessionFilePath: "",
    sessionObserver: null,
  };
  let shouldArmDuringRelease = null;
  let releaseCallbackCalls = 0;

  _internal.releaseSwitchingStateForState(state, () => {
    releaseCallbackCalls += 1;
    shouldArmDuringRelease = _internal.shouldArmSessionObserverForState(state);
  });

  assert.equal(state.switching, false);
  assert.equal(releaseCallbackCalls, 1);
  assert.equal(shouldArmDuringRelease, true);
});

Promise.all(pendingRuns)
  .then(() => {
    process.stdout.write("all cdx stability regression tests passed\n");
  })
  .catch(() => {
    process.exit(process.exitCode || 1);
  });
