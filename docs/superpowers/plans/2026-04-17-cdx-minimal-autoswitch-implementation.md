# CDX Minimal Autoswitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `cdx` to a near-transparent `codex` wrapper that only performs strict autoswitch-on-exhaustion and reopens the exact same session via verified `resume <sessionId>`.

**Architecture:** The interactive wrapper is narrowed to four responsibilities: PTY transport, canonical session identity, structured exhaustion observation, and strict switch orchestration. Prompt restore, autosubmit, visual decoration, and TUI-driven state inference are removed from the live autoswitch path. Any missing certainty becomes a hard error instead of a fallback.

**Tech Stack:** Node.js, `node-pty`, structured Codex session logs (`~/.codex/sessions/*.jsonl`), existing `cdx` smart-switch runtime, focused smoke/regression tests.

---

## File Map

- Modify: `bin/ccx.js`
  - Remove non-essential live-path behavior.
  - Delegate canonical session identity, structured exhaustion handling, and strict resume verification.
- Create: `lib/ccx/session-identity.js`
  - Own `sessionId`, `sessionFilePath`, and baseline policy for new vs resumed sessions.
- Create: `lib/ccx/switch-orchestrator.js`
  - Own strict exhaustion -> switch -> resume -> verify flow.
- Modify: `lib/ccx/session-observer.js`
  - Remove output/TUI fallback from the core path and emit only structured exhaustion events.
- Modify: `lib/ccx/session-log.js`
  - Expose only the structured state helpers needed for canonical identity and post-baseline exhaustion reads.
- Modify: `lib/ccx/output-pipeline.js`
  - Make the live output lane pure pass-through.
- Modify: `tests/ccx-stability-regressions.js`
  - Lock the minimal autoswitch contract behaviorally.
- Modify: `tests/smoke.js`
  - Lock the public `cdx` CLI contract including `smart-switch --json`.
- Modify: `README.md`
  - Document the minimal autoswitch contract.

## Execution Notes

- Use TDD on every task.
- Do not preserve prompt restore or autosubmit behavior in the live path.
- If a step exposes a conflict between transparency and convenience, choose transparency.
- Treat `lib/ccx/startup-ui.js`, `lib/ccx/status-ui.js`, and `tests/ccx-regressions.js` as unrelated unless a later approved task explicitly brings them back in scope.

### Task 1: Strip the Live Wrapper Down to Transparent Transport

**Files:**
- Modify: `bin/ccx.js`
- Modify: `lib/ccx/output-pipeline.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Write the failing transport-path tests**

```js
run("live output pipeline is pure pass-through in minimal mode", () => {
  const { createOutputPipeline } = require("../lib/ccx/output-pipeline");
  const pipeline = createOutputPipeline();

  assert.equal(pipeline.transform("partial assistant chunk"), "partial assistant chunk");
  assert.equal(pipeline.flush(), "");
});

run("minimal wrapper no longer imports prompt restore helpers in the autoswitch path", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");
  assert.doesNotMatch(source, /createPrefillController/);
  assert.doesNotMatch(source, /formatHighlightedUserPrompt/);
});
```

- [ ] **Step 2: Run the focused suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: FAIL because the live path still references prompt/prefill helpers or output decoration.

- [ ] **Step 3: Implement the minimal output lane**

```js
// lib/ccx/output-pipeline.js
"use strict";

function createOutputPipeline() {
  return {
    transform(chunk) {
      return String(chunk || "");
    },
    flush() {
      return "";
    },
    reset() {
      // no-op in minimal mode
    },
  };
}

module.exports = {
  createOutputPipeline,
};
```

```js
// bin/ccx.js
const { createOutputPipeline } = require("../lib/ccx/output-pipeline");

// remove live-path imports of:
// - createPrefillController
// - formatHighlightedUserPrompt
// - footer/highlight-specific output behavior
```

- [ ] **Step 4: Run the focused suite and verify the transport tests pass**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS on the new transport assertions.

- [ ] **Step 5: Commit**

```bash
git add bin/ccx.js lib/ccx/output-pipeline.js tests/ccx-stability-regressions.js
git commit -m "refactor: strip cdx wrapper to transparent transport"
```

### Task 2: Make Session Identity Canonical and Separate From the Wrapper Entry Point

**Files:**
- Create: `lib/ccx/session-identity.js`
- Modify: `bin/ccx.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Write the failing identity tests**

```js
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
```

- [ ] **Step 2: Run the focused suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: FAIL because `lib/ccx/session-identity.js` does not exist yet.

- [ ] **Step 3: Create the canonical identity module**

```js
// lib/ccx/session-identity.js
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
```

- [ ] **Step 4: Rewire `bin/ccx.js` to use the identity tracker**

```js
const { createSessionIdentityTracker } = require("../lib/ccx/session-identity");

const identity = createSessionIdentityTracker();

// launch of a new session
identity.markAwaitingDiscovery();

// attach discovered session
identity.attachDiscoveredSession({
  sessionId: match.id,
  sessionFilePath: match.filePath,
  preserveDiscoveredTail: true,
});

// attach resumed session
identity.attachResumedSession({
  sessionId: resumedSession.id,
  sessionFilePath: resumedSession.filePath,
  currentSize: fs.statSync(resumedSession.filePath).size,
});
```

- [ ] **Step 5: Run the focused suite and verify identity tests pass**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS on the identity assertions.

- [ ] **Step 6: Commit**

```bash
git add bin/ccx.js lib/ccx/session-identity.js tests/ccx-stability-regressions.js
git commit -m "refactor: make cdx session identity canonical"
```

### Task 3: Remove TUI-Driven Exhaustion and Use Structured Observer Events Only

**Files:**
- Modify: `lib/ccx/session-observer.js`
- Modify: `lib/ccx/session-log.js`
- Modify: `bin/ccx.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Write the failing observer tests**

```js
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
  latestState = {
    latestError: { code: "usage_limit_exceeded", message: "You've hit your usage limit." },
    latestUserMessage: "prompt corrente",
  };

  await new Promise((resolve) => setTimeout(resolve, 25));
  observer.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "prompt corrente");
});

run("observer does not use rendered output as a core trigger", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");
  assert.doesNotMatch(source, /hasOutputUsageLimitMessage/);
  assert.doesNotMatch(source, /readOutputUsageLimitBridge/);
});
```

- [ ] **Step 2: Run the focused suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: FAIL because the live path still includes TUI/output fallback logic.

- [ ] **Step 3: Make the observer structured-only**

```js
// lib/ccx/session-observer.js
"use strict";

const { isSessionStateUsageLimitExceeded } = require("./session-log");

function createSessionObserver(options = {}) {
  const readSessionState = options.readSessionState;
  const onSessionStateObserved = options.onSessionStateObserved || (() => {});
  const onUsageLimitExceeded = options.onUsageLimitExceeded || (() => {});
  const intervalMs = Number(options.intervalMs || 100);
  let timer = null;
  let lastUsageKey = "";

  function poll() {
    const sessionState = readSessionState();
    if (sessionState && typeof sessionState === "object") {
      onSessionStateObserved(sessionState);
    }
    if (!isSessionStateUsageLimitExceeded(sessionState)) {
      return;
    }

    const usageKey = JSON.stringify([
      sessionState.latestError ? sessionState.latestError.code : "",
      sessionState.latestError ? sessionState.latestError.timestamp || "" : "",
      sessionState.latestUserMessage || "",
    ]);
    if (!usageKey || usageKey === lastUsageKey) {
      return;
    }
    lastUsageKey = usageKey;
    onUsageLimitExceeded({
      prompt: sessionState.latestUserMessage || "",
      sessionState,
    });
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(poll, Math.max(1, intervalMs));
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
```

- [ ] **Step 4: Remove output-bridge logic from `bin/ccx.js`**

```js
// remove:
// - hasOutputUsageLimitMessage(...)
// - readOutputUsageLimitBridgeForState(...)
// - observer bridge callbacks based on rendered output

const observer = createSessionObserver({
  readSessionState,
  onSessionStateObserved: syncObservedSessionState,
  onUsageLimitExceeded: handleUsageLimitExceeded,
  intervalMs: 100,
});
```

- [ ] **Step 5: Run the focused suite and verify observer tests pass**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS on the observer-only assertions.

- [ ] **Step 6: Commit**

```bash
git add bin/ccx.js lib/ccx/session-observer.js lib/ccx/session-log.js tests/ccx-stability-regressions.js
git commit -m "refactor: make cdx exhaustion observation structured-only"
```

### Task 4: Remove Prompt Restore and Implement Strict Resume Verification

**Files:**
- Create: `lib/ccx/switch-orchestrator.js`
- Modify: `bin/ccx.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Write the failing orchestrator tests**

```js
run("strict autoswitch refuses to proceed without canonical identity", async () => {
  const { createSwitchOrchestrator } = require("../lib/ccx/switch-orchestrator");
  const calls = [];
  const orchestrator = createSwitchOrchestrator({
    closeSession: async () => calls.push("close"),
    runSmartSwitch: async () => ({ ok: true, from: "1", to: "2" }),
    resumeSession: async () => calls.push("resume"),
    verifyResumedSession: async () => true,
  });

  await assert.rejects(
    () => orchestrator.handleExhaustion({ sessionId: "", sessionFilePath: "" }),
    /canonical session identity/i,
  );
  assert.deepEqual(calls, []);
});

run("strict autoswitch errors when resumed session id does not match", async () => {
  const { createSwitchOrchestrator } = require("../lib/ccx/switch-orchestrator");
  const orchestrator = createSwitchOrchestrator({
    closeSession: async () => {},
    runSmartSwitch: async () => ({ ok: true, from: "1", to: "2" }),
    resumeSession: async () => {},
    verifyResumedSession: async () => false,
  });

  await assert.rejects(
    () => orchestrator.handleExhaustion({ sessionId: "sess-1", sessionFilePath: "C:\\tmp\\sess-1.jsonl" }),
    /same sessionId/i,
  );
});
```

- [ ] **Step 2: Run the focused suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: FAIL because `lib/ccx/switch-orchestrator.js` does not exist and live code still restores prompts.

- [ ] **Step 3: Create the strict orchestrator**

```js
// lib/ccx/switch-orchestrator.js
"use strict";

function createSwitchOrchestrator(options = {}) {
  const closeSession = options.closeSession;
  const runSmartSwitch = options.runSmartSwitch;
  const resumeSession = options.resumeSession;
  const verifyResumedSession = options.verifyResumedSession;

  return {
    async handleExhaustion(identity) {
      if (!identity || !identity.sessionId || !identity.sessionFilePath) {
        throw new Error("canonical session identity is required before autoswitch");
      }

      await closeSession();
      const result = await runSmartSwitch();
      if (!result || result.ok !== true) {
        throw new Error("smart switch failed");
      }

      await resumeSession(identity.sessionId);
      const matched = await verifyResumedSession(identity.sessionId);
      if (!matched) {
        throw new Error("resumed session did not confirm the same sessionId");
      }
    },
  };
}

module.exports = {
  createSwitchOrchestrator,
};
```

- [ ] **Step 4: Rewire `bin/ccx.js` to use `resume <sessionId>` only**

```js
const { createSwitchOrchestrator } = require("../lib/ccx/switch-orchestrator");

const orchestrator = createSwitchOrchestrator({
  closeSession: async () => {
    const child = state.ptyProcess;
    if (child) {
      child.kill();
      await waitForChildExit(child, { timeoutMs: 1500 });
      state.ptyProcess = null;
    }
  },
  runSmartSwitch: () => runLocalCdxSmartSwitchJson(),
  resumeSession: async (sessionId) => {
    await launchCodex(["resume", sessionId]);
  },
  verifyResumedSession: async (expectedSessionId) => {
    const sessionIdentity = await waitForTruthyValue(
      () => state.sessionId ? state.sessionId : null,
      { timeoutMs: SESSION_ID_WAIT_TIMEOUT_MS, intervalMs: 100 },
    );
    return sessionIdentity === expectedSessionId;
  },
});
```

- [ ] **Step 5: Remove prompt restore from the autoswitch path**

```js
// delete live-path usage of:
// - prefillText for exhaustion reopen
// - autoSubmitPrefill
// - canonical prompt restore after exhaustion
//
// keep launchCodex generic support only if other non-autoswitch code still needs it
```

- [ ] **Step 6: Run the focused suite and verify orchestrator tests pass**

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS on strict identity/error behavior.

- [ ] **Step 7: Commit**

```bash
git add bin/ccx.js lib/ccx/switch-orchestrator.js tests/ccx-stability-regressions.js
git commit -m "refactor: make cdx autoswitch resume the exact same session"
```

### Task 5: Document and Lock the Minimal Public Contract

**Files:**
- Modify: `README.md`
- Modify: `tests/smoke.js`
- Test: `tests/smoke.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add the failing smoke/regression expectations**

```js
// tests/smoke.js
run("wrapper help", ["--help"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx:/i);
});

runJson("smart switch json", ["smart-switch", "--json"], (payload) => {
  assert.equal(typeof payload.ok, "boolean");
  assert.equal(typeof payload.from, "string");
  assert.equal(typeof payload.to, "string");
});
```

```js
// tests/ccx-stability-regressions.js
run("minimal autoswitch path no longer restores prompts after exhaustion", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");
  assert.doesNotMatch(source, /prefillText:\s*canonicalPrompt/);
  assert.doesNotMatch(source, /autoSubmitPrefill/);
});
```

- [ ] **Step 2: Run the smoke and stability tests to verify at least one fails before docs/code alignment**

Run: `node .\tests\smoke.js`
Expected: PASS or FAIL depending on current smoke coverage changes.

Run: `node .\tests\ccx-stability-regressions.js`
Expected: FAIL until the live autoswitch path stops restoring prompts.

- [ ] **Step 3: Update the README contract**

```md
## Minimal Autoswitch Mode

`cdx` is intentionally conservative in the interactive path.

During autoswitch:

- exhaustion is detected from structured session state
- `cdx` stops the current session
- switches account
- resumes the exact same `sessionId`
- verifies that the reopened session is the same one

`cdx` does not:

- restore the last prompt
- autosubmit anything
- fall back to `fork`
- guess when session identity is uncertain
```

- [ ] **Step 4: Run the smoke and stability tests and verify they both pass**

Run: `node .\tests\smoke.js`
Expected: PASS

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md tests/smoke.js tests/ccx-stability-regressions.js
git commit -m "docs: lock minimal cdx autoswitch contract"
```

## Self-Review Checklist

### Spec coverage

- Autoswitch only on structured exhaustion: Task 3.
- Same-chat-only via `resume <sessionId>`: Task 4.
- Hard errors on uncertainty: Tasks 2 and 4.
- No prompt restore / no autosubmit / no visual sugar in live path: Tasks 1 and 4.
- Transparent CLI behavior and smoke coverage: Task 5.

### Placeholder scan

- No `TODO`, `TBD`, or vague “handle appropriately” language remains.
- Every code-changing step contains concrete code.
- Every verification step contains an exact command and expected outcome.

### Type consistency

- `createSessionIdentityTracker()` defined in Task 2 and reused consistently.
- `createSwitchOrchestrator()` defined in Task 4 and reused consistently.
- `createOutputPipeline()` simplified in Task 1 and referenced consistently afterward.

## Handoff Notes

- Execute Tasks 1-4 in order; each reduces live-path complexity before tightening the next invariant.
- If any step reveals that a remaining convenience feature still participates in correctness, delete it instead of patching around it.
- Do not reintroduce prompt restore or autosubmit while implementing this plan.
