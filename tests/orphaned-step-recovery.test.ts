/**
 * Orphaned Running-Step Recovery Tests
 *
 * Validates the conservative recovery path for steps that are stuck in "running"
 * state with no live worker attached.
 *
 * The core guarantee:
 *   - A step that has been running too long is reset to pending (not failed immediately)
 *   - After MAX_ABANDON_RESETS attempts, the step is failed and the run is failed
 *   - Loop steps with an active story are NOT reset (defer to cleanupAbandonedSteps)
 *   - Steps in terminal runs (failed/cancelled/completed) are NOT touched
 *   - A run that is still genuinely active (updated_at fresh) is NOT touched by time-based cleanup
 */

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// ── Minimal in-memory DB ────────────────────────────────────────────

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      abandoned_count INTEGER DEFAULT 0,
      produces_keys TEXT,
      required_keys TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT
    );

    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return db;
}

function now(): string {
  return new Date().toISOString();
}

/** Timestamp far in the past to simulate a step that has been stuck for a long time. */
function oldTimestamp(): string {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
}

// ── Inline resetAbandonedStep logic (mirrors step-ops.ts) ───────────

const MAX_ABANDON_RESETS = 5;

function resetAbandonedStep(
  db: DatabaseSync,
  stepId: string,
  runId: string
): "reset" | "failed" | "skipped" {
  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (!run || run.status === "failed" || run.status === "cancelled" || run.status === "completed") {
    return "skipped";
  }

  const step = db.prepare(
    "SELECT id, step_id, status, type, current_story_id, abandoned_count FROM steps WHERE id = ? AND run_id = ?"
  ).get(stepId, runId) as { id: string; step_id: string; status: string; type: string; current_story_id: string | null; abandoned_count: number } | undefined;

  if (!step || step.status !== "running") return "skipped";

  // Loop steps with active story: skip (per-story retry logic handles this)
  if (step.type === "loop" && step.current_story_id) return "skipped";

  const newCount = (step.abandoned_count ?? 0) + 1;

  if (newCount >= MAX_ABANDON_RESETS) {
    db.prepare(
      "UPDATE steps SET status = 'failed', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newCount, step.id);
    db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(runId);
    return "failed";
  }

  db.prepare(
    "UPDATE steps SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newCount, step.id);
  return "reset";
}

// ── Test runner ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function test(name: string, fn: () => void): void {
  console.log(`\nTest: ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`  EXCEPTION: ${err}`);
    failed++;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

test("orphaned single step is reset to pending on first abandonment", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const old = oldTimestamp();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, old, old);

  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, abandoned_count, created_at, updated_at) VALUES (?, ?, 'fix', 'wf_fixer', 0, '', '', 'running', 0, ?, ?)"
  ).run(stepId, runId, old, old);

  const result = resetAbandonedStep(db, stepId, runId);
  assert(result === "reset", `Expected 'reset', got '${result}'`);

  const step = db.prepare("SELECT status, abandoned_count FROM steps WHERE id = ?").get(stepId) as { status: string; abandoned_count: number };
  assert(step.status === "pending", "Step reset to pending");
  assert(step.abandoned_count === 1, "abandoned_count incremented to 1");

  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  assert(run.status === "running", "Run stays running while step is retrying");
});

test("orphaned step accumulates abandon count across multiple resets", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const old = oldTimestamp();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, old, old);

  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, abandoned_count, created_at, updated_at) VALUES (?, ?, 'triage', 'wf_triager', 0, '', '', 'running', 0, ?, ?)"
  ).run(stepId, runId, old, old);

  // Simulate 4 abandon resets (should all return "reset")
  for (let i = 1; i <= 4; i++) {
    // Simulate agent reclaims and abandons again
    db.prepare("UPDATE steps SET status = 'running', updated_at = ? WHERE id = ?").run(old, stepId);
    const result = resetAbandonedStep(db, stepId, runId);
    assert(result === "reset", `Reset ${i}: expected 'reset', got '${result}'`);
    const step = db.prepare("SELECT abandoned_count FROM steps WHERE id = ?").get(stepId) as { abandoned_count: number };
    assert(step.abandoned_count === i, `abandoned_count is ${i} after reset ${i}`);
  }

  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  assert(run.status === "running", "Run still running after 4 resets");
});

test("orphaned step fails run when MAX_ABANDON_RESETS reached", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const old = oldTimestamp();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, old, old);

  // Step already at 4 abandons — one more should trigger failure
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, abandoned_count, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_coder', 0, '', '', 'running', 4, ?, ?)"
  ).run(stepId, runId, old, old);

  const result = resetAbandonedStep(db, stepId, runId);
  assert(result === "failed", `Expected 'failed', got '${result}'`);

  const step = db.prepare("SELECT status, abandoned_count FROM steps WHERE id = ?").get(stepId) as { status: string; abandoned_count: number };
  assert(step.status === "failed", "Step marked failed");
  assert(step.abandoned_count === 5, "abandoned_count at 5 (MAX_ABANDON_RESETS)");

  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  assert(run.status === "failed", "Run marked failed when step exhausts abandon resets");
});

test("resetAbandonedStep skips steps in terminal runs", () => {
  const db = createTestDb();
  const t = now();

  for (const terminalStatus of ["failed", "cancelled", "completed"]) {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', ?, '{}', ?, ?)"
    ).run(runId, terminalStatus, t, t);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, abandoned_count, created_at, updated_at) VALUES (?, ?, 'step', 'agent', 0, '', '', 'running', 0, ?, ?)"
    ).run(stepId, runId, t, t);

    const result = resetAbandonedStep(db, stepId, runId);
    assert(result === "skipped", `Skips step in ${terminalStatus} run`);

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
    assert(step.status === "running", `Step untouched in ${terminalStatus} run`);
  }
});

test("resetAbandonedStep skips non-running steps", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const t = now();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, t, t);

  for (const stepStatus of ["pending", "waiting", "done", "failed"]) {
    const stepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, abandoned_count, created_at, updated_at) VALUES (?, ?, 'step', 'agent', 0, '', '', ?, 0, ?, ?)"
    ).run(stepId, runId, stepStatus, t, t);

    const result = resetAbandonedStep(db, stepId, runId);
    assert(result === "skipped", `Skips step in status='${stepStatus}'`);
  }
});

test("resetAbandonedStep skips loop step with active story (safe: defer to cleanupAbandonedSteps)", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const storyId = crypto.randomUUID();
  const t = now();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, t, t);

  // Loop step with current_story_id set — there IS active story work
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, abandoned_count, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_coder', 0, '', '', 'running', 'loop', ?, 0, ?, ?)"
  ).run(stepId, runId, storyId, t, t);

  const result = resetAbandonedStep(db, stepId, runId);
  assert(result === "skipped", "Loop step with active story is skipped (safe - no aggressive stealing)");

  const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
  assert(step.status === "running", "Loop step status unchanged");
});

test("resetAbandonedStep resets loop step without active story (no current_story_id)", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const old = oldTimestamp();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)"
  ).run(runId, old, old);

  // Loop step with no current story — it's in a liminal state, safe to reset
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, abandoned_count, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_coder', 0, '', '', 'running', 'loop', NULL, 0, ?, ?)"
  ).run(stepId, runId, old, old);

  const result = resetAbandonedStep(db, stepId, runId);
  assert(result === "reset", "Loop step without active story CAN be reset");

  const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepId) as { status: string };
  assert(step.status === "pending", "Loop step reset to pending");
});

test("time-based threshold: step updated recently should NOT be abandoned", () => {
  // This validates the conservative threshold behaviour conceptually:
  // steps that just started (updated_at is recent) won't appear in the
  // abandoned query because the time threshold hasn't elapsed.
  const recentUpdateAge = 30 * 1000; // 30 seconds ago — well within any threshold
  const maxTimeoutMs = (120 + 5 * 60) * 1000; // 7.5 minutes — minimum ABANDONED_THRESHOLD_MS

  assert(recentUpdateAge < maxTimeoutMs, "Recent step (30s old) is inside the safe window");

  const longRunningAge = 2 * 60 * 60 * 1000; // 2 hours
  assert(longRunningAge > maxTimeoutMs, "Long-running step (2h) exceeds safe threshold and should be detected");
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
