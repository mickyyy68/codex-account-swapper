"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SESSION_TAIL_BYTES = 128 * 1024;
const SESSION_DISCOVERY_SLACK_MS = 15_000;
const SESSION_META_MAX_BYTES = 1024 * 1024;

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function normalizeSessionPath(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseSessionMetaLine(line) {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object") {
    return null;
  }

  const payload = parsed.payload;
  if (typeof payload.id !== "string" || typeof payload.cwd !== "string") {
    return null;
  }

  return {
    id: payload.id,
    cwd: payload.cwd,
    timestamp: payload.timestamp || "",
    cliVersion: payload.cli_version || "",
    filePath: "",
  };
}

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    limitId: raw.limit_id || raw.limitId || "",
    planType: raw.plan_type || raw.planType || "",
    primary: raw.primary
      ? {
          usedPercent: Number(raw.primary.used_percent ?? raw.primary.usedPercent),
          windowMinutes: Number(raw.primary.window_minutes ?? raw.primary.windowDurationMins ?? raw.primary.windowMinutes),
          resetsAt: Number(raw.primary.resets_at ?? raw.primary.resetsAt),
        }
      : null,
    secondary: raw.secondary
      ? {
          usedPercent: Number(raw.secondary.used_percent ?? raw.secondary.usedPercent),
          windowMinutes: Number(raw.secondary.window_minutes ?? raw.secondary.windowDurationMins ?? raw.secondary.windowMinutes),
          resetsAt: Number(raw.secondary.resets_at ?? raw.secondary.resetsAt),
        }
      : null,
    credits: raw.credits && typeof raw.credits === "object"
      ? {
          hasCredits: raw.credits.has_credits === true || raw.credits.hasCredits === true,
          unlimited: raw.credits.unlimited === true,
          balance: raw.credits.balance == null ? "" : String(raw.credits.balance),
        }
      : null,
  };
}

function parseTokenCountLine(line) {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== "event_msg" || !parsed.payload || typeof parsed.payload !== "object") {
    return null;
  }

  const payload = parsed.payload;
  if (payload.type !== "token_count") {
    return null;
  }

  const rateLimits = normalizeRateLimits(payload.rate_limits || payload.rateLimits);
  if (!rateLimits) {
    return null;
  }

  return {
    timestamp: parsed.timestamp || "",
    rateLimits,
  };
}

function parseSessionErrorLine(line) {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== "event_msg" || !parsed.payload || typeof parsed.payload !== "object") {
    return null;
  }

  const payload = parsed.payload;
  if (payload.type !== "error") {
    return null;
  }

  return {
    timestamp: parsed.timestamp || "",
    message: payload.message || "",
    code: payload.codex_error_info || payload.code || "",
  };
}

function parseUserMessageLine(line) {
  const parsed = parseJsonLine(line);
  if (!parsed || parsed.type !== "event_msg" || !parsed.payload || typeof parsed.payload !== "object") {
    return null;
  }

  const payload = parsed.payload;
  if (payload.type !== "user_message" || typeof payload.message !== "string") {
    return null;
  }

  return {
    timestamp: parsed.timestamp || "",
    message: payload.message,
  };
}

function listSessionFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function readFirstLine(fd, fileSize, maxBytes = SESSION_META_MAX_BYTES) {
  const chunkSize = 16 * 1024;
  const limit = Math.min(Number(fileSize) || 0, maxBytes);
  if (limit <= 0) {
    return "";
  }

  const buffers = [];
  let offset = 0;
  while (offset < limit) {
    const bytesToRead = Math.min(chunkSize, limit - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, offset);
    if (read <= 0) {
      break;
    }
    const slice = buffer.subarray(0, read);
    const newlineIndex = slice.indexOf(0x0a);
    if (newlineIndex >= 0) {
      buffers.push(slice.subarray(0, newlineIndex));
      break;
    }
    buffers.push(slice);
    offset += read;
  }

  return Buffer.concat(buffers).toString("utf8");
}

function readSessionMeta(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      const firstLine = readFirstLine(fd, stat.size);
      if (!firstLine) {
        return null;
      }
      const meta = parseSessionMetaLine(firstLine);
      return meta ? { ...meta, filePath } : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
}

function findMatchingSessionFile(options) {
  const sessionsDir = options && options.sessionsDir ? options.sessionsDir : "";
  const cwd = options && options.cwd ? options.cwd : process.cwd();
  const startedAtMs = Number(options && options.startedAtMs);
  const excludedFilePaths = Array.isArray(options && options.excludedFilePaths)
    ? options.excludedFilePaths.map(normalizeSessionPath)
    : [];
  const excludedPathSet = new Set(excludedFilePaths);
  const slackMs = Number.isFinite(Number(options && options.slackMs))
    ? Number(options.slackMs)
    : SESSION_DISCOVERY_SLACK_MS;
  const normalizedCwd = normalizeSessionPath(cwd);
  const threshold = Number.isFinite(startedAtMs) ? startedAtMs - slackMs : 0;

  const candidates = listSessionFilesRecursive(sessionsDir)
    .map(readSessionMeta)
    .filter(Boolean)
    .filter((entry) => normalizeSessionPath(entry.cwd) === normalizedCwd)
    .filter((entry) => !excludedPathSet.has(normalizeSessionPath(entry.filePath)))
    .filter((entry) => {
      const timestampMs = Date.parse(entry.timestamp || "");
      return !Number.isFinite(startedAtMs) || (Number.isFinite(timestampMs) && timestampMs >= threshold);
    })
    .map((entry) => ({
      ...entry,
      timestampMs: Date.parse(entry.timestamp || "") || 0,
      stat: fs.statSync(entry.filePath),
    }));

  candidates.sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }
    return left.stat.mtimeMs - right.stat.mtimeMs;
  });

  return candidates[0]
    ? {
        id: candidates[0].id,
        cwd: candidates[0].cwd,
        timestamp: candidates[0].timestamp,
        filePath: candidates[0].filePath,
      }
    : null;
}

function findSessionFileById(options) {
  const sessionsDir = options && options.sessionsDir ? options.sessionsDir : "";
  const sessionId = options && options.sessionId ? String(options.sessionId) : "";
  if (!sessionId) {
    return null;
  }

  const match = listSessionFilesRecursive(sessionsDir)
    .map(readSessionMeta)
    .filter(Boolean)
    .find((entry) => entry.id === sessionId);

  return match
    ? {
        id: match.id,
        cwd: match.cwd,
        timestamp: match.timestamp,
        filePath: match.filePath,
      }
    : null;
}

function readLatestRateLimitsFromSessionFile(filePath, maxBytes = SESSION_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesToRead = Math.min(stat.size, Math.max(1024, maxBytes));
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, start);
    const lines = buffer.toString("utf8", 0, read).split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseTokenCountLine(lines[index]);
      if (parsed) {
        return parsed.rateLimits;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestSessionStateFromSessionFile(filePath, maxBytes = SESSION_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesToRead = Math.min(stat.size, Math.max(1024, maxBytes));
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, start);
    const lines = buffer.toString("utf8", 0, read).split(/\r?\n/).filter(Boolean);
    let latestError = null;
    let rateLimits = null;
    let latestUserMessage = "";

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!latestError) {
        latestError = parseSessionErrorLine(lines[index]);
      }
      if (!rateLimits) {
        const parsedTokenCount = parseTokenCountLine(lines[index]);
        rateLimits = parsedTokenCount ? parsedTokenCount.rateLimits : null;
      }
      if (!latestUserMessage) {
        const parsedUserMessage = parseUserMessageLine(lines[index]);
        latestUserMessage = parsedUserMessage ? parsedUserMessage.message : "";
      }
      if (latestError && rateLimits && latestUserMessage) {
        break;
      }
    }

    return { rateLimits, latestError, latestUserMessage };
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestSessionStateFromSessionFileAfterSize(filePath, baselineSize, maxBytes = SESSION_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const baseline = Math.max(0, Number(baselineSize) || 0);
  if (stat.size <= baseline) {
    return null;
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const bytesToRead = Math.min(stat.size - baseline, Math.max(1024, maxBytes));
    const start = Math.max(baseline, stat.size - bytesToRead);
    const buffer = Buffer.alloc(Math.max(0, stat.size - start));
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8", 0, read).split(/\r?\n/).filter(Boolean);
    let latestError = null;
    let rateLimits = null;
    let latestUserMessage = "";

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!latestError) {
        latestError = parseSessionErrorLine(lines[index]);
      }
      if (!rateLimits) {
        const parsedTokenCount = parseTokenCountLine(lines[index]);
        rateLimits = parsedTokenCount ? parsedTokenCount.rateLimits : null;
      }
      if (!latestUserMessage) {
        const parsedUserMessage = parseUserMessageLine(lines[index]);
        latestUserMessage = parsedUserMessage ? parsedUserMessage.message : "";
      }
      if (latestError && rateLimits && latestUserMessage) {
        break;
      }
    }

    if (!latestError && !rateLimits && !latestUserMessage) {
      return null;
    }
    return { rateLimits, latestError, latestUserMessage };
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestUserMessageFromSessionFile(filePath, maxBytes = SESSION_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytesToRead = Math.min(stat.size, Math.max(1024, maxBytes));
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, start);
    const lines = buffer.toString("utf8", 0, read).split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseUserMessageLine(lines[index]);
      if (parsed && parsed.message) {
        return parsed.message;
      }
    }
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

function getRateLimitUsedPercent(window) {
  const value = window && Number(window.usedPercent);
  return Number.isFinite(value) ? value : 0;
}

function hasZeroCredits(credits) {
  if (!credits || credits.hasCredits !== true || credits.unlimited === true) {
    return false;
  }
  const numeric = Number.parseFloat(String(credits.balance || ""));
  return Number.isFinite(numeric) && numeric <= 0;
}

function isRateLimitsExhausted(rateLimits) {
  if (!rateLimits) {
    return false;
  }

  return (
    getRateLimitUsedPercent(rateLimits.primary) >= 100 ||
    getRateLimitUsedPercent(rateLimits.secondary) >= 100 ||
    hasZeroCredits(rateLimits.credits)
  );
}

function isSessionStateUsageLimitExceeded(sessionState) {
  if (!sessionState || typeof sessionState !== "object") {
    return false;
  }

  const latestError = sessionState.latestError;
  if (latestError && latestError.code === "usage_limit_exceeded") {
    return true;
  }

  return isRateLimitsExhausted(sessionState.rateLimits);
}

module.exports = {
  SESSION_DISCOVERY_SLACK_MS,
  SESSION_TAIL_BYTES,
  parseSessionMetaLine,
  parseTokenCountLine,
  parseSessionErrorLine,
  parseUserMessageLine,
  readSessionMeta,
  listSessionFilesRecursive,
  findMatchingSessionFile,
  findSessionFileById,
  readLatestRateLimitsFromSessionFile,
  readLatestSessionStateFromSessionFile,
  readLatestSessionStateFromSessionFileAfterSize,
  readLatestUserMessageFromSessionFile,
  isRateLimitsExhausted,
  isSessionStateUsageLimitExceeded,
  normalizeRateLimits,
  normalizeSessionPath,
};
