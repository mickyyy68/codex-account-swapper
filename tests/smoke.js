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

function runJson(name, argv, checks) {
  const result = spawnSync(process.execPath, ["bin/cdx.js", ...argv], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${name}: ${result.error.message}`);
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 0, `${name}: expected exit status 0`);
  assert.doesNotMatch(output, /ccx:/i);
  checks(JSON.parse(output));
}

run("default", [], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("wrapper help", ["--help"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("manual", ["manual"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx: interactive terminal required/i);
});

run("resume", ["resume", "sess-1"], (output) => {
  assert.match(output, /cdx: interactive terminal required/i);
  assert.doesNotMatch(output, /ccx:/i);
});

run("manual extra", ["manual", "extra"], (output) => {
  assert.match(output, /usage: cdx manual/i);
  assert.doesNotMatch(output, /ccx:/i);
});

runJson("smart switch json", ["smart-switch", "--json"], (payload) => {
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(typeof payload.ok, "boolean");
  assert.equal(typeof payload.from, "string");
  assert.equal(typeof payload.to, "string");
});
