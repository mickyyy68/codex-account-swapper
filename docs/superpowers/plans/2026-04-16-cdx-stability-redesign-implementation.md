# CDX Stability Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cdx` behave like a transparent `codex` wrapper again while preserving automatic account switching on confirmed usage exhaustion.

**Architecture:** The implementation splits the current wrapped runtime into a transparent PTY transport plus an observer-driven autoswitch path. Input and output stop making semantic decisions in the critical path; session logs become the canonical source for exhaustion and prompt recovery.

**Tech Stack:** Node.js, `node-pty`, Powershell/Windows TTY behavior, local session-log parsing, existing `cdx` smart-switch internals.

---

## File Map

- Modify: `bin/ccx.js`
  - Remove submit-time prompt inference from the input path.
  - Wire in a simplified output lane and an observer-driven autoswitch lane.
- Create: `lib/ccx/output-pipeline.js`
  - Near-pass-through output helper for the wrapped interactive session.
- Create: `lib/ccx/session-observer.js`
  - Observer that reads structured session state and emits strong events (`user_message`, exhaustion).
- Modify: `lib/ccx/session-log.js`
  - Add narrowly scoped helpers for reading the latest canonical `user_message` and post-baseline exhaustion state.
- Modify: `lib/ccx/prompt-state.js`
  - Restrict visible-prompt fallback to safe cases only; no approval-UI false positives.
- Modify: `lib/ccx/output-style.js`
  - Remove critical-path responsibilities; keep only optional helpers needed outside the transport path.
- Create: `tests/ccx-stability-regressions.js`
  - Focused, no-spawn regression suite for stability invariants.
- Modify: `tests/smoke.js`
  - Keep top-level command expectations aligned with `cdx`.
- Modify: `README.md`
  - Document the stabilized behavior: transparent wrapper first, autoswitch core, optional visual sugar secondary.

## Execution Notes

- Use TDD for each task.
- Prefer `tests/ccx-stability-regressions.js` for deterministic iteration before touching the broader legacy suite.
- The existing `tests/ccx-regressions.js` contains spawn-based coverage that may still be useful, but it should not block the stabilization workstream until the core runtime is stable again.

### Task 1: Add a Dedicated Stability Regression Suite

**Files:**
- Create: `tests/ccx-stability-regressions.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Write the failing stability tests**

```js
#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  resolvePendingPrompt,
} = require("../lib/ccx/prompt-state");
const {
  createUserPromptOutputTransformer,
} = require("../lib/ccx/output-style");

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exit(1);
  }
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

run("normal output chunks are not buffered waiting for newlines", () => {
  const transformer = createUserPromptOutputTransformer();
  assert.equal(transformer.transform("assistant partial chunk"), "assistant partial chunk");
});

run("footer badge still appears for real codex footer lines", () => {
  const transformer = createUserPromptOutputTransformer();
  assert.equal(transformer.transform("  gpt-5.4 xhigh"), "");
  const output = transformer.transform(" · ~\\Documents\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
});

process.stdout.write("all cdx stability regression tests passed\n");
```

- [ ] **Step 2: Run the new suite to verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL on the approval-ui or buffering assertions against the current runtime.

- [ ] **Step 3: Commit the red test file**

```bash
git add tests/ccx-stability-regressions.js
git commit -m "test: add cdx stability regression suite"
```

### Task 2: Make Visible-Prompt Recovery Conservative

**Files:**
- Modify: `lib/ccx/prompt-state.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add a failing multiline + footer + approval test case if missing**

```js
run("visible multiline prompt survives footer lines but not approval ui", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh · ~\\Documents\\repo",
      ].join("\n"),
    ),
    "leggi il progetto\n  su piu righe",
  );
});
```

- [ ] **Step 2: Run the focused suite and verify the new prompt-state case fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL with a mismatch around `resolvePendingPrompt(...)`.

- [ ] **Step 3: Implement conservative trailing-prompt parsing**

```js
const PROMPT_MARKER_REGEX = new RegExp(`^[ \\t]*(?:${PROMPT_MARKER_PATTERN})[ \\t]*`);

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function isCodexFooterLine(line) {
  const plain = stripAnsi(line).trimEnd();
  return !!plain && /[\\/]/.test(plain) && /^\s*\S+\s+\S+\s+.\s+.+$/.test(plain);
}

function isIgnorableTrailingLine(line) {
  const plain = stripAnsi(line).trim();
  return !plain || isCodexFooterLine(line);
}

function isPromptLine(line) {
  return PROMPT_MARKER_REGEX.test(stripAnsi(line));
}

function isPromptContinuationLine(line) {
  return /^[ \t]+\S/.test(stripAnsi(line));
}

function extractVisiblePromptDraft(buffer) {
  const lines = String(buffer || "").split(/\r?\n/);
  let endIndex = lines.length - 1;

  while (endIndex >= 0 && isIgnorableTrailingLine(lines[endIndex])) {
    endIndex -= 1;
  }
  if (endIndex < 0) {
    return "";
  }

  const continuation = [];
  let cursor = endIndex;
  while (cursor >= 0 && isPromptContinuationLine(lines[cursor])) {
    continuation.unshift(stripAnsi(lines[cursor]).replace(/[ \t]+$/u, ""));
    cursor -= 1;
  }
  if (cursor < 0 || !isPromptLine(lines[cursor])) {
    return "";
  }

  const firstLine = stripAnsi(lines[cursor]).replace(PROMPT_MARKER_REGEX, "").trimEnd();
  return [firstLine, ...continuation].filter(Boolean).join("\n");
}
```

- [ ] **Step 4: Run the focused suite and verify it passes**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: PASS on all prompt-state cases.

- [ ] **Step 5: Commit**

```bash
git add lib/ccx/prompt-state.js tests/ccx-stability-regressions.js
git commit -m "fix: harden visible prompt fallback in cdx"
```

### Task 3: Simplify the Output Lane to Pass-Through by Default

**Files:**
- Create: `lib/ccx/output-pipeline.js`
- Modify: `bin/ccx.js`
- Modify: `lib/ccx/output-style.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add a failing no-buffering test for the new output lane**

```js
run("transparent output lane passes normal chunks through immediately", () => {
  const { createOutputPipeline } = require("../lib/ccx/output-pipeline");
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("assistant partial chunk"), "assistant partial chunk");
});
```

- [ ] **Step 2: Run the stability suite and verify the new output-lane case fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL because `lib/ccx/output-pipeline.js` does not exist yet.

- [ ] **Step 3: Create the new near-pass-through output pipeline**

```js
"use strict";

const { maybeAppendFooterBadge } = require("./output-style");

function createOutputPipeline(options = {}) {
  const enableFooterBadge = options.enableFooterBadge === true;
  let pendingFooter = "";

  function transform(chunk) {
    const input = String(chunk || "");
    if (!input) {
      return "";
    }

    if (!enableFooterBadge) {
      return input;
    }

    const candidate = `${pendingFooter}${input}`;
    const lineBreakIndex = candidate.search(/[\r\n]/);
    if (pendingFooter && lineBreakIndex !== -1) {
      const line = candidate.slice(0, lineBreakIndex);
      const lineBreak = candidate[lineBreakIndex] === "\r" && candidate[lineBreakIndex + 1] === "\n"
        ? "\r\n"
        : candidate[lineBreakIndex];
      const nextIndex = lineBreak === "\r\n" ? lineBreakIndex + 2 : lineBreakIndex + 1;
      pendingFooter = "";
      return `${maybeAppendFooterBadge(line)}${lineBreak}${candidate.slice(nextIndex)}`;
    }

    if (/^\s{2,}\S+\s+\S+$/.test(input)) {
      pendingFooter = input;
      return "";
    }

    return input;
  }

  function flush() {
    const tail = pendingFooter ? maybeAppendFooterBadge(pendingFooter) : "";
    pendingFooter = "";
    return tail;
  }

  function reset() {
    pendingFooter = "";
  }

  return { transform, flush, reset };
}

module.exports = {
  createOutputPipeline,
};
```

- [ ] **Step 4: Rewire the wrapped runtime to use the new output pipeline**

```js
const { createOutputPipeline } = require("../lib/ccx/output-pipeline");

// inside launchCodex(...)
const outputPipeline = createOutputPipeline({ enableFooterBadge: true });
state.outputTransformer = outputPipeline;

child.onData((data) => {
  process.stdout.write(outputPipeline.transform(data));
  state.outputBuffer = updateOutputBuffer(state.outputBuffer, data);
  updateSessionIdentityFromOutput();
  schedulePrefill();
});
```

- [ ] **Step 5: Run the stability suite and verify it passes**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: PASS, including immediate pass-through of normal chunks.

- [ ] **Step 6: Commit**

```bash
git add lib/ccx/output-pipeline.js lib/ccx/output-style.js bin/ccx.js tests/ccx-stability-regressions.js
git commit -m "refactor: simplify cdx output pipeline"
```

### Task 4: Move Autoswitch Triggering to a Session Observer

**Files:**
- Create: `lib/ccx/session-observer.js`
- Modify: `lib/ccx/session-log.js`
- Modify: `bin/ccx.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add a failing observer test that uses strong signals only**

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
    latestUserMessage: "leggi il progetto",
  };

  await new Promise((resolve) => setTimeout(resolve, 20));
  observer.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, "leggi il progetto");
});
```

- [ ] **Step 2: Run the stability suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL because `lib/ccx/session-observer.js` does not exist yet.

- [ ] **Step 3: Add a small observer module**

```js
"use strict";

function createSessionObserver(options = {}) {
  const readSessionState = options.readSessionState;
  const onUsageLimitExceeded = options.onUsageLimitExceeded;
  const intervalMs = options.intervalMs || 100;
  let timer = null;
  let lastSeenErrorKey = "";

  function poll() {
    const state = readSessionState();
    if (!state || !state.latestError || state.latestError.code !== "usage_limit_exceeded") {
      return;
    }

    const errorKey = `${state.latestError.code}:${state.latestError.timestamp || ""}`;
    if (errorKey === lastSeenErrorKey) {
      return;
    }
    lastSeenErrorKey = errorKey;
    onUsageLimitExceeded({
      prompt: state.latestUserMessage || "",
      sessionState: state,
    });
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(poll, intervalMs);
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

module.exports = {
  createSessionObserver,
};
```

- [ ] **Step 4: Extend session-log state to expose the latest user message**

```js
function readLatestSessionStateFromSessionFile(filePath) {
  // keep existing rate-limit/error parsing
  // add latestUserMessage to the returned object
  return {
    rateLimits,
    latestError,
    latestUserMessage,
  };
}
```

- [ ] **Step 5: Run the stability suite and verify it passes**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: PASS on the observer tests.

- [ ] **Step 6: Commit**

```bash
git add lib/ccx/session-observer.js lib/ccx/session-log.js tests/ccx-stability-regressions.js
git commit -m "feat: add observer-driven cdx exhaustion detection"
```

### Task 5: Remove Submit-Time Semantics from the Input Path

**Files:**
- Modify: `bin/ccx.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add a failing regression test for "approval enter does not become prompt submit"**

```js
run("input path no longer depends on visible prompt fallback for submit semantics", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");
  assert.doesNotMatch(source, /resolvePendingPrompt\(state\.draftBuffer,\s*state\.outputBuffer\)/);
});
```

- [ ] **Step 2: Run the stability suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL because `bin/ccx.js` still resolves submits from visible output.

- [ ] **Step 3: Make the input path transport-only**

```js
async function onInput(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const escapeRequested = chunkRequestsEscape(text);

  if (chunkRequestsAbort(text)) {
    cleanup();
    process.exit(130);
    return;
  }

  if (state.switching || !state.ptyProcess) {
    return;
  }

  const inputState = applyInputChunk(state.draftBuffer, text);
  state.draftBuffer = escapeRequested ? "" : inputState.draft;

  if (escapeRequested && state.outputTransformer && typeof state.outputTransformer.reset === "function") {
    state.outputTransformer.reset();
    state.outputBuffer = "";
  }

  for (const chunk of getForwardingChunks(text)) {
    state.ptyProcess.write(chunk);
  }
}
```

- [ ] **Step 4: Move prompt recovery to the exhaustion observer path**

```js
async function handleUsageLimitExceeded(event) {
  const canonicalPrompt = event.prompt || getCanonicalSubmittedPrompt(state.lastSubmittedPrompt);
  await reopenWithSmartSwitch(canonicalPrompt);
}
```

- [ ] **Step 5: Run the stability suite and verify it passes**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: PASS, and `bin/ccx.js` no longer depends on visible prompt fallback in the submit path.

- [ ] **Step 6: Commit**

```bash
git add bin/ccx.js tests/ccx-stability-regressions.js
git commit -m "refactor: remove cdx submit-time prompt inference"
```

### Task 6: Make Autoswitch Resume-Only for the Stabilization Pass

**Files:**
- Modify: `bin/ccx.js`
- Modify: `README.md`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add a failing test that documents the stabilization contract**

```js
run("stabilization contract prefers resume and prompt restore over autosubmit", () => {
  const source = require("node:fs").readFileSync("bin/ccx.js", "utf8");
  assert.doesNotMatch(source, /autoSubmitPrefill:\s*true/);
});
```

- [ ] **Step 2: Run the stability suite and verify it fails**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: FAIL because the current switch path still requests autosubmit.

- [ ] **Step 3: Disable autosubmit in the stabilized reopen path**

```js
await launchCodex(["resume", previousSessionId], {
  prefillText: canonicalPrompt,
  autoSubmitPrefill: false,
});
state.switching = false;
```

- [ ] **Step 4: Update the README contract**

```md
## Interactive Wrapper Stability Mode

`cdx` keeps autoswitch enabled on confirmed usage exhaustion.

In the stabilization path:

- `cdx` resumes the session automatically
- restores the last canonical user prompt
- does not autosubmit that prompt until the transparent wrapper core is fully hardened
```

- [ ] **Step 5: Run the stability suite and verify it passes**

Run: `node .\tests\ccx-stability-regressions.js`

Expected: PASS, with no autosubmit in the stabilization contract.

- [ ] **Step 6: Commit**

```bash
git add bin/ccx.js README.md tests/ccx-stability-regressions.js
git commit -m "fix: stabilize cdx by disabling autosubmit"
```

### Task 7: Verify the Public Command Contract Still Holds

**Files:**
- Modify: `tests/smoke.js`
- Test: `tests/smoke.js`
- Test: `tests/ccx-stability-regressions.js`

- [ ] **Step 1: Add or tighten smoke expectations for top-level `cdx`**

```js
const defaultResult = spawnSync(process.execPath, ["bin/cdx.js"], { encoding: "utf8" });
const defaultOutput = `${defaultResult.stdout || ""}${defaultResult.stderr || ""}`;

if (!/cdx: interactive terminal required/i.test(defaultOutput)) {
  process.exit(1);
}
if (/ccx: interactive terminal required/i.test(defaultOutput)) {
  process.exit(1);
}
```

- [ ] **Step 2: Run smoke and stability tests**

Run: `node .\tests\smoke.js`
Expected: PASS

Run: `node .\tests\ccx-stability-regressions.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.js tests/ccx-stability-regressions.js
git commit -m "test: lock cdx stability wrapper contract"
```

## Self-Review Checklist

### Spec coverage

- Transparent interactive path: covered by Tasks 3 and 5.
- Autoswitch as mandatory core behavior: covered by Tasks 4 and 6.
- Strong-signal exhaustion only: covered by Tasks 2 and 4.
- Removal of fragile TUI-driven semantics: covered by Tasks 2, 3, and 5.
- Optional visual sugar de-prioritized: covered by Tasks 3 and 6.
- Public command compatibility: covered by Task 7.

### Placeholder scan

- No `TODO`, `TBD`, or "implement later" markers remain.
- Every code-changing step contains concrete code.
- Every verification step includes an exact command and expected outcome.

### Type / naming consistency

- `createOutputPipeline()` is introduced consistently in Task 3.
- `createSessionObserver()` is introduced consistently in Task 4.
- `resolvePendingPrompt()` remains the conservative fallback helper, not an input-path dependency.

## Handoff Notes

- Execute the tasks in order. Task 5 depends on the observer from Task 4 and the simplified output lane from Task 3.
- Do not reintroduce autosubmit or complex styling while stabilizing the transport path.
- If a task reveals that an optional visual feature still affects correctness, delete or disable that feature rather than patching around it.
