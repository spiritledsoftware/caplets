import { createHash } from "node:crypto";
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
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import type { ResolvedPostgresStorage } from "../src/control-plane/storage-config";
import { resolveStorageDeployment } from "../src/control-plane/storage-config";
import * as migrationExclusion from "../src/control-plane/migration/exclusion";
import {
  createProductionControlPlane,
  runProductionControlPlaneOfflineMigration,
  resolveProductionPostgresProcessProfile,
  resolveProductionPostgresRuntimeProfile,
  runProductionPostgresOperationalStartup,
} from "../src/control-plane/production-runtime";
import { RuntimeAssetCache } from "../src/control-plane/runtime-caches";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import {
  encodePortableCapletArtifact,
  portableCapletFromCapletDocument,
} from "../src/control-plane/caplets/portable-codec";
import { createCapletsEngine } from "../src/engine";
import { hashInstalledArtifact } from "../src/cli/install";
import { writeCapletsLockfile } from "../src/cli/lockfile";
import { stableJsonStringify } from "../src/stable-json";
import { FileVaultStore } from "../src/vault";
import {
  createCurrentHostOperations,
  trustedDevelopmentOperatorPrincipal,
  withCurrentHostFinalAuthorization,
} from "../src/current-host/operations";

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
      async migrationQuery() {
        return [];
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

  it("resumes an active Windows post-activation journal to finalized readiness", async () => {
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
    const storage = { kind: "sqlite" as const, stateRoot };
    const deployment = await resolveStorageDeployment(storage);
    if (deployment.backend !== "sqlite") throw new Error("Expected SQLite test deployment.");
    const environment = {
      binaryVersion: "0.34.1",
      supportedSchemaVersion: 1,
      keyVersion: 1,
      manifestVersion: 1,
      oldNodesDrained: true,
      hostAdministrator: true,
    };
    const journalDialect = await openSqliteControlPlaneDialect({
      storage: deployment,
      environment,
      assetRoot: new URL("../drizzle/", import.meta.url),
    });
    await journalDialect.migrate();
    const [journalRow] = journalDialect.query<{ stateDocument: string }>(
      'SELECT state_document AS "stateDocument" FROM cp_migration WHERE migration_id = ?',
      ["legacy-v1"],
    );
    if (!journalRow) throw new Error("Finalized legacy journal is absent.");
    const finalizedDocument = JSON.parse(journalRow.stateDocument) as Record<string, unknown>;
    const metadata = finalizedDocument.metadata as Record<string, unknown>;
    const cleanupId = metadata.exclusionCleanupId;
    if (typeof cleanupId !== "string") throw new Error("Legacy cleanup identity is absent.");
    const activeDocument = { ...finalizedDocument, step: "activated" };
    const stateDocument = stableJsonStringify(activeDocument);
    const checksum = createHash("sha256").update(stateDocument).digest("hex");
    journalDialect.execute(
      "UPDATE cp_migration SET phase = ?, checksum = ?, state_document = ? WHERE migration_id = ?",
      ["activated", checksum, stateDocument, "legacy-v1"],
    );
    await journalDialect.close();

    let completed = 0;
    let released = 0;
    const resumeWindowsSpy = vi
      .spyOn(migrationExclusion, "resumeWindowsLegacyMigrationExclusion")
      .mockResolvedValue({
        sealedSource: {
          path: join(legacyRoot, ".sealed"),
          manifestSha256: "a".repeat(64),
          cleanupId,
          identities: [],
        },
        tombstonePaths: [],
        initialEvidence: {},
        state: "acquired",
        verifyFinalScanAndRehash: async () => ({
          manifestSha256: "a".repeat(64),
          platformEvidence: {},
        }),
        rollbackBeforeActivation: async () => undefined,
        completeActivation: async () => {
          completed += 1;
        },
        release: async () => {
          released += 1;
        },
      } as never);
    let resumed: Awaited<ReturnType<typeof createProductionControlPlane>> | undefined;
    try {
      resumed = await createProductionControlPlane({
        configPath,
        projectConfigPath,
        authDir,
        storage: { windowsLegacyExclusionOwnerSid: "S-1-5-80-4242" },
      });
      expect(resumed.initialSnapshot).toMatchObject({ backend: "sqlite" });
      expect(completed).toBe(1);
      expect(released).toBe(1);
      expect(resumeWindowsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceBoundaryPath: legacyRoot,
          mode: "offline",
          platformOptions: {
            windows: {
              expectedOwnerSid: "S-1-5-80-4242",
              expectedServices: [],
              proof: { kind: "offline", allReplicasStopped: true },
            },
          },
        }),
        cleanupId,
      );
    } finally {
      await resumed?.close();
      resumeWindowsSpy.mockRestore();
    }

    const finalizedDialect = await openSqliteControlPlaneDialect({
      storage: deployment,
      environment,
      assetRoot: new URL("../drizzle/", import.meta.url),
    });
    await finalizedDialect.migrate();
    try {
      expect(
        finalizedDialect.query<{ phase: string }>(
          "SELECT phase FROM cp_migration WHERE migration_id = ?",
          ["legacy-v1"],
        ),
      ).toEqual([{ phase: "finalized" }]);
    } finally {
      await finalizedDialect.close();
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
    const portable = engine.currentHostPortableOperations();
    const principal = trustedDevelopmentOperatorPrincipal("http://127.0.0.1:3000");
    await expect(
      portable!.execute(principal, {
        kind: "portable_status",
        binding: {
          operationId: "portable-production-status",
          target: "global",
          logicalHostId: initialActivatedSnapshot.identity.logicalHostId,
          storeId: initialActivatedSnapshot.identity.storeId,
          operationNamespace: initialActivatedSnapshot.identity.operationNamespace,
          actorId: principal.clientId,
          requestIdentity: "portable-production-status",
          operationClass: "logical-state",
        },
      }),
    ).resolves.toMatchObject({ kind: "portable_status", status: "live" });
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
  it("derives protected migration activation from durable store evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-evidence-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    const storage = { kind: "sqlite" as const, stateRoot };
    writeFileSync(configPath, JSON.stringify({ serve: { storage } }), "utf8");
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          fixture: {
            name: "Fixture",
            description: "Durable migration evidence fixture.",
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
      authDir: join(root, "auth"),
      env: { XDG_STATE_HOME: join(root, "state-home") },
    };
    const initialized = await createProductionControlPlane(startup);
    await initialized.close();

    const deployment = await resolveStorageDeployment(storage);
    if (deployment.backend !== "sqlite") throw new Error("Expected SQLite test deployment.");
    const dialect = await openSqliteControlPlaneDialect({
      storage: deployment,
      environment: {
        binaryVersion: "0.34.1",
        supportedSchemaVersion: 1,
        keyVersion: 1,
        manifestVersion: 1,
        oldNodesDrained: true,
        hostAdministrator: true,
      },
      assetRoot: new URL("../drizzle/", import.meta.url),
    });
    await dialect.migrate();
    dialect.execute("DELETE FROM __caplets_migration_history_v1 WHERE migration_id = ?", [
      "0009_harsh_gideon",
    ]);
    await dialect.close();

    await expect(createProductionControlPlane(startup)).rejects.toThrow(
      /requires store-bound activation evidence/u,
    );
  });

  it("commits portable and catalog changes through durable fenced SQL mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-production-portable-"));
    roots.push(root);
    vi.stubEnv("XDG_STATE_HOME", join(root, "state-home"));
    const stateRoot = join(root, "state");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        serve: {
          allowUnauthenticatedHttp: true,
          storage: { kind: "sqlite", stateRoot },
        },
      }),
      "utf8",
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        mcpServers: {
          bootstrap: {
            name: "Bootstrap",
            description: "Production portable test bootstrap.",
            command: process.execPath,
          },
        },
      }),
      "utf8",
    );
    const production = await createProductionControlPlane({
      configPath,
      projectConfigPath,
      authDir: join(root, "auth"),
      env: { ...process.env, SETUP_TOKEN: "available" },
    });
    production.bindSnapshotPublisher(async () => undefined);
    const principal = trustedDevelopmentOperatorPrincipal("http://127.0.0.1:3000");
    const portableBase = portableCapletFromCapletDocument({
      id: "portable-fixture",
      path: "CAPLET.md",
      text: [
        "---",
        "name: Portable fixture",
        "description: Durable portable import fixture.",
        "mcpServer:",
        "  command: node",
        "---",
        "# Portable fixture",
        "",
      ].join("\n"),
      files: [],
    });
    const portable = {
      ...portableBase,
      references: [
        ...portableBase.references,
        {
          type: "unresolved-setup" as const,
          owner: "frontmatter.backend.config.token",
          name: "SETUP_TOKEN",
        },
      ],
    };
    const encoded = encodePortableCapletArtifact(portable);
    const bytes = encoded.bytes;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const binding = {
      operationId: "portable-production-import",
      target: "global" as const,
      logicalHostId: production.store.identity.logicalHostId,
      storeId: production.store.identity.storeId,
      operationNamespace: production.store.identity.operationNamespace,
      actorId: principal.clientId,
      requestIdentity: "portable-production-import-request",
      operationClass: "logical-state" as const,
    };
    try {
      const created = await production.portable.execute(principal, {
        kind: "portable_import_session_create",
        binding,
        expectedByteLength: bytes.byteLength,
        expectedSha256: digest,
        mimeType: encoded.mimeType.split(";")[0]!,
      });
      if (created.kind !== "portable_import_session_create") {
        throw new Error("Portable session creation returned the wrong outcome.");
      }
      await production.portable.execute(principal, {
        kind: "portable_import_session_append",
        binding,
        sessionId: created.session.sessionId,
        offset: 0,
        chunkSha256: digest,
        bytes,
      });
      const finalized = await production.portable.execute(principal, {
        kind: "portable_import_session_finalize",
        binding,
        sessionId: created.session.sessionId,
      });
      if (finalized.kind !== "portable_import_session_finalize") {
        throw new Error("Portable finalization returned the wrong outcome.");
      }
      const preview = await production.portable.execute(principal, {
        kind: "portable_import_preview",
        binding,
        artifactReference: finalized.artifact.reference,
        collisionPolicy: "reject",
        replacementConfirmed: false,
      });
      if (preview.kind !== "portable_import_preview" || preview.status !== "previewed") {
        throw new Error("Portable preview was not created.");
      }
      const revoked = withCurrentHostFinalAuthorization(principal, () => {
        throw new Error("actor revoked before commit");
      });
      await expect(
        production.portable.execute(revoked, {
          kind: "portable_import_activate",
          binding,
          proposalId: preview.proposal.proposalId,
          proposalHash: preview.proposal.proposalHash,
        }),
      ).rejects.toThrow("actor revoked before commit");
      await expect(production.store.loadSnapshot()).resolves.toMatchObject({ caplets: [] });

      const activations = await Promise.all([
        production.portable.execute(principal, {
          kind: "portable_import_activate",
          binding,
          proposalId: preview.proposal.proposalId,
          proposalHash: preview.proposal.proposalHash,
        }),
        production.portable.execute(principal, {
          kind: "portable_import_activate",
          binding,
          proposalId: preview.proposal.proposalId,
          proposalHash: preview.proposal.proposalHash,
        }),
      ]);
      expect(
        activations
          .map((outcome) => outcome?.status)
          .sort((left, right) => String(left).localeCompare(String(right))),
      ).toEqual(["committed", "rejected"]);
      expect(
        activations.some(
          (outcome) =>
            outcome?.kind === "portable_import_activate" &&
            outcome.status === "rejected" &&
            (outcome.reason === "consumed" || outcome.reason === "stale-generation"),
        ),
      ).toBe(true);
      const activated = activations.find(
        (outcome) => outcome?.kind === "portable_import_activate" && outcome.status === "committed",
      );
      if (activated?.kind !== "portable_import_activate" || activated.status !== "committed") {
        throw new Error("Portable activation did not commit.");
      }
      await expect(production.store.lookupOrReserveNotCommitted(binding)).resolves.toMatchObject({
        status: "committed",
        receipt: { aggregateVersion: 1 },
      });

      const importedSnapshot = await production.store.loadSnapshot();
      const importedCaplet = importedSnapshot.caplets.find(
        ({ aggregate }) => aggregate.id === portable.id,
      );
      expect({
        activation: importedCaplet?.aggregate.activation,
        aggregateVersion: importedCaplet?.aggregate.aggregateVersion,
        authorityGeneration: importedSnapshot.versions.authorityGeneration,
        effectiveGeneration: importedSnapshot.versions.effectiveGeneration,
        securityEpoch: importedSnapshot.versions.securityEpoch,
      }).toEqual({
        activation: "setup-required",
        aggregateVersion: activated.receipt.aggregateVersion,
        authorityGeneration: activated.receipt.authorityToken.authorityGeneration,
        effectiveGeneration: activated.receipt.authorityToken.effectiveGeneration,
        securityEpoch: importedSnapshot.versions.securityEpoch,
      });
      await production.activated.refresh();
      const managementOperations = createCurrentHostOperations({
        engine: { enabledServers: () => [] },
        activityLog: new DashboardActivityLog({ dir: join(root, "management-activity") }),
        version: "test",
        management: production.management,
      });
      const bypassBinding = {
        ...binding,
        operationId: "portable-production-activation-bypass",
        requestIdentity: "portable-production-activation-bypass-request",
      };
      const bypassPreview = await managementOperations.preview(principal, {
        binding: bypassBinding,
        mutation: {
          kind: "caplet-set-activation",
          id: portable.id,
          activation: "active",
          selector: "underlying-sql",
        },
      });
      if (bypassPreview.status !== "preview") {
        throw new Error(`Activation bypass preview failed: ${JSON.stringify(bypassPreview)}`);
      }
      await expect(
        managementOperations.mutate(principal, {
          binding: bypassBinding,
          mutation: {
            kind: "caplet-set-activation",
            id: portable.id,
            activation: "active",
            selector: "underlying-sql",
            expectedAuthorityToken: bypassPreview.authorityToken,
          },
        }),
      ).rejects.toThrow(/only be activated through setup revalidation/u);
      const revalidated = await production.portable.execute(principal, {
        kind: "portable_setup_revalidate",
        binding: { ...binding, operationId: "portable-production-revalidate" },
        capletId: portable.id,
        expectedAggregateVersion: activated.receipt.aggregateVersion,
        expectedAuthorityToken: activated.receipt.authorityToken,
        expectedSecurityEpoch: importedSnapshot.versions.securityEpoch,
      });
      if (revalidated?.kind !== "portable_setup_revalidate" || revalidated.status !== "committed") {
        throw new Error(`Setup revalidation rejected: ${JSON.stringify(revalidated)}`);
      }
      expect(revalidated).toMatchObject({
        kind: "portable_setup_revalidate",
        status: "committed",
        caplet: { activation: "active" },
      });

      const catalogPortable = {
        ...portable,
        id: "catalog-sql-fixture",
        name: "Catalog SQL fixture",
        references: [],
      };
      const lockEntry = {
        id: catalogPortable.id,
        destination: `${catalogPortable.id}.md`,
        kind: "file" as const,
        source: {
          type: "git" as const,
          repository: "https://example.test/catalog.git",
          path: `${catalogPortable.id}.md`,
          resolvedRevision: "abc123",
          portability: "portable" as const,
        },
        installedHash: "a".repeat(64),
        installedAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
        risk: {
          backendFamilies: ["http"],
          safety: "standard" as const,
          projectBindingRequired: false,
          mutating: false,
          destructive: false,
        },
      };
      await expect(
        production.portable.persistGlobalCatalogChange?.({
          action: "install",
          principal,
          source: { repository: lockEntry.source.repository },
          force: false,
          artifacts: [
            {
              installed: {
                id: catalogPortable.id,
                source: lockEntry.source.repository,
                destination: lockEntry.destination,
                kind: "file",
                status: "installed",
              },
              lockEntry,
              portable: catalogPortable,
              provenance: {
                id: "ignored-caller-provenance",
                sourceKind: "caller",
                source: {},
                contentHash: "b".repeat(64),
              },
              setupActions: [],
            },
          ],
        }),
      ).resolves.toMatchObject({ installed: [{ id: catalogPortable.id }] });
      await expect(
        production.portable.loadGlobalCatalogProvenance?.([catalogPortable.id]),
      ).resolves.toEqual([lockEntry]);
      expect(
        (await production.store.loadSnapshot()).caplets.find(
          (entry) => entry.aggregate.id === catalogPortable.id,
        )?.aggregate.installationProvenanceId,
      ).not.toBe("ignored-caller-provenance");
    } finally {
      await production.close();
    }
  });
});
