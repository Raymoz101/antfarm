/**
 * Regression test: gateway-api must treat HTTP 401 as a transient failure
 * and fall back to the OpenClaw CLI, not hard-fail immediately.
 *
 * Without this fix, a gateway with auth misconfiguration (token mismatch,
 * password-mode vs token-mode) causes all cron operations to fail hard,
 * breaking workflow startup even when the CLI is available.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Import the compiled module (tests run against dist)
describe("gateway-api: 401 treated as transient failure", () => {
  let savedNodeEnv: string | undefined;
  let savedAntfarmTest: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedAntfarmTest = process.env.ANTFARM_TEST;
    process.env.NODE_ENV = "production";
    delete process.env.ANTFARM_TEST;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedAntfarmTest === undefined) delete process.env.ANTFARM_TEST;
    else process.env.ANTFARM_TEST = savedAntfarmTest;
  });

  it("isTransientGatewayFailure returns true for 401", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;

    globalThis.fetch = (async (_url: any, _opts: any) => {
      fetchCallCount++;
      return {
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
        json: async () => ({ error: "Unauthorized" }),
      };
    }) as any;

    try {
      const { createAgentCronJob } = await import("../dist/installer/gateway-api.js");

      const result = await createAgentCronJob({
        name: "wf/gateway-401-check",
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "isolated",
        agentId: "wf-agent",
        payload: { kind: "agentTurn", message: "test", timeoutSeconds: 30 },
        delivery: { mode: "none" },
        enabled: false,
      });

      if (!result.ok) {
        assert.ok(
          !result.error?.includes("Gateway returned 401"),
          `Expected CLI fallback error, got: ${result.error}`
        );
      }

      assert.ok(fetchCallCount >= 1, "fetch should have been called");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HTTP 4xx other than 401/404 is NOT treated as transient (hard fail)", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: any, _opts: any) => {
      return {
        ok: false,
        status: 403,
        text: async () => "Forbidden",
        json: async () => ({ error: "Forbidden" }),
      };
    }) as any;

    try {
      const { createAgentCronJob } = await import("../dist/installer/gateway-api.js");

      const result = await createAgentCronJob({
        name: "wf/gateway-403-check",
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "isolated",
        agentId: "wf-agent",
        payload: { kind: "agentTurn", message: "test", timeoutSeconds: 30 },
        delivery: { mode: "none" },
        enabled: false,
      });

      assert.ok(!result.ok, "403 should result in a failure");
      assert.ok(
        result.error?.includes("Gateway returned 403"),
        `Expected "Gateway returned 403" error, got: ${result.error}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
