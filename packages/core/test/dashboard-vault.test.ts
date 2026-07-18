import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { createHostStorage, VaultValueStore } from "../src/storage";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard Vault APIs", () => {
  it("sets, lists, grants, revokes, deletes, and records redacted activity", async () => {
    const setup = await authenticatedDashboard();
    const secret = "super_secret_dashboard_value";

    const set = await dashboardPost(setup, "/dashboard/api/vault/values", {
      key: "GH_TOKEN",
      value: secret,
    });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({ status: { key: "GH_TOKEN", present: true } });

    const list = await dashboardGet(setup, "/dashboard/api/vault");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain('"key":"GH_TOKEN"');
    expect(listText).not.toContain(secret);

    const grant = await dashboardPost(setup, "/dashboard/api/vault/grants", {
      storedKey: "GH_TOKEN",
      referenceName: "API_TOKEN",
      capletId: "status",
    });
    expect(grant.status).toBe(200);
    const grantBody = await grant.json();
    expect(grantBody).toMatchObject({
      grant: {
        referenceName: "API_TOKEN",
        capletId: "status",
        origin: { kind: "global-config" },
      },
    });
    expect(JSON.stringify(grantBody)).not.toContain(setup.context.configPath);

    const revoke = await dashboardPost(setup, "/dashboard/api/vault/grants/revoke", {
      storedKey: "GH_TOKEN",
      referenceName: "API_TOKEN",
      capletId: "status",
    });
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      revoked: [expect.objectContaining({ storedKey: "GH_TOKEN" })],
    });

    const deleted = await dashboardPost(setup, "/dashboard/api/vault/values/GH_TOKEN/delete", {});
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      deleted: { key: "GH_TOKEN", deleted: true },
    });

    const activity = await dashboardGet(setup, "/dashboard/api/activity");
    expect(activity.status).toBe(200);
    const activityText = await activity.text();
    expect(activityText).not.toContain(secret);
    expect(activityText).toContain('"action":"vault_value_written"');
    expect(activityText).toContain('"action":"vault.grant"');
    expect(activityText).toContain('"action":"vault.revoke"');
    expect(activityText).toContain('"action":"vault_value_deleted"');
    expect(activityText).not.toContain(setup.context.configPath);

    await setup.engine.close();
    await setup.storage.close();
  });

  it("reveals exactly one confirmed key and redacts reveal activity", async () => {
    const setup = await authenticatedDashboard();
    await dashboardPost(setup, "/dashboard/api/vault/values", {
      key: "GH_TOKEN",
      value: "remote_secret",
    });

    const denied = await dashboardPost(setup, "/dashboard/api/vault/reveal", {
      key: "GH_TOKEN",
      confirmation: "reveal WRONG",
    });
    expect(denied.status).toBe(400);

    const revealed = await dashboardPost(setup, "/dashboard/api/vault/reveal", {
      key: "GH_TOKEN",
      confirmation: "reveal GH_TOKEN",
    });
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    await expect(revealed.json()).resolves.toEqual({ key: "GH_TOKEN", value: "remote_secret" });

    const activity = await dashboardGet(
      setup,
      "/dashboard/api/activity?action=vault_value_revealed",
    );
    const text = await activity.text();
    expect(text).toContain('"action":"vault_value_revealed"');
    expect(text).not.toContain("remote_secret");

    await setup.engine.close();
    await setup.storage.close();
  });
  it("maps reveal collaborator faults to internal errors without ending the session", async () => {
    const setup = await authenticatedDashboard();
    await dashboardPost(setup, "/dashboard/api/vault/values", {
      key: "GH_TOKEN",
      value: "remote_secret",
    });
    vi.spyOn(VaultValueStore.prototype, "resolveValue").mockRejectedValue(
      new Error("Vault read failed at /tmp/private token=cap_remote_access_sensitive_value"),
    );

    const response = await dashboardPost(setup, "/dashboard/api/vault/reveal", {
      key: "GH_TOKEN",
      confirmation: "reveal GH_TOKEN",
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Current Host administration failed." },
    });
    expect(body).not.toContain("/tmp/private");
    expect(body).not.toContain("cap_remote_access_sensitive_value");
    expect(response.headers.get("set-cookie")).toBeNull();

    await setup.engine.close();
    await setup.storage.close();
  });
  it("preserves identical opaque Vault bytes through dashboard and bearer adapters", async () => {
    const setup = await authenticatedDashboard();
    const value = " \t\r\n ";

    const dashboardResponse = await dashboardPost(setup, "/dashboard/api/vault/values", {
      key: "DASHBOARD_WHITESPACE",
      value,
    });
    expect(dashboardResponse.status).toBe(200);

    const pending = await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
    });
    await setup.store.approvePendingLogin({
      operatorClientId: setup.operatorClientId,
      operatorCode: pending.operatorCode,
    });
    const operator = await setup.store.completePendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    });
    const bearerResponse = await setup.app.request("http://127.0.0.1:5387/v1/admin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "vault_set",
        arguments: { name: "BEARER_WHITESPACE", value },
      }),
    });
    expect(bearerResponse.status).toBe(200);

    await expect(setup.storage.vaultValues.resolveValue("DASHBOARD_WHITESPACE")).resolves.toBe(
      value,
    );
    await expect(setup.storage.vaultValues.resolveValue("BEARER_WHITESPACE")).resolves.toBe(value);

    await setup.engine.close();
    await setup.storage.close();
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

async function testApp() {
  const stateDir = tempDir("caplets-dashboard-vault-state-");
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
  };
}

function testContext(): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
  globalCapletsRoot: string;
  globalLockfilePath: string;
  authDir: string;
} {
  const dir = tempDir("caplets-dashboard-catalog-");
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  const globalCapletsRoot = join(dir, "global-caplets");
  const authDir = join(dir, "auth");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalCapletsRoot, { recursive: true });
  mkdirSync(authDir, { recursive: true });
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
  return {
    configPath,
    projectConfigPath,
    projectCapletsRoot: projectRoot,
    globalCapletsRoot,
    globalLockfilePath: join(dir, "remote-state", "caplets.lock.json"),
    authDir,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
