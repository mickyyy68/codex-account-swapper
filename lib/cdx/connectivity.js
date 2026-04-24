"use strict";

const dns = require("node:dns").promises;

const DEFAULT_HOST = "api.openai.com";
const DEFAULT_TIMEOUT_MS = 2500;

let OVERRIDE = null;

async function defaultOnlineCheck({ host, timeoutMs }) {
  let timer;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const lookup = dns.lookup(host).then(
      () => true,
      () => false,
    );
    const result = await Promise.race([lookup, timed]);
    return result === true;
  } finally {
    clearTimeout(timer);
  }
}

async function isOnline(options = {}) {
  const host = typeof options.host === "string" && options.host.trim() ? options.host.trim() : DEFAULT_HOST;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (typeof OVERRIDE === "function") {
    return !!(await OVERRIDE({ host, timeoutMs }));
  }
  return defaultOnlineCheck({ host, timeoutMs });
}

function setConnectivityCheckForTests(fn) {
  OVERRIDE = typeof fn === "function" ? fn : null;
}

module.exports = {
  isOnline,
  setConnectivityCheckForTests,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
};
