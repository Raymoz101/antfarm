import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";

describe("workflow step contract fields", () => {
  it("parses requires and produces arrays from workflow.yml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-contract-fields-"));
    try {
      await fs.mkdir(path.join(tmpDir, "agents", "worker"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "agents", "worker", "AGENTS.md"), "# Worker");

      await fs.writeFile(
        path.join(tmpDir, "workflow.yml"),
        `id: contract-test\nname: Contract Test\nversion: 1\nagents:\n  - id: worker\n    workspace:\n      baseDir: agents/worker\n      files:\n        AGENTS.md: agents/worker/AGENTS.md\nsteps:\n  - id: validate\n    agent: worker\n    input: |\n      TASK: {{task}}\n      REPO: {{repo}}\n      Reply with:\n      STATUS: done\n      RESULT: ok\n    expects: "STATUS: done"\n    requires: [task, repo, branch]\n    produces: [status, result]\n`
      );

      const spec = await loadWorkflowSpec(tmpDir);
      assert.equal(spec.steps.length, 1);
      assert.deepEqual(spec.steps[0].requires, ["task", "repo", "branch"]);
      assert.deepEqual(spec.steps[0].produces, ["status", "result"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
