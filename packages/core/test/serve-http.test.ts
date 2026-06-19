import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
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
      versions: [
        {
          version: 1,
          path: "/v1",
          links: {
            mcp: "/v1/mcp",
            admin: "/v1/admin",
            attachManifest: "/v1/attach/manifest",
            attachEvents: "/v1/attach/events",
            attachInvoke: "/v1/attach/invoke",
            health: "/v1/healthz",
          },
        },
      ],
      auth: { type: "development_unauthenticated" },
    });

    const v1 = await app.request("http://127.0.0.1:5387/v1");
    expect(v1.status).toBe(200);
    await expect(v1.json()).resolves.toMatchObject({
      version: 1,
      links: {
        mcp: "/v1/mcp",
        admin: "/v1/admin",
        attachManifest: "/v1/attach/manifest",
        attachEvents: "/v1/attach/events",
        attachInvoke: "/v1/attach/invoke",
        health: "/v1/healthz",
      },
    });

    const health = await app.request("http://127.0.0.1:5387/v1/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
    });

    await engine.close();
  });

  it("logs basic HTTP requests to stderr", async () => {
    const { engine } = testEngine();
    const logs: string[] = [];
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: (value) => logs.push(value),
    });

    const response = await app.request("http://127.0.0.1:5387/v1/healthz");

    expect(response.status).toBe(200);
    expect(logs.join("")).toContain("<-- GET /v1/healthz");
    const plainLogs = logs.join("").replaceAll(String.fromCharCode(27), "");
    expect(plainLogs).toContain("--> GET /v1/healthz");
    expect(plainLogs).toContain("200");

    await engine.close();
  });

  it("rejects Basic Auth on MCP path when remote credentials are required", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        remoteCredentialStateDir: tempDir("caplets-http-remote-credentials-"),
      }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/v1/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    const wrong = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("caplets:password").toString("base64")}`,
      },
    });
    expect(wrong.status).toBe(401);

    await engine.close();
  });

  it("uses issued remote credentials for protected self-hosted route classes", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const root = await app.request("http://127.0.0.1:5387/");
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({
      auth: { type: "remote_credentials" },
    });

    const basic = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: {
        authorization: `Basic ${Buffer.from("caplets:password").toString("base64")}`,
      },
    });
    expect(basic.status).toBe(401);
    expect(basic.headers.get("www-authenticate")).toBeNull();

    const attach = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(200);

    const project = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/bind_123/status",
      { headers: { authorization: `Bearer ${credentials.accessToken}` } },
    );
    expect(project.status).toBe(200);

    const control = await app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(control.status).toBe(200);
    await expect(control.json()).resolves.toMatchObject({ ok: true });

    const mcp = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
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
    expect(mcp.status).toBe(200);

    await engine.close();
  });

  it("exchanges Pairing Codes and rotates refresh credentials without accepting the copied code", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const issued = store.createPairingCode({ hostUrl: "http://127.0.0.1:5387/" });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const exchanged = await app.request("http://127.0.0.1:5387/v1/remote/pairing/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code, clientLabel: "Test Client" }),
    });
    expect(exchanged.status).toBe(200);
    const credentials = (await exchanged.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(credentials.accessToken).not.toBe(issued.code);
    expect(credentials.refreshToken).not.toBe(issued.code);

    const copiedCodeAttach = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${issued.code}` },
    });
    expect(copiedCodeAttach.status).toBe(401);

    const refreshed = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const nextCredentials = (await refreshed.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(nextCredentials.refreshToken).not.toBe(credentials.refreshToken);

    const stale = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    expect(stale.status).toBe(401);

    const revokedByReplay = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${nextCredentials.accessToken}` },
    });
    expect(revokedByReplay.status).toBe(401);

    await engine.close();
  });

  it("requires explicit public origin before trusted proxy headers select remote credential audiences", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const issued = store.createPairingCode({ hostUrl: "https://caplets.example.com/" });
    const app = createHttpServeApp(
      httpOptions({ auth: { type: "remote_credentials" }, trustProxy: true }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
      },
    );

    const exchanged = await app.request("http://10.0.0.5:5387/v1/remote/pairing/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "caplets.example.com",
      },
      body: JSON.stringify({ code: issued.code }),
    });

    expect(exchanged.status).toBe(400);
    await expect(exchanged.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });

    const refreshed = await app.request("http://10.0.0.5:5387/v1/remote/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "caplets.example.com",
      },
      body: JSON.stringify({ refreshToken: "unused-refresh-token" }),
    });
    expect(refreshed.status).toBe(400);
    await expect(refreshed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });
    await engine.close();
  });

  it("uses explicit public origin for remote credential audiences behind trusted proxies", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const issued = store.createPairingCode({ hostUrl: "https://caplets.example.com/" });
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        publicOrigin: "https://caplets.example.com",
        trustProxy: true,
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
      },
    );

    const exchanged = await app.request("http://10.0.0.5:5387/v1/remote/pairing/exchange", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.com",
      },
      body: JSON.stringify({ code: issued.code }),
    });
    expect(exchanged.status).toBe(200);
    const credentials = (await exchanged.json()) as { accessToken: string; refreshToken: string };

    const refreshed = await app.request("http://10.0.0.5:5387/v1/remote/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.com",
      },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const nextCredentials = (await refreshed.json()) as { accessToken: string };

    const attach = await app.request("http://10.0.0.5:5387/v1/attach/manifest", {
      headers: {
        authorization: `Bearer ${nextCredentials.accessToken}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.com",
      },
    });
    expect(attach.status).toBe(200);
    await engine.close();
  });

  it("rejects Basic Auth on attach manifest when remote credentials are required", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        remoteCredentialStateDir: tempDir("caplets-http-remote-credentials-"),
      }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    await engine.close();
  });

  it("requires remote credentials on control path and dispatches authenticated list requests", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });

    const missing = await app.request("http://127.0.0.1:5387/v1/admin", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    const listed = await app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ ok: true });

    await engine.close();
  });

  it("exposes authenticated Project Binding status under the attach namespace", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const missing = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/bind_123/status",
    );
    expect(missing.status).toBe(401);

    const response = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/bind_123/status",
      {
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
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
      "http://127.0.0.1:5387/caplets/v1/attach/project-bindings/connect",
    );

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: "websocket_upgrade_required",
    });

    await engine.close();
  });

  it("mounts Project Binding session routes under the attach namespace", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const session = await app.request("http://127.0.0.1:5387/v1/attach/project-bindings/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: "/repo" }),
    });
    expect(session.status).toBe(201);
    const created = (await session.json()) as {
      binding: { bindingId: string };
      sessionId: string;
    };
    expect(created.binding.bindingId).toEqual(expect.any(String));
    expect(created.sessionId).toEqual(expect.any(String));

    const heartbeat = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({ ok: true });

    const ended = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/session`,
      { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toMatchObject({ ok: true });

    await engine.close();
  });

  it("mounts service routes under a base path", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
      writeErr: () => {},
    });

    const rootHealth = await app.request("http://127.0.0.1:5387/healthz");
    expect(rootHealth.status).toBe(404);

    const health = await app.request("http://127.0.0.1:5387/caplets/v1/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    await engine.close();
  });

  it("mounts authenticated control dispatch under a base path", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "http://127.0.0.1:5387/caplets");
    const app = createHttpServeApp(
      httpOptions({ path: "/caplets", auth: { type: "remote_credentials" } }),
      engine,
      { writeErr: () => {}, control: context, remoteCredentialStore: store },
    );

    const rootControl = await app.request("http://127.0.0.1:5387/control", { method: "POST" });
    expect(rootControl.status).toBe(404);

    const missing = await app.request("http://127.0.0.1:5387/caplets/v1/admin", {
      method: "POST",
    });
    expect(missing.status).toBe(401);

    const listed = await app.request("http://127.0.0.1:5387/caplets/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
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

    const response = await app.request("http://127.0.0.1:5387/v1/admin", {
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
      "http://127.0.0.1:5387/caplets/v1/admin/auth/callback/flow-1?code=abc&state=xyz",
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
      "http://127.0.0.1:5387/caplets/v1/admin/auth/callback/flow-1?code=abc&state=xyz",
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

    const response = await app.request("http://127.0.0.1:5387/control-api/v1/admin", {
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
      /^http:\/\/127\.0\.0\.1:5387\/control-api\/v1\/admin\/auth\/callback\//u,
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

    const response = await app.request("http://127.0.0.1:5387/caplets/v1/admin", {
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
      /^https:\/\/caplets\.example\.com\/caplets\/v1\/admin\/auth\/callback\//u,
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

    const response = await app.request("http://10.0.0.5:5387/caplets/v1/admin", {
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
      /^http:\/\/10\.0\.0\.5:5387\/caplets\/v1\/admin\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("ignores spoofed host headers for remote auth callback URLs by default", async () => {
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

    const response = await app.request("http://10.0.0.5:5387/caplets/v1/admin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "attacker.example.com",
      },
      body: JSON.stringify({ command: "auth_login_start", arguments: { server: "remote" } }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    const result = (body as { result: { authorizationUrl: string } }).result;
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/10\.0\.0\.5:5387\/caplets\/v1\/admin\/auth\/callback\//u,
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

    const response = await app.request("http://10.0.0.5:5387/caplets/v1/admin", {
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
      /^https:\/\/caplets\.example\.com\/caplets\/v1\/admin\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("returns 404 for nested MCP paths", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/v1/mcp/extra");
    expect(response.status).toBe(404);

    await engine.close();
  });

  it("initializes an MCP HTTP session and lists Caplet tools", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const tools = await listMcpTools(app, "/v1/mcp");

    expect(tools.map((tool) => tool.name)).toEqual(["code_mode"]);

    await engine.close();
  });

  it("returns an attach manifest instead of serving MCP on attach", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifestResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json();

    expect(manifest).toMatchObject({
      version: 1,
      revision: expect.any(String),
      generatedAt: expect.any(String),
      caplets: [],
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      completions: [],
      codeModeCaplets: [
        expect.objectContaining({
          stableId: "code_mode:status",
          kind: "caplet",
          capletId: "status",
          name: "Status",
          shadowing: "forbid",
        }),
      ],
      diagnostics: [],
    });

    await engine.close();
  });

  it("does not advertise attach routes when an HTTP app bridges an attached session", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      exposeAttach: false,
      sessionFactory: () => ({
        connect: async () => undefined,
        close: async () => undefined,
      }),
    });

    const discovery = (await (await app.request("http://127.0.0.1:5387/v1")).json()) as {
      links: Record<string, string>;
    };
    expect(discovery.links).not.toHaveProperty("attachManifest");
    expect(await app.request("http://127.0.0.1:5387/v1/attach/manifest")).toHaveProperty(
      "status",
      404,
    );

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("invokes exported attach entries by revision-scoped export ID", async () => {
    const { engine } = testEngine({
      options: { exposure: "progressive" },
    });
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifest = (await (
      await app.request("http://127.0.0.1:5387/v1/attach/manifest")
    ).json()) as {
      revision: string;
      caplets: Array<{ exportId: string; kind: string; stableId: string; schemaHash: string }>;
    };
    expect(manifest.caplets).toHaveLength(1);

    const invoked = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: manifest.revision,
        kind: "caplet",
        exportId: manifest.caplets[0]!.exportId,
        input: { operation: "inspect" },
      }),
    });

    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toMatchObject({
      ok: true,
      data: {
        structuredContent: {
          result: expect.objectContaining({ id: "status" }),
        },
      },
    });

    const stale = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: "old",
        kind: "caplet",
        exportId: manifest.caplets[0]!.exportId,
        input: { operation: "inspect" },
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
    });

    const malformed = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"revision":',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });

    await engine.close();
  });

  it("recomputes attach projections before invokes so stale downstream surfaces are rejected", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
    };
    let downstreamToolName = "read";
    const engine = {
      onReload: () => () => undefined,
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [],
        codeModeCaplets: [],
        directTools: [
          {
            caplet,
            downstreamName: downstreamToolName,
            name: `docs__${downstreamToolName}`,
            tool: { name: downstreamToolName, inputSchema: { type: "object" } },
          },
        ],
        directResources: [],
        directResourceTemplates: [],
        directPrompts: [],
        hiddenCaplets: [],
      }),
      execute: async () => ({ called: true }),
    } as unknown as CapletsEngine;
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifest = (await (
      await app.request("http://127.0.0.1:5387/v1/attach/manifest")
    ).json()) as {
      revision: string;
      tools: Array<{ exportId: string; kind: string }>;
    };
    downstreamToolName = "search";

    const stale = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: manifest.revision,
        kind: "tool",
        exportId: manifest.tools[0]!.exportId,
        input: {},
      }),
    });

    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
    });
  });

  it("serves attach events as an unbuffered keep-alive SSE stream", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/events");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
    await engine.close();
  });

  it("closes active attach event streams during app shutdown", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/events");
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    await app.closeCapletsSessions();

    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await engine.close();
  });

  it("rejects unauthenticated attach requests through public origin host by default", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({ publicOrigin: "https://caplets.tail7ff085.ts.net" }),
      engine,
      { writeErr: () => {} },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { host: "caplets.tail7ff085.ts.net" },
    });

    expect(response.status).toBe(403);
    await engine.close();
  });

  it("allows authenticated attach requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: {
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await engine.close();
  });

  it("does not expose unversioned service routes", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    for (const path of ["/mcp", "/control", "/attach", "/healthz"]) {
      const response = await app.request(`http://127.0.0.1:5387${path}`, { method: "POST" });
      expect(response.status).toBe(404);
    }

    await engine.close();
  });

  it("rejects unauthenticated MCP requests through public origin host by default", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({ publicOrigin: "https://caplets.tail7ff085.ts.net" }),
      engine,
      { writeErr: () => {} },
    );

    const init = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
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

    expect(init.status).toBe(403);

    await engine.close();
  });

  it("allows authenticated MCP requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const init = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
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
    expect(init.headers.get("mcp-session-id")).toBeTruthy();

    await engine.close();
  });

  it("allows explicitly unauthenticated MCP requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        allowUnauthenticatedHttp: true,
      }),
      engine,
      { writeErr: () => {} },
    );

    const init = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
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
    expect(init.headers.get("mcp-session-id")).toBeTruthy();

    await engine.close();
  });
});

async function listMcpTools(
  app: ReturnType<typeof createHttpServeApp>,
  path: "/v1/mcp",
): Promise<Array<{ name: string; inputSchema?: unknown }>> {
  const init = await app.request(`http://127.0.0.1:5387${path}`, {
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

  await app.request(`http://127.0.0.1:5387${path}`, {
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

  const response = await app.request(`http://127.0.0.1:5387${path}`, {
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

  expect(response.status).toBe(200);
  const payload = parseMcpResponse(await response.text());

  const deleted = await app.request(`http://127.0.0.1:5387${path}`, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2025-03-26",
      host: "127.0.0.1:5387",
    },
  });
  expect(deleted.status).toBe(200);

  return payload.result.tools;
}

function parseMcpResponse(text: string): {
  result: { tools: Array<{ name: string; inputSchema?: unknown }> };
} {
  if (text.trimStart().startsWith("{")) {
    return JSON.parse(text) as {
      result: { tools: Array<{ name: string; inputSchema?: unknown }> };
    };
  }
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`Could not parse MCP response: ${text}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim()) as {
    result: { tools: Array<{ name: string; inputSchema?: unknown }> };
  };
}

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    publicOrigin: undefined,
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    ...overrides,
  };
}

function remoteCredentialStore(): RemoteServerCredentialStore {
  return new RemoteServerCredentialStore({ dir: tempDir("caplets-http-remote-credentials-") });
}

function pairedClient(
  store: RemoteServerCredentialStore,
  hostUrl = "http://127.0.0.1:5387/",
): {
  accessToken: string;
  refreshToken: string;
} {
  const issued = store.createPairingCode({ hostUrl });
  return store.exchangePairingCode({
    hostUrl,
    code: issued.code,
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function testEngine(config: Record<string, unknown> = {}): { engine: CapletsEngine } {
  const context = testContext(config);
  return {
    engine: new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    }),
  };
}

function testContext(options: { oauth?: boolean } & Record<string, unknown> = {}): {
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
            ...(options.options ? { options: options.options } : {}),
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
            ...(options.options ? { options: options.options } : {}),
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
