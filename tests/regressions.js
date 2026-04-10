#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "cdx.js");

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(env, fn) {
  const oldCdx = process.env.CDX_DIR;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.CDX_DIR = env.CDX_DIR;
  process.env.CODEX_HOME = env.CODEX_HOME;
  try {
    delete require.cache[require.resolve(BIN_PATH)];
    return fn(require(BIN_PATH)._internal);
  } finally {
    if (oldCdx === undefined) {
      delete process.env.CDX_DIR;
    } else {
      process.env.CDX_DIR = oldCdx;
    }
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    delete require.cache[require.resolve(BIN_PATH)];
  }
}

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exit(1);
  }
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

run("does not write migration marker when legacy file is absent", () => {
  const cdxDir = mkTempDir("cdx-test-no-legacy-");
  const codexHome = mkTempDir("cdx-test-no-legacy-home-");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");

  withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, false);
  });

  assert.equal(fs.existsSync(accounts), true);
  assert.equal(fs.existsSync(marker), false);
});

run("imports legacy tsv and writes migration marker", () => {
  const cdxDir = mkTempDir("cdx-test-legacy-import-");
  const codexHome = mkTempDir("cdx-test-legacy-import-home-");
  const legacy = path.join(cdxDir, "accounts.tsv");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(
    legacy,
    ["work\t/tmp/work-auth.json", "personal\t/tmp/personal-auth.json", ""].join("\n"),
    "utf8",
  );

  withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, true);
    assert.equal(result.count, 2);
  });

  assert.equal(fs.existsSync(marker), true);
  const parsed = JSON.parse(fs.readFileSync(accounts, "utf8"));
  assert.deepEqual(parsed, [
    { name: "work", path: "/tmp/work-auth.json" },
    { name: "personal", path: "/tmp/personal-auth.json" },
  ]);
});

run("does not write migration marker when legacy file has no valid rows", () => {
  const cdxDir = mkTempDir("cdx-test-legacy-invalid-");
  const codexHome = mkTempDir("cdx-test-legacy-invalid-home-");
  const legacy = path.join(cdxDir, "accounts.tsv");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(legacy, "invalid-row-without-tab\n\n", "utf8");

  withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, false);
    assert.equal(result.warning, "legacy_no_valid_rows");
  });

  assert.equal(fs.existsSync(accounts), true);
  assert.equal(fs.existsSync(marker), false);
});

run("readAccountsFromJson drops malformed entries", () => {
  const cdxDir = mkTempDir("cdx-test-read-accounts-");
  const codexHome = mkTempDir("cdx-test-read-accounts-home-");
  const accounts = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(
    accounts,
    JSON.stringify(
      [
        { name: 123, path: "/tmp/a" },
        { name: "valid", path: "/tmp/b" },
        { name: "   ", path: "/tmp/c" },
        { name: "x", path: "   " },
      ],
      null,
      2,
    ),
    "utf8",
  );

  withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, (internal) => {
    const parsed = internal.readAccounts();
    assert.deepEqual(parsed, [{ name: "valid", path: "/tmp/b" }]);
  });
});

run("extracts email from direct field and token claims", () => {
  const cdxDir = mkTempDir("cdx-test-email-");
  const codexHome = mkTempDir("cdx-test-email-home-");

  withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, (internal) => {
    assert.equal(
      internal.extractEmailFromObject({ user: { email: "direct@example.com" } }),
      "direct@example.com",
    );

    const token = makeJwt({ preferred_username: "jwt@example.com" });
    assert.equal(internal.emailFromToken(token), "jwt@example.com");
    assert.equal(
      internal.extractEmailFromObject({ auth: { id_token: token } }),
      "jwt@example.com",
    );
    assert.equal(internal.emailFromToken("not-a-jwt"), "");
  });
});

process.stdout.write("all regression tests passed\n");
