import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import { createHostStorage, type HostStorage, type RemoteSecurityStore } from "../src/storage";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];
const storages = new Set<HostStorage>();

afterEach(async () => {
  await Promise.all([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard sessions", () => {
  it("serves the unauthenticated dashboard shell without operator data", async () => {
    const { app, engine } = await testApp();

    const response = await app.request("http://127.0.0.1:5387/dashboard");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('id="caplets-dashboard"');
    expect(html).not.toContain("accessToken");
    expect(html).not.toContain("refreshToken");
    expect(html).not.toContain("cap_remote_access_");

    await engine.close();
  });

  it("requires a session cookie for remote-credential dashboard sessions", async () => {
    const { app, engine } = await testApp();

    const response = await app.request("http://127.0.0.1:5387/dashboard/api/session");

    expect(response.status).toBe(401);

    await engine.close();
  });

  it("serves a development operator session and dashboard data without cookies", async () => {
    const { app, engine } = await developmentTestApp();

    const session = await app.request("http://127.0.0.1:5387/dashboard/api/session");
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      session: {
        sessionId: "development_unauthenticated",
        operatorClientId: "development_unauthenticated",
        role: "operator",
        csrfToken: "development_unauthenticated",
      },
    });

    const summary = await app.request("http://127.0.0.1:5387/dashboard/api/v2/host");
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      host: {
        current: true,
        baseUrl: "http://127.0.0.1:5387/",
        dashboardUrl: "http://127.0.0.1:5387/dashboard",
      },
      sections: expect.objectContaining({
        caplets: expect.objectContaining({ href: "/dashboard#caplets" }),
      }),
    });
    expect((await app.request("http://127.0.0.1:5387/dashboard/api/summary")).status).toBe(404);

    await engine.close();
  });
  it("denies non-loopback development administration while preserving runtime access", async () => {
    const { app, engine } = await developmentTestApp({ host: "0.0.0.0", loopback: false });
    const baseUrl = "http://10.0.0.5:5387";

    const session = await app.request(`${baseUrl}/dashboard/api/session`);
    expect(session.status).toBe(403);

    const admin = await app.request(`${baseUrl}/v1/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "list", arguments: {} }),
    });
    expect(admin.status).toBe(403);

    const reveal = await app.request(`${baseUrl}/dashboard/api/private/vault-reveals`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caplets-csrf": "development_unauthenticated",
      },
      body: JSON.stringify({ key: "GH_TOKEN", confirmation: "reveal GH_TOKEN" }),
    });
    expect(reveal.status).toBe(403);

    const attach = await app.request(`${baseUrl}/v1/attach/manifest`);
    expect(attach.status).toBe(200);

    const mcp = await app.request(`${baseUrl}/v1/mcp`, {
      method: "POST",
      headers: {
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
          clientInfo: { name: "development-test", version: "1.0.0" },
        },
      }),
    });
    expect(mcp.status).toBe(200);

    await engine.close();
  });

  it("logs out development operator sessions without cookie-backed sessions", async () => {
    const { app, engine } = await developmentTestApp();

    const expectedStatuses = [
      {
        name: "development CSRF token",
        headers: { "x-caplets-csrf": "development_unauthenticated" },
        status: 200,
      },
      { name: "missing CSRF token", headers: undefined, status: 403 },
      { name: "wrong CSRF token", headers: { "x-caplets-csrf": "wrong" }, status: 403 },
    ] as const;

    for (const { name, headers, status } of expectedStatuses) {
      const response = await app.request("http://127.0.0.1:5387/dashboard/api/logout", {
        method: "POST",
        ...(headers ? { headers } : {}),
      });

      expect(response.status, name).toBe(status);
      if (status === 200) {
        await expect(response.json(), name).resolves.toEqual({ ok: true });
      }
    }

    await engine.close();
  });

  it("starts dashboard authorization as an operator pending login", async () => {
    const { app, engine, store } = await testApp();

    const response = await app.request("http://127.0.0.1:5387/dashboard/api/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientLabel: "Browser" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      flowId: string;
      approvalCommand: string;
      requestedRole: string;
    };
    expect(body).toMatchObject({
      flowId: expect.stringMatching(/^rlogin_/u),
      approvalCommand: expect.stringContaining("caplets remote host approve cap_login_"),
      requestedRole: "operator",
    });
    expect(body.approvalCommand).not.toContain("--state-path");
    expect(body.approvalCommand).toContain("--yes");
    expect(await store.listPendingLogins()).toContainEqual(
      expect.objectContaining({ clientLabel: "Browser", requestedRole: "operator" }),
    );

    await engine.close();
  });

  it("completes approved dashboard authorization into an HttpOnly session cookie", async () => {
    const { app, engine, store } = await testApp();
    const started = await startDashboardLogin(app);
    const code = approvalCode(started.approvalCommand);
    await store.approvePendingLogin({
      operatorClientId: "bootstrap_test",
      operatorCode: code,
    });

    const response = await app.request("http://127.0.0.1:5387/dashboard/api/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: started.flowId,
        pendingCompletionSecret: started.pendingCompletionSecret,
      }),
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("caplets_dashboard_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const bodyText = await response.text();
    expect(bodyText).not.toContain("cap_remote_access_");
    expect(bodyText).not.toContain("cap_remote_refresh_");
    const body = JSON.parse(bodyText) as { session: { csrfToken: string; role: string } };
    expect(body.session).toMatchObject({ role: "operator" });
    expect(body.session.csrfToken).toMatch(/^csrf_/u);

    const session = await app.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      session: { role: "operator", csrfToken: body.session.csrfToken },
    });

    await engine.close();
  });

  it("applies session and current CSRF authority to the shared dashboard Admin mount", async () => {
    const { app, engine, store, storage } = await testApp();
    expect((await app.request("http://127.0.0.1:5387/dashboard/api/v2/host")).status).toBe(401);
    const { cookie, csrfToken } = await approvedDashboardSession(app, store);
    await storage.caplets.importBundle({
      id: "demo",
      operator: { clientId: "operator_test", role: "operator" },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(`---
name: Demo
description: Dashboard Admin mount fixture.
mcpServer:
  command: demo
---

# Demo
`),
        },
      ],
    });
    const hostUrl = "http://127.0.0.1:5387/";
    const pending = await store.createPendingLogin({
      hostUrl,
      requestedRole: "operator",
      clientLabel: "Operator CLI",
    });
    await store.approvePendingLogin({
      operatorClientId: "bootstrap_test",
      operatorCode: pending.operatorCode,
    });
    const operator = await store.completePendingLogin({
      hostUrl,
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      requiredRole: "operator",
    });

    const dashboardRead = await app.request("http://127.0.0.1:5387/dashboard/api/v2/host", {
      headers: { cookie },
    });
    const bearerRead = await app.request("http://127.0.0.1:5387/v2/admin/host", {
      headers: { authorization: `Bearer ${operator.accessToken}` },
    });
    expect(dashboardRead.status).toBe(200);
    expect(bearerRead.status).toBe(200);
    expect(await dashboardRead.json()).toEqual(await bearerRead.json());
    const observations = await app.request(
      "http://127.0.0.1:5387/dashboard/api/v2/caplet-records/demo/installation-observations?limit=1",
      { headers: { cookie } },
    );
    expect(observations.status).toBe(200);
    await expect(observations.json()).resolves.toEqual({ items: [] });

    for (const [name, csrf, status] of [
      ["missing CSRF", undefined, 403],
      ["stale CSRF", "stale-csrf", 403],
      ["current CSRF", csrfToken, 503],
    ] as const) {
      const response = await app.request(
        "http://127.0.0.1:5387/dashboard/api/v2/runtime-restarts",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "idempotency-key": `dashboard-runtime-${name.replaceAll(" ", "-")}`,
            "if-none-match": "*",
            ...(csrf ? { "x-caplets-csrf": csrf } : {}),
          },
          body: "{}",
        },
      );
      expect(response.status, name).toBe(status);
      expect(response.headers.get("cache-control"), name).toBe("no-store");
    }

    const dashboardMutation = await app.request(
      "http://127.0.0.1:5387/dashboard/api/v2/runtime-restarts",
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": "dashboard-runtime-equivalence",
          "if-none-match": "*",
          "x-caplets-csrf": csrfToken,
        },
        body: "{}",
      },
    );
    const bearerMutation = await app.request("http://127.0.0.1:5387/v2/admin/runtime-restarts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "bearer-runtime-equivalence",
        "if-none-match": "*",
        "x-caplets-csrf": "ignored-by-bearer",
      },
      body: "{}",
    });
    expect(dashboardMutation.status).toBe(503);
    expect(bearerMutation.status).toBe(503);
    expect(await dashboardMutation.json()).toEqual(await bearerMutation.json());

    await app.closeCapletsSessions();
    await engine.close();
  });

  it.each([
    ["self-demotion", "PATCH", { role: "access" }],
    ["self-revocation", "DELETE", undefined],
  ] as const)(
    "expires and deletes the dashboard session after %s ends acting-client authority",
    async (_name, method, body) => {
      const { app, engine, store, storage } = await testApp();
      const { cookie, csrfToken } = await approvedDashboardSession(app, store);
      const currentSession = await app.request("http://127.0.0.1:5387/dashboard/api/session", {
        headers: { cookie },
      });
      const sessionBody = (await currentSession.json()) as {
        session: { sessionId: string; operatorClientId: string };
      };
      const clientUrl = `http://127.0.0.1:5387/dashboard/api/v2/remote-clients/${sessionBody.session.operatorClientId}`;
      const currentClient = await app.request(clientUrl, { headers: { cookie } });
      const etag = currentClient.headers.get("etag");
      expect(etag).not.toBeNull();

      const response = await app.request(clientUrl, {
        method,
        headers: {
          cookie,
          "idempotency-key": `dashboard-${method.toLowerCase()}-self`,
          "if-match": etag!,
          "x-caplets-csrf": csrfToken,
          ...(body === undefined ? {} : { "content-type": "application/merge-patch+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      await expect(
        storage.dashboardSessions.get(sessionBody.session.sessionId),
      ).resolves.toBeUndefined();
      const expired = await app.request("http://127.0.0.1:5387/dashboard/api/session", {
        headers: { cookie },
      });
      expect(expired.status).toBe(401);

      await engine.close();
    },
  );

  it("preserves a committed self-demotion response when session cleanup and reporting fail", async () => {
    const reports: string[] = [];
    const deleteSecret = "cap_remote_access_delete_failure_secret";
    const reporterSecret = "cap_remote_access_reporter_failure_secret";
    const { app, engine, store, storage } = await testApp({}, (message) => {
      if (message !== "Could not remove an ended dashboard session.\n") return;
      reports.push(message);
      throw new Error(reporterSecret);
    });
    const { cookie, csrfToken } = await approvedDashboardSession(app, store);
    const currentSession = await app.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    const sessionBody = (await currentSession.json()) as {
      session: { sessionId: string; operatorClientId: string };
    };
    const clientUrl = `http://127.0.0.1:5387/dashboard/api/v2/remote-clients/${sessionBody.session.operatorClientId}`;
    const currentClient = await app.request(clientUrl, { headers: { cookie } });
    const etag = currentClient.headers.get("etag");
    expect(etag).not.toBeNull();
    vi.spyOn(storage.dashboardSessions, "delete").mockRejectedValueOnce(new Error(deleteSecret));

    const response = await app.request(clientUrl, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/merge-patch+json",
        "idempotency-key": "dashboard-self-demotion-cleanup-failure",
        "if-match": etag!,
        "x-caplets-csrf": csrfToken,
      },
      body: JSON.stringify({ role: "access" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({ role: "access" });
    expect(reports).toEqual(["Could not remove an ended dashboard session.\n"]);
    for (const secret of [deleteSecret, reporterSecret]) {
      expect(responseText).not.toContain(secret);
      expect(response.headers.get("set-cookie")).not.toContain(secret);
      expect(reports.join("")).not.toContain(secret);
    }
    await expect(
      storage.dashboardSessions.get(sessionBody.session.sessionId),
    ).resolves.toBeDefined();

    await engine.close();
  });

  it("rejects downgraded dashboard approvals without creating orphaned access clients", async () => {
    const { app, engine, store } = await testApp();
    const started = await startDashboardLogin(app);
    await store.approvePendingLogin({
      operatorClientId: "bootstrap_test",
      operatorCode: approvalCode(started.approvalCommand),
      grantedRole: "access",
    });

    const response = await app.request("http://127.0.0.1:5387/dashboard/api/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: started.flowId,
        pendingCompletionSecret: started.pendingCompletionSecret,
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("operator role") },
    });
    expect(await store.listClients()).toHaveLength(0);

    await engine.close();
  });

  it("sets a Secure dashboard session cookie when HTTPS public origin fronts HTTP proxy traffic", async () => {
    const { app, engine, store } = await testApp({
      publicOrigin: "https://caplets.example.com",
      trustProxy: true,
    });
    const started = await startDashboardLogin(app);
    await store.approvePendingLogin({
      operatorClientId: "bootstrap_test",
      operatorCode: approvalCode(started.approvalCommand),
    });

    const response = await app.request("http://10.0.0.5:5387/dashboard/api/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json", host: "caplets.example.com" },
      body: JSON.stringify({
        flowId: started.flowId,
        pendingCompletionSecret: started.pendingCompletionSecret,
      }),
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("caplets_dashboard_session=");
    expect(cookie).toContain("Secure");

    await engine.close();
  });

  it("returns 503 instead of logging out on dashboard session lock contention", async () => {
    const setup = await testApp();
    const { cookie } = await approvedDashboardSession(setup.app, setup.store);
    if (setup.storage.database.dialect !== "sqlite") {
      throw new Error("Expected SQLite HostStorage.");
    }
    const sqlite = setup.storage.database.db as unknown as {
      $client: { pragma(source: string): unknown };
    };
    sqlite.$client.pragma("busy_timeout = 1");
    const lock = new BetterSqlite3(setup.databasePath);
    try {
      lock.exec("BEGIN IMMEDIATE");
      const response = await setup.app.request("http://127.0.0.1:5387/dashboard/api/session", {
        headers: { cookie },
      });

      expect(response.status).toBe(503);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    await setup.engine.close();
  });

  it("requires a remote-credential session and CSRF on unsafe dashboard APIs and invalidates logout", async () => {
    const { app, engine, store } = await testApp();
    const missingSession = await app.request("http://127.0.0.1:5387/dashboard/api/logout", {
      method: "POST",
    });
    expect(missingSession.status).toBe(401);

    const { cookie, csrfToken } = await approvedDashboardSession(app, store);

    const missingCsrf = await app.request("http://127.0.0.1:5387/dashboard/api/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(missingCsrf.status).toBe(403);

    const logout = await app.request("http://127.0.0.1:5387/dashboard/api/logout", {
      method: "POST",
      headers: { cookie, "x-caplets-csrf": csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const session = await app.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(401);

    await engine.close();
  });

  it("reloads durable sessions and rejects them after backing operator revocation", async () => {
    const setup = await testApp();
    const { cookie } = await approvedDashboardSession(setup.app, setup.store);
    await setup.engine.close();
    await setup.storage.close();

    const reloadedStorage = await createTestHostStorage(setup.stateDir, setup.databasePath);
    const reloadedEngine = engineFor(setup.context, reloadedStorage);
    const reloadedApp = createHttpServeApp(httpOptions(setup.stateDir), reloadedEngine, {
      writeErr: () => {},
      control: setup.context,
      authoritativeStorage: reloadedStorage,
    });
    const listClients = vi
      .spyOn(reloadedStorage.remoteSecurity, "listClients")
      .mockRejectedValue(new Error("dashboard session validation must not list clients"));
    const restored = await reloadedApp.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { session: { operatorClientId: string } };

    await reloadedStorage.remoteSecurity.revokeClient({
      operatorClientId: "bootstrap_test",
      clientId: restoredBody.session.operatorClientId,
    });
    const revoked = await reloadedApp.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(revoked.status).toBe(401);

    expect(listClients).not.toHaveBeenCalled();
    await reloadedEngine.close();
  });
});

async function startDashboardLogin(app: CapletsHttpApp): Promise<{
  flowId: string;
  pendingCompletionSecret: string;
  approvalCommand: string;
}> {
  const response = await app.request("http://127.0.0.1:5387/dashboard/api/login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLabel: "Browser" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
}

async function approvedDashboardSession(
  app: CapletsHttpApp,
  store: RemoteSecurityStore,
): Promise<{ cookie: string; csrfToken: string }> {
  const started = await startDashboardLogin(app);
  await store.approvePendingLogin({
    operatorClientId: "bootstrap_test",
    operatorCode: approvalCode(started.approvalCommand),
  });
  const response = await app.request("http://127.0.0.1:5387/dashboard/api/login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: started.flowId,
      pendingCompletionSecret: started.pendingCompletionSecret,
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  const body = (await response.json()) as { session: { csrfToken: string } };
  return { cookie, csrfToken: body.session.csrfToken };
}

function approvalCode(command: string): string {
  const code = command.match(/approve\s+(cap_login_[^\s]+)/u)?.[1];
  if (!code) throw new Error(`Could not find approval code in ${command}`);
  return code;
}

async function testApp(
  overrides: Partial<HttpServeOptions> = {},
  writeErr: (value: string) => void = () => {},
) {
  const stateDir = tempDir("caplets-dashboard-state-");
  const databasePath = join(stateDir, "host.sqlite3");
  const context = testContext();
  const storage = await createTestHostStorage(stateDir, databasePath);
  const engine = engineFor(context, storage);
  const store = storage.remoteSecurity;
  const app = createHttpServeApp(httpOptions(stateDir, overrides), engine, {
    writeErr,
    control: context,
    authoritativeStorage: storage,
  });
  return { app, engine, store, storage, databasePath, stateDir, context };
}

async function developmentTestApp(overrides: Partial<HttpServeOptions> = {}) {
  const stateDir = tempDir("caplets-dashboard-dev-state-");
  const context = testContext();
  const storage = await createTestHostStorage(stateDir, join(stateDir, "host.sqlite3"));
  const engine = engineFor(context, storage);
  const app = createHttpServeApp(developmentHttpOptions(stateDir, overrides), engine, {
    writeErr: () => {},
    control: context,
    authoritativeStorage: storage,
  });
  return { app, engine, storage, stateDir, context };
}

async function createTestHostStorage(stateDir: string, databasePath: string): Promise<HostStorage> {
  const storage = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { vaultRoot: join(stateDir, "vault") },
  );
  storages.add(storage);
  return storage;
}

function engineFor(
  context: { configPath: string; projectConfigPath: string },
  storage: HostStorage,
): CapletsEngine {
  return new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    hostStorage: storage,
    watch: false,
  });
}

function httpOptions(
  stateDir: string,
  overrides: Partial<HttpServeOptions> = {},
): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    auth: { type: "remote_credentials" },
    remoteCredentialStateDir: stateDir,
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    adminUploads: {
      stagingDir: join(tmpdir(), "caplets-uploads"),
      maxConcurrent: 1,
      maxStagedBytes: 400_000_000,
    },
    ...overrides,
  };
}

function developmentHttpOptions(
  stateDir: string,
  overrides: Partial<HttpServeOptions> = {},
): HttpServeOptions {
  return {
    ...httpOptions(stateDir),
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: true,
    ...overrides,
  };
}

function testContext(): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
} {
  const dir = tempDir("caplets-dashboard-");
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
  return { configPath, projectConfigPath, projectCapletsRoot: projectRoot };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
