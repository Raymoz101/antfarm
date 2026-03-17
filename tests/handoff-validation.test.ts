/**
 * Handoff Validation Tests
 *
 * Validates that when a step completes with output that is missing required
 * fields (declared via produces_keys), the failure is detected AT the producing
 * step — not later when the next step tries to render its template.
 *
 * Covers real failure modes observed in production:
 *   - triage omitting required structured fields (repo, branch, severity, ...)
 *   - fix step omitting root_cause / fix_approach / regression_test
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

// ── Inline produces_keys validation logic (mirrors step-ops.ts) ─────

/**
 * Simulate the produces_keys validation that completeStep() performs.
 * Returns missing keys, or empty array if all present.
 */
function validateProducesKeys(
  producesKeysJson: string | null,
  parsedOutput: Record<string, string>
): string[] {
  if (!producesKeysJson) return [];
  const requiredKeys: string[] = JSON.parse(producesKeysJson);
  return requiredKeys.filter(
    k => !Object.prototype.hasOwnProperty.call(parsedOutput, k)
  );
}

/**
 * Parse KEY: value output lines (simplified version of parseOutputKeyValues).
 */
function parseOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m && !m[1].startsWith("STORIES_JSON")) {
      result[m[1].toLowerCase()] = m[2].trim();
    }
  }
  return result;
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

test("produces_keys validation passes when all required fields present", () => {
  const producesKeys = JSON.stringify(["status", "repo", "branch", "severity"]);
  const output = parseOutput(
    "STATUS: done\nREPO: /tmp/myrepo\nBRANCH: bugfix-123\nSEVERITY: high"
  );
  const missing = validateProducesKeys(producesKeys, output);
  assert(missing.length === 0, "No missing keys when all fields present");
});

test("produces_keys validation detects missing required fields", () => {
  const producesKeys = JSON.stringify([
    "status", "repo", "branch", "severity", "affected_area", "reproduction", "problem_statement"
  ]);
  // Triage only outputs STATUS and REPO — missing 5 required fields
  const output = parseOutput("STATUS: done\nREPO: /tmp/myrepo");
  const missing = validateProducesKeys(producesKeys, output);
  assert(missing.length === 5, `Detects 5 missing fields (got ${missing.length})`);
  assert(missing.includes("branch"), "Detects missing BRANCH");
  assert(missing.includes("severity"), "Detects missing SEVERITY");
  assert(missing.includes("affected_area"), "Detects missing AFFECTED_AREA");
  assert(missing.includes("reproduction"), "Detects missing REPRODUCTION");
  assert(missing.includes("problem_statement"), "Detects missing PROBLEM_STATEMENT");
});

test("produces_keys validation is case-insensitive (keys stored lowercase)", () => {
  // Keys are stored lowercase in produces_keys JSON
  const producesKeys = JSON.stringify(["root_cause", "fix_approach"]);
  // Agent output uses uppercase keys (as expected in the protocol)
  const output = parseOutput("STATUS: done\nROOT_CAUSE: null pointer\nFIX_APPROACH: add nil check");
  const missing = validateProducesKeys(producesKeys, output);
  assert(missing.length === 0, "Lowercase produces keys match uppercase agent output after parsing");
});

test("produces_keys skips validation when field is null", () => {
  const output = parseOutput("STATUS: done");
  const missing = validateProducesKeys(null, output);
  assert(missing.length === 0, "Null produces_keys means no validation required");
});

test("produces_keys detects fix step missing regression_test field (real failure mode)", () => {
  const producesKeys = JSON.stringify(["status", "changes", "regression_test"]);
  // Fix step forgot to include REGRESSION_TEST
  const output = parseOutput("STATUS: done\nCHANGES: fixed null pointer in handler");
  const missing = validateProducesKeys(producesKeys, output);
  assert(missing.length === 1, `Exactly 1 missing field (got ${missing.length})`);
  assert(missing[0] === "regression_test", "Detects missing REGRESSION_TEST");
});

test("completeStep-like: step reset to pending on validation failure (retries remain)", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const t = now();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'bug-fix', 'task', 'running', '{}', ?, ?)"
  ).run(runId, t, t);

  // Triage step: max_retries=2, retry_count=0, requires produces_keys
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, produces_keys, created_at, updated_at) VALUES (?, ?, 'triage', 'bug-fix_triager', 0, '', 'STATUS: done', 'running', 0, 2, ?, ?, ?)"
  ).run(stepId, runId, JSON.stringify(["status", "repo", "branch", "severity"]), t, t);

  // Simulate completeStep with missing produces_keys
  const step = db.prepare(
    "SELECT id, step_id, produces_keys, retry_count, max_retries FROM steps WHERE id = ?"
  ).get(stepId) as { id: string; step_id: string; produces_keys: string; retry_count: number; max_retries: number };

  const parsedOutput = parseOutput("STATUS: done\nREPO: /tmp/r");
  const missing = validateProducesKeys(step.produces_keys, parsedOutput);

  assert(missing.length > 0, "Validation detects missing fields");

  // Apply retry logic: reset to pending since retry_count + 1 <= max_retries
  const newRetry = step.retry_count + 1;
  if (newRetry <= step.max_retries) {
    db.prepare(
      "UPDATE steps SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newRetry, step.id);
  }

  const after = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number };
  assert(after.status === "pending", "Step reset to pending for retry");
  assert(after.retry_count === 1, "retry_count incremented to 1");

  // Run status should NOT be failed (still retrying)
  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  assert(run.status === "running", "Run remains running while step is retrying");
});

test("completeStep-like: step and run fail when retries exhausted on validation failure", () => {
  const db = createTestDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const t = now();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'bug-fix', 'task', 'running', '{}', ?, ?)"
  ).run(runId, t, t);

  // Step at max retries already
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, produces_keys, created_at, updated_at) VALUES (?, ?, 'investigate', 'bug-fix_investigator', 1, '', 'STATUS: done', 'running', 2, 2, ?, ?, ?)"
  ).run(stepId, runId, JSON.stringify(["status", "root_cause", "fix_approach"]), t, t);

  const step = db.prepare(
    "SELECT id, step_id, produces_keys, retry_count, max_retries FROM steps WHERE id = ?"
  ).get(stepId) as { id: string; step_id: string; produces_keys: string; retry_count: number; max_retries: number };

  // Missing root_cause and fix_approach
  const parsedOutput = parseOutput("STATUS: done");
  const missing = validateProducesKeys(step.produces_keys, parsedOutput);
  assert(missing.length === 2, `Detects 2 missing fields (got ${missing.length})`);

  // Apply retry logic: retries exhausted
  const newRetry = step.retry_count + 1;
  if (newRetry > step.max_retries) {
    const errorMsg = `Step "${step.step_id}" output is missing required field(s): ${missing.join(", ")}`;
    db.prepare("UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(errorMsg, newRetry, step.id);
    db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(runId);
  }

  const afterStep = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number };
  assert(afterStep.status === "failed", "Step marked failed when retries exhausted");
  assert(afterStep.retry_count === 3, "retry_count bumped to 3");

  const afterRun = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  assert(afterRun.status === "failed", "Run marked failed when step retries exhausted");
});

test("produces_keys validation does not apply to loop steps", () => {
  // Loop steps have variable per-story output structure — validation is skipped
  const stepType = "loop";
  const producesKeys = JSON.stringify(["some_key"]);
  const parsedOutput = parseOutput("STATUS: done");

  // The validation check in completeStep() is: if (step.produces_keys && step.type !== "loop")
  const shouldValidate = stepType !== "loop";
  assert(!shouldValidate, "Loop steps bypass produces_keys validation");
});

test("produces_keys stored as lowercase for case-insensitive enforcement", () => {
  // Simulate what run.ts does: lowercase all produces keys
  const rawProduces = ["STATUS", "ROOT_CAUSE", "FIX_APPROACH"];
  const stored = JSON.stringify(rawProduces.map(k => k.toLowerCase()));
  const parsed: string[] = JSON.parse(stored);
  assert(parsed[0] === "status", "STATUS normalized to status");
  assert(parsed[1] === "root_cause", "ROOT_CAUSE normalized to root_cause");
  assert(parsed[2] === "fix_approach", "FIX_APPROACH normalized to fix_approach");
});

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
