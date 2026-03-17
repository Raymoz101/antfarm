/**
 * Medic health checks — modular functions that inspect DB state and return findings.
 */
import fs from "node:fs";
import { getDb } from "../db.js";
import { getMaxRoleTimeoutSeconds } from "../installer/install.js";
import { resolveWorkflowDir } from "../installer/paths.js";

export type MedicSeverity = "info" | "warning" | "critical";
export type MedicActionType =
  | "reset_step"
  | "fail_run"
  | "teardown_crons"
  | "none";

export interface MedicFinding {
  check: string;
  severity: MedicSeverity;
  message: string;
  action: MedicActionType;
  /** IDs of affected entities */
  runId?: string;
  stepId?: string;
  /** Whether the medic auto-remediated this */
  remediated: boolean;
}

// ── Check: Stuck Steps ──────────────────────────────────────────────

const MAX_ROLE_TIMEOUT_MS = (getMaxRoleTimeoutSeconds() + 5 * 60) * 1000;

/**
 * Find steps that have been "running" longer than the max role timeout.
 * These are likely abandoned by crashed/timed-out agents.
 */
export function checkStuckSteps(): MedicFinding[] {
  const db = getDb();
  const findings: MedicFinding[] = [];

  const stuck = db.prepare(`
    SELECT s.id, s.step_id, s.run_id, s.agent_id, s.updated_at, s.abandoned_count,
           r.workflow_id, r.task
    FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.status = 'running'
      AND r.status = 'running'
      AND (julianday('now') - julianday(s.updated_at)) * 86400000 > ?
  `).all(MAX_ROLE_TIMEOUT_MS) as Array<{
    id: string; step_id: string; run_id: string; agent_id: string;
    updated_at: string; abandoned_count: number; workflow_id: string; task: string;
  }>;

  for (const step of stuck) {
    const ageMin = Math.round(
      (Date.now() - new Date(step.updated_at).getTime()) / 60000
    );
    findings.push({
      check: "stuck_steps",
      severity: "warning",
      message: `Step "${step.step_id}" in run ${step.run_id.slice(0, 8)} (${step.workflow_id}) has been running for ${ageMin}min — likely abandoned by agent ${step.agent_id}`,
      action: "reset_step",
      runId: step.run_id,
      stepId: step.id,
      remediated: false, // caller decides whether to remediate
    });
  }

  return findings;
}

// ── Check: Stalled Runs ─────────────────────────────────────────────

const STALL_THRESHOLD_MS = MAX_ROLE_TIMEOUT_MS * 2;

/**
 * Find runs where no step OR story has progressed in 2x the max role timeout.
 * Checks both step transitions and story-level progress, so multi-story
 * implement steps (which can run for hours) don't trigger false positives
 * as long as stories keep completing.
 */
export function checkStalledRuns(): MedicFinding[] {
  const db = getDb();
  const findings: MedicFinding[] = [];

  // Get running runs where BOTH the most recent step update AND story update are stale.
  // A run is only stalled if neither steps nor stories have progressed recently.
  const stalled = db.prepare(`
    SELECT r.id, r.workflow_id, r.task, r.updated_at,
           MAX(s.updated_at) as last_step_update,
           (SELECT MAX(st.updated_at) FROM stories st WHERE st.run_id = r.id) as last_story_update
    FROM runs r
    JOIN steps s ON s.run_id = r.id
    WHERE r.status = 'running'
    GROUP BY r.id
    HAVING (julianday('now') - julianday(
      MAX(
        COALESCE(MAX(s.updated_at), '2000-01-01'),
        COALESCE((SELECT MAX(st.updated_at) FROM stories st WHERE st.run_id = r.id), '2000-01-01')
      )
    )) * 86400000 > ?
  `).all(STALL_THRESHOLD_MS) as Array<{
    id: string; workflow_id: string; task: string;
    updated_at: string; last_step_update: string; last_story_update: string | null;
  }>;

  for (const run of stalled) {
    const latestUpdate = run.last_story_update && run.last_story_update > run.last_step_update
      ? run.last_story_update : run.last_step_update;
    const ageMin = Math.round(
      (Date.now() - new Date(latestUpdate).getTime()) / 60000
    );
    findings.push({
      check: "stalled_runs",
      severity: "critical",
      message: `Run ${run.id.slice(0, 8)} (${run.workflow_id}: "${run.task.slice(0, 60)}") has had no step or story progress for ${ageMin}min`,
      action: "none", // alert only — don't auto-fail without human input
      runId: run.id,
      remediated: false,
    });
  }

  return findings;
}

// ── Check: Dead Runs ────────────────────────────────────────────────

/**
 * Find runs marked as "running" but all steps are terminal (done/failed)
 * with no waiting/pending/running steps left. These are zombie runs.
 */
export function checkDeadRuns(): MedicFinding[] {
  const db = getDb();
  const findings: MedicFinding[] = [];

  const zombies = db.prepare(`
    SELECT r.id, r.workflow_id, r.task
    FROM runs r
    WHERE r.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM steps s
        WHERE s.run_id = r.id
        AND s.status IN ('waiting', 'pending', 'running')
      )
  `).all() as Array<{ id: string; workflow_id: string; task: string }>;

  for (const run of zombies) {
    // Check if all steps are done (should be completed) or some are failed
    const failed = db.prepare(
      "SELECT COUNT(*) as cnt FROM steps WHERE run_id = ? AND status = 'failed'"
    ).get(run.id) as { cnt: number };

    const action: MedicActionType = "fail_run";
    const detail = failed.cnt > 0
      ? `${failed.cnt} failed step(s), no active steps remaining`
      : `All steps terminal but run still marked as running`;

    findings.push({
      check: "dead_runs",
      severity: "critical",
      message: `Run ${run.id.slice(0, 8)} (${run.workflow_id}) is a zombie — ${detail}`,
      action,
      runId: run.id,
      remediated: false,
    });
  }

  return findings;
}

// ── Check: Orphaned Crons ───────────────────────────────────────────

/**
 * Check if agent crons exist for workflows with zero active runs.
 * Returns workflow IDs that should have their crons torn down.
 *
 * NOTE: This check requires the list of current cron jobs to be passed in,
 * since reading crons is async (gateway API). The medic runner handles this.
 */
function isLikelyTestWorkflowCron(job: { name: string; agentId?: string }): boolean {
  const name = job.name.toLowerCase();
  const agentId = (job.agentId ?? "").toLowerCase();
  const match = name.match(/^antfarm\/([^/]+)\/([^/]+)/);
  const workflowId = match?.[1]?.toLowerCase() ?? "";
  const roleId = match?.[2]?.toLowerCase() ?? "";

  return (
    workflowId === "test-wf" ||
    workflowId.startsWith("test-") ||
    workflowId.startsWith("test_") ||
    roleId === "test-agent" ||
    roleId.startsWith("test-") ||
    roleId.startsWith("test_") ||
    agentId === "test-agent" ||
    agentId.startsWith("test-") ||
    agentId.startsWith("test_")
  );
}

export function checkOrphanedCrons(
  cronJobs: Array<{ id: string; name: string; agentId?: string }>,
): MedicFinding[] {
  const db = getDb();
  const findings: MedicFinding[] = [];

  const relevantJobs = cronJobs.filter(job => !isLikelyTestWorkflowCron(job));

  // Extract unique workflow IDs from antfarm cron job names
  const workflowIds = new Set<string>();
  for (const job of relevantJobs) {
    const match = job.name.match(/^antfarm\/([^/]+)\//);
    if (match) workflowIds.add(match[1]);
  }

  for (const wfId of workflowIds) {
    // Only flag crons as orphaned if the workflow is NOT installed.
    // Installed workflows keep their crons regardless of active runs —
    // they need them to pick up new work when runs are started.
    if (fs.existsSync(resolveWorkflowDir(wfId))) continue;

    const jobCount = relevantJobs.filter(j => j.name.startsWith(`antfarm/${wfId}/`)).length;
    findings.push({
      check: "orphaned_crons",
      severity: "warning",
      message: `${jobCount} cron job(s) for uninstalled workflow "${wfId}" — should be cleaned up`,
      action: "teardown_crons",
      remediated: false,
    });
  }

  return findings;
}

// ── Run All Checks ──────────────────────────────────────────────────

/**
 * Run all synchronous checks (everything except orphaned crons which needs async cron list).
 */
export function runSyncChecks(): MedicFinding[] {
  return [
    ...checkStuckSteps(),
    ...checkStalledRuns(),
    ...checkDeadRuns(),
  ];
}
