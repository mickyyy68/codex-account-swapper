"use strict";

async function runManualEntryPoint(deps) {
  const {
    ensureState,
    requireTTY,
    runInteractive,
    PromptCancelledError,
    loadPrompts,
    die,
  } = deps;
  const exit = typeof deps.exit === "function" ? deps.exit : (code) => process.exit(code);

  requireTTY();
  const migration = ensureState();

  try {
    await runInteractive(migration);
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      const p = await loadPrompts();
      p.cancel("Operation cancelled");
      return exit(1);
    }
    die(err.message || String(err));
  }
}

module.exports = {
  runManualEntryPoint,
};
