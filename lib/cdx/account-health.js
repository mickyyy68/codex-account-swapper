"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CLEANUP_THRESHOLD = 3;

function resolveCdxDir(options = {}) {
  if (typeof options.cdxDir === "string") {
    const trimmed = options.cdxDir.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof process.env.CDX_DIR === "string") {
    const trimmed = process.env.CDX_DIR.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return path.join(os.homedir(), ".cdx");
}

function getAccountHealthFilePath(options = {}) {
  return path.join(resolveCdxDir(options), "account-health.json");
}

function normalizeHealthEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const rawFailures = Number(entry.consecutiveFailures);
  return {
    consecutiveFailures: Number.isFinite(rawFailures) && rawFailures >= 0 ? Math.floor(rawFailures) : 0,
    lastFailureAt: typeof entry.lastFailureAt === "string" ? entry.lastFailureAt : "",
    lastSuccessAt: typeof entry.lastSuccessAt === "string" ? entry.lastSuccessAt : "",
    lastErrorCode: typeof entry.lastErrorCode === "string" ? entry.lastErrorCode : "",
  };
}

function readAccountHealth(options = {}) {
  try {
    const raw = fs.readFileSync(getAccountHealthFilePath(options), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!name) {
        continue;
      }
      const normalized = normalizeHealthEntry(value);
      if (normalized) {
        out[name] = normalized;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAccountHealth(health, options = {}) {
  const filePath = getAccountHealthFilePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const safe = {};
  for (const [name, value] of Object.entries(health || {})) {
    if (!name) {
      continue;
    }
    const normalized = normalizeHealthEntry(value);
    if (normalized) {
      safe[name] = normalized;
    }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return safe;
}

function toFreshMap(cacheFreshness) {
  if (cacheFreshness instanceof Map) {
    return cacheFreshness;
  }
  const map = new Map();
  if (cacheFreshness && typeof cacheFreshness === "object") {
    for (const [key, value] of Object.entries(cacheFreshness)) {
      map.set(key, !!value);
    }
  }
  return map;
}

function decideAccountCleanups({
  entries,
  cacheFreshness,
  health = {},
  activeName = "",
  isOnline = false,
  threshold = DEFAULT_CLEANUP_THRESHOLD,
  now = () => new Date().toISOString(),
} = {}) {
  const result = {
    toDelete: [],
    healthUpdates: {},
    skipped: false,
    reason: "",
  };

  if (!isOnline) {
    result.skipped = true;
    result.reason = "offline";
    return result;
  }

  const list = Array.isArray(entries) ? entries : [];
  const successCount = list.filter((entry) => entry && entry.status && entry.status.available).length;
  if (successCount === 0) {
    result.skipped = true;
    result.reason = "no_successful_accounts";
    return result;
  }

  const freshMap = toFreshMap(cacheFreshness);
  const nowIso = typeof now === "function" ? now() : "";
  const effectiveThreshold = Number.isFinite(threshold) && threshold >= 1
    ? Math.floor(threshold)
    : DEFAULT_CLEANUP_THRESHOLD;

  for (const entry of list) {
    const account = entry && entry.account;
    if (!account || typeof account.name !== "string" || !account.name) {
      continue;
    }
    const name = account.name;
    if (freshMap.get(name)) {
      continue;
    }
    const status = entry.status;
    const previous = health && health[name] ? health[name] : null;
    const previousFailures = previous && Number.isFinite(previous.consecutiveFailures)
      ? previous.consecutiveFailures
      : 0;

    if (status && status.available) {
      if (previousFailures > 0 || !previous) {
        result.healthUpdates[name] = {
          consecutiveFailures: 0,
          lastSuccessAt: nowIso,
          lastFailureAt: previous && typeof previous.lastFailureAt === "string" ? previous.lastFailureAt : "",
          lastErrorCode: "",
        };
      }
      continue;
    }

    const nextFailures = previousFailures + 1;
    const errorCode = status && typeof status.errorCode === "string" && status.errorCode
      ? status.errorCode
      : "unavailable";
    result.healthUpdates[name] = {
      consecutiveFailures: nextFailures,
      lastFailureAt: nowIso,
      lastSuccessAt: previous && typeof previous.lastSuccessAt === "string" ? previous.lastSuccessAt : "",
      lastErrorCode: errorCode,
    };
    if (nextFailures >= effectiveThreshold && name !== activeName) {
      result.toDelete.push(name);
    }
  }

  return result;
}

module.exports = {
  DEFAULT_CLEANUP_THRESHOLD,
  getAccountHealthFilePath,
  normalizeHealthEntry,
  readAccountHealth,
  writeAccountHealth,
  decideAccountCleanups,
};
