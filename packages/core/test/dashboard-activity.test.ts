import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { createHostStorage } from "../src/storage";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard activity and access actions", () => {
  it("approves and denies pending logins through operator actions and records redacted activity", async () => {
    const setup = await authenticatedDashboard();
    const approveTarget = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Tablet",
    });
    const denyTarget = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "access",
      clientLabel: "Old laptop",
    });

    const approved = await dashboardPatch(
      setup,
      `/dashboard/api/v2/remote-login-requests/${approveTarget.flowId}`,
      { action: "approve", grantedRole: "access" },
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      flowId: approveTarget.flowId,
      requestedRole: "operator",
      grantedRole: "access",
    });

    const denied = await dashboardPatch(
      setup,
      `/dashboard/api/v2/remote-login-requests/${denyTarget.flowId}`,
      { action: "deny" },
    );
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({ status: "denied" });

    const activity = await dashboardGet(setup, "/dashboard/api/v2/activity");
    expect(activity.status).toBe(200);
    const text = await activity.text();
    expect(text).toContain('"action":"remote_pending_login_approved"');
    expect(text).toContain('"action":"remote_pending_login_denied"');
    expect(text).toContain('"actorClientId"');
    expect(text).not.toContain(approveTarget.operatorCode);
    expect(text).not.toContain(approveTarget.pendingCompletionSecret);
    expect(text).not.toContain("cap_remote_access_");

    await setup.engine.close();
    await setup.storage.close();
  });

  it("rejects flow-id approval after the visible operator code expires", async () => {
    const setup = await authenticatedDashboard();
    const expired = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Expired browser",
      now: new Date(Date.now() - 11 * 60_000),
    });

    const approved = await dashboardPatch(
      setup,
      `/dashboard/api/v2/remote-login-requests/${expired.flowId}`,
      { action: "approve", grantedRole: "operator" },
    );

    expect(approved.status).toBe(401);
    await expect(approved.json()).resolves.toMatchObject({
      code: "AUTH_FAILED",
      detail: expect.stringContaining("code has expired"),
      status: 401,
    });
    await expect(setup.store.listPendingLogins()).resolves.toContainEqual(
      expect.objectContaining({ flowId: expired.flowId, status: "pending" }),
    );

    await setup.engine.close();
    await setup.storage.close();
  });

  it("revokes and role-changes clients, terminating current operator authority when applicable", async () => {
    const setup = await authenticatedDashboard();
    const other = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Second operator",
    });
    await setup.store.approvePendingLogin({
      operatorClientId: setup.operatorClientId,
      operatorCode: other.operatorCode,
    });
    const otherCredentials = await setup.store.completePendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      flowId: other.flowId,
      pendingCompletionSecret: other.pendingCompletionSecret,
    });

    const revoked = await dashboardDelete(
      setup,
      `/dashboard/api/v2/remote-clients/${otherCredentials.clientId}`,
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      revoked: true,
      clientId: otherCredentials.clientId,
    });

    const downgraded = await dashboardPatch(
      setup,
      `/dashboard/api/v2/remote-clients/${setup.operatorClientId}`,
      { role: "access" },
    );
    expect(downgraded.status).toBe(200);
    await expect(downgraded.json()).resolves.toMatchObject({
      role: "access",
    });

    const summary = await dashboardGet(setup, "/dashboard/api/v2/host");
    expect(summary.status).toBe(401);

    const activity = await setup.app.request("http://127.0.0.1:5387/dashboard/api/v2/activity", {
      headers: { cookie: setup.cookie },
    });
    expect(activity.status).toBe(401);

    await setup.engine.close();
    await setup.storage.close();
  });

  it("paginates SQL activity toward older entries and preserves safe valueBytes metadata", async () => {
    const root = tempDir("caplets-dashboard-activity-log-");
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "host.sqlite3"),
    });

    await storage.operatorActivity.append({
      actorClientId: "operator",
      action: "vault_set",
      target: { type: "vault", id: "GH_TOKEN" },
      metadata: { bytesWritten: 42, secretValue: "should-not-log" },
      now: new Date("2026-07-08T10:00:00.000Z"),
    });
    await storage.operatorActivity.append({
      actorClientId: "operator",
      action: "catalog_updated",
      target: { type: "catalog", id: "github" },
      now: new Date("2026-07-08T10:01:00.000Z"),
    });

    const firstPage = await storage.operatorActivity.list({ limit: 1 });
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]).toMatchObject({
      action: "catalog_updated",
      target: { id: "github" },
    });
    expect(firstPage.nextCursor).toBe(firstPage.entries[0]?.id);

    const secondPage = await storage.operatorActivity.list({
      limit: 1,
      after: firstPage.nextCursor,
    });
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]).toMatchObject({
      action: "vault_set",
      target: { id: "GH_TOKEN" },
      metadata: { bytesWritten: 42 },
    });
    expect(secondPage.entries[0]?.metadata).not.toHaveProperty("secretValue");
    await storage.close();
  });
});

type Setup = Awaited<ReturnType<typeof authenticatedDashboard>>;

async function authenticatedDashboard() {
  const setup = await testApp();
  const started = await appPost(setup, "/dashboard/api/login/start", { clientLabel: "Browser" });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
  await setup.store.approvePendingLogin({
    operatorClientId: "bootstrap_test",
    operatorCode: approvalCode(startBody.approvalCommand),
    grantedRole: "operator",
  });
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

async function dashboardPatch(setup: Setup, path: string, body: unknown) {
  return dashboardConditionalMutation(setup, path, "PATCH", body);
}

async function dashboardDelete(setup: Setup, path: string) {
  return dashboardConditionalMutation(setup, path, "DELETE");
}

async function dashboardConditionalMutation(
  setup: Setup,
  path: string,
  method: "PATCH" | "DELETE",
  body?: unknown,
) {
  const current = await dashboardGet(setup, path);
  const etag = current.headers.get("etag");
  if (!etag) throw new Error(`Missing ETag for ${path}`);
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method,
    headers: {
      cookie: setup.cookie,
      "x-caplets-csrf": setup.csrfToken,
      "content-type": method === "PATCH" ? "application/merge-patch+json" : "application/json",
      "idempotency-key": crypto.randomUUID(),
      "if-match": etag,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

async function testApp() {
  const stateDir = tempDir("caplets-dashboard-activity-state-");
  const context = testContext();
  const storage = await createHostStorage(
    { type: "sqlite", path: join(stateDir, "host.sqlite3") },
    { vaultRoot: join(stateDir, "vault") },
  );
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    hostStorage: storage,
    watch: false,
  });
  const store = storage.remoteSecurity;
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: context,
    authoritativeStorage: storage,
  });
  return { app, engine, store, storage, stateDir, context };
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
    adminUploads: {
      stagingDir: join(tmpdir(), "caplets-uploads"),
      maxConcurrent: 1,
      maxStagedBytes: 400_000_000,
    },
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
