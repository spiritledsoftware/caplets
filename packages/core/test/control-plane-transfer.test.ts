import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import {
  attachVerifiedPostgresPools,
  type PostgresControlPlaneDialect,
  type PostgresPool,
} from "../src/control-plane/dialect/postgres";
import {
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../src/control-plane/dialect/migrations";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import { quoteSafeSqlIdentifier } from "../src/control-plane/schema/model-codec";
import type {
  ResolvedPostgresStorage,
  ResolvedSqliteStorage,
} from "../src/control-plane/storage-config";
import { stableJsonStringify } from "../src/stable-json";
import {
  LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET,
  createOfflineSqlTransferOperations,
} from "../src/control-plane/operations";
import {
  SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES,
  assertSqlTransferSemanticManifest,
  sqlTransferManifestDigest,
  type SqlTransferSemanticManifest,
} from "../src/control-plane/migration/manifest";
import {
  SQL_TRANSFER_FAILURE_POINTS,
  SqlTransferError,
  createSqliteToPostgresTransferCoordinator,
  createSqlTransferJournalRepository,
  sqlTransferAuthorityState,
  sqlTransferSemanticDomainDigest,
  type SqliteToPostgresTransferPort,
  type SqlTransferActivationEvidence,
  type SqlTransferActivationPlan,
  type SqlTransferConfirmation,
  type SqlTransferFailurePoint,
  type SqlTransferJournalPort,
  type SqlTransferJournalSnapshot,
  type SqlTransferJournalState,
  type SqlTransferNodeReadiness,
  type SqlTransferStartRequest,
} from "../src/control-plane/migration/transfer";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const identity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
} as const;
const chunks = [Buffer.from("alpha"), Buffer.from("bravo")] as const;
const request: SqlTransferStartRequest = {
  transferId: "transfer_01J00000000000000000000000",
  identity,
  sourceDescriptorDigest: digest("source-descriptor"),
  destinationDescriptorDigest: digest("destination-descriptor"),
  sourceKeyProviderIdentity: "source-keyring",
  destinationKeyProviderIdentity: "destination-keyring",
  maxChunkBytes: 5,
};

function semanticManifest(overrides: Partial<SqlTransferSemanticManifest> = {}) {
  return {
    format: "caplets-sql-transfer-manifest-v1",
    transferId: request.transferId,
    identity,
    source: {
      backend: "sqlite",
      descriptorDigest: request.sourceDescriptorDigest,
      keyProviderIdentity: request.sourceKeyProviderIdentity,
    },
    destination: {
      backend: "postgres",
      descriptorDigest: request.destinationDescriptorDigest,
      keyProviderIdentity: request.destinationKeyProviderIdentity,
    },
    schemaDigest: digest("schema"),
    semanticDomains: SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES.map((name, index) => ({
      name,
      count: index + 1,
      sha256: digest(name),
    })),
    sourceAuthorityGeneration: 2,
    sourceSecurityEpoch: 3,
    sourceWriterEpoch: 1,
    destinationAuthorityGeneration: 3,
    projectedSecurityEpoch: 4,
    invalidationDigest: digest("invalidations"),
    expectedSealedSourceDigest: digest("sealed-source"),
    chunkCount: chunks.length,
    totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    maxChunkBytes: request.maxChunkBytes,
    requiredDestinationNodeIds: ["node-a", "node-b"],
    ...overrides,
  } as SqlTransferSemanticManifest;
}

class MemoryJournal implements SqlTransferJournalPort {
  snapshot: SqlTransferJournalSnapshot = { status: "absent" };

  async read(transferId: string) {
    if (this.snapshot.status === "present" && this.snapshot.state.transferId !== transferId) {
      return { status: "absent" } as const;
    }
    return structuredClone(this.snapshot);
  }

  async compareAndSet(
    transferId: string,
    expectedRevision: number | undefined,
    next: SqlTransferJournalState,
  ) {
    const actual = this.snapshot.status === "present" ? this.snapshot.revision : undefined;
    if (actual !== expectedRevision || next.transferId !== transferId) return "conflict" as const;
    this.snapshot = {
      status: "present",
      revision: expectedRevision === undefined ? 0 : expectedRevision + 1,
      state: structuredClone(next),
    };
    return structuredClone(this.snapshot);
  }
}

type FixtureFault =
  | "live-writer"
  | "busy-wal"
  | "corrupt-source"
  | "nonempty-destination"
  | "wrong-host"
  | "capacity"
  | "hash"
  | "manifest";

class TransferFixture implements SqliteToPostgresTransferPort {
  readonly journal = new MemoryJournal();
  readonly manifest = semanticManifest();
  readonly staged = new Map<number, Uint8Array>();
  readonly events: string[] = [];
  readonly access = { source: 0, destination: 0, secrets: 0 };
  fault?: FixtureFault;
  readinessSuppressed = false;
  confirmationValidation: "valid" | "invalid" | "stale" | "reused" = "valid";
  activated: SqlTransferActivationEvidence | undefined;
  oldFenceCommitAccepted = false;

  async preflightDestination(_input: SqlTransferStartRequest) {
    this.access.destination += 1;
    if (this.fault === "nonempty-destination" || this.fault === "wrong-host")
      throw new Error("bad target");
    return { capacityBytes: this.fault === "capacity" ? 1 : 1_000_000 };
  }

  async quiesceSource() {
    this.access.source += 1;
    if (this.fault === "live-writer") throw new Error("writer live");
    this.events.push("quiesce");
    return { fenceId: "initial-fence", writerEpoch: 1, authorityGeneration: 2, securityEpoch: 3 };
  }

  async checkpointSourceWal() {
    this.events.push("checkpoint");
    if (this.fault === "busy-wal") throw new Error("wal busy");
  }

  async verifySourceIntegrity() {
    this.events.push("integrity");
    if (this.fault === "corrupt-source") throw new Error("corrupt");
  }

  async createSemanticManifest() {
    this.access.secrets += 1;
    return this.fault === "manifest"
      ? semanticManifest({ transferId: "another-transfer" })
      : this.manifest;
  }

  async createRecoveryBackup(manifest: SqlTransferSemanticManifest, manifestDigest: string) {
    this.events.push("backup");
    return {
      backupId: "backup-source-recovery",
      manifestDigest,
      recoveryAuthorityDigest: digest(`source-recovery:${manifest.transferId}`),
    };
  }

  async readTransferChunk(_manifest: SqlTransferSemanticManifest, ordinal: number) {
    this.access.secrets += 1;
    return chunks[ordinal];
  }

  async stageDestinationChunk(
    _transferId: string,
    _manifestDigest: string,
    receipt: { ordinal: number },
    bytes: Uint8Array,
  ) {
    this.staged.set(receipt.ordinal, new Uint8Array(bytes));
    this.events.push(`stage:${receipt.ordinal}`);
  }

  async readDestinationChunk(_transferId: string, _manifestDigest: string, ordinal: number) {
    const bytes = this.staged.get(ordinal);
    if (bytes && this.fault === "hash") return Buffer.concat([bytes, Buffer.from("x")]);
    return bytes;
  }

  async verifyDestinationStage(manifest: SqlTransferSemanticManifest) {
    return {
      manifestDigest: sqlTransferManifestDigest(manifest),
      semanticDigest: sqlTransferSemanticDomainDigest(manifest),
      consumedOperationsDigest: digest("consumed-operations"),
    };
  }

  async previewConfirmation(action: "cutover" | "finalize", state: SqlTransferJournalState) {
    return confirmation(action, state);
  }

  async validateConfirmationWithoutSideEffects(
    candidate: SqlTransferConfirmation,
    state: SqlTransferJournalState,
  ) {
    if (this.confirmationValidation !== "valid") return this.confirmationValidation;
    return candidate.transferId === state.transferId &&
      candidate.manifestDigest === state.manifestDigest
      ? ("valid" as const)
      : ("invalid" as const);
  }

  async acquireFreshSourceFence() {
    this.events.push("fresh-fence");
    return { fenceId: "fresh-fence", writerEpoch: 2, authorityGeneration: 2, securityEpoch: 3 };
  }

  async sealSourceAtomically(manifest: SqlTransferSemanticManifest) {
    this.events.push("seal");
    this.oldFenceCommitAccepted = false;
    return {
      manifestDigest: sqlTransferManifestDigest(manifest),
      sealedSourceDigest: manifest.expectedSealedSourceDigest,
      invalidationDigest: manifest.invalidationDigest,
      authorityGeneration: manifest.sourceAuthorityGeneration,
      securityEpoch: manifest.projectedSecurityEpoch,
      writerEpoch: 2,
    };
  }

  async revalidateSourceSeal() {
    return true;
  }

  async beginDescriptorRebind() {
    this.events.push("descriptor-pending");
  }

  async enterDestinationCutoverPending() {
    this.events.push("destination-read-only");
  }

  async prepareDestinationActivation(manifest: SqlTransferSemanticManifest) {
    this.events.push("prepare-activation");
    return activationPlan(manifest);
  }

  async readDestinationNodeReadiness(
    _transferId: string,
    plan: SqlTransferActivationPlan,
  ): Promise<readonly SqlTransferNodeReadiness[]> {
    return this.readinessSuppressed
      ? [readyNode(plan, "node-a")]
      : plan.requiredNodeIds.map((nodeId) => readyNode(plan, nodeId));
  }

  async revalidateBeforeActivation() {
    return true;
  }

  async destinationActivationStatus() {
    return this.activated ?? ("inactive" as const);
  }

  async activateDestinationAtomically(
    _state: SqlTransferJournalState,
    plan: SqlTransferActivationPlan,
  ) {
    this.events.push("activate-marker");
    this.activated = activationEvidence(plan);
    return this.activated;
  }

  async activateDescriptorBinding() {
    this.events.push("descriptor-bound");
  }

  async forceHydrateDestinationNodes() {
    this.events.push("hydrate");
  }

  async writeFinalizeDestructionIntents() {
    this.events.push("destruction-intents");
    return { intentDigest: digest("destruction-intents"), intentCount: 2 };
  }

  async finishTransferLedgers() {
    this.events.push("final-ledgers");
  }

  async discardDestinationStage() {
    this.events.push("discard-stage");
    this.staged.clear();
  }

  async restoreSourceDescriptor() {
    this.events.push("restore-descriptor");
  }

  async preserveSecurityInvalidationsOnRollback() {
    this.events.push("preserve-invalidations");
  }

  async unsealSourceAfterRollback() {
    this.events.push("unseal-source");
  }

  async finishRollbackLedgers() {
    this.events.push("rollback-ledgers");
  }
}

function activationPlan(manifest: SqlTransferSemanticManifest): SqlTransferActivationPlan {
  return {
    authorityGeneration: manifest.destinationAuthorityGeneration,
    authorityTokenDigest: digest("fresh-authority-token"),
    keyCanaryDigest: digest("destination-key-canary"),
    writerEpoch: 1,
    requiredNodeIds: manifest.requiredDestinationNodeIds,
  };
}

function readyNode(plan: SqlTransferActivationPlan, nodeId: string): SqlTransferNodeReadiness {
  return {
    nodeId,
    authorityGeneration: plan.authorityGeneration,
    authorityTokenDigest: plan.authorityTokenDigest,
    keyCanaryDigest: plan.keyCanaryDigest,
    writerEpoch: plan.writerEpoch,
  };
}

function activationEvidence(plan: SqlTransferActivationPlan): SqlTransferActivationEvidence {
  return {
    markerDigest: digest("durable-activation-marker"),
    authorityGeneration: plan.authorityGeneration,
    authorityTokenDigest: plan.authorityTokenDigest,
    keyCanaryDigest: plan.keyCanaryDigest,
    writerEpoch: plan.writerEpoch,
  };
}

function confirmation(
  action: "cutover" | "finalize",
  state: SqlTransferJournalState,
): SqlTransferConfirmation {
  return {
    action,
    transferId: state.transferId,
    token: `${action}-token`,
    manifestDigest: state.manifestDigest!,
    authorityGeneration:
      action === "cutover"
        ? state.manifest!.sourceAuthorityGeneration
        : state.manifest!.destinationAuthorityGeneration,
    expiresAt: "2099-01-01T00:00:00.000Z",
    consequencesDigest: digest(`${action}-consequences`),
  };
}

async function stage(fixture = new TransferFixture()) {
  const coordinator = createSqliteToPostgresTransferCoordinator({ port: fixture });
  const state = await coordinator.start(request);
  expect(state.phase).toBe("destination-verified");
  return { fixture, coordinator, state };
}

async function cutover(fixture = new TransferFixture()) {
  const staged = await stage(fixture);
  const preview = await staged.coordinator.previewCutover(request.transferId);
  const state = await staged.coordinator.cutover(request.transferId, preview);
  expect(state.phase).toBe("destination-ready");
  return { ...staged, state, preview };
}

describe("U12 canonical transfer manifest", () => {
  it("binds the preserved store/host/operation namespace and exact semantic coverage", () => {
    const manifest = semanticManifest();
    expect(() => assertSqlTransferSemanticManifest(manifest)).not.toThrow();
    expect(manifest.identity).toEqual(identity);
    expect(
      manifest.semanticDomains.find((domain) => domain.name === "consumed-operations")?.sha256,
    ).toBe(digest("consumed-operations"));
    expect(sqlTransferManifestDigest(manifest)).toHaveLength(64);
  });

  it("fails closed for a noncanonical readiness set or manifest field", () => {
    expect(() =>
      assertSqlTransferSemanticManifest(
        semanticManifest({ requiredDestinationNodeIds: ["node-b", "node-a"] }),
      ),
    ).toThrow("SQL transfer manifest verification failed");
    expect(() =>
      assertSqlTransferSemanticManifest({ ...semanticManifest(), plaintext: "secret" } as never),
    ).toThrow("SQL transfer manifest verification failed");
  });
});

describe("U12 bounded resumable transfer state machine", () => {
  it("quiesces, checkpoints, verifies, stages bounded chunks by readback, and preserves namespaces", async () => {
    const { fixture, state } = await stage();
    expect(state.request.identity).toEqual(identity);
    expect(state.chunks).toEqual([
      { ordinal: 0, byteLength: 5, sha256: digest(chunks[0]) },
      { ordinal: 1, byteLength: 5, sha256: digest(chunks[1]) },
    ]);
    expect(fixture.events).toEqual([
      "quiesce",
      "checkpoint",
      "integrity",
      "backup",
      "stage:0",
      "stage:1",
    ]);
    expect(JSON.stringify(state)).not.toContain("alpha");
  });

  it.each([
    "live-writer",
    "busy-wal",
    "corrupt-source",
    "nonempty-destination",
    "wrong-host",
    "capacity",
    "hash",
    "manifest",
  ] satisfies readonly FixtureFault[])("fails before activation for %s", async (fault) => {
    const fixture = new TransferFixture();
    fixture.fault = fault;
    const coordinator = createSqliteToPostgresTransferCoordinator({ port: fixture });
    await expect(coordinator.start(request)).rejects.toBeInstanceOf(SqlTransferError);
    expect(fixture.activated).toBeUndefined();
    if (fault === "nonempty-destination" || fault === "wrong-host") {
      expect(fixture.access.source).toBe(0);
      expect(fixture.access.secrets).toBe(0);
    }
  });

  it("requires two destination nodes to hold the fresh token, canary, and writer epoch", async () => {
    const fixture = new TransferFixture();
    fixture.readinessSuppressed = true;
    const coordinator = createSqliteToPostgresTransferCoordinator({ port: fixture });
    await coordinator.start(request);
    const preview = await coordinator.previewCutover(request.transferId);
    await expect(coordinator.cutover(request.transferId, preview)).rejects.toMatchObject({
      code: "destination_not_ready",
    });
    expect(fixture.activated).toBeUndefined();
    fixture.readinessSuppressed = false;
    expect((await coordinator.cutover(request.transferId, preview)).phase).toBe(
      "destination-ready",
    );
  });

  it("rejects missing, stale, and reused confirmations before the protected boundary", async () => {
    const { fixture, coordinator } = await stage();
    await expect(coordinator.cutover(request.transferId, undefined)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    const preview = await coordinator.previewCutover(request.transferId);
    fixture.confirmationValidation = "stale";
    await expect(coordinator.cutover(request.transferId, preview)).rejects.toMatchObject({
      code: "confirmation_stale",
    });
    fixture.confirmationValidation = "reused";
    await expect(coordinator.cutover(request.transferId, preview)).rejects.toMatchObject({
      code: "confirmation_reused",
    });
    expect(fixture.events).not.toContain("fresh-fence");
  });

  it("rejects a reused finalize confirmation before destination activation", async () => {
    const { fixture, coordinator } = await cutover();
    const preview = await coordinator.previewFinalize(request.transferId);
    fixture.confirmationValidation = "reused";
    await expect(coordinator.finalize(request.transferId, preview)).rejects.toMatchObject({
      code: "confirmation_reused",
    });
    expect(fixture.activated).toBeUndefined();
  });

  it("seals under a fresh fence before the irreversible marker and never exposes two writers", async () => {
    const { fixture, coordinator, state } = await cutover();
    expect(state.sourceSeal?.writerEpoch).toBe(2);
    expect(fixture.oldFenceCommitAccepted).toBe(false);
    expect(sqlTransferAuthorityState(state)).toEqual({
      sourceWritable: false,
      destinationWritable: false,
    });
    const finalizePreview = await coordinator.previewFinalize(request.transferId);
    const completed = await coordinator.finalize(request.transferId, finalizePreview);
    expect(completed.phase).toBe("completed");
    expect(sqlTransferAuthorityState(completed)).toEqual({
      sourceWritable: false,
      destinationWritable: true,
    });
    expect(fixture.events.indexOf("seal")).toBeLessThan(fixture.events.indexOf("activate-marker"));
    expect(fixture.events.indexOf("activate-marker")).toBeLessThan(
      fixture.events.indexOf("descriptor-bound"),
    );
  });

  it("rolls back only before activation, preserving invalidations before unsealing", async () => {
    const { fixture, coordinator } = await cutover();
    const rolledBack = await coordinator.rollback(request.transferId);
    expect(rolledBack.phase).toBe("rolled-back");
    expect(fixture.events.slice(-5)).toEqual([
      "discard-stage",
      "restore-descriptor",
      "preserve-invalidations",
      "unseal-source",
      "rollback-ledgers",
    ]);
    expect(sqlTransferAuthorityState(rolledBack)).toEqual({
      sourceWritable: true,
      destinationWritable: false,
    });
  });

  it("can abandon a validated transfer before source or manifest access", async () => {
    const fixture = new TransferFixture();
    const faulted = createSqliteToPostgresTransferCoordinator({
      port: fixture,
      failureInjector(point) {
        if (point === "after-validated") throw new Error("stop after preflight");
      },
    });
    await expect(faulted.start(request)).rejects.toMatchObject({ code: "transfer_interrupted" });
    expect(fixture.access.source).toBe(0);
    const coordinator = createSqliteToPostgresTransferCoordinator({ port: fixture });
    expect((await coordinator.rollback(request.transferId)).phase).toBe("rolled-back");
  });

  it("is roll-forward-only after the durable destination marker", async () => {
    const { fixture, coordinator } = await cutover();
    const finalizePreview = await coordinator.previewFinalize(request.transferId);
    let fired = false;
    const faulted = createSqliteToPostgresTransferCoordinator({
      port: fixture,
      failureInjector(point) {
        if (!fired && point === "after-destination-activated") {
          fired = true;
          throw new Error("crash");
        }
      },
    });
    await expect(faulted.finalize(request.transferId, finalizePreview)).rejects.toMatchObject({
      code: "transfer_interrupted",
    });
    await expect(coordinator.rollback(request.transferId)).rejects.toMatchObject({
      code: "rollback_forbidden",
    });
    expect((await coordinator.finalize(request.transferId, finalizePreview)).phase).toBe(
      "completed",
    );
  });

  it("resumes after every forward journal boundary fault", async () => {
    const rollbackPoints = new Set([
      "after-rollback-pending",
      "after-rollback-staging-discarded",
      "after-rollback-descriptor-restored",
      "after-rollback-invalidations-preserved",
      "after-rolled-back",
    ]);
    for (const point of SQL_TRANSFER_FAILURE_POINTS.filter((item) => !rollbackPoints.has(item))) {
      const fixture = new TransferFixture();
      let fired = false;
      const faulted = createSqliteToPostgresTransferCoordinator({
        port: fixture,
        failureInjector(candidate) {
          if (!fired && candidate === point) {
            fired = true;
            throw new Error("injected boundary fault");
          }
        },
      });
      const plain = createSqliteToPostgresTransferCoordinator({ port: fixture });
      await driveForward(faulted, fixture).catch(() => undefined);
      if (fixture.journal.snapshot.status !== "present") throw new Error(`missing ${point}`);
      const phase = fixture.journal.snapshot.state.phase;
      if (phase !== "completed") await driveForward(plain, fixture);
      expect((fixture.journal.snapshot as { state: SqlTransferJournalState }).state.phase).toBe(
        "completed",
      );
      expect(fired, point).toBe(true);
    }
  });

  it("resumes after every rollback journal boundary fault", async () => {
    const points = [
      "after-rollback-pending",
      "after-rollback-staging-discarded",
      "after-rollback-descriptor-restored",
      "after-rollback-invalidations-preserved",
      "after-rolled-back",
    ] as const satisfies readonly SqlTransferFailurePoint[];
    for (const point of points) {
      const fixture = new TransferFixture();
      const plain = createSqliteToPostgresTransferCoordinator({ port: fixture });
      await plain.start(request);
      let fired = false;
      const faulted = createSqliteToPostgresTransferCoordinator({
        port: fixture,
        failureInjector(candidate) {
          if (!fired && candidate === point) {
            fired = true;
            throw new Error("rollback boundary fault");
          }
        },
      });
      await faulted.rollback(request.transferId).catch(() => undefined);
      if (
        (fixture.journal.snapshot as { state: SqlTransferJournalState }).state.phase !==
        "rolled-back"
      ) {
        await plain.rollback(request.transferId);
      }
      expect((fixture.journal.snapshot as { state: SqlTransferJournalState }).state.phase).toBe(
        "rolled-back",
      );
      expect(fired, point).toBe(true);
    }
  });
});

async function driveForward(
  coordinator: ReturnType<typeof createSqliteToPostgresTransferCoordinator>,
  fixture: TransferFixture,
): Promise<void> {
  const current = fixture.journal.snapshot;
  if (current.status === "absent" || beforeOrAt(current.state.phase, "destination-verified")) {
    await coordinator.start(request);
  }
  const staged = fixture.journal.snapshot;
  if (
    staged.status === "present" &&
    [
      "destination-verified",
      "seal-fence-acquired",
      "source-sealed",
      "descriptor-pending",
      "destination-pending",
      "destination-ready",
    ].includes(staged.state.phase)
  ) {
    await coordinator.cutover(request.transferId, confirmation("cutover", staged.state));
  }
  const cut = fixture.journal.snapshot;
  if (cut.status === "present" && cut.state.phase !== "completed") {
    await coordinator.finalize(request.transferId, confirmation("finalize", cut.state));
  }
}

function beforeOrAt(phase: string, terminal: string): boolean {
  const order = [
    "validated",
    "source-quiesced",
    "source-checkpointed",
    "source-integrity-verified",
    "manifest-recorded",
    "backup-durable",
    "destination-staging",
    "destination-verified",
  ];
  return order.indexOf(phase) >= 0 && order.indexOf(phase) <= order.indexOf(terminal);
}

describe("U12 offline operation authority", () => {
  it.each([
    undefined,
    {},
    { target: "project", mode: "offline", transport: "local" },
    { target: "global", mode: "offline", transport: "remote" },
    { target: "global", mode: "online", transport: "local" },
    { ...LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET, remote: true },
  ])(
    "rejects invalid or mixed target before auth, dependency, source, or destination access",
    async (administration) => {
      let authorization = 0;
      let resolution = 0;
      const operations = createOfflineSqlTransferOperations({
        authorizeLocalGlobalAdministration() {
          authorization += 1;
          return true;
        },
        resolveCoordinator() {
          resolution += 1;
          throw new Error("must not resolve");
        },
      });
      await expect(operations.start({ administration, transfer: request })).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      expect({ authorization, resolution }).toEqual({ authorization: 0, resolution: 0 });
    },
  );

  it("reports the accepted local --global target without secret material", async () => {
    const fixture = new TransferFixture();
    const operations = createOfflineSqlTransferOperations({
      authorizeLocalGlobalAdministration: () => true,
      resolveCoordinator: () => createSqliteToPostgresTransferCoordinator({ port: fixture }),
    });
    const receipt = await operations.start({
      administration: LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET,
      transfer: request,
    });
    expect(receipt).toMatchObject({
      status: "accepted",
      target: "global",
      mode: "offline",
      transport: "local",
      phase: "destination-verified",
      guidance: "confirm-cutover",
    });
    expect(stableJsonStringify(receipt)).not.toContain("token");
  });
});

const postgresAdminUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const migrationAssetRoot = resolve(import.meta.dirname, "..", "drizzle");
const nodeRequire = createRequire(import.meta.url);

describe.sequential("U12 paired durable transfer journal", () => {
  it.skipIf(!postgresAdminUrl)(
    "persists and resumes the same journal revision in real SQLite and Postgres",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "caplets-u12-transfer-"));
      await chmod(root, 0o700);
      const sourceStorage: ResolvedSqliteStorage = {
        backend: "sqlite",
        ...identity,
        stateRoot: root,
        databasePath: join(root, "source.sqlite3"),
        keyProviderManifest: join(root, "source-keys.json"),
        artifacts: { kind: "filesystem", root: join(root, "artifacts") },
      };
      let source = await openSqliteControlPlaneDialect({
        storage: sourceStorage,
        environment: transferMigrationEnvironment(),
        assetRoot: migrationAssetRoot,
      });
      source.migrate();
      await createControlPlaneRepository({ identity, dialect: source }).initialize();
      const destination = await realPostgresTransferFixture(postgresAdminUrl!);
      try {
        const repository = createSqlTransferJournalRepository({
          identity,
          source,
          destination: destination.dialect,
        });
        const initial: SqlTransferJournalState = {
          transferId: request.transferId,
          phase: "validated",
          request,
          destinationCapacityBytes: 1_000_000,
        };
        expect(
          await repository.compareAndSet(request.transferId, undefined, initial),
        ).toMatchObject({
          status: "present",
          revision: 0,
        });
        await source.close();
        source = await openSqliteControlPlaneDialect({
          storage: sourceStorage,
          environment: transferMigrationEnvironment(),
          assetRoot: migrationAssetRoot,
        });
        source.migrate();
        const resumed = createSqlTransferJournalRepository({
          identity,
          source,
          destination: destination.dialect,
        });
        expect(await resumed.read(request.transferId)).toEqual({
          status: "present",
          revision: 0,
          state: initial,
        });
      } finally {
        await source.close();
        await destination.cleanup();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function transferMigrationEnvironment(): MigrationEnvironment {
  return {
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
}

async function realPostgresTransferFixture(adminUrl: string): Promise<{
  dialect: PostgresControlPlaneDialect;
  cleanup(): Promise<void>;
}> {
  const Pool = nodeRequire("pg").Pool as new (options: {
    connectionString: string;
    max: number;
  }) => PostgresPool;
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const roles = {
    runtime: `caplets_u12_runtime_${suffix}`,
    migrator: `caplets_u12_migrator_${suffix}`,
    maintenance: `caplets_u12_maintenance_${suffix}`,
  };
  const passwords = {
    runtime: "runtime-transfer-password",
    migrator: "migrator-transfer-password",
    maintenance: "maintenance-transfer-password",
  };
  const databaseName = new URL(adminUrl).pathname.slice(1);
  await admin.query(`
    DROP SCHEMA IF EXISTS caplets CASCADE;
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.runtime)} LOGIN NOINHERIT PASSWORD '${passwords.runtime}';
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.migrator)} LOGIN NOINHERIT PASSWORD '${passwords.migrator}';
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.maintenance)} LOGIN NOINHERIT PASSWORD '${passwords.maintenance}';
    GRANT CREATE ON DATABASE ${quoteSafeSqlIdentifier(databaseName)} TO ${quoteSafeSqlIdentifier(roles.migrator)};
  `);
  const roleUrl = (role: keyof typeof roles) => {
    const url = new URL(adminUrl);
    url.username = roles[role];
    url.password = passwords[role];
    return url.href;
  };
  const pools = {
    runtime: new Pool({ connectionString: roleUrl("runtime"), max: 2 }),
    migrator: new Pool({ connectionString: roleUrl("migrator"), max: 2 }),
    maintenance: new Pool({ connectionString: roleUrl("maintenance"), max: 2 }),
  };
  const storage: ResolvedPostgresStorage = {
    backend: "postgres",
    ...identity,
    stateRoot: "/tmp/caplets-u12-postgres",
    keyProviderManifest: "/tmp/caplets-u12-postgres/key-provider.json",
    artifacts: {
      kind: "s3",
      identity: createArtifactProviderIdentity({
        kind: "s3",
        provider: "https://objects.invalid/caplets-u12",
        namespace: `transfer-${suffix}`,
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
      }),
    },
  };
  const registry = await loadMigrationRegistry({
    dialect: "postgres",
    assetRoot: migrationAssetRoot,
  });
  const dialect = await attachVerifiedPostgresPools({
    storage,
    pools,
    roles,
    registry,
    environment: transferMigrationEnvironment(),
  });
  await dialect.migrate();
  await admin.query(`
    GRANT USAGE ON SCHEMA caplets TO ${quoteSafeSqlIdentifier(roles.runtime)}, ${quoteSafeSqlIdentifier(roles.maintenance)};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caplets TO ${quoteSafeSqlIdentifier(roles.runtime)}, ${quoteSafeSqlIdentifier(roles.maintenance)};
  `);
  await createControlPlaneRepository({ identity, dialect }).initialize();
  return {
    dialect,
    async cleanup() {
      await Promise.allSettled([
        pools.runtime.end(),
        pools.migrator.end(),
        pools.maintenance.end(),
      ]);
      await admin.query(`DROP SCHEMA IF EXISTS caplets CASCADE;`);
      await admin.query(`
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.runtime)} CASCADE;
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.migrator)} CASCADE;
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.maintenance)} CASCADE;
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.runtime)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.migrator)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.maintenance)};
      `);
      await admin.end();
    },
  };
}
