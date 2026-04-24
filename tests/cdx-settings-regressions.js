#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const { _internal: cdxInternal } = require("../bin/cdx.js");
const {
  VALID_ACCESS_MODES,
  getSettingsFilePath,
  normalizeCdxSettings,
  readCdxSettings,
  writeCdxSettings,
} = require("../lib/cdx/settings");

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

async function main() {
  await run("reads missing settings files as an empty object", async () => {
    const cdxDir = mkTempDir("cdx-settings-missing-");

    assert.deepEqual(readCdxSettings({ cdxDir }), {});
  });

  await run("reads malformed settings files as an empty object", async () => {
    const cdxDir = mkTempDir("cdx-settings-malformed-");
    const settingsFilePath = getSettingsFilePath({ cdxDir });

    fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
    fs.writeFileSync(settingsFilePath, "{ not json\n", "utf8");

    assert.deepEqual(readCdxSettings({ cdxDir }), {});
  });

  await run("uses CDX_DIR for the default settings path", async () => {
    const cdxDir = mkTempDir("cdx-settings-env-");
    const previousCdxDir = process.env.CDX_DIR;

    try {
      process.env.CDX_DIR = cdxDir;
      assert.equal(
        getSettingsFilePath(),
        path.join(cdxDir, "settings.json"),
      );
      assert.deepEqual(
        writeCdxSettings({
          settings: { accessMode: "read-only" },
        }),
        { accessMode: "read-only" },
      );
      assert.deepEqual(readCdxSettings(), { accessMode: "read-only" });
    } finally {
      if (previousCdxDir === undefined) {
        delete process.env.CDX_DIR;
      } else {
        process.env.CDX_DIR = previousCdxDir;
      }
    }
  });

  await run("trims whitespace around overridden CDX_DIR values", async () => {
    const cdxDir = mkTempDir("cdx-settings-env-trim-");
    const previousCdxDir = process.env.CDX_DIR;

    try {
      process.env.CDX_DIR = `  ${cdxDir}  `;
      assert.equal(
        getSettingsFilePath(),
        path.join(cdxDir, "settings.json"),
      );
      assert.deepEqual(
        writeCdxSettings({
          settings: { accessMode: "full-access" },
        }),
        { accessMode: "full-access" },
      );
      assert.deepEqual(readCdxSettings(), { accessMode: "full-access" });
    } finally {
      if (previousCdxDir === undefined) {
        delete process.env.CDX_DIR;
      } else {
        process.env.CDX_DIR = previousCdxDir;
      }
    }
  });

  await run("roundtrips a valid access mode", async () => {
    const cdxDir = mkTempDir("cdx-settings-roundtrip-");
    const settings = { accessMode: "full-access" };
    const settingsFilePath = getSettingsFilePath({ cdxDir });

    assert.deepEqual(VALID_ACCESS_MODES, ["read-only", "default", "full-access"]);
    assert.deepEqual(normalizeCdxSettings(settings), settings);
    assert.equal(settingsFilePath, path.join(cdxDir, "settings.json"));

    assert.deepEqual(
      writeCdxSettings({ cdxDir, settings }),
      settings,
    );
    assert.equal(
      fs.readFileSync(settingsFilePath, "utf8"),
      [
        "{",
        '  "accessMode": "full-access"',
        "}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(readCdxSettings({ cdxDir }), settings);
  });

  await run("drops invalid access modes during normalization", async () => {
    const cdxDir = mkTempDir("cdx-settings-invalid-");
    const settingsFilePath = getSettingsFilePath({ cdxDir });

    assert.deepEqual(
      normalizeCdxSettings({ accessMode: "always", ignored: true }),
      {},
    );
    assert.deepEqual(
      writeCdxSettings({
        cdxDir,
        settings: { accessMode: "always", ignored: true },
      }),
      {},
    );
    assert.equal(fs.readFileSync(settingsFilePath, "utf8"), "{}\n");
    assert.deepEqual(readCdxSettings({ cdxDir }), {});
  });

  await run("drops legacy approvalPolicy field silently", async () => {
    // Pre-refactor files stored approvalPolicy. Normalization treats them as default (empty).
    assert.deepEqual(
      normalizeCdxSettings({ approvalPolicy: "on-request" }),
      {},
    );
  });

  await run("manual action list includes CDX settings", async () => {
    assert.deepEqual(
      cdxInternal.getManualActionOptions().find((option) => option.value === "settings"),
      {
        value: "settings",
        label: "CDX settings",
        hint: "Configure wrapper defaults",
      },
    );
  });

  await run("settings menu shows Access mode with labelized hint", async () => {
    assert.deepEqual(cdxInternal.getSettingsMenuOptions({}), [
      {
        value: "access-mode",
        label: "Access mode",
        hint: "Default",
      },
      { value: "back", label: "Back" },
    ]);
    assert.deepEqual(cdxInternal.getSettingsMenuOptions({ accessMode: "read-only" }), [
      {
        value: "access-mode",
        label: "Access mode",
        hint: "Read Only",
      },
      { value: "back", label: "Back" },
    ]);
    assert.deepEqual(cdxInternal.getSettingsMenuOptions({ accessMode: "full-access" }), [
      {
        value: "access-mode",
        label: "Access mode",
        hint: "Full Access",
      },
      { value: "back", label: "Back" },
    ]);
  });

  await run("access mode options list the three presets with human labels", async () => {
    assert.deepEqual(cdxInternal.getAccessModeOptions(), [
      { value: "read-only", label: "Read Only" },
      { value: "default", label: "Default" },
      { value: "full-access", label: "Full Access" },
    ]);
  });

  await run("access mode initial value defaults to Default", async () => {
    assert.equal(cdxInternal.getAccessModeInitialValue({}), "default");
    assert.equal(cdxInternal.getAccessModeInitialValue({ accessMode: "full-access" }), "full-access");
    assert.equal(cdxInternal.getAccessModeInitialValue({ accessMode: "unknown" }), "default");
  });

  await run("README documents cdx settings access mode behavior", async () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

    assert.match(readme, /cdx manual[\s\S]*CDX settings/i);
    assert.match(readme, /Access mode/i);
    assert.match(readme, /Read Only/i);
    assert.match(readme, /Full Access/i);
    assert.match(readme, /danger-full-access/i);
    assert.match(readme, /saved access mode by default/i);
    assert.match(readme, /-a .*--ask-for-approval .*--sandbox .*overrides/i);
    assert.match(readme, /Exit/i);
    assert.match(readme, /ccx.*legacy compatibility entrypoint/i);
    assert.match(readme, /Most non-interactive runs exit with an error/i);
  });

  await run("cdx state root helper trims env overrides consistently", async () => {
    assert.equal(
      cdxInternal.resolveCdxDir("  C:\\temp\\cdx-state  "),
      "C:\\temp\\cdx-state",
    );
  });

  await run("injects read-only flags when saved and no override exists", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["resume", "--last"],
        settings: { accessMode: "read-only" },
      }),
      ["--sandbox", "read-only", "--ask-for-approval", "never", "resume", "--last"],
    );
  });

  await run("injects full-access flags when saved and no override exists", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["resume", "019xxx"],
        settings: { accessMode: "full-access" },
      }),
      ["--sandbox", "danger-full-access", "--ask-for-approval", "never", "resume", "019xxx"],
    );
  });

  await run("default access mode injects nothing", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["resume", "019xxx"],
        settings: { accessMode: "default" },
      }),
      ["resume", "019xxx"],
    );
  });

  await run("does not inject with short approval flag", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["-a", "untrusted", "resume", "--last"],
        settings: { accessMode: "full-access" },
      }),
      ["-a", "untrusted", "resume", "--last"],
    );
  });

  await run("does not inject with long approval flag", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["--ask-for-approval", "untrusted", "resume", "--last"],
        settings: { accessMode: "read-only" },
      }),
      ["--ask-for-approval", "untrusted", "resume", "--last"],
    );
  });

  await run("does not inject with long equals-form approval flag", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["--ask-for-approval=untrusted", "resume", "--last"],
        settings: { accessMode: "full-access" },
      }),
      ["--ask-for-approval=untrusted", "resume", "--last"],
    );
  });

  await run("does not inject with sandbox flag", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["--sandbox", "workspace-write", "resume", "--last"],
        settings: { accessMode: "full-access" },
      }),
      ["--sandbox", "workspace-write", "resume", "--last"],
    );
  });

  await run("does not inject with compact short sandbox flag", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["-sread-only", "resume", "--last"],
        settings: { accessMode: "full-access" },
      }),
      ["-sread-only", "resume", "--last"],
    );
  });

  await run("does not inject when no saved setting exists", async () => {
    assert.deepEqual(
      cdxInternal.applySavedAccessMode({
        forwardedArgs: ["resume", "--last"],
        settings: {},
      }),
      ["resume", "--last"],
    );
  });

  process.stdout.write("all cdx settings regression tests passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
