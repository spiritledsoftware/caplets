import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ControlPlaneAuthorizationDecision,
  type ControlPlaneAuthorizationRequest,
  type ControlPlaneAuthorizer,
} from "../src/control-plane/authorization";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import { createControlPlaneService } from "../src/control-plane/service";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type {
  ControlPlaneAuthorization,
  ControlPlaneStoreIdentity,
  ControlPlaneWriterFence,
  HostSettingManagementMutation,
} from "../src/control-plane/types";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type { ControlPlaneFailurePoint, ControlPlaneStore } from "../src/control-plane/store";

const NOW = "2026-07-14T00:00:00.000Z";
const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function environment(): MigrationEnvironment {
  return {
    binaryVersion: "0.34.1",
    supportedSchemaVersion: 1,
    keyVersion: 1,
    manifestVersion: 1,
    verifiedSchemaAwareBackup: true,
    oldNodesDrained: true,
    retainedKeyVersions: [1],
    hostAdministrator: true,
    now: new Date(NOW),
  };
}

class MutableAuthorizer implements ControlPlaneAuthorizer {
  readonly requests: ControlPlaneAuthorizationRequest[] = [];

  constructor(public decision: ControlPlaneAuthorizationDecision) {}

  async authorize(
    request: ControlPlaneAuthorizationRequest,
  ): Promise<ControlPlaneAuthorizationDecision> {
    this.requests.push(request);
    return this.decision;
  }
}

async function fixture(options: { migrate?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "caplets-store-contract-"));
  roots.push(root);
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    ...identity,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: join(root, "key-provider.json"),
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  const dialect = await openSqliteControlPlaneDialect({
    storage,
    environment: environment(),
    assetRoot: resolve(import.meta.dirname, "..", "drizzle"),
  });
  if (options.migrate !== false) dialect.migrate();
  let injectedPoint: ControlPlaneFailurePoint | undefined;
  const store = createControlPlaneRepository({
    identity,
    dialect,
    failureInjector: (point) => {
      if (point === injectedPoint) throw new Error(`injected:${point}`);
    },
  });
  if (options.migrate === false) return { dialect, store, storage };
  const versions = await store.initialize();
  const registration = await store.registerNode({
    nodeId: "node-1",
    bootstrapFingerprint: "a".repeat(64),
    effectiveRuntimeFingerprint: "a".repeat(64),
    compatibility: { binaryVersion: "0.34.1", schemaVersion: 3, keyVersion: 1, manifestVersion: 1 },
    appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
    ttlMs: 60_000,
  });
  if (registration.status !== "ready") throw new Error("test node was not ready");
  const acknowledgement = await store.acknowledgeNode({
    nodeId: "node-1",
    bootstrapFingerprint: "a".repeat(64),
    effectiveRuntimeFingerprint: "a".repeat(64),
    appliedToken: versions,
    writerFence: registration.writerFence,
  });
  if (acknowledgement.status !== "applied") throw new Error("test node was not acknowledged");
  return {
    dialect,
    store,
    storage,
    versions,
    fence: registration.writerFence,
    inject(point: ControlPlaneFailurePoint | undefined) {
      injectedPoint = point;
    },
  };
}

function binding(operationId: string, overrides: Partial<CurrentHostOperationBinding> = {}) {
  return {
    operationId,
    target: "global",
    ...identity,
    actorId: "operator-1",
    requestIdentity: `request:${operationId}`,
    operationClass: "logical-state",
    ...overrides,
  } satisfies CurrentHostOperationBinding;
}

function mutation(
  operationId: string,
  fence: ControlPlaneWriterFence,
  overrides: Partial<HostSettingManagementMutation> = {},
): HostSettingManagementMutation {
  return {
    binding: binding(operationId),
    aggregateId: "native.daemon-url",
    expectedAggregateVersion: 0,
    expectedAuthorityGeneration: fence.authorityGeneration,
    expectedSecurityEpoch: 0,
    writerFence: fence,
    setting: {
      version: 1,
      key: "native.daemon-url",
      value: { source: "setup", url: "http://127.0.0.1:3100/" },
      updatedAt: NOW,
    },
    provenance: {
      id: `provenance:${operationId}`,
      sourceKind: "setup",
      source: { command: "setup" },
      contentHash: "c".repeat(64),
      installedAt: NOW,
    },
    activity: {
      id: `activity:${operationId}`,
      action: "host-setting.update",
      target: { type: "host-setting", id: "native.daemon-url" },
    },
    ...overrides,
  };
}

function authorization(fence: ControlPlaneWriterFence, overrides = {}): ControlPlaneAuthorization {
  return {
    ...identity,
    actorId: "operator-1",
    role: "operator",
    securityEpoch: 0,
    writerFence: fence,
    ...overrides,
  };
}

async function reserve(store: ControlPlaneStore, input: HostSettingManagementMutation) {
  await expect(store.reserveOperation(input.binding, input.aggregateId)).resolves.toMatchObject({
    status: "reserved",
  });
}

describe("control-plane store public contract", () => {
  it("keeps operational ledgers generation-neutral and does not invalidate a management proposal", async () => {
    const test = await fixture();
    if (!("fence" in test)) throw new Error("fixture was not initialized");
    const proposal = mutation("operation-after-ledgers", test.fence);
    const before = await test.store.loadSnapshot();

    for (const kind of ["heartbeat", "session-expiry", "retention", "migration"] as const) {
      await test.store.recordOperationalLedger({ kind, id: `ledger:${kind}`, detail: { tick: 1 } });
    }

    expect((await test.store.loadSnapshot()).versions).toEqual(before.versions);
    await reserve(test.store, proposal);
    await expect(test.store.mutateHostSetting(proposal)).resolves.toMatchObject({
      status: "committed",
    });
  });

  it("replays the identical durable receipt after acknowledgement loss without duplicate state or activity", async () => {
    const test = await fixture();
    if (!("fence" in test)) throw new Error("fixture was not initialized");
    const input = mutation("operation-lost-ack", test.fence);
    await reserve(test.store, input);
    test.inject?.("after-receipt");

    await expect(test.store.mutateHostSetting(input)).resolves.toEqual({
      status: "indeterminate",
      binding: input.binding,
    });
    test.inject?.(undefined);
    const firstLookup = await test.store.lookupOrReserveNotCommitted(input.binding);
    expect(firstLookup).toMatchObject({ status: "committed" });
    if (firstLookup.status !== "committed") throw new Error("durable receipt was not found");

    await expect(test.store.mutateHostSetting(input)).resolves.toEqual({
      status: "committed",
      receipt: firstLookup.receipt,
    });
    await expect(test.store.lookupOrReserveNotCommitted(input.binding)).resolves.toEqual(
      firstLookup,
    );
    expect((await test.store.loadSnapshot()).hostSettings).toEqual([input.setting]);
    expect(
      test.dialect.query(
        "SELECT provenance_id AS provenanceId, provenance_source_kind AS sourceKind, provenance_content_hash AS contentHash FROM cp_host_setting WHERE id = ?",
        [input.aggregateId],
      ),
    ).toEqual([
      {
        provenanceId: input.provenance.id,
        sourceKind: input.provenance.sourceKind,
        contentHash: input.provenance.contentHash,
      },
    ]);
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_operator_activity WHERE activity_id = ?",
        [input.activity.id],
      )[0]!.count,
    ).toBe(1);

    await test.dialect.close();
    const reopenedDialect = await openSqliteControlPlaneDialect({
      storage: test.storage,
      environment: environment(),
      assetRoot: resolve(import.meta.dirname, "..", "drizzle"),
    });
    reopenedDialect.migrate();
    const reopened = createControlPlaneRepository({ identity, dialect: reopenedDialect });
    await expect(reopened.lookupOrReserveNotCommitted(input.binding)).resolves.toEqual(firstLookup);
    await reopenedDialect.close();
  });

  it("denies wrong host/store, stale security, revoked role, and unavailable authority without rows", async () => {
    const test = await fixture();
    if (!("fence" in test)) throw new Error("fixture was not initialized");
    const authorizer = new MutableAuthorizer({
      status: "authorized",
      authorization: authorization(test.fence),
    });
    const service = createControlPlaneService({ store: test.store, authorization: authorizer });

    const cases = [
      {
        input: mutation("operation-wrong-host", test.fence, {
          binding: binding("operation-wrong-host", { logicalHostId: "host-other" }),
        }),
        decision: authorizer.decision,
        expected: { status: "denied", reason: "wrong-host" },
      },
      {
        input: mutation("operation-wrong-store", test.fence, {
          binding: binding("operation-wrong-store", { storeId: "store-other" }),
        }),
        decision: authorizer.decision,
        expected: { status: "denied", reason: "wrong-store" },
      },
      {
        input: mutation("operation-stale-security", test.fence),
        decision: {
          status: "authorized",
          authorization: authorization(test.fence, { securityEpoch: 1 }),
        } satisfies ControlPlaneAuthorizationDecision,
        expected: { status: "denied", reason: "stale-security" },
      },
      {
        input: mutation("operation-stale-namespace", test.fence),
        decision: {
          status: "authorized",
          authorization: authorization(test.fence, {
            operationNamespace: "namespace-other",
          }),
        } satisfies ControlPlaneAuthorizationDecision,
        expected: { status: "denied", reason: "stale-authority" },
      },
      {
        input: mutation("operation-revoked", test.fence),
        decision: {
          status: "denied",
          reason: "revoked",
        } satisfies ControlPlaneAuthorizationDecision,
        expected: { status: "denied", reason: "revoked-role" },
      },
      {
        input: mutation("operation-unavailable", test.fence),
        decision: {
          status: "denied",
          reason: "unavailable",
        } satisfies ControlPlaneAuthorizationDecision,
        expected: { status: "unavailable" },
      },
    ] as const;

    for (const testCase of cases) {
      authorizer.decision = testCase.decision;
      await expect(service.mutateHostSetting(testCase.input)).resolves.toEqual(testCase.expected);
    }
    expect((await test.store.loadSnapshot()).hostSettings).toEqual([]);
    expect(authorizer.requests).toContainEqual({
      actorId: "operator-1",
      ...identity,
      requiredRole: "operator",
    });

    const lookupBinding = binding("operation-revoked-lookup");
    authorizer.decision = { status: "denied", reason: "revoked" };
    await expect(service.lookupOperation(lookupBinding)).resolves.toEqual({
      status: "unknown",
      binding: lookupBinding,
    });
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_operation_tombstone WHERE operation_id = ?",
        [lookupBinding.operationId],
      )[0]!.count,
    ).toBe(0);
  });

  it("returns unavailable instead of leaking driver failure when the authoritative store is not ready", async () => {
    const test = await fixture({ migrate: false });
    const unavailableFence: ControlPlaneWriterFence = {
      leaseId: "lease-unavailable",
      writerEpoch: 0,
      authorityGeneration: 0,
    };
    await expect(
      test.store.mutateHostSetting(mutation("operation-unavailable-store", unavailableFence)),
    ).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("does not disclose a host-bound receipt through another host or store binding", async () => {
    const test = await fixture();
    if (!("fence" in test)) throw new Error("fixture was not initialized");
    const input = mutation("operation-host-bound", test.fence);
    await reserve(test.store, input);
    const committed = await test.store.mutateHostSetting(input);
    expect(committed).toMatchObject({ status: "committed" });

    await expect(
      test.store.lookupOrReserveNotCommitted({
        ...input.binding,
        logicalHostId: "host-other",
      }),
    ).resolves.toEqual({
      status: "wrong_target",
      binding: { ...input.binding, logicalHostId: "host-other" },
    });
    await expect(
      test.store.lookupOrReserveNotCommitted({ ...input.binding, storeId: "store-other" }),
    ).resolves.toEqual({
      status: "wrong_target",
      binding: { ...input.binding, storeId: "store-other" },
    });
    await expect(
      test.store.lookupOrReserveNotCommitted({ ...input.binding, actorId: "operator-other" }),
    ).resolves.toEqual({
      status: "wrong_target",
      binding: { ...input.binding, actorId: "operator-other" },
    });
    await expect(
      test.store.lookupOrReserveNotCommitted({
        ...input.binding,
        requestIdentity: "request-other",
      }),
    ).resolves.toEqual({
      status: "wrong_target",
      binding: { ...input.binding, requestIdentity: "request-other" },
    });
  });
});
