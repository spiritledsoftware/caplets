import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCurrentHostOperations,
  trustedDevelopmentOperatorPrincipal,
  withCurrentHostFinalAuthorization,
  type CurrentHostManagementStorage,
  type CurrentHostOperationBinding,
  type CurrentHostOperationReceipt,
  type CurrentHostOperatorPrincipal,
} from "../src/current-host/operations";
import { createCurrentHostManagementClient } from "../src/current-host/client-operations";
import { resolveControlPlaneCapletMutationTarget } from "../src/control-plane/snapshot";
import { DashboardActivityLog } from "../src/dashboard/activity-log";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("U9 Current Host SQL management", () => {
  it("authorizes, reserves, and rejects a filesystem-owned effective target before mutation", async () => {
    const events: string[] = [];
    const binding: CurrentHostOperationBinding = {
      operationId: "operation-u9-proof",
      target: "global",
      logicalHostId: "host-u9",
      storeId: "store-u9",
      operationNamespace: "namespace-u9",
      actorId: "development_unauthenticated",
      requestIdentity: "request-u9",
      operationClass: "logical-state",
    };
    const identity = {
      logicalHostId: binding.logicalHostId,
      storeId: binding.storeId,
      operationNamespace: binding.operationNamespace,
    };
    const storage: CurrentHostManagementStorage = {
      identity,
      async reserveOperation() {
        events.push("reserve");
        return { status: "reserved", binding } as const;
      },
      async loadSnapshot() {
        events.push("source-read");
        return {
          status: "ok",
          snapshot: {
            identity,
            versions: { authorityGeneration: 1, effectiveGeneration: 4, securityEpoch: 2 },
            caplets: [],
            hostSettings: [],
            encodedBytes: 0,
            normalizedRows: 0,
          },
        };
      },
      async mutateCaplet() {
        throw new Error("unexpected mutation");
      },
      async mutateHostSetting() {
        throw new Error("unexpected mutation");
      },
      async lookupOperation(candidate) {
        return { status: "unknown", binding: candidate };
      },
      async status(candidate) {
        return { status: "unavailable", binding: candidate };
      },
    };
    const operations = createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      activityLog: new DashboardActivityLog({ dir: "/tmp/caplets-u9-proof" }),
      version: "test",
      management: {
        storage,
        async loadRuntimeSnapshot() {
          events.push("target-query");
          return {
            identity,
            authorityGeneration: 1,
            effectiveGeneration: 4,
            securityEpoch: 2,
            caplets: {},
            hostSettings: {
              telemetry: {
                key: "telemetry",
                owner: "filesystem",
                source: { kind: "global-config", path: "/redacted" },
                effective: true,
                shadowChain: [
                  { owner: "sql", source: { kind: "sql", path: "sql://control-plane" } },
                  {
                    owner: "filesystem",
                    source: { kind: "global-config", path: "/redacted" },
                  },
                ],
                underlyingSql: {
                  owner: "sql",
                  source: { kind: "sql", path: "sql://control-plane" },
                },
              },
            },
          } as never;
        },
      },
    });

    const principal = withCurrentHostFinalAuthorization(
      trustedDevelopmentOperatorPrincipal("http://127.0.0.1:3100"),
      () => {
        events.push("authorize");
      },
    );
    const result = await operations.preview(principal, {
      binding,
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "effective",
      },
    });

    expect(result).toMatchObject({
      status: "rejected",
      reason: "filesystem-owned",
      target: { owner: "filesystem", source: { kind: "global-config" } },
    });
    expect(events).toEqual(["authorize", "reserve", "source-read", "target-query"]);
  });

  it("rejects Access principals before reservation, source reads, or target queries", async () => {
    const harness = sqlHostSettingHarness();
    const accessPrincipal = {
      clientId: "rcli_access",
      clientLabel: "Read only",
      hostUrl: "http://127.0.0.1:3100",
      role: "access",
    } as const;

    await expect(
      harness.operations.list(accessPrincipal, {
        binding: { ...harness.binding, actorId: accessPrincipal.clientId },
        resource: "host-setting",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(harness.events).toEqual([]);
  });

  it("rejects a forged local Operator before observing management state", async () => {
    const harness = sqlHostSettingHarness();
    const forgedLocalPrincipal = {
      clientId: "development_unauthenticated",
      hostUrl: "http://127.0.0.1:3100",
      role: "operator",
    } as const;

    await expect(
      harness.operations.status(forgedLocalPrincipal, harness.binding),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(harness.events).toEqual([]);
  });

  it("mutates an explicitly selected dormant SQL setting, keeps the safe receipt after local apply fails, and writes no global files", async () => {
    const globalRoot = tempDir("caplets-u9-global-root-");
    const harness = sqlHostSettingHarness({
      globalRoot,
      applyCommitted() {
        throw new Error("apply failed with cap_remote_access_sensitive");
      },
    });

    const result = await harness.operations.mutate(harness.principal, {
      binding: harness.binding,
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "underlying-sql",
      },
    });

    expect(result).toMatchObject({
      status: "committed",
      receipt: {
        localApplication: "pending",
        management: {
          owner: "sql",
          selector: "underlying-sql",
          effectiveChanged: false,
          consequence: "no-effective-change-while-shadowed",
        },
      },
      localApplicationError: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(result)).not.toContain("cap_remote_access_sensitive");
    expect(readdirSync(globalRoot)).toEqual([]);
  });

  it("makes operation lookup consume the caller-known identity before a paused dispatch can reserve it", async () => {
    const harness = sqlHostSettingHarness({ lookupConsumesOperation: true });
    const client = createCurrentHostManagementClient({
      operations: harness.operations,
      principal: harness.principal,
      target: "global",
      identity: harness.identity,
    });

    await expect(client.lookupOperation(harness.binding)).resolves.toMatchObject({
      status: "not_committed",
      binding: harness.binding,
    });
    await expect(
      client.mutate(
        {
          kind: "host-setting-set",
          key: "telemetry",
          value: false,
          selector: "underlying-sql",
        },
        harness.binding,
      ),
    ).resolves.toMatchObject({
      status: "conflict",
      reason: "operation-reservation",
    });
    expect(harness.events).not.toContain("mutate");
  });

  it("serializes dashboard and CLI mutations so exactly one expected-version writer commits", async () => {
    const harness = sqlHostSettingHarness({ serializeMutations: true });
    const dashboardBinding = harness.binding;
    const cliBinding = {
      ...harness.binding,
      operationId: "operation-u9-cli",
      requestIdentity: "request-u9-cli",
    };
    const mutation = {
      kind: "host-setting-set",
      key: "telemetry",
      value: false,
      selector: "underlying-sql",
      expectedAggregateVersion: 1,
    } as const;

    const results = await Promise.all([
      harness.operations.mutate(harness.principal, { binding: dashboardBinding, mutation }),
      harness.operations.mutate(harness.principal, { binding: cliBinding, mutation }),
    ]);

    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toEqual([
      expect.objectContaining({ reason: "aggregate-version" }),
    ]);
  });

  it("requires a new preview when ownership composition changes before mutation", async () => {
    const harness = sqlHostSettingHarness();
    const preview = await harness.operations.preview(harness.principal, {
      binding: harness.binding,
      mutation: {
        kind: "host-setting-set",
        key: "telemetry",
        value: false,
        selector: "underlying-sql",
      },
    });
    expect(preview.status).toBe("preview");
    if (preview.status !== "preview") throw new Error("Expected a management preview.");
    harness.advanceEffectiveGeneration();

    await expect(
      harness.operations.mutate(harness.principal, {
        binding: harness.binding,
        mutation: {
          kind: "host-setting-set",
          key: "telemetry",
          value: false,
          selector: "underlying-sql",
          expectedAuthorityToken: preview.authorityToken,
        },
      }),
    ).resolves.toMatchObject({
      status: "conflict",
      reason: "effective-generation",
    });
    expect(harness.events).not.toContain("mutate");
  });

  it("treats activating a visible dormant SQL Caplet as an effective runtime change", () => {
    const resolution = resolveControlPlaneCapletMutationTarget(
      {
        caplets: {
          dormant: {
            id: "dormant",
            owner: "sql",
            source: { kind: "sql", path: "sql://control-plane" },
            effective: false,
            runtimeStatus: "dormant",
            shadowChain: [{ owner: "sql", source: { kind: "sql", path: "sql://control-plane" } }],
          },
        },
      } as never,
      "dormant",
      { underlyingSql: true },
    );

    expect(resolution).toMatchObject({
      status: "allowed",
      owner: "sql",
      effectiveChanged: true,
    });
  });
});

function sqlHostSettingHarness(
  options: {
    applyCommitted?: (() => void) | undefined;
    lookupConsumesOperation?: boolean | undefined;
    serializeMutations?: boolean | undefined;
    globalRoot?: string | undefined;
  } = {},
) {
  const events: string[] = [];
  const binding: CurrentHostOperationBinding = {
    operationId: "operation-u9-management",
    target: "global",
    logicalHostId: "host-u9",
    storeId: "store-u9",
    operationNamespace: "namespace-u9",
    actorId: "development_unauthenticated",
    requestIdentity: "request-u9-management",
    operationClass: "logical-state",
  };
  const identity = {
    logicalHostId: binding.logicalHostId,
    storeId: binding.storeId,
    operationNamespace: binding.operationNamespace,
  };
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
  const snapshot = {
    identity,
    versions: { authorityGeneration: 1, effectiveGeneration: 4, securityEpoch: 2 },
    caplets: [],
    hostSettings: [
      { version: 1, key: "telemetry", value: true, updatedAt: "2026-07-15T00:00:00.000Z" },
    ],
    hostSettingVersions: { telemetry: 1 },
    encodedBytes: 0,
    normalizedRows: 1,
  } as const;
  let runtimeEffectiveGeneration = 4;
  const consumed = new Set<string>();
  const reservations = new Set<string>();
  let aggregateVersion = 1;
  let mutationQueue = Promise.resolve();
  const storage: CurrentHostManagementStorage = {
    identity,
    async reserveOperation(candidate) {
      events.push("reserve");
      if (consumed.has(candidate.operationId)) {
        return { status: "conflict", reason: "operation-consumed" };
      }
      reservations.add(candidate.operationId);
      return { status: "reserved", binding: candidate };
    },
    async loadSnapshot(candidate) {
      events.push("source-read");
      return { status: "ok", snapshot, binding: candidate };
    },
    async mutateCaplet() {
      throw new Error("unexpected Caplet mutation");
    },
    async mutateHostSetting(input) {
      const execute = async () => {
        events.push("mutate");
        if (options.serializeMutations && input.expectedAggregateVersion !== aggregateVersion) {
          return { status: "conflict", reason: "aggregate-version" } as const;
        }
        aggregateVersion += 1;
        return {
          status: "committed",
          receipt: receiptFor(input.binding, target, aggregateVersion),
        } as const;
      };
      if (!options.serializeMutations) return execute();
      const result = mutationQueue.then(execute);
      mutationQueue = result.then(() => undefined);
      return result;
    },
    async lookupOperation(candidate) {
      events.push("lookup");
      if (options.lookupConsumesOperation) {
        consumed.add(candidate.operationId);
        return {
          status: "not_committed",
          binding: candidate,
          retryReservationId: `retry_${candidate.operationId}`,
        };
      }
      return { status: "unknown", binding: candidate };
    },
    async status(candidate) {
      return { status: "unavailable", binding: candidate };
    },
  };
  const principal: CurrentHostOperatorPrincipal =
    trustedDevelopmentOperatorPrincipal("http://127.0.0.1:3100");
  const operations = createCurrentHostOperations({
    engine: { enabledServers: () => [] },
    ...(options.globalRoot
      ? {
          control: {
            globalCapletsRoot: join(options.globalRoot, "caplets"),
            globalLockfilePath: join(options.globalRoot, "caplets.lock.json"),
          },
        }
      : {}),
    activityLog: new DashboardActivityLog({ dir: tempDir("caplets-u9-activity-") }),
    version: "test",
    management: {
      storage,
      applyCommitted: options.applyCommitted,
      async loadRuntimeSnapshot() {
        events.push("target-query");
        return {
          identity,
          authorityGeneration: 1,
          effectiveGeneration: runtimeEffectiveGeneration,
          securityEpoch: 2,
          caplets: {},
          hostSettings: {
            telemetry: {
              key: "telemetry",
              owner: "filesystem",
              source: { kind: "global-config", path: "/not-returned/global-config.json" },
              effective: true,
              shadowChain: [
                { owner: "sql", source: { kind: "sql", path: "sql://not-returned" } },
                {
                  owner: "filesystem",
                  source: { kind: "global-config", path: "/not-returned/global-config.json" },
                },
              ],
              underlyingSql: {
                owner: "sql",
                source: { kind: "sql", path: "sql://not-returned" },
              },
            },
          },
        } as never;
      },
    },
  });
  return {
    binding,
    events,
    identity,
    operations,
    principal,
    reservations,
    advanceEffectiveGeneration() {
      runtimeEffectiveGeneration += 1;
    },
  };
}

function receiptFor(
  binding: CurrentHostOperationBinding,
  management: CurrentHostOperationReceipt["management"],
  aggregateVersion: number,
): CurrentHostOperationReceipt {
  return {
    status: "committed",
    binding,
    aggregateVersion,
    authorityToken: { authorityGeneration: 1, effectiveGeneration: 4 },
    localApplication: "pending",
    convergence: { kind: "single-node" },
    management,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
