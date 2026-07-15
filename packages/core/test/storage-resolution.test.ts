import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type PostgresStorageConfig } from "../src/config";
import { parseLocalAuthorityDescriptor } from "../src/current-host/authority";
import { bootstrapSqliteFileV1 } from "../src/control-plane/key-provider/file-v1";
import {
  assertStorageBootstrapCompatible,
  resolveStorageDeployment,
} from "../src/control-plane/storage-config";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const operationNamespace = "operations_01J00000000000000000000000";
const databaseIdentity = "a".repeat(64);
const leastPrivileges = {
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRowLevelSecurity: false,
} as const;
const roots: string[] = [];

function tempPath(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), `caplets-${name}-`));
  roots.push(parent);
  chmodSync(parent, 0o700);
  return join(parent, "state");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage deployment resolution", () => {
  it("resolves omitted config to one owner-private SQLite store and complete key bootstrap", async () => {
    const stateRoot = tempPath("sqlite-zero");

    const resolved = await resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot });

    expect(resolved.backend).toBe("sqlite");
    if (resolved.backend !== "sqlite") throw new Error("expected SQLite");
    expect(resolved.databasePath).toBe(join(stateRoot, "control-plane.sqlite"));
    expect(resolved.artifacts.root).toBe(join(stateRoot, "artifacts"));
    expect(existsSync(resolved.databasePath)).toBe(true);
    expect(lstatSync(stateRoot).mode & 0o077).toBe(0);
    expect(lstatSync(resolved.artifacts.root).mode & 0o077).toBe(0);
    expect(existsSync(resolved.keyProviderManifest)).toBe(true);

    const descriptor = parseLocalAuthorityDescriptor(
      readFileSync(join(stateRoot, "authority.json"), "utf8"),
    );
    expect(descriptor).toMatchObject({
      state: "bound",
      logicalHostId: resolved.logicalHostId,
      storeId: resolved.storeId,
    });

    const restarted = await resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot });
    expect(() => assertStorageBootstrapCompatible(resolved, restarted)).not.toThrow();
    const bindingPath = join(stateRoot, "storage-binding.json");
    const originalBinding = readFileSync(bindingPath, "utf8");
    const regressedBinding = JSON.parse(originalBinding) as {
      keyVersionFloors: Record<
        string,
        { activeVersion: number; minimumLiveVersion: number; liveVersions: number[] }
      >;
    };
    regressedBinding.keyVersionFloors["active-record"]!.activeVersion = 2;
    regressedBinding.keyVersionFloors["active-record"]!.liveVersions = [1, 2];
    writeFileSync(bindingPath, JSON.stringify(regressedBinding));

    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot }),
    ).rejects.toThrow(/version floors|backwards/i);
    writeFileSync(bindingPath, originalBinding);
    const databaseBytes = readFileSync(resolved.databasePath);
    const databaseInode = lstatSync(resolved.databasePath).ino;
    writeFileSync(resolved.databasePath, Buffer.alloc(0));
    expect(lstatSync(resolved.databasePath).ino).toBe(databaseInode);
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot }),
    ).rejects.toThrow(/SQLite verification/i);
    writeFileSync(resolved.databasePath, databaseBytes);

    const artifactCanaryPath = join(resolved.artifacts.root, ".caplets-storage-canary-v1.json");
    const artifactCanary = readFileSync(artifactCanaryPath, "utf8");
    writeFileSync(
      artifactCanaryPath,
      JSON.stringify({
        version: 1,
        logicalHostId: resolved.logicalHostId,
        storeId: resolved.storeId,
        canary: "0".repeat(64),
      }),
    );
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot }),
    ).rejects.toThrow(/artifact provider canary/i);
    writeFileSync(artifactCanaryPath, artifactCanary);

    const driftedDatabase = join(stateRoot, "other.sqlite");
    await expect(
      resolveStorageDeployment({
        kind: "sqlite",
        stateRoot,
        databasePath: driftedDatabase,
      }),
    ).rejects.toThrow(/binding|drift|absent/i);
    expect(existsSync(driftedDatabase)).toBe(false);

    const originalManifest = readFileSync(resolved.keyProviderManifest, "utf8");
    const rotatedManifest = JSON.parse(originalManifest) as { generation: number };
    rotatedManifest.generation += 1;
    writeFileSync(resolved.keyProviderManifest, JSON.stringify(rotatedManifest));
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot }),
    ).rejects.toThrow(/retirement authorization/i);
    await expect(
      resolveStorageDeployment(undefined, {
        defaultStateRoot: stateRoot,
        authorizeKeyRotation: async ({
          currentGeneration,
          candidateGeneration,
          currentVersionFloors,
          candidateVersionFloors,
        }) => {
          expect(currentVersionFloors["active-record"].liveVersions).toEqual([1]);
          expect(candidateVersionFloors["active-record"].liveVersions).toEqual([1]);
          return candidateGeneration === currentGeneration + 1;
        },
      }),
    ).resolves.toMatchObject({ backend: "sqlite" });
    writeFileSync(resolved.keyProviderManifest, originalManifest);
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: stateRoot }),
    ).rejects.toThrow(/rollback/i);
  });

  it("fails closed on partial, insecure, and symlinked roots without replacing state", async () => {
    const partialRoot = tempPath("sqlite-partial");
    mkdirSync(partialRoot, { mode: 0o700 });
    writeFileSync(join(partialRoot, "foreign"), "keep", { mode: 0o600 });
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: partialRoot }),
    ).rejects.toThrow(/descriptor|partial|fresh/i);
    expect(readFileSync(join(partialRoot, "foreign"), "utf8")).toBe("keep");

    const insecureRoot = tempPath("sqlite-insecure");
    mkdirSync(insecureRoot, { mode: 0o755 });
    await expect(
      resolveStorageDeployment(undefined, { defaultStateRoot: insecureRoot }),
    ).rejects.toThrow(/permissions/i);

    const target = tempPath("sqlite-link-target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(dirname(target), "linked-state");
    symlinkSync(target, link);
    await expect(resolveStorageDeployment(undefined, { defaultStateRoot: link })).rejects.toThrow(
      /symlink|directory/i,
    );
  });

  it("validates U1 authority before resolving Postgres credentials and pins verified identity once", async () => {
    const keyRoot = tempPath("postgres-keys");
    const keyBootstrap = await bootstrapSqliteFileV1({ root: keyRoot, logicalHostId, storeId });
    const stateRoot = tempPath("postgres-node");
    const storage = postgresConfig(stateRoot, keyBootstrap.profileManifestPaths.online);
    const config = parseConfig({ serve: { storage } });
    const resolvedSecrets: string[] = [];

    const resolved = await resolveStorageDeployment(config.serve?.storage, {
      resolveSecret: async (reference) => {
        const descriptorPath = join(stateRoot, "authority.json");
        expect(existsSync(descriptorPath)).toBe(true);
        expect(lstatSync(descriptorPath).mode & 0o077).toBe(0);
        expect(parseLocalAuthorityDescriptor(readFileSync(descriptorPath, "utf8")).state).toBe(
          "unbound",
        );
        resolvedSecrets.push(reference.kind === "env" ? reference.name : "file-reference");
        if (reference.kind === "env" && reference.name === "CAPLETS_PG_RUNTIME_URL") {
          return "postgresql://caplets_runtime:sentinel-password@postgres.internal/caplets";
        }
        if (reference.kind === "env" && reference.name === "CAPLETS_S3_CANARY") {
          return "a".repeat(64);
        }
        return reference.kind === "env" ? `s3-${reference.name}` : "trusted-ca";
      },
      verifyPostgres: async ({ tls, role }) => ({
        logicalHostId,
        storeId,
        tlsPeerServerName: tls.serverName,
        databaseRole: role,
        canSetRole: false,
        inheritedRoles: [],
        privileges: leastPrivileges,
        operationNamespace,
        databaseIdentity,
      }),
      verifyS3Canary: async ({ identity }) => ({ identity, matches: true }),
    });

    expect(resolved).toMatchObject({ backend: "postgres", logicalHostId, storeId });
    expect(resolvedSecrets.sort()).toEqual([
      "CAPLETS_PG_RUNTIME_URL",
      "CAPLETS_S3_ACCESS_KEY_ID",
      "CAPLETS_S3_CANARY",
      "file-reference",
    ]);
    const descriptor = parseLocalAuthorityDescriptor(
      readFileSync(join(stateRoot, "authority.json"), "utf8"),
    );
    expect(descriptor).toMatchObject({ state: "bound", storeId });
    expect(JSON.stringify(config)).not.toContain("sentinel-password");
  });

  it("ignores database-password differences but rejects runtime key commitment drift", async () => {
    const keyRoot = tempPath("postgres-compatible-keys");
    const keyBootstrap = await bootstrapSqliteFileV1({ root: keyRoot, logicalHostId, storeId });
    const resolveNode = async (
      stateRoot: string,
      databasePassword: string,
      manifestPath = keyBootstrap.profileManifestPaths.online,
    ) =>
      resolveStorageDeployment(postgresConfig(stateRoot, manifestPath), {
        resolveSecret: async (reference) => {
          if (reference.kind === "env" && reference.name === "CAPLETS_PG_RUNTIME_URL") {
            return `postgresql://caplets_runtime:${databasePassword}@postgres.internal/caplets`;
          }
          if (reference.kind === "env" && reference.name === "CAPLETS_S3_CANARY") {
            return "a".repeat(64);
          }
          return "shared-artifact-secret";
        },
        verifyPostgres: async ({ tls, role }) => ({
          logicalHostId,
          storeId,
          tlsPeerServerName: tls.serverName,
          databaseRole: role,
          canSetRole: false,
          inheritedRoles: [],
          privileges: leastPrivileges,
          operationNamespace,
          databaseIdentity,
        }),
        verifyS3Canary: async ({ identity }) => ({ identity, matches: true }),
      });

    const first = await resolveNode(tempPath("postgres-compatible-a"), "database-password-a");
    const second = await resolveNode(tempPath("postgres-compatible-b"), "database-password-b");
    expect("secretCommitments" in first).toBe(false);
    expect(() => assertStorageBootstrapCompatible(first, second)).not.toThrow();

    const driftKeyRoot = tempPath("postgres-drifted-keys");
    cpSync(keyRoot, driftKeyRoot, { recursive: true });
    const driftManifestPath = join(driftKeyRoot, "key-provider", "manifests", "online.json");
    const driftManifest = JSON.parse(readFileSync(driftManifestPath, "utf8")) as {
      entries: Array<{ file: string }>;
    };
    const driftKeyPath = join(dirname(driftManifestPath), driftManifest.entries[0]!.file);
    writeFileSync(driftKeyPath, Buffer.alloc(32, 0x5a), { mode: 0o600 });
    await expect(
      resolveNode(tempPath("postgres-drifted-node"), "database-password-c", driftManifestPath),
    ).rejects.toThrow(/compatibility/i);
  });

  it("rejects Postgres TLS peer, store, role escalation, and canary mismatches", async () => {
    const keyRoot = tempPath("postgres-invalid-keys");
    const keyBootstrap = await bootstrapSqliteFileV1({ root: keyRoot, logicalHostId, storeId });

    let verifierCalled = false;
    await expect(
      resolveStorageDeployment(
        postgresConfig(
          tempPath("postgres-wrong-credential-target"),
          keyBootstrap.profileManifestPaths.online,
        ),
        {
          resolveSecret: async (reference) =>
            reference.kind === "env" && reference.name === "CAPLETS_S3_CANARY"
              ? "a".repeat(64)
              : "postgresql://wrong_role:password@postgres.internal/caplets",
          verifyPostgres: async () => {
            verifierCalled = true;
            throw new Error("must not verify");
          },
          verifyS3Canary: async ({ identity }) => ({ identity, matches: true }),
        },
      ),
    ).rejects.toThrow(/credential/i);
    expect(verifierCalled).toBe(false);

    for (const verification of [
      {
        tlsPeerServerName: "attacker.internal",
        databaseRole: "caplets_runtime",
        canSetRole: false,
      },
      { tlsPeerServerName: "postgres.internal", databaseRole: "wrong_role", canSetRole: false },
      { tlsPeerServerName: "postgres.internal", databaseRole: "caplets_runtime", canSetRole: true },
      {
        tlsPeerServerName: "postgres.internal",
        databaseRole: "caplets_runtime",
        canSetRole: false,
        privileges: { ...leastPrivileges, superuser: true },
      },
      {
        tlsPeerServerName: "postgres.internal",
        databaseRole: "caplets_runtime",
        canSetRole: false,
        operationNamespace: "operations_bad",
      },
    ]) {
      const stateRoot = tempPath("postgres-invalid-node");
      await expect(
        resolveStorageDeployment(
          postgresConfig(stateRoot, keyBootstrap.profileManifestPaths.online),
          {
            resolveSecret: async (reference) =>
              reference.kind === "env" && reference.name === "CAPLETS_S3_CANARY"
                ? "a".repeat(64)
                : "postgresql://caplets_runtime:password@postgres.internal/caplets",
            verifyPostgres: async () => ({
              logicalHostId,
              storeId,
              inheritedRoles: [],
              privileges: leastPrivileges,
              operationNamespace,
              databaseIdentity,
              ...verification,
            }),
            verifyS3Canary: async ({ identity }) => ({ identity, matches: true }),
          },
        ),
      ).rejects.toThrow(/identity|tls|role|privilege|namespace/i);
    }

    const stateRoot = tempPath("postgres-canary-node");
    await expect(
      resolveStorageDeployment(
        postgresConfig(stateRoot, keyBootstrap.profileManifestPaths.online),
        {
          resolveSecret: async (reference) =>
            reference.kind === "env" && reference.name === "CAPLETS_S3_CANARY"
              ? "a".repeat(64)
              : "postgresql://caplets_runtime:password@postgres.internal/caplets",
          verifyPostgres: async ({ tls, role }) => ({
            logicalHostId,
            databaseIdentity,
            storeId,
            tlsPeerServerName: tls.serverName,
            databaseRole: role,
            canSetRole: false,
            inheritedRoles: [],
            privileges: leastPrivileges,
            operationNamespace,
          }),
          verifyS3Canary: async ({ identity }) => ({ identity, matches: false }),
        },
      ),
    ).rejects.toThrow(/canary/i);
  });
});

function postgresConfig(stateRoot: string, keyProviderManifest: string): PostgresStorageConfig {
  return {
    kind: "postgres",
    stateRoot,
    logicalHostId,
    expectedStoreId: storeId,
    processRole: "online",
    connection: {
      tls: { mode: "verify-full", serverName: "postgres.internal" },
      roles: {
        runtime: {
          role: "caplets_runtime",
          credential: { kind: "env", name: "CAPLETS_PG_RUNTIME_URL" },
        },
        migrator: {
          role: "caplets_migrator",
          credential: { kind: "env", name: "CAPLETS_PG_MIGRATOR_URL" },
        },
        maintenance: {
          role: "caplets_maintenance",
          credential: { kind: "file", path: "/run/secrets/pg-maintenance" },
        },
      },
    },
    keyProviderManifest,
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
