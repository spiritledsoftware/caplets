import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresStorageConfig } from "../src/config";
import type { PostgresControlPlaneDialect } from "../src/control-plane/dialect/postgres";
import type { ResolvedPostgresStorage } from "../src/control-plane/storage-config";
import * as migrationExclusion from "../src/control-plane/migration/exclusion";
import {
  createProductionControlPlane,
  runProductionControlPlaneOfflineMigration,
  resolveProductionPostgresProcessProfile,
  resolveProductionPostgresRuntimeProfile,
  runProductionPostgresOperationalStartup,
} from "../src/control-plane/production-runtime";
import { RuntimeAssetCache } from "../src/control-plane/runtime-caches";
import { createCapletsEngine } from "../src/engine";
import { hashInstalledArtifact } from "../src/cli/install";
import { writeCapletsLockfile } from "../src/cli/lockfile";
import { FileVaultStore } from "../src/vault";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function postgresStorage(): PostgresStorageConfig {
  return {
    kind: "postgres",
    stateRoot: "/var/lib/caplets/node",
    logicalHostId: "host_01J00000000000000000000000",
    expectedStoreId: "store_01J00000000000000000000000",
    processRole: "online",
    connection: {
      tls: {
        mode: "verify-full",
        serverName: "postgres.internal",
        ca: { kind: "env", name: "CAPLETS_PG_CA" },
      },
      roles: {
        runtime: {
          role: "caplets_runtime",
          credential: { kind: "env", name: "CAPLETS_PG_RUNTIME_URL" },
        },
        migrator: {
          role: "caplets_migrator",
          credential: { kind: "file", path: "/run/secrets/pg-migrator" },
        },
        maintenance: {
          role: "caplets_maintenance",
          credential: { kind: "file", path: "/run/secrets/pg-maintenance" },
        },
      },
    },
    keyProviderManifest: "/run/secrets/caplets/online.manifest.json",
    artifacts: {
      kind: "s3",
      endpoint: "https://objects.internal",
      region: "us-east-1",
      bucket: "caplets-control-plane",
      prefix: "hosts/current",
      canary: { kind: "env", name: "CAPLETS_S3_CANARY" },
      credentials: {
        accessKeyId: { kind: "env", name: "CAPLETS_S3_ACCESS_KEY_ID" },
        secretAccessKey: { kind: "file", path: "/run/secrets/s3-secret-key" },
      },
    },
    migration: { designated: false },
    retention: { backupDays: 30 },
  };
}

function resolvedPostgresStorage(): ResolvedPostgresStorage {
  const storage = postgresStorage();
  return {
    backend: "postgres",
    logicalHostId: storage.logicalHostId,
    storeId: storage.expectedStoreId,
    operationNamespace: "namespace_01J00000000000000000000",
    stateRoot: storage.stateRoot,
    keyProviderManifest: storage.keyProviderManifest,
    artifacts: {} as ResolvedPostgresStorage["artifacts"],
  };
}

describe("production SQL runtime activation", () => {
  it("resolves only online credentials and requires an explicitly encrypted Postgres URI", async () => {
    const accessed: string[] = [];
    const storage = postgresStorage();
    const profile = await resolveProductionPostgresRuntimeProfile(
      storage,
      {},
      async (reference) => {
        const identity = reference.kind === "env" ? reference.name : reference.path;
        accessed.push(identity);
        return reference.kind === "env" && reference.name === "CAPLETS_PG_RUNTIME_URL"
          ? "postgresql://caplets_runtime:secret@postgres.internal/caplets?sslmode=require"
          : "trusted-ca";
      },
    );

    expect(accessed).toEqual(["CAPLETS_PG_RUNTIME_URL", "CAPLETS_PG_CA"]);
    expect(profile).toMatchObject({ role: "caplets_runtime", tls: { mode: "verify-full" } });
    await expect(
      resolveProductionPostgresRuntimeProfile(storage, {}, async (reference) =>
        reference.kind === "env" && reference.name === "CAPLETS_PG_RUNTIME_URL"
          ? "postgresql://caplets_runtime:secret@postgres.internal/caplets?sslmode=disable"
          : "trusted-ca",
      ),
    ).rejects.toThrow(/connection string is invalid/u);
    await expect(
      resolveProductionPostgresRuntimeProfile(
        { ...storage, processRole: "migrator", migration: { designated: true } },
        {},
        async () => {
          throw new Error("credential resolver must not run");
        },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects operational roles before resolving any serving credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-role-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        serve: {
          storage: {
            ...postgresStorage(),
            processRole: "migrator",
            migration: { designated: true },
          },
        },
      }),
      "utf8",
    );
    writeFileSync(projectConfigPath, "{}", "utf8");
    let resolutions = 0;
    await expect(
      createProductionControlPlane({
        configPath,
        projectConfigPath,
        storage: {
          resolveSecret: async () => {
            resolutions += 1;
            return "unused";
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(resolutions).toBe(0);
  });

  it("selects one designated operational role and runs only its one-shot startup action", async () => {
    const migratorStorage: PostgresStorageConfig = {
      ...postgresStorage(),
      processRole: "migrator",
      migration: { designated: true },
    };
    const accessed: string[] = [];
    const profile = await resolveProductionPostgresProcessProfile(
      migratorStorage,
      {},
      async (reference) => {
        const identity = reference.kind === "env" ? reference.name : reference.path;
        accessed.push(identity);
        return reference.kind === "file"
          ? "postgresql://caplets_migrator:secret@postgres.internal/caplets?sslmode=verify-full"
          : "trusted-ca";
      },
    );
    expect(accessed).toEqual(["/run/secrets/pg-migrator", "CAPLETS_PG_CA"]);
    expect(profile.role).toBe("caplets_migrator");

    let migrated = 0;
    let closed = 0;
    const dialect = {
      async beginMigrationDrain() {
        return { gateId: "test-gate", status: "active" as const };
      },
      async releaseMigrationDrain(_gateId: string, outcome: string) {
        expect(outcome).toBe("finalized");
      },
      async migrate() {
        migrated += 1;
        return ["0005"];
      },
      async close() {
        closed += 1;
      },
    } as unknown as PostgresControlPlaneDialect;
    await expect(
      runProductionPostgresOperationalStartup({
        storage: migratorStorage,
        deployment: resolvedPostgresStorage(),
        resolveSecret: async (reference) =>
          reference.kind === "file"
            ? "postgresql://caplets_migrator:secret@postgres.internal/caplets?sslmode=require"
            : "trusted-ca",
        openDialect: async (options) => {
          expect(options.runtimeRole).toBe("caplets_runtime");
          return dialect;
        },
        verifyOldNodesDrained: async () => true,
      }),
    ).resolves.toEqual({ role: "migrator", migrations: ["0005"] });
    expect({ migrated, closed }).toEqual({ migrated: 1, closed: 1 });
  });

  it("holds a durable migration drain while checking for old-node reentry", async () => {
    const events: string[] = [];
    let drainChecks = 0;
    const dialect = {
      async beginMigrationDrain(gateId: string) {
        events.push("gate-begin");
        return { gateId, status: "active" as const };
      },
      async releaseMigrationDrain(_gateId: string, outcome: string) {
        events.push(`gate-${outcome}`);
      },
      async migrate() {
        events.push("migrate");
        return ["0005"];
      },
      async close() {
        events.push("close");
      },
    } as unknown as PostgresControlPlaneDialect;

    await expect(
      runProductionPostgresOperationalStartup({
        storage: {
          ...postgresStorage(),
          processRole: "migrator",
          migration: { designated: true },
        },
        deployment: resolvedPostgresStorage(),
        resolveSecret: async (reference) =>
          reference.kind === "file"
            ? "postgresql://caplets_migrator:secret@postgres.internal/caplets?sslmode=require"
            : "trusted-ca",
        openDialect: async () => {
          events.push("dialect-open");
          return dialect;
        },
        verifyOldNodesDrained: async () => {
          drainChecks += 1;
          events.push(`drain-${drainChecks}`);
          return drainChecks === 1;
        },
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

    expect(events).toEqual([
      "drain-1",
      "dialect-open",
      "gate-begin",
      "drain-2",
      "gate-rolled-back",
      "close",
    ]);
  });

  it("requires explicit legacy inputs before a maintenance credential is touched", async () => {
    let resolutions = 0;
    await expect(
      runProductionPostgresOperationalStartup({
        storage: {
          ...postgresStorage(),
          processRole: "maintenance",
          migration: { designated: true },
        },
        deployment: resolvedPostgresStorage(),
        resolveSecret: async () => {
          resolutions += 1;
          return "unused";
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(resolutions).toBe(0);

    let initialized = 0;
    let closed = 0;
    const maintenanceDialect = {
      async close() {
        closed += 1;
      },
    } as unknown as PostgresControlPlaneDialect;
    await expect(
      runProductionPostgresOperationalStartup({
        storage: {
          ...postgresStorage(),
          processRole: "maintenance",
          migration: { designated: true },
        },
        deployment: resolvedPostgresStorage(),
        resolveSecret: async (reference) =>
          reference.kind === "file"
            ? "postgresql://caplets_maintenance:secret@postgres.internal/caplets?sslmode=require"
            : "trusted-ca",
        openDialect: async () => maintenanceDialect,
        verifyOldNodesDrained: async () => true,
        async initializeLegacy() {
          initialized += 1;
          return { status: "migrated", backend: "postgres" };
        },
      }),
    ).resolves.toEqual({
      role: "maintenance",
      initialization: { status: "migrated", backend: "postgres" },
    });
    expect({ initialized, closed }).toEqual({ initialized: 1, closed: 1 });
  });

  it("refuses reviewed legacy mutable authority before fresh SQLite activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-legacy-"));
    roots.push(root);
    const stateHome = join(root, "state-home");
    const authDir = join(root, "legacy-auth");
    const vaultRoot = join(stateHome, "caplets", "vault");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    const sqlStateRoot = join(root, "sql");

    mkdirSync(join(authDir, "remote-server"), { recursive: true, mode: 0o700 });
    mkdirSync(join(vaultRoot, "values"), { recursive: true, mode: 0o700 });
    writeFileSync(join(authDir, "fixture.json"), JSON.stringify({ server: "fixture" }), {
      mode: 0o600,
    });
    writeFileSync(
      join(authDir, "remote-server", "remote-server-credentials.json"),
      JSON.stringify({ version: 1, clients: [{ id: "client-1" }] }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(authDir, "remote-server", "dashboard-sessions.json"),
      JSON.stringify({ version: 1, sessions: [{ id: "session-1" }] }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(vaultRoot, "values", "token.json"),
      JSON.stringify({ ciphertext: "value" }),
      {
        mode: 0o600,
      },
    );
    writeFileSync(
      join(vaultRoot, "access-grants.json"),
      JSON.stringify([{ storedKey: "token", capletId: "fixture" }]),
      { mode: 0o600 },
    );
    writeFileSync(
      join(stateHome, "caplets", "caplets.lock.json"),
      JSON.stringify({ version: 1, entries: [] }),
      { mode: 0o600 },
    );
    writeFileSync(
      configPath,
      JSON.stringify({ serve: { storage: { kind: "sqlite", stateRoot: sqlStateRoot } } }),
      "utf8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            name: "Fixture",
            description: "Legacy refusal fixture.",
            command: process.execPath,
            args: ["-e", ""],
          },
        },
      }),
      "utf8",
    );

    const startup = {
      configPath,
      projectConfigPath,
      authDir,
      env: { XDG_STATE_HOME: stateHome },
    };
    await expect(createProductionControlPlane(startup)).rejects.toThrow(
      /caplets storage migrate --global --offline/u,
    );

    rmSync(authDir, { recursive: true, force: true });
    rmSync(vaultRoot, { recursive: true, force: true });
    rmSync(join(stateHome, "caplets", "caplets.lock.json"), { force: true });
    const fresh = await createProductionControlPlane(startup);
    try {
      expect(fresh.initialSnapshot.authorityGeneration).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it("refuses a complete reviewed legacy boundary when privileged exclusion cannot be proven", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-legacy-"));
    roots.push(root);
    const stateRoot = join(root, "sql-state");
    const legacyRoot = join(root, "legacy");
    const authDir = join(legacyRoot, "auth");
    const vaultRoot = join(authDir, "vault");
    const globalRoot = root;
    mkdirSync(join(authDir, "remote-server"), { recursive: true });
    mkdirSync(join(authDir, "remote-profiles", "profiles"), { recursive: true });
    mkdirSync(join(authDir, "remote-profiles", "credentials"), { recursive: true });
    mkdirSync(join(authDir, "remote-profiles", "selections"), { recursive: true });
    chmodSync(legacyRoot, 0o700);
    mkdirSync(globalRoot, { recursive: true });
    const trackedPath = join(globalRoot, "tracked.md");
    writeFileSync(
      trackedPath,
      [
        "---",
        "name: Tracked legacy Caplet",
        "description: A complete config-root legacy Caplet.",
        "mcpServer:",
        "  command: node",
        "  args:",
        '    - "-e"',
        '    - ""',
        "---",
        "# Tracked legacy Caplet",
        "",
      ].join("\n"),
    );
    writeCapletsLockfile(join(legacyRoot, "caplets.lock.json"), {
      version: 1,
      entries: [
        {
          id: "tracked",
          destination: "tracked.md",
          kind: "file",
          source: {
            type: "git",
            repository: "https://example.test/caplets.git",
            path: "caplets/tracked.md",
            resolvedRevision: "abc123",
            portability: "portable",
          },
          installedHash: hashInstalledArtifact(trackedPath),
          installedAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          risk: {
            backendFamilies: ["mcp"],
            safety: "standard",
            projectBindingRequired: false,
            mutating: false,
            destructive: false,
          },
        },
      ],
    });
    writeFileSync(
      join(authDir, "remote-server", "remote-server-credentials.json"),
      JSON.stringify({
        version: 1,
        pairingCodes: [],
        pendingLogins: [],
        clients: [
          {
            clientId: "client-legacy",
            clientLabel: "Legacy operator",
            role: "operator",
            hostUrl: "https://legacy.example",
            refreshTokenHash: "a".repeat(64),
            supersededRefreshTokenHashes: [],
            issuedAt: "2026-07-15T00:00:00.000Z",
            lastUsedAt: "2026-07-15T01:00:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      join(authDir, "remote-server", "dashboard-sessions.json"),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "session-legacy",
            secretHash: "b".repeat(64),
            operatorClientId: "client-legacy",
            role: "operator",
            csrfToken: "csrf-legacy",
            createdAt: "2026-07-15T00:00:00.000Z",
            expiresAt: "2026-07-16T00:00:00.000Z",
            lastUsedAt: "2026-07-15T01:00:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      join(authDir, "remote-profiles", "profiles", "profile-legacy.json"),
      JSON.stringify({
        version: 1,
        kind: "cloud",
        key: "profile-legacy",
        hostUrl: "https://cloud.example",
        workspaceId: "workspace-legacy",
        workspaceSlug: "legacy-workspace",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T01:00:00.000Z",
      }),
    );
    writeFileSync(
      join(authDir, "remote-profiles", "credentials", "profile-legacy.json"),
      JSON.stringify({
        accessToken: "legacy-access-token",
        refreshToken: "legacy-refresh-token",
        expiresAt: "2026-07-16T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(authDir, "remote-profiles", "selections", "cloud.example.json"),
      JSON.stringify({
        version: 1,
        hostUrl: "https://cloud.example",
        workspace: "workspace-legacy",
        profileKey: "profile-legacy",
        selectedAt: "2026-07-15T01:00:00.000Z",
      }),
    );
    writeFileSync(
      join(authDir, "cloud-auth.json"),
      JSON.stringify({
        version: 2,
        cloudUrl: "https://cloud.example",
        workspaceId: "workspace-legacy",
        accessToken: "legacy-cloud-access",
        refreshToken: "legacy-cloud-refresh",
        expiresAt: "2026-07-16T00:00:00.000Z",
        credentialFamilyId: "cloud-family-legacy",
      }),
    );
    new FileVaultStore({ root: vaultRoot, env: {} }).set("LEGACY_SECRET", "preserved-value", {
      now: new Date("2026-07-15T00:00:00.000Z"),
    });
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({ serve: { storage: { kind: "sqlite", stateRoot } } }),
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            name: "Fixture",
            description: "Migration activation fixture.",
            command: process.execPath,
            args: ["-e", ""],
          },
        },
      }),
    );

    await expect(
      createProductionControlPlane({
        configPath,
        projectConfigPath,
        authDir,
      }),
    ).rejects.toThrow(/caplets storage migrate --global --offline/u);
    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(trackedPath)).toBe(true);
    expect(existsSync(join(authDir, "remote-server", "remote-server-credentials.json"))).toBe(true);
    expect(existsSync(join(authDir, "remote-server", "dashboard-sessions.json"))).toBe(true);
    expect(new FileVaultStore({ root: vaultRoot, env: {} }).resolveValue("LEGACY_SECRET")).toBe(
      "preserved-value",
    );
    if (process.platform !== "linux") return;
    const procRoot = join(root, "complete-proc-fixture");
    mkdirSync(procRoot);
    const acquireExclusion = migrationExclusion.acquireLegacyMigrationExclusion;
    vi.spyOn(migrationExclusion, "acquireLegacyMigrationExclusion").mockImplementation((options) =>
      acquireExclusion({
        ...options,
        platformOptions: {
          linux: {
            procRootForTests: procRoot,
            proof: { kind: "offline", allReplicasStopped: true },
          },
        },
      }),
    );
    await expect(
      runProductionControlPlaneOfflineMigration({
        configPath,
        projectConfigPath,
        authDir,
      }),
    ).resolves.toMatchObject({ status: "migrated", backend: "sqlite" });
    const activated = await createProductionControlPlane({
      configPath,
      projectConfigPath,
      authDir,
    });
    const persisted = await activated.store.loadSnapshot();
    try {
      expect(persisted.caplets.map((entry) => entry.aggregate.id)).toContain("tracked");
      expect(
        persisted.caplets.find((entry) => entry.aggregate.id === "tracked")?.projection.body,
      ).toContain("Tracked legacy Caplet");
      expect((await activated.security.listClients()).map((entry) => entry.clientId)).toContain(
        "client-legacy",
      );
      expect((await activated.security.listValues()).map((entry) => entry.key)).toContain(
        "LEGACY_SECRET",
      );
      for (const sqlPath of [
        join(stateRoot, "control-plane.sqlite3"),
        join(stateRoot, "control-plane.sqlite3-wal"),
      ]) {
        if (!existsSync(sqlPath)) continue;
        const sqlBytes = readFileSync(sqlPath);
        for (const plaintext of [
          "preserved-value",
          "legacy-cloud-access",
          "legacy-cloud-refresh",
          "remote-profile-token",
        ]) {
          expect(sqlBytes.includes(Buffer.from(plaintext))).toBe(false);
        }
      }
    } finally {
      await activated.close();
    }
  });

  it("keeps engine and activated service on one generation when asset publication fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-publication-"));
    roots.push(root);
    vi.stubEnv("XDG_STATE_HOME", join(root, "state-home"));
    const stateRoot = join(root, "state");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({ serve: { storage: { kind: "sqlite", stateRoot } } }),
      "utf8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            name: "Published fixture",
            description: "Atomic publication fixture.",
            command: process.execPath,
          },
        },
      }),
      "utf8",
    );
    const engine = await createCapletsEngine({
      configPath,
      projectConfigPath,
      authDir: join(root, "auth"),
      watch: false,
    });
    const initialEngineSnapshot = engine.currentControlPlaneRuntimeSnapshot();
    const management = engine.currentHostManagementDependencies();
    const initialActivatedSnapshot = await management!.loadRuntimeSnapshot();
    const failedCommit = vi
      .spyOn(RuntimeAssetCache.prototype, "commit")
      .mockRejectedValueOnce(new Error("asset cleanup failed"));
    try {
      writeFileSync(
        projectConfigPath,
        JSON.stringify({
          mcpServers: {
            fixture: {
              name: "Unpublished fixture",
              description: "Must never escape a failed publication.",
              command: process.execPath,
            },
          },
        }),
        "utf8",
      );

      await expect(engine.reload()).resolves.toBe(false);

      expect(engine.currentControlPlaneRuntimeSnapshot()).toBe(initialEngineSnapshot);
      expect(await management!.loadRuntimeSnapshot()).toBe(initialActivatedSnapshot);
      expect(engine.currentConfig().mcpServers.fixture?.name).toBe("Published fixture");
    } finally {
      failedCommit.mockRestore();
      await engine.close();
    }
  });

  it("runs U7 fresh initialization and returns only an active complete SQLite snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-sql-"));
    roots.push(root);
    vi.stubEnv("XDG_STATE_HOME", join(root, "state-home"));
    const stateRoot = join(root, "state");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        serve: { storage: { kind: "sqlite", stateRoot } },
      }),
      "utf8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            name: "Fixture",
            description: "Project-owned production activation fixture.",
            command: process.execPath,
            args: ["-e", ""],
          },
        },
      }),
      "utf8",
    );

    const engine = await createCapletsEngine({
      configPath,
      projectConfigPath,
      authDir: join(root, "auth"),
      watch: false,
    });
    try {
      const snapshot = engine.currentControlPlaneRuntimeSnapshot();
      expect(snapshot).toMatchObject({
        backend: "sqlite",
        authorityGeneration: 1,
        effectiveGeneration: 0,
      });
      expect(snapshot?.caplets.fixture).toMatchObject({
        owner: "filesystem",
        source: { kind: "project-config" },
      });
      expect(engine.controlPlaneSecurityRepository()).toMatchObject({
        backend: "sqlite",
      });
      const maintenance = engine.controlPlaneMaintenanceCoordinator();
      expect(maintenance).toBeDefined();
      await expect(
        maintenance!.rollCompatibleFingerprint(snapshot!.bootstrapFingerprint),
      ).resolves.toMatchObject({
        currentFingerprint: snapshot!.bootstrapFingerprint,
      });
      const stagedFingerprint = "f".repeat(64);
      await expect(maintenance!.stageNextFingerprint(stagedFingerprint)).resolves.toMatchObject({
        nextFingerprint: stagedFingerprint,
      });
      await expect(maintenance!.abortNextFingerprint(stagedFingerprint)).resolves.toMatchObject({
        currentFingerprint: snapshot!.bootstrapFingerprint,
      });
      expect(existsSync(join(stateRoot, "control-plane.sqlite"))).toBe(true);
      expect(existsSync(join(stateRoot, "legacy-migration.lock"))).toBe(false);
      expect(await engine.reload()).toBe(true);
      expect(engine.currentControlPlaneRuntimeSnapshot()).toBe(snapshot);

      writeFileSync(
        projectConfigPath,
        JSON.stringify({
          mcpServers: {
            fixture: {
              name: "Changed fixture",
              description: "Filesystem drift activation fixture.",
              command: process.execPath,
              args: ["-e", ""],
            },
          },
        }),
        "utf8",
      );
      expect(await engine.reload()).toBe(true);
      expect(engine.currentControlPlaneRuntimeSnapshot()).not.toBe(snapshot);
      expect(engine.currentControlPlaneRuntimeSnapshot()).toMatchObject({
        backend: "sqlite",
        authorityGeneration: 2,
      });
      expect(engine.currentConfig().mcpServers.fixture?.name).toBe("Changed fixture");
      await engine.close();
      const reopened = await createCapletsEngine({
        configPath,
        projectConfigPath,
        authDir: join(root, "auth"),
        watch: false,
      });
      try {
        expect(reopened.currentControlPlaneRuntimeSnapshot()).toMatchObject({
          backend: "sqlite",
          authorityGeneration: 2,
          effectiveGeneration: 0,
        });
        expect(reopened.controlPlaneSecurityRepository()).toMatchObject({
          backend: "sqlite",
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await engine.close();
    }
  });
});
