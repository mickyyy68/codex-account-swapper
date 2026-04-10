#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CDX_DIR = process.env.CDX_DIR || path.join(os.homedir(), ".cdx");
const ACCOUNTS_FILE = path.join(CDX_DIR, "accounts.json");
const LEGACY_ACCOUNTS_FILE = path.join(CDX_DIR, "accounts.tsv");
const MIGRATION_MARKER = path.join(CDX_DIR, ".migration_accounts_tsv_v1.done");
const ACTIVE_FILE = path.join(CDX_DIR, "active");
const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const TARGET_AUTH = path.join(CODEX_HOME_DIR, "auth.json");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const AUTH_EMAIL_CACHE = new Map();

function die(message) {
  process.stderr.write(`cdx: ${message}\n`);
  process.exit(1);
}

function ensureState() {
  fs.mkdirSync(CDX_DIR, { recursive: true });
  const migration = migrateLegacyAccountsOnce();
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, "[]\n", "utf8");
  }
  return migration;
}

function writeMigrationMarker(extra = "") {
  const body = extra
    ? `migrated_at=${new Date().toISOString()}\n${extra}\n`
    : `migrated_at=${new Date().toISOString()}\n`;
  fs.writeFileSync(MIGRATION_MARKER, body, "utf8");
}

function parseLegacyAccountsTsv(filePath) {
  const rows = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const accounts = [];
  for (const row of rows) {
    const parts = row.split("\t");
    if (parts.length < 2) {
      continue;
    }
    const name = (parts[0] || "").trim();
    const accountPath = (parts[1] || "").trim();
    if (!name || !accountPath) {
      continue;
    }

    const existing = accounts.findIndex((entry) => entry.name === name);
    const next = { name, path: accountPath };
    if (existing >= 0) {
      accounts[existing] = next;
    } else {
      accounts.push(next);
    }
  }

  return accounts;
}

function readAccountsFromJson(filePath) {
  const data = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(data);
  if (!Array.isArray(parsed)) {
    die(`invalid accounts file at ${filePath}`);
  }

  return parsed
    .filter(
      (entry) =>
        entry &&
        typeof entry.name === "string" &&
        typeof entry.path === "string" &&
        entry.name.trim() &&
        entry.path.trim(),
    )
    .map((entry) => ({ name: entry.name.trim(), path: entry.path.trim() }));
}

function migrateLegacyAccountsOnce() {
  if (fs.existsSync(MIGRATION_MARKER)) {
    return { migrated: false, count: 0 };
  }

  const hasLegacy = fs.existsSync(LEGACY_ACCOUNTS_FILE);
  const hasJson = fs.existsSync(ACCOUNTS_FILE);

  if (hasJson) {
    const existing = readAccountsFromJson(ACCOUNTS_FILE);
    if (existing.length > 0) {
      writeMigrationMarker("reason=accounts_json_nonempty");
      return { migrated: false, count: 0 };
    }
  }

  if (!hasLegacy) {
    return { migrated: false, count: 0 };
  }

  const migratedAccounts = parseLegacyAccountsTsv(LEGACY_ACCOUNTS_FILE);
  if (migratedAccounts.length === 0) {
    return { migrated: false, count: 0, warning: "legacy_no_valid_rows" };
  }

  writeAccounts(migratedAccounts);
  writeMigrationMarker(`count=${migratedAccounts.length}\nreason=legacy_tsv_imported`);
  return { migrated: true, count: migratedAccounts.length };
}

function readAccounts() {
  try {
    return readAccountsFromJson(ACCOUNTS_FILE);
  } catch (err) {
    die(`failed to read accounts: ${err.message}`);
  }
}

function writeAccounts(accounts) {
  const json = `${JSON.stringify(accounts, null, 2)}\n`;
  fs.writeFileSync(ACCOUNTS_FILE, json, "utf8");
}

function getActive() {
  if (!fs.existsSync(ACTIVE_FILE)) {
    return "";
  }
  return fs.readFileSync(ACTIVE_FILE, "utf8").trim();
}

function setActive(name) {
  fs.writeFileSync(ACTIVE_FILE, `${name}\n`, "utf8");
}

function clearActive() {
  if (fs.existsSync(ACTIVE_FILE)) {
    fs.rmSync(ACTIVE_FILE, { force: true });
  }
}

function upsertAccount(accounts, name, accountPath) {
  let found = false;
  const next = accounts.map((entry) => {
    if (entry.name === name) {
      found = true;
      return { name, path: accountPath };
    }
    return entry;
  });
  if (!found) {
    next.push({ name, path: accountPath });
  }
  return next;
}

function findAccount(accounts, name) {
  return accounts.find((entry) => entry.name === name);
}

function isRegularFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function isManagedSnapshot(filePath) {
  const snapshotRoot = path.resolve(CDX_DIR, "auth");
  const resolvedPath = path.resolve(filePath);
  return resolvedPath.startsWith(`${snapshotRoot}${path.sep}`);
}

function toEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return EMAIL_RE.test(trimmed) ? trimmed : "";
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") {
    return null;
  }

  const raw = token.trim().replace(/^Bearer\s+/i, "");
  const parts = raw.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(base64 + padding, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function emailFromToken(tokenValue) {
  const payload = decodeJwtPayload(tokenValue);
  if (!payload) {
    return "";
  }

  const candidateClaims = [
    payload.email,
    payload.upn,
    payload.preferred_username,
    payload.unique_name,
  ];
  for (const claim of candidateClaims) {
    const email = toEmail(claim);
    if (email) {
      return email;
    }
  }
  return "";
}

function extractEmailFromObject(input) {
  if (!input || typeof input !== "object") {
    return "";
  }

  const stack = [input];
  const seen = new Set();

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push(item);
      }
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        if (/(email|mail)/i.test(key)) {
          const direct = toEmail(value);
          if (direct) {
            return direct;
          }
        }

        if (/(token|id_token|access_token)/i.test(key)) {
          const tokenEmail = emailFromToken(value);
          if (tokenEmail) {
            return tokenEmail;
          }
        }

        if (/(username|preferred_username|upn|login)/i.test(key)) {
          const userEmail = toEmail(value);
          if (userEmail) {
            return userEmail;
          }
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return "";
}

function getAccountEmail(accountPath) {
  try {
    const stat = fs.statSync(accountPath);
    if (!stat.isFile()) {
      AUTH_EMAIL_CACHE.delete(accountPath);
      return "";
    }

    const cached = AUTH_EMAIL_CACHE.get(accountPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.email;
    }

    const raw = fs.readFileSync(accountPath, "utf8");
    const parsed = JSON.parse(raw);
    const email = extractEmailFromObject(parsed);
    AUTH_EMAIL_CACHE.set(accountPath, { mtimeMs: stat.mtimeMs, size: stat.size, email });
    return email;
  } catch (_) {
    AUTH_EMAIL_CACHE.delete(accountPath);
    return "";
  }
}

function accountDisplayName(account) {
  const email = getAccountEmail(account.path);
  if (!email) {
    return account.name;
  }
  if (account.name.toLowerCase().includes(email.toLowerCase())) {
    return account.name;
  }
  return `${account.name} <${email}>`;
}

function applyAuthFile(sourceAuth) {
  if (!isRegularFile(sourceAuth)) {
    die(`auth file does not exist: ${sourceAuth}`);
  }

  fs.mkdirSync(CODEX_HOME_DIR, { recursive: true });
  if (fs.existsSync(TARGET_AUTH)) {
    fs.copyFileSync(TARGET_AUTH, `${TARGET_AUTH}.bak`);
  }
  fs.copyFileSync(sourceAuth, TARGET_AUTH);
  try {
    fs.chmodSync(TARGET_AUTH, 0o600);
  } catch (_) {
    // Ignore chmod failures on non-POSIX systems.
  }
}

function opAdd(name, rawPath) {
  const fullPath = path.resolve(rawPath);
  if (!isRegularFile(fullPath)) {
    die(`auth file not found: ${fullPath}`);
  }

  const accounts = readAccounts();
  writeAccounts(upsertAccount(accounts, name, fullPath));
  if (!getActive()) {
    setActive(name);
  }
  return `Registered account '${name}' -> ${fullPath}`;
}

function opSave(name) {
  if (!isRegularFile(TARGET_AUTH)) {
    die(`no current auth found at ${TARGET_AUTH}. Run 'codex login' first.`);
  }

  const snapshotDir = path.join(CDX_DIR, "auth");
  const snapshotPath = path.join(snapshotDir, `${name}.auth.json`);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.copyFileSync(TARGET_AUTH, snapshotPath);
  try {
    fs.chmodSync(snapshotPath, 0o600);
  } catch (_) {
    // Ignore chmod failures on non-POSIX systems.
  }

  const accounts = readAccounts();
  writeAccounts(upsertAccount(accounts, name, snapshotPath));
  if (!getActive()) {
    setActive(name);
  }
  return `Saved current auth as '${name}'`;
}

function opUse(name) {
  const accounts = readAccounts();
  const account = findAccount(accounts, name);
  if (!account) {
    die(`unknown account: ${name}`);
  }
  applyAuthFile(account.path);
  setActive(name);
  return `Switched to account '${name}'`;
}

function opRename(oldName, newName) {
  const accounts = readAccounts();
  const oldIndex = accounts.findIndex((entry) => entry.name === oldName);
  if (oldIndex < 0) {
    die(`unknown account: ${oldName}`);
  }

  if (oldName === newName) {
    return "Rename target is the same account; nothing changed.";
  }

  const collisionIndex = accounts.findIndex((entry) => entry.name === newName);
  if (collisionIndex >= 0) {
    die(`account name already exists: ${newName}`);
  }

  accounts[oldIndex] = { ...accounts[oldIndex], name: newName };
  writeAccounts(accounts);

  if (getActive() === oldName) {
    setActive(newName);
  }

  return `Renamed account '${oldName}' to '${newName}'`;
}

function opSwap(aName, bName) {
  const accounts = readAccounts();
  if (accounts.length < 2) {
    die("need at least 2 configured accounts to swap");
  }

  const firstIndex = accounts.findIndex((entry) => entry.name === aName);
  const secondIndex = accounts.findIndex((entry) => entry.name === bName);
  if (firstIndex < 0 || secondIndex < 0) {
    die("unknown account selected for swap");
  }

  if (firstIndex === secondIndex) {
    return "Swap target is the same account; nothing changed.";
  }

  const firstName = accounts[firstIndex].name;
  const secondName = accounts[secondIndex].name;
  [accounts[firstIndex], accounts[secondIndex]] = [accounts[secondIndex], accounts[firstIndex]];
  writeAccounts(accounts);
  return `Swapped '${firstName}' with '${secondName}'`;
}

function opRemove(name) {
  const accounts = readAccounts();
  const removed = findAccount(accounts, name);
  if (!removed) {
    die(`unknown account: ${name}`);
  }

  const remaining = accounts.filter((entry) => entry.name !== name);
  writeAccounts(remaining);

  if (isManagedSnapshot(removed.path) && isRegularFile(removed.path)) {
    fs.rmSync(removed.path, { force: true });
  }

  const active = getActive();
  if (active !== name) {
    return `Removed account '${name}'`;
  }

  const next = remaining.find((entry) => isRegularFile(entry.path));
  if (!next) {
    clearActive();
    return `Removed account '${name}'. No active account remains.`;
  }

  applyAuthFile(next.path);
  setActive(next.name);
  return `Removed account '${name}'. Switched to '${next.name}'.`;
}

function toAccountOptions(accounts, activeName, disabledName) {
  return accounts.map((account) => {
    const hints = [];
    if (account.name === activeName) {
      hints.push("active");
    }
    hints.push(account.path);

    return {
      value: account.name,
      label: accountDisplayName(account),
      hint: hints.join(" · "),
      disabled: account.name === disabledName,
    };
  });
}

function displayAccountList(p) {
  const active = getActive();
  const accounts = readAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured.");
    return;
  }

  const lines = accounts.map((account, index) => {
    const marker = account.name === active ? "*" : " ";
    return `${String(index + 1).padStart(2, " ")} ${marker} ${accountDisplayName(account)}  ${account.path}`;
  });
  p.note(lines.join("\n"), "Configured Accounts");
}

async function loadPrompts() {
  try {
    return await import("@clack/prompts");
  } catch (err) {
    die(
      `failed to load @clack/prompts (${err.message}). Install dependencies and try again.`,
    );
  }
}

function requireTTY() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die("interactive terminal required. Run `cdx` in a TTY.");
  }
}

class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

async function promptValue(p, promise) {
  const value = await promise;
  if (p.isCancel(value)) {
    throw new PromptCancelledError();
  }
  return value;
}

async function chooseAccount(p, message, opts = {}) {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    p.log.warn("No accounts configured.");
    return "";
  }

  const selection = await promptValue(
    p,
    p.select({
      message,
      options: toAccountOptions(accounts, getActive(), opts.disabledName),
      initialValue: opts.initialValue,
    }),
  );
  return selection;
}

async function runInteractive(migration) {
  const p = await loadPrompts();
  p.intro("cdx");
  if (migration.migrated) {
    p.log.info(
      `Imported ${migration.count} account${migration.count === 1 ? "" : "s"} from legacy accounts.tsv`,
    );
  } else if (migration.warning === "legacy_no_valid_rows") {
    p.log.warn("Found legacy accounts.tsv but no valid rows were imported.");
  }

  while (true) {
    const active = getActive();
    const action = await promptValue(
      p,
      p.select({
        message: active ? `Choose an action (active: ${active})` : "Choose an action",
        options: [
          { value: "use", label: "Use account", hint: "Set active account" },
          { value: "switch", label: "Switch account", hint: "Interactive account picker" },
          { value: "save", label: "Save current auth as account" },
          { value: "add", label: "Add account from auth file" },
          { value: "rename", label: "Rename account" },
          { value: "swap", label: "Swap account order" },
          { value: "remove", label: "Remove account" },
          { value: "list", label: "List accounts" },
          { value: "exit", label: "Exit" },
        ],
      }),
    );

    if (action === "exit") {
      p.outro("Done.");
      return;
    }

    if (action === "list") {
      displayAccountList(p);
      continue;
    }

    if (action === "use") {
      const name = await chooseAccount(p, "Use which account?");
      if (!name) {
        continue;
      }
      p.log.success(opUse(name));
      continue;
    }

    if (action === "switch") {
      const accounts = readAccounts();
      if (accounts.length === 0) {
        p.log.warn("No accounts configured.");
        continue;
      }

      const activeName = getActive();
      const currentIndex = accounts.findIndex((entry) => entry.name === activeName);
      const next = currentIndex < 0 ? accounts[0].name : accounts[(currentIndex + 1) % accounts.length].name;
      const name = await chooseAccount(p, "Switch to which account?", { initialValue: next });
      if (!name) {
        continue;
      }
      p.log.success(opUse(name));
      continue;
    }

    if (action === "save") {
      const name = await promptValue(
        p,
        p.text({
          message: "Save current auth as",
          placeholder: "work",
          validate: (value) => (String(value || "").trim() ? undefined : "Name is required"),
        }),
      );
      const trimmed = String(name).trim();
      const exists = !!findAccount(readAccounts(), trimmed);
      if (exists) {
        const overwrite = await promptValue(
          p,
          p.confirm({
            message: `Account '${trimmed}' exists. Overwrite?`,
            initialValue: false,
          }),
        );
        if (!overwrite) {
          p.log.info("Save cancelled.");
          continue;
        }
      }
      p.log.success(opSave(trimmed));
      continue;
    }

    if (action === "add") {
      const name = await promptValue(
        p,
        p.text({
          message: "Account name",
          placeholder: "personal",
          validate: (value) => (String(value || "").trim() ? undefined : "Name is required"),
        }),
      );

      const authPath = await promptValue(
        p,
        p.path({
          message: "Path to auth.json",
          placeholder: path.join(CODEX_HOME_DIR, "auth.json"),
          validate: (value) => {
            const candidate = path.resolve(String(value || ""));
            return isRegularFile(candidate) ? undefined : "File not found";
          },
        }),
      );

      p.log.success(opAdd(String(name).trim(), String(authPath)));
      continue;
    }

    if (action === "rename") {
      const oldName = await chooseAccount(p, "Rename which account?");
      if (!oldName) {
        continue;
      }
      const accounts = readAccounts();
      const newName = await promptValue(
        p,
        p.text({
          message: `New name for '${oldName}'`,
          placeholder: oldName,
          validate: (value) => {
            const next = String(value || "").trim();
            if (!next) {
              return "Name is required";
            }
            if (next !== oldName && accounts.some((entry) => entry.name === next)) {
              return "Account name already exists";
            }
            return undefined;
          },
        }),
      );
      p.log.success(opRename(oldName, String(newName).trim()));
      continue;
    }

    if (action === "swap") {
      if (readAccounts().length < 2) {
        p.log.warn("Need at least 2 accounts to swap.");
        continue;
      }
      const first = await chooseAccount(p, "First account to swap");
      if (!first) {
        continue;
      }
      const second = await chooseAccount(p, "Second account to swap", {
        disabledName: first,
      });
      if (!second) {
        continue;
      }
      p.log.success(opSwap(first, second));
      continue;
    }

    if (action === "remove") {
      const name = await chooseAccount(p, "Remove which account?");
      if (!name) {
        continue;
      }
      const ok = await promptValue(
        p,
        p.confirm({
          message: `Remove '${name}'?`,
          initialValue: false,
        }),
      );
      if (!ok) {
        p.log.info("Remove cancelled.");
        continue;
      }
      p.log.success(opRemove(name));
      continue;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    die("subcommands were removed. Run `cdx` with no arguments.");
  }

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
  _internal: {
    ensureState,
    migrateLegacyAccountsOnce,
    parseLegacyAccountsTsv,
    readAccountsFromJson,
    readAccounts,
    extractEmailFromObject,
    emailFromToken,
    decodeJwtPayload,
    getAccountEmail,
    accountDisplayName,
  },
};

if (require.main === module) {
  main();
}
