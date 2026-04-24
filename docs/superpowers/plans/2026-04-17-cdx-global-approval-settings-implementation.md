# CDX Global Approval Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global `CDX settings` menu to `cdx manual` with a saved `Approval policy`, and make `cdx` launch Codex with that policy by default unless the user already passed an explicit override.

**Architecture:** Add a small settings storage module under `lib/cdx/` for reading and writing `~/.cdx/settings.json`. Extend the manual UI in `bin/cdx.js` with a `CDX settings` action that edits the global approval policy. Inject `-a <policy>` into wrapper-routed Codex launches only when forwarded args do not already contain `-a` or `--ask-for-approval`.

**Tech Stack:** Node.js, existing `@clack/prompts` manual UI flow, current `cdx` wrapper runtime, JSON file storage under `~/.cdx`.

---

## File Structure

- `lib/cdx/settings.js`
  - global settings storage helpers
  - validation for `approvalPolicy`
  - read/write behavior for `~/.cdx/settings.json`
- `bin/cdx.js`
  - manual UI integration (`CDX settings`)
  - launch-time injection of `-a <policy>`
- `tests/smoke.js`
  - contract-level checks for wrapper CLI behavior
- `tests/cdx-settings-regressions.js`
  - focused deterministic tests for settings storage, CLI injection, and override precedence
- `README.md`
  - user-facing docs for `CDX settings` and approval policy behavior

---

### Task 1: Add Global Settings Storage

**Files:**
- Create: `lib/cdx/settings.js`
- Create: `tests/cdx-settings-regressions.js`

- [ ] **Step 1: Write the failing tests for settings storage**

```js
run("reads missing settings file as empty settings", () => {
  const { readCdxSettings } = require("../lib/cdx/settings");
  const tempRoot = mkTempDir("cdx-settings-missing-");

  assert.deepEqual(
    readCdxSettings({ cdxDir: tempRoot }),
    {},
  );
});

run("ignores malformed settings files", () => {
  const { readCdxSettings } = require("../lib/cdx/settings");
  const tempRoot = mkTempDir("cdx-settings-malformed-");
  fs.writeFileSync(path.join(tempRoot, "settings.json"), "{not-json", "utf8");

  assert.deepEqual(
    readCdxSettings({ cdxDir: tempRoot }),
    {},
  );
});

run("roundtrips a valid approval policy", () => {
  const { readCdxSettings, writeCdxSettings } = require("../lib/cdx/settings");
  const tempRoot = mkTempDir("cdx-settings-roundtrip-");

  writeCdxSettings({ cdxDir: tempRoot, settings: { approvalPolicy: "on-request" } });

  assert.deepEqual(
    readCdxSettings({ cdxDir: tempRoot }),
    { approvalPolicy: "on-request" },
  );
});

run("drops invalid approval policies", () => {
  const { normalizeCdxSettings } = require("../lib/cdx/settings");

  assert.deepEqual(
    normalizeCdxSettings({ approvalPolicy: "invalid" }),
    {},
  );
});
```

- [ ] **Step 2: Run the new settings test file and verify it fails**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: FAIL with module-not-found or missing-export errors for `../lib/cdx/settings`.

- [ ] **Step 3: Write the minimal settings module**

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

function getCdxDir(options = {}) {
  return options.cdxDir || process.env.CDX_DIR || path.join(os.homedir(), ".cdx");
}

function getSettingsFilePath(options = {}) {
  return path.join(getCdxDir(options), "settings.json");
}

function normalizeCdxSettings(input = {}) {
  const settings = {};
  if (VALID_APPROVAL_POLICIES.has(input.approvalPolicy)) {
    settings.approvalPolicy = input.approvalPolicy;
  }
  return settings;
}

function readCdxSettings(options = {}) {
  const filePath = getSettingsFilePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeCdxSettings(parsed);
  } catch {
    return {};
  }
}

function writeCdxSettings(options = {}) {
  const cdxDir = getCdxDir(options);
  const filePath = getSettingsFilePath(options);
  const normalized = normalizeCdxSettings(options.settings || {});
  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

module.exports = {
  VALID_APPROVAL_POLICIES,
  getSettingsFilePath,
  normalizeCdxSettings,
  readCdxSettings,
  writeCdxSettings,
};
```

- [ ] **Step 4: Run the settings test file and verify it passes**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: PASS for the four settings storage cases above.

- [ ] **Step 5: Commit**

```bash
git add lib/cdx/settings.js tests/cdx-settings-regressions.js
git commit -m "feat: add cdx global settings storage"
```

---

### Task 2: Add `CDX settings` to `cdx manual`

**Files:**
- Modify: `bin/cdx.js`
- Test: `tests/cdx-settings-regressions.js`

- [ ] **Step 1: Write failing tests for manual settings integration**

```js
run("manual action list includes CDX settings", () => {
  const source = fs.readFileSync("bin/cdx.js", "utf8");
  assert.match(source, /value:\s*"settings",\s*label:\s*"CDX settings"/);
});

run("manual settings flow offers the three approval policies", () => {
  const source = fs.readFileSync("bin/cdx.js", "utf8");
  assert.match(source, /value:\s*"untrusted"/);
  assert.match(source, /value:\s*"on-request"/);
  assert.match(source, /value:\s*"never"/);
});
```

- [ ] **Step 2: Run the focused settings tests and verify they fail**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: FAIL because `bin/cdx.js` does not yet contain the new `settings` action.

- [ ] **Step 3: Add the manual settings action and flow**

Implementation shape in `bin/cdx.js`:

```js
const {
  readCdxSettings,
  writeCdxSettings,
} = require("../lib/cdx/settings");
```

Add top-level action:

```js
{ value: "settings", label: "CDX settings", hint: "Configure wrapper defaults" },
```

Add settings branch:

```js
if (action === "settings") {
  const currentSettings = readCdxSettings();
  const settingAction = await promptValue(
    p,
    p.select({
      message: "CDX settings",
      options: [
        {
          value: "approval-policy",
          label: "Approval policy",
          hint: currentSettings.approvalPolicy || "Codex default",
        },
        { value: "back", label: "Back" },
      ],
    }),
  );

  if (settingAction === "back") {
    continue;
  }

  const approvalPolicy = await promptValue(
    p,
    p.select({
      message: "Default approval policy",
      initialValue: currentSettings.approvalPolicy || "on-request",
      options: [
        { value: "untrusted", label: "untrusted" },
        { value: "on-request", label: "on-request" },
        { value: "never", label: "never" },
      ],
    }),
  );

  writeCdxSettings({
    settings: {
      ...currentSettings,
      approvalPolicy,
    },
  });
  p.log.success(`Saved approval policy '${approvalPolicy}'.`);
  continue;
}
```

- [ ] **Step 4: Run the settings tests again**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: PASS for the manual UI source-level assertions plus Task 1 tests.

- [ ] **Step 5: Commit**

```bash
git add bin/cdx.js tests/cdx-settings-regressions.js
git commit -m "feat: add cdx manual approval settings"
```

---

### Task 3: Inject Saved Approval Policy into Codex Launches

**Files:**
- Modify: `bin/cdx.js`
- Test: `tests/cdx-settings-regressions.js`
- Test: `tests/smoke.js`

- [ ] **Step 1: Write the failing tests for approval-policy injection**

Add deterministic helpers and tests:

```js
run("injects saved approval policy when cli args do not override it", () => {
  const { _internal } = require("../bin/cdx.js");

  assert.deepEqual(
    _internal.applySavedApprovalPolicy({
      forwardedArgs: ["resume", "--last"],
      settings: { approvalPolicy: "never" },
    }),
    ["-a", "never", "resume", "--last"],
  );
});

run("does not inject when short approval flag already exists", () => {
  const { _internal } = require("../bin/cdx.js");

  assert.deepEqual(
    _internal.applySavedApprovalPolicy({
      forwardedArgs: ["-a", "untrusted", "resume", "--last"],
      settings: { approvalPolicy: "never" },
    }),
    ["-a", "untrusted", "resume", "--last"],
  );
});

run("does not inject when long approval flag already exists", () => {
  const { _internal } = require("../bin/cdx.js");

  assert.deepEqual(
    _internal.applySavedApprovalPolicy({
      forwardedArgs: ["--ask-for-approval", "untrusted", "resume", "--last"],
      settings: { approvalPolicy: "never" },
    }),
    ["--ask-for-approval", "untrusted", "resume", "--last"],
  );
});

run("does not inject when no saved approval policy exists", () => {
  const { _internal } = require("../bin/cdx.js");

  assert.deepEqual(
    _internal.applySavedApprovalPolicy({
      forwardedArgs: ["resume", "--last"],
      settings: {},
    }),
    ["resume", "--last"],
  );
});
```

- [ ] **Step 2: Run the focused settings tests and verify they fail**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: FAIL because `_internal.applySavedApprovalPolicy` does not exist yet.

- [ ] **Step 3: Add launch-time approval-policy injection**

In `bin/cdx.js`, add:

```js
function hasExplicitApprovalPolicy(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-a" || args[index] === "--ask-for-approval") {
      return true;
    }
  }
  return false;
}

function applySavedApprovalPolicy({ forwardedArgs, settings }) {
  const args = Array.isArray(forwardedArgs) ? [...forwardedArgs] : [];
  if (!settings || !settings.approvalPolicy) {
    return args;
  }
  if (hasExplicitApprovalPolicy(args)) {
    return args;
  }
  return ["-a", settings.approvalPolicy, ...args];
}
```

Then in `main()` before `runCodexWrapper(...)`:

```js
const settings = readCdxSettings();
const wrapperArgs = applySavedApprovalPolicy({
  forwardedArgs: mode.forwardedArgs,
  settings,
});

await runCodexWrapper({
  argv: wrapperArgs,
  mainImpl: require("./ccx.js")._internalMain,
});
```

Export both helpers under `_internal`.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
node .\tests\cdx-settings-regressions.js
node .\tests\smoke.js
```

Expected:
- focused settings tests PASS
- smoke still PASS

- [ ] **Step 5: Commit**

```bash
git add bin/cdx.js tests/cdx-settings-regressions.js tests/smoke.js
git commit -m "feat: inject saved cdx approval policy"
```

---

### Task 4: Document the New Settings Behavior

**Files:**
- Modify: `README.md`
- Test: `tests/smoke.js`

- [ ] **Step 1: Write the failing docs/source assertions**

Add a simple README contract check:

```js
run("README documents cdx settings approval policy", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /CDX settings/i);
  assert.match(readme, /Approval policy/i);
  assert.match(readme, /untrusted/i);
  assert.match(readme, /on-request/i);
  assert.match(readme, /never/i);
});
```

- [ ] **Step 2: Run the focused settings tests and verify they fail**

Run: `node .\tests\cdx-settings-regressions.js`

Expected: FAIL because README does not yet mention `CDX settings`.

- [ ] **Step 3: Update the README**

Add a short section like:

```md
## CDX Settings

Open:

```bash
cdx manual
```

then choose `CDX settings`.

Currently supported:

- `Approval policy`
  - `untrusted`
  - `on-request`
  - `never`

`cdx` will use the saved approval policy by default when launching Codex, unless you explicitly pass `-a ...` or `--ask-for-approval ...` in the CLI.
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
node .\tests\cdx-settings-regressions.js
node .\tests\smoke.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/cdx-settings-regressions.js
git commit -m "docs: add cdx approval settings"
```

---

## Spec Coverage Check

- `CDX settings` in `cdx manual`: Task 2
- global `Approval policy`: Tasks 1 and 2
- valid values `untrusted`, `on-request`, `never`: Tasks 1 and 2
- persist in `~/.cdx/settings.json`: Task 1
- inject `-a <policy>` on launch: Task 3
- preserve explicit CLI override precedence: Task 3
- docs: Task 4

## Notes

- Do not attempt per-session approval replay.
- Do not modify `~/.codex/config.toml`.
- Keep this feature global, not per-account.
