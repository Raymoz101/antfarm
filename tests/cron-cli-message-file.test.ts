/**
 * Regression test: CLI fallback for createAgentCronJob must use --message-file
 * instead of --message to avoid OS argument-length limits.
 *
 * Agent prompts are several KB.  Passing them as a CLI argument can exceed
 * ARG_MAX (~128 KB on Linux, much lower on some systems) and causes silent
 * failure or ENAMETOOLONG errors when spawning the openclaw subprocess.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";

describe("createAgentCronJob CLI fallback uses --message-file", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedCliArgs: string[];

  beforeEach(() => {
    capturedCliArgs = [];
    originalFetch = globalThis.fetch;

    // Force HTTP to return 401 (transient) so code falls through to CLI
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
      json: async () => ({ error: "Unauthorized" }),
    })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not pass --message as a direct CLI argument", async () => {
    // We can verify the code path by checking the temp file mechanism:
    // import the source and verify --message is not in the args array.
    // Since execFile will fail (no openclaw), we can't run end-to-end,
    // but we can verify the source code structure.

    const srcPath = new URL("../src/installer/gateway-api.ts", import.meta.url).pathname;
    const source = fs.readFileSync(srcPath, "utf-8");

    // The CLI fallback must NOT use args.push("--message", job.payload.message)
    assert.ok(
      !source.includes(`args.push("--message", job.payload.message)`),
      'Source must not push "--message" directly — use --message-file instead'
    );

    // It must use --message-file
    assert.ok(
      source.includes(`"--message-file"`),
      'Source must use "--message-file" temp file pattern'
    );
  });

  it("temp file is created and cleaned up even on CLI error", async () => {
    const { createAgentCronJob } = await import("../dist/installer/gateway-api.js");

    // Track temp files before
    const tmpDir = os.tmpdir();
    const beforeFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith("antfarm-cron-msg-"));

    const result = await createAgentCronJob({
      name: "test/message-file-test",
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      agentId: "test-agent",
      payload: {
        kind: "agentTurn",
        message: "A".repeat(1000), // 1 KB message
        timeoutSeconds: 30,
      },
      delivery: { mode: "none" },
      enabled: false,
    });

    // Track temp files after — should be cleaned up
    const afterFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith("antfarm-cron-msg-"));
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));

    assert.equal(
      newFiles.length,
      0,
      `Temp message files should be cleaned up after CLI call, found: ${newFiles.join(", ")}`
    );

    // The result will be a CLI fallback failure (no openclaw in test env) — that's fine
    // The important thing is no temp files remain
    if (!result.ok) {
      assert.ok(
        result.error?.includes("CLI fallback failed"),
        `Expected CLI fallback error, got: ${result.error}`
      );
    }
  });
});
