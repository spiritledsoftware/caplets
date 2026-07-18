import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CapletsEngine } from "../src/engine";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import type { CapletsEngineOptions } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import type { ProjectBindingLease } from "../src/project-binding";
import { ProjectBindingWorkspaceStore } from "../src/project-binding/workspaces";
import {
  CAPLETS_STACK_CHAIN_HEADER,
  createHttpServeApp,
  sanitizeRemoteEngineOptions,
} from "../src/serve/http";
import * as serveHttpModule from "../src/serve/http";
import type { HttpAttachSessionFactory, HttpMcpSessionFactory } from "../src/serve/http";
import { CAPLETS_ATTACH_SESSION_HEADER, type AttachManifest } from "../src/attach/api";
import { buildManifestExposureProjection } from "../src/exposure/projection";
import type { HttpServeOptions } from "../src/serve/options";
import { BackendAuthStateStore } from "../src/storage/backend-auth";
import { sqliteSchema } from "../src/storage/schema/sqlite";

const dirs: string[] = [];
const backendAuthDatabases: Array<InstanceType<typeof BetterSqlite3>> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const database of backendAuthDatabases.splice(0)) database.close();
});

it("forces remote artifact paths off after caller engine options", () => {
  const options = sanitizeRemoteEngineOptions({
    artifactDir: "/tmp/caplets-artifacts",
    exposeLocalArtifactPaths: true,
    mediaInlineThresholdBytes: 128,
  });

  expect(options).toMatchObject({
    artifactDir: "/tmp/caplets-artifacts",
    exposeLocalArtifactPaths: false,
    mediaInlineThresholdBytes: 128,
    vaultRecoveryTarget: "remote",
  });
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
      ready: true,
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
    const operatorCredentials = pairedClient(store, "http://127.0.0.1:5387/", "operator");
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
        authorization: `Bearer ${operatorCredentials.accessToken}`,
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

    const operatorAttach = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { authorization: `Bearer ${operatorCredentials.accessToken}` },
    });
    expect(operatorAttach.status).toBe(403);

    const operatorProjectBinding = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/bind_123/status",
      { headers: { authorization: `Bearer ${operatorCredentials.accessToken}` } },
    );
    expect(operatorProjectBinding.status).toBe(403);

    const operatorMcp = await app.request("http://127.0.0.1:5387/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorCredentials.accessToken}`,
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "operator", version: "1.0.0" },
        },
      }),
    });
    expect(operatorMcp.status).toBe(403);
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
      approvalCommand: string;
      pendingRefreshSecret: string;
      pendingCompletionSecret: string;
      codeExpiresAt: string;
      flowExpiresAt: string;
      intervalSeconds: number;
    };
    expect(pending.operatorCode).toMatch(/^cap_login_/u);
    expect(pending.approvalCommand).toContain(
      `caplets remote host approve ${pending.operatorCode}`,
    );
    expect(pending.approvalCommand).toContain(`--state-path ${store.dir}`);
    expect(pending.approvalCommand).toContain("--yes");
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

  it("allows both credential roles to revoke only their own remote client", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const access = pairedClient(store);
    const otherAccess = pairedClient(store);
    const operator = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const otherOperator = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });

    const revokedAccess = await app.request("http://127.0.0.1:5387/v1/remote/client", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: otherAccess.clientId }),
    });
    expect(revokedAccess.status).toBe(200);
    await expect(revokedAccess.json()).resolves.toEqual({
      revoked: true,
      clientId: access.clientId,
    });
    expect(
      await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
        headers: { authorization: `Bearer ${access.accessToken}` },
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
        headers: { authorization: `Bearer ${otherAccess.accessToken}` },
      }),
    ).toHaveProperty("status", 200);

    const revokedOperator = await app.request("http://127.0.0.1:5387/v1/remote/client", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: otherOperator.clientId }),
    });
    expect(revokedOperator.status).toBe(200);
    await expect(revokedOperator.json()).resolves.toEqual({
      revoked: true,
      clientId: operator.clientId,
    });
    expect(
      await app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${operator.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "list", arguments: {} }),
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request("http://127.0.0.1:5387/v1/admin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${otherOperator.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "list", arguments: {} }),
      }),
    ).toHaveProperty("status", 200);

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
    const accessCredentials = pairedClient(store);
    const operatorCredentials = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });

    const missing = await app.request("http://127.0.0.1:5387/v1/admin", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    const denied = await app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessCredentials.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.text()).resolves.toContain("operator role required");

    const listed = await app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorCredentials.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ ok: true });

    await engine.close();
  });

  it("records the validated Operator client for administrative Vault mutations", async () => {
    const context = testContext();
    const authDir = tempDir("caplets-http-admin-vault-auth-");
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const operator = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const app = createHttpServeApp(
      httpOptions({ auth: { type: "remote_credentials" }, remoteCredentialStateDir: store.dir }),
      engine,
      {
        writeErr: () => {},
        control: { ...context, authDir },
        remoteCredentialStore: store,
      },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "vault_set",
        arguments: { name: "GH_TOKEN", value: "administrative_secret" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { key: "GH_TOKEN", present: true },
    });
    expect(
      new DashboardActivityLog({ dir: store.dir }).list({ action: "vault_set" }).entries,
    ).toEqual([expect.objectContaining({ actorClientId: operator.clientId, action: "vault_set" })]);

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
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });

    const session = await app.request("http://127.0.0.1:5387/v1/attach/project-bindings/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
    });
    expect(session.status).toBe(201);
    const created = (await session.json()) as {
      binding: {
        bindingId: string;
        projectFingerprint: string;
        state: string;
        syncState: string;
        serverProjectRoot: string;
      };
      sessionId: string;
    };
    expect(created).toMatchObject({
      binding: {
        projectFingerprint: "sha256_repo",
        state: "attaching",
        syncState: "pending",
        serverProjectRoot: expect.stringContaining(workspaceRoot),
      },
      sessionId: expect.any(String),
    });

    const heartbeat = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: created.sessionId,
          state: "ready",
          syncState: "idle",
        }),
      },
    );
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({
      ok: true,
      binding: { bindingId: created.binding.bindingId, state: "ready", syncState: "idle" },
    });

    const status = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      bindingId: created.binding.bindingId,
      state: "ready",
      syncState: "idle",
    });

    const ended = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/session`,
      { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toMatchObject({
      ok: true,
      binding: { bindingId: created.binding.bindingId, state: "ended", syncState: "not_started" },
    });

    await engine.close();
  });

  it("scopes Project Binding server workspaces by Remote Credential owner", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const first = pairedClient(store);
    const second = pairedClient(store);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });

    async function createSession(accessToken: string): Promise<{
      binding: { projectFingerprint: string; serverProjectRoot: string };
    }> {
      const response = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as {
        binding: { projectFingerprint: string; serverProjectRoot: string };
      };
    }

    const firstSession = await createSession(first.accessToken);
    const secondSession = await createSession(second.accessToken);

    expect(firstSession.binding.projectFingerprint).toBe("sha256_repo");
    expect(secondSession.binding.projectFingerprint).toBe("sha256_repo");
    expect(firstSession.binding.serverProjectRoot).not.toBe(
      secondSession.binding.serverProjectRoot,
    );
    expect(firstSession.binding.serverProjectRoot).toContain(workspaceRoot);
    expect(secondSession.binding.serverProjectRoot).toContain(workspaceRoot);

    await engine.close();
  });

  it("does not retain Project Binding sessions when lease persistence fails", async () => {
    const { engine } = testEngine();
    let attemptedBindingId: string | undefined;
    class FailingWorkspaceStore extends ProjectBindingWorkspaceStore {
      override async writeLease(lease: ProjectBindingLease): Promise<void> {
        attemptedBindingId = lease.bindingId;
        throw new Error("disk full");
      }
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new FailingWorkspaceStore({ root: workspaceRoot }),
    });

    const response = await app.request(
      "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      },
    );

    expect(response.status).toBe(500);
    expect(attemptedBindingId).toBeTruthy();
    const status = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${attemptedBindingId}/status`,
    );
    await expect(status.json()).resolves.toMatchObject({
      bindingId: attemptedBindingId,
      state: "not_attached",
    });

    await engine.close();
  });

  it("prunes an expired active Project Binding restart lease when HTTP starts", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const workspaces = new ProjectBindingWorkspaceStore({
      root: workspaceRoot,
      now: () => now,
      inactiveWorkspaceTtlMs: 0,
    });
    await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-restart-expired",
      projectRoot: "/repo",
      lastActiveAt: now.toISOString(),
    });
    await workspaces.writeLease({
      bindingId: "bind_restart_expired",
      projectFingerprint: "sha256-restart-expired",
      state: "ready",
      active: true,
      updatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
    });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      await withTimeout(
        waitFor(async () => {
          await expect(workspaces.listLeases("sha256-restart-expired")).resolves.toEqual([]);
        }),
        "prune restart lease at HTTP startup",
      );
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("bounds workspace cleanup to one startup-or-prune run while cleanup is pending", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredWorkspaceCleanupStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        workspaces.releaseCleanup.resolve();
        await app.closeCapletsSessions();
        await engine.close();
      };

      expect(workspaces.cleanupCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(workspaces.cleanupCalls).toBe(1);
      workspaces.releaseCleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("expires inactive Project Binding sessions from in-memory lookups", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      await vi.advanceTimersByTimeAsync(60_000);

      const heartbeat = await app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      expect(heartbeat.status).toBe(404);
      const status = await app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`,
      );
      await expect(status.json()).resolves.toMatchObject({
        bindingId: created.binding.bindingId,
        state: "not_attached",
      });

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("terminalizes a post-TTL heartbeat before the next Project Binding prune tick", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      vi.setSystemTime(new Date("2026-06-25T12:01:00.001Z"));

      const heartbeat = await app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      expect(heartbeat.status).toBe(404);
      await vi.advanceTimersByTimeAsync(0);

      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("keeps prune racing a deferred heartbeat terminal rather than reviving its lease", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      workspaces.deferNextWrite();
      const heartbeat = app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      await workspaces.nextWriteStarted;
      await vi.advanceTimersByTimeAsync(60_000);
      workspaces.releaseNextWrite();

      expect((await heartbeat).status).toBe(403);
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
      const status = await app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`,
      );
      await expect(status.json()).resolves.toMatchObject({
        bindingId: created.binding.bindingId,
        state: "not_attached",
      });

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("deduplicates ownerless terminal cleanup while a prune write is pending and retries after failure", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      const statusUrl = `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`;
      workspaces.deferNextWrite();
      workspaces.failNextWrite();
      await vi.advanceTimersByTimeAsync(60_000);
      await workspaces.nextWriteStarted;
      await app.request(statusUrl);
      await app.request(statusUrl);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(workspaces.writeLeases).toHaveLength(1);

      workspaces.releaseNextWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaces.writeLeases).toHaveLength(2);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([]);

      await app.request(statusUrl);
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaces.writeLeases).toHaveLength(3);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          active: false,
          state: "ended",
        }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("bounds concurrent HTTP heartbeats to the in-flight write and the latest pending state", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const heartbeatUrl = `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`;
      workspaces.deferNextWrite();
      const first = app.request(heartbeatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
      });
      await workspaces.nextWriteStarted;
      const pending = [
        app.request(heartbeatUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: created.sessionId,
            state: "offline",
            syncState: "failed",
          }),
        }),
        app.request(heartbeatUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: created.sessionId,
            state: "degraded",
            syncState: "failed",
          }),
        }),
      ];
      await new Promise<void>((resolve) => setImmediate(resolve));
      workspaces.releaseNextWrite();

      expect((await first).status).toBe(200);
      await expect(Promise.all(pending)).resolves.toEqual([
        expect.objectContaining({ status: 200 }),
        expect.objectContaining({ status: 200 }),
      ]);
      expect(workspaces.writeLeases).toHaveLength(3);
      expect(workspaces.writeLeases.at(-1)).toMatchObject({
        bindingId: created.binding.bindingId,
        state: "degraded",
      });
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("makes shutdown terminal when a Project Binding heartbeat write is in flight", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      workspaces.deferNextWrite();
      const heartbeat = app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      await workspaces.nextWriteStarted;
      const closing = app.closeCapletsSessions();
      workspaces.releaseNextWrite();

      expect((await heartbeat).status).toBe(403);
      await closing;
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("does not acknowledge an HTTP Project Binding end when terminal lease persistence fails", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new FailingProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
      };
      workspaces.failNextWrite();

      const ended = await app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
      );
      expect(ended.status).toBe(500);
      await app.closeCapletsSessions();
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("rejects failed shutdown cleanup and lets a later shutdown retry terminal persistence", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new FailingProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
      };
      workspaces.failNextWrite();

      await expect(app.closeCapletsSessions()).rejects.toThrow("terminal lease write failed");
      await app.closeCapletsSessions();
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("terminalizes a staged session lease when shutdown wins creation", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      workspaces.deferNextWrite();
      const creating = app.request("http://127.0.0.1:5387/v1/attach/project-bindings/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      await workspaces.nextWriteStarted;
      const closing = app.closeCapletsSessions();
      workspaces.releaseNextWrite();

      expect((await creating).status).toBe(503);
      await closing;
      const rejectedAfterShutdown = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectRoot: "/repo",
            projectFingerprint: "sha256_after_shutdown",
          }),
        },
      );
      expect(rejectedAfterShutdown.status).toBe(503);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([expect.objectContaining({ active: false, state: "ended" })]);
    } finally {
      await engine.close();
    }
  });

  it("accepts Project Binding WebSocket connections for owned sessions", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string; state: string; syncState: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}&projectFingerprint=sha256_repo`,
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open Project Binding WebSocket");
        await expect(
          withTimeout(nextSocketJson(socket), "receive Project Binding ready"),
        ).resolves.toMatchObject({
          type: "ready",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
          syncState: "pending",
        });
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(
          waitFor(async () => {
            const status = await fetch(
              `${server.origin}/v1/attach/project-bindings/${created.binding.bindingId}/status`,
            );
            const payload = (await status.json()) as { state: string; syncState: string };
            expect(payload).toMatchObject({ state: "ready", syncState: "idle" });
          }),
          "observe Project Binding heartbeat",
        );
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("ends Project Binding sessions when sockets close without an explicit end message", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}&projectFingerprint=sha256_repo`,
      );
      await withTimeout(waitForSocketOpen(socket), "open Project Binding WebSocket");
      await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
      socket.close();

      await withTimeout(
        waitFor(async () => {
          const status = await fetch(
            `${server.origin}/v1/attach/project-bindings/${created.binding.bindingId}/status`,
          );
          await expect(status.json()).resolves.toMatchObject({
            bindingId: created.binding.bindingId,
            state: "not_attached",
          });
        }),
        "observe Project Binding close cleanup",
      );
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("keeps two-socket heartbeat and end races terminal in either ordering", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      for (const heartbeatFirst of [true, false]) {
        const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        });
        const created = (await session.json()) as {
          binding: { bindingId: string };
          sessionId: string;
        };
        const socketUrl =
          `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=` +
          `${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`;
        const first = new WebSocket(socketUrl);
        const second = new WebSocket(socketUrl);
        try {
          await withTimeout(waitForSocketOpen(first), "open first Project Binding socket");
          await withTimeout(waitForSocketOpen(second), "open second Project Binding socket");
          await withTimeout(nextSocketJson(first), "receive first Project Binding ready");
          await withTimeout(nextSocketJson(second), "receive second Project Binding ready");

          const heartbeatSocket = heartbeatFirst ? first : second;
          const endingSocket = heartbeatFirst ? second : first;
          const heartbeatMessages: unknown[] = [];
          heartbeatSocket.on("message", (data) => {
            heartbeatMessages.push(JSON.parse(data.toString()) as unknown);
          });
          const heartbeat = JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          });
          const end = JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          });

          workspaces.deferNextWrite();
          if (heartbeatFirst) {
            heartbeatSocket.send(heartbeat);
            await withTimeout(workspaces.nextWriteStarted, "start deferred first heartbeat");
            const ended = nextSocketJson(endingSocket);
            endingSocket.send(end);
            workspaces.releaseNextWrite();
            await expect(withTimeout(ended, "receive Project Binding end")).resolves.toMatchObject({
              type: "ended",
            });
            const staleClose = waitForSocketClose(heartbeatSocket);
            heartbeatSocket.send(heartbeat);
            await expect(
              withTimeout(staleClose, "close stale first Project Binding socket"),
            ).resolves.toMatchObject({ code: 1008 });
          } else {
            const ended = nextSocketJson(endingSocket);
            endingSocket.send(end);
            await withTimeout(workspaces.nextWriteStarted, "start deferred Project Binding end");
            const staleClose = waitForSocketClose(heartbeatSocket);
            heartbeatSocket.send(heartbeat);
            workspaces.releaseNextWrite();
            await expect(withTimeout(ended, "receive Project Binding end")).resolves.toMatchObject({
              type: "ended",
            });
            await expect(
              withTimeout(staleClose, "close stale second Project Binding socket"),
            ).resolves.toMatchObject({ code: 1008 });
          }

          expect(heartbeatMessages).toEqual([]);
          const status = await app.request(
            `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`,
          );
          await expect(status.json()).resolves.toMatchObject({
            bindingId: created.binding.bindingId,
            state: "not_attached",
          });
          await expect(
            workspaces.listLeases(
              projectBindingWorkspaceFingerprintForTest(
                "development_unauthenticated",
                "sha256_repo",
              ),
            ),
          ).resolves.toContainEqual(
            expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
          );
        } finally {
          first.terminate();
          second.terminate();
        }
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  }, 30_000);

  it("makes a peer socket close terminal against a deferred heartbeat", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socketUrl =
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=` +
        `${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`;
      const heartbeatSocket = new WebSocket(socketUrl);
      const peer = new WebSocket(socketUrl);
      try {
        await withTimeout(waitForSocketOpen(heartbeatSocket), "open heartbeat socket");
        await withTimeout(waitForSocketOpen(peer), "open peer socket");
        await withTimeout(nextSocketJson(heartbeatSocket), "receive heartbeat socket ready");
        await withTimeout(nextSocketJson(peer), "receive peer socket ready");
        workspaces.deferNextWrite();
        heartbeatSocket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start deferred heartbeat");
        const peerClosed = waitForSocketClose(peer);
        peer.close();
        await withTimeout(peerClosed, "close peer socket");
        const firstIoTurn = Promise.withResolvers<void>();
        setImmediate(firstIoTurn.resolve);
        await firstIoTurn.promise;
        const secondIoTurn = Promise.withResolvers<void>();
        setImmediate(secondIoTurn.resolve);
        await secondIoTurn.promise;
        workspaces.releaseNextWrite();

        await withTimeout(
          waitFor(async () => {
            const status = await app.request(
              `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/status`,
            );
            await expect(status.json()).resolves.toMatchObject({
              bindingId: created.binding.bindingId,
              state: "not_attached",
            });
          }),
          "observe peer close terminal cleanup",
        );
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
          ),
        ).resolves.toContainEqual(
          expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
        );
        const staleClose = waitForSocketClose(heartbeatSocket);
        heartbeatSocket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await expect(
          withTimeout(staleClose, "close stale heartbeat socket"),
        ).resolves.toMatchObject({
          code: 1008,
        });
      } finally {
        heartbeatSocket.terminate();
        peer.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  }, 30_000);

  it("authenticates Project Binding WebSocket connections with bearer subprotocols", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create authenticated Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}&projectFingerprint=sha256_repo`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open authenticated Project Binding socket");
        await expect(
          withTimeout(nextSocketJson(socket), "receive authenticated Project Binding ready"),
        ).resolves.toMatchObject({
          type: "ready",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
        });
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("keeps a socket authorized across token rotation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create authenticated Project Binding session",
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}&projectFingerprint=sha256_repo`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open authenticated Project Binding socket");
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");

        const rotated = store.refreshClientCredentials({
          hostUrl: `${server.origin}/`,
          refreshToken: credentials.refreshToken,
        });
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(
          waitFor(async () => {
            const status = await fetch(
              `${server.origin}/v1/attach/project-bindings/${created.binding.bindingId}/status`,
              { headers: { authorization: `Bearer ${rotated.accessToken}` } },
            );
            await expect(status.json()).resolves.toMatchObject({
              state: "ready",
              syncState: "idle",
            });
          }),
          "observe heartbeat after token rotation",
        );
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rechecks role loss after a queued first heartbeat commits but before the next mutation starts", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open queued authorization socket");
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        workspaces.deferNextWrite();
        workspaces.runAfterNextWritePostCommit(() => {
          store.changeClientRole(credentials.clientId, "operator");
        });
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start queued first heartbeat");
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "syncing",
            syncState: "syncing",
          }),
        );
        const firstNodeIoTurn = Promise.withResolvers<void>();
        setImmediate(firstNodeIoTurn.resolve);
        await firstNodeIoTurn.promise;
        expect(workspaces.writeLeases).toHaveLength(1);
        const secondNodeIoTurn = Promise.withResolvers<void>();
        setImmediate(secondNodeIoTurn.resolve);
        await secondNodeIoTurn.promise;
        expect(workspaces.writeLeases).toHaveLength(1);
        workspaces.releaseNextWrite();

        await expect(withTimeout(closed, "close demoted queued socket")).resolves.toMatchObject({
          code: 1008,
        });
        expect(workspaces.writeLeases).toHaveLength(3);
        expect(workspaces.writeLeases[1]).toMatchObject({
          bindingId: created.binding.bindingId,
          state: "ready",
          active: true,
        });
        expect(workspaces.writeLeases).not.toContainEqual(
          expect.objectContaining({ bindingId: created.binding.bindingId, state: "syncing" }),
        );
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({
            bindingId: created.binding.bindingId,
            state: "ended",
            active: false,
            expiresAt: workspaces.writeLeases[1]!.expiresAt,
          }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rejects in-flight heartbeat state after post-write durable role loss", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open post-write authorization socket");
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        workspaces.deferNextWrite();
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "syncing",
            syncState: "syncing",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start in-flight candidate lease write");
        store.changeClientRole(credentials.clientId, "operator");
        workspaces.releaseNextWrite();

        await expect(withTimeout(closed, "close post-write demoted socket")).resolves.toMatchObject(
          {
            code: 1008,
          },
        );
        expect(workspaces.writeLeases).toHaveLength(3);
        expect(workspaces.writeLeases[1]).toMatchObject({
          bindingId: created.binding.bindingId,
          state: "syncing",
          active: true,
        });
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({
            bindingId: created.binding.bindingId,
            state: "ended",
            active: false,
            expiresAt: created.binding.expiresAt,
          }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("does not return a successful HTTP end after post-write role loss", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const credentials = pairedClient(store);

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      workspaces.deferNextWrite();
      const ending = app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      await workspaces.nextWriteStarted;
      store.changeClientRole(credentials.clientId, "operator");
      workspaces.releaseNextWrite();

      expect((await ending).status).toBe(403);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          state: "ended",
          active: false,
          expiresAt: created.binding.expiresAt,
        }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("does not return a successful deferred end after its captured lease expires", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      workspaces.deferNextWrite();
      const ending = app.request(
        `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await workspaces.nextWriteStarted;
      await vi.advanceTimersByTimeAsync(60_000);
      workspaces.releaseNextWrite();

      expect((await ending).status).toBe(403);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          state: "ended",
          active: false,
          expiresAt: created.binding.expiresAt,
        }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("does not acknowledge a socket end after post-write durable role loss", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open end authorization socket");
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        const messages: unknown[] = [];
        socket.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as unknown);
        });
        workspaces.deferNextWrite();
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start in-flight terminal lease write");
        store.changeClientRole(credentials.clientId, "operator");
        workspaces.releaseNextWrite();

        await expect(
          withTimeout(closed, "close post-write demoted end socket"),
        ).resolves.toMatchObject({
          code: 1008,
        });
        expect(messages).toEqual([]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("terminalizes an active Project Binding socket after durable client revocation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = new WebSocket(
        `${server.origin.replace("http:", "ws:")}/v1/attach/project-bindings/connect?bindingId=${encodeURIComponent(created.binding.bindingId)}&sessionId=${encodeURIComponent(created.sessionId)}`,
        [
          "caplets.project-binding.v1",
          `caplets.bearer.${Buffer.from(credentials.accessToken).toString("base64url")}`,
        ],
      );
      try {
        await withTimeout(waitForSocketOpen(socket), "open revocable Project Binding socket");
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        store.revokeClient(credentials.clientId);
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );

        await expect(
          withTimeout(closed, "close revoked Project Binding socket"),
        ).resolves.toMatchObject({
          code: 1008,
        });
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rejects Project Binding heartbeats from a different Remote Credential client", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const owner = pairedClient(store);
    const other = pairedClient(store);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });

    const session = await app.request("http://127.0.0.1:5387/v1/attach/project-bindings/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.accessToken}`,
      },
      body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
    });
    const created = (await session.json()) as {
      binding: { bindingId: string };
      sessionId: string;
    };

    const heartbeat = await app.request(
      `http://127.0.0.1:5387/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.accessToken}`,
        },
        body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
      },
    );

    expect(heartbeat.status).toBe(404);

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
    await expect(health.json()).resolves.toEqual({ status: "ok", ready: true });

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
    const credentials = pairedClient(store, "http://127.0.0.1:5387/caplets", "operator");
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
      backendAuthStore: testBackendAuthStore(),
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
        backendAuthStore: testBackendAuthStore(),
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
    const store = remoteCredentialStore();
    const operator = pairedClient(store, "https://10.0.0.5:5387/caplets/", "operator");
    const app = createHttpServeApp(
      httpOptions({ path: "/caplets", auth: { type: "remote_credentials" } }),
      engine,
      {
        writeErr: () => {},
        backendAuthStore: testBackendAuthStore(),
        control: context,
        remoteCredentialStore: store,
      },
    );

    const response = await app.request("https://10.0.0.5:5387/caplets/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
        "x-forwarded-proto": "http",
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
      /^https:\/\/10\.0\.0\.5:5387\/caplets\/v1\/admin\/auth\/callback\//u,
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
    const store = remoteCredentialStore();
    const operator = pairedClient(store, "https://10.0.0.5:5387/caplets/", "operator");
    const app = createHttpServeApp(
      httpOptions({ path: "/caplets", auth: { type: "remote_credentials" } }),
      engine,
      {
        writeErr: () => {},
        backendAuthStore: testBackendAuthStore(),
        control: context,
        remoteCredentialStore: store,
      },
    );

    const response = await app.request("https://10.0.0.5:5387/caplets/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
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
      /^https:\/\/10\.0\.0\.5:5387\/caplets\/v1\/admin\/auth\/callback\//u,
    );

    await engine.close();
  });

  it("uses explicit public origin for auth callback URLs behind trusted proxies", async () => {
    const context = testContext({ oauth: true });
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const operator = pairedClient(store, "https://caplets.example.com/caplets/", "operator");
    const app = createHttpServeApp(
      httpOptions({
        path: "/caplets",
        auth: { type: "remote_credentials" },
        trustProxy: true,
        publicOrigin: "https://caplets.example.com",
      }),
      engine,
      {
        writeErr: () => {},
        backendAuthStore: testBackendAuthStore(),
        control: context,
        remoteCredentialStore: store,
      },
    );

    const response = await app.request("http://10.0.0.5:5387/caplets/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.net",
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

  it("keeps the HTTP Attach revision stable after a README-only reload", async () => {
    const context = testContext();
    const capletDir = join(dirname(context.configPath), "status");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, httpReadmeCaplet("Initial operator notes."));
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const initialResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    const initial = (await initialResponse.json()) as AttachManifest;

    writeFileSync(capletPath, httpReadmeCaplet("Updated troubleshooting notes."));

    await expect(engine.reload()).resolves.toBe(true);
    const nextResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    const next = (await nextResponse.json()) as AttachManifest;
    expect(next.revision).toBe(initial.revision);
    expect({ ...next, generatedAt: initial.generatedAt }).toEqual(initial);
    await engine.close();
  });

  it("rejects an old HTTP Attach export after reload hides its Caplet", async () => {
    const config = {
      options: { exposure: "direct" },
      httpApis: {
        status: {
          name: "Status",
          description: "Read status.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    };
    const { engine, configPath } = testEngine(config);
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const manifestResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    const previous = (await manifestResponse.json()) as AttachManifest;
    const previousTool = previous.tools[0];
    expect(previousTool).toBeDefined();

    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        httpApis: {
          status: {
            ...config.httpApis.status,
            disabled: true,
          },
        },
      }),
    );
    await engine.reload();

    const nextResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    const next = (await nextResponse.json()) as AttachManifest;
    expect(next.revision).not.toBe(previous.revision);
    expect(next.tools).toEqual([]);
    expect(next.diagnostics).toEqual([
      expect.objectContaining({ code: "ATTACH_CAPLET_DISABLED", capletId: "status" }),
    ]);

    const invoked = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: previous.revision,
        kind: "tool",
        exportId: previousTool?.exportId,
        input: {},
      }),
    });
    expect(invoked.status).toBe(409);
    await expect(invoked.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
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
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
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

  it("routes attach manifest and invoke through the default attach session without a session header", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      defaultAttachSessionFactory: () => ({
        manifest: async () => attachManifest("default-rev", "default-tool"),
        invoke: async (request) => ({ invoked: request.exportId }),
        onManifestChanged: () => () => undefined,
        close: async () => undefined,
      }),
    });

    const manifestResponse = await app.request("http://127.0.0.1:5387/v1/attach/manifest");
    expect(manifestResponse.status).toBe(200);
    const manifest = (await manifestResponse.json()) as AttachManifest;
    expect(manifest.revision).toBe("default-rev");

    const invoked = await app.request("http://127.0.0.1:5387/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: "default-rev",
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

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("keeps caller-enabled artifact paths out of stacked MCP and Attach results", async () => {
    const downstream = await startPdfServer();
    const upstreamContext = testContext();
    const upstreamEngine = new CapletsEngine({
      configPath: upstreamContext.configPath,
      projectConfigPath: upstreamContext.projectConfigPath,
      watch: false,
    });
    const upstreamApp = createHttpServeApp(httpOptions(), upstreamEngine, { writeErr: () => {} });
    const upstream = await startTestHttpServer(upstreamApp);
    let captured: CapturedUpstreamServe | undefined;
    const captureSessionFactory = async (
      _options: HttpServeOptions,
      sessionFactory: HttpMcpSessionFactory,
      _writeErr: ((value: string) => void) | undefined,
      io: {
        attachSessionFactory?: HttpAttachSessionFactory;
        defaultAttachSessionFactory?: HttpAttachSessionFactory;
        exposeAttach?: boolean;
      },
      engineOptions: CapletsEngineOptions,
    ): Promise<void> => {
      captured = {
        sessionFactory,
        ...(io.attachSessionFactory ? { attachSessionFactory: io.attachSessionFactory } : {}),
        ...(io.defaultAttachSessionFactory
          ? { defaultAttachSessionFactory: io.defaultAttachSessionFactory }
          : {}),
        ...(io.exposeAttach === undefined ? {} : { exposeAttach: io.exposeAttach }),
        engineOptions,
      };
    };

    vi.resetModules();
    vi.doMock("../src/serve/http", () => ({
      ...serveHttpModule,
      serveHttpWithSessionFactory: captureSessionFactory,
    }));
    try {
      const wrapperContext = testContext();
      const authDir = tempDir("caplets-stacked-auth-");
      await new FileRemoteProfileStore({
        root: join(authDir, "remote-profiles"),
      }).saveSelfHostedProfile({
        hostUrl: upstream.origin,
        clientId: "stacked_test_client",
        clientLabel: "Stacked Test",
        credentials: {
          accessToken: "stacked-access-token",
          refreshToken: "stacked-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      });
      const artifactDir = tempDir("caplets-stacked-artifacts-");
      writeFileSync(
        wrapperContext.configPath,
        JSON.stringify({
          options: { exposure: "direct" },
          httpApis: {
            overlay: {
              name: "Overlay HTTP",
              description: "Download a stacked runtime report.",
              exposure: "direct",
              baseUrl: downstream.baseUrl,
              auth: { type: "none" },
              actions: { download: { method: "GET", path: "/report" } },
            },
          },
        }),
      );

      // The module must load after the mock so the public upstream entrypoint builds its closures.
      const { serveResolvedCaplets } = await import("../src/serve");
      await serveResolvedCaplets(
        httpOptions({ port: 5399, upstreamUrl: upstream.origin }),
        {
          configPath: wrapperContext.configPath,
          projectConfigPath: wrapperContext.projectConfigPath,
          authDir,
          artifactDir,
          exposeLocalArtifactPaths: true,
          watch: false,
        },
        () => {},
      );
      if (!captured) throw new Error("expected stacked serve wiring to capture session factories");

      const wrapperEngine = new CapletsEngine(captured.engineOptions);
      const wrapperApp = createHttpServeApp(httpOptions({ loopback: false }), wrapperEngine, {
        writeErr: () => {},
        ...(captured.exposeAttach === undefined ? {} : { exposeAttach: captured.exposeAttach }),
        sessionFactory: captured.sessionFactory,
        ...(captured.attachSessionFactory
          ? { attachSessionFactory: captured.attachSessionFactory }
          : {}),
        ...(captured.defaultAttachSessionFactory
          ? { defaultAttachSessionFactory: captured.defaultAttachSessionFactory }
          : {}),
      });
      const wrapper = await startTestHttpServer(wrapperApp);
      try {
        expectRemoteArtifactResult(await callMcpTool(wrapper.origin, "overlay__download", {}));

        expectRemoteArtifactResult(await invokeAttachTool(wrapper.origin));

        const created = await fetch(`${wrapper.origin}/v1/attach/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(created.status).toBe(201);
        const sessionId = attachSessionId(await created.json());
        expectRemoteArtifactResult(
          await invokeAttachTool(wrapper.origin, {
            [CAPLETS_ATTACH_SESSION_HEADER]: sessionId,
          }),
        );
      } finally {
        await wrapperApp.closeCapletsSessions();
        await withTimeout(wrapper.close(), "close stacked HTTP server");
        await wrapperEngine.close();
      }
    } finally {
      vi.doUnmock("../src/serve/http");
      vi.resetModules();
      await upstreamApp.closeCapletsSessions();
      await withTimeout(upstream.close(), "close upstream HTTP server");
      await upstreamEngine.close();
      await downstream.close();
    }
  });

  it("rejects attach requests that would cycle through the same stacked runtime", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      defaultAttachSessionFactory: () => {
        throw new Error("default attach session should not be created");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { [CAPLETS_STACK_CHAIN_HEADER]: "http://127.0.0.1:5387/" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Stacked runtime upstream cycle detected.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("defaults attach session project config path from project root", async () => {
    const { engine } = testEngine();
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
    const projectConfigPath = join(projectRoot, ".caplets", "config.json");
    let captured: unknown;
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (metadata) => {
        captured = metadata;
        return {
          manifest: async () => attachManifest("session-rev", "session-tool"),
          invoke: async () => ({ ok: true }),
          onManifestChanged: () => () => undefined,
          close: async () => undefined,
        };
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(201);
    expect(captured).toEqual({ projectRoot, projectConfigPath });

    await app.closeCapletsSessions();
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

  it("rejects attach session project config symlinks that resolve outside the project root", async () => {
    const { engine } = testEngine();
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
    const outsideDir = tempDir("caplets-attach-session-outside-");
    const outsideConfig = join(outsideDir, "config.json");
    writeFileSync(outsideConfig, "{}", "utf8");
    mkdirSync(join(projectRoot, ".caplets"), { recursive: true });
    symlinkSync(outsideConfig, join(projectRoot, ".caplets", "config.json"));
    const app = createHttpServeApp(httpOptions(), engine, {
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
        message: "projectConfigPath must resolve inside projectRoot.",
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

  it("rejects attach session project context through a configured public origin", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
        attachSessionFactory: () => {
          throw new Error("session factory should not run");
        },
      },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
      },
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

  it("canonicalizes symlinked attach session project config paths", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const canonicalProjectRoot = realpathSync(projectRoot);
    const projectConfigPath = join(canonicalProjectRoot, ".caplets", "config.json");
    mkdirSync(join(canonicalProjectRoot, ".caplets"), { recursive: true });
    writeFileSync(projectConfigPath, "{}", "utf8");
    const symlinkedProjectRoot = tempDir("caplets-attach-session-link-parent-");
    rmSync(symlinkedProjectRoot, { recursive: true, force: true });
    symlinkSync(projectRoot, symlinkedProjectRoot, "dir");
    dirs.push(symlinkedProjectRoot);
    let metadata: unknown;
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (sessionMetadata) => {
        metadata = sessionMetadata;
        return {
          manifest: async () => attachManifest("session-rev", "session-tool"),
          invoke: async () => ({ ok: true }),
          onManifestChanged: () => () => undefined,
          close: async () => undefined,
        };
      },
    });

    const response = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: symlinkedProjectRoot,
        projectConfigPath: join(symlinkedProjectRoot, ".caplets", "config.json"),
      }),
    });

    expect(response.status).toBe(201);
    expect(metadata).toEqual({
      projectRoot: canonicalProjectRoot,
      projectConfigPath,
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

  it("prunes idle attach sessions without waiting for another request", async () => {
    vi.useFakeTimers();
    const { engine } = testEngine();
    const close = vi.fn(async () => undefined);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => ({
        manifest: async () => attachManifest("session-rev", "session-tool"),
        invoke: async () => ({ ok: true }),
        onManifestChanged: () => () => undefined,
        close,
      }),
    });
    try {
      const created = await app.request("http://127.0.0.1:5387/v1/attach/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(201);

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(close).toHaveBeenCalledOnce();
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
    let downstreamToolName = "read";
    const engine = {
      onReload: () => () => undefined,
      currentExposureGeneration: () => 0,
      exposureProjection: async () => ({
        generation: 0,
        projection: buildManifestExposureProjection({
          caplets: [],
          tools: [
            {
              kind: "tool",
              capletId: "docs",
              downstreamName: downstreamToolName,
              name: `docs__${downstreamToolName}`,
              inputSchema: { type: "object" },
              shadowing: "forbid",
            },
          ],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          completions: [],
        }),
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

  it("allows attach requests through additional configured public origin hosts", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://primary.example.com",
        publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        allowUnauthenticatedHttp: true,
      }),
      engine,
      { writeErr: () => {} },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: { host: "secondary.example.com" },
    });

    expect(response.status).toBe(200);
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

  it("allows authenticated attach requests through additional configured public origin hosts", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://secondary.example.com/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://primary.example.com",
        publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const response = await app.request("http://127.0.0.1:5387/v1/attach/manifest", {
      headers: {
        host: "secondary.example.com",
        authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    expect(response.status).toBe(200);
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

async function startTestHttpServer(app: ReturnType<typeof createHttpServeApp>): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  return await new Promise((resolve) => {
    const websocketServer = new WebSocketServer({ noServer: true });
    const server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        websocket: {
          server: websocketServer as unknown as WebSocketServerLike,
        },
      },
      (info) => {
        resolve({
          origin: `http://127.0.0.1:${info.port}`,
          close: async () => {
            for (const client of websocketServer.clients) {
              client.terminate();
            }
            await new Promise<void>((closed) => server.close(() => closed()));
          },
        });
      },
    );
  });
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function nextSocketJson(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; reason: string }>();
  socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  socket.once("error", reject);
  return await promise;
}

async function waitFor(assertion: () => Promise<void>, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

class DeferredProjectBindingWorkspaceStore extends ProjectBindingWorkspaceStore {
  nextWriteStarted: Promise<void> = Promise.resolve();
  writeLeases: ProjectBindingLease[] = [];
  private afterNextWritePostCommit: (() => void) | undefined;
  private failedWrites = 0;
  private deferredWrite:
    | {
        started: PromiseWithResolvers<void>;
        release: PromiseWithResolvers<void>;
      }
    | undefined;

  deferNextWrite(): void {
    this.deferredWrite = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.nextWriteStarted = this.deferredWrite.started.promise;
  }

  releaseNextWrite(): void {
    this.deferredWrite?.release.resolve();
  }

  failNextWrite(): void {
    this.failedWrites += 1;
  }

  runAfterNextWritePostCommit(action: () => void): void {
    this.afterNextWritePostCommit = action;
  }

  override async writeLease(lease: ProjectBindingLease): Promise<void> {
    const deferred = this.deferredWrite;
    if (deferred) {
      deferred.started.resolve();
      await deferred.release.promise;
      if (this.deferredWrite === deferred) this.deferredWrite = undefined;
    }
    this.writeLeases.push(lease);
    if (this.failedWrites > 0) {
      this.failedWrites -= 1;
      throw new Error("terminal lease write failed");
    }
    await super.writeLease(lease);
    const afterNextWritePostCommit = this.afterNextWritePostCommit;
    this.afterNextWritePostCommit = undefined;
    if (afterNextWritePostCommit) {
      queueMicrotask(() => queueMicrotask(afterNextWritePostCommit));
    }
  }
}

class DeferredWorkspaceCleanupStore extends ProjectBindingWorkspaceStore {
  cleanupCalls = 0;
  readonly releaseCleanup = Promise.withResolvers<void>();

  override async cleanup() {
    this.cleanupCalls += 1;
    await this.releaseCleanup.promise;
    return await super.cleanup();
  }
}

class FailingProjectBindingWorkspaceStore extends ProjectBindingWorkspaceStore {
  private failedWrites = 0;

  failNextWrite(): void {
    this.failedWrites += 1;
  }

  override async writeLease(lease: ProjectBindingLease): Promise<void> {
    if (this.failedWrites > 0) {
      this.failedWrites -= 1;
      throw new Error("terminal lease write failed");
    }
    await super.writeLease(lease);
  }
}

function projectBindingWorkspaceFingerprintForTest(
  ownerKey: string,
  projectFingerprint: string,
): string {
  return `sha256_${createHash("sha256").update(ownerKey).update("\0").update(projectFingerprint).digest("hex")}`;
}

function pairedClient(
  store: RemoteServerCredentialStore,
  hostUrl = "http://127.0.0.1:5387/",
  role: "access" | "operator" = "access",
): {
  clientId: string;
  accessToken: string;
  refreshToken: string;
} {
  if (role === "access") {
    const issued = store.createPairingCode({ hostUrl });
    return store.exchangePairingCode({
      hostUrl,
      code: issued.code,
    });
  }
  const pending = store.createPendingLogin({ hostUrl, requestedRole: role });
  store.approvePendingLogin({ operatorCode: pending.operatorCode });
  return store.completePendingLogin({
    hostUrl,
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
  });
}

function httpReadmeCaplet(readme: string): string {
  return [
    "---",
    "name: Status",
    "description: Read service status.",
    "httpApi:",
    "  baseUrl: http://127.0.0.1:1",
    "  auth: { type: none }",
    "  actions:",
    "    check: { method: GET, path: /check }",
    "---",
    readme,
    "",
  ].join("\n");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function testBackendAuthStore(): BackendAuthStateStore {
  const sqlite = new BetterSqlite3(":memory:");
  backendAuthDatabases.push(sqlite);
  sqlite.exec(`
    create table backend_auth_states (
      server text primary key not null,
      generation integer not null,
      token_bundle text not null,
      created_at text not null,
      updated_at text not null
    );
    create table operator_activity (
      activity_key text primary key not null,
      operator_client_id text not null,
      action text not null,
      target_kind text not null,
      target_key text not null,
      outcome text not null,
      metadata text not null,
      created_at text not null
    )
  `);
  const database = drizzle(sqlite, { schema: sqliteSchema });
  return new BackendAuthStateStore({ dialect: "sqlite", db: database });
}

function testEngine(config: Record<string, unknown> = {}): {
  engine: CapletsEngine;
  configPath: string;
  projectConfigPath: string;
} {
  const context = testContext(config);
  return {
    engine: new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    }),
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
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

type CapturedUpstreamServe = {
  sessionFactory: HttpMcpSessionFactory;
  attachSessionFactory?: HttpAttachSessionFactory;
  defaultAttachSessionFactory?: HttpAttachSessionFactory;
  exposeAttach?: boolean;
  engineOptions: CapletsEngineOptions;
};

async function startPdfServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/pdf");
    response.end(Buffer.from("%PDF-1.7 stacked"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("stacked HTTP artifact server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function callMcpTool(
  origin: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const initialized = await fetch(`${origin}/v1/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "host-boundary-test", version: "1.0.0" },
      },
    }),
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("expected MCP session ID");
  try {
    await fetch(`${origin}/v1/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const response = await fetch(`${origin}/v1/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return mcpToolCallResult(await response.text());
  } finally {
    const deleted = await fetch(`${origin}/v1/mcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
    });
    expect(deleted.status).toBe(200);
  }
}

function mcpToolCallResult(text: string): unknown {
  const payloadText = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
  if (!payloadText) throw new Error(`Could not parse MCP response: ${text}`);
  const payload: unknown = JSON.parse(payloadText);
  if (!isRecord(payload) || !("result" in payload)) {
    throw new Error("MCP tool call did not return a result");
  }
  return payload.result;
}

function attachToolInvocation(
  manifest: unknown,
  name: string,
): { revision: string; exportId: string } {
  if (
    !isRecord(manifest) ||
    typeof manifest.revision !== "string" ||
    !Array.isArray(manifest.tools)
  ) {
    throw new Error("expected Attach manifest");
  }
  const tool = manifest.tools.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.name === name && typeof candidate.exportId === "string",
  );
  if (!tool) throw new Error(`expected Attach export ${name}`);
  const exportId = tool.exportId;
  if (typeof exportId !== "string") throw new Error(`expected Attach export ID for ${name}`);
  return { revision: manifest.revision, exportId };
}

function attachResponseData(response: unknown): unknown {
  if (!isRecord(response) || response.ok !== true || !("data" in response)) {
    throw new Error("expected successful Attach response");
  }
  return response.data;
}

async function invokeAttachTool(
  origin: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const manifestResponse = await fetch(`${origin}/v1/attach/manifest`, { headers });
  expect(manifestResponse.status).toBe(200);
  const attachExport = attachToolInvocation(await manifestResponse.json(), "overlay__download");
  const invokeResponse = await fetch(`${origin}/v1/attach/invoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      revision: attachExport.revision,
      kind: "tool",
      exportId: attachExport.exportId,
      input: {},
    }),
  });
  expect(invokeResponse.status).toBe(200);
  return attachResponseData(await invokeResponse.json());
}

function attachSessionId(response: unknown): string {
  if (!isRecord(response) || typeof response.sessionId !== "string") {
    throw new Error("expected Attach session ID");
  }
  return response.sessionId;
}

function expectRemoteArtifactResult(result: unknown): void {
  const structuredContent = remoteArtifact(result);
  const reference = artifactReference(result);
  expect(structuredContent).toMatchObject({
    kind: "remote-reference",
    uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
    mimeType: "application/pdf",
    byteLength: 16,
  });
  expect(structuredContent).not.toHaveProperty("path");
  expect(structuredContent).not.toHaveProperty("pathResolution");
  expect(reference).toMatchObject({
    presentation: "reference",
    reference: structuredContent.uri,
  });
  expect(reference).not.toHaveProperty("path");
  expect(reference).not.toHaveProperty("pathResolution");
}

function remoteArtifact(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  throw new Error("expected structured artifact content");
}

function artifactReference(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result._meta) || !isRecord(result._meta.caplets)) {
    throw new Error("expected Caplets result metadata");
  }
  const artifacts = result._meta.caplets.artifacts;
  if (Array.isArray(artifacts) && isRecord(artifacts[0])) {
    return artifacts[0];
  }
  throw new Error("expected artifact reference metadata");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
