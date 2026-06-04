import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
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
      base: "/",
      mcp: "/mcp",
      control: "/control",
      health: "/healthz",
      auth: { type: "basic", enabled: false },
    });

    const health = await app.request("http://127.0.0.1:5387/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      transport: "http",
      base: "/",
      mcpPath: "/mcp",
      controlPath: "/control",
      healthPath: "/healthz",
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

  it("requires Basic Auth on control path and dispatches authenticated list requests", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const testPassword = ["test", "password"].join("-");
    const app = createHttpServeApp(
      httpOptions({ auth: { enabled: true, user: "caplets", password: testPassword } }),
      engine,
      { writeErr: () => {}, control: context },
    );

    const missing = await app.request("http://127.0.0.1:5387/control", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Basic");

    const listed = await app.request("http://127.0.0.1:5387/control", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`caplets:${testPassword}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ ok: true });

    await engine.close();
  });

  it("exposes authenticated Project Binding status under the control namespace", async () => {
    const { engine } = testEngine();
    const testPassword = ["test", "password"].join("-");
    const app = createHttpServeApp(
      httpOptions({ auth: { enabled: true, user: "caplets", password: testPassword } }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request(
      "http://127.0.0.1:5387/control/project-bindings/bind_123/status",
    );
    expect(missing.status).toBe(401);

    const response = await app.request(
      "http://127.0.0.1:5387/control/project-bindings/bind_123/status",
      {
        headers: {
          authorization: `Basic ${Buffer.from(`caplets:${testPassword}`).toString("base64")}`,
        },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bindingId: "bind_123",
      state: "not_attached",
    });

    await engine.close();
  });

  it("exposes the Project Binding WebSocket upgrade route under a base path", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: () => {},
    });

    const response = await app.request(
      "http://127.0.0.1:5387/caplets/control/project-bindings/connect",
    );

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: "websocket_upgrade_required",
    });

    await engine.close();
  });

  it("mounts service routes under a base path", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: () => {},
    });

    const rootHealth = await app.request("http://127.0.0.1:5387/healthz");
    expect(rootHealth.status).toBe(404);

    const health = await app.request("http://127.0.0.1:5387/caplets/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      base: "/caplets",
      mcpPath: "/caplets/mcp",
      controlPath: "/caplets/control",
      healthPath: "/caplets/healthz",
    });

    await engine.close();
  });

  it("mounts authenticated control dispatch under a base path", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const testPassword = ["test", "password"].join("-");
    const app = createHttpServeApp(
      httpOptions({
        path: "/caplets",
        auth: { enabled: true, user: "caplets", password: testPassword },
      }),
      engine,
      { writeErr: () => {}, control: context },
    );

    const rootControl = await app.request("http://127.0.0.1:5387/control", { method: "POST" });
    expect(rootControl.status).toBe(404);

    const missing = await app.request("http://127.0.0.1:5387/caplets/control", {
      method: "POST",
    });
    expect(missing.status).toBe(401);

    const listed = await app.request("http://127.0.0.1:5387/caplets/control", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`caplets:${testPassword}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ ok: true });

    await engine.close();
  });

  it("returns a structured control error for malformed JSON", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {}, control: context });

    const response = await app.request("http://127.0.0.1:5387/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID", message: expect.stringContaining("JSON") },
    });

    await engine.close();
  });

  it("dispatches auth callback completion under the control path", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const authFlowStore = new RemoteAuthFlowStore();
    authFlowStore.create(
      {
        server: "remote",
        authorizationUrl: "https://auth.example/authorize",
        complete: async (_callbackUrl: string) => {},
      },
      "flow-1",
    );
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: () => {},
      control: context,
      authFlowStore,
    });

    const response = await app.request(
      "http://127.0.0.1:5387/caplets/control/auth/callback/flow-1?code=abc&state=xyz",
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("authentication complete");

    await engine.close();
  });

  it("hides auth callback failure details from unauthenticated browsers", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const authFlowStore = new RemoteAuthFlowStore();
    authFlowStore.create(
      {
        server: "remote",
        authorizationUrl: "https://auth.example/authorize",
        complete: async () => {
          throw new Error("internal token exchange failure");
        },
      },
      "flow-1",
    );
    const logs: string[] = [];
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: (value) => logs.push(value),
      control: context,
      authFlowStore,
    });

    const response = await app.request(
      "http://127.0.0.1:5387/caplets/control/auth/callback/flow-1?code=abc&state=xyz",
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe(
      "Caplets authentication failed. Check server logs for details.",
    );
    expect(logs.join("")).toContain("internal token exchange failure");

    await engine.close();
  });

  it("uses the mounted control path when auth login starts under a base path containing control", async () => {
    const context = testContext({ oauth: true });
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions({ path: "/control-api" }), engine, {
      writeErr: () => {},
      control: context,
    });

    const response = await app.request("http://127.0.0.1:5387/control-api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    const result = (body as { result: { authorizationUrl: string } }).result;
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:5387\/control-api\/control\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("uses CAPLETS_SERVER_URL public scheme for remote auth callback URLs", async () => {
    const context = testContext({ oauth: true });
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(
      httpOptions({ path: "/caplets", publicOrigin: "https://caplets.example.com" }),
      engine,
      {
        writeErr: () => {},
        control: context,
      },
    );

    const response = await app.request("http://127.0.0.1:5387/caplets/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    const result = (body as { result: { authorizationUrl: string } }).result;
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
      /^https:\/\/caplets\.example\.com\/caplets\/control\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("ignores forwarded host and proto for remote auth callback URLs by default", async () => {
    const context = testContext({ oauth: true });
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: () => {},
      control: context,
    });

    const response = await app.request("http://10.0.0.5:5387/caplets/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "caplets.example.com",
      },
      body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    const result = (body as { result: { authorizationUrl: string } }).result;
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/10\.0\.0\.5:5387\/caplets\/control\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("uses forwarded host and proto for remote auth callback URLs when proxy trust is enabled", async () => {
    const context = testContext({ oauth: true });
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions({ path: "/caplets", trustProxy: true }), engine, {
      writeErr: () => {},
      control: context,
    });

    const response = await app.request("http://10.0.0.5:5387/caplets/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "caplets.example.com",
      },
      body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    const result = (body as { result: { authorizationUrl: string } }).result;
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
      /^https:\/\/caplets\.example\.com\/caplets\/control\/auth\/callback\//u,
    );

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
    path: "/",
    publicOrigin: undefined,
    auth: { enabled: false, user: "caplets" },
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    ...overrides,
  };
}

function testEngine(): { engine: CapletsEngine } {
  const context = testContext();
  return {
    engine: new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    }),
  };
}

function testContext(options: { oauth?: boolean } = {}): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
} {
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
    JSON.stringify(
      options.oauth
        ? {
            httpApis: {
              remote: {
                name: "Remote",
                description: "Remote OAuth API.",
                baseUrl: "http://127.0.0.1:1",
                auth: {
                  type: "oauth2",
                  clientId: "client",
                  authorizationUrl: "https://auth.example/authorize",
                  tokenUrl: "https://auth.example/token",
                },
                actions: { check: { method: "GET", path: "/check" } },
              },
            },
          }
        : {
            httpApis: {
              status: {
                name: "Status",
                description: "Status API.",
                baseUrl: "http://127.0.0.1:1",
                auth: { type: "none" },
                actions: { check: { method: "GET", path: "/check" } },
              },
            },
          },
    ),
  );
  return { configPath, projectConfigPath, projectCapletsRoot: projectRoot };
}
