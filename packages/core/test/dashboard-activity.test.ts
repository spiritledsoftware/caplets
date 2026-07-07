import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { CapletsEngine } from "../src/engine";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard activity and access actions", () => {
  it("approves and denies pending logins through operator actions and records redacted activity", async () => {
    const setup = await authenticatedDashboard();
    const approveTarget = setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Tablet",
    });
    const denyTarget = setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "access",
      clientLabel: "Old laptop",
    });

    const approved = await dashboardPost(
      setup,
      `/dashboard/api/access/pending-logins/${approveTarget.flowId}/approve`,
      { grantedRole: "access" },
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      pendingLogin: {
        flowId: approveTarget.flowId,
        requestedRole: "operator",
        grantedRole: "access",
      },
    });

    const denied = await dashboardPost(
      setup,
      `/dashboard/api/access/pending-logins/${denyTarget.flowId}/deny`,
      {},
    );
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({ pendingLogin: { status: "denied" } });

    const activity = await dashboardGet(setup, "/dashboard/api/activity");
    expect(activity.status).toBe(200);
    const text = await activity.text();
    expect(text).toContain('"action":"pending_login_approved"');
    expect(text).toContain('"action":"pending_login_denied"');
    expect(text).toContain('"actorClientId"');
    expect(text).not.toContain(approveTarget.operatorCode);
    expect(text).not.toContain(approveTarget.pendingCompletionSecret);
    expect(text).not.toContain("cap_remote_access_");

    await setup.engine.close();
  });

  it("rejects flow-id approval after the visible operator code expires", async () => {
    const setup = await authenticatedDashboard();
    const expired = setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Expired browser",
      now: new Date(Date.now() - 11 * 60_000),
    });

    const approved = await dashboardPost(
      setup,
      `/dashboard/api/access/pending-logins/${expired.flowId}/approve`,
      { grantedRole: "operator" },
    );

    expect(approved.status).toBe(401);
    await expect(approved.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("code has expired"),
      },
    });
    expect(setup.store.listPendingLogins()).toContainEqual(
      expect.objectContaining({ flowId: expired.flowId, status: "pending" }),
    );

    await setup.engine.close();
  });

  it("revokes and role-changes clients, terminating current operator authority when applicable", async () => {
    const setup = await authenticatedDashboard();
    const other = setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Second operator",
    });
    setup.store.approvePendingLogin({ operatorCode: other.operatorCode });
    const otherCredentials = setup.store.completePendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      flowId: other.flowId,
      pendingCompletionSecret: other.pendingCompletionSecret,
    });

    const revoked = await dashboardPost(
      setup,
      `/dashboard/api/access/clients/${otherCredentials.clientId}/revoke`,
      {},
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      revoked: true,
      clientId: otherCredentials.clientId,
    });

    const downgraded = await dashboardPost(
      setup,
      `/dashboard/api/access/clients/${setup.operatorClientId}/role`,
      { role: "access" },
    );
    expect(downgraded.status).toBe(200);
    await expect(downgraded.json()).resolves.toMatchObject({
      client: { role: "access" },
      sessionEnded: true,
    });

    const summary = await dashboardGet(setup, "/dashboard/api/summary");
    expect(summary.status).toBe(401);

    const activity = await setup.app.request("http://127.0.0.1:5387/dashboard/api/activity", {
      headers: { cookie: setup.cookie },
    });
    expect(activity.status).toBe(401);

    await setup.engine.close();
  });

  it("paginates activity toward older entries and preserves safe valueBytes metadata", () => {
    const log = new DashboardActivityLog({ dir: tempDir("caplets-dashboard-activity-log-") });

    log.append({
      actorClientId: "operator",
      action: "vault_set",
      target: { type: "vault", id: "GH_TOKEN" },
      metadata: { bytesWritten: 42, secretValue: "should-not-log" },
      now: new Date("2026-07-08T10:00:00.000Z"),
    });
    log.append({
      actorClientId: "operator",
      action: "catalog_updated",
      target: { type: "catalog", id: "github" },
      now: new Date("2026-07-08T10:01:00.000Z"),
    });

    const firstPage = log.list({ limit: 1 });
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]).toMatchObject({
      action: "catalog_updated",
      target: { id: "github" },
    });
    expect(firstPage.nextCursor).toBe(firstPage.entries[0]?.id);

    const secondPage = log.list({ limit: 1, after: firstPage.nextCursor });
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]).toMatchObject({
      action: "vault_set",
      target: { id: "GH_TOKEN" },
      metadata: { bytesWritten: 42 },
    });
    expect(secondPage.entries[0]?.metadata).not.toHaveProperty("secretValue");
  });
});

type Setup = Awaited<ReturnType<typeof authenticatedDashboard>>;

async function authenticatedDashboard() {
  const setup = testApp();
  const started = await appPost(setup, "/dashboard/api/login/start", { clientLabel: "Browser" });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
  setup.store.approvePendingLogin({ operatorCode: approvalCode(startBody.approvalCommand) });
  const completed = await appPost(setup, "/dashboard/api/login/complete", {
    flowId: startBody.flowId,
    pendingCompletionSecret: startBody.pendingCompletionSecret,
  });
  expect(completed.status).toBe(200);
  const cookie = completed.headers.get("set-cookie") ?? "";
  const body = (await completed.json()) as {
    session: { csrfToken: string; operatorClientId: string };
  };
  return {
    ...setup,
    cookie,
    csrfToken: body.session.csrfToken,
    operatorClientId: body.session.operatorClientId,
  };
}

async function dashboardGet(setup: Setup, path: string) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
  });
}

async function dashboardPost(setup: Setup, path: string, body: unknown) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      cookie: setup.cookie,
      "x-caplets-csrf": setup.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function appPost(
  setup: { app: ReturnType<typeof createHttpServeApp> },
  path: string,
  body: unknown,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function approvalCode(command: string): string {
  const code = command.match(/approve\s+(cap_login_[^\s]+)/u)?.[1];
  if (!code) throw new Error(`Could not find approval code in ${command}`);
  return code;
}

function testApp() {
  const stateDir = tempDir("caplets-dashboard-activity-state-");
  const context = testContext();
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    watch: false,
  });
  const store = new RemoteServerCredentialStore({ dir: stateDir });
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: context,
    remoteCredentialStore: store,
  });
  return { app, engine, store, stateDir, context };
}

function httpOptions(stateDir: string): HttpServeOptions {
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
  };
}

function testContext(): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
} {
  const dir = tempDir("caplets-dashboard-activity-");
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
