import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { FileVaultStore } from "../src/vault";
import type {
  CurrentHostManagementDependencies,
  CurrentHostOperationReceipt,
} from "../src/current-host/operations";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dashboard API read model", () => {
  it("returns Current Host summary, attention, counts, and redacted section links", async () => {
    const setup = await authenticatedDashboard();
    setup.store.createPendingLogin({
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
  });

  it("lists clients, pending logins, and Vault metadata without credential or raw Vault values", async () => {
    const setup = await authenticatedDashboard();
    setup.store.createPendingLogin({
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
  });

  it("keeps injected SQL management behind operator cookie and CSRF checks with target-pinned receipts", async () => {
    const management = dashboardManagementFixture();
    const setup = await authenticatedDashboard(management.dependencies);

    const listed = await dashboardGet(setup, "/dashboard/api/management?resource=host-setting");
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).toContain('"owner":"filesystem"');
    expect(listText).toContain('"underlyingSqlAvailable":true');
    expect(listText).not.toContain("/private/global/config.json");

    const operation = {
      operationId: "operation-dashboard-u9",
      requestIdentity: "request-dashboard-u9",
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "underlying-sql",
      },
    };
    const csrfRejected = await setup.app.request(
      "http://127.0.0.1:5387/dashboard/api/management/mutate",
      {
        method: "POST",
        headers: { cookie: setup.cookie, "content-type": "application/json" },
        body: JSON.stringify(operation),
      },
    );
    expect(csrfRejected.status).toBe(403);
    expect(management.events).not.toContain("reserve");

    const preview = await dashboardPost(setup, "/dashboard/api/management/preview", operation);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      status: "preview",
      target: {
        owner: "sql",
        selector: "underlying-sql",
        consequence: "no-effective-change-while-shadowed",
      },
    });

    const mutated = await dashboardPost(setup, "/dashboard/api/management/mutate", operation);
    expect(mutated.status).toBe(200);
    await expect(mutated.json()).resolves.toMatchObject({
      status: "committed",
      receipt: {
        binding: {
          operationId: operation.operationId,
          logicalHostId: "host-dashboard-u9",
          storeId: "store-dashboard-u9",
          operationNamespace: "namespace-dashboard-u9",
        },
        management: {
          owner: "sql",
          selector: "underlying-sql",
          consequence: "no-effective-change-while-shadowed",
        },
      },
    });

    setup.store.revokeClient(setup.session.operatorClientId);
    const eventCount = management.events.length;
    const revoked = await dashboardGet(setup, "/dashboard/api/management?resource=host-setting");
    expect(revoked.status).toBe(401);
    expect(management.events).toHaveLength(eventCount);

    await setup.engine.close();
  });
});

async function authenticatedDashboard(
  currentHostManagement?: CurrentHostManagementDependencies | undefined,
) {
  const setup = testApp(currentHostManagement);
  const vault = new FileVaultStore({ root: join(setup.authDir, "vault") });
  vault.set("GH_TOKEN", "super-secret-token");
  vault.grantAccess({
    storedKey: "GH_TOKEN",
    referenceName: "GH_TOKEN",
    capletId: "status",
    origin: { kind: "global-config", path: setup.context.configPath },
  });
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
  const completedBody = (await completed.json()) as {
    authenticated: boolean;
    session: { operatorClientId: string; csrfToken: string };
  };
  const cookie = completed.headers.get("set-cookie") ?? "";
  return { ...setup, cookie, session: completedBody.session };
}

async function dashboardGet(
  setup: { app: ReturnType<typeof createHttpServeApp>; cookie: string },
  path: string,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
  });
}

async function dashboardPost(
  setup: {
    app: ReturnType<typeof createHttpServeApp>;
    cookie: string;
    session: { csrfToken: string };
  },
  path: string,
  body: unknown,
) {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      cookie: setup.cookie,
      "content-type": "application/json",
      "x-caplets-csrf": setup.session.csrfToken,
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

function testApp(currentHostManagement?: CurrentHostManagementDependencies | undefined) {
  const stateDir = tempDir("caplets-dashboard-api-state-");
  const authDir = tempDir("caplets-dashboard-api-auth-");
  const context = testContext();
  const engine = new CapletsEngine({
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    authDir,
    watch: false,
  });
  const store = new RemoteServerCredentialStore({ dir: stateDir });
  const app = createHttpServeApp(httpOptions(stateDir), engine, {
    writeErr: () => {},
    control: { ...context, authDir },
    remoteCredentialStore: store,
    currentHostManagement,
  });
  return { app, engine, store, stateDir, authDir, context };
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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function dashboardManagementFixture(): {
  dependencies: CurrentHostManagementDependencies;
  events: string[];
} {
  const events: string[] = [];
  const identity = {
    logicalHostId: "host-dashboard-u9",
    storeId: "store-dashboard-u9",
    operationNamespace: "namespace-dashboard-u9",
  };
  const snapshot = {
    identity,
    versions: { authorityGeneration: 1, effectiveGeneration: 2, securityEpoch: 3 },
    caplets: [],
    hostSettings: [
      { version: 1, key: "telemetry", value: true, updatedAt: "2026-07-15T00:00:00.000Z" },
    ],
    hostSettingVersions: { telemetry: 1 },
    encodedBytes: 0,
    normalizedRows: 1,
  } as const;
  const target = {
    resource: "host-setting",
    id: "telemetry",
    selector: "underlying-sql",
    owner: "sql",
    source: { kind: "sql" },
    effective: true,
    effectiveChanged: false,
    shadowChain: [
      { owner: "sql", source: { kind: "sql" } },
      { owner: "filesystem", source: { kind: "global-config" } },
    ],
    underlyingSqlAvailable: true,
    consequence: "no-effective-change-while-shadowed",
  } as const;
  const reservations = new Set<string>();
  const dependencies: CurrentHostManagementDependencies = {
    storage: {
      identity,
      async reserveOperation(binding) {
        events.push("reserve");
        reservations.add(binding.operationId);
        return { status: "reserved", binding };
      },
      async loadSnapshot(binding) {
        events.push("source-read");
        return { status: "ok", binding, snapshot };
      },
      async mutateCaplet() {
        throw new Error("unexpected Caplet mutation");
      },
      async mutateHostSetting(input) {
        events.push("mutate");
        const receipt: CurrentHostOperationReceipt = {
          status: "committed",
          binding: input.binding,
          aggregateVersion: 2,
          authorityToken: { authorityGeneration: 1, effectiveGeneration: 2 },
          localApplication: "not-applicable",
          convergence: { kind: "single-node" },
          management: target,
        };
        return { status: "committed", receipt };
      },
      async lookupOperation(binding) {
        events.push("lookup");
        return reservations.has(binding.operationId)
          ? { status: "unknown", binding }
          : {
              status: "not_committed",
              binding,
              retryReservationId: `retry_${binding.operationId}`,
            };
      },
      async status(binding) {
        return { status: "unavailable", binding };
      },
    },
    async loadRuntimeSnapshot() {
      events.push("target-query");
      return {
        identity,
        authorityGeneration: 1,
        effectiveGeneration: 2,
        securityEpoch: 3,
        caplets: {},
        hostSettings: {
          telemetry: {
            key: "telemetry",
            owner: "filesystem",
            source: { kind: "global-config", path: "/private/global/config.json" },
            effective: true,
            shadowChain: [
              { owner: "sql", source: { kind: "sql", path: "sql://private" } },
              {
                owner: "filesystem",
                source: { kind: "global-config", path: "/private/global/config.json" },
              },
            ],
            underlyingSql: {
              owner: "sql",
              source: { kind: "sql", path: "sql://private" },
            },
          },
        },
      } as never;
    },
  };
  return { dependencies, events };
}
