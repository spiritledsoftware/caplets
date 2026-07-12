import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCurrentHostOperations,
  trustedDevelopmentOperatorPrincipal,
} from "../src/current-host/operations";
import { AuthorityRemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { createAsyncCapletsRuntime } from "../src/runtime";
import { createHttpServeApp, type CapletsHttpApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { createSqliteAuthority, type SqliteAuthority } from "../src/storage/sql/authority";
import { migrateSqliteDatabase } from "../src/storage/sql/migrate";
import type { VaultAdministrationStore } from "../src/vault";

const roots: string[] = [];
const TEST_VAULT_KEY = Buffer.alloc(32, 11).toString("base64url");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Snapshot = Record<string, unknown>;
type AppliedCommand = { snapshot: Snapshot; result?: unknown };
type Authority = SqliteAuthority<Snapshot, unknown>;
type RuntimeHost = Awaited<ReturnType<typeof createAsyncCapletsRuntime>>;
type DashboardSetup = {
  app: CapletsHttpApp;
  authority: Authority;
  runtime: RuntimeHost;
  store: AuthorityRemoteServerCredentialStore;
  cookie: string;
  csrfToken: string;
  databasePath: string;
  root: string;
};

describe("dashboard authority mutations", () => {
  it("commits executable MCP CRUD, settings, and setup through SQLite and reads back on a replica", async () => {
    const setup = await sqliteDashboard();
    try {
      const before = await setup.runtime.health();
      expect(before.activeGeneration).not.toBeNull();

      const created = await dashboardPost(setup, "/dashboard/api/caplets/create", {
        record: {
          id: "created",
          name: "Created MCP",
          description: "Created by the SQLite dashboard fixture.",
          backend: { transport: "stdio", command: "node", args: ["-e", "process.exit(0)"] },
        },
        expectedGeneration: before.activeGeneration,
        idempotencyKey: "sqlite-create",
      });
      if (created.status !== 200)
        throw new Error(
          `Create failed (${created.status}): ${JSON.stringify(await created.json())}`,
        );
      await expect(created.json()).resolves.toMatchObject({
        operation: "caplet_create",
        status: "active",
        activation: "active",
        caplet: {
          id: "created",
          name: "Created MCP",
          backend: "mcp",
          backendConfig: { transport: "stdio", command: "node" },
        },
      });
      expect((await setup.runtime.health()).connectivity).toBe("healthy");

      const list = await dashboardGet(setup, "/dashboard/api/caplets");
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { caplets?: unknown[] };
      expect(listBody.caplets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "created",
            backendConfig: expect.objectContaining({ command: "node" }),
          }),
        ]),
      );

      const afterCreate = (await setup.runtime.health()).activeGeneration;
      const updated = await dashboardPost(setup, "/dashboard/api/caplets/update", {
        id: "created",
        record: {
          id: "created",
          name: "Updated MCP",
          description: "Updated by the SQLite dashboard fixture.",
          backend: { transport: "stdio", command: "node", args: ["-e", "process.exit(0)"] },
        },
        expectedGeneration: afterCreate,
        idempotencyKey: "sqlite-update",
      });
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({
        operation: "caplet_update",
        status: "active",
        caplet: { id: "created", name: "Updated MCP", backendConfig: { command: "node" } },
      });

      const replica = await openReplica(setup.databasePath);
      try {
        const head = await replica.readHead();
        expect(head?.sequence).toBe((before.activeGeneration?.sequence ?? 0) + 2);
        if (!head) throw new Error("Expected SQLite replica head.");
        const generation = await replica.readGeneration(head.id);
        const snapshot = generation.snapshot;
        expect(snapshot.caplets).toMatchObject({
          created: {
            config: {
              mcpServers: {
                created: { name: "Updated MCP", command: "node", transport: "stdio" },
              },
            },
          },
        });
      } finally {
        await replica.close();
      }

      const afterUpdate = (await setup.runtime.health()).activeGeneration;
      const deleted = await dashboardPost(setup, "/dashboard/api/caplets/delete", {
        id: "created",
        expectedGeneration: afterUpdate,
        idempotencyKey: "sqlite-delete",
      });
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toMatchObject({
        operation: "caplet_delete",
        status: "active",
        activation: "active",
        deleted: true,
      });

      const afterDelete = (await setup.runtime.health()).activeGeneration;
      const settings = await dashboardPost(setup, "/dashboard/api/settings", {
        settings: {
          telemetry: true,
          defaultSearchLimit: 10,
          maxSearchLimit: 20,
          options: { exposure: "direct" },
        },
        expectedGeneration: afterDelete,
        idempotencyKey: "sqlite-settings",
      });
      expect(settings.status).toBe(200);
      await expect(settings.json()).resolves.toMatchObject({
        operation: "settings_update",
        status: "active",
        settings: { telemetry: true, options: { exposure: "direct" } },
      });

      const afterSettings = (await setup.runtime.health()).activeGeneration;
      const grant = await dashboardPost(setup, "/dashboard/api/setup/grant", {
        capletId: "created",
        contentHash: "sha256:created-content",
        targetKind: "local_host",
        expectedGeneration: afterSettings,
        idempotencyKey: "sqlite-grant",
      });
      expect(grant.status).toBe(200);
      await expect(grant.json()).resolves.toMatchObject({
        operation: "setup_grant",
        status: "active",
        approval: { capletId: "created", decision: "grant" },
      });

      const afterGrant = (await setup.runtime.health()).activeGeneration;
      const revoke = await dashboardPost(setup, "/dashboard/api/setup/revoke", {
        capletId: "created",
        contentHash: "sha256:created-content",
        targetKind: "local_host",
        expectedGeneration: afterGrant,
        idempotencyKey: "sqlite-revoke",
      });
      expect(revoke.status).toBe(200);
      await expect(revoke.json()).resolves.toMatchObject({
        operation: "setup_revoke",
        status: "active",
        approval: { capletId: "created", decision: "revoke" },
      });
      expect((await setup.runtime.health()).connectivity).toBe("healthy");
    } finally {
      await setup.runtime.close();
      await setup.authority.close();
    }
  });
  it("cleans authority dashboard auxiliary state when the dashboard revokes its own client", async () => {
    const setup = await sqliteDashboard();
    try {
      const sessionResponse = await dashboardGet(setup, "/dashboard/api/session");
      expect(sessionResponse.status).toBe(200);
      const sessionBody = (await sessionResponse.json()) as {
        session: { sessionId: string; operatorClientId: string };
      };
      const before = await setup.authority.readAuxiliary({
        kind: "session_touch",
        sessionId: sessionBody.session.sessionId,
      });
      expect(before).toMatchObject({ revoked: false });

      const revoke = await dashboardPost(
        setup,
        `/dashboard/api/access/clients/${encodeURIComponent(sessionBody.session.operatorClientId)}/revoke`,
        {},
      );
      expect(revoke.status).toBe(200);
      await expect(revoke.json()).resolves.toMatchObject({
        revoked: true,
        sessionEnded: true,
      });
      expect(
        await setup.authority.readAuxiliary({
          kind: "session_touch",
          sessionId: sessionBody.session.sessionId,
        }),
      ).toBeNull();
      expect((await dashboardGet(setup, "/dashboard/api/session")).status).toBe(401);
    } finally {
      await setup.runtime.close();
      await setup.authority.close();
    }
  });
  it("preserves existing records when mutating an array-backed authority snapshot", async () => {
    const setup = await sqliteDashboard(true);
    try {
      const before = await setup.runtime.health();
      const created = await dashboardPost(setup, "/dashboard/api/caplets/create", {
        record: {
          id: "created",
          name: "Created MCP",
          description: "Created against an array-backed authority snapshot.",
          backend: { transport: "stdio", command: "node", args: ["-e", "process.exit(0)"] },
        },
        expectedGeneration: before.activeGeneration,
        idempotencyKey: "sqlite-array-create",
      });
      expect(created.status).toBe(200);

      const head = await setup.authority.readHead();
      if (!head) throw new Error("Expected SQLite authority head.");
      const generation = await setup.authority.readGeneration(head.id);
      expect(generation.snapshot.caplets).toMatchObject({
        status: { id: "status" },
        created: { id: "created" },
      });
    } finally {
      await setup.runtime.close();
      await setup.authority.close();
    }
  });
  it("replays create, update, settings, and setup mutations before stale-state validation", async () => {
    const setup = await sqliteDashboard();
    try {
      const before = await setup.runtime.health();
      const createBody = {
        record: {
          id: "replay-created",
          name: "Replay Created",
          description: "Created for replay coverage.",
          backend: { transport: "stdio", command: "node", args: ["-e", "process.exit(0)"] },
        },
        expectedGeneration: before.activeGeneration,
        idempotencyKey: "replay-create",
      };
      const created = await dashboardPost(setup, "/dashboard/api/caplets/create", createBody);
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as Record<string, unknown>;
      const createdReplay = await dashboardPost(setup, "/dashboard/api/caplets/create", createBody);
      expect(createdReplay.status).toBe(200);
      await expect(createdReplay.json()).resolves.toEqual({
        ...createdBody,
        replayed: true,
      });
      const changedCreate = await dashboardPost(setup, "/dashboard/api/caplets/create", {
        ...createBody,
        record: { ...createBody.record, name: "Changed Payload" },
      });
      expect(changedCreate.status).toBe(400);

      const afterCreate = (await setup.runtime.health()).activeGeneration;
      const updateBody = {
        id: "replay-created",
        record: {
          id: "replay-created",
          name: "Replay Updated",
          description: "Updated for replay coverage.",
          backend: { transport: "stdio", command: "node", args: ["-e", "process.exit(0)"] },
        },
        expectedGeneration: afterCreate,
        idempotencyKey: "replay-update",
      };
      const updated = await dashboardPost(setup, "/dashboard/api/caplets/update", updateBody);
      expect(updated.status).toBe(200);
      const updatedBody = (await updated.json()) as Record<string, unknown>;
      const updatedReplay = await dashboardPost(setup, "/dashboard/api/caplets/update", updateBody);
      expect(updatedReplay.status).toBe(200);
      await expect(updatedReplay.json()).resolves.toEqual({
        ...updatedBody,
        replayed: true,
      });
      const changedUpdate = await dashboardPost(setup, "/dashboard/api/caplets/update", {
        ...updateBody,
        record: { ...updateBody.record, name: "Changed Update Payload" },
      });
      expect(changedUpdate.status).toBe(400);

      const afterUpdate = (await setup.runtime.health()).activeGeneration;
      const settingsBody = {
        settings: {
          telemetry: true,
          defaultSearchLimit: 10,
          maxSearchLimit: 20,
          options: { exposure: "direct" },
        },
        expectedGeneration: afterUpdate,
        idempotencyKey: "replay-settings",
      };
      const settings = await dashboardPost(setup, "/dashboard/api/settings", settingsBody);
      expect(settings.status).toBe(200);
      const settingsResult = (await settings.json()) as Record<string, unknown>;
      const settingsReplay = await dashboardPost(setup, "/dashboard/api/settings", settingsBody);
      expect(settingsReplay.status).toBe(200);
      await expect(settingsReplay.json()).resolves.toEqual({
        ...settingsResult,
        replayed: true,
      });
      const changedSettings = await dashboardPost(setup, "/dashboard/api/settings", {
        ...settingsBody,
        settings: { ...settingsBody.settings, telemetry: false },
      });
      expect(changedSettings.status).toBe(400);

      const afterSettings = (await setup.runtime.health()).activeGeneration;
      const setupBody = {
        capletId: "replay-created",
        contentHash: "sha256:replay-content",
        targetKind: "local_host" as const,
        expectedGeneration: afterSettings,
        idempotencyKey: "replay-setup",
      };
      const granted = await dashboardPost(setup, "/dashboard/api/setup/grant", setupBody);
      expect(granted.status).toBe(200);
      const grantedBody = (await granted.json()) as Record<string, unknown>;
      const grantedReplay = await dashboardPost(setup, "/dashboard/api/setup/grant", setupBody);
      expect(grantedReplay.status).toBe(200);
      await expect(grantedReplay.json()).resolves.toEqual({
        ...grantedBody,
        replayed: true,
      });
      const changedSetup = await dashboardPost(setup, "/dashboard/api/setup/grant", {
        ...setupBody,
        contentHash: "sha256:changed-content",
      });
      expect(changedSetup.status).toBe(400);

      expect((await setup.authority.readHead())?.sequence).toBe(
        (before.activeGeneration?.sequence ?? 0) + 4,
      );
    } finally {
      await setup.runtime.close();
      await setup.authority.close();
    }
  });

  it("stores shared mutation success activity once in the authority generation", async () => {
    const setup = await sqliteDashboard();
    let replicaAuthority: Authority | undefined;
    let replicaRuntime: RuntimeHost | undefined;
    try {
      const before = await setup.runtime.health();
      const principal = trustedDevelopmentOperatorPrincipal("http://127.0.0.1:5387/");
      const operation = {
        kind: "caplet_create" as const,
        record: {
          id: "activity-once",
          config: {
            mcpServers: {
              "activity-once": {
                name: "Activity Once",
                description: "One authority activity entry.",
                transport: "stdio",
                command: "node",
                args: ["-e", "process.exit(0)"],
              },
            },
          },
        },
        expectedGeneration: before.activeGeneration,
        idempotencyKey: "activity-once",
      };
      const firstOperations = createCurrentHostOperations({
        engine: setup.runtime.engine,
        runtime: setup.runtime,
        control: { authorityId: "dashboard-sqlite", currentHostId: "shared-current-host" },
        activityLog: new DashboardActivityLog({ dir: join(setup.root, "activity-a") }),
        version: "test-version",
      });
      await firstOperations.execute(principal, operation);

      replicaAuthority = await openReplica(setup.databasePath);
      replicaRuntime = await createAsyncCapletsRuntime({
        authority: replicaAuthority,
        bootstrap: {
          provider: "sqlite",
          authorityId: "dashboard-sqlite",
          namespace: "dashboard",
          databasePath: setup.databasePath,
          pollIntervalMs: 1_000,
          vaultKeyRef: "dashboard-test-vault-key",
        },
        secretResolver: (reference) =>
          reference === "dashboard-test-vault-key" ? TEST_VAULT_KEY : undefined,
        configPath: join(setup.root, "missing-replica-config.json"),
        projectConfigPath: join(setup.root, "missing-replica-project.json"),
        staged: [],
        autoRefresh: false,
        readDeadlineMs: 500,
        activationDeadlineMs: 500,
        writeErr: () => {},
      });
      const secondOperations = createCurrentHostOperations({
        engine: replicaRuntime.engine,
        runtime: replicaRuntime,
        control: { authorityId: "dashboard-sqlite", currentHostId: "shared-current-host" },
        activityLog: new DashboardActivityLog({ dir: join(setup.root, "activity-b") }),
        version: "test-version",
      });
      const replay = await secondOperations.execute(principal, operation);
      expect(replay).toEqual(expect.objectContaining({ kind: "caplet_create", replayed: true }));

      const head = await setup.authority.readHead();
      if (!head) throw new Error("Expected authority head after shared mutation.");
      const generation = await setup.authority.readGeneration(head.id);
      const entries: unknown[] = Array.isArray(generation.snapshot.dashboardActivity)
        ? generation.snapshot.dashboardActivity
        : [];
      expect(
        entries.filter((entry) => isRecord(entry) && entry.action === "caplet_created"),
      ).toHaveLength(1);
      const listed = await secondOperations.execute(principal, {
        kind: "activity_list",
      });
      if (listed.kind !== "activity_list") throw new Error("Expected activity list outcome.");
      expect(
        listed.activity.entries.filter((entry) => entry.action === "caplet_created"),
      ).toHaveLength(1);
    } finally {
      await replicaRuntime?.close();
      await replicaAuthority?.close();
      await setup.runtime.close();
      await setup.authority.close();
    }
  });
});

async function sqliteDashboard(arrayBacked = false): Promise<DashboardSetup> {
  const root = await mkdtemp(join(tmpdir(), "caplets-dashboard-sqlite-"));
  roots.push(root);
  const databasePath = join(root, "authority.sqlite");
  const authorityId = "dashboard-sqlite";
  const namespace = "dashboard";
  await migrateSqliteDatabase({ databasePath, authorityId, namespace });
  const seedConfig = {
    httpApis: {
      status: {
        name: "Status API",
        description: "A status API for the SQLite dashboard fixture.",
        baseUrl: "http://127.0.0.1:1",
        auth: { type: "none" },
        actions: { check: { method: "GET", path: "/check" } },
      },
    },
  };
  const authority = await createSqliteAuthority<Snapshot, unknown>({
    databasePath,
    authorityId,
    namespace,
    initialSnapshot: { caplets: {} },
    applyCommand: ({ snapshot, command }) => {
      const value = command as {
        snapshot?: unknown;
        result?: unknown;
        command?: unknown;
      };
      if (!isRecord(value.snapshot)) {
        return { snapshot: snapshot as Snapshot, result: value.result ?? value.command };
      }
      return {
        snapshot: value.snapshot as Snapshot,
        result: value.result ?? value.command,
      } satisfies AppliedCommand;
    },
  });
  const seeded = await authority.commit({
    authorityId,
    currentHostId: "seed",
    principalId: "seed",
    expectedGeneration: null,
    idempotencyKey: "seed",
    requestDigest: "seed",
    command: {
      kind: "replace_snapshot",
      snapshot: {
        caplets: arrayBacked
          ? [{ id: "status", config: seedConfig }]
          : { status: { id: "status", config: seedConfig } },
      },
    },
  });
  if (seeded.kind !== "committed") throw new Error("Expected SQLite seed generation.");
  const runtime = await createAsyncCapletsRuntime({
    authority,
    bootstrap: {
      provider: "sqlite",
      authorityId,
      namespace,
      databasePath,
      pollIntervalMs: 1_000,
      vaultKeyRef: "dashboard-test-vault-key",
    },
    secretResolver: (reference) =>
      reference === "dashboard-test-vault-key" ? TEST_VAULT_KEY : undefined,
    configPath: join(root, "missing-config.json"),
    projectConfigPath: join(root, "missing-project.json"),
    staged: [],
    autoRefresh: false,
    readDeadlineMs: 500,
    activationDeadlineMs: 500,
    writeErr: () => {},
  });
  const stateDir = join(root, "state");
  const authDir = join(root, "auth");
  const store = new AuthorityRemoteServerCredentialStore({
    authority,
    authorityId,
    currentHostId: "http-current-host",
    principalId: "remote-credentials",
    encryptionKey: TEST_VAULT_KEY,
  });
  const options: HttpServeOptions = {
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
  const app = createHttpServeApp(options, runtime.engine, {
    writeErr: () => {},
    control: {
      configPath: join(root, "missing-config.json"),
      projectConfigPath: join(root, "missing-project.json"),
      projectCapletsRoot: join(root, "project-caplets"),
      authDir,
    },
    vaultStore: unusedVaultStore(),
    remoteCredentialAuthorityStore: store,
    runtime,
  });
  const started = await app.request("http://127.0.0.1:5387/dashboard/api/login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLabel: "SQLite browser" }),
  });
  const startBody = (await started.json()) as {
    flowId: string;
    pendingCompletionSecret: string;
    operatorCode?: string;
    approvalCommand?: string;
  };
  const operatorCode =
    startBody.operatorCode ??
    startBody.approvalCommand?.match(/approve\s+(cap_login_[^\s]+)/u)?.[1];
  if (!operatorCode) throw new Error("Expected SQLite dashboard operator code.");
  await store.approvePendingLogin({ operatorCode });
  const completed = await app.request("http://127.0.0.1:5387/dashboard/api/login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: startBody.flowId,
      pendingCompletionSecret: startBody.pendingCompletionSecret,
    }),
  });
  if (completed.status !== 200) throw new Error(`Dashboard login failed: ${completed.status}`);
  const completedBody = (await completed.json()) as { session: { csrfToken: string } };
  await runtime.refresh();
  return {
    app,
    authority,
    runtime,
    store,
    cookie: completed.headers.get("set-cookie") ?? "",
    csrfToken: completedBody.session.csrfToken,
    databasePath,
    root,
  };
}

async function openReplica(databasePath: string): Promise<Authority> {
  return await createSqliteAuthority<Snapshot, unknown>({
    databasePath,
    authorityId: "dashboard-sqlite",
    namespace: "dashboard",
    initialSnapshot: { caplets: {} },
    applyCommand: ({ command }) => {
      const value = command as { snapshot?: unknown };
      if (!isRecord(value.snapshot)) throw new Error("Expected replica snapshot.");
      return { snapshot: value.snapshot as Snapshot };
    },
  });
}

async function dashboardPost(
  setup: DashboardSetup,
  path: string,
  body: unknown,
): Promise<Response> {
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

async function dashboardGet(setup: DashboardSetup, path: string): Promise<Response> {
  return await setup.app.request(`http://127.0.0.1:5387${path}`, {
    headers: { cookie: setup.cookie },
  });
}

function unusedVaultStore(): VaultAdministrationStore {
  const unused = async (): Promise<never> => {
    throw new Error("Vault is not part of this dashboard mutation fixture.");
  };
  return {
    set: unused,
    getStatus: unused,
    listValues: unused,
    delete: unused,
    grantAccess: unused,
    listAccess: unused,
    revokeAccess: unused,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
