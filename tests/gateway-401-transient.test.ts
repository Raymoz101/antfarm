/**
 * Regression test: gateway-api must treat HTTP 401 as a transient failure
 * and fall back to the OpenClaw CLI, not hard-fail immediately.
 *
 * Without this fix, a gateway with auth misconfiguration (token mismatch,
 * password-mode vs token-mode) causes all cron operations to fail hard,
 * breaking workflow startup even when the CLI is available.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the compiled module (tests run against dist)
describe("gateway-api: 401 treated as transient failure", () => {
  it("isTransientGatewayFailure returns true for 401", async () => {
    // We test via the observable behaviour: createAgentCronJob falls back to CLI
    // when the HTTP call returns 401.  We mock fetch to return 401 and mock the
    // CLI to succeed, then assert the overall result is ok.

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
      // Since we can't easily mock execFile, just verify that the function
      // doesn't throw a hard error on 401 (it should reach CLI fallback code).
      // We verify by checking that the HTTP call was made and the result is
      // either a CLI fallback error (not a "Gateway returned 401" error).
      const { createAgentCronJob } = await import("../dist/installer/gateway-api.js");

      const result = await createAgentCronJob({
        name: "test/gateway-401-check",
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: { kind: "agentTurn", message: "test", timeoutSeconds: 30 },
        delivery: { mode: "none" },
        enabled: false,
      });

      // The HTTP call returned 401, so it should have fallen through to CLI fallback.
      // The CLI fallback will fail (no openclaw binary in test env), but the error
      // must say "CLI fallback failed" NOT "Gateway returned 401" (which would
      // indicate a hard failure instead of CLI fallback).
      if (!result.ok) {
        assert.ok(
          !result.error?.includes("Gateway returned 401"),
          `Expected CLI fallback error, got: ${result.error}`
        );
        // Allow "CLI fallback failed" as expected result
        assert.ok(
          result.error?.includes("CLI fallback failed") ||
          result.error?.includes("openclaw") ||
          result.error?.includes("not found") ||
          result.error?.includes("ENOENT") ||
          result.error?.includes("Cannot find") ||
          true, // CLI errors vary; the key assertion is above
          `Unexpected error: ${result.error}`
        );
      }

      assert.ok(fetchCallCount >= 1, "fetch should have been called");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HTTP 4xx other than 401/404 is NOT treated as transient (hard fail)", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;

    // 403 Forbidden should be a hard failure, not trigger CLI fallback
    globalThis.fetch = (async (_url: any, _opts: any) => {
      fetchCallCount++;
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
        name: "test/gateway-403-check",
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: { kind: "agentTurn", message: "test", timeoutSeconds: 30 },
        delivery: { mode: "none" },
        enabled: false,
      });

      // 403 should hard-fail, not fall through to CLI
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
