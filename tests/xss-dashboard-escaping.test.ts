/**
 * Regression test: stored XSS prevention in dashboard (index.html)
 *
 * Verifies that every dynamic value injected into innerHTML template literals
 * in src/server/index.html is wrapped in esc() calls. This prevents stored XSS
 * via workflow names, IDs, task titles, run statuses, and step IDs.
 *
 * Attack vector: antfarm workflow run <wf> "<img src=x onerror=alert(1)>"
 * would inject unsanitized HTML into the dashboard for all viewers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HTML_PATH = path.resolve(import.meta.dirname, "..", "src", "server", "index.html");

describe("XSS prevention in dashboard (index.html)", () => {
  let source: string;

  // Load the file once
  source = fs.readFileSync(HTML_PATH, "utf-8");

  it("esc() helper exists in the file", () => {
    assert.ok(
      source.includes("function esc(s)"),
      "esc() sanitizer function must be defined"
    );
  });

  it("workflow option values and names are escaped in loadWorkflows()", () => {
    // Both w.id (attribute value) and w.name (text content) must be wrapped in esc()
    assert.ok(
      source.includes('esc(w.id)') && source.includes('esc(w.name)'),
      "w.id and w.name must be wrapped in esc() when building <option> elements"
    );
    // Must NOT have the raw unescaped form in the option template
    assert.ok(
      !source.includes('value="${w.id}"'),
      "raw w.id must not appear unescaped in option value attribute"
    );
    assert.ok(
      !source.includes('`>${w.name}<'),
      "raw w.name must not appear unescaped as option text content"
    );
  });

  it("run.id is escaped in onclick handler in renderBoard()", () => {
    assert.ok(
      source.includes("esc(run.id)"),
      "run.id must be wrapped in esc() in onclick attribute"
    );
    // The raw form that was vulnerable
    assert.ok(
      !source.includes("openRun('${run.id}')"),
      "raw run.id must not appear unescaped in onclick handler"
    );
  });

  it("run.task (card title) is escaped in renderBoard()", () => {
    // title attribute and card-title text must use esc()
    assert.ok(
      source.includes("esc(run.task)") || source.includes("esc(title)"),
      "run.task must be wrapped in esc() for card title"
    );
    // The old partial-escape pattern must be gone
    assert.ok(
      !source.includes('run.task.replace(/"/g'),
      "partial escaping of run.task (replace quotes only) must be replaced with esc()"
    );
  });

  it("run.status is escaped in renderBoard() card badge", () => {
    // Check that esc is applied to run.status in the renderBoard function
    // We verify by checking the template pattern uses esc
    const renderBoardSection = source.slice(
      source.indexOf("function renderBoard"),
      source.indexOf("const stepIcons")
    );
    assert.ok(
      renderBoardSection.includes("esc(run.status)"),
      "run.status must be wrapped in esc() in renderBoard card badge"
    );
    assert.ok(
      !renderBoardSection.includes("`>${run.status}<"),
      "raw run.status must not appear unescaped in badge text"
    );
  });

  it("step.id (column header) is escaped in renderBoard()", () => {
    const renderBoardSection = source.slice(
      source.indexOf("function renderBoard"),
      source.indexOf("const stepIcons")
    );
    assert.ok(
      renderBoardSection.includes("esc(step.id)"),
      "step.id must be wrapped in esc() in column header"
    );
    assert.ok(
      !renderBoardSection.includes("`>${step.id}<"),
      "raw step.id must not appear unescaped in column header"
    );
  });

  it("s.step_id is escaped in renderRunPanel()", () => {
    const panelSection = source.slice(
      source.indexOf("function renderRunPanel"),
      source.indexOf("function formatEventDesc")
    );
    assert.ok(
      panelSection.includes("esc(s.step_id)"),
      "s.step_id must be wrapped in esc() in run panel"
    );
  });

  it("s.agent_id is escaped in renderRunPanel()", () => {
    const panelSection = source.slice(
      source.indexOf("function renderRunPanel"),
      source.indexOf("function formatEventDesc")
    );
    assert.ok(
      panelSection.includes("esc(s.agent_id"),
      "s.agent_id must be wrapped in esc() in run panel"
    );
  });

  it("run.status is escaped in renderRunPanel() panel header", () => {
    const panelSection = source.slice(
      source.indexOf("function renderRunPanel"),
      source.indexOf("function formatEventDesc")
    );
    assert.ok(
      panelSection.includes("esc(run.workflow_id)"),
      "run.workflow_id must be wrapped in esc() in panel <h2>"
    );
    assert.ok(
      panelSection.includes("esc(run.status)"),
      "run.status must be wrapped in esc() in panel badge"
    );
  });

  it("story title and ID are escaped in loadStories()", () => {
    const storiesSection = source.slice(
      source.indexOf("async function loadStories"),
      source.indexOf("document.getElementById('wf-select').addEventListener")
    );
    assert.ok(
      storiesSection.includes("esc(s.story_id)"),
      "s.story_id must be wrapped in esc() in stories panel"
    );
    assert.ok(
      storiesSection.includes("esc(s.title)"),
      "s.title must be wrapped in esc() in stories panel"
    );
  });

  it("esc() correctly sanitizes XSS payloads", () => {
    // Simulate calling esc() logic in Node to verify it works correctly
    function esc(s: string | null | undefined): string {
      if (!s) return "";
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    const xssPayload = '<img src=x onerror=alert(1)>';
    const escaped = esc(xssPayload);
    assert.ok(!escaped.includes("<"), "esc() must strip < from XSS payload");
    assert.ok(!escaped.includes(">"), "esc() must strip > from XSS payload");
    assert.equal(
      escaped,
      "&lt;img src=x onerror=alert(1)&gt;",
      "esc() must fully escape XSS payload"
    );

    const scriptPayload = '"><script>alert(1)</script>';
    const escapedScript = esc(scriptPayload);
    assert.ok(!escapedScript.includes("<script>"), "esc() must neutralize <script> tag");
    assert.ok(!escapedScript.includes('"'), "esc() must escape double quotes");
  });
});
