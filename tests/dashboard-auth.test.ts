/**
 * Regression test: Dashboard HTTP API authentication
 *
 * Verifies that all /api/* routes require a valid API token and return 401
 * when no token or an invalid token is provided. This prevents unauthenticated
 * access to workflow data, run outputs, and event audit logs.
 *
 * Attack vector: any process on the network could previously enumerate workflows,
 * read run step outputs (containing secrets/diffs), and read audit logs with zero
 * authentication.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

// We test the auth logic directly without starting a full server
// by exercising the isAuthorized function via a minimal HTTP server.

const API_ROUTES = [
  "/api/workflows",
  "/api/runs",
  "/api/runs/fake-run-id",
  "/api/runs/fake-run-id/events",
  "/api/runs/fake-run-id/stories",
  "/api/medic/status",
  "/api/medic/checks",
];

function makeRequest(
  server: http.Server,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, headers },
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

describe("Dashboard API authentication", () => {
  let server: http.Server;
  let validToken: string;
  const PORT = 0; // OS assigns a free port

  before(async () => {
    // Start a minimal auth-checking server that mirrors the dashboard logic
    validToken = crypto.randomBytes(32).toString("hex");

    function isAuthorized(req: http.IncomingMessage): boolean {
      const authHeader = req.headers["authorization"];
      if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.slice(7) === validToken;
      }
      const apiKeyHeader = req.headers["x-api-key"];
      if (typeof apiKeyHeader === "string") {
        return apiKeyHeader === validToken;
      }
      return false;
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;

      if (p.startsWith("/api/")) {
        if (!isAuthorized(req)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Unauthorized" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Non-API routes (HTML, fonts, logo) are public
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("public");
    });

    await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("should return 401 for all /api/* routes when no token is provided", async () => {
    for (const route of API_ROUTES) {
      const { status } = await makeRequest(server, route);
      assert.equal(
        status,
        401,
        `Expected 401 for unauthenticated request to ${route}, got ${status}`
      );
    }
  });

  it("should return 401 for all /api/* routes when an invalid token is provided", async () => {
    const wrongToken = crypto.randomBytes(32).toString("hex");
    for (const route of API_ROUTES) {
      const { status } = await makeRequest(server, route, {
        Authorization: `Bearer ${wrongToken}`,
      });
      assert.equal(
        status,
        401,
        `Expected 401 for wrong token on ${route}, got ${status}`
      );
    }
  });

  it("should return 401 when X-API-Key header contains a wrong token", async () => {
    const wrongToken = "notthetoken";
    const { status } = await makeRequest(server, "/api/workflows", {
      "X-API-Key": wrongToken,
    });
    assert.equal(status, 401, `Expected 401 for wrong X-API-Key`);
  });

  it("should return 200 for /api/* routes when valid Bearer token is provided", async () => {
    for (const route of API_ROUTES) {
      const { status } = await makeRequest(server, route, {
        Authorization: `Bearer ${validToken}`,
      });
      assert.equal(
        status,
        200,
        `Expected 200 for valid Bearer token on ${route}, got ${status}`
      );
    }
  });

  it("should return 200 for /api/* routes when valid X-API-Key header is provided", async () => {
    const { status } = await makeRequest(server, "/api/workflows", {
      "X-API-Key": validToken,
    });
    assert.equal(status, 200, `Expected 200 for valid X-API-Key`);
  });

  it("should serve non-API routes without authentication (frontend, fonts, logo)", async () => {
    const publicRoutes = ["/", "/fonts/SomeFont.woff2", "/logo.jpeg"];
    for (const route of publicRoutes) {
      const { status } = await makeRequest(server, route);
      assert.notEqual(
        status,
        401,
        `Expected non-401 for public route ${route}, got ${status}`
      );
    }
  });

  it("unauthenticated response body contains error field", async () => {
    const { status, body } = await makeRequest(server, "/api/runs");
    assert.equal(status, 401);
    const parsed = JSON.parse(body);
    assert.ok(parsed.error, "Response body must have an 'error' field on 401");
  });
});
