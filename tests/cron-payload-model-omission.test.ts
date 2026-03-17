/**
 * Regression test: cron payload must omit model when value is "default" or falsy.
 *
 * Passing the literal string "default" to the gateway/CLI causes it to be
 * interpreted as an actual model name, breaking cron execution.  When the
 * model resolves to "default" or is undefined/falsy, the payload.model field
 * must be absent entirely so the gateway falls back to the agent's configured
 * default model.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("cron payload model omission when default/falsy", () => {
  let capturedJobs: any[];
  let originalFetch: typeof globalThis.fetch;
  let savedNodeEnv: string | undefined;
  let savedAntfarmTest: string | undefined;

  beforeEach(() => {
    capturedJobs = [];
    originalFetch = globalThis.fetch;
    savedNodeEnv = process.env.NODE_ENV;
    savedAntfarmTest = process.env.ANTFARM_TEST;

    // These regression tests validate the production cron payload shape.
    // Force a non-test env so gateway-api does not short-circuit HTTP creation.
    process.env.NODE_ENV = "production";
    delete process.env.ANTFARM_TEST;

    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.args?.job) {
        capturedJobs.push(body.args.job);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: `job-${capturedJobs.length}` } }),
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedAntfarmTest === undefined) delete process.env.ANTFARM_TEST;
    else process.env.ANTFARM_TEST = savedAntfarmTest;
  });

  it("omits model from payload when workflow polling.model is 'default'", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "wf-default-model",
      name: "Workflow Default Model",
      version: 1,
      polling: {
        model: "default",
        timeoutSeconds: 120,
      },
      agents: [
        {
          id: "agent-x",
          name: "Agent X",
          workspace: { baseDir: "agents/x", files: {} },
        },
      ],
      steps: [
        { id: "step-x", agent: "agent-x", input: "do work", expects: "RESULT" },
      ],
    };

    await setupAgentCrons(fakeWorkflow as any);

    assert.equal(capturedJobs.length, 1, "should create one cron job");
    const payload = capturedJobs[0].payload;

    // The model must NOT be the literal string "default".
    // If resolveAgentCronModel resolved a real model from the openclaw config,
    // that is valid to include; otherwise it must be absent.
    assert.ok(
      !("model" in payload) || payload.model !== "default",
      `payload.model must not be the literal string "default", got: ${payload.model}`
    );
  });

  it("omits model from payload when no polling config is set (default fallback)", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "wf-no-polling",
      name: "Workflow No Polling",
      version: 1,
      // no polling config — defaults to DEFAULT_POLLING_MODEL = "default"
      agents: [
        {
          id: "agent-y",
          name: "Agent Y",
          workspace: { baseDir: "agents/y", files: {} },
        },
      ],
      steps: [
        { id: "step-y", agent: "agent-y", input: "do work", expects: "RESULT" },
      ],
    };

    await setupAgentCrons(fakeWorkflow as any);

    assert.equal(capturedJobs.length, 1, "should create one cron job");
    const payload = capturedJobs[0].payload;

    // The model must NOT be the literal string "default".
    assert.ok(
      !("model" in payload) || payload.model !== "default",
      `payload.model must not be the literal string "default", got: ${payload.model}`
    );
  });

  it("includes model when polling model is a real model string", async () => {
    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");

    const fakeWorkflow = {
      id: "wf-real-model",
      name: "Workflow Real Model",
      version: 1,
      polling: {
        model: "claude-haiku-4-5-20251001",
        timeoutSeconds: 60,
      },
      agents: [
        {
          id: "agent-z",
          name: "Agent Z",
          workspace: { baseDir: "agents/z", files: {} },
        },
      ],
      steps: [
        { id: "step-z", agent: "agent-z", input: "do work", expects: "RESULT" },
      ],
    };

    await setupAgentCrons(fakeWorkflow as any);

    assert.equal(capturedJobs.length, 1, "should create one cron job");
    const payload = capturedJobs[0].payload;

    assert.equal(
      payload.model,
      "claude-haiku-4-5-20251001",
      "payload.model must be set when a real model name is specified"
    );
  });
});
