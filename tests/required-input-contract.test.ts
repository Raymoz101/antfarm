import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db.js";
import { claimStep } from "../dist/installer/step-ops.js";

describe("claimStep enforces explicit required input contracts", () => {
  const runIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of runIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    runIds.length = 0;
  });

  it("fails the step when required_keys are missing even if the template does not reference them", () => {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const agentId = `required-contract-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'contract-test', 'task', 'running', ?, ?, ?)`
    ).run(runId, JSON.stringify({ task: "task", repo: "/tmp/example-repo" }), now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, required_keys, created_at, updated_at, type)
       VALUES (?, ?, 'validate-input', ?, 0, ?, 'STATUS: done', 'pending', ?, ?, ?, 'single')`
    ).run(
      stepId,
      runId,
      agentId,
      "Validate the repo before setup.\nREPO: {{repo}}\nReply with:\nSTATUS: done\nRESULT: ok",
      JSON.stringify(["repo", "branch"]),
      now,
      now,
    );

    runIds.push(runId);

    const result = claimStep(agentId);
    assert.equal(result.found, false, "should not hand out work when explicit required keys are missing");

    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string };
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };

    assert.equal(step.status, "failed");
    assert.match(step.output, /missing required template key\(s\) branch/i);
    assert.equal(run.status, "failed");
  });

  it("defaults verify_feedback for first-pass single-step claims", () => {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const agentId = `required-contract-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'bug-fix', 'task', 'running', ?, ?, ?)`
    ).run(runId, JSON.stringify({ repo: '/tmp/example-repo', branch: 'bugfix-test', build_cmd: 'npm run build', test_cmd: 'npm test', affected_area: 'src/initials.js', root_cause: 'empty segments are not ignored', fix_approach: 'filter blank parts before mapping', problem_statement: 'initials throws on repeated whitespace', task: 'bug report' }), now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at, type)
       VALUES (?, ?, 'fix', ?, 3, ?, 'STATUS: done', 'pending', ?, ?, 'single')`
    ).run(
      stepId,
      runId,
      agentId,
      "Implement the bug fix.\nVERIFY FEEDBACK: {{verify_feedback}}\nROOT_CAUSE: {{root_cause}}",
      now,
      now,
    );

    runIds.push(runId);

    const result = claimStep(agentId);
    assert.equal(result.found, true, 'should claim the step even without verify_feedback in context');
    assert.match(result.resolvedInput ?? '', /VERIFY FEEDBACK:\s*\nROOT_CAUSE:/, 'verify_feedback should resolve to an empty string on first pass');
  });
});
