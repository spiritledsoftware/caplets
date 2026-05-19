import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createHttpServeApp", () => {
  it("serves root info and health without auth", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const root = await app.request("http://127.0.0.1:5387/");
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({
      name: "caplets",
      transport: "http",
      mcp: "/mcp",
      health: "/healthz",
      auth: { type: "basic", enabled: false },
    });

    const health = await app.request("http://127.0.0.1:5387/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      transport: "http",
      mcpPath: "/mcp",
    });

    await engine.close();
  });

  it("logs basic HTTP requests to stderr", async () => {
    const { engine } = testEngine();
    const logs: string[] = [];
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: (value) => logs.push(value),
    });

    const response = await app.request("http://127.0.0.1:5387/healthz");

    expect(response.status).toBe(200);
    expect(logs.join("")).toContain("<-- GET /healthz");
    const plainLogs = logs.join("").replaceAll(String.fromCharCode(27), "");
    expect(plainLogs).toContain("--> GET /healthz");
    expect(plainLogs).toContain("200");

    await engine.close();
  });

  it("requires Basic Auth on MCP path when password is configured", async () => {
    const { engine } = testEngine();
    const testPassword = ["test", "password"].join("-");
    const app = createHttpServeApp(
      httpOptions({ auth: { enabled: true, user: "caplets", password: testPassword } }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Basic");

    const wrong = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`caplets:not-the-${testPassword}`).toString("base64")}`,
      },
    });
    expect(wrong.status).toBe(401);

    await engine.close();
  });

  it("returns 404 for nested MCP paths", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/mcp/extra");
    expect(response.status).toBe(404);

    await engine.close();
  });

  it("initializes an MCP HTTP session and lists Caplet tools", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const init = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const tools = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(tools.status).toBe(200);
    const body = await tools.text();
    expect(body).toContain("status");

    const deleted = await app.request("http://127.0.0.1:5387/mcp", {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-03-26",
        host: "127.0.0.1:5387",
      },
    });
    expect(deleted.status).toBe(200);

    await engine.close();
  });
});

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/mcp",
    auth: { enabled: false, user: "caplets" },
    warnUnauthenticatedNetwork: false,
    loopback: true,
    ...overrides,
  };
}

function testEngine(): { engine: CapletsEngine } {
  const dir = mkdtempSync(join(tmpdir(), "caplets-http-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status",
          description: "Status API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  return { engine: new CapletsEngine({ configPath, projectConfigPath, watch: false }) };
}
