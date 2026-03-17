/**
 * Regression tests for cron payload model + timeout behavior.
 *
 * Bug #121: stale dist once dropped the polling model from cron payloads,
 * causing all polling to run on the wrong model.
 *
 * Bug #clean-run-20260317: polling prompts must execute claimed work inline,
 * so cron payload timeouts need to be long enough for real work.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("cron payload includes polling model + execution timeout", () => {
  let capturedJobs: any[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    capturedJobs = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.args?.job) capturedJobs.push(body.args.job);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: `job-${capturedJobs.length}` } }),
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("setupAgentCrons passes polling model in payload and uses inline execution prompt", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "test-workflow",
      name: "Test",
      version: 1,
      polling: {
        model: "claude-sonnet-4-20250514",
        timeoutSeconds: 120,
      },
      agents: [
        {
          id: "agent-a",
          name: "Agent A",
          workspace: { baseDir: "agents/a", files: {} },
        },
      ],
      steps: [{ id: "step-a", agent: "agent-a", input: "do work", expects: "RESULT" }],
    };

    await setupAgentCrons(fakeWorkflow as any);

    assert.equal(capturedJobs.length, 1);
    const payload = capturedJobs[0].payload;
    assert.equal(payload.model, "claude-sonnet-4-20250514");
    assert.ok(payload.message.includes("Execute it inline in THIS session"));
    assert.ok(!payload.message.includes("sessions_spawn"));
  });

  it("per-agent pollingModel overrides workflow-level polling model", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "test-override",
      name: "Test Override",
      version: 1,
      polling: {
        model: "claude-sonnet-4-20250514",
        timeoutSeconds: 120,
      },
      agents: [
        { id: "cheap-agent", name: "Cheap Agent", pollingModel: "claude-haiku-3", workspace: { baseDir: "agents/cheap", files: {} } },
        { id: "default-agent", name: "Default Agent", workspace: { baseDir: "agents/default", files: {} } },
      ],
      steps: [
        { id: "s1", agent: "cheap-agent", input: "work", expects: "R" },
        { id: "s2", agent: "default-agent", input: "work", expects: "R" },
      ],
    };

    await setupAgentCrons(fakeWorkflow as any);

    assert.equal(capturedJobs.length, 2);
    assert.equal(capturedJobs[0].payload.model, "claude-haiku-3");
    assert.equal(capturedJobs[1].payload.model, "claude-sonnet-4-20250514");
  });

  it("cron payload timeout expands to full execution budget for inline work", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "test-timeout",
      name: "Test Timeout",
      version: 1,
      polling: { model: "claude-sonnet-4-20250514", timeoutSeconds: 120 },
      agents: [{ id: "agent-t", name: "Agent T", workspace: { baseDir: "agents/t", files: {} } }],
      steps: [{ id: "st", agent: "agent-t", input: "work", expects: "R" }],
    };

    await setupAgentCrons(fakeWorkflow as any);
    assert.equal(capturedJobs[0].payload.timeoutSeconds, 1800);
  });

  it("agent-specific timeoutSeconds can exceed the workflow polling timeout", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "test-agent-timeout",
      name: "Test Agent Timeout",
      version: 1,
      polling: { model: "claude-sonnet-4-20250514", timeoutSeconds: 120 },
      agents: [{ id: "agent-long", name: "Agent Long", timeoutSeconds: 2400, workspace: { baseDir: "agents/long", files: {} } }],
      steps: [{ id: "s1", agent: "agent-long", input: "work", expects: "R" }],
    };

    await setupAgentCrons(fakeWorkflow as any);
    assert.equal(capturedJobs[0].payload.timeoutSeconds, 2400);
  });
});
