/**
 * Regression test: installMedicCron must be idempotent — calling it multiple
 * times must not create duplicate cron jobs.
 *
 * Without idempotency, each container restart (which calls antfarm install or
 * starts the dashboard) would create a new medic cron, eventually causing
 * dozens of concurrent medic checks per interval.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("installMedicCron is idempotent", () => {
  let fetchCallCount: number;
  let createdCronCount: number;
  let listedJobs: Array<{ id: string; name: string }>;
  let originalFetch: typeof globalThis.fetch;
  let savedNodeEnv: string | undefined;
  let savedAntfarmTest: string | undefined;

  beforeEach(() => {
    fetchCallCount = 0;
    createdCronCount = 0;
    savedNodeEnv = process.env.NODE_ENV;
    savedAntfarmTest = process.env.ANTFARM_TEST;
    process.env.NODE_ENV = "production";
    delete process.env.ANTFARM_TEST;
    // Simulate the medic cron already existing after the first install
    listedJobs = [{ id: "existing-medic-id", name: "antfarm/medic" }];

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, opts: any) => {
      fetchCallCount++;
      const body = JSON.parse(opts.body);

      if (body.args?.action === "list") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { content: [{ text: JSON.stringify({ jobs: listedJobs }) }] },
          }),
        };
      }

      if (body.args?.action === "add") {
        createdCronCount++;
        listedJobs = [...listedJobs, { id: `new-cron-${createdCronCount}`, name: body.args.job?.name ?? "unknown" }];
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { id: `new-cron-${createdCronCount}` } }),
        };
      }

      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not create a second cron if medic is already installed", async () => {
    const { installMedicCron } = await import("../dist/medic/medic-cron.js");

    // First call: medic already exists (listedJobs pre-populated)
    const result = await installMedicCron();

    assert.ok(result.ok, `installMedicCron should succeed: ${result.error}`);
    assert.equal(
      createdCronCount,
      0,
      "Should not create a new cron when one already exists"
    );
  });

  it("creates a cron on first install when none exists", async () => {
    // Start with empty job list
    listedJobs = [];

    const { installMedicCron } = await import("../dist/medic/medic-cron.js");

    const result = await installMedicCron();

    assert.ok(result.ok, `installMedicCron should succeed: ${result.error}`);
    assert.equal(
      createdCronCount,
      1,
      "Should create exactly one cron on first install"
    );
  });

  it("calling installMedicCron twice does not create duplicates", async () => {
    // Start with empty job list — first call creates it, second should no-op
    listedJobs = [];

    const { installMedicCron } = await import("../dist/medic/medic-cron.js");

    const result1 = await installMedicCron();
    const result2 = await installMedicCron();

    assert.ok(result1.ok, `first installMedicCron should succeed`);
    assert.ok(result2.ok, `second installMedicCron should succeed`);
    assert.equal(
      createdCronCount,
      1,
      "Should create only one cron even after two install calls"
    );
  });
});
