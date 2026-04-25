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

async function withEnv(env, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    delete require.cache[require.resolve(BIN_PATH)];
    return await fn(require(BIN_PATH)._internal);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    delete require.cache[require.resolve(BIN_PATH)];
  }
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

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function writeAuthSnapshot(filePath, accountId, email, planType) {
  const accessTokenPayload = {
    preferred_username: email,
  };
  if (planType) {
    accessTokenPayload.chatgpt_plan_type = planType;
  }
  const accessToken = makeJwt(accessTokenPayload);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        account_id: accountId,
        tokens: {
          access_token: accessToken,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function main() {
await run("does not write migration marker when legacy file is absent", async () => {
  const cdxDir = mkTempDir("cdx-test-no-legacy-");
  const codexHome = mkTempDir("cdx-test-no-legacy-home-");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, false);
  });

  assert.equal(fs.existsSync(accounts), true);
  assert.equal(fs.existsSync(marker), false);
});

await run("imports legacy tsv and writes migration marker", async () => {
  const cdxDir = mkTempDir("cdx-test-legacy-import-");
  const codexHome = mkTempDir("cdx-test-legacy-import-home-");
  const legacy = path.join(cdxDir, "accounts.tsv");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");
  const authDir = path.join(cdxDir, "legacy-auth");
  const workAuth = path.join(authDir, "work.auth.json");
  const personalAuth = path.join(authDir, "personal.auth.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  writeAuthSnapshot(workAuth, "acct-legacy-work", "work@example.com", "plus");
  writeAuthSnapshot(personalAuth, "acct-legacy-personal", "personal@example.com", "plus");
  fs.writeFileSync(
    legacy,
    [`work\t${workAuth}`, `personal\t${personalAuth}`, ""].join("\n"),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, true);
    assert.equal(result.count, 2);
  });

  assert.equal(fs.existsSync(marker), true);
  const parsed = JSON.parse(fs.readFileSync(accounts, "utf8"));
  assert.deepEqual(parsed, [
    { name: "work", path: workAuth, pinned: false, excludedFromRecommendation: false },
    { name: "personal", path: personalAuth, pinned: false, excludedFromRecommendation: false },
  ]);
});

await run("does not write migration marker when legacy file has no valid rows", async () => {
  const cdxDir = mkTempDir("cdx-test-legacy-invalid-");
  const codexHome = mkTempDir("cdx-test-legacy-invalid-home-");
  const legacy = path.join(cdxDir, "accounts.tsv");
  const marker = path.join(cdxDir, ".migration_accounts_tsv_v1.done");
  const accounts = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(legacy, "invalid-row-without-tab\n\n", "utf8");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const result = internal.ensureState();
    assert.equal(result.migrated, false);
    assert.equal(result.warning, "legacy_no_valid_rows");
  });

  assert.equal(fs.existsSync(accounts), true);
  assert.equal(fs.existsSync(marker), false);
});

await run("readAccountsFromJson drops malformed entries", async () => {
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

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const parsed = internal.readAccounts();
    assert.deepEqual(parsed, [{ name: "valid", path: "/tmp/b", pinned: false, excludedFromRecommendation: false }]);
  });
});

await run("repairAccountsState removes missing accounts and reassigns active", async () => {
  const cdxDir = mkTempDir("cdx-test-repair-");
  const codexHome = mkTempDir("cdx-test-repair-home-");
  const authDir = path.join(cdxDir, "auth");
  const goodAuth = path.join(authDir, "good.auth.json");
  const missingAuth = path.join(authDir, "missing.auth.json");

  fs.mkdirSync(authDir, { recursive: true });
  writeAuthSnapshot(goodAuth, "acct-good", "good@example.com", "plus");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const repair = internal.repairAccountsState(
      [
        { name: "missing", path: missingAuth, pinned: false, excludedFromRecommendation: false },
        { name: "good", path: goodAuth, pinned: true, excludedFromRecommendation: false },
      ],
      "missing",
    );

    assert.equal(repair.changed, true);
    assert.equal(repair.activeChanged, true);
    assert.equal(repair.activeName, "good");
    assert.deepEqual(repair.removed.map((entry) => entry.name), ["missing"]);
    assert.deepEqual(repair.accounts, [
      { name: "good", path: goodAuth, pinned: true, excludedFromRecommendation: false },
    ]);
  });
});

await run("extracts email and plan type from direct fields and token claims", async () => {
  const cdxDir = mkTempDir("cdx-test-email-");
  const codexHome = mkTempDir("cdx-test-email-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    assert.equal(
      internal.extractEmailFromObject({ user: { email: "direct@example.com" } }),
      "direct@example.com",
    );

    const token = makeJwt({
      preferred_username: "jwt@example.com",
      chatgpt_plan_type: "plus",
    });
    assert.equal(internal.emailFromToken(token), "jwt@example.com");
    assert.equal(internal.planTypeFromToken(token), "plus");
    assert.equal(
      internal.extractEmailFromObject({ auth: { id_token: token } }),
      "jwt@example.com",
    );
    assert.equal(
      internal.extractPlanTypeFromObject({ auth: { access_token: token } }),
      "plus",
    );
    assert.equal(internal.emailFromToken("not-a-jwt"), "");
    assert.equal(internal.planTypeFromToken("not-a-jwt"), "");
  });
});

await run("extracts account id from auth metadata", async () => {
  const cdxDir = mkTempDir("cdx-test-account-id-");
  const codexHome = mkTempDir("cdx-test-account-id-home-");
  const authPath = path.join(cdxDir, "current.auth.json");

  fs.mkdirSync(cdxDir, { recursive: true });
  writeAuthSnapshot(authPath, "acct-metadata", "metadata@example.com", "plus");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    assert.equal(
      internal.extractAccountIdFromObject({ auth: { account_id: "acct-direct" } }),
      "acct-direct",
    );
    assert.equal(internal.getAccountMetadata(authPath).accountId, "acct-metadata");
  });
});

await run("formats rate limit windows into compact picker text", async () => {
  const cdxDir = mkTempDir("cdx-test-rate-limit-format-");
  const codexHome = mkTempDir("cdx-test-rate-limit-format-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const summary = internal.createRateLimitWindowSummary(
      {
        usedPercent: 26,
        windowDurationMins: 300,
        resetsAt: Date.UTC(2030, 0, 2, 18, 40, 0) / 1000,
      },
      "fallback",
      new Date(Date.UTC(2030, 0, 2, 12, 0, 0)),
    );
    assert.equal(summary.label, "5h");
    assert.equal(summary.remainingPercent, 74);
    assert.match(summary.resetAt, /^\d{2}:\d{2}$/);
  });
});

await run("serializes initialized notification without params", async () => {
  const cdxDir = mkTempDir("cdx-test-app-server-notify-");
  const codexHome = mkTempDir("cdx-test-app-server-notify-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    assert.deepEqual(internal.createAppServerNotification("initialized"), { method: "initialized" });
    assert.deepEqual(
      internal.createAppServerRequest("account/rateLimits/read", 7),
      { method: "account/rateLimits/read", id: 7 },
    );
  });
});

await run("resolves Windows npm shim to codex.js and launches it with Node", async () => {
  const cdxDir = mkTempDir("cdx-test-codex-launch-");
  const codexHome = mkTempDir("cdx-test-codex-launch-home-");
  const binDir = path.join(mkTempDir("cdx test path "), "bin dir");
  const codexCmd = path.join(binDir, "codex.cmd");
  const codexScript = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.dirname(codexScript), { recursive: true });
  fs.writeFileSync(codexCmd, "@echo off\r\n", "utf8");
  fs.writeFileSync(codexScript, "console.log('codex');\n", "utf8");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const spec = internal.getCodexLaunchSpec(["app-server", "--listen", "stdio://"], {
      command: "codex",
      platform: "win32",
      env: {
        PATH: binDir,
        PATHEXT: ".EXE;.CMD;.BAT",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      fileExists: (candidate) => fs.existsSync(candidate),
    });

    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], codexScript);
    assert.deepEqual(spec.args.slice(1), ["app-server", "--listen", "stdio://"]);
  });
});

await run("preserves live email and plan when only rate limits fail", async () => {
  const cdxDir = mkTempDir("cdx-test-live-fallback-");
  const codexHome = mkTempDir("cdx-test-live-fallback-home-");
  const authDir = path.join(cdxDir, "auth");
  const authPath = path.join(authDir, "work.auth.json");

  fs.mkdirSync(authDir, { recursive: true });
  writeAuthSnapshot(authPath, "acct-1", "snapshot@example.com");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    internal.setCodexAppServerQueryForTests(async () => {
      const error = new Error("backend failed");
      error.appServerErrorCode = "rate_limits_failed";
      error.partial = {
        account: {
          account: {
            email: "live@example.com",
            planType: "plus",
          },
        },
        rateLimits: null,
      };
      throw error;
    });

    const status = await internal.fetchLiveRateLimitStatus(authPath);
    assert.equal(status.available, false);
    assert.equal(status.email, "live@example.com");
    assert.equal(status.planType, "plus");
    assert.equal(status.errorCode, "rate_limits_failed");

    const account = { name: "work", path: authPath };
    assert.equal(stripAnsi(internal.buildSwitchAccountLabel(account, status, "work")), "work   live@example.com   5h   — (reset —)   [ACTIVE]");
    assert.match(internal.buildSwitchAccountHint(account, "", status), /limits unavailable/);
  });
});

await run("toggles pinned and excluded recommendation flags", async () => {
  const cdxDir = mkTempDir("cdx-test-account-flags-");
  const codexHome = mkTempDir("cdx-test-account-flags-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");
  const authPath = path.join(authDir, "work.auth.json");

  fs.mkdirSync(authDir, { recursive: true });
  writeAuthSnapshot(authPath, "acct-1", "work@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "work", path: authPath, pinned: false, excludedFromRecommendation: false },
      ],
      null,
      2,
    ),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    assert.equal(internal.opSetPinned("work", true), "Pinned account 'work'");
    assert.equal(
      internal.opSetExcludedFromRecommendation("work", true),
      "Excluded account 'work' from recommendation",
    );
    assert.deepEqual(internal.readAccounts(), [
      { name: "work", path: authPath, pinned: true, excludedFromRecommendation: true },
    ]);
  });
});

await run("describes depleted limits for hard warning", async () => {
  const cdxDir = mkTempDir("cdx-test-depleted-warning-");
  const codexHome = mkTempDir("cdx-test-depleted-warning-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const status = {
      available: true,
      primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
      secondary: { label: "weekly", remainingPercent: 12, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
    };
    assert.equal(internal.statusHasDepletedLimit(status), true);
    assert.deepEqual(internal.getDepletedLimitLabels(status), ["5h"]);
    assert.equal(
      internal.buildDepletedWarningMessage("work", status),
      "Account 'work' is exhausted for 5h. Switch anyway?",
    );
  });
});

await run("shows low credits in switch labels and hints", async () => {
  const cdxDir = mkTempDir("cdx-test-low-credits-");
  const codexHome = mkTempDir("cdx-test-low-credits-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const status = {
      available: true,
      email: "work@example.com",
      planType: "plus",
      primary: { label: "5h", remainingPercent: 82, resetAt: "18:40", resetAtSeconds: 10 },
      secondary: { label: "weekly", remainingPercent: 76, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
      credits: internal.createCreditsSummary({ hasCredits: true, balance: "7" }),
      errorCode: "",
    };
    const account = { name: "work", path: "C:/tmp/work.auth.json" };

    assert.equal(internal.statusHasLowCredits(status), true);
    assert.equal(internal.statusHasZeroCredits(status), false);
    assert.equal(stripAnsi(internal.buildSwitchAccountLabel(account, status, "")), "work   work@example.com   5h  82% (reset 18:40)   [LOW 7 CR]");
    assert.equal(
      internal.buildSwitchAccountHint(account, "", status),
      "5h 82% (reset 18:40)  ·  weekly 76% (reset 2039-09-18 18:40)  ·  low credits 7",
    );
  });
});

await run("ignores zero credit balances when credits are not enabled", async () => {
  const cdxDir = mkTempDir("cdx-test-ignore-false-zero-credits-");
  const codexHome = mkTempDir("cdx-test-ignore-false-zero-credits-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const status = {
      available: true,
      email: "work@example.com",
      planType: "plus",
      primary: { label: "5h", remainingPercent: 82, resetAt: "18:40", resetAtSeconds: 10 },
      secondary: { label: "weekly", remainingPercent: 76, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
      credits: internal.createCreditsSummary({ hasCredits: false, balance: "0" }),
      errorCode: "",
    };
    const account = { name: "work", path: "C:/tmp/work.auth.json" };

    assert.equal(status.credits, null);
    assert.equal(internal.statusHasZeroCredits(status), false);
    assert.equal(stripAnsi(internal.buildSwitchAccountLabel(account, status, "", "work")), "work   work@example.com   5h  82% (reset 18:40)   [RECOMMENDED]");
    assert.equal(
      internal.buildSwitchAccountHint(account, "", status),
      "5h 82% (reset 18:40)  ·  weekly 76% (reset 2039-09-18 18:40)",
    );
  });
});

await run("does not recommend smart switch when all eligible accounts are exhausted", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-exhausted-");
  const codexHome = mkTempDir("cdx-test-smart-switch-exhausted-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const entries = [
      {
        account: {
          name: "zero-window",
          path: "C:/tmp/zero-window.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 40, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
          credits: null,
        },
      },
      {
        account: {
          name: "zero-credits",
          path: "C:/tmp/zero-credits.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 15 },
          secondary: { label: "weekly", remainingPercent: 90, resetAt: "2039-09-18 18:40", resetAtSeconds: 150 },
          credits: internal.createCreditsSummary({ hasCredits: true, balance: "0" }),
        },
      },
    ];

    assert.equal(internal.getRecommendedSwitchAccount(entries, "", ""), "");
    assert.equal(internal.areAllEligibleAccountsExhausted(entries), true);
    assert.equal(internal.statusNeedsHardWarning(entries[1].status), true);
    assert.equal(
      internal.buildDepletedWarningMessage("zero-credits", entries[1].status),
      "Account 'zero-credits' has 0 credits. Switch anyway?",
    );
  });
});

await run("recommends the healthiest account and flags depleted ones in the label", async () => {
  const cdxDir = mkTempDir("cdx-test-live-recommend-");
  const codexHome = mkTempDir("cdx-test-live-recommend-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(authDir, { recursive: true });
  const zeroAuth = path.join(authDir, "zero.auth.json");
  const bestAuth = path.join(authDir, "best.auth.json");
  const okayAuth = path.join(authDir, "okay.auth.json");
  writeAuthSnapshot(zeroAuth, "acct-0", "zero@example.com", "plus");
  writeAuthSnapshot(bestAuth, "acct-1", "best@example.com", "plus");
  writeAuthSnapshot(okayAuth, "acct-2", "okay@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "zero", path: zeroAuth },
        { name: "best", path: bestAuth },
        { name: "okay", path: okayAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );

  await withEnv(
    {
      CDX_DIR: cdxDir,
      CODEX_HOME: codexHome,
    },
    async (internal) => {
      internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
        if (accountPath === zeroAuth) {
          return {
            available: true,
            email: "zero@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
            secondary: { label: "weekly", remainingPercent: 90, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
            errorCode: "",
          };
        }
        if (accountPath === bestAuth) {
          return {
            available: true,
            email: "best@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 20 },
            secondary: { label: "weekly", remainingPercent: 70, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
            errorCode: "",
          };
        }
        return {
          available: true,
          email: "okay@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 60, resetAt: "18:40", resetAtSeconds: 30 },
          secondary: { label: "weekly", remainingPercent: 60, resetAt: "2039-09-18 18:40", resetAtSeconds: 300 },
          errorCode: "",
        };
      });

      const accounts = internal.readAccounts();
      const entries = await Promise.all(
        accounts.map(async (account) => ({
          account,
          status: await internal.getLiveRateLimitStatus(account.path),
        })),
      );
      assert.equal(internal.getRecommendedSwitchAccount(entries, "zero", ""), "best");

      const selection = internal.buildSwitchAccountSelection(entries, "zero", "");
      assert.equal(selection.recommendedValue, "best");
      assert.equal(stripAnsi(selection.options[0].label), "zero   zero@example.com   5h   0% (reset 18:40)   [ACTIVE]");
      assert.equal(stripAnsi(selection.options[1].label), "best   best@example.com   5h  80% (reset 18:40)   [RECOMMENDED]");
      assert.equal(stripAnsi(selection.options[2].label), "okay   okay@example.com   5h  60% (reset 18:40)");
    },
  );
});

await run("prefers pinned account in Tier A even with low credits", async () => {
  const cdxDir = mkTempDir("cdx-test-credit-priority-");
  const codexHome = mkTempDir("cdx-test-credit-priority-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const entries = [
      {
        account: {
          name: "pinned-low",
          path: "C:/tmp/pinned-low.auth.json",
          pinned: true,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 96, resetAt: "18:40", resetAtSeconds: 20 },
          secondary: { label: "weekly", remainingPercent: 96, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
          credits: internal.createCreditsSummary({ hasCredits: true, balance: "2" }),
        },
      },
      {
        account: {
          name: "safer",
          path: "C:/tmp/safer.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 25 },
          secondary: { label: "weekly", remainingPercent: 80, resetAt: "2039-09-18 18:40", resetAtSeconds: 250 },
          credits: internal.createCreditsSummary({ hasCredits: true, balance: "40" }),
        },
      },
    ];

    assert.equal(internal.getRecommendedSwitchAccount(entries, "", ""), "pinned-low");
  });
});

await run("runs smart switch operation and returns a machine-readable result", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-operation-");
  const codexHome = mkTempDir("cdx-test-smart-switch-operation-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");
  const activeFile = path.join(cdxDir, "active");

  fs.mkdirSync(authDir, { recursive: true });
  const lowAuth = path.join(authDir, "low.auth.json");
  const bestAuth = path.join(authDir, "best.auth.json");
  writeAuthSnapshot(lowAuth, "acct-low", "low@example.com", "plus");
  writeAuthSnapshot(bestAuth, "acct-best", "best@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "low", path: lowAuth },
        { name: "best", path: bestAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(activeFile, "low\n", "utf8");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
      if (accountPath === lowAuth) {
        return {
          available: true,
          email: "low@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 35, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
          credits: internal.createCreditsSummary({ hasCredits: true, balance: "2" }),
          errorCode: "",
        };
      }
      return {
        available: true,
        email: "best@example.com",
        planType: "plus",
        primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 20 },
        secondary: { label: "weekly", remainingPercent: 70, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
        credits: null,
        errorCode: "",
      };
    });

    const result = await internal.runSmartSwitchOperation();
    assert.deepEqual(
      result,
      {
        ok: true,
        switched: true,
        alreadyOptimal: false,
        allExhausted: false,
        from: "low",
        to: "best",
        reason: "best_available",
        activeStatus: {
          available: true,
          email: "low@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 35, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
          lowCredits: true,
          zeroCredits: false,
          credits: { hasCredits: true, unlimited: false, balance: "2" },
          errorCode: "",
        },
        recommendedStatus: {
          available: true,
          email: "best@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 20 },
          secondary: { label: "weekly", remainingPercent: 70, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
          lowCredits: false,
          zeroCredits: false,
          credits: null,
          errorCode: "",
        },
      },
    );
    assert.equal(fs.readFileSync(activeFile, "utf8").trim(), "best");
  });
});

await run("smart switch moves off active when a fresher 5h account is available", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-prefer-fresh-");
  const codexHome = mkTempDir("cdx-test-smart-switch-prefer-fresh-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");
  const activeFile = path.join(cdxDir, "active");

  fs.mkdirSync(authDir, { recursive: true });
  const stickyAuth = path.join(authDir, "sticky.auth.json");
  const freshAuth = path.join(authDir, "fresh.auth.json");
  writeAuthSnapshot(stickyAuth, "acct-sticky", "sticky@example.com", "plus");
  writeAuthSnapshot(freshAuth, "acct-fresh", "fresh@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "sticky", path: stickyAuth },
        { name: "fresh", path: freshAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(activeFile, "sticky\n", "utf8");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
      if (accountPath === stickyAuth) {
        return {
          available: true,
          email: "sticky@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 8, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 12, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
          credits: null,
          errorCode: "",
        };
      }
      return {
        available: true,
        email: "fresh@example.com",
        planType: "plus",
        primary: { label: "5h", remainingPercent: 99, resetAt: "18:40", resetAtSeconds: 20 },
        secondary: { label: "weekly", remainingPercent: 99, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
        credits: null,
        errorCode: "",
      };
    });

    const result = await internal.runSmartSwitchOperation();
    assert.equal(result.ok, true);
    assert.equal(result.switched, true);
    assert.equal(result.alreadyOptimal, false);
    assert.equal(result.from, "sticky");
    assert.equal(result.to, "fresh");
    assert.equal(fs.readFileSync(activeFile, "utf8").trim(), "fresh");
  });
});

await run("recommendation prioritizes 5h remaining over weekly", async () => {
  const cdxDir = mkTempDir("cdx-test-5h-priority-");
  const codexHome = mkTempDir("cdx-test-5h-priority-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const entries = [
      {
        account: {
          name: "weekly-rich",
          path: "C:/tmp/weekly-rich.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 50, resetAt: "18:40", resetAtSeconds: 20 },
          secondary: { label: "weekly", remainingPercent: 95, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
        },
      },
      {
        account: {
          name: "fivehour-rich",
          path: "C:/tmp/fivehour-rich.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 85, resetAt: "18:40", resetAtSeconds: 25 },
          secondary: { label: "weekly", remainingPercent: 25, resetAt: "2039-09-18 18:40", resetAtSeconds: 250 },
        },
      },
    ];

    assert.equal(internal.getRecommendedSwitchAccount(entries, "", ""), "fivehour-rich");
  });
});

await run("runSmartSwitchOperation applies the same auto-cleanup as Account list", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-cleanup-");
  const codexHome = mkTempDir("cdx-test-smart-switch-cleanup-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");
  const activeFile = path.join(cdxDir, "active");

  fs.mkdirSync(authDir, { recursive: true });
  const liveAuth = path.join(authDir, "live.auth.json");
  const staleAuth = path.join(authDir, "stale.auth.json");
  const bestAuth = path.join(authDir, "best.auth.json");
  writeAuthSnapshot(liveAuth, "acct-live", "live@example.com", "plus");
  writeAuthSnapshot(staleAuth, "acct-stale", "stale@example.com", "plus");
  writeAuthSnapshot(bestAuth, "acct-best", "best@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "live", path: liveAuth },
        { name: "stale", path: staleAuth },
        { name: "best", path: bestAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(activeFile, "live\n", "utf8");

  const { writeAccountHealth, readAccountHealth } = require("../lib/cdx/account-health");
  const connectivity = require("../lib/cdx/connectivity");

  connectivity.setConnectivityCheckForTests(async () => true);
  try {
    await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
      writeAccountHealth({ stale: { consecutiveFailures: 2 } });

      internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
        if (accountPath === liveAuth) {
          return {
            available: true,
            email: "live@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 40, resetAt: "18:40", resetAtSeconds: 10 },
            secondary: { label: "weekly", remainingPercent: 50, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
            credits: null,
            errorCode: "",
          };
        }
        if (accountPath === bestAuth) {
          return {
            available: true,
            email: "best@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 95, resetAt: "18:40", resetAtSeconds: 20 },
            secondary: { label: "weekly", remainingPercent: 95, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
            credits: null,
            errorCode: "",
          };
        }
        return internal.createUnavailableRateLimitStatus(
          { email: "stale@example.com", planType: "plus" },
          "rate_limits_failed",
        );
      });

      const result = await internal.runSmartSwitchOperation();
      assert.equal(result.ok, true);
      assert.equal(result.switched, true);
      assert.equal(result.from, "live");
      assert.equal(result.to, "best");

      const remaining = internal.readAccounts().map((entry) => entry.name);
      assert.deepEqual(remaining.sort(), ["best", "live"]);
      assert.equal(readAccountHealth().stale, undefined);
    });
  } finally {
    connectivity.setConnectivityCheckForTests(null);
  }
});

await run("reports all exhausted from smart switch operation", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-all-exhausted-");
  const codexHome = mkTempDir("cdx-test-smart-switch-all-exhausted-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(authDir, { recursive: true });
  const zeroAuth = path.join(authDir, "zero.auth.json");
  writeAuthSnapshot(zeroAuth, "acct-zero", "zero@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify([{ name: "zero", path: zeroAuth }], null, 2),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    internal.setLiveRateLimitFetcherForTests(async () => ({
      available: true,
      email: "zero@example.com",
      planType: "plus",
      primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
      secondary: { label: "weekly", remainingPercent: 20, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
      credits: null,
      errorCode: "",
    }));

    const result = await internal.runSmartSwitchOperation();
    assert.equal(result.ok, false);
    assert.equal(result.allExhausted, true);
    assert.equal(result.reason, "all_exhausted");
    assert.equal(result.to, "");
  });
});

await run("reports an error when every eligible account is unavailable or exhausted", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-unavailable-or-exhausted-");
  const codexHome = mkTempDir("cdx-test-smart-switch-unavailable-or-exhausted-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(authDir, { recursive: true });
  const zeroAuth = path.join(authDir, "zero.auth.json");
  const unavailableAuth = path.join(authDir, "unavailable.auth.json");
  writeAuthSnapshot(zeroAuth, "acct-zero", "zero@example.com", "plus");
  writeAuthSnapshot(unavailableAuth, "acct-unavailable", "unavailable@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "zero", path: zeroAuth },
        { name: "unavailable", path: unavailableAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
      if (accountPath === zeroAuth) {
        return {
          available: true,
          email: "zero@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 20, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
          credits: null,
          errorCode: "",
        };
      }

      return internal.createUnavailableRateLimitStatus(
        { email: "unavailable@example.com", planType: "plus" },
        "rate_limits_failed",
      );
    });

    const result = await internal.runSmartSwitchOperation();
    assert.equal(result.ok, false);
    assert.equal(result.allExhausted, false);
    assert.equal(result.reason, "all_unavailable_or_exhausted");
    assert.equal(result.to, "");
  });
});

await run("smart switch can bypass stale live-limit cache when forced", async () => {
  const cdxDir = mkTempDir("cdx-test-smart-switch-force-refresh-");
  const codexHome = mkTempDir("cdx-test-smart-switch-force-refresh-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");
  const activeFile = path.join(cdxDir, "active");

  fs.mkdirSync(authDir, { recursive: true });
  const activeAuth = path.join(authDir, "active.auth.json");
  const spareAuth = path.join(authDir, "spare.auth.json");
  writeAuthSnapshot(activeAuth, "acct-active", "active@example.com", "plus");
  writeAuthSnapshot(spareAuth, "acct-spare", "spare@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "active", path: activeAuth },
        { name: "spare", path: spareAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(activeFile, "active\n", "utf8");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    let phase = "warm";
    internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
      if (phase === "warm") {
        return accountPath === activeAuth
          ? {
              available: true,
              email: "active@example.com",
              planType: "plus",
              primary: { label: "5h", remainingPercent: 90, resetAt: "18:40", resetAtSeconds: 10 },
              secondary: { label: "weekly", remainingPercent: 90, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
              credits: null,
              errorCode: "",
            }
          : {
              available: true,
              email: "spare@example.com",
              planType: "plus",
              primary: { label: "5h", remainingPercent: 70, resetAt: "18:40", resetAtSeconds: 20 },
              secondary: { label: "weekly", remainingPercent: 70, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
              credits: null,
              errorCode: "",
            };
      }

      return accountPath === activeAuth
        ? {
            available: true,
            email: "active@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 0, resetAt: "18:40", resetAtSeconds: 10 },
            secondary: { label: "weekly", remainingPercent: 20, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
            credits: null,
            errorCode: "",
          }
        : {
            available: true,
            email: "spare@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 80, resetAt: "18:40", resetAtSeconds: 20 },
            secondary: { label: "weekly", remainingPercent: 80, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
            credits: null,
            errorCode: "",
          };
    });

    const accounts = internal.readAccounts();
    const warmOptions = await internal.buildSwitchAccountOptions(accounts, "active", "");
    assert.equal(stripAnsi(warmOptions[0].label), "active   active@example.com   5h  90% (reset 18:40)   [RECOMMENDED]  [ACTIVE]");

    phase = "live";
    const result = await internal.runSmartSwitchOperation({ forceRefreshLiveLimits: true });
    assert.equal(result.ok, true);
    assert.equal(result.switched, true);
    assert.equal(result.from, "active");
    assert.equal(result.to, "spare");
    assert.equal(fs.readFileSync(activeFile, "utf8").trim(), "spare");
  });
});

await run("prefers pinned healthy accounts and ignores excluded ones in recommendation", async () => {
  const cdxDir = mkTempDir("cdx-test-pinned-recommend-");
  const codexHome = mkTempDir("cdx-test-pinned-recommend-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const entries = [
      {
        account: {
          name: "pinned",
          path: "C:/tmp/pinned.auth.json",
          pinned: true,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 55, resetAt: "18:40", resetAtSeconds: 20 },
          secondary: { label: "weekly", remainingPercent: 55, resetAt: "2039-09-18 18:40", resetAtSeconds: 200 },
        },
      },
      {
        account: {
          name: "excluded",
          path: "C:/tmp/excluded.auth.json",
          pinned: false,
          excludedFromRecommendation: true,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 99, resetAt: "18:40", resetAtSeconds: 10 },
          secondary: { label: "weekly", remainingPercent: 99, resetAt: "2039-09-18 18:40", resetAtSeconds: 100 },
        },
      },
      {
        account: {
          name: "normal",
          path: "C:/tmp/normal.auth.json",
          pinned: false,
          excludedFromRecommendation: false,
        },
        status: {
          available: true,
          primary: { label: "5h", remainingPercent: 50, resetAt: "18:40", resetAtSeconds: 15 },
          secondary: { label: "weekly", remainingPercent: 50, resetAt: "2039-09-18 18:40", resetAtSeconds: 150 },
        },
      },
    ];

    assert.equal(internal.getRecommendedSwitchAccount(entries, "", ""), "pinned");
  });
});

await run("builds switch account options from live limits and reuses cache", async () => {
  const cdxDir = mkTempDir("cdx-test-live-switch-");
  const codexHome = mkTempDir("cdx-test-live-switch-home-");
  const authDir = path.join(cdxDir, "auth");
  const accountsFile = path.join(cdxDir, "accounts.json");

  fs.mkdirSync(authDir, { recursive: true });
  const workAuth = path.join(authDir, "work.auth.json");
  const personalAuth = path.join(authDir, "personal.auth.json");
  writeAuthSnapshot(workAuth, "acct-1", "snapshot-work@example.com", "plus");
  writeAuthSnapshot(personalAuth, "acct-2", "snapshot-personal@example.com", "plus");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify(
      [
        { name: "work", path: workAuth },
        { name: "personal", path: personalAuth },
      ],
      null,
      2,
    ),
    "utf8",
  );

  await withEnv(
    {
      CDX_DIR: cdxDir,
      CODEX_HOME: codexHome,
    },
    async (internal) => {
      let fetchCount = 0;
      internal.setLiveRateLimitFetcherForTests(async (accountPath) => {
        fetchCount += 1;
        if (accountPath === workAuth) {
          return {
            available: true,
            email: "acct-1@example.com",
            planType: "plus",
            primary: { label: "5h", remainingPercent: 74, resetAt: "18:40" },
            secondary: { label: "weekly", remainingPercent: 91, resetAt: "2039-09-18 18:40" },
            errorCode: "",
          };
        }

        return {
          available: true,
          email: "acct-2@example.com",
          planType: "plus",
          primary: { label: "5h", remainingPercent: 60, resetAt: "18:40" },
          secondary: { label: "weekly", remainingPercent: 80, resetAt: "2039-09-18 18:40" },
          errorCode: "",
        };
      });

      const accounts = internal.readAccounts();
      const firstOptions = await internal.buildSwitchAccountOptions(accounts, "work", "");
      assert.equal(firstOptions.length, 2);
      assert.equal(stripAnsi(firstOptions[0].label), "    work   acct-1@example.com   5h  74% (reset 18:40)   [RECOMMENDED]  [ACTIVE]");
      assert.equal(firstOptions[0].hint, "5h 74% (reset 18:40)  ·  weekly 91% (reset 2039-09-18 18:40)");
      assert.equal(stripAnsi(firstOptions[1].label), "personal   acct-2@example.com   5h  60% (reset 18:40)");
      assert.equal(firstOptions[1].hint, "5h 60% (reset 18:40)  ·  weekly 80% (reset 2039-09-18 18:40)");
      assert.equal(fetchCount, 2);

      const secondOptions = await internal.buildSwitchAccountOptions(accounts, "work", "");
      assert.equal(fetchCount, 2);
      assert.deepEqual(secondOptions, firstOptions);
    },
  );
});

await run("exports a reusable manual entrypoint", async () => {
  const manual = require("../lib/cdx/manual");
  assert.equal(typeof manual.runManualEntryPoint, "function");
});

await run("manual entrypoint enforces TTY, initializes state, and runs interactive flow", async () => {
  const { runManualEntryPoint } = require("../lib/cdx/manual");
  const calls = [];
  const migration = { migrated: true, count: 2 };
  let interactiveArg = null;

  await runManualEntryPoint({
    requireTTY() {
      calls.push("requireTTY");
    },
    ensureState() {
      calls.push("ensureState");
      return migration;
    },
    async runInteractive(value) {
      calls.push("runInteractive");
      interactiveArg = value;
    },
    PromptCancelledError: class PromptCancelledError extends Error {},
    async loadPrompts() {
      throw new Error("loadPrompts should not run during the success path");
    },
    die(message) {
      throw new Error(`die should not be called: ${message}`);
    },
    exit(code) {
      throw new Error(`exit should not be called: ${code}`);
    },
  });

  assert.deepEqual(calls, ["requireTTY", "ensureState", "runInteractive"]);
  assert.equal(interactiveArg, migration);
});

await run("manual entrypoint handles prompt cancellation through prompts and injected exit", async () => {
  const { runManualEntryPoint } = require("../lib/cdx/manual");
  class PromptCancelledError extends Error {}

  let cancelMessage = "";
  let exitCode = null;

  await runManualEntryPoint({
    requireTTY() {},
    ensureState() {
      return { migrated: false, count: 0 };
    },
    async runInteractive() {
      throw new PromptCancelledError();
    },
    PromptCancelledError,
    async loadPrompts() {
      return {
        cancel(message) {
          cancelMessage = message;
        },
      };
    },
    die(message) {
      throw new Error(`die should not be called: ${message}`);
    },
    exit(code) {
      exitCode = code;
    },
  });

  assert.equal(cancelMessage, "Operation cancelled");
  assert.equal(exitCode, 1);
});

await run("manual entrypoint returns a status on prompt cancellation without exit injection", async () => {
  const { runManualEntryPoint } = require("../lib/cdx/manual");
  class PromptCancelledError extends Error {}

  let cancelMessage = "";
  const originalExit = process.exit;
  process.exit = () => {
    throw new Error("process.exit should not be called without an injected exit");
  };

  try {
    const result = await runManualEntryPoint({
      requireTTY() {},
      ensureState() {
        return { migrated: false, count: 0 };
      },
      async runInteractive() {
        throw new PromptCancelledError();
      },
      PromptCancelledError,
      async loadPrompts() {
        return {
          cancel(message) {
            cancelMessage = message;
          },
        };
      },
      die(message) {
        throw new Error(`die should not be called: ${message}`);
      },
    });

    assert.equal(cancelMessage, "Operation cancelled");
    assert.equal(result, 1);
  } finally {
    process.exit = originalExit;
  }
});

await run("manual entrypoint routes non-cancel errors through die", async () => {
  const { runManualEntryPoint } = require("../lib/cdx/manual");
  class PromptCancelledError extends Error {}

  let dieMessage = "";

  await runManualEntryPoint({
    requireTTY() {},
    ensureState() {
      return { migrated: false, count: 0 };
    },
    async runInteractive() {
      throw new Error("interactive failed");
    },
    PromptCancelledError,
    async loadPrompts() {
      throw new Error("loadPrompts should not run for non-cancel errors");
    },
    die(message) {
      dieMessage = message;
    },
    exit(code) {
      throw new Error(`exit should not be called: ${code}`);
    },
  });

  assert.equal(dieMessage, "interactive failed");
});

await run("keeps smart-switch internals available after manual extraction", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-plan-manual-"), CODEX_HOME: mkTempDir("cdx-plan-home-") }, async (internal) => {
    assert.equal(typeof internal.runSmartSwitchOperation, "function");
    assert.equal(typeof internal.ensureState, "function");
  });
});

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

await run("keeps smart-switch json as an explicit subcommand", async () => {
  const { decideCdxMode } = require("../lib/cdx/dispatcher");
  assert.equal(decideCdxMode({ args: ["smart-switch", "--json"], isTTY: false }).kind, "smart-switch-json");
});

await run("routes codex-style invocations to the wrapper lane", async () => {
  const { decideCdxMode } = require("../lib/cdx/dispatcher");

  assert.deepEqual(
    decideCdxMode({ args: [], isTTY: true }),
    { kind: "wrapper", forwardedArgs: [], isTTY: true },
  );

  assert.deepEqual(
    decideCdxMode({ args: ["resume", "--last"], isTTY: true }),
    { kind: "wrapper", forwardedArgs: ["resume", "--last"], isTTY: true },
  );

  assert.deepEqual(
    decideCdxMode({ args: ["exec", "print('hi')"], isTTY: false }),
    { kind: "wrapper", forwardedArgs: ["exec", "print('hi')"], isTTY: false },
  );
});

await run("manual menu exposes smart, Account list, Add account, settings, and exit", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-menu-shape-"), CODEX_HOME: mkTempDir("cdx-menu-shape-home-") }, async (internal) => {
    const options = internal.getManualActionOptions();
    assert.deepEqual(
      options.map((entry) => entry.value),
      ["smart", "switch", "add", "settings", "exit"],
    );
    const switchOption = options.find((entry) => entry.value === "switch");
    assert.equal(switchOption.label, "Account list");
    const addOption = options.find((entry) => entry.value === "add");
    assert.equal(addOption.label, "Add account");
    assert.equal(typeof internal.opRemove, "function");
    assert.equal(typeof internal.opRename, "function");
    assert.equal(typeof internal.runAccountListPicker, "function");
    assert.equal(typeof internal.performAccountCleanup, "function");
    assert.equal(typeof internal.performAccountAddition, "function");
    assert.equal(typeof internal.getFirstAvailableNumericAccountName, "function");
  });
});

await run("formatFiveHourInline renders percent+reset colored, with placeholders when unavailable", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-inline-"), CODEX_HOME: mkTempDir("cdx-inline-home-") }, async (internal) => {
    const inline = (status) => stripAnsi(internal.formatFiveHourInline(status));

    assert.equal(
      inline({ available: true, primary: { label: "5h", remainingPercent: 82, resetAt: "18:40" } }),
      "5h  82% (reset 18:40)",
    );
    assert.equal(
      inline({ available: true, primary: { label: "5h", remainingPercent: 0, resetAt: "18:40" } }),
      "5h   0% (reset 18:40)",
    );
    assert.equal(
      inline({ available: true, primary: { label: "5h", remainingPercent: 100, resetAt: "18:40" } }),
      "5h 100% (reset 18:40)",
    );
    assert.equal(
      inline({ available: true, primary: { label: "5h", remainingPercent: 40 } }),
      "5h  40% (reset —)",
    );
    assert.equal(inline({ available: false }), "5h   — (reset —)");
    assert.equal(inline(null), "5h   — (reset —)");
    assert.equal(
      inline({ available: true, primary: { label: "5h", remainingPercent: "bogus" } }),
      "5h   — (reset —)",
    );
  });
});

await run("opRemove clears the account's health entry so a reused name starts fresh", async () => {
  const cdxDir = mkTempDir("cdx-opremove-cleanup-");
  const codexHome = mkTempDir("cdx-opremove-cleanup-home-");
  const authDir = path.join(cdxDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const authPath = path.join(authDir, "2.auth.json");
  writeAuthSnapshot(authPath, "acct-2", "two@example.com", "plus");
  fs.writeFileSync(
    path.join(cdxDir, "accounts.json"),
    JSON.stringify([{ name: "1", path: authPath }, { name: "2", path: authPath }], null, 2),
    "utf8",
  );

  const { readAccountHealth, writeAccountHealth } = require("../lib/cdx/account-health");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    writeAccountHealth({
      "2": {
        consecutiveFailures: 2,
        lastFailureAt: "2026-04-24T00:00:00.000Z",
        lastSuccessAt: "",
        lastErrorCode: "rate_limits_failed",
      },
      "1": { consecutiveFailures: 1 },
    });
    assert.ok(readAccountHealth()["2"]);

    internal.opRemove("2");

    const afterRemove = readAccountHealth();
    assert.equal(afterRemove["2"], undefined);
    assert.ok(afterRemove["1"], "unrelated account health entries are preserved");

    const nextName = internal.getFirstAvailableNumericAccountName(internal.readAccounts());
    assert.equal(nextName, "2", "the freed numeric slot is immediately reusable");
    assert.equal(readAccountHealth()["2"], undefined, "reused name has no inherited failure counter");
  });
});

await run("sortEntriesByFiveHour puts highest 5h remaining on top and unavailable at the bottom", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-sort-5h-"), CODEX_HOME: mkTempDir("cdx-sort-5h-home-") }, async (internal) => {
    const entries = [
      { account: { name: "a" }, status: { available: true, primary: { remainingPercent: 30 } } },
      { account: { name: "b" }, status: { available: true, primary: { remainingPercent: 90 } } },
      { account: { name: "c" }, status: { available: false } },
      { account: { name: "d" }, status: { available: true, primary: { remainingPercent: 0 } } },
      { account: { name: "e" }, status: { available: true, primary: { remainingPercent: 90 } } },
      { account: { name: "f" }, status: { available: true, primary: { remainingPercent: 60 } } },
    ];

    const sorted = internal.sortEntriesByFiveHour(entries);
    assert.deepEqual(
      sorted.map((entry) => entry.account.name),
      ["b", "e", "f", "a", "d", "c"],
    );
  });
});

await run("evaluateCurrentAuthRegistration detects unsaved current Codex auth with suggested numeric name", async () => {
  const cdxDir = mkTempDir("cdx-reg-unsaved-");
  const codexHome = mkTempDir("cdx-reg-unsaved-home-");
  fs.mkdirSync(codexHome, { recursive: true });
  writeAuthSnapshot(path.join(codexHome, "auth.json"), "acct-live", "live@example.com", "plus");

  const authDir = path.join(cdxDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const savedAuth = path.join(authDir, "1.auth.json");
  writeAuthSnapshot(savedAuth, "acct-saved", "saved@example.com", "plus");
  fs.writeFileSync(
    path.join(cdxDir, "accounts.json"),
    JSON.stringify([{ name: "1", path: savedAuth }], null, 2),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const decision = internal.evaluateCurrentAuthRegistration();
    assert.equal(decision.needed, true);
    assert.equal(decision.reason, "unsaved");
    assert.equal(decision.currentEmail, "live@example.com");
    assert.equal(decision.suggestedName, "2");
  });
});

await run("evaluateCurrentAuthRegistration skips when current auth matches a saved account", async () => {
  const cdxDir = mkTempDir("cdx-reg-matched-");
  const codexHome = mkTempDir("cdx-reg-matched-home-");
  fs.mkdirSync(codexHome, { recursive: true });
  writeAuthSnapshot(path.join(codexHome, "auth.json"), "acct-42", "me@example.com", "plus");

  const authDir = path.join(cdxDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const savedAuth = path.join(authDir, "work.auth.json");
  writeAuthSnapshot(savedAuth, "acct-42", "me@example.com", "plus");
  fs.writeFileSync(
    path.join(cdxDir, "accounts.json"),
    JSON.stringify([{ name: "work", path: savedAuth }], null, 2),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const decision = internal.evaluateCurrentAuthRegistration();
    assert.equal(decision.needed, false);
    assert.equal(decision.reason, "already_saved");
    assert.equal(decision.matchedName, "work");
  });
});

await run("evaluateCurrentAuthRegistration skips when no Codex auth file is present", async () => {
  const cdxDir = mkTempDir("cdx-reg-no-auth-");
  const codexHome = mkTempDir("cdx-reg-no-auth-home-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const decision = internal.evaluateCurrentAuthRegistration();
    assert.equal(decision.needed, false);
    assert.equal(decision.reason, "no_codex_auth");
  });
});

await run("evaluateCurrentAuthRegistration skips when auth file lacks identity", async () => {
  const cdxDir = mkTempDir("cdx-reg-bad-auth-");
  const codexHome = mkTempDir("cdx-reg-bad-auth-home-");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }, null, 2),
    "utf8",
  );

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: codexHome }, async (internal) => {
    const decision = internal.evaluateCurrentAuthRegistration();
    assert.equal(decision.needed, false);
    assert.equal(decision.reason, "missing_identity");
  });
});

await run("decideAccountCleanups skips when offline or when no accounts responded", async () => {
  const { decideAccountCleanups } = require("../lib/cdx/account-health");

  const offlineDecision = decideAccountCleanups({
    entries: [{ account: { name: "a" }, status: { available: true } }],
    cacheFreshness: new Map([["a", false]]),
    health: {},
    activeName: "",
    isOnline: false,
    threshold: 3,
  });
  assert.equal(offlineDecision.skipped, true);
  assert.equal(offlineDecision.reason, "offline");
  assert.deepEqual(offlineDecision.toDelete, []);

  const noSuccess = decideAccountCleanups({
    entries: [
      { account: { name: "a" }, status: { available: false, errorCode: "rate_limits_failed" } },
      { account: { name: "b" }, status: { available: false, errorCode: "rate_limits_failed" } },
    ],
    cacheFreshness: new Map([["a", false], ["b", false]]),
    health: {},
    activeName: "a",
    isOnline: true,
    threshold: 3,
  });
  assert.equal(noSuccess.skipped, true);
  assert.equal(noSuccess.reason, "no_successful_accounts");
  assert.deepEqual(noSuccess.toDelete, []);
});

await run("decideAccountCleanups increments fresh failures and deletes after threshold", async () => {
  const { decideAccountCleanups } = require("../lib/cdx/account-health");

  const first = decideAccountCleanups({
    entries: [
      { account: { name: "ok" }, status: { available: true } },
      { account: { name: "broken" }, status: { available: false, errorCode: "rate_limits_failed" } },
    ],
    cacheFreshness: new Map([["ok", false], ["broken", false]]),
    health: {},
    activeName: "ok",
    isOnline: true,
    threshold: 3,
    now: () => "2026-04-24T00:00:00.000Z",
  });
  assert.equal(first.skipped, false);
  assert.deepEqual(first.toDelete, []);
  assert.equal(first.healthUpdates.broken.consecutiveFailures, 1);
  assert.equal(first.healthUpdates.broken.lastErrorCode, "rate_limits_failed");

  const second = decideAccountCleanups({
    entries: [
      { account: { name: "ok" }, status: { available: true } },
      { account: { name: "broken" }, status: { available: false, errorCode: "rate_limits_failed" } },
    ],
    cacheFreshness: new Map([["ok", false], ["broken", false]]),
    health: { broken: { consecutiveFailures: 2 } },
    activeName: "ok",
    isOnline: true,
    threshold: 3,
  });
  assert.deepEqual(second.toDelete, ["broken"]);
  assert.equal(second.healthUpdates.broken.consecutiveFailures, 3);
});

await run("decideAccountCleanups never deletes the active account", async () => {
  const { decideAccountCleanups } = require("../lib/cdx/account-health");

  const decision = decideAccountCleanups({
    entries: [
      { account: { name: "healthy" }, status: { available: true } },
      { account: { name: "primary" }, status: { available: false, errorCode: "rate_limits_failed" } },
    ],
    cacheFreshness: new Map([["healthy", false], ["primary", false]]),
    health: { primary: { consecutiveFailures: 5 } },
    activeName: "primary",
    isOnline: true,
    threshold: 3,
  });
  assert.deepEqual(decision.toDelete, []);
  assert.equal(decision.healthUpdates.primary.consecutiveFailures, 6);
});

await run("decideAccountCleanups resets counter on success and skips cached accounts", async () => {
  const { decideAccountCleanups } = require("../lib/cdx/account-health");

  const decision = decideAccountCleanups({
    entries: [
      { account: { name: "recovered" }, status: { available: true } },
      { account: { name: "cached-fail" }, status: { available: false, errorCode: "rate_limits_failed" } },
    ],
    cacheFreshness: new Map([["recovered", false], ["cached-fail", true]]),
    health: { recovered: { consecutiveFailures: 2 }, "cached-fail": { consecutiveFailures: 1 } },
    activeName: "recovered",
    isOnline: true,
    threshold: 3,
  });
  assert.deepEqual(decision.toDelete, []);
  assert.equal(decision.healthUpdates.recovered.consecutiveFailures, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(decision.healthUpdates, "cached-fail"), false);
});

await run("readAccountHealth / writeAccountHealth round-trip with normalization", async () => {
  const cdxDir = mkTempDir("cdx-health-roundtrip-");

  await withEnv({ CDX_DIR: cdxDir, CODEX_HOME: mkTempDir("cdx-health-home-") }, async () => {
    const { readAccountHealth, writeAccountHealth } = require("../lib/cdx/account-health");

    assert.deepEqual(readAccountHealth(), {});

    writeAccountHealth({
      alpha: { consecutiveFailures: 2, lastFailureAt: "2026-04-24T00:00:00.000Z", lastErrorCode: "rate_limits_failed" },
      beta: { consecutiveFailures: "not-a-number" },
      "": { consecutiveFailures: 3 },
      garbage: "skip-me",
    });

    const loaded = readAccountHealth();
    assert.deepEqual(loaded, {
      alpha: {
        consecutiveFailures: 2,
        lastFailureAt: "2026-04-24T00:00:00.000Z",
        lastSuccessAt: "",
        lastErrorCode: "rate_limits_failed",
      },
      beta: {
        consecutiveFailures: 0,
        lastFailureAt: "",
        lastSuccessAt: "",
        lastErrorCode: "",
      },
    });
  });
});

await run("classifyKeypress distinguishes delete, rename, add, and ignores normal keys", async () => {
  const { classifyKeypress } = require("../lib/cdx/account-list-prompt");

  assert.equal(classifyKeypress({ name: "delete", sequence: "\x1b[3~" }), "delete");
  assert.equal(classifyKeypress({ name: "tab", sequence: "\t" }), "rename");
  assert.equal(classifyKeypress({ name: "space", sequence: " " }), "add");
  assert.equal(classifyKeypress({ sequence: "\x1b[3~" }), "delete");
  assert.equal(classifyKeypress({ sequence: "\t" }), "rename");
  assert.equal(classifyKeypress({ sequence: " " }), "add");
  assert.equal(classifyKeypress({ name: "up", sequence: "\x1b[A" }), "");
  assert.equal(classifyKeypress(null), "");
});

await run("renderAccountListView renders cyan bar, arrow on cursor, dim rest", async () => {
  const { renderAccountListView } = require("../lib/cdx/account-list-prompt");

  const frame = renderAccountListView({
    message: "Account list",
    hint: "Esc back",
    state: "active",
    cursor: 1,
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ],
    theme: { style: (_kind, text) => text },
  });

  assert.equal(
    frame,
    [
      "│",
      "│  Account list",
      "│  ○ Alpha",
      "│  ❯ Beta",
      "│  ○ Gamma",
      "│",
      "│  Esc back",
      "│",
    ].join("\n"),
  );
});

await run("formatMainMenuMessage reflects active account and wifi status", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-menu-msg-"), CODEX_HOME: mkTempDir("cdx-menu-msg-home-") }, async (internal) => {
    assert.equal(
      stripAnsi(internal.formatMainMenuMessage("10", true)),
      "Choose an action (active: 10 · wifi ok)",
    );
    assert.equal(
      stripAnsi(internal.formatMainMenuMessage("10", false)),
      "Choose an action (active: 10 · wifi down)",
    );
    assert.equal(
      stripAnsi(internal.formatMainMenuMessage("", true)),
      "Choose an action (no active account · wifi ok)",
    );
  });
});

await run("checkWifiStatus caches the result within TTL and refetches after expiry", async () => {
  const connectivity = require("../lib/cdx/connectivity");

  await withEnv({ CDX_DIR: mkTempDir("cdx-wifi-cache-"), CODEX_HOME: mkTempDir("cdx-wifi-cache-home-") }, async (internal) => {
    internal.resetWifiStatusCacheForTests();
    let calls = 0;
    connectivity.setConnectivityCheckForTests(async () => {
      calls += 1;
      return true;
    });
    try {
      const frozenNow = 1_000_000;
      assert.equal(await internal.checkWifiStatus(() => frozenNow), true);
      assert.equal(calls, 1);
      assert.equal(await internal.checkWifiStatus(() => frozenNow + 5_000), true);
      assert.equal(calls, 1, "second call within TTL reuses the cached value");
      assert.equal(await internal.checkWifiStatus(() => frozenNow + 20_000), true);
      assert.equal(calls, 2, "after the TTL a fresh probe is issued");
    } finally {
      connectivity.setConnectivityCheckForTests(null);
      internal.resetWifiStatusCacheForTests();
    }
  });
});

await run("isOnline uses the injected check and honors timeouts", async () => {
  const connectivity = require("../lib/cdx/connectivity");

  connectivity.setConnectivityCheckForTests(async () => true);
  assert.equal(await connectivity.isOnline(), true);

  connectivity.setConnectivityCheckForTests(async () => false);
  assert.equal(await connectivity.isOnline(), false);

  connectivity.setConnectivityCheckForTests(null);
});

await run("getFirstAvailableNumericAccountName returns the smallest unused integer name", async () => {
  await withEnv({ CDX_DIR: mkTempDir("cdx-auto-name-"), CODEX_HOME: mkTempDir("cdx-auto-name-home-") }, async (internal) => {
    const nextEmpty = internal.getFirstAvailableNumericAccountName([]);
    assert.equal(nextEmpty, "1");

    const nextWithOne = internal.getFirstAvailableNumericAccountName([{ name: "1" }]);
    assert.equal(nextWithOne, "2");

    const nextSkipSuffixes = internal.getFirstAvailableNumericAccountName([
      { name: "1" },
      { name: "3" },
      { name: "samu2" },
      { name: "work" },
    ]);
    assert.equal(nextSkipSuffixes, "2");

    const nextFillGap = internal.getFirstAvailableNumericAccountName([
      { name: "1" },
      { name: "2" },
      { name: "4" },
    ]);
    assert.equal(nextFillGap, "3");
  });
});

process.stdout.write("all regression tests passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
