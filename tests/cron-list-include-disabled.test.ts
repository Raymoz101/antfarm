/**
 * Regression test: listCronJobs must include disabled crons.
 *
 * The HTTP path was previously sending { action: "list" } without
 * includeDisabled, so sanitized/disabled test crons and disabled workflow
 * crons were invisible to workflowCronsExist(), causing duplicate cron
 * creation on restart.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("listCronJobs includes disabled crons in HTTP request", () => {
  let capturedBodies: any[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    capturedBodies = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      capturedBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            content: [{ text: JSON.stringify({ jobs: [] }) }],
          },
        }),
      };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends includeDisabled: true in the HTTP request body by default", async () => {
    const { listCronJobs } = await import("../dist/installer/gateway-api.js");
    await listCronJobs();

    assert.ok(capturedBodies.length >= 1, "fetch should have been called");
    const listBody = capturedBodies.find((b: any) => b.args?.action === "list");
    assert.ok(listBody, "should have sent a cron list request");
    assert.equal(
      listBody.args.includeDisabled,
      true,
      "HTTP list request must send includeDisabled: true"
    );
  });

  it("sends includeDisabled: true when explicitly requested", async () => {
    const { listCronJobs } = await import("../dist/installer/gateway-api.js");
    await listCronJobs({ includeDisabled: true });

    const listBody = capturedBodies.find((b: any) => b.args?.action === "list");
    assert.ok(listBody, "should have sent a cron list request");
    assert.equal(listBody.args.includeDisabled, true);
  });

  it("sends includeDisabled: false when explicitly disabled", async () => {
    const { listCronJobs } = await import("../dist/installer/gateway-api.js");
    await listCronJobs({ includeDisabled: false });

    const listBody = capturedBodies.find((b: any) => b.args?.action === "list");
    assert.ok(listBody, "should have sent a cron list request");
    assert.equal(listBody.args.includeDisabled, false);
  });
});
