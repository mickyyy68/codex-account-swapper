"use strict";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPredicate(readValue, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 1500;
  const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 100;
  const predicate = typeof options.predicate === "function" ? options.predicate : Boolean;
  const stopWhen = typeof options.stopWhen === "function" ? options.stopWhen : null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastValue = null;

  while (Date.now() <= deadline) {
    if (stopWhen && stopWhen()) {
      return { matched: false, cancelled: true, value: lastValue };
    }

    lastValue = await Promise.resolve(readValue());
    if (predicate(lastValue)) {
      return { matched: true, cancelled: false, value: lastValue };
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  return { matched: false, cancelled: false, value: lastValue };
}

async function waitForTruthyValue(readValue, options = {}) {
  const result = await waitForPredicate(readValue, {
    ...options,
    predicate: (value) => Boolean(value),
  });
  return result.matched ? result.value : null;
}

async function waitForChildExit(child, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 1500;
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(value);
    };

    try {
      child.onExit(() => {
        finish(true);
      });
    } catch (_) {
      finish(false);
      return;
    }

    timeoutId = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

module.exports = {
  sleep,
  waitForPredicate,
  waitForTruthyValue,
  waitForChildExit,
};
