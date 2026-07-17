import type { CapletsConfig, ConfigWithSources } from "../../src/config";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "../../src/control-plane/snapshot";
import type { ControlPlaneStore } from "../../src/control-plane/store";
import type {
  ControlPlaneConvergenceToken,
  ControlPlaneHealthSummary,
  ControlPlaneNodeApplication,
  ControlPlaneNodeRegistration,
  ControlPlaneStoreIdentity,
} from "../../src/control-plane/types";

export const ACTIVATION_IDENTITY: ControlPlaneStoreIdentity = Object.freeze({
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "operations_01J00000000000000000000000",
});

export const ACTIVATION_FINGERPRINT = "a".repeat(64);

const EMPTY_CONFIG: CapletsConfig = Object.freeze({
  version: 1,
  options: Object.freeze({
    defaultSearchLimit: 10,
    maxSearchLimit: 100,
    exposure: "progressive",
    exposureDiscoveryTimeoutMs: 1_000,
    exposureDiscoveryConcurrency: 4,
    completion: Object.freeze({
      discoveryTimeoutMs: 1_000,
      overallTimeoutMs: 2_000,
      cacheTtlMs: 60_000,
      negativeCacheTtlMs: 5_000,
    }),
  }),
  namespaceAliases: Object.freeze({ upstreams: Object.freeze({}) }),
  mcpServers: Object.freeze({}),
  openapiEndpoints: Object.freeze({}),
  googleDiscoveryApis: Object.freeze({}),
  graphqlEndpoints: Object.freeze({}),
  httpApis: Object.freeze({}),
  cliTools: Object.freeze({}),
  capletSets: Object.freeze({}),
});

const EMPTY_CONFIG_WITH_SOURCES: ConfigWithSources = Object.freeze({
  config: EMPTY_CONFIG,
  sources: Object.freeze({}),
  shadows: Object.freeze({}),
});

export function activationSnapshot(
  token: ControlPlaneConvergenceToken,
  marker = "initial",
): ControlPlaneRuntimeSnapshot {
  return Object.freeze({
    config: EMPTY_CONFIG,
    configWithSources: EMPTY_CONFIG_WITH_SOURCES,
    sqlSnapshot: Object.freeze({
      identity: ACTIVATION_IDENTITY,
      versions: Object.freeze({ ...token }),
      caplets: Object.freeze([]),
      hostSettings: Object.freeze([]),
      encodedBytes: 0,
      normalizedRows: 0,
    }),
    backend: "postgres",
    identity: ACTIVATION_IDENTITY,
    authorityGeneration: token.authorityGeneration,
    effectiveGeneration: token.effectiveGeneration,
    securityEpoch: token.securityEpoch,
    bootstrapFingerprint: ACTIVATION_FINGERPRINT,
    effectiveRuntimeFingerprint: `${ACTIVATION_FINGERPRINT.slice(0, 56)}${marker.padStart(8, "0").slice(-8)}`,
    caplets: Object.freeze({}),
    hostSettings: Object.freeze({}),
  });
}

export function createActivationFixture() {
  let token: ControlPlaneConvergenceToken = Object.freeze({
    authorityGeneration: 0,
    effectiveGeneration: 0,
    securityEpoch: 0,
  });
  let currentFingerprint = ACTIVATION_FINGERPRINT;
  let nextFingerprint: string | undefined;
  let current = activationSnapshot(token);
  const firstReload = Promise.withResolvers<void>();
  let nextSnapshot = current;
  let connectivityFailure = false;
  let notificationListener: ((token: ControlPlaneConvergenceToken | undefined) => void) | undefined;
  let fenceEpoch = 0;
  let reloadCount = 0;
  let commitCount = 0;
  let reloadGate: Promise<void> | undefined;
  let stageCount = 0;
  let revokeGate: Promise<void> | undefined;

  const healthy = (): ControlPlaneHealthSummary =>
    Object.freeze({
      backend: "postgres",
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      authorityToken: Object.freeze({
        authorityGeneration: token.authorityGeneration,
        effectiveGeneration: token.effectiveGeneration,
      }),
      bootstrapCompatibility: "current",
      convergence: "within-budget",
      guidanceCode: "ok",
    });

  const store: ControlPlaneStore = {
    identity: ACTIVATION_IDENTITY,
    backend: "postgres",
    async initialize() {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return { ...token };
    },
    async reserveOperation() {
      throw new Error("not used by activation fixture");
    },
    async lookupOrReserveNotCommitted() {
      throw new Error("not used by activation fixture");
    },
    async mutateCaplet() {
      throw new Error("not used by activation fixture");
    },
    async mutateHostSetting() {
      throw new Error("not used by activation fixture");
    },
    async loadSnapshot() {
      throw new Error("not used by activation fixture");
    },
    async createConfirmationPreview() {
      throw new Error("not used by activation fixture");
    },
    async consumeConfirmation() {
      throw new Error("not used by activation fixture");
    },
    async confirmExternalDestruction() {
      throw new Error("not used by activation fixture");
    },
    async resumeExternalDestruction() {
      throw new Error("not used by activation fixture");
    },
    async recordOperationalLedger() {},
    async activationState() {
      return {
        generation: token.authorityGeneration,
        currentFingerprint,
        ...(nextFingerprint ? { nextFingerprint } : {}),
      };
    },
    async initializeActivationFingerprint() {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return {
        generation: token.authorityGeneration,
        currentFingerprint,
        ...(nextFingerprint ? { nextFingerprint } : {}),
      };
    },
    async stageNextFingerprint(fingerprint: string) {
      stageCount += 1;
      if (connectivityFailure) throw new Error("postgres unavailable");
      nextFingerprint = fingerprint === currentFingerprint ? undefined : fingerprint;
      return {
        generation: token.authorityGeneration,
        currentFingerprint,
        ...(nextFingerprint ? { nextFingerprint } : {}),
      };
    },
    async abortNextFingerprint(fingerprint: string) {
      if (nextFingerprint === fingerprint) nextFingerprint = undefined;
      return { generation: token.authorityGeneration, currentFingerprint };
    },
    async activateNextFingerprint(fingerprint: string) {
      currentFingerprint = fingerprint;
      nextFingerprint = undefined;
      return { generation: token.authorityGeneration + 1, currentFingerprint };
    },
    async convergenceToken() {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return token;
    },
    async registerNode(input: ControlPlaneNodeRegistration) {
      if (connectivityFailure) throw new Error("postgres unavailable");
      if (input.bootstrapFingerprint === nextFingerprint) {
        return { status: "activation-pending", readyNodes: 0 } as const;
      }
      if (
        input.bootstrapFingerprint !== currentFingerprint ||
        input.appliedToken.authorityGeneration !== token.authorityGeneration ||
        input.appliedToken.effectiveGeneration !== token.effectiveGeneration ||
        input.appliedToken.securityEpoch !== token.securityEpoch
      ) {
        return { status: "catching-up", readyNodes: 0 } as const;
      }
      fenceEpoch += 1;
      return {
        status: "ready",
        readyNodes: 1,
        writerFence: {
          leaseId: `writer:${input.nodeId}`,
          writerEpoch: fenceEpoch,
          authorityGeneration: token.authorityGeneration,
        },
      } as const;
    },
    async acknowledgeNode(input: ControlPlaneNodeApplication) {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return input.appliedToken.authorityGeneration === token.authorityGeneration &&
        input.appliedToken.effectiveGeneration === token.effectiveGeneration &&
        input.appliedToken.securityEpoch === token.securityEpoch
        ? ({ status: "applied", appliedNodes: 1 } as const)
        : ({ status: "rejected", reason: "token-regression" } as const);
    },
    async revokeNode() {
      await revokeGate;
    },
    async sweepOverdueNodes() {
      return 0;
    },
    async subscribeToChanges(listener: (value: ControlPlaneConvergenceToken | undefined) => void) {
      notificationListener = listener;
      return async () => {
        notificationListener = undefined;
      };
    },
    async health() {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return healthy();
    },
    async detailedDiagnostics() {
      if (connectivityFailure) throw new Error("postgres unavailable");
      return {
        backend: "postgres",
        store: ACTIVATION_IDENTITY,
        fingerprint: {
          generation: token.authorityGeneration,
          currentFingerprint,
        },
        keyCompatibility: {
          status: "compatible",
          activeVersion: 1,
          providerCommitmentPresent: true,
          canaryCommitmentPresent: true,
        },
        readyNodes: 1,
        overdueNodes: 0,
      } as const;
    },
  };

  const loader: ControlPlaneRuntimeSnapshotLoader = Object.freeze({
    async initialize() {
      return current;
    },
    async reload() {
      reloadCount += 1;
      if (reloadCount === 1) firstReload.resolve();
      const candidate = nextSnapshot;
      await reloadGate;
      return candidate;
    },
    commit(snapshot) {
      if (
        snapshot.authorityGeneration < current.authorityGeneration ||
        (snapshot.authorityGeneration === current.authorityGeneration &&
          snapshot.effectiveGeneration < current.effectiveGeneration)
      ) {
        return false;
      }
      current = snapshot;
      commitCount += 1;
      return true;
    },
    current() {
      return current;
    },
  });

  return {
    store,
    loader,
    node: {
      nodeId: "node-1",
      bootstrapFingerprint: ACTIVATION_FINGERPRINT,
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 3,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    } as const,
    setToken(next: ControlPlaneConvergenceToken, marker = "changed") {
      token = Object.freeze({ ...next });
      nextSnapshot = activationSnapshot(token, marker);
    },
    setConnectivityFailure(value: boolean) {
      connectivityFailure = value;
    },
    setCurrentFingerprint(value: string) {
      currentFingerprint = value;
    },
    notify(value?: ControlPlaneConvergenceToken) {
      notificationListener?.(value);
    },
    setReloadGate(value: Promise<void> | undefined) {
      reloadGate = value;
    },
    setRevokeGate(value: Promise<void> | undefined) {
      revokeGate = value;
    },
    waitForFirstReload() {
      return firstReload.promise;
    },
    stats() {
      return { reloadCount, commitCount } as const;
    },
    stageCount() {
      return stageCount;
    },
    healthy,
  };
}
