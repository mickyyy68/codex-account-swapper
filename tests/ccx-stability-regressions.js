#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolvePendingPrompt } = require("../lib/ccx/prompt-state");
const { createOutputPipeline } = require("../lib/ccx/output-pipeline");

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

run("visible multiline prompt survives footer lines but not approval ui", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
      ].join("\n"),
    ),
    "leggi il progetto\n  su piu righe",
  );
});

run("visible multiline prompt with footer and approval ui does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
        "",
        "Allow command execution?",
        "  Enter = approve",
        "  Esc = deny",
      ].join("\n"),
    ),
    "",
  );
});

run("visible multiline prompt with blank tail does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "",
      ].join("\n"),
    ),
    "",
  );
});

run("visible multiline prompt survives bare-cr footer lines", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4 xhigh \u00b7 ~\\Documents\\repo",
      ].join("\r"),
    ),
    "leggi il progetto\n  su piu righe",
  );
});

run("partial footer tails do not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  gpt-5.4",
      ].join("\n"),
    ),
    "",
  );
});

run("generic indented trailing output does not become a pending prompt", () => {
  assert.equal(
    resolvePendingPrompt(
      "",
      [
        "header",
        "\u203a leggi il progetto",
        "  su piu righe",
        "  assistant output",
      ].join("\n"),
    ),
    "",
  );
});

run("transparent output lane passes normal chunks through immediately", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("assistant partial chunk"), "assistant partial chunk");
});

run("footer badge still appears for real codex footer lines", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4 xhigh"), "");
  const output = pipeline.transform(" \u00b7 ~\\Documents\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /\u00b7 ~\\Documents\\repo/);
});

run("footer badge survives a short model-prefix PTY split", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  assert.equal(pipeline.transform("  gpt-5.4"), "");
  const output = pipeline.transform(" xhigh \u00b7 ~\\repo\r\n");
  assert.match(output, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.match(output, /gpt-5\.4 xhigh \u00b7 ~\\repo/);
});

run("generic indented path lines do not get a footer badge", () => {
  const pipeline = createOutputPipeline({ enableFooterBadge: true });
  const first = pipeline.transform("  2026 build - /tmp foo\r\n");
  const second = pipeline.transform("  7 job - C:\\temp file\r\n");
  assert.doesNotMatch(first, /\u001b\[1;32mCDX\u001b\[0m/);
  assert.doesNotMatch(second, /\u001b\[1;32mCDX\u001b\[0m/);
});

process.stdout.write("all cdx stability regression tests passed\n");
