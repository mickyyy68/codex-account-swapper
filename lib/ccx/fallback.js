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

function shouldAttemptFallbackAccount(result) {
  if (!result) {
    return true;
  }
  if (result.ok) {
    return false;
  }
  if (result.allExhausted) {
    return false;
  }
  return result.reason !== "all_unavailable_or_exhausted" && result.reason !== "no_accounts";
}

module.exports = {
  chooseFallbackAccount,
  shouldAttemptFallbackAccount,
};
