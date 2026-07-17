import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneFilter,
  ControlPlaneOrder,
  ControlPlaneSqlTransaction,
  ControlPlaneTable,
  ControlPlaneTransactionalDialect,
} from "../src/control-plane/store";
import { FilesystemArtifactProvider } from "../src/control-plane/artifacts/filesystem";
import {
  createArtifactProviderIdentity,
  MAX_PORTABLE_ARTIFACT_BYTES,
} from "../src/control-plane/artifacts/provider";
import { createArtifactSessionManager } from "../src/control-plane/artifacts/sessions";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const operationNamespace = "namespace_01J00000000000000000000";
const identity = { logicalHostId, storeId, operationNamespace } as const;
const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const environment: MigrationEnvironment = {
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  hostAdministrator: true,
  now: new Date("2026-07-17T00:00:00.000Z"),
};
const roots: string[] = [];
const dialects: Array<{ close(): Promise<void> }> = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(
  decorateDialect: (
    dialect: ControlPlaneTransactionalDialect,
  ) => ControlPlaneTransactionalDialect = (dialect) => dialect,
) {
  const root = await mkdtemp(join(tmpdir(), "caplets-artifact-sessions-"));
  roots.push(root);
  const artifactsRoot = join(root, "artifacts");
  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    ...identity,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: join(root, "key-provider.json"),
    artifacts: { kind: "filesystem", root: artifactsRoot },
  };
  const sqliteDialect = await openSqliteControlPlaneDialect({ storage, environment, assetRoot });
  dialects.push(sqliteDialect);
  sqliteDialect.migrate();
  const dialect = decorateDialect(sqliteDialect);
  const providerIdentity = createArtifactProviderIdentity({
    kind: "filesystem",
    provider: "owner-private",
    namespace: "control-plane",
    logicalHostId,
    storeId,
  });
  const provider = new FilesystemArtifactProvider(artifactsRoot, providerIdentity);
  const manager = createArtifactSessionManager({
    identity,
    dialect,
    provider,
    expectedProviderIdentity: providerIdentity,
    expectedCanary: "artifact-canary-v1",
  });
  return { manager };
}

function observeArtifactPartReads(
  dialect: ControlPlaneTransactionalDialect,
  reads: Array<Readonly<{ limit: number | undefined; rowCount: number }>>,
): ControlPlaneTransactionalDialect {
  const instrument = (transaction: ControlPlaneSqlTransaction): ControlPlaneSqlTransaction => ({
    ...transaction,
    async select<Row extends ControlPlaneDatabaseRow>(
      table: ControlPlaneTable,
      filter?: ControlPlaneFilter,
      order?: readonly ControlPlaneOrder[],
      limit?: number,
    ) {
      const rows = await transaction.select<Row>(table, filter, order, limit);
      if (table === "artifactParts") reads.push({ limit, rowCount: rows.length });
      return rows;
    },
  });
  return {
    ...dialect,
    snapshotTransaction<T>(
      work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
    ): Promise<T> {
      return dialect.snapshotTransaction((transaction) => work(instrument(transaction)));
    },
  };
}

afterEach(async () => {
  await Promise.all(dialects.splice(0).map((dialect) => dialect.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQL artifact session lifecycle", () => {
  it("round-trips deterministic text and binary bytes through bounded immutable parts", async () => {
    const { manager } = await fixture();
    const bytes = Uint8Array.from([...new TextEncoder().encode("portable\ntext\n"), 0, 127, 255]);
    const now = new Date("2026-07-17T01:00:00.000Z");
    const session = await manager.createUploadSession({
      actorId: "operator-1",
      operationId: "operation-1",
      expectedByteLength: bytes.byteLength,
      expectedSha256: sha256(bytes),
      mimeType: "application/vnd.caplets.portable+json",
      now,
    });
    const split = 5;
    await manager.append({
      actorId: "operator-1",
      operationId: "operation-1",
      sessionId: session.sessionId,
      offset: 0,
      chunkSha256: sha256(bytes.subarray(0, split)),
      bytes: bytes.subarray(0, split),
      now,
    });
    await manager.append({
      actorId: "operator-1",
      operationId: "operation-1",
      sessionId: session.sessionId,
      offset: split,
      chunkSha256: sha256(bytes.subarray(split)),
      bytes: bytes.subarray(split),
      now,
    });
    const finalized = await manager.finalize(session.sessionId, "operator-1", "operation-1", now);
    expect(finalized.manifest.partCount).toBe(2);
    await expect(
      manager.readFinalizedArtifact(finalized.manifest.artifactId, "operator-1", "operation-1"),
    ).resolves.toEqual(Buffer.from(bytes));
  });

  it("reads at most one indexed part row per append across a maximum-part upload", async () => {
    const partReads: Array<Readonly<{ limit: number | undefined; rowCount: number }>> = [];
    const { manager } = await fixture((dialect) => observeArtifactPartReads(dialect, partReads));
    const partCount = 256;
    const bytes = Uint8Array.from({ length: partCount }, (_, ordinal) => ordinal);
    const now = new Date("2026-07-17T01:30:00.000Z");
    const session = await manager.createUploadSession({
      actorId: "operator-many",
      operationId: "operation-many",
      expectedByteLength: bytes.byteLength,
      expectedSha256: sha256(bytes),
      mimeType: "application/octet-stream",
      now,
    });

    for (let ordinal = 0; ordinal < partCount; ordinal += 1) {
      const chunk = bytes.subarray(ordinal, ordinal + 1);
      await manager.append({
        actorId: "operator-many",
        operationId: "operation-many",
        sessionId: session.sessionId,
        offset: ordinal,
        chunkSha256: sha256(chunk),
        bytes: chunk,
        now,
      });
    }

    expect(partReads).toHaveLength(partCount);
    expect(partReads.every((read) => read.limit === 1 && read.rowCount <= 1)).toBe(true);
    expect(partReads.reduce((total, read) => total + read.rowCount, 0)).toBe(partCount - 1);

    const lastChunk = bytes.subarray(partCount - 1);
    await expect(
      manager.append({
        actorId: "operator-many",
        operationId: "operation-many",
        sessionId: session.sessionId,
        offset: partCount - 1,
        chunkSha256: sha256(lastChunk),
        bytes: lastChunk,
        now,
      }),
    ).rejects.toThrow(/offset does not match resumable status/u);
    await expect(
      manager.status(session.sessionId, "operator-many", "operation-many"),
    ).resolves.toMatchObject({ nextOffset: partCount, state: "uploading" });

    const finalized = await manager.finalize(
      session.sessionId,
      "operator-many",
      "operation-many",
      now,
    );
    expect(finalized.manifest.partCount).toBe(partCount);
    expect(partReads.at(-1)).toEqual({ limit: undefined, rowCount: partCount });
  }, 30_000);

  it("accepts the exact portable limit and rejects one byte more before reservation", async () => {
    const { manager } = await fixture();
    await expect(
      manager.createUploadSession({
        actorId: "operator-1",
        operationId: "operation-limit",
        expectedByteLength: MAX_PORTABLE_ARTIFACT_BYTES,
        expectedSha256: "0".repeat(64),
        mimeType: "application/octet-stream",
      }),
    ).resolves.toMatchObject({ expectedByteLength: MAX_PORTABLE_ARTIFACT_BYTES, nextOffset: 0 });
    await expect(
      manager.createUploadSession({
        actorId: "operator-1",
        operationId: "operation-too-large",
        expectedByteLength: MAX_PORTABLE_ARTIFACT_BYTES + 1,
        expectedSha256: "0".repeat(64),
        mimeType: "application/octet-stream",
      }),
    ).rejects.toThrow(/envelope declaration is invalid/u);
  });

  it("keeps stale proposal rejection inert and consumes a valid proposal once", async () => {
    const { manager } = await fixture();
    const bytes = new TextEncoder().encode("proposal bytes");
    const published = await manager.publishDownloadArtifact(
      "operator-1",
      "operation-proposal",
      bytes,
      "application/octet-stream",
    );
    const fence = {
      authorityGeneration: 4,
      effectiveGeneration: 7,
      securityEpoch: 2,
      runtimeFingerprint: "f".repeat(64),
      aggregateVersion: 3,
    };
    const proposal = await manager.createImportProposal({
      actorId: "operator-1",
      operationId: "operation-proposal",
      artifactId: published.manifest.artifactId,
      capletId: "portable-caplet",
      artifactSha256: sha256(bytes),
      fence,
      collisionPolicy: "reject",
      replacementConfirmed: false,
      consequence: "effective-runtime-changes",
      differences: [],
      setupDependencies: [],
    });
    let activations = 0;
    const stale = await manager.consumeImportProposal(
      {
        actorId: "operator-1",
        operationId: "operation-proposal",
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        artifactSha256: sha256(bytes),
        fence: { ...fence, effectiveGeneration: 8 },
      },
      async () => ++activations,
    );
    expect(stale).toEqual({ status: "rejected", reason: "stale-generation" });
    expect(activations).toBe(0);
    const committed = await manager.consumeImportProposal(
      {
        actorId: "operator-1",
        operationId: "operation-proposal",
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        artifactSha256: sha256(bytes),
        fence,
      },
      async () => ++activations,
    );
    expect(committed.status).toBe("committed");
    expect(activations).toBe(1);
    await expect(
      manager.consumeImportProposal(
        {
          actorId: "operator-1",
          operationId: "operation-proposal",
          proposalId: proposal.proposalId,
          proposalHash: proposal.proposalHash,
          artifactSha256: sha256(bytes),
          fence,
        },
        async () => ++activations,
      ),
    ).resolves.toEqual({ status: "rejected", reason: "consumed" });
    expect(activations).toBe(1);
  });
});
