"use strict";

function formatStartupBanner() {
  return [
    "\u001b[1;32m  _____   _____  __   __\u001b[0m",
    "\u001b[1;32m / ____| |  __ \\\\ \\ \\ / /\u001b[0m",
    "\u001b[1;32m| |      | |  | | \\ V / \u001b[0m",
    "\u001b[1;32m| |      | |  | |  > <  \u001b[0m",
    "\u001b[1;32m| |____  | |__| | / . \\\\\u001b[0m",
    "\u001b[1;32m \\_____| |_____/ /_/ \\_\\\\" + "\u001b[0m",
  ].join("\r\n");
}

module.exports = {
  formatStartupBanner,
};
