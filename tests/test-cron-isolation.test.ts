/**
 * Test Isolation for Gateway/Cron Tests
 *
 * Validates that the gateway-api module cannot accidentally mutate a live gateway
 * during test runs. Two protection layers:
 *
 *  1. NODE_ENV=test / ANTFARM_TEST=1: any job (regardless of name/agentId) is
 *     treated as a test job and sanitized (disabled, no announcements).
 *
 *  2. ANTFARM_TEST=1: the HTTP path in createAgentCronJobHTTP() returns null
 *     early (signals CLI fallback) so globalThis.fetch is never called even if
 *     the test forgets to mock it.
 *
 * This is an improvement over the v0.5.2 mitigation that only sanitized jobs
 * whose name or agentId starts with "test-".
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Helper: inline isLikelyTestCronJob logic (mirrors gateway-api.ts) ──

type CronJobDefinition = {
  name: string;
  schedule: { kind: string; everyMs?: number };
  sessionTarget: string;
  agentId: string;
  payload: { kind: string; message: string };
  delivery?: { mode: "none" | "announce"; channel?: string };
  enabled: boolean;
};

function isLikelyTestCronJob(
  job: CronJobDefinition,
  env: { NODE_ENV?: string; ANTFARM_TEST?: string }
): boolean {
  if (env.NODE_ENV === "test" || env.ANTFARM_TEST === "1") return true;
  const name = job.name.toLowerCase();
  const agentId = job.agentId.toLowerCase();
  return (
    name.startsWith("test/") ||
    name.startsWith("test-") ||
    name.startsWith("test_") ||
    agentId === "test-agent" ||
    agentId.startsWith("test-") ||
    agentId.startsWith("test_")
  );
}

function sanitizeCronJob(
  job: CronJobDefinition,
  env: { NODE_ENV?: string; ANTFARM_TEST?: string }
): CronJobDefinition {
  if (!isLikelyTestCronJob(job, env)) return job;
  return { ...job, enabled: false, delivery: { mode: "none" } };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("test-cron-isolation: sanitization based on job name/agentId (existing)", () => {
  const prodEnv = { NODE_ENV: "production" };

  it("sanitizes job with name starting with 'test/'", () => {
    const job: CronJobDefinition = {
      name: "test/my-workflow/my-agent",
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      agentId: "my-workflow_my-agent",
      payload: { kind: "agentTurn", message: "poll" },
      delivery: { mode: "announce", channel: "#general" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, prodEnv);
    assert.equal(sanitized.enabled, false, "disabled");
    assert.equal(sanitized.delivery?.mode, "none", "no announcements");
  });

  it("sanitizes job with agentId starting with 'test-'", () => {
    const job: CronJobDefinition = {
      name: "antfarm/real-workflow/real-agent",
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      agentId: "test-agent",
      payload: { kind: "agentTurn", message: "poll" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, prodEnv);
    assert.equal(sanitized.enabled, false, "disabled when agentId matches test pattern");
  });

  it("does NOT sanitize a real production job in production env", () => {
    const job: CronJobDefinition = {
      name: "antfarm/bug-fix/triager",
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      agentId: "bug-fix_triager",
      payload: { kind: "agentTurn", message: "poll" },
      delivery: { mode: "announce" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, prodEnv);
    assert.equal(sanitized.enabled, true, "real job left enabled in production");
    assert.equal(sanitized.delivery?.mode, "announce", "announce preserved in production");
  });
});

describe("test-cron-isolation: NODE_ENV=test forces sanitization of ALL jobs", () => {
  const testEnv = { NODE_ENV: "test" };

  it("sanitizes production-named job when NODE_ENV=test", () => {
    const job: CronJobDefinition = {
      name: "antfarm/bug-fix/triager",
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      agentId: "bug-fix_triager",
      payload: { kind: "agentTurn", message: "poll" },
      delivery: { mode: "announce" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, testEnv);
    assert.equal(sanitized.enabled, false, "disabled in test env regardless of name");
    assert.equal(sanitized.delivery?.mode, "none", "no announcements in test env");
  });

  it("sanitizes any job with NODE_ENV=test — even unusual names", () => {
    const job: CronJobDefinition = {
      name: "production-critical/my-workflow/my-agent",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      agentId: "important-agent",
      payload: { kind: "agentTurn", message: "poll" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, testEnv);
    assert.equal(sanitized.enabled, false, "still disabled when NODE_ENV=test");
  });
});

describe("test-cron-isolation: ANTFARM_TEST=1 forces sanitization of ALL jobs", () => {
  const testEnv = { ANTFARM_TEST: "1" };

  it("sanitizes production-named job when ANTFARM_TEST=1", () => {
    const job: CronJobDefinition = {
      name: "antfarm/feature-dev/planner",
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      agentId: "feature-dev_planner",
      payload: { kind: "agentTurn", message: "poll" },
      delivery: { mode: "announce", channel: "#deploys" },
      enabled: true,
    };
    const sanitized = sanitizeCronJob(job, testEnv);
    assert.equal(sanitized.enabled, false, "disabled when ANTFARM_TEST=1");
    assert.equal(sanitized.delivery?.mode, "none", "no announcements when ANTFARM_TEST=1");
  });

  it("does NOT sanitize when ANTFARM_TEST is not set to '1'", () => {
    // Only exact value '1' triggers test mode
    for (const val of ["0", "false", "", "yes"]) {
      const env = { ANTFARM_TEST: val };
      const job: CronJobDefinition = {
        name: "antfarm/bug-fix/triager",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "bug-fix_triager",
        payload: { kind: "agentTurn", message: "poll" },
        enabled: true,
      };
      const sanitized = sanitizeCronJob(job, env);
      assert.equal(sanitized.enabled, true, `ANTFARM_TEST='${val}' should NOT trigger test mode`);
    }
  });
});

describe("test-cron-isolation: production skips creating Antfarm test workflow crons", () => {
  let savedAntfarmTest: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedAntfarmTest = process.env.ANTFARM_TEST;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.ANTFARM_TEST;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (savedAntfarmTest === undefined) delete process.env.ANTFARM_TEST;
    else process.env.ANTFARM_TEST = savedAntfarmTest;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("createAgentCronJob short-circuits antfarm/test-* jobs before HTTP", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async (..._args: any[]) => {
      fetchCalled = true;
      throw new Error("fetch should not be called for antfarm test workflow crumbs in production");
    }) as any;

    try {
      const mod = await import(`../dist/installer/gateway-api.js?antfarm-prod-skip-${Date.now()}`);
      const result = await mod.createAgentCronJob({
        name: "antfarm/test-wf/test-agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: { kind: "agentTurn", message: "poll" },
        enabled: true,
      });
      assert.equal(result.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, "fetch was NOT called for antfarm/test-* cron in production env");
  });
});

describe("test-cron-isolation: ANTFARM_TEST=1 blocks HTTP path (via module import)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ANTFARM_TEST;
    process.env.ANTFARM_TEST = "1";
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ANTFARM_TEST;
    } else {
      process.env.ANTFARM_TEST = savedEnv;
    }
  });

  it("createAgentCronJob does not call fetch when ANTFARM_TEST=1 (HTTP path blocked)", async () => {
    // Even if fetch is not mocked, no real HTTP call should be attempted.
    // The HTTP path returns null early when ANTFARM_TEST=1, then CLI fallback is tried.
    // CLI fallback will fail (no openclaw binary in CI), so result.ok will be false —
    // but crucially, globalThis.fetch was NEVER invoked.

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async (..._args: any[]) => {
      fetchCalled = true;
      throw new Error("TEST FAILURE: fetch should not be called when ANTFARM_TEST=1");
    }) as any;

    try {
      const mod = await import(`../dist/installer/gateway-api.js?antfarm-test-isolation-${Date.now()}`);
      // CLI fallback will fail (openclaw not in PATH in test env), but that's expected
      await mod.createAgentCronJob({
        name: "antfarm/bug-fix/triager",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "bug-fix_triager",
        payload: { kind: "agentTurn", message: "poll" },
        enabled: true,
      });
    } catch {
      // CLI failure is expected — we only care that fetch wasn't called
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false, "fetch was NOT called when ANTFARM_TEST=1");
  });
});
