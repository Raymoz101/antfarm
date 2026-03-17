/**
 * Tests for cron drift detection (computeWorkflowCronSignature + refreshWorkflowCrons).
 *
 * These tests verify that the signature-based cron refresh mechanism correctly
 * detects when workflow specs change so live cron jobs are updated automatically.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeWorkflowCronSignature, refreshWorkflowCrons } from "../dist/installer/agent-cron.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

function makeWorkflow(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: "test-wf",
    version: 1,
    polling: { model: "default", timeoutSeconds: 120 },
    agents: [
      {
        id: "test-agent",
        workspace: {
          baseDir: "agents/test-agent",
          files: { "AGENTS.md": "agents/test-agent/AGENTS.md" },
        },
      },
    ],
    steps: [
      {
        id: "test-step",
        agent: "test-agent",
        input: "do the thing\nReply with:\nSTATUS: done",
        expects: "STATUS: done",
      },
    ],
    ...overrides,
  };
}

describe("computeWorkflowCronSignature", () => {
  it("returns a non-empty hex string", () => {
    const sig = computeWorkflowCronSignature(makeWorkflow());
    assert.match(sig, /^[0-9a-f]{16}$/);
  });

  it("is stable for the same spec", () => {
    const wf = makeWorkflow();
    const sig1 = computeWorkflowCronSignature(wf);
    const sig2 = computeWorkflowCronSignature(wf);
    assert.equal(sig1, sig2);
  });

  it("changes when workflow version changes", () => {
    const sig1 = computeWorkflowCronSignature(makeWorkflow({ version: 1 }));
    const sig2 = computeWorkflowCronSignature(makeWorkflow({ version: 2 }));
    assert.notEqual(sig1, sig2);
  });

  it("changes when polling model changes", () => {
    const sig1 = computeWorkflowCronSignature(
      makeWorkflow({ polling: { model: "default", timeoutSeconds: 120 } })
    );
    const sig2 = computeWorkflowCronSignature(
      makeWorkflow({ polling: { model: "claude-opus-4-6", timeoutSeconds: 120 } })
    );
    assert.notEqual(sig1, sig2);
  });

  it("changes when polling timeout changes", () => {
    const sig1 = computeWorkflowCronSignature(
      makeWorkflow({ polling: { model: "default", timeoutSeconds: 120 } })
    );
    const sig2 = computeWorkflowCronSignature(
      makeWorkflow({ polling: { model: "default", timeoutSeconds: 60 } })
    );
    assert.notEqual(sig1, sig2);
  });

  it("changes when an agent model is added", () => {
    const wf1 = makeWorkflow();
    const wf2 = makeWorkflow();
    wf2.agents[0].model = "claude-sonnet-4-6";
    const sig1 = computeWorkflowCronSignature(wf1);
    const sig2 = computeWorkflowCronSignature(wf2);
    assert.notEqual(sig1, sig2);
  });

  it("changes when an agent timeout changes", () => {
    const wf1 = makeWorkflow();
    const wf2 = makeWorkflow();
    wf2.agents[0].timeoutSeconds = 3600;
    const sig1 = computeWorkflowCronSignature(wf1);
    const sig2 = computeWorkflowCronSignature(wf2);
    assert.notEqual(sig1, sig2);
  });

  it("changes when a new agent is added", () => {
    const wf1 = makeWorkflow();
    const wf2 = makeWorkflow();
    wf2.agents.push({
      id: "second-agent",
      workspace: {
        baseDir: "agents/second-agent",
        files: { "AGENTS.md": "agents/second-agent/AGENTS.md" },
      },
    });
    const sig1 = computeWorkflowCronSignature(wf1);
    const sig2 = computeWorkflowCronSignature(wf2);
    assert.notEqual(sig1, sig2);
  });

  it("produces different sigs for different workflow ids", () => {
    const sig1 = computeWorkflowCronSignature(makeWorkflow({ id: "workflow-a" }));
    const sig2 = computeWorkflowCronSignature(makeWorkflow({ id: "workflow-b" }));
    assert.notEqual(sig1, sig2);
  });
});

describe("refreshWorkflowCrons export", () => {
  it("is an exported async function", () => {
    assert.equal(typeof refreshWorkflowCrons, "function");
    // In test env (ANTFARM_TEST=1) gateway calls are no-ops, so the function
    // should resolve without throwing
    const result = refreshWorkflowCrons(makeWorkflow());
    assert.ok(result instanceof Promise, "refreshWorkflowCrons should return a Promise");
    // Don't await — we just verify it's callable and returns a promise
    result.catch(() => {}); // silence any test-env errors
  });
});
