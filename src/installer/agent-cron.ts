import { createAgentCronJob, deleteAgentCronJobs, listCronJobs, checkCronToolAvailable } from "./gateway-api.js";
import type { WorkflowAgent, WorkflowSpec } from "./types.js";
import { resolveAntfarmCli } from "./paths.js";
import { getDb } from "../db.js";
import { readOpenClawConfig } from "./openclaw-config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_EVERY_MS = 300_000; // 5 minutes
const DEFAULT_AGENT_TIMEOUT_SECONDS = 30 * 60; // 30 minutes

function buildAgentPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Check for pending work and execute it.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

Step 1 — Check for pending work:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`

If output is "NO_WORK", reply HEARTBEAT_OK and stop.

Step 2 — If JSON is returned, it contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Step 3 — Do the work described in the input. Format your output with the EXACT KEY: value lines required by the claimed step input.

Step 4 — MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
<copy the exact step-specific KEY: value output required by the input's "Reply with:" section>
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

CRITICAL OUTPUT RULES:
- Follow the claimed step input's "Reply with:" contract exactly
- First extract the exact keys from the claimed step input's "Reply with:" block and use ONLY that block as your output contract
- Ignore stale agent-doc examples or generic wrapper habits if they conflict with the claimed step input
- Do NOT substitute generic fields like CHANGES or TESTS unless the input explicitly asks for them
- If the input requires REPO / BRANCH / SEVERITY / AFFECTED_AREA / REPRODUCTION / PROBLEM_STATEMENT, emit those exact keys
- If the input requires ROOT_CAUSE / FIX_APPROACH, REGRESSION_TEST, or VERIFIED, emit those exact keys

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

export function buildWorkPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Execute the pending work below.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

The claimed step JSON is provided below. It contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with the EXACT KEY: value lines required by the claimed step input.

MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
<copy the exact step-specific KEY: value output required by the input's "Reply with:" section>
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

CRITICAL OUTPUT RULES:
- Follow the claimed step input's "Reply with:" contract exactly
- First extract the exact keys from the claimed step input's "Reply with:" block and use ONLY that block as your output contract
- Ignore stale agent-doc examples or generic wrapper habits if they conflict with the claimed step input
- Do NOT substitute generic fields like CHANGES or TESTS unless the input explicitly asks for them
- If the input requires REPO / BRANCH / SEVERITY / AFFECTED_AREA / REPRODUCTION / PROBLEM_STATEMENT, emit those exact keys
- If the input requires ROOT_CAUSE / FIX_APPROACH, REGRESSION_TEST, or VERIFIED, emit those exact keys

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

const DEFAULT_POLLING_TIMEOUT_SECONDS = 120;
const DEFAULT_POLLING_MODEL = "default";

function extractModel(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const primary = (value as { primary?: unknown }).primary;
    if (typeof primary === "string") return primary;
  }
  return undefined;
}

async function resolveAgentCronModel(agentId: string, requestedModel?: string): Promise<string | undefined> {
  if (requestedModel && requestedModel !== "default") {
    return requestedModel;
  }

  try {
    const { config } = await readOpenClawConfig();
    const agents = config.agents?.list;
    if (Array.isArray(agents)) {
      const entry = agents.find((a: any) => a?.id === agentId);
      const configured = extractModel(entry?.model);
      if (configured) return configured;
    }

    const defaults = config.agents?.defaults;
    const fallback = extractModel(defaults?.model);
    if (fallback) return fallback;
  } catch {
    // best-effort — fallback below
  }

  return requestedModel;
}

export function buildPollingPrompt(workflowId: string, agentId: string, workModel?: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();
  const model = workModel ?? "default";
  const workPrompt = buildWorkPrompt(workflowId, agentId);

  return `Step 1 — Quick check for pending work (lightweight, no side effects):
\`\`\`
node ${cli} step peek "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop immediately. Do NOT run step claim.

Step 2 — If "HAS_WORK", claim the step:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop.

If JSON is returned, parse it to extract stepId, runId, and input fields.
Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- model: "${model}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.

Full work prompt to include in the spawned task:
---START WORK PROMPT---
${workPrompt}
---END WORK PROMPT---

Reply with a short summary of what you spawned.`;
}

type CronJobShape = {
  id?: string;
  name: string;
  schedule?: { kind?: string; everyMs?: number; anchorMs?: number };
  sessionTarget?: string;
  agentId?: string;
  payload?: { kind?: string; message?: string; model?: string; timeoutSeconds?: number };
  delivery?: { mode?: string; channel?: string; to?: string };
  enabled?: boolean;
};

async function buildDesiredCronJob(workflow: WorkflowSpec, agent: WorkflowAgent, index: number): Promise<CronJobShape> {
  const everyMs = (workflow as any).cron?.interval_ms ?? DEFAULT_EVERY_MS;
  const workflowPollingModel = workflow.polling?.model ?? DEFAULT_POLLING_MODEL;
  const workflowPollingTimeout = workflow.polling?.timeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS;
  const anchorMs = index * 60_000;
  const cronName = `antfarm/${workflow.id}/${agent.id}`;
  const agentId = `${workflow.id}_${agent.id}`;

  const requestedPollingModel = agent.pollingModel ?? workflowPollingModel;
  const pollingModel = await resolveAgentCronModel(agentId, requestedPollingModel);
  const requestedWorkModel = agent.model ?? workflowPollingModel;
  const workModel = await resolveAgentCronModel(agentId, requestedWorkModel);
  const prompt = buildPollingPrompt(workflow.id, agent.id, workModel);
  const resolvedModel = pollingModel && pollingModel !== "default" ? pollingModel : undefined;

  return {
    name: cronName,
    schedule: { kind: "every", everyMs, anchorMs },
    sessionTarget: "isolated",
    agentId,
    payload: {
      kind: "agentTurn",
      message: prompt,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      timeoutSeconds: workflowPollingTimeout,
    },
    delivery: { mode: "none" },
    enabled: true,
  };
}

function normalizeMaybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cronJobsMatch(existing: CronJobShape, desired: CronJobShape): boolean {
  return existing.name === desired.name
    && existing.schedule?.kind === desired.schedule?.kind
    && existing.schedule?.everyMs === desired.schedule?.everyMs
    && existing.schedule?.anchorMs === desired.schedule?.anchorMs
    && normalizeMaybeString(existing.sessionTarget) === normalizeMaybeString(desired.sessionTarget)
    && normalizeMaybeString(existing.agentId) === normalizeMaybeString(desired.agentId)
    && normalizeMaybeString(existing.payload?.kind) === normalizeMaybeString(desired.payload?.kind)
    && normalizeMaybeString(existing.payload?.message) === normalizeMaybeString(desired.payload?.message)
    && normalizeMaybeString(existing.payload?.model) === normalizeMaybeString(desired.payload?.model)
    && existing.payload?.timeoutSeconds === desired.payload?.timeoutSeconds
    && normalizeMaybeString(existing.delivery?.mode) === normalizeMaybeString(desired.delivery?.mode)
    && (existing.enabled ?? true) === (desired.enabled ?? true);
}

async function workflowCronsNeedRefresh(workflow: WorkflowSpec): Promise<boolean> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return true;

  const prefix = `antfarm/${workflow.id}/`;
  const existingJobs = result.jobs.filter((job) => job.name.startsWith(prefix));
  if (existingJobs.length !== workflow.agents.length) return true;

  const desiredJobs = await Promise.all(workflow.agents.map((agent, index) => buildDesiredCronJob(workflow, agent, index)));
  return desiredJobs.some((desired) => {
    const existing = existingJobs.find((job) => job.name === desired.name);
    return !existing || !cronJobsMatch(existing, desired);
  });
}

export async function setupAgentCrons(workflow: WorkflowSpec): Promise<void> {
  for (let i = 0; i < workflow.agents.length; i++) {
    const agent = workflow.agents[i];
    const desiredJob = await buildDesiredCronJob(workflow, agent, i);
    const result = await createAgentCronJob(desiredJob as any);

    if (!result.ok) {
      throw new Error(`Failed to create cron job for agent "${agent.id}": ${result.error}`);
    }
  }
}

export async function removeAgentCrons(workflowId: string): Promise<void> {
  await deleteAgentCronJobs(`antfarm/${workflowId}/`);
}

// ── Cron drift detection ─────────────────────────────────────────────
//
// When workflow prompts, models, or timeouts change, existing cron jobs
// won't reflect the update until crons are recreated. We track a short
// content-hash of all cron-influencing parameters. On each
// ensureWorkflowCrons call, if the hash has changed we automatically
// delete and recreate the crons — so prompt/spec changes propagate to
// live jobs without requiring a manual reinstall.

const CRON_SIG_FILE = path.join(os.homedir(), ".openclaw", "antfarm", "cron-signatures.json");

function loadCronSignatures(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(CRON_SIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveCronSignature(workflowId: string, sig: string): void {
  try {
    const sigs = loadCronSignatures();
    sigs[workflowId] = sig;
    const dir = path.dirname(CRON_SIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CRON_SIG_FILE, JSON.stringify(sigs, null, 2), "utf-8");
  } catch {
    // best-effort — signature tracking is advisory, not critical
  }
}

/**
 * Compute a short hash over all parameters that affect cron job payloads:
 * agent ids/models/timeouts, polling config, interval, and the built-in
 * prompt template text (so antfarm upgrades that change prompts also
 * trigger a refresh).
 *
 * Exported for testing.
 */
export function computeWorkflowCronSignature(workflow: WorkflowSpec): string {
  const everyMs = (workflow as any).cron?.interval_ms ?? DEFAULT_EVERY_MS;
  const parts: string[] = [
    workflow.id,
    String(workflow.version ?? 1),
    workflow.polling?.model ?? DEFAULT_POLLING_MODEL,
    String(workflow.polling?.timeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS),
    String(everyMs),
    // Include agent-level config
    ...workflow.agents.map(a =>
      `${a.id}:${a.model ?? ""}:${a.pollingModel ?? ""}:${a.timeoutSeconds ?? ""}`
    ),
    // Include the built-in work prompt template as a proxy for antfarm version
    ...(workflow.agents.length > 0
      ? [buildWorkPrompt(workflow.id, workflow.agents[0].id)]
      : []),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Refresh crons for a workflow by deleting and recreating them with the
 * current spec. Call this after changing workflow prompts, models, or
 * timeouts to ensure live cron jobs immediately reflect the latest spec.
 *
 * Unlike ensureWorkflowCrons (which no-ops if crons exist and are fresh),
 * this always performs a full delete-and-recreate.
 */
export async function refreshWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  await removeAgentCrons(workflow.id);
  await setupAgentCrons(workflow);
  saveCronSignature(workflow.id, computeWorkflowCronSignature(workflow));
}

// ── Run-scoped cron lifecycle ───────────────────────────────────────

/**
 * Count active (running) runs for a given workflow.
 */
function countActiveRuns(workflowId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'"
  ).get(workflowId) as { cnt: number };
  return row.cnt;
}

/**
 * Check if crons already exist for a workflow.
 */
async function workflowCronsExist(workflowId: string): Promise<boolean> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return false;
  const prefix = `antfarm/${workflowId}/`;
  return result.jobs.some((j) => j.name.startsWith(prefix));
}

/**
 * Start crons for a workflow when a run begins.
 *
 * Uses a local content-hash (cron-signatures.json) to detect whether the
 * workflow spec has drifted since the crons were last created. If it has,
 * crons are automatically deleted and recreated with the current spec.
 *
 * This ensures prompt, model, and timeout changes reach live jobs without
 * requiring a manual `antfarm workflow install` or `ensure-crons` run.
 * The signature comparison is fast (local file read + hash) and avoids
 * repeated gateway round-trips for payload comparison — since listCronJobs
 * only returns {id,name}, payload-level drift cannot be detected via the
 * gateway API alone.
 */
export async function ensureWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  const currentSig = computeWorkflowCronSignature(workflow);
  const storedSig = loadCronSignatures()[workflow.id];
  const cronsExist = await workflowCronsExist(workflow.id);

  // Fast path: crons are present and spec is unchanged — nothing to do
  if (cronsExist && storedSig === currentSig) return;

  // Preflight: verify cron tool is accessible before attempting to create jobs
  const preflight = await checkCronToolAvailable();
  if (!preflight.ok) {
    throw new Error(preflight.error!);
  }

  // If stale crons exist (spec drifted or no stored sig yet), remove them first
  if (cronsExist) {
    await removeAgentCrons(workflow.id);
  }

  await setupAgentCrons(workflow);
  saveCronSignature(workflow.id, currentSig);
}

/**
 * Tear down crons for a workflow when a run ends.
 *
 * DISABLED: Installed workflow crons must persist even when no active runs
 * exist — they're needed to pick up new work when runs are started.
 * Cron lifecycle is managed by the installer (install/uninstall), not
 * by run completion. See checkOrphanedCrons() for cleanup of truly
 * orphaned crons from uninstalled workflows.
 */
export async function teardownWorkflowCronsIfIdle(_workflowId: string): Promise<void> {
  // no-op — crons persist until workflow is uninstalled
  return;
}
