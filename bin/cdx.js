#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
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
const CODEX_BIN = process.env.CDX_CODEX_BIN || "codex";
const CODEX_BIN_ARGS = parseJsonArrayEnv("CDX_CODEX_BIN_ARGS_JSON");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const AUTH_METADATA_CACHE = new Map();
const LIVE_RATE_LIMIT_CACHE = new Map();
const LIVE_RATE_LIMIT_TTL_MS = 45_000;
const APP_SERVER_INITIALIZE_TIMEOUT_MS = 5_000;
const APP_SERVER_ACCOUNT_READ_TIMEOUT_MS = 5_000;
const APP_SERVER_RATE_LIMITS_TIMEOUT_MS = 10_000;
const LIVE_RATE_LIMIT_CONCURRENCY = 2;
const LOW_CREDITS_THRESHOLD = 10;
const LIVE_RATE_LIMIT_TEMP_PREFIX = ".codex-rate-limit-home-";
const LIVE_RATE_LIMIT_TEMP_ROOT = path.join(os.tmpdir(), "cdx-rate-limit-homes");
let LIVE_RATE_LIMIT_FETCHER = null;
let APP_SERVER_QUERY = null;
let RESOLVED_CODEX_BINARY = null;
const ANSI_RESET = "\x1b[0m";
const ANSI = {
  boldGreen: "\x1b[1;32m",
  boldCyan: "\x1b[1;36m",
  boldRed: "\x1b[1;31m",
  boldYellow: "\x1b[1;33m",
  dim: "\x1b[2m",
};

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch (_) {
    return [];
  }
}

function die(message) {
  process.stderr.write(`cdx: ${message}\n`);
  process.exit(1);
}

function normalizeAccountEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (typeof entry.name !== "string" || typeof entry.path !== "string") {
    return null;
  }

  const name = entry.name.trim();
  const accountPath = entry.path.trim();
  if (!name || !accountPath) {
    return null;
  }

  return {
    name,
    path: accountPath,
    pinned: entry.pinned === true,
    excludedFromRecommendation: entry.excludedFromRecommendation === true,
  };
}

function isAccountEntryEqual(left, right) {
  return !!left && !!right &&
    left.name === right.name &&
    left.path === right.path &&
    left.pinned === right.pinned &&
    left.excludedFromRecommendation === right.excludedFromRecommendation;
}

function ensureState() {
  fs.mkdirSync(CDX_DIR, { recursive: true });
  const migration = migrateLegacyAccountsOnce();
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, "[]\n", "utf8");
  }
  const repair = repairAccountsStateOnDisk();
  return { ...migration, repair };
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
    const next = {
      name,
      path: accountPath,
      pinned: false,
      excludedFromRecommendation: false,
    };
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
    .map(normalizeAccountEntry)
    .filter(Boolean);
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

function getNextActiveAccount(accounts, previousActive = "") {
  const preferred = previousActive ? accounts.find((entry) => entry.name === previousActive) : null;
  if (preferred) {
    return preferred;
  }
  return accounts[0] || null;
}

function repairAccountsState(accounts, activeName = "") {
  const normalized = accounts.map((entry) => normalizeAccountEntry(entry)).filter(Boolean);
  const valid = normalized.filter((entry) => isRegularFile(entry.path));
  const removed = normalized.filter((entry) => !isRegularFile(entry.path));
  const changed =
    removed.length > 0 ||
    normalized.length !== accounts.length ||
    normalized.some((entry, index) => !isAccountEntryEqual(entry, accounts[index]));

  const activeMissing = !!activeName && !valid.some((entry) => entry.name === activeName);
  const nextActive = activeMissing ? getNextActiveAccount(valid, activeName) : null;

  return {
    accounts: valid,
    removed,
    changed,
    activeChanged: activeMissing,
    activeName: activeMissing ? (nextActive ? nextActive.name : "") : activeName,
  };
}

function repairAccountsStateOnDisk() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    return {
      accounts: [],
      removed: [],
      changed: false,
      activeChanged: false,
      activeName: getActive(),
    };
  }

  const parsed = readAccountsFromJson(ACCOUNTS_FILE);
  const activeName = getActive();
  const repair = repairAccountsState(parsed, activeName);
  if (repair.changed) {
    writeAccounts(repair.accounts);
  }

  if (repair.activeChanged) {
    if (repair.activeName) {
      setActive(repair.activeName);
    } else {
      clearActive();
    }
  }

  return repair;
}

function upsertAccount(accounts, name, accountPath) {
  let found = false;
  const next = accounts.map((entry) => {
    if (entry.name === name) {
      found = true;
      return {
        ...entry,
        name,
        path: accountPath,
      };
    }
    return entry;
  });
  if (!found) {
    next.push({
      name,
      path: accountPath,
      pinned: false,
      excludedFromRecommendation: false,
    });
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

function normalizePlanType(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function planTypeFromToken(tokenValue) {
  const payload = decodeJwtPayload(tokenValue);
  if (!payload) {
    return "";
  }

  const candidateClaims = [
    payload.chatgpt_plan_type,
    payload.plan_type,
    payload.planType,
  ];
  for (const claim of candidateClaims) {
    const planType = normalizePlanType(claim);
    if (planType) {
      return planType;
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

function extractPlanTypeFromObject(input) {
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
        if (/(chatgpt_plan_type|plan_type|planType)/i.test(key)) {
          const planType = normalizePlanType(value);
          if (planType) {
            return planType;
          }
        }

        if (/(token|id_token|access_token)/i.test(key)) {
          const tokenPlanType = planTypeFromToken(value);
          if (tokenPlanType) {
            return tokenPlanType;
          }
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return "";
}

function getAccountMetadata(accountPath) {
  try {
    const stat = fs.statSync(accountPath);
    if (!stat.isFile()) {
      AUTH_METADATA_CACHE.delete(accountPath);
      return { email: "", planType: "" };
    }

    const cached = AUTH_METADATA_CACHE.get(accountPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { email: cached.email, planType: cached.planType };
    }

    const raw = fs.readFileSync(accountPath, "utf8");
    const parsed = JSON.parse(raw);
    const metadata = {
      email: extractEmailFromObject(parsed),
      planType: extractPlanTypeFromObject(parsed),
    };
    AUTH_METADATA_CACHE.set(accountPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      email: metadata.email,
      planType: metadata.planType,
    });
    return metadata;
  } catch (_) {
    AUTH_METADATA_CACHE.delete(accountPath);
    return { email: "", planType: "" };
  }
}

function getAccountEmail(accountPath) {
  return getAccountMetadata(accountPath).email;
}

function getAccountPlanType(accountPath) {
  return getAccountMetadata(accountPath).planType;
}

function formatAccountNameWithEmail(name, email) {
  if (!email) {
    return name;
  }
  if (name.toLowerCase().includes(email.toLowerCase())) {
    return name;
  }
  return `${name} <${email}>`;
}

function accountDisplayName(account) {
  return formatAccountNameWithEmail(account.name, getAccountEmail(account.path));
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

function opSetPinned(name, pinned) {
  const accounts = readAccounts();
  const index = accounts.findIndex((entry) => entry.name === name);
  if (index < 0) {
    die(`unknown account: ${name}`);
  }

  accounts[index] = {
    ...accounts[index],
    pinned: pinned === true,
  };
  writeAccounts(accounts);
  return pinned ? `Pinned account '${name}'` : `Unpinned account '${name}'`;
}

function opSetExcludedFromRecommendation(name, excluded) {
  const accounts = readAccounts();
  const index = accounts.findIndex((entry) => entry.name === name);
  if (index < 0) {
    die(`unknown account: ${name}`);
  }

  accounts[index] = {
    ...accounts[index],
    excludedFromRecommendation: excluded === true,
  };
  writeAccounts(accounts);
  return excluded
    ? `Excluded account '${name}' from recommendation`
    : `Included account '${name}' in recommendation`;
}

function formatRepairSummary(repair) {
  if (!repair || (!repair.changed && !repair.activeChanged)) {
    return "";
  }

  const parts = [];
  if (repair.removed && repair.removed.length > 0) {
    const names = repair.removed.map((entry) => entry.name).join(", ");
    parts.push(`Auto-removed missing account${repair.removed.length === 1 ? "" : "s"}: ${names}`);
  }
  if (repair.activeChanged) {
    if (repair.activeName) {
      parts.push(`Active account is now '${repair.activeName}'`);
    } else {
      parts.push("No active account remains");
    }
  }

  return parts.join(". ");
}

function toAccountOptions(accounts, activeName, disabledName) {
  return accounts.map((account) => {
    const metadata = getAccountMetadata(account.path);

    return {
      value: account.name,
      label: buildAccountLabel(account.name, metadata.email, [
        formatPlanBadge(metadata.planType),
        formatPinnedBadge(account.pinned === true),
        formatExcludedBadge(account.excludedFromRecommendation === true),
        formatActiveBadge(account.name === activeName),
      ]),
      hint: account.path,
      disabled: account.name === disabledName,
    };
  });
}

function pruneLiveRateLimitCache(accountPath) {
  const resolvedPath = path.resolve(accountPath);
  for (const key of LIVE_RATE_LIMIT_CACHE.keys()) {
    if (key.startsWith(`${resolvedPath}::`)) {
      LIVE_RATE_LIMIT_CACHE.delete(key);
    }
  }
}

function getLiveRateLimitCacheKey(accountPath) {
  const stat = fs.statSync(accountPath);
  return `${path.resolve(accountPath)}::${stat.mtimeMs}::${stat.size}`;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function colorize(text, style, output = process.stdout) {
  const code = ANSI[style];
  if (!code || !output || !output.isTTY) {
    return text;
  }
  return `${code}${text}${ANSI_RESET}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePathEntries(pathValue) {
  return String(pathValue || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseWindowsExtensions(pathext) {
  const defaults = [".cmd", ".exe", ".bat"];
  const extensions = String(pathext || "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([...defaults, ...extensions]));
}

function getWindowsCommandCandidates(command, env = process.env) {
  const trimmed = String(command || "").trim();
  if (!trimmed) {
    return [];
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext) {
    return [trimmed];
  }

  const extensions = parseWindowsExtensions(env.PATHEXT);
  return Array.from(new Set([...extensions.map((suffix) => `${trimmed}${suffix}`), trimmed]));
}

function resolveWindowsCommand(command, env = process.env, fileExists = isRegularFile) {
  const trimmed = String(command || "").trim();
  if (!trimmed) {
    return "";
  }

  const hasPathReference = trimmed.includes("\\") || trimmed.includes("/") || path.isAbsolute(trimmed);
  const candidates = getWindowsCommandCandidates(trimmed, env);
  if (hasPathReference) {
    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    return trimmed;
  }

  for (const entry of parsePathEntries(env.PATH)) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (fileExists(fullPath)) {
        return fullPath;
      }
    }
  }

  return trimmed;
}

function resolveCodexBinary(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fileExists = typeof options.fileExists === "function" ? options.fileExists : isRegularFile;
  const command = typeof options.command === "string" ? options.command : CODEX_BIN;
  const useCache =
    options.command === undefined &&
    options.env === undefined &&
    options.platform === undefined &&
    options.fileExists === undefined;

  if (useCache && RESOLVED_CODEX_BINARY) {
    return RESOLVED_CODEX_BINARY;
  }

  const resolved = platform === "win32"
    ? resolveWindowsCommand(command, env, fileExists)
    : String(command || "").trim();

  if (useCache) {
    RESOLVED_CODEX_BINARY = resolved;
  }
  return resolved;
}

function requiresWindowsCmdWrapper(command, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function resolveNpmShimScript(command, fileExists = isRegularFile) {
  const commandPath = String(command || "").trim();
  if (!commandPath || !/\.(cmd|ps1)$/i.test(commandPath)) {
    return "";
  }

  const scriptPath = path.join(path.dirname(commandPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  return fileExists(scriptPath) ? scriptPath : "";
}

function quoteWindowsCommandArgument(value) {
  const stringValue = String(value);
  if (!stringValue) {
    return "\"\"";
  }
  if (!/[\s"]/u.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, "\"\"")}"`;
}

function getCodexLaunchSpec(baseArgs, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fileExists = typeof options.fileExists === "function" ? options.fileExists : isRegularFile;
  const command = resolveCodexBinary(options);
  const args = [...CODEX_BIN_ARGS, ...baseArgs];
  const npmShimScript = platform === "win32" ? resolveNpmShimScript(command, fileExists) : "";

  if (npmShimScript) {
    return {
      command: process.execPath,
      args: [npmShimScript, ...args],
    };
  }

  if (requiresWindowsCmdWrapper(command, platform)) {
    const comspec = env.comspec || env.ComSpec || "cmd.exe";
    const commandLine = [command, ...args].map(quoteWindowsCommandArgument).join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command, args };
}

function getCodexAppServerArgs() {
  return [...CODEX_BIN_ARGS, "app-server", "--listen", "stdio://"];
}

function createAppServerRequest(method, id, params) {
  const message = { method, id };
  if (params !== undefined) {
    message.params = params;
  }
  return message;
}

function createAppServerNotification(method, params) {
  const message = { method };
  if (params !== undefined) {
    message.params = params;
  }
  return message;
}

function createTemporaryCodexHome(sourceAuthPath) {
  fs.mkdirSync(LIVE_RATE_LIMIT_TEMP_ROOT, { recursive: true });
  const tempHome = fs.mkdtempSync(path.join(LIVE_RATE_LIMIT_TEMP_ROOT, LIVE_RATE_LIMIT_TEMP_PREFIX));
  fs.copyFileSync(sourceAuthPath, path.join(tempHome, "auth.json"));
  return tempHome;
}

function isRetryableWindowsCleanupError(error) {
  return !!(error && typeof error.code === "string" && /^(EPERM|EBUSY|ENOTEMPTY)$/i.test(error.code));
}

async function cleanupTemporaryCodexHome(tempHome) {
  const tempRoot = path.resolve(LIVE_RATE_LIMIT_TEMP_ROOT);
  if (!tempHome || !(tempHome === tempRoot || tempHome.startsWith(`${tempRoot}${path.sep}`))) {
    return;
  }

  const attempts = [0, 75, 200];
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isRetryableWindowsCleanupError(err) || index === attempts.length - 1) {
        return;
      }
      await sleep(attempts[index + 1]);
    }
  }
}

async function queryCodexAppServer(tempHome) {
  const launchSpec = getCodexLaunchSpec(getCodexAppServerArgs());
  let child;
  try {
    child = spawn(launchSpec.command, launchSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: tempHome,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    error.appServerErrorCode = "spawn_failed";
    error.partial = {};
    throw error;
  }

  let stderr = "";
  let stdoutBuffer = "";
  let closed = false;
  let exited = false;
  let nextId = 1;
  const pending = new Map();
  const exitPromise = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  function rejectPending(error) {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  }

  function finalize(error) {
    if (closed) {
      return;
    }
    closed = true;
    rejectPending(error);
  }

  function send(message) {
    if (!child.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(String(id), { resolve, reject });
      try {
        send(createAppServerRequest(method, id, params));
      } catch (err) {
        pending.delete(String(id));
        reject(err);
      }
    });
  }

  function handleMessage(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const key = String(message.id);
      const pendingRequest = pending.get(key);
      if (!pendingRequest) {
        return;
      }
      pending.delete(key);

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message || `codex app-server request '${key}' failed`));
        return;
      }

      pendingRequest.resolve(message.result);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleMessage(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 4096) {
      stderr = stderr.slice(-4096);
    }
  });

  child.on("error", (err) => {
    finalize(err);
  });

  child.on("exit", (code, signal) => {
    const details = stderr.trim();
    const suffix = details ? `: ${details}` : "";
    const message = signal
      ? `codex app-server exited with signal ${signal}${suffix}`
      : `codex app-server exited with code ${code}${suffix}`;
    finalize(new Error(message));
  });

  function wrapStageError(error, stage, partial) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (stage === "initialize_failed" && wrapped && typeof wrapped.code === "string" && /^(ENOENT|EACCES|EPERM)$/i.test(wrapped.code)) {
      wrapped.appServerErrorCode = "spawn_failed";
    } else {
      wrapped.appServerErrorCode = /timed out after /i.test(wrapped.message)
        ? "timeout"
        : stage;
    }
    wrapped.partial = partial;
    return wrapped;
  }

  try {
    try {
      await withTimeout(
        request("initialize", {
          clientInfo: {
            name: "cdx",
            title: "cdx",
            version: "0.2.0",
          },
        }),
        APP_SERVER_INITIALIZE_TIMEOUT_MS,
        "codex app-server initialize",
      );
    } catch (err) {
      throw wrapStageError(err, "initialize_failed", {});
    }

    send(createAppServerNotification("initialized"));

    let account;
    try {
      account = await withTimeout(
        request("account/read", { refreshToken: true }),
        APP_SERVER_ACCOUNT_READ_TIMEOUT_MS,
        "codex app-server account/read",
      );
    } catch (err) {
      throw wrapStageError(err, "account_read_failed", { account: null, rateLimits: null });
    }

    let rateLimits;
    try {
      rateLimits = await withTimeout(
        request("account/rateLimits/read"),
        APP_SERVER_RATE_LIMITS_TIMEOUT_MS,
        "codex app-server account/rateLimits/read",
      );
    } catch (err) {
      throw wrapStageError(err, "rate_limits_failed", { account, rateLimits: null });
    }

    return { account, rateLimits };
  } finally {
    child.stdin.end();
    if (!child.killed && !exited) {
      child.kill();
    }
    await withTimeout(exitPromise, 2_500, "codex app-server shutdown").catch(() => {});
  }
}

function getRateLimitWindowLabel(windowDurationMins, fallbackLabel) {
  const duration = Number(windowDurationMins);
  if (!Number.isFinite(duration) || duration <= 0) {
    return fallbackLabel;
  }
  if (duration === 7 * 24 * 60) {
    return "weekly";
  }
  if (duration % (24 * 60) === 0 && duration >= 24 * 60) {
    return `${duration / (24 * 60)}d`;
  }
  if (duration % 60 === 0) {
    return `${duration / 60}h`;
  }
  return fallbackLabel;
}

function formatResetAt(seconds, now = new Date()) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }

  const resetAt = new Date(numeric * 1000);
  if (Number.isNaN(resetAt.getTime())) {
    return "";
  }

  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(resetAt.getHours())}:${pad(resetAt.getMinutes())}`;
  const isSameDay =
    resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (isSameDay) {
    return time;
  }

  const date = `${resetAt.getFullYear()}-${pad(resetAt.getMonth() + 1)}-${pad(resetAt.getDate())}`;
  return `${date} ${time}`;
}

function createRateLimitWindowSummary(window, fallbackLabel, now = new Date()) {
  if (!window || typeof window !== "object") {
    return null;
  }

  const usedPercent = Number(window.usedPercent);
  if (!Number.isFinite(usedPercent)) {
    return null;
  }

  const resetAtSeconds = Number(window.resetsAt);

  return {
    label: getRateLimitWindowLabel(window.windowDurationMins, fallbackLabel),
    remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
    resetAt: formatResetAt(resetAtSeconds, now),
    resetAtSeconds: Number.isFinite(resetAtSeconds) && resetAtSeconds > 0 ? resetAtSeconds : 0,
  };
}

function formatCreditAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  const rounded = Math.round(numeric * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function createCreditsSummary(credits) {
  if (!credits || typeof credits !== "object") {
    return null;
  }

  const hasCredits = credits.hasCredits === true || credits.has_credits === true;
  const unlimited = credits.unlimited === true;
  if (!hasCredits && !unlimited) {
    return null;
  }

  const rawBalance = credits.balance;
  const numericBalance = typeof rawBalance === "number"
    ? rawBalance
    : Number.parseFloat(String(rawBalance || "").trim());
  const displayBalance = Number.isFinite(numericBalance)
    ? formatCreditAmount(numericBalance)
    : typeof rawBalance === "string" && rawBalance.trim()
      ? rawBalance.trim()
      : unlimited
        ? "unlimited"
        : "";

  if (!displayBalance && !unlimited) {
    return null;
  }

  return {
    hasCredits,
    unlimited,
    balance: displayBalance,
    numericBalance: Number.isFinite(numericBalance) ? numericBalance : null,
  };
}

function createUnavailableRateLimitStatus(metadata = {}, errorCode = "unavailable") {
  return {
    available: false,
    email: metadata.email || "",
    planType: metadata.planType || "",
    primary: null,
    secondary: null,
    credits: null,
    errorCode,
  };
}

function extractLiveAccount(accountResponse) {
  return accountResponse && accountResponse.account && typeof accountResponse.account === "object"
    ? accountResponse.account
    : null;
}

function extractRateLimitSnapshot(rateLimitResponse) {
  return rateLimitResponse && rateLimitResponse.rateLimits && typeof rateLimitResponse.rateLimits === "object"
    ? rateLimitResponse.rateLimits
    : null;
}

function getLiveRateLimitMetadata(metadata, liveAccount, snapshot) {
  return {
    email: liveAccount && typeof liveAccount.email === "string" ? liveAccount.email : metadata.email,
    planType:
      (liveAccount && typeof liveAccount.planType === "string" && normalizePlanType(liveAccount.planType)) ||
      (snapshot && typeof snapshot.planType === "string" && normalizePlanType(snapshot.planType)) ||
      metadata.planType,
  };
}

async function fetchLiveRateLimitStatus(accountPath) {
  const metadata = getAccountMetadata(accountPath);
  if (!isRegularFile(accountPath)) {
    return createUnavailableRateLimitStatus(metadata, "missing_auth");
  }

  const tempHome = createTemporaryCodexHome(accountPath);
  try {
    const query = APP_SERVER_QUERY || queryCodexAppServer;
    const { account, rateLimits } = await query(tempHome);
    const liveAccount = extractLiveAccount(account);
    const snapshot = extractRateLimitSnapshot(rateLimits);
    const liveMetadata = getLiveRateLimitMetadata(metadata, liveAccount, snapshot);
    if (!snapshot) {
      return createUnavailableRateLimitStatus(liveMetadata, "missing_rate_limits");
    }

    const now = new Date();
    return {
      available: true,
      email: liveMetadata.email,
      planType: liveMetadata.planType,
      primary: createRateLimitWindowSummary(snapshot.primary, "5h", now),
      secondary: createRateLimitWindowSummary(snapshot.secondary, "weekly", now),
      credits: createCreditsSummary(snapshot.credits),
      errorCode: "",
    };
  } catch (err) {
    const partial = err && err.partial && typeof err.partial === "object" ? err.partial : {};
    const liveAccount = extractLiveAccount(partial.account);
    const snapshot = extractRateLimitSnapshot(partial.rateLimits);
    const liveMetadata = getLiveRateLimitMetadata(metadata, liveAccount, snapshot);
    return createUnavailableRateLimitStatus(liveMetadata, err && err.appServerErrorCode ? err.appServerErrorCode : "query_failed");
  } finally {
    await cleanupTemporaryCodexHome(tempHome);
  }
}

async function getLiveRateLimitStatus(accountPath, options = {}) {
  if (!isRegularFile(accountPath)) {
    return createUnavailableRateLimitStatus(getAccountMetadata(accountPath), "missing_auth");
  }

  const cacheKey = getLiveRateLimitCacheKey(accountPath);
  const forceRefresh = !!(options && options.forceRefresh);
  const cached = forceRefresh ? null : LIVE_RATE_LIMIT_CACHE.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < LIVE_RATE_LIMIT_TTL_MS) {
    return cached.status;
  }

  const fetcher = LIVE_RATE_LIMIT_FETCHER || fetchLiveRateLimitStatus;
  const status = await fetcher(accountPath);
  pruneLiveRateLimitCache(accountPath);
  LIVE_RATE_LIMIT_CACHE.set(cacheKey, { fetchedAt: now, status });
  return status;
}

function hasFreshLiveRateLimitCache(accountPath, now = Date.now()) {
  if (!isRegularFile(accountPath)) {
    return false;
  }

  try {
    const cacheKey = getLiveRateLimitCacheKey(accountPath);
    const cached = LIVE_RATE_LIMIT_CACHE.get(cacheKey);
    return !!(cached && now - cached.fetchedAt < LIVE_RATE_LIMIT_TTL_MS);
  } catch (_) {
    return false;
  }
}

function getStatusWindows(status) {
  return [status && status.primary ? status.primary : null, status && status.secondary ? status.secondary : null]
    .filter(Boolean);
}

function getRemainingPercent(summary) {
  const value = summary && Number(summary.remainingPercent);
  return Number.isFinite(value) ? value : -1;
}

function isWindowDepleted(summary) {
  return getRemainingPercent(summary) <= 0;
}

function getStatusCredits(status) {
  return status && status.credits && typeof status.credits === "object" ? status.credits : null;
}

function getCreditBalanceValue(status) {
  const credits = getStatusCredits(status);
  if (!credits) {
    return -1;
  }
  if (credits.unlimited === true) {
    return Number.POSITIVE_INFINITY;
  }
  const numericBalance = Number(credits.numericBalance);
  return Number.isFinite(numericBalance) ? numericBalance : -1;
}

function getCreditBalanceLabel(status) {
  const credits = getStatusCredits(status);
  if (!credits) {
    return "";
  }
  if (credits.unlimited === true) {
    return "unlimited";
  }
  return credits.balance || formatCreditAmount(credits.numericBalance);
}

function statusHasZeroCredits(status) {
  const balance = getCreditBalanceValue(status);
  return Number.isFinite(balance) && balance === 0;
}

function statusHasLowCredits(status) {
  const balance = getCreditBalanceValue(status);
  return Number.isFinite(balance) && balance > 0 && balance <= LOW_CREDITS_THRESHOLD;
}

function statusNeedsHardWarning(status) {
  return statusHasDepletedLimit(status) || statusHasZeroCredits(status);
}

function isStatusUsableNow(status) {
  return !!(status && status.available) && !statusHasDepletedLimit(status) && !statusHasZeroCredits(status);
}

function areAllEligibleAccountsExhausted(entries, disabledName = "") {
  const eligible = entries.filter(
    (entry) => entry.account.name !== disabledName && entry.account.excludedFromRecommendation !== true,
  );
  const available = eligible.filter((entry) => entry.status && entry.status.available);
  return available.length > 0 && available.every((entry) => statusNeedsHardWarning(entry.status));
}

function getResetSortValue(summary) {
  const raw = summary && Number(summary.resetAtSeconds);
  return Number.isFinite(raw) && raw > 0 ? raw : Number.POSITIVE_INFINITY;
}

function getStatusRecommendation(status) {
  if (!status || !status.available) {
    return null;
  }

  const windows = getStatusWindows(status);
  if (windows.length === 0) {
    return null;
  }

  const depleted = windows.filter(isWindowDepleted);
  const primaryRemaining = getRemainingPercent(status.primary);
  const secondaryRemaining = status.secondary ? getRemainingPercent(status.secondary) : 101;
  const totalRemaining = windows.reduce((sum, summary) => sum + Math.max(0, getRemainingPercent(summary)), 0);
  const bottleneckRemaining = windows.reduce(
    (current, summary) => Math.min(current, Math.max(0, getRemainingPercent(summary))),
    Number.POSITIVE_INFINITY,
  );
  const depletedReset = depleted.reduce(
    (current, summary) => Math.min(current, getResetSortValue(summary)),
    Number.POSITIVE_INFINITY,
  );
  const lowCredits = statusHasLowCredits(status);
  const zeroCredits = statusHasZeroCredits(status);
  const creditBalance = getCreditBalanceValue(status);

  return depleted.length === 0 && !zeroCredits
    ? {
        tier: lowCredits ? 1 : 0,
        bottleneckRemaining,
        primaryRemaining,
        secondaryRemaining,
        totalRemaining,
        depletedCount: 0,
        depletedReset,
        lowCredits,
        creditBalance,
      }
    : {
        tier: 2,
        bottleneckRemaining,
        primaryRemaining,
        secondaryRemaining,
        totalRemaining,
        depletedCount: depleted.length,
        depletedReset,
        lowCredits,
        creditBalance,
      };
}

function compareRecommendationMetrics(left, right) {
  if (!left && !right) {
    return 0;
  }
  if (left && !right) {
    return -1;
  }
  if (!left && right) {
    return 1;
  }

  const comparators = left.tier === 2 && right.tier === 2
    ? [
        [left.tier, right.tier, true],
        [left.depletedCount, right.depletedCount, true],
        [left.depletedReset, right.depletedReset, true],
        [left.creditBalance, right.creditBalance, false],
        [left.pinned ? 0 : 1, right.pinned ? 0 : 1, true],
        [left.primaryRemaining, right.primaryRemaining, false],
        [left.secondaryRemaining, right.secondaryRemaining, false],
        [left.totalRemaining, right.totalRemaining, false],
      ]
    : [
        [left.tier, right.tier, true],
        [left.depletedCount, right.depletedCount, true],
        [left.creditBalance, right.creditBalance, false],
        [left.pinned ? 0 : 1, right.pinned ? 0 : 1, true],
        [left.bottleneckRemaining, right.bottleneckRemaining, false],
        [left.primaryRemaining, right.primaryRemaining, false],
        [left.secondaryRemaining, right.secondaryRemaining, false],
        [left.totalRemaining, right.totalRemaining, false],
        [left.depletedReset, right.depletedReset, true],
      ];

  for (const [a, b, ascending] of comparators) {
    if (a === b) {
      continue;
    }
    return ascending ? a - b : b - a;
  }

  return 0;
}

function getRecommendedSwitchAccount(entries, activeName = "", disabledName = "") {
  const candidates = entries.filter(
    (entry) => entry.account.name !== disabledName && entry.account.excludedFromRecommendation !== true,
  );
  if (candidates.length === 0) {
    return "";
  }

  const decorated = candidates.map((entry, index) => ({
    ...entry,
    index,
    recommendation: (() => {
      const metrics = getStatusRecommendation(entry.status);
      return metrics ? { ...metrics, pinned: entry.account.pinned === true } : null;
    })(),
  }));

  decorated.sort((left, right) => {
    const comparison = compareRecommendationMetrics(left.recommendation, right.recommendation);
    if (comparison !== 0) {
      return comparison;
    }
    if (left.account.name === activeName && right.account.name !== activeName) {
      return -1;
    }
    if (right.account.name === activeName && left.account.name !== activeName) {
      return 1;
    }
    return left.index - right.index;
  });

  return decorated[0] && decorated[0].recommendation && decorated[0].recommendation.tier < 2
    ? decorated[0].account.name
    : "";
}

function setLiveRateLimitFetcherForTests(fetcher) {
  LIVE_RATE_LIMIT_FETCHER = typeof fetcher === "function" ? fetcher : null;
}

function setCodexAppServerQueryForTests(query) {
  APP_SERVER_QUERY = typeof query === "function" ? query : null;
}

function formatPlanBadge(planType) {
  const normalized = normalizePlanType(planType);
  return normalized ? `[${normalized.toUpperCase()}]` : "";
}

function formatPinnedBadge(isPinned) {
  return isPinned ? colorize("[PINNED]", "boldYellow") : "";
}

function formatExcludedBadge(isExcluded) {
  return isExcluded ? colorize("[EXCLUDED]", "dim") : "";
}

function formatRecommendedBadge(isRecommended) {
  return isRecommended ? colorize("[RECOMMENDED]", "boldCyan") : "";
}

function formatActiveBadge(isActive) {
  return isActive ? colorize("[ACTIVE]", "boldGreen") : "";
}

function formatDepletedBadge(summary) {
  if (!summary || !isWindowDepleted(summary)) {
    return "";
  }
  return colorize(`[${summary.label.toUpperCase()} 0%]`, "boldRed");
}

function formatCreditsBadge(status) {
  const balanceLabel = getCreditBalanceLabel(status);
  if (!balanceLabel) {
    return "";
  }
  if (statusHasZeroCredits(status)) {
    return colorize("[0 CR]", "boldRed");
  }
  if (statusHasLowCredits(status)) {
    return colorize(`[LOW ${balanceLabel} CR]`, "boldYellow");
  }
  return "";
}

function buildAccountLabel(name, email, badges = []) {
  const label = formatAccountNameWithEmail(name, email);
  const suffix = badges.filter(Boolean).join(" ");
  return suffix ? `${label} ${suffix}` : label;
}

function buildSwitchAccountLabel(account, status, activeName = "", recommendedName = "") {
  const metadata = getAccountMetadata(account.path);
  const email = status && status.email ? status.email : metadata.email;
  const planType = status && status.planType ? status.planType : metadata.planType;
  return buildAccountLabel(account.name, email, [
    formatPlanBadge(planType),
    formatPinnedBadge(account.pinned === true),
    formatExcludedBadge(account.excludedFromRecommendation === true),
    formatDepletedBadge(status && status.primary),
    formatDepletedBadge(status && status.secondary),
    formatCreditsBadge(status),
    formatRecommendedBadge(account.name === recommendedName),
    formatActiveBadge(account.name === activeName),
  ]);
}

function formatRateLimitHint(summary) {
  if (!summary) {
    return "";
  }

  const base = `${summary.label} ${summary.remainingPercent}%`;
  return summary.resetAt ? `${base} (reset ${summary.resetAt})` : base;
}

function getDepletedLimitLabels(status) {
  return getStatusWindows(status)
    .filter(isWindowDepleted)
    .map((summary) => summary.label);
}

function statusHasDepletedLimit(status) {
  return getDepletedLimitLabels(status).length > 0;
}

function buildSwitchAccountHint(account, activeName, status) {
  const hints = [];

  if (!status || !status.available) {
    hints.push("limits unavailable");
    return hints.join(" | ");
  }

  if (status.primary) {
    hints.push(formatRateLimitHint(status.primary));
  }
  if (status.secondary) {
    hints.push(formatRateLimitHint(status.secondary));
  }
  if (statusHasZeroCredits(status)) {
    hints.push("credits 0");
  } else if (statusHasLowCredits(status)) {
    hints.push(`low credits ${getCreditBalanceLabel(status)}`);
  }

  if (hints.length === 0) {
    hints.push("limits unavailable");
  }

  return hints.join(" | ");
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadSwitchAccountEntries(accounts, options = {}) {
  return mapWithConcurrency(accounts, LIVE_RATE_LIMIT_CONCURRENCY, async (account) => {
    const status = await getLiveRateLimitStatus(account.path, options);
    return { account, status };
  });
}

function buildSwitchAccountSelection(entries, activeName, disabledName) {
  const recommendedValue = getRecommendedSwitchAccount(entries, activeName, disabledName);
  const options = entries.map(({ account, status }) => ({
    value: account.name,
    label: buildSwitchAccountLabel(account, status, activeName, recommendedValue),
    hint: buildSwitchAccountHint(account, activeName, status),
    disabled: account.name === disabledName,
  }));

  return {
    options,
    recommendedValue,
    entriesByName: new Map(entries.map((entry) => [entry.account.name, entry])),
  };
}

function createRateLimitWindowSnapshot(summary) {
  if (!summary) {
    return null;
  }

  return {
    label: summary.label,
    remainingPercent: summary.remainingPercent,
    resetAt: summary.resetAt,
    resetAtSeconds: summary.resetAtSeconds,
  };
}

function createStatusSnapshot(status) {
  if (!status) {
    return null;
  }

  return {
    available: status.available === true,
    email: status.email || "",
    planType: status.planType || "",
    primary: createRateLimitWindowSnapshot(status.primary),
    secondary: createRateLimitWindowSnapshot(status.secondary),
    lowCredits: statusHasLowCredits(status),
    zeroCredits: statusHasZeroCredits(status),
    credits: (() => {
      const credits = getStatusCredits(status);
      if (!credits) {
        return null;
      }
      return {
        hasCredits: credits.hasCredits === true,
        unlimited: credits.unlimited === true,
        balance: credits.balance || "",
      };
    })(),
    errorCode: status.errorCode || "",
  };
}

function getSmartSwitchDecisionFromSelection(selection, activeName) {
  const entries = selection && selection.entriesByName
    ? Array.from(selection.entriesByName.values())
    : [];
  const recommendedValue = selection && typeof selection.recommendedValue === "string"
    ? selection.recommendedValue
    : "";
  const activeEntry = entries.find((entry) => entry.account.name === activeName) || null;
  const recommendedEntry = recommendedValue
    ? (selection.entriesByName.get(recommendedValue) || null)
    : null;

  if (!recommendedEntry) {
    const allExhausted = areAllEligibleAccountsExhausted(entries);
    return {
      ok: false,
      switched: false,
      alreadyOptimal: false,
      allExhausted,
      from: activeName || "",
      to: "",
      reason: entries.length === 0 ? "no_accounts" : (allExhausted ? "all_exhausted" : "no_recommendation"),
      activeStatus: createStatusSnapshot(activeEntry ? activeEntry.status : null),
      recommendedStatus: null,
    };
  }

  const lowCredits = statusHasLowCredits(recommendedEntry.status);
  if (recommendedValue === activeName) {
    return {
      ok: true,
      switched: false,
      alreadyOptimal: true,
      allExhausted: false,
      from: activeName || "",
      to: recommendedValue,
      reason: lowCredits ? "already_optimal_low_credits" : "already_optimal",
      activeStatus: createStatusSnapshot(recommendedEntry.status),
      recommendedStatus: createStatusSnapshot(recommendedEntry.status),
    };
  }

  return {
    ok: true,
    switched: false,
    alreadyOptimal: false,
    allExhausted: false,
    from: activeName || "",
    to: recommendedValue,
    reason: lowCredits ? "best_available_low_credits" : "best_available",
    activeStatus: createStatusSnapshot(activeEntry ? activeEntry.status : null),
    recommendedStatus: createStatusSnapshot(recommendedEntry.status),
  };
}

async function buildSwitchAccountOptions(accounts, activeName, disabledName, options = {}) {
  const entries = await loadSwitchAccountEntries(accounts, options);
  return buildSwitchAccountSelection(entries, activeName, disabledName).options;
}

async function runSmartSwitchOperation(options = {}) {
  const accounts = readAccounts();
  const activeName = getActive();

  if (accounts.length === 0) {
    return {
      ok: false,
      switched: false,
      alreadyOptimal: false,
      allExhausted: false,
      from: activeName || "",
      to: "",
      reason: "no_accounts",
      activeStatus: null,
      recommendedStatus: null,
    };
  }

  const entries = await loadSwitchAccountEntries(accounts, {
    forceRefresh: !!(options && options.forceRefreshLiveLimits),
  });
  const selection = buildSwitchAccountSelection(entries, activeName, "");
  const decision = getSmartSwitchDecisionFromSelection(selection, activeName);
  if (!decision.ok || decision.alreadyOptimal || !decision.to) {
    return decision;
  }

  opUse(decision.to);
  return {
    ...decision,
    switched: true,
  };
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
    const metadata = getAccountMetadata(account.path);
    const label = buildAccountLabel(account.name, metadata.email, [
      formatPlanBadge(metadata.planType),
      formatPinnedBadge(account.pinned === true),
      formatExcludedBadge(account.excludedFromRecommendation === true),
      formatActiveBadge(account.name === active),
    ]);
    return `${String(index + 1).padStart(2, " ")} ${marker} ${label}  ${account.path}`;
  });
  p.note(lines.join("\n"), "Configured Accounts");
}

async function loadSwitchAccountSelection(p, accounts, activeName, disabledName) {
  const shouldShowLoading = accounts.some((account) => !hasFreshLiveRateLimitCache(account.path));
  const loading = shouldShowLoading && typeof p.spinner === "function" ? p.spinner() : null;

  if (loading) {
    loading.start("Loading account info...");
  }

  try {
    const entries = await loadSwitchAccountEntries(accounts);
    return buildSwitchAccountSelection(entries, activeName, disabledName);
  } finally {
    if (loading) {
      loading.clear();
    }
  }
}

function buildDepletedWarningMessage(name, status) {
  const labels = getDepletedLimitLabels(status);
  const hasZeroCredits = statusHasZeroCredits(status);
  if (labels.length === 0 && !hasZeroCredits) {
    return "";
  }
  if (labels.length === 0) {
    return `Account '${name}' has 0 credits. Switch anyway?`;
  }
  if (!hasZeroCredits) {
    return labels.length === 1
      ? `Account '${name}' is exhausted for ${labels[0]}. Switch anyway?`
      : `Account '${name}' is exhausted for ${labels.join(", ")}. Switch anyway?`;
  }
  return labels.length === 1
    ? `Account '${name}' is exhausted for ${labels[0]} and has 0 credits. Switch anyway?`
    : `Account '${name}' is exhausted for ${labels.join(", ")} and has 0 credits. Switch anyway?`;
}

async function confirmDepletedSelection(p, name, status) {
  if (!statusNeedsHardWarning(status)) {
    return true;
  }

  return promptValue(
    p,
    p.confirm({
      message: buildDepletedWarningMessage(name, status),
      active: "Switch anyway",
      inactive: "Back",
      initialValue: false,
    }),
  );
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

  const selectionData = opts.liveRateLimits
    ? await loadSwitchAccountSelection(p, accounts, getActive(), opts.disabledName)
    : {
        options: toAccountOptions(accounts, getActive(), opts.disabledName),
        recommendedValue: "",
      };
  const initialValue = opts.liveRateLimits
    ? selectionData.recommendedValue || opts.initialValue
    : opts.initialValue;
  let nextInitialValue = initialValue;

  while (true) {
    const selection = await promptValue(
      p,
      p.select({
        message,
        options: selectionData.options,
        initialValue: nextInitialValue,
      }),
    );

    if (!opts.liveRateLimits) {
      return selection;
    }

    const entry = selectionData.entriesByName.get(selection);
    if (!entry || !statusHasDepletedLimit(entry.status)) {
      return selection;
    }

    const confirmed = await confirmDepletedSelection(p, selection, entry.status);
    if (confirmed) {
      return selection;
    }

    nextInitialValue = selectionData.recommendedValue || selection;
  }
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
  if (migration.repair) {
    const repairSummary = formatRepairSummary(migration.repair);
    if (repairSummary) {
      p.log.info(repairSummary);
    }
  }

  while (true) {
    const repair = repairAccountsStateOnDisk();
    const repairSummary = formatRepairSummary(repair);
    if (repairSummary) {
      p.log.info(repairSummary);
    }

    const active = getActive();
    const action = await promptValue(
      p,
      p.select({
        message: active ? `Choose an action (active: ${active})` : "Choose an action",
        options: [
          { value: "smart", label: "Smart switch", hint: "Use the healthiest account now" },
          { value: "use", label: "Use account", hint: "Set active account" },
          { value: "switch", label: "Switch account", hint: "Interactive account picker" },
          { value: "save", label: "Save current auth as account" },
          { value: "add", label: "Add account from auth file" },
          { value: "pin", label: "Pin or unpin account" },
          { value: "exclude", label: "Exclude or include account" },
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
      const name = await chooseAccount(p, "Switch to which account?", {
        initialValue: next,
        liveRateLimits: true,
      });
      if (!name) {
        continue;
      }
      p.log.success(opUse(name));
      continue;
    }

    if (action === "smart") {
      const accounts = readAccounts();
      if (accounts.length === 0) {
        p.log.warn("No accounts configured.");
        continue;
      }

      const activeName = getActive();
      const selection = await loadSwitchAccountSelection(p, accounts, activeName, "");
      const decision = getSmartSwitchDecisionFromSelection(selection, activeName);
      if (!decision.ok) {
        if (decision.allExhausted) {
          p.log.error("All eligible accounts are exhausted right now.");
        } else {
          p.log.warn("No smart-switch account is available.");
        }
        continue;
      }

      const targetName = decision.to || activeName;
      const entry = targetName ? selection.entriesByName.get(targetName) : null;
      if (entry && statusNeedsHardWarning(entry.status)) {
        const confirmed = await confirmDepletedSelection(p, targetName, entry.status);
        if (!confirmed) {
          p.log.info("Smart switch cancelled.");
          continue;
        }
      }

      if (decision.alreadyOptimal) {
        const currentEntry = selection.entriesByName.get(activeName);
        const lowCreditsMessage = currentEntry && statusHasLowCredits(currentEntry.status)
          ? ` (low credits: ${getCreditBalanceLabel(currentEntry.status)})`
          : "";
        p.outro(`Already using smart account '${activeName}'${lowCreditsMessage}.`);
        return;
      }

      if (entry && statusHasLowCredits(entry.status)) {
        p.log.warn(
          `Smart switch picked '${targetName}' with low credits (${getCreditBalanceLabel(entry.status)}).`,
        );
      }
      p.outro(opUse(targetName));
      return;
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

    if (action === "pin") {
      const name = await chooseAccount(p, "Pin or unpin which account?");
      if (!name) {
        continue;
      }
      const account = findAccount(readAccounts(), name);
      p.log.success(opSetPinned(name, !(account && account.pinned === true)));
      continue;
    }

    if (action === "exclude") {
      const name = await chooseAccount(p, "Exclude or include which account?");
      if (!name) {
        continue;
      }
      const account = findAccount(readAccounts(), name);
      p.log.success(
        opSetExcludedFromRecommendation(name, !(account && account.excludedFromRecommendation === true)),
      );
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
  const isSmartSwitchCommand = args[0] === "smart-switch";
  const jsonOutput = args.includes("--json");

  if (isSmartSwitchCommand) {
    const unsupportedArgs = args.slice(1).filter((arg) => arg !== "--json");
    if (unsupportedArgs.length > 0) {
      die("usage: cdx smart-switch [--json]");
    }

    ensureState();
    try {
      const result = await runSmartSwitchOperation();
      if (jsonOutput) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.ok && result.switched) {
        process.stdout.write(`Switched '${result.from}' -> '${result.to}'\n`);
      } else if (result.ok && result.alreadyOptimal) {
        process.stdout.write(`Already using smart account '${result.to}'\n`);
      } else if (result.reason === "all_exhausted") {
        process.stdout.write("All eligible accounts are exhausted right now.\n");
      } else if (result.reason === "no_accounts") {
        process.stdout.write("No accounts configured.\n");
      } else {
        process.stdout.write("No smart-switch account is available.\n");
      }
      process.exit(result.ok ? 0 : (result.allExhausted ? 2 : 1));
    } catch (err) {
      die(err.message || String(err));
    }
  }

  if (args.length > 0) {
    die("subcommands were removed. Run `cdx` with no arguments, or use `cdx smart-switch --json`.");
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
    normalizeAccountEntry,
    readAccountsFromJson,
    readAccounts,
    getActive,
    repairAccountsState,
    repairAccountsStateOnDisk,
    formatRepairSummary,
    extractEmailFromObject,
    extractPlanTypeFromObject,
    emailFromToken,
    planTypeFromToken,
    decodeJwtPayload,
    getAccountMetadata,
    getAccountEmail,
    getAccountPlanType,
    accountDisplayName,
    formatAccountNameWithEmail,
    getRateLimitWindowLabel,
    formatResetAt,
    createRateLimitWindowSummary,
    createCreditsSummary,
    createUnavailableRateLimitStatus,
    getDepletedLimitLabels,
    statusHasDepletedLimit,
    statusHasZeroCredits,
    statusHasLowCredits,
    statusNeedsHardWarning,
    isStatusUsableNow,
    areAllEligibleAccountsExhausted,
    getCreditBalanceLabel,
    buildDepletedWarningMessage,
    createAppServerRequest,
    createAppServerNotification,
    resolveCodexBinary,
    getCodexLaunchSpec,
    resolveNpmShimScript,
    hasFreshLiveRateLimitCache,
    getRecommendedSwitchAccount,
    buildSwitchAccountSelection,
    getSmartSwitchDecisionFromSelection,
    createStatusSnapshot,
    runSmartSwitchOperation,
    opUse,
    formatRateLimitHint,
    buildSwitchAccountLabel,
    buildSwitchAccountHint,
    buildSwitchAccountOptions,
    fetchLiveRateLimitStatus,
    getLiveRateLimitStatus,
    setLiveRateLimitFetcherForTests,
    setCodexAppServerQueryForTests,
    opSetPinned,
    opSetExcludedFromRecommendation,
  },
};

if (require.main === module) {
  main();
}
