"use strict";

const PREFILL_AUTOSUBMIT_DELAY_MS = 150;

function createPrefillController(options = {}) {
  const prefillText = typeof options.prefillText === "string" ? options.prefillText : "";
  const autoSubmit = options.autoSubmit === true;
  const schedule = typeof options.schedule === "function" ? options.schedule : setTimeout;
  const clearScheduled = typeof options.clearScheduled === "function" ? options.clearScheduled : clearTimeout;

  let hasRun = false;
  let timerId = null;

  function clear() {
    if (timerId !== null) {
      clearScheduled(timerId);
      timerId = null;
    }
  }

  function scheduleAutoSubmit(write, isActive, onAutoSubmit, canAutoSubmit) {
    timerId = schedule(() => {
      timerId = null;
      if (!isActive()) {
        return;
      }
      if (typeof canAutoSubmit === "function" && !canAutoSubmit()) {
        scheduleAutoSubmit(write, isActive, onAutoSubmit, canAutoSubmit);
        return;
      }
      write("\r");
      if (typeof onAutoSubmit === "function") {
        onAutoSubmit(prefillText);
      }
    }, PREFILL_AUTOSUBMIT_DELAY_MS);
  }

  function run(write, isActive, onAutoSubmit, canAutoSubmit) {
    if (!prefillText || hasRun) {
      return false;
    }
    if (typeof write !== "function" || typeof isActive !== "function" || !isActive()) {
      return false;
    }

    hasRun = true;
    write(prefillText);

    if (!autoSubmit) {
      return true;
    }

    scheduleAutoSubmit(write, isActive, onAutoSubmit, canAutoSubmit);

    return true;
  }

  return {
    run,
    clear,
  };
}

module.exports = {
  createPrefillController,
  PREFILL_AUTOSUBMIT_DELAY_MS,
};
