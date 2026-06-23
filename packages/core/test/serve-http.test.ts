import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp } from "../src/serve/http";
import { CAPLETS_ATTACH_SESSION_HEADER, type AttachManifest } from "../src/attach/api";
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

  it("reports remote credential host identity metadata from the public origin", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.example.com",
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: remoteCredentialStore() },
    );

    const root = await app.request("http://127.0.0.1:5387/");
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({
      remote: {
        hostIdentity: "https://caplets.example.com/",
        audience: "https://caplets.example.com/",
      },
      versions: [
        expect.objectContaining({
          remote: {
            hostIdentity: "https://caplets.example.com/",
            audience: "https://caplets.example.com/",
          },
        }),
      ],
    });

    const version = await app.request("http://127.0.0.1:5387/v1");
    expect(version.status).toBe(200);
    await expect(version.json()).resolves.toMatchObject({
      remote: {
        hostIdentity: "https://caplets.example.com/",
        audience: "https://caplets.example.com/",
      },
    });

    await engine.close();
  });

  it("rejects legacy Pairing Code exchange over HTTP", async () => {
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

    expect(exchanged.status).toBe(400);
    await expect(exchanged.json()).resolves.toMatchObject({
      error: { code: "REQUEST_INVALID", message: expect.stringContaining("no longer supported") },
    });

    await engine.close();
  });

  it("does not collapse HTTP pending login starts into an eight-flow empty-source quota", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    for (let index = 0; index < 9; index += 1) {
      const started = await app.request("http://127.0.0.1:5387/v1/remote/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientLabel: `Client ${index}` }),
      });
      expect(started.status).toBe(200);
    }

    await engine.close();
  });

  it("applies pending login quotas per trusted forwarded source", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
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
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    };

    for (let index = 0; index < 8; index += 1) {
      const started = await app.request("http://10.0.0.5:5387/v1/remote/login/start", {
        method: "POST",
        headers,
        body: JSON.stringify({ clientLabel: `Client ${index}` }),
      });
      expect(started.status).toBe(200);
    }

    const blocked = await app.request("http://10.0.0.5:5387/v1/remote/login/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ clientLabel: "Blocked client" }),
    });
    expect(blocked.status).toBe(401);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { message: "Too many active pending logins for this source." },
    });

    const otherSource = await app.request("http://10.0.0.5:5387/v1/remote/login/start", {
      method: "POST",
      headers: { ...headers, "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ clientLabel: "Other source" }),
    });
    expect(otherSource.status).toBe(200);

    await engine.close();
  });

  it("applies loopback host protection before pending login starts mutate state", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const started = await app.request("http://127.0.0.1:5387/v1/remote/login/start", {
      method: "POST",
      headers: { host: "attacker.example.com", "content-type": "application/json" },
      body: JSON.stringify({ clientLabel: "Blocked client" }),
    });

    expect(started.status).toBe(403);
    expect(store.listPendingLogins()).toHaveLength(0);
    await engine.close();
  });

  it("starts, polls, and completes pending remote login over HTTP without remote approval routes", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const started = await app.request("http://127.0.0.1:5387/v1/remote/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientLabel: "Test Client",
        clientFingerprint: "fp_test",
      }),
    });
    expect(started.status).toBe(200);
    const pending = (await started.json()) as {
      flowId: string;
      operatorCode: string;
      pendingRefreshSecret: string;
      pendingCompletionSecret: string;
      codeExpiresAt: string;
      flowExpiresAt: string;
      intervalSeconds: number;
    };
    expect(pending.operatorCode).toMatch(/^cap_login_/u);
    expect(pending.pendingRefreshSecret).toMatch(/^cap_pending_refresh_/u);
    expect(pending.pendingCompletionSecret).toMatch(/^cap_pending_complete_/u);

    const waiting = await app.request("http://127.0.0.1:5387/v1/remote/login/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(waiting.status).toBe(200);
    await expect(waiting.json()).resolves.toMatchObject({ status: "pending" });

    expect(await app.request("http://127.0.0.1:5387/v1/remote/login/approve")).toMatchObject({
      status: 404,
    });
    store.approvePendingLogin({ operatorCode: pending.operatorCode });

    const approved = await app.request("http://127.0.0.1:5387/v1/remote/login/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ status: "approved" });

    const completed = await app.request("http://127.0.0.1:5387/v1/remote/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(completed.status).toBe(200);
    const credentials = (await completed.json()) as {
      accessToken: string;
      refreshToken: string;
      clientId: string;
    };
    expect(credentials.accessToken).not.toBe(pending.pendingRefreshSecret);
    expect(credentials.refreshToken).not.toBe(pending.pendingCompletionSecret);

    const attach = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(200);

    await engine.close();
  });

  it("returns a retryable status when remote credential refresh state is unavailable", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: {
        refreshClientCredentials: () => {
          throw new CapletsError("SERVER_UNAVAILABLE", "Remote credential state is locked.");
        },
      } as unknown as RemoteServerCredentialStore,
    });

    const response = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SERVER_UNAVAILABLE" },
    });

    await engine.close();
  });

  it("returns a structured revoked status for stale remote credential refreshes", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: {
        refreshClientCredentials: () => {
          throw new CapletsError(
            "REMOTE_CREDENTIALS_REVOKED",
            "Remote refresh credential is stale.",
          );
        },
      } as unknown as RemoteServerCredentialStore,
    });

    const response = await app.request("http://127.0.0.1:5387/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REMOTE_CREDENTIALS_REVOKED" },
    });

    await engine.close();
  });

  it("revokes the authenticated self-hosted remote client", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const revoked = await app.request("http://127.0.0.1:5387/v1/remote/client", {
      method: "DELETE",
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });

    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      revoked: true,
      clientId: credentials.clientId,
    });
    const attach = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(401);

    await engine.close();
  });

  it("requires explicit public origin before trusted proxy headers select remote credential audiences", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    try {
      expect(() =>
        createHttpServeApp(
          httpOptions({ auth: { type: "remote_credentials" }, trustProxy: true }),
          engine,
          {
            writeErr: () => {},
            remoteCredentialStore: store,
          },
        ),
      ).toThrow(
        expect.objectContaining({
          code: "REQUEST_INVALID",
          message: "Remote credential auth with --trust-proxy requires CAPLETS_SERVER_URL.",
        }) as CapletsError,
      );
    } finally {
      await engine.close();
    }
  });

  it("uses explicit public origin for remote credential audiences behind trusted proxies", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const issued = store.createPairingCode({ hostUrl: "https://caplets.example.com/" });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com/",
      code: issued.code,
    });
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
    expect(session.status).toBe(501);
    await expect(session.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED_CAPABILITY",
        message: "Self-hosted Project Binding sessions are not implemented by this runtime.",
      },
    });

    const heartbeat = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/binding_123/heartbeat",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(heartbeat.status).toBe(501);
    await expect(heartbeat.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
      binding: { bindingId: "binding_123", state: "not_attached" },
    });

    const ended = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/binding_123/session",
      { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(ended.status).toBe(501);
    await expect(ended.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
      binding: { bindingId: "binding_123", state: "not_attached" },
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

  it("only advertises attach sessions when the session route is mounted", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const discovery = (await (await app.request("http://127.0.0.1:5387/v1")).json()) as {
      links: Record<string, string>;
    };

    expect(discovery.links).toMatchObject({
      attachManifest: "/v1/attach/manifest",
      attachEvents: "/v1/attach/events",
      attachInvoke: "/v1/attach/invoke",
    });
    expect(discovery.links).not.toHaveProperty("attachSessions");

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("routes attach manifest, invoke, and events through an attach session", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const projectConfigPath = join(projectRoot, ".caplets", "config.json");
    const closed: string[] = [];
    let eventListener: (() => void) | undefined;
    const manifest = attachManifest("session-rev", "session-tool");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (metadata) => ({
        manifest: async () => ({
          ...manifest,
          diagnostics: [
            {
              code: "SESSION_METADATA",
              message: JSON.stringify(metadata),
            },
          ],
        }),
        invoke: async (request) => ({ invoked: request.exportId }),
        onManifestChanged: (listener) => {
          eventListener = listener;
          return () => {
            eventListener = undefined;
          };
        },
        close: async () => {
          closed.push(metadata.projectRoot ?? "<none>");
        },
      }),
    });

    const created = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        projectConfigPath,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { sessionId: string };

    const sessionHeaders = { [CAPLETS_ATTACH_SESSION_HEADER]: body.sessionId };
    const manifestResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: sessionHeaders,
    });
    expect(manifestResponse.status).toBe(200);
    await expect(manifestResponse.json()).resolves.toMatchObject({
      revision: "session-rev",
      caplets: [expect.objectContaining({ capletId: "session-tool" })],
      diagnostics: [
        expect.objectContaining({
          code: "SESSION_METADATA",
          message: JSON.stringify({
            projectRoot,
            projectConfigPath,
          }),
        }),
      ],
    });

    const invoked = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        revision: "session-rev",
        kind: "caplet",
        exportId: "session-export",
        input: {},
      }),
    });
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toEqual({
      ok: true,
      data: { invoked: "session-export" },
    });

    const events = await app.request("http://127.0.0.1:5387/v1/attach/events", {
      headers: sessionHeaders,
    });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    eventListener?.();
    const changed = await reader.read();
    expect(new TextDecoder().decode(changed.value)).toContain("session-rev");
    await reader.cancel();

    await app.closeCapletsSessions();
    expect(closed).toEqual([projectRoot]);
    await engine.close();
  });

  it("rejects attach session project config paths outside the project root", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot, projectConfigPath: "/tmp/outside-config.json" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectConfigPath must be <projectRoot>/.caplets/config.json.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project roots that are not directories", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const filePath = join(projectRoot, "not-a-directory");
    writeFileSync(filePath, "content", "utf8");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: filePath }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectRoot must be an existing directory.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project config paths that are not the standard project path", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        projectConfigPath: "other-config.json",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectConfigPath must be <projectRoot>/.caplets/config.json.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project context on non-loopback runtimes", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions({ loopback: false }), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Attach session project context is only accepted by loopback runtimes.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("returns structured errors for unknown attach session headers", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { [CAPLETS_ATTACH_SESSION_HEADER]: "missing-session" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Attach session was not found.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("keeps attach sessions active while events are connected", async () => {
    vi.useFakeTimers();
    const { engine } = testEngine();
    const manifest = attachManifest("session-rev", "session-tool");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => ({
        manifest: async () => manifest,
        invoke: async () => ({ ok: true }),
        onManifestChanged: () => () => undefined,
        close: async () => undefined,
      }),
    });
    try {
      const created = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await created.json()) as { sessionId: string };
      const sessionHeaders = { [CAPLETS_ATTACH_SESSION_HEADER]: body.sessionId };
      const events = await app.request("http://127.0.0.1:5387/v1/attach/events", {
        headers: sessionHeaders,
      });
      const reader = events.body!.getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      const manifestResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
        headers: sessionHeaders,
      });
      expect(manifestResponse.status).toBe(200);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
      await app.closeCapletsSessions();
      await engine.close();
    }
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

function attachManifest(revision: string, capletId: string): AttachManifest {
  return {
    version: 1,
    revision,
    generatedAt: "2026-06-23T00:00:00.000Z",
    caplets: [
      {
        stableId: `progressive:${capletId}`,
        exportId: "session-export",
        kind: "caplet",
        name: capletId,
        title: capletId,
        description: "Session tool.",
        inputSchema: { type: "object" },
        schemaHash: null,
        capletId,
        shadowing: "forbid",
      },
    ],
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    completions: [],
    codeModeCaplets: [],
    diagnostics: [],
  };
}

function remoteCredentialStore(): RemoteServerCredentialStore {
  return new RemoteServerCredentialStore({ dir: tempDir("caplets-http-remote-credentials-") });
}

function pairedClient(
  store: RemoteServerCredentialStore,
  hostUrl = "http://127.0.0.1:5387/",
): {
  clientId: string;
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
