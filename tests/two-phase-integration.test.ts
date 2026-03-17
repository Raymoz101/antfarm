import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPollingPrompt, buildWorkPrompt } from "../dist/installer/agent-cron.js";

/**
 * Integration tests for the polling prompt + work prompt flow.
 * Verifies that polling prompts stay lightweight, embed the execution prompt,
 * and remain compatible with runtimes that do not expose sessions_spawn.
 */
describe("polling-prompt integration", () => {
  describe("polling config creates correct prompt structure", () => {
    it("polling prompt with custom work model still documents the optional spawn model", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer", "anthropic/claude-opus-4-6");
      assert.ok(prompt.includes("anthropic/claude-opus-4-6"), "work model mentioned for optional spawn");
      assert.ok(prompt.includes("sessions_spawn"), "optional spawn is still described");
      assert.ok(prompt.includes("Continue in THIS session instead"), "inline fallback is documented");
    });

    it("polling prompt embeds the full work prompt for execution", () => {
      const pollingPrompt = buildPollingPrompt("feature-dev", "developer");
      const workPrompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(pollingPrompt.includes(workPrompt), "polling prompt embeds full work prompt");
    });
  });

  describe("defaults without polling config", () => {
    it("uses 'default' work model when no workModel specified", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes('"default"'), "default work model");
    });

    it("agent id uses namespaced format (workflowId_agentId)", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("feature-dev_developer"), "namespaced agent id");
      assert.ok(!prompt.includes("feature-dev/developer"), "no slash-separated id");
      assert.ok(!prompt.includes("feature-dev-developer"), "no hyphen-delimited id");
    });
  });

  describe("polling prompt stays lightweight", () => {
    it("Phase 1 instructions (before work prompt) are concise", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      const phase1End = prompt.indexOf("---START WORK PROMPT---");
      assert.ok(phase1End > 0, "work prompt delimiter exists");
      const phase1 = prompt.substring(0, phase1End);
      assert.ok(phase1.length < 2600, `Phase 1 too long: ${phase1.length} chars`);
    });

    it("polling prompt does not contain AGENTS.md or SOUL.md references", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(!prompt.includes("AGENTS.md"));
      assert.ok(!prompt.includes("SOUL.md"));
      assert.ok(!prompt.includes("MEMORY.md"));
    });

    it("polling prompt does not contain heavy workflow context", () => {
      const prompt = buildPollingPrompt("feature-dev", "developer");
      assert.ok(!prompt.includes("Acceptance Criteria"));
      assert.ok(!prompt.includes("COMPLETED STORIES"));
    });
  });

  describe("work prompt has full execution instructions", () => {
    it("contains step complete with file-pipe pattern", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("antfarm-step-output.txt"), "file-pipe pattern");
      assert.ok(prompt.includes("step complete"), "step complete command");
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

    it("contains all 3 rules", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.includes("NEVER end your session"));
      assert.ok(prompt.includes("Write output to a file first"));
      assert.ok(prompt.includes("step fail with an explanation"));
    });

    it("uses step-specific completion guidance instead of generic CHANGES/TESTS output", () => {
      const prompt = buildWorkPrompt("bug-fix", "triager");
      assert.ok(prompt.includes('Reply with:" contract exactly'));
      assert.ok(prompt.includes("Do NOT substitute generic fields like CHANGES or TESTS"));
      assert.ok(!prompt.includes("STATUS: done\nCHANGES: what you did\nTESTS: what tests you ran"));
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
      assert.ok(prompt.includes("Continue in THIS session instead"));
    });

    it("buildWorkPrompt is independent of polling config", () => {
      const prompt = buildWorkPrompt("feature-dev", "developer");
      assert.ok(prompt.length > 0);
      assert.ok(prompt.includes("step complete"));
      assert.ok(prompt.includes("step fail"));
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
          assert.ok(polling.includes(`${wf.id}_${agent}`), `${wf.id}/${agent} polling agent id`);
          assert.ok(work.includes("step complete"), `${wf.id}/${agent} work has step complete`);
          assert.ok(polling.includes("Continue in THIS session instead"), `${wf.id}/${agent} polling has inline fallback`);
        }
      }
    });

    it("module exports remain available", async () => {
      const mod = await import("../dist/installer/agent-cron.js");
      assert.ok(typeof mod.setupAgentCrons === "function", "setupAgentCrons exported");
      assert.ok(typeof mod.removeAgentCrons === "function", "removeAgentCrons exported");
      assert.ok(typeof mod.buildPollingPrompt === "function", "buildPollingPrompt exported");
      assert.ok(typeof mod.buildWorkPrompt === "function", "buildWorkPrompt exported");
    });
  });
});
