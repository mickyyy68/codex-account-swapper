#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

function run(name, argv, checks) {
  const result = spawnSync(process.execPath, ["bin/cdx.js", ...argv], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${name}: ${result.error.message}`);
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 1, `${name}: expected exit status 1`);
  checks(output);
}

run("default", [], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("manual", ["manual"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("manual extra", ["manual", "extra"], (output) => {
  assert.match(output, /usage: cdx manual/i);
});
