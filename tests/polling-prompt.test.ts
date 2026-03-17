import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPollingPrompt } from "../dist/installer/agent-cron.js";

describe("buildPollingPrompt", () => {
  it("contains the step claim command with correct agent id", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes('step claim "feature-dev_developer"'));
  });

  it("instructs to reply HEARTBEAT_OK on NO_WORK", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes("HEARTBEAT_OK"));
    assert.ok(prompt.includes("NO_WORK"));
  });

  it("does NOT contain workspace/AGENTS.md/SOUL.md content", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(!prompt.includes("AGENTS.md"));
    assert.ok(!prompt.includes("SOUL.md"));
  });

  it("works with different workflow/agent ids", () => {
    const prompt = buildPollingPrompt("bug-fix", "fixer");
    assert.ok(prompt.includes('step claim "bug-fix_fixer"'));
  });

  it("includes instructions for parsing step claim JSON output", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes("stepId"));
    assert.ok(prompt.includes("runId"));
    assert.ok(prompt.includes("input"));
    assert.ok(prompt.includes("parse"));
  });

  it("forces inline execution instead of handoff", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes("Do NOT hand off the claimed step"), "should forbid handoff");
    assert.ok(prompt.includes("Execute it inline in THIS session"), "should require inline execution");
    assert.ok(!prompt.includes("sessions_spawn"), "should not reference sessions_spawn anymore");
  });

  it("includes the full work prompt with step complete/fail instructions", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes("step complete"));
    assert.ok(prompt.includes("step fail"));
    assert.ok(prompt.includes("use ONLY that block as your output contract"));
    assert.ok(prompt.includes("---START WORK PROMPT---"));
    assert.ok(prompt.includes("---END WORK PROMPT---"));
  });

  it("remains backward-compatible when a workModel argument is passed", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer", "claude-opus-4-6");
    assert.ok(prompt.includes('step claim "feature-dev_developer"'));
    assert.ok(prompt.includes("Execute it inline in THIS session"));
  });

  it("instructs to include claimed JSON in inline execution", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer");
    assert.ok(prompt.includes("exact JSON output from step claim"));
  });
});
