import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import {
  openSqliteControlPlaneDialect,
  type SqliteControlPlaneDialect,
} from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import {
  bootstrapSqliteFileV1,
  hashFileV1HighEntropyVerifier,
  loadFileV1KeyProvider,
} from "../src/control-plane/key-provider/file-v1";
import {
  FILE_V1_PURPOSE_SPECS,
  fileV1CompatibilityManifestCommitment,
  type FileV1CompatibilityKey,
} from "../src/control-plane/key-provider/manifest";
import { createControlPlaneKeyRotationManager } from "../src/control-plane/security/key-rotation";
import {
  createControlPlaneActivityMaintenanceRepository,
  createControlPlaneSecurityRepository,
} from "../src/control-plane/security/repository";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type { ControlPlaneTransactionalDialect } from "../src/control-plane/store";
import type { ControlPlaneStoreIdentity } from "../src/control-plane/types";
import type { DashboardActivityRepository } from "../src/dashboard/activity-log";
import {
  openPostgresControlPlaneFixture,
  type PostgresControlPlaneFixture,
} from "./fixtures/postgres-control-plane";

const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
const migrationEnvironment: MigrationEnvironment = {
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  hostAdministrator: true,
  now: new Date("2026-07-15T00:00:00.000Z"),
};
const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const postgresAdminUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const roots: string[] = [];
const dialects: SqliteControlPlaneDialect[] = [];
const postgresFixtures: PostgresControlPlaneFixture[] = [];

afterEach(async () => {
  await Promise.all(dialects.splice(0).map((dialect) => dialect.close().catch(() => undefined)));
  await Promise.all(
    postgresFixtures.splice(0).map((fixture) => fixture.close().catch(() => undefined)),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "caplets-u6-security-"));
  roots.push(parent);
  const root = join(parent, "state");
  const bootstrap = await bootstrapSqliteFileV1({
    root,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
  });
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    ...identity,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: bootstrap.profileManifestPaths.online,
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  const dialect = await openSqliteControlPlaneDialect({
    storage,
    environment: migrationEnvironment,
    assetRoot,
  });
  dialects.push(dialect);
  dialect.migrate();
  const keyProvider = await loadFileV1KeyProvider({
    manifestPath: bootstrap.profileManifestPaths.online,
    expectedLogicalHostId: identity.logicalHostId,
    expectedStoreId: identity.storeId,
    expectedProfile: "online",
  });
  const controlStore = createControlPlaneRepository({ identity, dialect });
  await controlStore.initialize();
  return {
    root,
    storage,
    dialect,
    keyProvider,
    controlStore,
    repository: createControlPlaneSecurityRepository({ identity, dialect, keyProvider }),
  };
}

async function seedAuthorizationRows(dialect: ControlPlaneTransactionalDialect): Promise<void> {
  await dialect.runtimeTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    const common = {
      modelVersion: 1,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 1,
    } as const;
    await transaction.insert("securityVersions", {
      ...common,
      id: "security-version:1",
      epoch: 1,
      minimumKeyVersion: 1,
      revocationWatermark: 0,
      advancedAt: now,
    });
    await transaction.insert("writerFences", {
      ...common,
      id: "writer-fence:1",
      leaseId: "lease-u6",
      writerEpoch: 1,
      authorityGeneration: 0,
      expiresAt: "9999-12-31T23:59:59.999Z",
      state: "active",
    });
  });
}

async function seedCaplet(dialect: ControlPlaneTransactionalDialect): Promise<void> {
  await dialect.runtimeTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    await transaction.insert("caplets", {
      modelVersion: 1,
      id: "caplet-u6",
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      name: "U6 fixture",
      description: "Vault grant target",
      ownership: "sql",
      activation: "active",
      effective: 1,
      updateState: "current",
      portableAggregateId: "caplet-u6",
      installationProvenanceId: null,
    });
  });
}

type MutableManifestEntry = {
  keyId: string;
  keyVersion: number;
  purpose: string;
  file: string;
  operations: string[];
};

type MutableManifest = {
  entries: MutableManifestEntry[];
  compatibilityKeys: FileV1CompatibilityKey[];
  compatibilityCommitment: string;
};

async function postgresSecurityFixture() {
  if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
  const parent = await mkdtemp(join(tmpdir(), "caplets-u6-security-postgres-"));
  roots.push(parent);
  const root = join(parent, "state");
  const bootstrap = await bootstrapSqliteFileV1({
    root,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
  });
  const postgres = await openPostgresControlPlaneFixture({
    adminUrl: postgresAdminUrl,
    assetRoot,
    identity,
    environment: migrationEnvironment,
    rolePrefix: "caplets_u6_security",
    keyProviderManifest: bootstrap.profileManifestPaths.online,
  });
  postgresFixtures.push(postgres);
  const keyProvider = await loadFileV1KeyProvider({
    manifestPath: bootstrap.profileManifestPaths.online,
    expectedLogicalHostId: identity.logicalHostId,
    expectedStoreId: identity.storeId,
    expectedProfile: "online",
  });
  const controlStore = createControlPlaneRepository({ identity, dialect: postgres.dialect });
  await controlStore.initialize();
  return {
    ...postgres,
    root,
    onlineManifestPath: bootstrap.profileManifestPaths.online,
    keyProvider,
    controlStore,
    repository: createControlPlaneSecurityRepository({
      identity,
      dialect: postgres.dialect,
      keyProvider,
    }),
  };
}

async function createVaultVersionTwoProvider(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
  const previous = manifest.entries.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === 1,
  );
  const previousCompatibility = manifest.compatibilityKeys.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === 1,
  );
  if (!previous || !previousCompatibility) throw new Error("vault-record v1 is missing");
  previous.operations = previous.operations.filter((operation) => operation === "decrypt");
  const material = randomBytes(32);
  const next: MutableManifestEntry = {
    ...previous,
    keyId: "key_01J00000000000000000000002",
    keyVersion: 2,
    file: "keys/vault-record-v2.key",
    operations: ["encrypt", "decrypt"],
  };
  const nextCompatibility: FileV1CompatibilityKey = {
    ...previousCompatibility,
    keyId: next.keyId,
    keyVersion: next.keyVersion,
    commitment: keyCommitment(next, material),
  };
  manifest.entries.push(next);
  manifest.compatibilityKeys.push(nextCompatibility);
  manifest.compatibilityCommitment = fileV1CompatibilityManifestCommitment(
    manifest.compatibilityKeys,
  );
  await writeFile(resolve(dirname(manifestPath), next.file), material, { mode: 0o600 });
  const nextManifestPath = join(dirname(manifestPath), "online-v2.json");
  await writeFile(nextManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(nextManifestPath, 0o600);
  return loadFileV1KeyProvider({
    manifestPath: nextManifestPath,
    expectedLogicalHostId: identity.logicalHostId,
    expectedStoreId: identity.storeId,
    expectedProfile: "online",
  });
}

function keyCommitment(entry: MutableManifestEntry, material: Buffer): string {
  const operations =
    FILE_V1_PURPOSE_SPECS[entry.purpose as keyof typeof FILE_V1_PURPOSE_SPECS].operations;
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.keyId,
        entry.keyVersion,
        entry.purpose,
        operations,
        material.byteLength,
      ]),
    )
    .update("\0")
    .update(material)
    .digest("hex");
}

describe("SQL control-plane security state", () => {
  it("preserves verifier, replay, approval, session, authorization, activity, and secret-redaction contracts", async () => {
    const test = await fixture();
    await seedAuthorizationRows(test.dialect);
    const operator = await test.repository.issueClient({
      hostUrl: "http://127.0.0.1:3100",
      clientLabel: "operator",
      role: "operator",
    });
    await expect(
      test.repository.validateAccessToken({
        hostUrl: operator.hostUrl,
        accessToken: operator.accessToken,
        requiredRole: "operator",
      }),
    ).resolves.toMatchObject({ clientId: operator.clientId, role: "operator" });

    const issuedSession = await test.repository.create({ operatorClientId: operator.clientId });
    await expect(
      test.repository.validate({
        cookieValue: issuedSession.cookieValue,
        requireCsrf: true,
        csrfToken: "wrong-csrf",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      test.repository.validate({
        cookieValue: issuedSession.cookieValue,
        requireCsrf: true,
        csrfToken: issuedSession.session.csrfToken,
      }),
    ).resolves.toMatchObject({ sessionId: issuedSession.session.sessionId });

    await expect(
      test.repository.authorize({
        ...identity,
        actorId: operator.clientId,
        requiredRole: "operator",
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await test.repository.changeClientRole(operator.clientId, "access");
    expect(
      test.dialect.query<{ epoch: number; revocationWatermark: number }>(
        "SELECT epoch, revocation_watermark AS revocationWatermark FROM cp_security_version ORDER BY epoch",
      ),
    ).toEqual([
      { epoch: 0, revocationWatermark: 0 },
      { epoch: 1, revocationWatermark: 0 },
      { epoch: 2, revocationWatermark: 1 },
    ]);
    await expect(
      test.repository.validate({ cookieValue: issuedSession.cookieValue }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      test.repository.validateAccessToken({
        hostUrl: operator.hostUrl,
        accessToken: operator.accessToken,
        requiredRole: "access",
      }),
    ).resolves.toMatchObject({ role: "access" });
    await expect(
      test.repository.authorize({
        ...identity,
        actorId: operator.clientId,
        requiredRole: "operator",
      }),
    ).resolves.toEqual({ status: "denied", reason: "role-insufficient" });
    await expect(
      test.repository.authorize({
        ...identity,
        actorId: operator.clientId,
        requiredRole: "access",
      }),
    ).resolves.toMatchObject({ status: "authorized" });
    await expect(
      test.dialect.runtimeTransaction((transaction) =>
        test.repository.authorizeInTransaction!(transaction, {
          ...identity,
          actorId: operator.clientId,
          requiredRole: "operator",
        }),
      ),
    ).resolves.toEqual({ status: "denied", reason: "role-insufficient" });
    await expect(
      test.dialect.runtimeTransaction((transaction) =>
        test.repository.authorizeInTransaction!(transaction, {
          ...identity,
          actorId: operator.clientId,
          requiredRole: "access",
        }),
      ),
    ).resolves.toMatchObject({ status: "authorized" });

    const refreshable = await test.repository.issueClient({
      hostUrl: operator.hostUrl,
      clientLabel: "refresh-family",
      role: "access",
    });
    const refreshRows = test.dialect.query<{
      credentialId: string;
      verifier: Buffer;
    }>(
      "SELECT credential_id AS credentialId, verifier_or_ciphertext AS verifier FROM cp_credential WHERE client_id = ? AND purpose = ?",
      [refreshable.clientId, "remote-refresh"],
    );
    expect(refreshRows).toHaveLength(1);
    expect(refreshRows[0]!.verifier).toEqual(
      hashFileV1HighEntropyVerifier({
        ...identity,
        purpose: "credential-verifier",
        recordId: `remote-refresh:${refreshRows[0]!.credentialId}`,
        secret: refreshable.refreshToken,
      }),
    );
    expect(
      test.dialect.query(
        "SELECT role, status, host_url AS hostUrl, revoked_at AS revokedAt FROM cp_client WHERE client_id = ?",
        [refreshable.clientId],
      ),
    ).toEqual([
      { role: "access", status: "active", hostUrl: refreshable.hostUrl, revokedAt: null },
    ]);
    const rotated = await test.repository.refreshClientCredentials({
      hostUrl: refreshable.hostUrl,
      refreshToken: refreshable.refreshToken,
    });
    await expect(
      test.repository.validateAccessToken({
        hostUrl: refreshable.hostUrl,
        accessToken: refreshable.accessToken,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      test.repository.validateAccessToken({
        hostUrl: rotated.hostUrl,
        accessToken: rotated.accessToken,
      }),
    ).resolves.toMatchObject({ clientId: rotated.clientId });
    await expect(
      test.repository.refreshClientCredentials({
        hostUrl: refreshable.hostUrl,
        refreshToken: refreshable.refreshToken,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(
      test.dialect.query<{ epoch: number; revocationWatermark: number }>(
        "SELECT epoch, revocation_watermark AS revocationWatermark FROM cp_security_version ORDER BY epoch",
      ),
    ).toEqual([
      { epoch: 0, revocationWatermark: 0 },
      { epoch: 1, revocationWatermark: 0 },
      { epoch: 2, revocationWatermark: 1 },
      { epoch: 3, revocationWatermark: 2 },
    ]);
    await expect(
      test.repository.validateAccessToken({
        hostUrl: rotated.hostUrl,
        accessToken: rotated.accessToken,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });

    const approved = await test.repository.createPendingApproval();
    const competing = await Promise.all([
      test.repository.resolvePendingApproval({
        approvalId: approved.approvalId,
        code: approved.code,
        action: "approve",
      }),
      test.repository.resolvePendingApproval({
        approvalId: approved.approvalId,
        code: approved.code,
        action: "cancel",
      }),
    ]);
    expect(new Set(competing.map((result) => result.state)).size).toBe(1);
    expect(["approved", "cancelled"]).toContain(competing[0]!.state);
    const expiring = await test.repository.createPendingApproval({ ttlMs: -1 });
    await expect(
      test.repository.resolvePendingApproval({
        approvalId: expiring.approvalId,
        code: expiring.code,
        action: "approve",
      }),
    ).resolves.toMatchObject({ state: "expired" });
    const cancelled = await test.repository.createPendingApproval();
    await expect(
      test.repository.resolvePendingApproval({
        approvalId: cancelled.approvalId,
        code: cancelled.code,
        action: "cancel",
      }),
    ).resolves.toMatchObject({ state: "cancelled" });

    const expiryOperator = await test.repository.issueClient({
      hostUrl: operator.hostUrl,
      clientLabel: "session-expiry",
      role: "operator",
    });
    const idleSession = await test.repository.create({ operatorClientId: expiryOperator.clientId });
    test.dialect.execute(
      "UPDATE cp_dashboard_session SET idle_expires_at = ? WHERE session_id = ?",
      ["1970-01-01T00:00:00.000Z", idleSession.session.sessionId],
    );
    await expect(
      test.repository.validate({ cookieValue: idleSession.cookieValue }),
    ).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    const absoluteSession = await test.repository.create({
      operatorClientId: expiryOperator.clientId,
    });
    test.dialect.execute(
      "UPDATE cp_dashboard_session SET absolute_expires_at = ? WHERE session_id = ?",
      ["1970-01-01T00:00:00.000Z", absoluteSession.session.sessionId],
    );
    await expect(
      test.repository.validate({ cookieValue: absoluteSession.cookieValue }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });

    const sentinel = "U6_SENTINEL_TOKEN_COOKIE_CSRF_VAULT";
    await test.repository.writeTokenBundle({ server: "u6-oauth", accessToken: sentinel });
    await expect(test.repository.readTokenBundle("u6-oauth")).resolves.toEqual({
      server: "u6-oauth",
      accessToken: sentinel,
    });
    const expiredActivity = await test.repository.append({
      actorClientId: expiryOperator.clientId,
      action: "vault_set",
      target: { type: "vault", id: "EXPIRED" },
      metadata: { token: sentinel },
    });
    const retainedActivity = await test.repository.append({
      actorClientId: expiryOperator.clientId,
      action: "vault_set",
      target: { type: "vault", id: "RETAINED" },
    });
    test.dialect.execute("UPDATE cp_operator_activity SET expires_at = ? WHERE activity_id = ?", [
      "1970-01-01T00:00:00.000Z",
      expiredActivity.id,
    ]);
    const maintenance = createControlPlaneActivityMaintenanceRepository({
      identity,
      dialect: test.dialect,
    });
    await expect(maintenance.purgeExpired({ watermark: 7, limit: 1 })).resolves.toMatchObject({
      deleted: 1,
      watermark: 7,
    });
    await expect(maintenance.purgeExpired({ watermark: 6, limit: 1 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    const activities = await test.repository.list();
    expect(activities.entries.map((entry) => entry.id)).toContain(retainedActivity.id);
    expect(JSON.stringify(activities)).not.toContain(sentinel);
    const runtimeActivity: DashboardActivityRepository = test.repository;
    expect("update" in runtimeActivity).toBe(false);
    expect("delete" in runtimeActivity).toBe(false);
    expect(Object.keys(maintenance)).toEqual(["purgeExpired"]);

    const backupPath = join(test.root, "u6-sentinel-backup.sqlite3");
    await test.dialect.onlineBackup(backupPath);
    const rawFiles = await Promise.all(
      [test.storage.databasePath, `${test.storage.databasePath}-wal`, backupPath].map((path) =>
        readFile(path).catch(() => Buffer.alloc(0)),
      ),
    );
    rawFiles.push(Buffer.from(JSON.stringify(await test.controlStore.loadSnapshot()), "utf8"));
    for (const secret of [
      operator.accessToken,
      operator.refreshToken,
      rotated.accessToken,
      rotated.refreshToken,
      issuedSession.cookieValue,
      issuedSession.session.csrfToken,
      sentinel,
    ]) {
      expect(Buffer.concat(rawFiles).includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("rolls back Vault value and grant writes atomically and replaces an exact-origin remap", async () => {
    const test = await fixture();
    await seedCaplet(test.dialect);
    const origin = { kind: "project-file" as const, path: "/workspace/caplet.json" };
    const afterGrant = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: test.keyProvider,
      failureInjector(point) {
        if (point === "after-vault-grant") throw new Error("injected grant failure");
      },
    });
    await expect(
      afterGrant.setWithGrant({
        key: "ROLLBACK_CREATE",
        value: "must-not-commit",
        grant: {
          storedKey: "ROLLBACK_CREATE",
          referenceName: "CREATE_REF",
          capletId: "caplet-u6",
          origin,
        },
      }),
    ).rejects.toThrow(/injected grant failure/u);
    await expect(test.repository.getStatus("ROLLBACK_CREATE")).resolves.toEqual({
      key: "ROLLBACK_CREATE",
      present: false,
    });
    await expect(test.repository.listAccess({ referenceName: "CREATE_REF" })).resolves.toEqual([]);

    await test.repository.setWithGrant({ key: "ROLLBACK_OVERWRITE", value: "preserved" });
    const afterValue = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: test.keyProvider,
      failureInjector(point) {
        if (point === "after-vault-value") throw new Error("injected value failure");
      },
    });
    await expect(
      afterValue.setWithGrant({ key: "ROLLBACK_OVERWRITE", value: "replacement", force: true }),
    ).rejects.toThrow(/injected value failure/u);
    await expect(test.repository.revealValue("ROLLBACK_OVERWRITE")).resolves.toBe("preserved");

    await test.repository.setWithGrant({ key: "OLD_TARGET", value: "old-value" });
    await test.repository.setWithGrant({ key: "NEW_TARGET", value: "new-value" });
    await test.repository.grantAccess({
      storedKey: "OLD_TARGET",
      referenceName: "EXACT_REF",
      capletId: "caplet-u6",
      origin,
    });
    await test.repository.grantAccess({
      storedKey: "NEW_TARGET",
      referenceName: "EXACT_REF",
      capletId: "caplet-u6",
      origin,
    });
    await expect(
      test.repository.listAccess({ referenceName: "EXACT_REF", capletId: "caplet-u6", origin }),
    ).resolves.toMatchObject([{ storedKey: "NEW_TARGET" }]);
    await expect(
      test.repository.resolveGrantedValue({
        referenceName: "EXACT_REF",
        capletId: "caplet-u6",
        origin,
      }),
    ).resolves.toEqual({ storedKey: "NEW_TARGET", value: "new-value" });
  });

  it.skipIf(!postgresAdminUrl)(
    "preserves security, Vault, authorization, activity, and key lifecycle contracts on real Postgres",
    async () => {
      const test = await postgresSecurityFixture();
      await seedAuthorizationRows(test.dialect);
      await seedCaplet(test.dialect);
      const manager = createControlPlaneKeyRotationManager({
        identity,
        dialect: test.dialect,
      });
      await expect(
        manager.registerActiveVersion({
          provider: test.keyProvider,
          purpose: "vault-record",
        }),
      ).resolves.toMatchObject({ keyVersion: 1, state: "active" });
      await expect(
        manager.verifyNodeCanary({
          nodeId: "postgres-node-a",
          purpose: "vault-record",
          keyVersion: 1,
          provider: test.keyProvider,
        }),
      ).resolves.toMatchObject({ verified: true, readiness: "canary-verified" });

      const operator = await test.repository.issueClient({
        hostUrl: "http://127.0.0.1:3100",
        clientLabel: "postgres-operator",
        role: "operator",
      });
      await expect(
        test.repository.validateAccessToken({
          hostUrl: operator.hostUrl,
          accessToken: operator.accessToken,
          requiredRole: "operator",
        }),
      ).resolves.toMatchObject({ clientId: operator.clientId, role: "operator" });
      const session = await test.repository.create({ operatorClientId: operator.clientId });
      await expect(
        test.repository.validate({
          cookieValue: session.cookieValue,
          requireCsrf: true,
          csrfToken: session.session.csrfToken,
        }),
      ).resolves.toMatchObject({ sessionId: session.session.sessionId });
      await expect(
        test.repository.validate({
          cookieValue: session.cookieValue,
          requireCsrf: true,
          csrfToken: "wrong-csrf",
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      await expect(
        test.repository.authorize({
          ...identity,
          actorId: operator.clientId,
          requiredRole: "operator",
        }),
      ).resolves.toMatchObject({ status: "authorized" });
      await test.repository.changeClientRole(operator.clientId, "access");
      await expect(
        test.repository.authorize({
          ...identity,
          actorId: operator.clientId,
          requiredRole: "operator",
        }),
      ).resolves.toEqual({ status: "denied", reason: "role-insufficient" });
      await expect(
        test.repository.authorize({
          ...identity,
          actorId: operator.clientId,
          requiredRole: "access",
        }),
      ).resolves.toMatchObject({ status: "authorized" });
      await expect(
        test.repository.validate({ cookieValue: session.cookieValue }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });

      const refreshable = await test.repository.issueClient({
        hostUrl: operator.hostUrl,
        clientLabel: "postgres-refresh",
        role: "access",
      });
      const rotated = await test.repository.refreshClientCredentials({
        hostUrl: refreshable.hostUrl,
        refreshToken: refreshable.refreshToken,
      });
      await expect(
        test.repository.validateAccessToken({
          hostUrl: refreshable.hostUrl,
          accessToken: refreshable.accessToken,
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await expect(
        test.repository.validateAccessToken({
          hostUrl: rotated.hostUrl,
          accessToken: rotated.accessToken,
        }),
      ).resolves.toMatchObject({ clientId: refreshable.clientId });
      await expect(
        test.repository.refreshClientCredentials({
          hostUrl: refreshable.hostUrl,
          refreshToken: refreshable.refreshToken,
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await expect(
        test.repository.validateAccessToken({
          hostUrl: rotated.hostUrl,
          accessToken: rotated.accessToken,
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });

      const approval = await test.repository.createPendingApproval();
      const competing = await Promise.all([
        test.repository.resolvePendingApproval({
          approvalId: approval.approvalId,
          code: approval.code,
          action: "approve",
        }),
        test.repository.resolvePendingApproval({
          approvalId: approval.approvalId,
          code: approval.code,
          action: "cancel",
        }),
      ]);
      expect(new Set(competing.map((result) => result.state)).size).toBe(1);
      const expiring = await test.repository.createPendingApproval({ ttlMs: -1 });
      await expect(
        test.repository.resolvePendingApproval({
          approvalId: expiring.approvalId,
          code: expiring.code,
          action: "approve",
        }),
      ).resolves.toMatchObject({ state: "expired" });

      const expiryOperator = await test.repository.issueClient({
        hostUrl: operator.hostUrl,
        clientLabel: "postgres-session-expiry",
        role: "operator",
      });
      const expiredSession = await test.repository.create({
        operatorClientId: expiryOperator.clientId,
      });
      await test.adminQuery(
        "UPDATE caplets.cp_dashboard_session SET absolute_expires_at = $1 WHERE session_id = $2",
        ["1970-01-01T00:00:00.000Z", expiredSession.session.sessionId],
      );
      await expect(
        test.repository.validate({ cookieValue: expiredSession.cookieValue }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });

      const origin = { kind: "project-file" as const, path: "/workspace/postgres.json" };
      const failingVault = createControlPlaneSecurityRepository({
        identity,
        dialect: test.dialect,
        keyProvider: test.keyProvider,
        failureInjector(point) {
          if (point === "after-vault-grant") throw new Error("postgres rollback proof");
        },
      });
      await expect(
        failingVault.setWithGrant({
          key: "PG_ROLLBACK",
          value: "must-not-commit",
          grant: {
            storedKey: "PG_ROLLBACK",
            referenceName: "PG_ROLLBACK_REF",
            capletId: "caplet-u6",
            origin,
          },
        }),
      ).rejects.toThrow(/postgres rollback proof/u);
      await expect(test.repository.getStatus("PG_ROLLBACK")).resolves.toMatchObject({
        present: false,
      });
      await expect(
        test.repository.listAccess({ referenceName: "PG_ROLLBACK_REF" }),
      ).resolves.toEqual([]);

      await test.repository.setWithGrant({ key: "PG_OLD", value: "old-value" });
      await test.repository.setWithGrant({ key: "PG_NEW", value: "new-value" });
      await test.repository.grantAccess({
        storedKey: "PG_OLD",
        referenceName: "PG_REF",
        capletId: "caplet-u6",
        origin,
      });
      await test.repository.grantAccess({
        storedKey: "PG_NEW",
        referenceName: "PG_REF",
        capletId: "caplet-u6",
        origin,
      });
      await expect(
        test.repository.resolveGrantedValue({
          referenceName: "PG_REF",
          capletId: "caplet-u6",
          origin,
        }),
      ).resolves.toEqual({ storedKey: "PG_NEW", value: "new-value" });

      const sentinel = "U6_POSTGRES_SENTINEL";
      await test.repository.writeTokenBundle({
        server: "postgres-oauth",
        accessToken: sentinel,
      });
      await expect(test.repository.readTokenBundle("postgres-oauth")).resolves.toEqual({
        server: "postgres-oauth",
        accessToken: sentinel,
      });
      await test.repository.setWithGrant({ key: "PG_ROTATE", value: sentinel });
      const versionTwoProvider = await createVaultVersionTwoProvider(test.onlineManifestPath);
      await expect(
        manager.registerActiveVersion({
          provider: versionTwoProvider,
          purpose: "vault-record",
        }),
      ).resolves.toMatchObject({ keyVersion: 2, state: "active" });
      await expect(
        manager.verifyNodeCanary({
          nodeId: "postgres-node-a",
          purpose: "vault-record",
          keyVersion: 2,
          provider: versionTwoProvider,
        }),
      ).resolves.toMatchObject({ verified: true });
      const rotatedVault = createControlPlaneSecurityRepository({
        identity,
        dialect: test.dialect,
        keyProvider: versionTwoProvider,
      });
      await expect(rotatedVault.revealValue("PG_ROTATE")).resolves.toBe(sentinel);
      expect(await rotatedVault.reencryptVaultValues()).toBeGreaterThan(0);
      await expect(rotatedVault.revealValue("PG_ROTATE")).resolves.toBe(sentinel);
      expect(
        await test.adminQuery("SELECT id FROM caplets.cp_vault_value WHERE key_version = $1", [1]),
      ).toEqual([]);
      await manager.advancePurgeWatermark({
        purpose: "vault-record",
        keyVersion: 1,
        watermark: 1,
      });
      const retirement = await manager.previewRetirement({
        purpose: "vault-record",
        keyVersion: 1,
        authorityToken: "0:0",
        minimumPurgeWatermark: 1,
      });
      await expect(
        manager.retireVersion({ preview: retirement, authorityToken: "0:0" }),
      ).resolves.toMatchObject({ status: "retired" });

      const activity = await test.repository.append({
        actorClientId: expiryOperator.clientId,
        action: "vault_set",
        target: { type: "vault", id: "PG_ACTIVITY" },
        metadata: { token: sentinel },
      });
      await test.adminQuery(
        "ALTER TABLE caplets.cp_operator_activity DISABLE TRIGGER cp_operator_activity_no_update",
      );
      await test.adminQuery(
        "UPDATE caplets.cp_operator_activity SET expires_at = $1 WHERE activity_id = $2",
        ["1970-01-01T00:00:00.000Z", activity.id],
      );
      await test.adminQuery(
        "ALTER TABLE caplets.cp_operator_activity ENABLE TRIGGER cp_operator_activity_no_update",
      );
      const maintenance = createControlPlaneActivityMaintenanceRepository({
        identity,
        dialect: test.dialect,
      });
      await expect(maintenance.purgeExpired({ watermark: 7, limit: 1 })).resolves.toMatchObject({
        deleted: 1,
        watermark: 7,
      });
      await expect(maintenance.purgeExpired({ watermark: 6, limit: 1 })).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      expect(
        JSON.stringify(
          await test.adminQuery(
            `SELECT encode(verifier_or_ciphertext, 'hex') AS payload FROM caplets.cp_credential
             UNION ALL SELECT encode(access_ciphertext, 'hex') FROM caplets.cp_oauth_token
             UNION ALL SELECT encode(ciphertext, 'hex') FROM caplets.cp_vault_value`,
          ),
        ),
      ).not.toContain(sentinel);
      expect(JSON.stringify(await test.repository.list())).not.toContain(sentinel);
    },
  );
});
