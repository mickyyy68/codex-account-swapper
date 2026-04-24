"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VALID_ACCESS_MODES = Object.freeze([
  "read-only",
  "default",
  "full-access",
]);

const VALID_ACCESS_MODE_SET = new Set(VALID_ACCESS_MODES);

function getCdxDir(options = {}) {
  if (typeof options.cdxDir === "string") {
    const trimmedOption = options.cdxDir.trim();
    if (trimmedOption) {
      return trimmedOption;
    }
  }
  if (typeof process.env.CDX_DIR === "string") {
    const trimmedEnv = process.env.CDX_DIR.trim();
    if (trimmedEnv) {
      return trimmedEnv;
    }
  }
  return path.join(os.homedir(), ".cdx");
}

function getSettingsFilePath(options = {}) {
  return path.join(getCdxDir(options), "settings.json");
}

function normalizeCdxSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }

  const normalized = {};
  const accessMode = typeof settings.accessMode === "string"
    ? settings.accessMode.trim()
    : "";

  if (VALID_ACCESS_MODE_SET.has(accessMode)) {
    normalized.accessMode = accessMode;
  }

  return normalized;
}

function readCdxSettings(options = {}) {
  const settingsFilePath = getSettingsFilePath(options);

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath, "utf8"));
    return normalizeCdxSettings(parsed);
  } catch {
    return {};
  }
}

function writeCdxSettings(options = {}) {
  const settingsFilePath = getSettingsFilePath(options);
  const normalized = normalizeCdxSettings(options.settings);

  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  fs.writeFileSync(
    settingsFilePath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );

  return normalized;
}

module.exports = {
  VALID_ACCESS_MODES,
  getSettingsFilePath,
  normalizeCdxSettings,
  readCdxSettings,
  writeCdxSettings,
};
