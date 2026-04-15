"use strict";

function formatStartupBanner() {
  return [
    "\u001b[1;36m  ____ ____ __  __   CCX\u001b[0m",
    "\u001b[1;36m / ___/ ___|\\ \\/ /\u001b[0m",
    "\u001b[1;36m| |  | |     \\  / \u001b[0m",
    "\u001b[1;36m| |__| |___  /  \\\u001b[0m",
    "\u001b[1;36m \\____\\____|/_/\\_\\\\" + "\u001b[0m",
  ].join("\r\n");
}

module.exports = {
  formatStartupBanner,
};
