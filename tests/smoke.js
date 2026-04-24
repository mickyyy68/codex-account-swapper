#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "cdx.js");
const SMOKE_TIMEOUT_MS = 10_000;

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createIsolatedEnv() {
  const root = mkTempDir("cdx-smoke-");
  const cdxDir = path.join(root, ".cdx");
  const codexHome = path.join(root, ".codex");
  const cwd = path.join(root, "cwd");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  return {
    cwd,
    env: {
      ...process.env,
      CDX_DIR: cdxDir,
      CODEX_HOME: codexHome,
    },
  };
}

function run(name, argv, checks) {
  const isolated = createIsolatedEnv();
  const result = spawnSync(process.execPath, [BIN_PATH, ...argv], {
    encoding: "utf8",
    env: isolated.env,
    cwd: isolated.cwd,
    timeout: SMOKE_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`${name}: ${result.error.message}`);
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 1, `${name}: expected exit status 1`);
  checks(output);
}

function runJson(name, argv, expectedStatus, checks) {
  const isolated = createIsolatedEnv();
  const result = spawnSync(process.execPath, [BIN_PATH, ...argv], {
    encoding: "utf8",
    env: isolated.env,
    cwd: isolated.cwd,
    timeout: SMOKE_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`${name}: ${result.error.message}`);
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, expectedStatus, `${name}: expected exit status ${expectedStatus}`);
  assert.doesNotMatch(output, /ccx:/i);
  checks(JSON.parse(result.stdout || ""));
}

run("default", [], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("wrapper help", ["--help"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("manual", ["manual"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("resume", ["resume", "sess-1"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx:/i);
});

run("manual extra", ["manual", "extra"], (output) => {
  assert.match(output, /usage: cdx manual/i);
  assert.doesNotMatch(output, /ccx:/i);
});

runJson("smart switch json", ["smart-switch", "--json"], 1, (payload) => {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.from, "string");
  assert.equal(typeof payload.to, "string");
  assert.equal(payload.reason, "no_accounts");
});
