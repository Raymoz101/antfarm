import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPollingPrompt } from "../dist/installer/agent-cron.js";

describe("polling-cron-setup", () => {
  describe("buildPollingPrompt inline execution", () => {
    it("uses inline execution instead of runtime-specific handoff", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("Execute it inline in THIS session"));
      assert.ok(!prompt.includes("sessions_spawn"));
    });

    it("still accepts a custom work model argument without changing behavior", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer", "anthropic/custom-model");
      assert.ok(prompt.includes("Execute it inline in THIS session"));
    });

    it("still includes step claim command", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes('step claim "feature-dev_developer"'));
    });

    it("still includes HEARTBEAT_OK for NO_WORK", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("HEARTBEAT_OK"));
    });

    it("remains under 5200 chars", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.length < 5200, `Prompt too long: ${prompt.length} chars`);
    });
  });

  describe("setupAgentCrons config resolution", () => {
    it("polling prompt uses correct agent id format", () => {
      const prompt = buildPollingPrompt("security-audit", "scanner");
      assert.ok(prompt.includes("security-audit_scanner"));
    });
  });
});
