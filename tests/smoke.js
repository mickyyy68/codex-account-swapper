#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const defaultResult = spawnSync(process.execPath, ["bin/cdx.js"], { encoding: "utf8" });
const manualResult = spawnSync(process.execPath, ["bin/cdx.js", "manual"], { encoding: "utf8" });
const manualExtraResult = spawnSync(process.execPath, ["bin/cdx.js", "manual", "extra"], { encoding: "utf8" });

const defaultOutput = `${defaultResult.stdout || ""}${defaultResult.stderr || ""}`;
if (defaultResult.status !== 1) {
  process.exit(1);
}
if (!/ccx: interactive terminal required/i.test(defaultOutput)) {
  process.exit(1);
}
if (/cdx: interactive terminal required/i.test(defaultOutput)) {
  process.exit(1);
}

const manualOutput = `${manualResult.stdout || ""}${manualResult.stderr || ""}`;
if (manualResult.status !== 1) {
  process.exit(1);
}
if (!/cdx: interactive terminal required/i.test(manualOutput)) {
  process.exit(1);
}
if (/ccx: interactive terminal required/i.test(manualOutput)) {
  process.exit(1);
}

const manualExtraOutput = `${manualExtraResult.stdout || ""}${manualExtraResult.stderr || ""}`;
if (manualExtraResult.status !== 1) {
  process.exit(1);
}
if (!/usage: cdx manual/i.test(manualExtraOutput)) {
  process.exit(1);
}
