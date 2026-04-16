#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolvePendingPrompt } = require("../lib/ccx/prompt-state");
const { createUserPromptOutputTransformer } = require("../lib/ccx/output-style");

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exit(1);
  }
}

run("approval ui does not become a pending prompt", () => {
  const prompt = resolvePendingPrompt(
    "",
    [
      "header",
      "\u203a leggi il progetto",
      "",
      "Allow command execution?",
      "  Enter = approve",
      "  Esc = deny",
    ].join("\n"),
  );
  assert.equal(prompt, "");
});

run("normal output chunks are not buffered waiting for newlines", () => {
  const transformer = createUserPromptOutputTransformer();
  assert.equal(transformer.transform("  hello there"), "  hello there");
});

run("footer badge still appears for real codex footer lines", () => {
  const transformer = createUserPromptOutputTransformer();
  assert.equal(transformer.transform("  gpt-5.4 xhigh"), "");
  const output = transformer.transform(" · ~\\Documents\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
});

process.stdout.write("all cdx stability regression tests passed\n");
