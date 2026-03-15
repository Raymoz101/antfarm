/**
 * Regression test: package.json must have a "test" script.
 *
 * Bug: The project had no "test" script in package.json, so `npm test`
 * failed with "Missing script: test". This test ensures the script
 * exists and invokes the node:test runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");

describe("package.json test script", () => {
  it("should have a 'test' script defined", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.scripts?.test,
      "package.json must have a 'test' script so that 'npm test' works",
    );
  });

  it("test script should invoke node --test", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.scripts.test.includes("node --test"),
      "test script should use the built-in node:test runner (node --test)",
    );
  });

  it("test script should build before running tests", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const testScript: string = pkg.scripts.test;
    const buildIndex = testScript.indexOf("build");
    const nodeTestIndex = testScript.indexOf("node --test");
    assert.ok(buildIndex !== -1, "test script should include a build step");
    assert.ok(
      buildIndex < nodeTestIndex,
      "build step should come before node --test",
    );
  });
});
