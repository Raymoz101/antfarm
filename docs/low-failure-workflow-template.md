# Low-Failure Workflow Template

This template is for Antfarm workflows that should almost never fail in normal operation.
It is built around Antfarm's actual runtime behavior:

- `requires` is enforced at **claim time**
- `produces` is enforced at **complete time**
- abandoned claimed steps are reset by existing recovery logic
- live cron jobs are reconciled against the current workflow prompt/payload
- verify/retry loops work best when feedback is precise and step contracts are explicit

## Recommended shape

1. **analyze / triage**
   - Find the repo, generate the branch name, and classify the work.
   - `produces`: canonical identifiers like `repo`, `branch`, `severity`, `problem_statement`.

2. **validate-input**
   - Normalize the handoff before expensive work starts.
   - Confirm the repo exists, branch name is valid, task is actionable, and the job is not already fixed.
   - Output explicit no-op state when appropriate.
   - Typical outputs: `run_mode`, `repo`, `branch`, `target_repo`, `target_base`, `target_head`, `no_op_reason`.

3. **setup-checkpoint**
   - Idempotent branch/setup/baseline step.
   - Safe to rerun.
   - Outputs: `build_cmd`, `test_cmd`, `baseline`, `ci_notes`.

4. **implement / fix (loop if needed)**
   - Only do expensive work after validate-input and setup-checkpoint pass.
   - Retry feedback should quote the exact missing or incorrect keys.

5. **verify**
   - Reject empty/trivial diffs.
   - Confirm the code matches the claimed changes.
   - Return `STATUS: retry` with concrete issues when work is incomplete.

6. **final-validate**
   - Run the full suite once after all looped work is done.
   - Decide whether the run is `open-pr`, `noop`, or `blocked`.
   - Typical outputs: `pr_action`, `final_result`, `no_op_reason`.

7. **pr-sanity**
   - Check the PR target before opening anything.
   - Confirm the repo/fork/head/base are correct and `gh` has permission.
   - Typical outputs: `pr_action`, `pr_base_repo`, `pr_head_repo`, `pr_permission_status`, `pr_notes`.

8. **pr**
   - Only opens a PR when `pr_action` is `open`.
   - If the run is a no-op or permissions-blocked outcome, return a clear terminal result instead of forcing `gh pr create`.

## Why this reduces failure rate

### 1) Producer/consumer contract drift is caught at the source
Use both:
- `requires` on the consumer step
- `produces` on the producer step

That means:
- missing input is caught **before** a downstream step starts
- missing output is sent back to the **producing** step with the exact missing keys

### 2) Stale generic wrapper output is less likely to win
Antfarm's worker prompts now explicitly tell agents to:
- extract the keys from the claimed step input's `Reply with:` block
- ignore stale `AGENTS.md` examples if they conflict
- avoid generic fallback fields unless the claimed step asks for them

### 3) Claimed-but-abandoned steps recover cleanly
The template keeps expensive work behind explicit checkpoints and uses rerunnable setup/checkpoint steps.
If a worker vanishes after claim:
- single steps are reset to `pending`
- loop stories are retried conservatively
- repeated abandons still fail clearly instead of hanging forever

### 4) PR failures become explicit, not mysterious
A separate `pr-sanity` step avoids wasting the last mile on:
- wrong repo/fork
- wrong base/head
- missing `gh` auth or missing push/create permission

### 5) No-op runs stop cleanly
Not every run should produce code or a PR.
The template explicitly allows outcomes like:
- already fixed
- duplicate report
- no diff required
- permissions-blocked escalation

Instead of forcing fake work, later steps should propagate `pr_action: noop` or `pr_action: blocked` and finish with a clear terminal note.

## When to mark a run as no-op

Use no-op when:
- the bug is already fixed on the target branch
- the requested change produces no code diff after verification
- the report is a duplicate of existing work
- the correct action is documentation / escalation, not a code change

Do **not** create a PR just to satisfy the pipeline. Return a terminal outcome such as:

```text
STATUS: done
PR: none (no-op — already fixed on target branch)
```

## Rollout note for prompt changes

Prompt/model/timeout changes now refresh automatically when workflow crons are reconciled at run start/resume.
If you need to push a prompt change immediately to an already-installed workflow, run:

```bash
antfarm workflow ensure-crons <workflow-id>
```

## Example

See `docs/examples/low-failure-workflow.yml` for a concrete YAML skeleton using these contracts.
