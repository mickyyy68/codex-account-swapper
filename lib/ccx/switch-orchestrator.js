"use strict";

function createSwitchOrchestrator(options = {}) {
  const closeSession = typeof options.closeSession === "function"
    ? options.closeSession
    : async () => {};
  const runSmartSwitch = typeof options.runSmartSwitch === "function"
    ? options.runSmartSwitch
    : async () => ({ ok: false });
  const resumeSession = typeof options.resumeSession === "function"
    ? options.resumeSession
    : async () => {};
  const verifyResumedSession = typeof options.verifyResumedSession === "function"
    ? options.verifyResumedSession
    : async () => false;

  return {
    async handleExhaustion(identity) {
      if (!identity || !identity.sessionId || !identity.sessionFilePath) {
        throw new Error("canonical session identity is required before autoswitch");
      }

      await closeSession();
      const result = await runSmartSwitch();
      if (!result || result.ok !== true) {
        throw new Error("smart switch failed");
      }

      await resumeSession(identity.sessionId);
      const matched = await verifyResumedSession(identity.sessionId);
      if (!matched) {
        throw new Error("resumed session did not confirm the same sessionId");
      }

      return result;
    },
  };
}

module.exports = {
  createSwitchOrchestrator,
};
