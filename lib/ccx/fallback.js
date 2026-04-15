"use strict";

function chooseFallbackAccount(accounts, activeName = "") {
  const entries = Array.isArray(accounts) ? accounts : [];
  const eligible = entries.filter((entry) => (
    entry &&
    typeof entry.name === "string" &&
    entry.name &&
    entry.name !== activeName &&
    entry.excludedFromRecommendation !== true
  ));

  if (eligible.length === 0) {
    return "";
  }

  const pinned = eligible.find((entry) => entry.pinned === true);
  return (pinned || eligible[0]).name || "";
}

module.exports = {
  chooseFallbackAccount,
};
