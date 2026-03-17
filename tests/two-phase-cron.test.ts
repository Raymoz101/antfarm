import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPollingPrompt } from "../dist/installer/agent-cron.js";

describe("polling-cron-setup", () => {
  describe("buildPollingPrompt with optional handoff", () => {
    it("keeps sessions_spawn optional instead of mandatory", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("sessions_spawn"), "should mention sessions_spawn");
      assert.ok(prompt.includes("Continue in THIS session instead"), "should include inline fallback");
    });

    it("includes the default work model when none specified", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes('"default"'), "should include default work model");
    });

    it("includes custom work model when specified", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer", "anthropic/custom-model");
      assert.ok(prompt.includes("anthropic/custom-model"), "should include custom work model");
    });

    it("still includes step claim command", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes('step claim "feature-dev_developer"'));
    });

    it("still includes HEARTBEAT_OK for NO_WORK", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("HEARTBEAT_OK"));
    });

    it("remains under 6000 chars (includes embedded work prompt + fallback)", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.length < 6000, `Prompt too long: ${prompt.length} chars`);
    });
  });

  describe("setupAgentCrons config resolution", () => {
    it("default work model is 'default'", async () => {
      const prompt = buildPollingPrompt("test", "agent");
      assert.ok(prompt.includes('"default"'), "default work model in prompt");
    });

    it("polling prompt uses correct agent id format", () => {
      const prompt = buildPollingPrompt("security-audit", "scanner");
      assert.ok(prompt.includes("security-audit_scanner"));
    });
  });
});
