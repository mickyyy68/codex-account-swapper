"use strict";

const fs = require("node:fs");

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function normalizeIdentity(metadata = {}) {
  return {
    accountId: typeof metadata.accountId === "string" ? metadata.accountId.trim() : "",
    email: typeof metadata.email === "string" ? metadata.email.trim().toLowerCase() : "",
  };
}

function hasIdentity(metadata = {}) {
  const identity = normalizeIdentity(metadata);
  return !!(identity.accountId || identity.email);
}

function identitiesMatch(left, right) {
  const current = normalizeIdentity(left);
  const saved = normalizeIdentity(right);

  if (current.accountId && saved.accountId) {
    return current.accountId === saved.accountId;
  }

  return !!(current.email && saved.email && current.email === saved.email);
}

function findMatchingSavedAccount(accounts, currentMetadata, getAccountMetadata) {
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || typeof account.path !== "string") {
      continue;
    }
    const savedMetadata = getAccountMetadata(account.path);
    if (identitiesMatch(currentMetadata, savedMetadata)) {
      return account;
    }
  }
  return null;
}

function getFirstAvailableNumericAccountName(accounts) {
  const used = new Set(
    (Array.isArray(accounts) ? accounts : [])
      .map((account) => (account && typeof account.name === "string" ? account.name.trim() : ""))
      .filter(Boolean),
  );

  let next = 1;
  while (used.has(String(next))) {
    next += 1;
  }
  return String(next);
}

function ensureCurrentAuthRegistered(options = {}) {
  const cdxInternal = options.cdxInternal;
  const currentAuthPath = options.currentAuthPath || "";
  if (!cdxInternal || typeof cdxInternal.getAccountMetadata !== "function") {
    throw new Error("cdx internals are required to bootstrap the current account.");
  }

  if (typeof cdxInternal.ensureState === "function") {
    cdxInternal.ensureState();
  }

  if (!isRegularFile(currentAuthPath)) {
    return { action: "noop", reason: "missing_auth", name: "", message: "" };
  }

  const currentMetadata = cdxInternal.getAccountMetadata(currentAuthPath);
  if (!hasIdentity(currentMetadata)) {
    return { action: "noop", reason: "missing_identity", name: "", message: "" };
  }

  const accounts = typeof cdxInternal.readAccounts === "function"
    ? cdxInternal.readAccounts()
    : [];
  const matched = findMatchingSavedAccount(accounts, currentMetadata, cdxInternal.getAccountMetadata);
  if (matched) {
    if (typeof cdxInternal.setActive === "function" && typeof cdxInternal.getActive === "function") {
      if (cdxInternal.getActive() !== matched.name) {
        cdxInternal.setActive(matched.name);
      }
    }
    return { action: "matched", reason: "existing_account", name: matched.name, message: "" };
  }

  const nextName = getFirstAvailableNumericAccountName(accounts);
  if (typeof cdxInternal.opSave !== "function") {
    throw new Error("cdx opSave is unavailable for current-account bootstrap.");
  }
  const message = cdxInternal.opSave(nextName);
  if (typeof cdxInternal.setActive === "function") {
    cdxInternal.setActive(nextName);
  }

  return {
    action: "saved",
    reason: "new_account",
    name: nextName,
    message,
  };
}

module.exports = {
  ensureCurrentAuthRegistered,
  findMatchingSavedAccount,
  getFirstAvailableNumericAccountName,
  identitiesMatch,
  normalizeIdentity,
};
