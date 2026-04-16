# CDX Transparent Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `cdx` into the primary transparent `codex` wrapper, move the current account-management menu to `cdx manual`, and keep `ccx` only as a compatibility alias.

**Architecture:** Split the current monolithic entrypoints into a small dispatcher, a reusable wrapper shell, and a manual account-manager module. Preserve the existing smart-switch internals, but move them behind explicit modules so wrapped interactive behavior and menu/admin behavior stop sharing one top-level control path.

**Tech Stack:** Node.js 18+, CommonJS, `node-pty`, `@clack/prompts`, built-in `assert`, existing `tests/*.js` scripts

---

## File Map

### Existing files to keep and refactor

- `bin/cdx.js`
  - today: account-manager entrypoint plus smart-switch API plus exported internals
  - target: thin CLI entrypoint that delegates to dispatcher logic and re-exports internals from extracted modules
- `bin/ccx.js`
  - today: full wrapper implementation
  - target: compatibility alias that forwards to the same wrapper runtime used by `cdx`
- `tests/regressions.js`
  - current regression coverage for `cdx` internals and account-manager behavior
  - target: keep account-manager tests and add dispatcher/manual-mode tests
- `tests/ccx-regressions.js`
  - current wrapper-focused tests
  - target: keep wrapper tests but update imports and expectations to point at the new shared wrapper module
- `tests/smoke.js`
  - current smoke test for `bin/cdx.js`
  - target: verify `cdx` still fails correctly in non-TTY wrapper mode and that `cdx manual` still rejects non-TTY the same way
- `README.md`
  - update command model and installation usage
- `package.json`
  - update description and, if needed, bin/help metadata wording

### New files to create

- `lib/cdx/dispatcher.js`
  - pure argv/TTY routing
- `lib/cdx/manual.js`
  - extracted manual account-manager UI entrypoint and helpers wiring
- `lib/cdx/smart-switch.js`
  - extracted machine-readable switching API wrapper around existing internals
- `lib/cdx/wrapper.js`
  - shared transparent/wrapped Codex shell used by both `bin/cdx.js` and `bin/ccx.js`

### Existing wrapper helper files to keep as-is initially

- `lib/ccx/current-account.js`
- `lib/ccx/fallback.js`
- `lib/ccx/input-buffer.js`
- `lib/ccx/output-style.js`
- `lib/ccx/prefill.js`
- `lib/ccx/prompt-state.js`
- `lib/ccx/runtime.js`
- `lib/ccx/session-log.js`
- `lib/ccx/startup-ui.js`
- `lib/ccx/status-ui.js`
- `lib/ccx/terminal-state.js`

These helpers already exist and should be reused through `lib/cdx/wrapper.js` before any rename/re-homing work. Do not add file moves in the same implementation pass as the command-model migration.

## Task 1: Add dispatcher contract tests and create the dispatcher module

**Files:**
- Create: `lib/cdx/dispatcher.js`
- Modify: `tests/regressions.js`
- Test: `tests/regressions.js`

- [ ] **Step 1: Write the failing dispatcher tests**

Add these tests near the end of `tests/regressions.js` before `main()` closes:

```js
await run("dispatches manual and smart-switch modes explicitly", async () => {
  const { decideCdxMode } = require("../lib/cdx/dispatcher");

  assert.deepEqual(
    decideCdxMode({ args: ["manual"], isTTY: true }),
    { kind: "manual", forwardedArgs: [] },
  );

  assert.deepEqual(
    decideCdxMode({ args: ["smart-switch", "--json"], isTTY: false }),
    { kind: "smart-switch-json", forwardedArgs: [] },
  );
});

await run("routes codex-style invocations to the wrapper lane", async () => {
  const { decideCdxMode } = require("../lib/cdx/dispatcher");

  assert.deepEqual(
    decideCdxMode({ args: [], isTTY: true }),
    { kind: "wrapper", forwardedArgs: [] },
  );

  assert.deepEqual(
    decideCdxMode({ args: ["resume", "--last"], isTTY: true }),
    { kind: "wrapper", forwardedArgs: ["resume", "--last"] },
  );

  assert.deepEqual(
    decideCdxMode({ args: ["exec", "print('hi')"], isTTY: false }),
    { kind: "wrapper", forwardedArgs: ["exec", "print('hi')"] },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\regressions.js
```

Expected: FAIL with `Cannot find module '../lib/cdx/dispatcher'`.

- [ ] **Step 3: Write the minimal dispatcher implementation**

Create `lib/cdx/dispatcher.js`:

```js
"use strict";

function decideCdxMode({ args, isTTY }) {
  const forwardedArgs = Array.isArray(args) ? [...args] : [];

  if (forwardedArgs[0] === "manual") {
    return { kind: "manual", forwardedArgs: forwardedArgs.slice(1) };
  }

  if (
    forwardedArgs[0] === "smart-switch" &&
    forwardedArgs.length === 2 &&
    forwardedArgs[1] === "--json"
  ) {
    return { kind: "smart-switch-json", forwardedArgs: [] };
  }

  return {
    kind: "wrapper",
    forwardedArgs,
    isTTY: !!isTTY,
  };
}

module.exports = {
  decideCdxMode,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node .\tests\regressions.js
```

Expected: PASS with new `ok - dispatches ...` and `ok - routes ...` lines.

- [ ] **Step 5: Commit**

```powershell
git add tests/regressions.js lib/cdx/dispatcher.js
git commit -m "test: add cdx dispatcher contract"
```

## Task 2: Extract the current menu flow into `cdx manual`

**Files:**
- Create: `lib/cdx/manual.js`
- Modify: `bin/cdx.js`
- Modify: `tests/regressions.js`
- Test: `tests/regressions.js`

- [ ] **Step 1: Write the failing manual-entrypoint tests**

Add these tests to `tests/regressions.js`:

```js
await run("exports a reusable manual entrypoint", async () => {
  const manual = require("../lib/cdx/manual");
  assert.equal(typeof manual.runManualEntryPoint, "function");
});

await run("keeps smart-switch internals available after manual extraction", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-plan-manual-"), CODEX_HOME: mkTempDir("cdx-plan-home-") }, async (internal) => {
    assert.equal(typeof internal.runSmartSwitchOperation, "function");
    assert.equal(typeof internal.ensureState, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\regressions.js
```

Expected: FAIL with `Cannot find module '../lib/cdx/manual'`.

- [ ] **Step 3: Write the minimal extraction**

Create `lib/cdx/manual.js` with a narrow wrapper around the existing `bin/cdx.js` helpers:

```js
"use strict";

async function runManualEntryPoint(deps) {
  const {
    ensureState,
    requireTTY,
    runInteractive,
    PromptCancelledError,
    loadPrompts,
    die,
  } = deps;

  requireTTY();
  const migration = ensureState();

  try {
    await runInteractive(migration);
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      const p = await loadPrompts();
      p.cancel("Operation cancelled");
      process.exit(1);
    }
    die(err.message || String(err));
  }
}

module.exports = {
  runManualEntryPoint,
};
```

Then, in `bin/cdx.js`, import it and replace the current bottom-of-file interactive branch with:

```js
const { runManualEntryPoint } = require("../lib/cdx/manual");
```

and later:

```js
await runManualEntryPoint({
  ensureState,
  requireTTY,
  runInteractive,
  PromptCancelledError,
  loadPrompts,
  die,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node .\tests\regressions.js
```

Expected: PASS with new `ok - exports a reusable manual entrypoint` line and no regressions in account-manager tests.

- [ ] **Step 5: Commit**

```powershell
git add lib/cdx/manual.js bin/cdx.js tests/regressions.js
git commit -m "refactor: extract cdx manual entrypoint"
```

## Task 3: Extract the current `ccx` runtime into a shared wrapper module

**Files:**
- Create: `lib/cdx/wrapper.js`
- Modify: `bin/ccx.js`
- Modify: `tests/ccx-regressions.js`
- Test: `tests/ccx-regressions.js`

- [ ] **Step 1: Write the failing shared-wrapper tests**

Add these tests near the top of `tests/ccx-regressions.js` after the helper declarations:

```js
await run("exports a shared cdx wrapper entrypoint", async () => {
  const wrapper = require("../lib/cdx/wrapper");
  assert.equal(typeof wrapper.runCodexWrapper, "function");
});

await run("keeps bin/ccx as a thin compatibility entrypoint", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "bin", "ccx.js"), "utf8");
  assert.match(source, /runCodexWrapper/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\ccx-regressions.js
```

Expected: FAIL with `Cannot find module '../lib/cdx/wrapper'`.

- [ ] **Step 3: Write the minimal wrapper extraction**

Create `lib/cdx/wrapper.js`:

```js
"use strict";

async function runCodexWrapper(options = {}) {
  const {
    mainImpl,
    argv,
  } = options;

  return mainImpl({
    forwardedArgs: Array.isArray(argv) ? argv : [],
  });
}

module.exports = {
  runCodexWrapper,
};
```

Then adapt `bin/ccx.js` so its `main()` delegates through this module rather than remaining the only home of the wrapper contract:

```js
const { runCodexWrapper } = require("../lib/cdx/wrapper");
```

and near the bottom:

```js
runCodexWrapper({
  argv: process.argv.slice(2),
  mainImpl: async ({ forwardedArgs }) => {
    // existing wrapper body, using forwardedArgs instead of process.argv.slice(2)
  },
}).catch((err) => {
  process.stderr.write(`ccx: ${err.message || String(err)}\n`);
  process.exit(1);
});
```

Do not move helper logic out of `bin/ccx.js` yet. This task only creates the shared seam.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node .\tests\ccx-regressions.js
```

Expected: PASS with new `ok - exports a shared cdx wrapper entrypoint` line and all existing wrapper regressions still green.

- [ ] **Step 5: Commit**

```powershell
git add lib/cdx/wrapper.js bin/ccx.js tests/ccx-regressions.js
git commit -m "refactor: add shared cdx wrapper entrypoint"
```

## Task 4: Rewire `bin/cdx.js` to dispatch between wrapper, manual mode, and smart-switch JSON

**Files:**
- Modify: `bin/cdx.js`
- Modify: `tests/regressions.js`
- Modify: `tests/smoke.js`
- Test: `tests/regressions.js`
- Test: `tests/smoke.js`

- [ ] **Step 1: Write the failing top-level CLI behavior tests**

Add these tests to `tests/regressions.js`:

```js
await run("keeps smart-switch json as an explicit subcommand", async () => {
  const { decideCdxMode } = require("../lib/cdx/dispatcher");
  assert.equal(decideCdxMode({ args: ["smart-switch", "--json"], isTTY: false }).kind, "smart-switch-json");
});
```

Update `tests/smoke.js` so it verifies both default wrapper mode and `manual` mode reject non-TTY correctly:

```js
const defaultResult = spawnSync(process.execPath, ["bin/cdx.js"], { encoding: "utf8" });
const manualResult = spawnSync(process.execPath, ["bin/cdx.js", "manual"], { encoding: "utf8" });

for (const result of [defaultResult, manualResult]) {
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 1) {
    process.exit(1);
  }
  if (!/interactive terminal required/i.test(output)) {
    process.exit(1);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\smoke.js
```

Expected: FAIL because `bin/cdx.js manual` still routes into the old "subcommands were removed" branch.

- [ ] **Step 3: Implement the dispatcher-driven `cdx` entrypoint**

In `bin/cdx.js`, import the new modules:

```js
const { decideCdxMode } = require("../lib/cdx/dispatcher");
const { runManualEntryPoint } = require("../lib/cdx/manual");
const { runCodexWrapper } = require("../lib/cdx/wrapper");
```

Replace the current `main()` branching with:

```js
async function main() {
  const args = process.argv.slice(2);
  const mode = decideCdxMode({
    args,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  });

  if (mode.kind === "smart-switch-json") {
    const result = await runSmartSwitchOperation({ outputJson: true, forceRefreshLiveLimits: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 2);
  }

  if (mode.kind === "manual") {
    if (mode.forwardedArgs.length > 0) {
      die("usage: cdx manual");
    }
    await runManualEntryPoint({
      ensureState,
      requireTTY,
      runInteractive,
      PromptCancelledError,
      loadPrompts,
      die,
    });
    return;
  }

  await runCodexWrapper({
    argv: mode.forwardedArgs,
    mainImpl: require("./ccx.js")._internalMain,
  });
}
```

Also export `_internal.main = main` only if needed by tests, and remove the old "subcommands were removed" path.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
node .\tests\smoke.js
node .\tests\regressions.js
```

Expected:

- `tests/smoke.js` exits successfully
- `tests/regressions.js` stays green

- [ ] **Step 5: Commit**

```powershell
git add bin/cdx.js tests/regressions.js tests/smoke.js
git commit -m "feat: make cdx dispatch wrapper and manual modes"
```

## Task 5: Turn `bin/ccx.js` into a compatibility alias over the new `cdx` wrapper core

**Files:**
- Modify: `bin/ccx.js`
- Modify: `tests/ccx-regressions.js`
- Test: `tests/ccx-regressions.js`

- [ ] **Step 1: Write the failing alias test**

Add this test to `tests/ccx-regressions.js`:

```js
await run("bin/ccx delegates to the shared cdx wrapper entrypoint", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "bin", "ccx.js"), "utf8");
  assert.match(source, /require\(\"..\/lib\/cdx\/wrapper\"\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\ccx-regressions.js
```

Expected: FAIL if `bin/ccx.js` still contains duplicate top-level bootstrapping and does not cleanly delegate through the shared wrapper entrypoint.

- [ ] **Step 3: Implement the compatibility alias**

Refactor `bin/ccx.js` so it exports the wrapper implementation for reuse and keeps the CLI path tiny:

```js
async function internalMain({ forwardedArgs }) {
  const args = Array.isArray(forwardedArgs) ? forwardedArgs : process.argv.slice(2);
  // existing wrapper implementation body
}

module.exports = {
  _internalMain: internalMain,
};

if (require.main === module) {
  const { runCodexWrapper } = require("../lib/cdx/wrapper");
  runCodexWrapper({ argv: process.argv.slice(2), mainImpl: internalMain }).catch((err) => {
    process.stderr.write(`ccx: ${err.message || String(err)}\n`);
    process.exit(1);
  });
}
```

The important part is single-sourcing the wrapper body, not changing the helper behavior.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node .\tests\ccx-regressions.js
```

Expected: PASS with all existing wrapper regressions still green.

- [ ] **Step 5: Commit**

```powershell
git add bin/ccx.js tests/ccx-regressions.js
git commit -m "refactor: keep ccx as alias over shared wrapper"
```

## Task 6: Extract the smart-switch API seam and update user-facing docs

**Files:**
- Create: `lib/cdx/smart-switch.js`
- Modify: `bin/cdx.js`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `tests/regressions.js`
- Test: `tests/regressions.js`
- Test: `tests/smoke.js`

- [ ] **Step 1: Write the failing smart-switch seam and README expectations**

Add this test to `tests/regressions.js`:

```js
await run("exports a reusable smart-switch json entrypoint", async () => {
  const smartSwitch = require("../lib/cdx/smart-switch");
  assert.equal(typeof smartSwitch.runSmartSwitchJsonCommand, "function");
});
```

Also update `README.md` in the plan branch expectation so it documents:

````md
Run:

```bash
cdx
```

to use Codex through the transparent wrapper, and:

```bash
cdx manual
```

to manage accounts manually.
````

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node .\tests\regressions.js
```

Expected: FAIL with `Cannot find module '../lib/cdx/smart-switch'`.

- [ ] **Step 3: Implement the smart-switch seam and docs**

Create `lib/cdx/smart-switch.js`:

```js
"use strict";

async function runSmartSwitchJsonCommand({ runSmartSwitchOperation, stdout, exit }) {
  const result = await runSmartSwitchOperation({
    outputJson: true,
    forceRefreshLiveLimits: true,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  exit(result.ok ? 0 : 2);
}

module.exports = {
  runSmartSwitchJsonCommand,
};
```

Use it from `bin/cdx.js` instead of inlining the JSON branch.

Update `README.md` to describe the new command model, for example:

````md
Commands installed:
- `cdx` (primary wrapper for Codex)
- `cxs` (alias of `cdx`)
- `ccx` (compatibility alias of `cdx`)

Daily use:

```bash
cdx
cdx resume --last
cdx exec "summarize this repo"
```

Account management:

```bash
cdx manual
cdx smart-switch --json
```
````

Update `package.json` description:

```json
"description": "Transparent Codex wrapper with account switching and manual account management"
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
node .\tests\regressions.js
node .\tests\smoke.js
```

Expected: PASS on both scripts.

- [ ] **Step 5: Commit**

```powershell
git add lib/cdx/smart-switch.js bin/cdx.js README.md package.json tests/regressions.js
git commit -m "docs: document cdx as primary codex wrapper"
```

## Task 7: Final integration verification

**Files:**
- Modify: `tests/smoke.js` (only if missing assertions after integration)
- Test: `tests/smoke.js`
- Test: `tests/regressions.js`
- Test: `tests/ccx-regressions.js`

- [ ] **Step 1: Add final smoke coverage for alias commands if still missing**

If `tests/smoke.js` does not yet cover both wrapper entrypoints, extend it with:

```js
const ccxResult = spawnSync(process.execPath, ["bin/ccx.js"], {
  encoding: "utf8",
});

const ccxOutput = `${ccxResult.stdout || ""}${ccxResult.stderr || ""}`;
if (ccxResult.status !== 1) {
  process.exit(1);
}
if (!/interactive terminal required/i.test(ccxOutput)) {
  process.exit(1);
}
```

- [ ] **Step 2: Run the full test suite**

Run:

```powershell
npm.cmd test
```

Expected:

```text
> codex-account-switcher@0.2.0 test
> npm run test:smoke && npm run test:regressions && npm run test:ccx
```

and all three scripts exit successfully.

- [ ] **Step 3: Run manual help verification**

Run:

```powershell
node .\bin\cdx.js manual
```

Expected: in a non-TTY harness this exits with `interactive terminal required`; in a real TTY it should open the existing manual menu.

- [ ] **Step 4: Sanity-check wrapper passthrough help**

Run:

```powershell
node .\bin\cdx.js --help
```

Expected: `codex --help` style output, not the old `cdx` menu-only behavior.

- [ ] **Step 5: Commit**

```powershell
git add tests/smoke.js
git commit -m "test: verify cdx wrapper integration"
```

## Self-Review

### Spec coverage

- `cdx` becomes the main wrapper command: covered by Tasks 1, 3, 4, and 7.
- `cdx manual` becomes the menu/account-manager entrypoint: covered by Tasks 2 and 4.
- `cdx smart-switch --json` remains stable: covered by Tasks 1, 4, and 6.
- `ccx` remains a compatibility alias: covered by Tasks 3, 5, and 7.
- Transparent passthrough vs wrapped interactive separation: covered by Tasks 1, 3, 4, and 7.
- Shortcut semantics and wrapper behavior preservation: carried forward by reusing the current wrapper implementation in Task 3 and validating through `tests/ccx-regressions.js` in Tasks 5 and 7.
- Wrapper stays visually close to Codex while manual mode carries the richer UI: covered by preserving the existing wrapper behavior in Tasks 3-5 and moving only the menu entrypoint in Tasks 2 and 4.

### Placeholder scan

- No `TODO` or `TBD` markers remain.
- Every task names exact files.
- Every code-changing step includes concrete code blocks.
- Every verification step includes runnable commands and expected outcomes.

### Type consistency

- Dispatcher API stays `decideCdxMode({ args, isTTY })`.
- Wrapper API stays `runCodexWrapper({ argv, mainImpl })`.
- Manual entrypoint stays `runManualEntryPoint(deps)`.
- Smart-switch seam stays `runSmartSwitchJsonCommand({ runSmartSwitchOperation, stdout, exit })`.
