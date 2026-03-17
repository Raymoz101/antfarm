import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPollingPrompt, buildWorkPrompt } from "../dist/installer/agent-cron.js";

describe("polling-prompt integration", () => {
  describe("polling config creates correct prompt structure", () => {
    it("polling prompt executes inline without spawn semantics", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer", "anthropic/claude-opus-4-6");
      assert.ok(prompt.includes("Execute it inline in THIS session"));
      assert.ok(!prompt.includes("sessions_spawn"));
    });

    it("polling prompt embeds the full work prompt for execution", () => {
      const pollingPrompt = buildPollingPrompt("feature-dev", "developer");
      const workPrompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(pollingPrompt.includes(workPrompt));
    });
  });

  describe("defaults without polling config", () => {
    it("agent id uses namespaced format (workflowId_agentId)", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("feature-dev_developer"));
      assert.ok(!prompt.includes("feature-dev/developer"));
      assert.ok(!prompt.includes("feature-dev-developer"));
    });
  });

  describe("polling prompt stays lightweight", () => {
    it("instructions before work prompt are concise", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      const phase1End = prompt.indexOf("---START WORK PROMPT---");
      assert.ok(phase1End > 0);
      const phase1 = prompt.substring(0, phase1End);
      assert.ok(phase1.length < 2000, `Phase 1 too long: ${phase1.length} chars`);
    });

    it("polling prompt does not contain AGENTS.md or SOUL.md references", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(!prompt.includes("AGENTS.md"));
      assert.ok(!prompt.includes("SOUL.md"));
      assert.ok(!prompt.includes("MEMORY.md"));
    });
  });

  describe("work prompt has full execution instructions", () => {
    it("contains step complete with file-pipe pattern", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("antfarm-step-output.txt"));
      assert.ok(prompt.includes("step complete"));
    });

    it("contains step fail instructions", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("step fail"));
    });

    it("contains critical warning about session ending", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("CRITICAL"));
      assert.ok(prompt.includes("stuck forever"));
    });

    it("does NOT contain step claim (polling prompt handles claiming)", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(!prompt.includes("step claim"));
    });
  });

  describe("backward compatibility", () => {
    it("buildPollingPrompt works with no workModel argument", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.length > 0);
      assert.ok(prompt.includes("step claim"));
      assert.ok(prompt.includes("HEARTBEAT_OK"));
      assert.ok(prompt.includes("Execute it inline in THIS session"));
    });

    it("all three workflows produce valid prompts", () => {
      const workflows = [
        { id: "feature-dev", agents: ["planner", "developer", "reviewer", "verifier"] },
        { id: "security-audit", agents: ["scanner", "analyst", "remediator"] },
        { id: "bug-fix", agents: ["triager", "fixer", "verifier"] },
      ];

      for (const wf of workflows) {
        for (const agent of wf.agents) {
          const polling = buildPollingPrompt(wf.id, agent);
          const work = buildWorkPrompt(wf.id, agent);
          assert.ok(polling.includes(`${wf.id}_${agent}`));
          assert.ok(work.includes("step complete"));
          assert.ok(polling.includes("Execute it inline in THIS session"));
        }
      }
    });
  });
});
