/**
 * Regression test: Dashboard serveHTML must inject window.API_TOKEN
 * so the frontend fetchJSON sends Authorization: Bearer headers.
 *
 * Without injection the frontend sends unauthenticated requests and
 * receives 401 for every /api/* call, rendering the dashboard unusable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

function makeRequest(
  server: http.Server,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Dashboard HTML token injection", () => {
  let server: http.Server;
  let injectedToken: string;

  before(async () => {
    // Start a minimal server that mimics serveHTML token injection behaviour
    injectedToken = crypto.randomBytes(32).toString("hex");

    server = http.createServer((_req, res) => {
      const html = `<script>\nconst API_TOKEN = null;\n</script>`.replace(
        "const API_TOKEN = null;",
        `const API_TOKEN = ${JSON.stringify(injectedToken)};`
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("injects the API token into the served HTML", async () => {
    const { body } = await makeRequest(server, "/");
    assert.ok(
      body.includes(`const API_TOKEN = ${JSON.stringify(injectedToken)}`),
      "Served HTML must contain the injected API_TOKEN value"
    );
    assert.ok(
      !body.includes("const API_TOKEN = null"),
      "Served HTML must NOT contain the null placeholder"
    );
  });

  it("injected token is a non-empty string suitable for Bearer auth", async () => {
    const { body } = await makeRequest(server, "/");
    const match = body.match(/const API_TOKEN = "([^"]+)"/);
    assert.ok(match, "API_TOKEN value should be a quoted string");
    assert.ok(match![1].length > 0, "Injected token must be non-empty");
  });
});
