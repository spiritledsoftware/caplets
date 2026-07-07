import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard sessions", () => {
  it("serves the unauthenticated dashboard shell without operator data", async () => {
    const { app, engine } = testApp();

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
    const { app, engine } = testApp();

    const response = await app.request("http://127.0.0.1:5387/dashboard/api/session");

    expect(response.status).toBe(401);

    await engine.close();
  });

  it("serves a development operator session and dashboard data without cookies", async () => {
    const { app, engine } = developmentTestApp();

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

    const summary = await app.request("http://127.0.0.1:5387/dashboard/api/summary");
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

    await engine.close();
  });

  it("logs out development operator sessions without cookie-backed sessions", async () => {
    const { app, engine } = developmentTestApp();

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
    const { app, engine, store, stateDir } = testApp();

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
    expect(body.approvalCommand).toContain(`--state-path ${stateDir}`);
    expect(body.approvalCommand).toContain("--yes");
    expect(store.listPendingLogins()).toContainEqual(
      expect.objectContaining({ clientLabel: "Browser", requestedRole: "operator" }),
    );

    await engine.close();
  });

  it("completes approved dashboard authorization into an HttpOnly session cookie", async () => {
    const { app, engine, store } = testApp();
    const started = await startDashboardLogin(app);
    const code = approvalCode(started.approvalCommand);
    store.approvePendingLogin({ operatorCode: code });

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

  it("sets a Secure dashboard session cookie when HTTPS public origin fronts HTTP proxy traffic", async () => {
    const { app, engine, store } = testApp({
      publicOrigin: "https://caplets.example.com",
      trustProxy: true,
    });
    const started = await startDashboardLogin(app);
    store.approvePendingLogin({ operatorCode: approvalCode(started.approvalCommand) });

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
    const setup = testApp();
    const { cookie } = await approvedDashboardSession(setup.app, setup.store);

    mkdirSync(join(setup.stateDir, "dashboard-sessions.lock"), { recursive: true });
    const response = await setup.app.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });

    expect(response.status).toBe(503);
    await setup.engine.close();
  });

  it("requires a remote-credential session and CSRF on unsafe dashboard APIs and invalidates logout", async () => {
    const { app, engine, store } = testApp();
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
    const setup = testApp();
    const { cookie } = await approvedDashboardSession(setup.app, setup.store);
    await setup.engine.close();

    const reloadedEngine = engineFor(setup.context);
    const reloadedApp = createHttpServeApp(httpOptions(setup.stateDir), reloadedEngine, {
      writeErr: () => {},
      control: setup.context,
      remoteCredentialStore: setup.store,
    });
    const restored = await reloadedApp.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { session: { operatorClientId: string } };

    setup.store.revokeClient(restoredBody.session.operatorClientId);
    const revoked = await reloadedApp.request("http://127.0.0.1:5387/dashboard/api/session", {
      headers: { cookie },
    });
    expect(revoked.status).toBe(401);

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
  store: RemoteServerCredentialStore,
): Promise<{ cookie: string; csrfToken: string }> {
  const started = await startDashboardLogin(app);
  store.approvePendingLogin({ operatorCode: approvalCode(started.approvalCommand) });
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

function testApp(overrides: Partial<HttpServeOptions> = {}) {
  const stateDir = tempDir("caplets-dashboard-state-");
  const context = testContext();
  const engine = engineFor(context);
  const store = new RemoteServerCredentialStore({ dir: stateDir });
  const app = createHttpServeApp(httpOptions(stateDir, overrides), engine, {
    writeErr: () => {},
    control: context,
    remoteCredentialStore: store,
  });
  return { app, engine, store, stateDir, context };
}

function developmentTestApp() {
  const stateDir = tempDir("caplets-dashboard-dev-state-");
  const context = testContext();
  const engine = engineFor(context);
  const app = createHttpServeApp(developmentHttpOptions(stateDir), engine, {
    writeErr: () => {},
    control: context,
  });
  return { app, engine, stateDir, context };
}

function engineFor(context: { configPath: string; projectConfigPath: string }): CapletsEngine {
  return new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
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
    ...overrides,
  };
}

function developmentHttpOptions(stateDir: string): HttpServeOptions {
  return {
    ...httpOptions(stateDir),
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: true,
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
