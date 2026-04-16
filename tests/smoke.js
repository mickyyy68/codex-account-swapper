#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const defaultResult = spawnSync(process.execPath, ["bin/cdx.js"], { encoding: "utf8" });
const manualResult = spawnSync(process.execPath, ["bin/cdx.js", "manual"], { encoding: "utf8" });

for (const result of [defaultResult, manualResult]) {
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 1) {
    process.exit(1);
  }
  if (!/interactive terminal required/i.test(output)) {
    process.exit(1);
  }
}
