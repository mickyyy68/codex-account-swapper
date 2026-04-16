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

  requireTTY();
  const migration = ensureState();

  try {
    await runInteractive(migration);
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      const p = await loadPrompts();
      p.cancel("Operation cancelled");
      process.exit(1);
    }
    die(err.message || String(err));
  }
}

module.exports = {
  runManualEntryPoint,
};
