import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { createHostStorage } from "../src/storage";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard API read model", () => {
  it("returns Current Host summary, attention, counts, and redacted section links", async () => {
    const setup = await authenticatedDashboard();
    await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Waiting Browser",
    });

    const response = await dashboardGet(setup, "/dashboard/api/summary");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      host: {
        current: true,
        baseUrl: "http://127.0.0.1:5387/",
        dashboardUrl: "http://127.0.0.1:5387/dashboard",
        version: expect.any(String),
      },
      attention: [expect.objectContaining({ kind: "pending-login", severity: "warning" })],
      sections: expect.objectContaining({
        caplets: expect.objectContaining({ count: 1, href: "/dashboard#caplets" }),
        access: expect.objectContaining({ pending: 1 }),
        vault: expect.objectContaining({ count: 1 }),
        settings: expect.objectContaining({ href: "/dashboard#settings" }),
      }),
    });
    expect(
      JSON.stringify(await (await dashboardGet(setup, "/dashboard/api/summary")).json()),
    ).not.toContain(setup.context.configPath);

    await setup.engine.close();
    await setup.storage.close();
  });

  it("lists clients, pending logins, and Vault metadata without credential or raw Vault values", async () => {
    const setup = await authenticatedDashboard();
    await setup.store.createPendingLogin({
      hostUrl: "http://127.0.0.1:5387/",
      requestedRole: "operator",
      clientLabel: "Waiting Browser",
      clientFingerprint: "fp_waiting",
    });

    const clients = await dashboardGet(setup, "/dashboard/api/access/clients");
    expect(clients.status).toBe(200);
    const clientsText = await clients.text();
    expect(clientsText).toContain('"role":"operator"');
    expect(clientsText).not.toContain("cap_remote_access_");
    expect(clientsText).not.toContain("cap_remote_refresh_");

    const pending = await dashboardGet(setup, "/dashboard/api/access/pending-logins");
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      pendingLogins: [
        expect.objectContaining({ requestedRole: "operator", clientFingerprint: "fp_waiting" }),
      ],
    });

    const vault = await dashboardGet(setup, "/dashboard/api/vault");
    expect(vault.status).toBe(200);
    const vaultText = await vault.text();
    expect(vaultText).toContain('"key":"GH_TOKEN"');
    expect(vaultText).toContain('"capletId":"status"');
    expect(vaultText).not.toContain("super-secret-token");

    await setup.engine.close();
    await setup.storage.close();
  });

  it("returns Project Binding and runtime placeholders as mobile-friendly objects", async () => {
    const setup = await authenticatedDashboard();

    const runtime = await dashboardGet(setup, "/dashboard/api/runtime");
    expect(runtime.status).toBe(200);
    await expect(runtime.json()).resolves.toMatchObject({
      runtime: {
        status: "ok",
        bind: "127.0.0.1:5387",
        baseUrl: "http://127.0.0.1:5387/",
      },
      daemon: { restartAvailable: false, stopAvailable: false },
    });

    const binding = await dashboardGet(setup, "/dashboard/api/project-binding");
    expect(binding.status).toBe(200);
    await expect(binding.json()).resolves.toMatchObject({
      projectBinding: {
        state: "disconnected",
        affectedCaplets: [],
        actions: expect.any(Array),
      },
    });

    await setup.engine.close();
    await setup.storage.close();
  });
  it("administers stored Caplet records through authenticated SQL-backed routes", async () => {
    const setup = await authenticatedStoredDashboard();
    const firstDocument = storedDocument("first-command");
    const imported = await dashboardMutation(setup, "/dashboard/api/stored-caplets", "POST", {
      id: "stored",
      document: firstDocument,
      historyLimit: 3,
    });
    expect(imported.status).toBe(201);
    const importedBody = (await imported.json()) as {
      record: { headGeneration: number };
    };
    expect(importedBody.record.headGeneration).toBe(1);

    const listed = await dashboardGet(setup, "/dashboard/api/stored-caplets");
    await expect(listed.json()).resolves.toMatchObject({
      records: [{ id: "stored", headGeneration: 1 }],
    });
    const updated = await dashboardMutation(setup, "/dashboard/api/stored-caplets/stored", "PUT", {
      document: storedDocument("second-command"),
      expectedGeneration: 1,
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      record: { id: "stored", headGeneration: 2 },
    });
    const revisions = await dashboardGet(setup, "/dashboard/api/stored-caplets/stored/revisions");
    await expect(revisions.json()).resolves.toMatchObject({
      revisions: [{ sequence: 2 }, { sequence: 1 }],
    });
    const stale = await dashboardMutation(setup, "/dashboard/api/stored-caplets/stored", "PUT", {
      document: storedDocument("stale-secret-command"),
      expectedGeneration: 1,
    });
    expect(stale.status).toBe(400);
    expect(await stale.text()).not.toContain("stale-secret-command");
    const deleted = await dashboardMutation(
      setup,
      "/dashboard/api/stored-caplets/stored",
      "DELETE",
      { expectedGeneration: 2 },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true, id: "stored" });
    const activity = await setup.storage.installations.listActivity();
    expect(activity.map((entry) => entry.operatorClientId)).toContain(setup.operatorClientId);
    expect(JSON.stringify(activity)).not.toContain("first-command");
    expect(JSON.stringify(activity)).not.toContain("second-command");

    await setup.engine.close();
    await setup.storage.close();
  });

  it("maps authenticated collaborator faults to internal errors without ending the session", async () => {
    const setup = await authenticatedDashboard();
    vi.spyOn(setup.engine, "enabledServers").mockImplementation(() => {
      throw new Error("collaborator failed with cap_remote_access_sensitive_value");
    });

    const response = await dashboardGet(setup, "/dashboard/api/caplets");

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(body).not.toContain("collaborator failed");
    expect(body).not.toContain("cap_remote_access_sensitive_value");
    expect(response.headers.get("set-cookie")).toBeNull();

    await setup.engine.close();
    await setup.storage.close();
  });
});

async function authenticatedDashboard() {
  const setup = await testApp();
  await setup.storage.vaultValues.set("GH_TOKEN", "super-secret-token", {
    operatorClientId: "bootstrap_test",
  });
  await setup.storage.vaultGrants.grant({
    capletId: "status",
    vaultKey: "GH_TOKEN",
    referenceName: "GH_TOKEN",
    originKind: "global-config",
    originPath: setup.context.configPath,
    operator: { role: "operator", clientId: "bootstrap_test" },
  });
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
  return { ...setup, cookie };
}
async function authenticatedStoredDashboard() {
  const stateDir = tempDir("caplets-dashboard-stored-state-");
  const authDir = tempDir("caplets-dashboard-stored-auth-");
  const context = testContext();
  const storage = await createHostStorage(
    { type: "sqlite", path: join(stateDir, "host.sqlite3") },
    { vaultRoot: join(stateDir, "vault") },
  );
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    authDir,
    hostStorage: storage,
    watch: false,
  });
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: { ...context, authDir },
    authoritativeStorage: storage,
  });
  const started = await appPost({ app }, "/dashboard/api/login/start", {
    clientLabel: "Stored Browser",
  });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    approvalCommand: string;
  };
  await storage.remoteSecurity.approvePendingLogin({
    operatorClientId: "bootstrap_test",
    operatorCode: approvalCode(startBody.approvalCommand),
    grantedRole: "operator",
  });
  const completed = await appPost({ app }, "/dashboard/api/login/complete", {
    flowId: startBody.flowId,
    pendingCompletionSecret: startBody.pendingCompletionSecret,
  });
  expect(completed.status).toBe(200);
  const body = (await completed.json()) as {
    session: { csrfToken: string; operatorClientId: string };
  };
  return {
    app,
    engine,
    storage,
    cookie: completed.headers.get("set-cookie") ?? "",
    csrfToken: body.session.csrfToken,
    operatorClientId: body.session.operatorClientId,
  };
}

async function dashboardMutation(
  setup: {
    app: ReturnType<typeof createHttpServeApp>;
    cookie: string;
    csrfToken: string;
  },
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method,
    headers: {
      cookie: setup.cookie,
      "x-caplets-csrf": setup.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function dashboardGet(
  setup: { app: ReturnType<typeof createHttpServeApp>; cookie: string },
  path: string,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
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
  const stateDir = tempDir("caplets-dashboard-api-state-");
  const authDir = tempDir("caplets-dashboard-api-auth-");
  const context = testContext();
  const storage = await createHostStorage(
    { type: "sqlite", path: join(stateDir, "host.sqlite3") },
    { vaultRoot: join(stateDir, "vault") },
  );
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    authDir,
    hostStorage: storage,
    watch: false,
  });
  const store = storage.remoteSecurity;
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: { ...context, authDir },
    authoritativeStorage: storage,
  });
  return { app, engine, store, storage, stateDir, authDir, context };
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
  const dir = tempDir("caplets-dashboard-api-");
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

function storedDocument(command: string): string {
  return [
    "---",
    "name: Stored",
    "description: Stored dashboard fixture.",
    "mcpServer:",
    `  command: ${command}`,
    "---",
    "",
    "# Stored",
    "",
  ].join("\n");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
