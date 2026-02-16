#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CDX_DIR = process.env.CDX_DIR || path.join(os.homedir(), ".cdx");
const ACCOUNTS_FILE = path.join(CDX_DIR, "accounts.json");
const ACTIVE_FILE = path.join(CDX_DIR, "active");
const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const TARGET_AUTH = path.join(CODEX_HOME_DIR, "auth.json");

function die(message) {
  process.stderr.write(`cdx: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage:
  cdx add <name> <auth_json_path>   Register an account auth file
  cdx save <name>                   Save current ~/.codex/auth.json as a named account
  cdx use <name>                    Activate a named account
  cdx switch                        Switch to next configured account
  cdx current                       Print active account name
  cdx list                          List configured accounts
  cdx help                          Show this help
`);
}

function ensureState() {
  fs.mkdirSync(CDX_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, "[]\n", "utf8");
  }
}

function readAccounts() {
  try {
    const data = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      die(`invalid accounts file at ${ACCOUNTS_FILE}`);
    }
    return parsed.filter((entry) => entry && entry.name && entry.path);
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

function applyAuthFile(sourceAuth) {
  if (!fs.existsSync(sourceAuth) || !fs.statSync(sourceAuth).isFile()) {
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

function cmdAdd(args) {
  if (args.length !== 2) {
    die("add requires <name> <auth_json_path>");
  }
  const [name, rawPath] = args;
  const fullPath = path.resolve(rawPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    die(`auth file not found: ${fullPath}`);
  }

  const accounts = readAccounts();
  writeAccounts(upsertAccount(accounts, name, fullPath));
  if (!getActive()) {
    setActive(name);
  }
  process.stdout.write(`Registered account '${name}' -> ${fullPath}\n`);
}

function cmdSave(args) {
  if (args.length !== 1) {
    die("save requires <name>");
  }
  const [name] = args;

  if (!fs.existsSync(TARGET_AUTH) || !fs.statSync(TARGET_AUTH).isFile()) {
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
  process.stdout.write(`Saved current auth as '${name}'\n`);
}

function cmdUse(args) {
  if (args.length !== 1) {
    die("use requires <name>");
  }
  const [name] = args;
  const accounts = readAccounts();
  const account = findAccount(accounts, name);
  if (!account) {
    die(`unknown account: ${name}`);
  }
  applyAuthFile(account.path);
  setActive(name);
  process.stdout.write(`Switched to account '${name}'\n`);
}

function cmdCurrent(args) {
  if (args.length !== 0) {
    die("current takes no arguments");
  }
  const active = getActive();
  if (!active) {
    die("no active account set");
  }
  process.stdout.write(`${active}\n`);
}

function cmdList(args) {
  if (args.length !== 0) {
    die("list takes no arguments");
  }
  const active = getActive();
  const accounts = readAccounts();

  if (accounts.length === 0) {
    process.stdout.write("No accounts configured.\n");
    return;
  }

  for (const account of accounts) {
    if (account.name === active) {
      process.stdout.write(`* ${account.name}\t${account.path}\n`);
    } else {
      process.stdout.write(`  ${account.name}\t${account.path}\n`);
    }
  }
}

function cmdSwitch(args) {
  if (args.length !== 0) {
    die("switch takes no arguments");
  }
  const active = getActive();
  const accounts = readAccounts();
  if (accounts.length === 0) {
    die("no accounts configured. Use 'cdx add' or 'cdx save'.");
  }

  if (!active) {
    applyAuthFile(accounts[0].path);
    setActive(accounts[0].name);
    process.stdout.write(`Switched to account '${accounts[0].name}'\n`);
    return;
  }

  const currentIndex = accounts.findIndex((entry) => entry.name === active);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % accounts.length;
  const next = accounts[nextIndex];

  applyAuthFile(next.path);
  setActive(next.name);
  process.stdout.write(`Switched to account '${next.name}'\n`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  ensureState();

  const rest = args.slice(1);
  switch (command) {
    case "add":
      cmdAdd(rest);
      break;
    case "save":
      cmdSave(rest);
      break;
    case "use":
      cmdUse(rest);
      break;
    case "switch":
      cmdSwitch(rest);
      break;
    case "current":
      cmdCurrent(rest);
      break;
    case "list":
      cmdList(rest);
      break;
    default:
      die(`unknown command: ${command} (run 'cdx help')`);
  }
}

main();
