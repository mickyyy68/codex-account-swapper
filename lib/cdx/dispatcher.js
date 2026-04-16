"use strict";

function decideCdxMode({ args, isTTY }) {
  const forwardedArgs = Array.isArray(args) ? [...args] : [];

  if (forwardedArgs[0] === "manual") {
    return { kind: "manual", forwardedArgs: forwardedArgs.slice(1) };
  }

  if (
    forwardedArgs[0] === "smart-switch" &&
    forwardedArgs.length === 2 &&
    forwardedArgs[1] === "--json"
  ) {
    return { kind: "smart-switch-json", forwardedArgs: [] };
  }

  const result = {
    kind: "wrapper",
    forwardedArgs,
  };

  Object.defineProperty(result, "isTTY", {
    value: !!isTTY,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return result;
}

module.exports = {
  decideCdxMode,
};
