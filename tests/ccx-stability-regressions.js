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
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("assistant partial chunk"), "assistant partial chunk");
});

run("footer badge still appears for real codex footer lines", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4 xhigh"), "");
  const output = pipeline.transform(" \u00b7 ~\\Documents\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /\u00b7 ~\\Documents\\repo/);
});

run("footer badge survives a short model-prefix PTY split", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4"), "");
  const output = pipeline.transform(" xhigh \u00b7 ~\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /gpt-5\.4 xhigh \u00b7 ~\\repo/);
});

run("complete footer tails without a trailing newline stay buffered for the badge", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4 xhigh \u00b7 ~\\repo"), "");
  const output = pipeline.transform("\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /gpt-5\.4 xhigh \u00b7 ~\\repo/);
});

run("disproven footer prefixes flush without badge", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4"), "");
  const output = pipeline.transform(" totally not a footer\r\n");
  assert.doesNotMatch(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /gpt-5\.4 totally not a footer/);
});

run("generic indented path lines do not get a footer badge", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  const first = pipeline.transform("  2026 build - /tmp foo\r\n");
  const second = pipeline.transform("  7 job - C:\\temp file\r\n");
  assert.doesNotMatch(first, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.doesNotMatch(second, /\u001b\[1;32mCDX\u001b\[0m/);
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

run("observer keeps the output bridge active until structured session state is readable", async () => {
  const {
    createSessionObserver,
    hasActionableStructuredSessionState,
  } = require("../lib/ccx/session-observer");
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
  let currentSessionState = null;
  let bridgeCalls = 0;
  const bridgeStates = [];
  const sessionStateHistory = [];
  const structuredSignalArgs = [];
  const events = [];

  const observer = createSessionObserver({
    readSessionState: () => {
      currentSessionState = structuredStates[Math.min(readCount++, structuredStates.length - 1)];
      sessionStateHistory.push(currentSessionState);
      return currentSessionState;
    },
    hasStructuredSessionSignal: (sessionState) => {
      structuredSignalArgs.push(sessionState);
      return hasActionableStructuredSessionState(sessionState);
    },
    readOutputUsageLimitBridge: () => {
      bridgeCalls += 1;
      bridgeStates.push(currentSessionState);
      return bridgeCalls === 3
        ? {
            prompt: "ponte output",
            source: "output",
            message: "You've hit your usage limit.",
          }
        : null;
    },
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  const deadline = Date.now() + 100;
  while (
    Date.now() < deadline &&
    (!structuredSignalArgs.some((state) => state && state.latestError) || bridgeCalls < 3)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  observer.stop();

  assert.equal(bridgeCalls, 3);
  assert.equal(events.length >= 1, true);
  assert.equal(events[0].prompt, "ponte output");
  assert.equal(events[0].source, "output");
  assert.deepEqual(bridgeStates.slice(0, 3), [
    null,
    {},
    {
      latestUserMessage: "stato strutturato",
    },
  ]);
  assert.deepEqual(sessionStateHistory.slice(0, 4), [
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
  ]);
  assert.equal(
    hasActionableStructuredSessionState({
      latestUserMessage: "stato strutturato",
    }),
    false,
  );
  assert.equal(
    hasActionableStructuredSessionState({
      latestError: {
        code: "usage_limit_exceeded",
      },
    }),
    true,
  );
});

run("known session file path does not disable the output bridge before structured state becomes actionable", async () => {
  const {
    createSessionObserver,
    hasActionableStructuredSessionState,
  } = require("../lib/ccx/session-observer");
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.readOutputUsageLimitBridgeForState, "function");

  const state = {
    sessionFilePath: "C:\\Users\\filmd\\.codex\\sessions\\2026\\04\\17\\session.jsonl",
    outputBuffer: "You've hit your usage limit. Try again later.",
    lastSubmittedPrompt: "leggi il progetto",
  };
  const structuredState = {
    latestUserMessage: "leggi il progetto",
  };
  const events = [];

  const observer = createSessionObserver({
    readSessionState: () => structuredState,
    hasStructuredSessionSignal: (sessionState) => hasActionableStructuredSessionState(sessionState),
    readOutputUsageLimitBridge: () => _internal.readOutputUsageLimitBridgeForState(state),
    onUsageLimitExceeded: (event) => events.push(event),
    intervalMs: 5,
  });

  observer.start();
  const deadline = Date.now() + 50;
  while (Date.now() < deadline && events.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  observer.stop();

  assert.equal(state.sessionFilePath.length > 0, true);
  assert.equal(hasActionableStructuredSessionState(structuredState), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "output");
  assert.equal(events[0].prompt, "leggi il progetto");
});

run("pre-session output bridge matches historical usage-limit phrasings", () => {
  const { _internal } = require("../bin/ccx.js");
  const hasOutputUsageLimitMessage = _internal && _internal.hasOutputUsageLimitMessage;

  assert.equal(typeof hasOutputUsageLimitMessage, "function");
  assert.equal(hasOutputUsageLimitMessage("You have hit your usage limit."), true);
  assert.equal(hasOutputUsageLimitMessage("Please purchase more credits or visit settings/usage."), true);
  assert.equal(hasOutputUsageLimitMessage("Your usage limit was reached. Please try again at 9:00 PM."), true);
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

run("local submit clears stale prompt cache before the output bridge can replay prompt A", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.processInputChunkForState, "function");
  assert.equal(typeof _internal.readOutputUsageLimitBridgeForState, "function");

  const state = {
    draftBuffer: "prompt B",
    lastSubmittedPrompt: "prompt A",
    outputBuffer: "You've hit your usage limit. Try again later.",
    outputTransformer: null,
  };

  const result = _internal.processInputChunkForState(state, "\r");
  state.outputBuffer = "You've hit your usage limit. Try again later.";
  const bridgeEvent = _internal.readOutputUsageLimitBridgeForState(state);

  assert.equal(result.submittedPrompt, "prompt B");
  assert.equal(state.lastSubmittedPrompt, "");
  assert.deepEqual(bridgeEvent, {
    prompt: "",
    source: "output",
    message: "You've hit your usage limit.",
  });
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

run("output bridge can reuse the observer-owned prompt cache before structured exhaustion lands", () => {
  const { _internal } = require("../bin/ccx.js");

  assert.equal(typeof _internal.syncObservedSessionStateForState, "function");
  assert.equal(typeof _internal.readOutputUsageLimitBridgeForState, "function");

  const state = {
    outputBuffer: "You've hit your usage limit. Try again later.",
    lastSubmittedPrompt: "",
  };

  _internal.syncObservedSessionStateForState(state, {
    latestUserMessage: "prompt recovered by observer",
  });

  const event = _internal.readOutputUsageLimitBridgeForState(state);
  assert.equal(event.prompt, "prompt recovered by observer");
  assert.equal(event.source, "output");
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
