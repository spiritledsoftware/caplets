import type {
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
} from "../current-host/operations";
import { CapletsError } from "../errors";
import {
  validateControlPlaneAuthorization,
  type ControlPlaneAuthorizer,
  type ControlPlaneAuthorizationDecision,
} from "./authorization";
import {
  createControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistenceOptions,
} from "./migration/persistence";
import { assertDetailedControlPlaneDiagnostics, assertRedactedControlPlaneHealth } from "./health";
import type { FileV1KeyProvider } from "./key-provider/file-v1";
import { FILE_V1_RUNTIME_PURPOSES, type FileV1Purpose } from "./key-provider/manifest";
import type {
  ControlPlaneKeyRotationManager,
  KeyInventoryStatus,
  KeyRetirementPreview,
  KeyRetirementResult,
} from "./security/key-rotation";
import type { ControlPlaneSecurityRepository } from "./security/repository";
import {
  type ControlPlaneRuntimeSnapshot,
  type ControlPlaneRuntimeSnapshotLoader,
  type ControlPlaneRuntimeSnapshotLoadContext,
} from "./snapshot";
import { STORAGE_BENCHMARK_ENVELOPE } from "./storage-benchmark-envelope";
import type { ControlPlaneSqlTransaction, ControlPlaneStore } from "./store";
import type {
  CapletManagementMutation,
  ControlPlaneConvergenceToken,
  ControlPlaneDetailedDiagnostics,
  ControlPlaneHealthSummary,
  ControlPlaneActivationState,
  ControlPlaneMaintenanceFence,
  ControlPlaneNodeRegistration,
  ControlPlaneWriterFence,
  ControlPlaneNodeRegistrationResult,
  ControlPlaneMutationResult,
  ControlPlaneOperationReservationResult,
  ControlPlaneSnapshot,
  HostSettingManagementMutation,
  UntrustedCapletManagementMutation,
  UntrustedHostSettingManagementMutation,
} from "./types";

export type ControlPlaneManagementAuthorizationFailure =
  | Readonly<{
      status: "denied";
      binding: CurrentHostOperationBinding;
      reason: "wrong-host" | "wrong-store" | "stale-authority" | "stale-security" | "revoked-role";
    }>
  | Readonly<{ status: "unavailable"; binding: CurrentHostOperationBinding }>;

export type ControlPlaneService = Readonly<{
  readonly identity: ControlPlaneStore["identity"];
  reserveOperation(
    binding: CurrentHostOperationBinding,
    aggregateId: string,
  ): Promise<ControlPlaneOperationReservationResult | ControlPlaneManagementAuthorizationFailure>;
  loadSnapshot(
    binding: CurrentHostOperationBinding,
  ): Promise<
    | Readonly<{ status: "ok"; snapshot: ControlPlaneSnapshot }>
    | ControlPlaneManagementAuthorizationFailure
  >;
  status(
    binding: CurrentHostOperationBinding,
  ): Promise<
    | Readonly<{ status: "ok"; health: ControlPlaneHealthSummary }>
    | ControlPlaneManagementAuthorizationFailure
  >;
  mutateCaplet(input: UntrustedCapletManagementMutation): Promise<ControlPlaneMutationResult>;
  mutateHostSetting(
    input: UntrustedHostSettingManagementMutation,
  ): Promise<ControlPlaneMutationResult>;
  lookupOperation(binding: CurrentHostOperationBinding): Promise<CurrentHostOperationLookupOutcome>;
}>;

export function createControlPlaneService(options: {
  store: ControlPlaneStore;
  authorization: ControlPlaneAuthorizer;
}): ControlPlaneService {
  const authorize = async (
    binding: CurrentHostOperationBinding,
    transaction?: ControlPlaneSqlTransaction,
  ): Promise<ControlPlaneAuthorizationDecision> => {
    const request = {
      actorId: binding.actorId,
      logicalHostId: binding.logicalHostId,
      storeId: binding.storeId,
      operationNamespace: binding.operationNamespace,
      requiredRole: "operator" as const,
    };
    const decision =
      transaction && options.authorization.authorizeInTransaction
        ? await options.authorization.authorizeInTransaction(transaction, request)
        : await options.authorization.authorize(request);
    return validateControlPlaneAuthorization(request, decision);
  };

  async function prepare(
    input: UntrustedCapletManagementMutation,
  ): Promise<ControlPlaneMutationResult | CapletManagementMutation>;
  async function prepare(
    input: UntrustedHostSettingManagementMutation,
  ): Promise<ControlPlaneMutationResult | HostSettingManagementMutation>;
  async function prepare(
    input: UntrustedCapletManagementMutation | UntrustedHostSettingManagementMutation,
  ): Promise<
    ControlPlaneMutationResult | CapletManagementMutation | HostSettingManagementMutation
  > {
    if (input.binding.logicalHostId !== options.store.identity.logicalHostId) {
      return { status: "denied", reason: "wrong-host" };
    }
    if (input.binding.storeId !== options.store.identity.storeId) {
      return { status: "denied", reason: "wrong-store" };
    }
    const decision = await authorize(input.binding);
    if (decision.status === "denied") {
      if (decision.reason === "unavailable") return { status: "unavailable" };
      if (decision.reason === "namespace-mismatch") {
        return { status: "denied", reason: "stale-authority" };
      }
      return {
        status: "denied",
        reason:
          decision.reason === "revoked" || decision.reason === "role-insufficient"
            ? "revoked-role"
            : "wrong-store",
      };
    }
    if (decision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
      return { status: "denied", reason: "stale-security" };
    }
    const trustedInput = {
      ...input,
      expectedSecurityEpoch: decision.authorization.securityEpoch,
      writerFence: decision.authorization.writerFence,
      finalAuthorization: async (transaction: ControlPlaneSqlTransaction) => {
        const finalDecision = await authorize(input.binding, transaction);
        if (finalDecision.status === "denied") {
          if (finalDecision.reason === "unavailable") return { status: "unavailable" } as const;
          if (finalDecision.reason === "namespace-mismatch") {
            return { status: "denied", reason: "stale-authority" } as const;
          }
          return {
            status: "denied",
            reason:
              finalDecision.reason === "revoked" || finalDecision.reason === "role-insufficient"
                ? "revoked-role"
                : "wrong-store",
          } as const;
        }
        if (finalDecision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
          return { status: "denied", reason: "stale-security" } as const;
        }
        return {
          status: "authorized",
          securityEpoch: finalDecision.authorization.securityEpoch,
          writerFence: finalDecision.authorization.writerFence,
        } as const;
      },
    };
    const reservation = await options.store.reserveOperation(input.binding, input.aggregateId);
    if (reservation.status === "unavailable") return { status: "unavailable" };
    if (reservation.status === "conflict") {
      return { status: "conflict", reason: "operation-reservation" };
    }
    if (reservation.status === "committed") {
      return { status: "committed", receipt: reservation.receipt };
    }
    return trustedInput;
  }

  const authorizeManagementBinding = async (
    binding: CurrentHostOperationBinding,
  ): Promise<ControlPlaneManagementAuthorizationFailure | undefined> => {
    if (binding.logicalHostId !== options.store.identity.logicalHostId) {
      return { status: "denied", binding, reason: "wrong-host" };
    }
    if (binding.storeId !== options.store.identity.storeId) {
      return { status: "denied", binding, reason: "wrong-store" };
    }
    const decision = await authorize(binding);
    if (decision.status === "authorized") return undefined;
    if (decision.reason === "unavailable") return { status: "unavailable", binding };
    if (decision.reason === "namespace-mismatch") {
      return { status: "denied", binding, reason: "stale-authority" };
    }
    return {
      status: "denied",
      binding,
      reason:
        decision.reason === "revoked" || decision.reason === "role-insufficient"
          ? "revoked-role"
          : "wrong-store",
    };
  };

  return {
    identity: options.store.identity,
    async reserveOperation(binding, aggregateId) {
      const denied = await authorizeManagementBinding(binding);
      if (denied) return denied;
      return options.store.reserveOperation(binding, aggregateId);
    },
    async loadSnapshot(binding) {
      const denied = await authorizeManagementBinding(binding);
      if (denied) return denied;
      try {
        return { status: "ok", snapshot: await options.store.loadSnapshot() };
      } catch {
        return { status: "unavailable", binding };
      }
    },
    async status(binding) {
      const denied = await authorizeManagementBinding(binding);
      if (denied) return denied;
      try {
        return { status: "ok", health: await options.store.health() };
      } catch {
        return { status: "unavailable", binding };
      }
    },
    async lookupOperation(binding) {
      if (
        binding.logicalHostId !== options.store.identity.logicalHostId ||
        binding.storeId !== options.store.identity.storeId
      ) {
        return { status: "wrong_target", binding };
      }
      const decision = await authorize(binding);
      if (decision.status === "denied") {
        if (decision.reason === "unavailable") return { status: "unavailable", binding };
        if (decision.reason === "namespace-mismatch") {
          return { status: "stale_namespace", binding };
        }
        return { status: "unknown", binding };
      }
      return options.store.lookupOrReserveNotCommitted(binding);
    },
    async mutateCaplet(input) {
      const prepared = await prepare(input);
      return "aggregate" in prepared ? options.store.mutateCaplet(prepared) : prepared;
    },
    async mutateHostSetting(input) {
      const prepared = await prepare(input);
      return "setting" in prepared ? options.store.mutateHostSetting(prepared) : prepared;
    },
  };
}

export type ControlPlaneRuntimeKeyPurpose = (typeof FILE_V1_RUNTIME_PURPOSES)[number];

/**
 * Internal host-maintenance capability. It is wired only by the production SQL runtime and never
 * projected through agent, HTTP, dashboard, or remote-control surfaces.
 */
export type ControlPlaneMaintenanceCoordinator = Readonly<{
  rollCompatibleFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  stageNextFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  abortNextFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  activateNextFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  reverseFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  stageKeyVersion(purpose: ControlPlaneRuntimeKeyPurpose): Promise<KeyInventoryStatus>;
  verifyKeyCanary(
    purpose: ControlPlaneRuntimeKeyPurpose,
    keyVersion: number,
  ): Promise<Readonly<{ verified: boolean; readiness: "canary-verified" | "denied" }>>;
  activateKeyVersion(
    purpose: ControlPlaneRuntimeKeyPurpose,
    keyVersion: number,
  ): Promise<KeyInventoryStatus>;
  reencryptVaultValues(): Promise<number>;
  rescanKeyRetirement(
    input: Readonly<{
      purpose: FileV1Purpose;
      keyVersion: number;
      authorityToken: string;
      minimumPurgeWatermark: number;
    }>,
  ): Promise<KeyRetirementPreview>;
  retireKeyVersion(
    input: Readonly<{
      preview: KeyRetirementPreview;
      authorityToken: string;
    }>,
  ): Promise<KeyRetirementResult>;
  listKeyInventory(): Promise<readonly KeyInventoryStatus[]>;
}>;

export function createControlPlaneMaintenanceCoordinator(
  options: Readonly<{
    store: ControlPlaneStore;
    activated: ActivatedControlPlane;
    keyRotation: ControlPlaneKeyRotationManager;
    security: ControlPlaneSecurityRepository;
    nodeId: string;
    loadKeyProvider(): Promise<FileV1KeyProvider>;
    rememberKeyProvider(provider: FileV1KeyProvider): void | Promise<void>;
    activateKeyProvider(provider: FileV1KeyProvider): void | Promise<void>;
  }>,
): ControlPlaneMaintenanceCoordinator {
  const liveFence = async (): Promise<ControlPlaneMaintenanceFence> => {
    const writerFence = await options.activated.requireLive("admin");
    const current = options.activated.current();
    if (writerFence.authorityGeneration !== current.authorityGeneration) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Production maintenance authority changed.");
    }
    return { securityEpoch: current.securityEpoch, writerFence };
  };
  const requireFingerprint = (fingerprint: string): string => {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new CapletsError("REQUEST_INVALID", "Runtime fingerprint is invalid.");
    }
    return fingerprint;
  };
  const loadAndRegisterProvider = async (
    purpose: ControlPlaneRuntimeKeyPurpose,
    fence: ControlPlaneMaintenanceFence,
  ): Promise<Readonly<{ provider: FileV1KeyProvider; inventory: KeyInventoryStatus }>> => {
    const provider = await options.loadKeyProvider();
    const inventory = await options.keyRotation.registerActiveVersion({
      provider,
      purpose,
      ...fence,
    });
    await options.rememberKeyProvider(provider);
    return { provider, inventory };
  };

  return Object.freeze({
    async rollCompatibleFingerprint(fingerprint) {
      const expected = requireFingerprint(fingerprint);
      await liveFence();
      const current = await options.store.activationState();
      if (current.currentFingerprint !== expected || current.nextFingerprint !== undefined) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Compatible rolling requires the active fingerprint and no staged replacement.",
        );
      }
      await options.activated.refresh();
      return current;
    },
    async stageNextFingerprint(fingerprint) {
      return options.store.stageNextFingerprint(requireFingerprint(fingerprint), await liveFence());
    },
    async abortNextFingerprint(fingerprint) {
      return options.store.abortNextFingerprint(requireFingerprint(fingerprint), await liveFence());
    },
    async activateNextFingerprint(fingerprint) {
      return options.store.activateNextFingerprint(
        requireFingerprint(fingerprint),
        await liveFence(),
      );
    },
    async reverseFingerprint(fingerprint) {
      const expected = requireFingerprint(fingerprint);
      await options.store.stageNextFingerprint(expected, await liveFence());
      const reversed = await options.store.activateNextFingerprint(expected, await liveFence());
      return reversed;
    },
    async stageKeyVersion(purpose) {
      const fence = await liveFence();
      const { provider, inventory } = await loadAndRegisterProvider(purpose, fence);
      const verification = await options.keyRotation.verifyNodeCanary({
        nodeId: options.nodeId,
        purpose,
        keyVersion: inventory.keyVersion,
        provider,
        writerFence: fence.writerFence,
      });
      if (!verification.verified) {
        throw new CapletsError(
          "AUTH_FAILED",
          "The production node rejected the staged key canary.",
        );
      }
      const current = (await options.keyRotation.listInventory()).find(
        (candidate) =>
          candidate.purpose === purpose && candidate.keyVersion === inventory.keyVersion,
      );
      if (!current) {
        throw new CapletsError("SERVER_UNAVAILABLE", "The staged key inventory disappeared.");
      }
      return current;
    },
    async verifyKeyCanary(purpose, keyVersion) {
      const fence = await liveFence();
      const provider = await options.loadKeyProvider();
      const verification = await options.keyRotation.verifyNodeCanary({
        nodeId: options.nodeId,
        purpose,
        keyVersion,
        provider,
        writerFence: fence.writerFence,
      });
      return { verified: verification.verified, readiness: verification.readiness };
    },
    async activateKeyVersion(purpose, keyVersion) {
      const fence = await liveFence();
      const { provider } = await loadAndRegisterProvider(purpose, fence);
      const activated = await options.keyRotation.activateVersion({
        purpose,
        keyVersion,
        ...fence,
      });
      await options.activateKeyProvider(provider);
      await options.activated.refresh();
      return activated;
    },
    async reencryptVaultValues() {
      await liveFence();
      return options.security.reencryptVaultValues();
    },
    async rescanKeyRetirement(input) {
      return options.keyRotation.previewRetirement({
        ...input,
        ...(await liveFence()),
      });
    },
    async retireKeyVersion(input) {
      return options.keyRotation.retireVersion({
        ...input,
        ...(await liveFence()),
      });
    },
    listKeyInventory() {
      return options.keyRotation.listInventory();
    },
  });
}

export type ControlPlaneStaleReadClass = "catalog-read" | "runtime-metadata-read";

export type ControlPlaneLiveOperationClass =
  | "auth"
  | "admin"
  | "project-binding"
  | "attach"
  | "vault"
  | "import"
  | "export"
  | "mutation";

export type ActivatedControlPlaneRead = Readonly<{
  snapshot: ControlPlaneRuntimeSnapshot;
  stale: boolean;
  staleAgeMs?: number | undefined;
}>;

export type ActivatedControlPlane = Readonly<{
  readonly identity: ControlPlaneStore["identity"];
  current(): ControlPlaneRuntimeSnapshot;
  read(operation: ControlPlaneStaleReadClass): ActivatedControlPlaneRead;
  requireLive(operation: ControlPlaneLiveOperationClass): Promise<ControlPlaneWriterFence>;
  writerFenceForFinalGuard(): ControlPlaneWriterFence;
  refresh(): Promise<ControlPlaneRuntimeSnapshot>;
  health(): Promise<ControlPlaneHealthSummary>;
  detailedDiagnostics(
    reauthorize: () => Promise<boolean>,
  ): Promise<ControlPlaneDetailedDiagnostics>;
  close(): Promise<void>;
}>;

export type ControlPlaneActivationDeadlines = Readonly<{
  detectionMs: number;
  compositionMs: number;
  publicationMs: number;
}>;

type DeadlineRunner = <T>(operation: Promise<T>, timeoutMs: number, stage: string) => Promise<T>;

export type ActivatedControlPlaneOptions = Readonly<{
  store: ControlPlaneStore;
  loader: ControlPlaneRuntimeSnapshotLoader;
  node: Omit<ControlPlaneNodeRegistration, "appliedToken" | "effectiveRuntimeFingerprint">;
  loadContext?: ControlPlaneRuntimeSnapshotLoadContext | undefined;
  pollingIntervalMs?: number | undefined;
  deadlines?: Partial<ControlPlaneActivationDeadlines> | undefined;
  publish?:
    | ((
        snapshot: ControlPlaneRuntimeSnapshot,
        publication: Readonly<{ signal: AbortSignal }>,
      ) => void | Promise<void>)
    | undefined;
  verifyReady?: ((writerFence: ControlPlaneWriterFence) => void | Promise<void>) | undefined;
}>;

const DEFAULT_ACTIVATION_DEADLINES: ControlPlaneActivationDeadlines = Object.freeze({
  detectionMs: 750,
  compositionMs: 1_500,
  publicationMs: 250,
});

export async function createActivatedControlPlane(
  options: ActivatedControlPlaneOptions,
): Promise<ActivatedControlPlane> {
  const deadlines = Object.freeze({
    ...DEFAULT_ACTIVATION_DEADLINES,
    ...options.deadlines,
  });
  validateActivationDeadlines(deadlines);
  const pollingIntervalMs = options.pollingIntervalMs ?? 900;
  if (
    !Number.isSafeInteger(pollingIntervalMs) ||
    pollingIntervalMs <= 0 ||
    pollingIntervalMs > STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms
  ) {
    throw new CapletsError("CONFIG_INVALID", "Control-plane polling interval is invalid.");
  }
  if (
    pollingIntervalMs +
      deadlines.detectionMs * 2 +
      deadlines.compositionMs +
      deadlines.publicationMs * 4 >
    STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Control-plane polling and serial stage deadlines exceed the five-second envelope.",
    );
  }

  const revocationsInFlight = new Map<string, Promise<void>>();
  const fenceIdentity = (fence: ControlPlaneWriterFence): string =>
    `${fence.leaseId}:${fence.writerEpoch}:${fence.authorityGeneration}`;
  const revokeNodeWithinDeadline = async (
    stage: string,
    fence: ControlPlaneWriterFence | undefined,
  ): Promise<void> => {
    if (!fence) return;
    const key = fenceIdentity(fence);
    const revocation =
      revocationsInFlight.get(key) ??
      options.store.revokeNode(options.node.nodeId, fence).then(
        () => undefined,
        () => undefined,
      );
    revocationsInFlight.set(key, revocation);
    void revocation.finally(() => {
      if (revocationsInFlight.get(key) === revocation) revocationsInFlight.delete(key);
    });
    await withHardDeadline(revocation, deadlines.publicationMs, stage).catch(() => undefined);
  };
  const scheduleLateRegistrationCleanup = (
    registration: Promise<ControlPlaneNodeRegistrationResult>,
  ): void => {
    void registration.then(
      (result) => {
        if ((result.status === "ready" || result.status === "catching-up") && result.writerFence) {
          void revokeNodeWithinDeadline(
            "control-plane late failed-startup revocation",
            result.writerFence,
          );
        }
      },
      () => undefined,
    );
  };

  await withHardDeadline(
    options.store.initialize(),
    deadlines.detectionMs,
    "control-plane initialization",
  );
  let current = await withHardDeadline(
    options.loader.initialize(options.loadContext),
    deadlines.compositionMs,
    "control-plane initial composition",
  );
  await withHardDeadline(
    options.store.initializeActivationFingerprint(current.bootstrapFingerprint),
    deadlines.publicationMs,
    "control-plane initial activation",
  );
  let initialActivation = await withHardDeadline(
    options.store.activationState(),
    deadlines.detectionMs,
    "control-plane activation validation",
  );
  if (initialActivation.currentFingerprint !== current.bootstrapFingerprint) {
    const observed = await withHardDeadline(
      options.store.convergenceToken(),
      deadlines.detectionMs,
      "control-plane staged fingerprint detection",
    );
    const preflightRegistration = options.store.registerNode({
      ...options.node,
      effectiveRuntimeFingerprint: current.effectiveRuntimeFingerprint,
      appliedToken: observed,
    });
    let preflight: ControlPlaneNodeRegistrationResult;
    try {
      preflight = await withHardDeadline(
        preflightRegistration,
        deadlines.publicationMs,
        "control-plane staged fingerprint registration",
      );
    } catch (error) {
      scheduleLateRegistrationCleanup(preflightRegistration);
      throw error;
    }
    if (
      (preflight.status === "ready" || preflight.status === "catching-up") &&
      preflight.writerFence
    ) {
      await revokeNodeWithinDeadline(
        "control-plane unexpected preflight revocation",
        preflight.writerFence,
      );
    }
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      preflight.status === "activation-pending"
        ? "Runtime fingerprint is staged but not activated."
        : "Runtime fingerprint is not compatible with the active control plane.",
    );
  }

  let writerFence: ControlPlaneWriterFence | undefined;
  let startupRegistration: Promise<ControlPlaneNodeRegistrationResult> | undefined;
  let startupTransition: Promise<unknown> | undefined;
  let lastHealth: ControlPlaneHealthSummary;
  let pendingLoaderCommit = false;
  const startupDeadlineAt =
    Date.now() + deadlines.detectionMs + deadlines.compositionMs + deadlines.publicationMs * 3;
  const runStartupStage: DeadlineRunner = (operation, timeoutMs, stage) => {
    const remainingMs = Math.floor(startupDeadlineAt - Date.now());
    if (remainingMs <= 0) {
      throw unavailable("Control-plane startup convergence exceeded its hard deadline.");
    }
    return withHardDeadline(operation, Math.min(timeoutMs, remainingMs), stage);
  };
  try {
    for (;;) {
      startupRegistration = nodeRegistration(options, current);
      const registration = await runStartupStage(
        startupRegistration,
        deadlines.publicationMs,
        "control-plane node readiness",
      );
      startupRegistration = undefined;
      if (registration.status === "ready" && registration.writerFence) {
        writerFence = registration.writerFence;
        break;
      }
      if (registration.status !== "catching-up") {
        throw unavailable(`Control-plane node readiness failed: ${registration.status}.`);
      }
      const observed = await runStartupStage(
        options.store.convergenceToken(),
        deadlines.detectionMs,
        "control-plane startup catch-up detection",
      );
      const candidate = await runStartupStage(
        options.loader.reload(options.loadContext),
        deadlines.compositionMs,
        "control-plane startup catch-up composition",
      );
      if (compareSnapshotToken(candidate, observed) < 0) {
        throw unavailable("Startup runtime snapshot did not reach the observed SQL token.");
      }
      initialActivation = await runStartupStage(
        options.store.activationState(),
        deadlines.detectionMs,
        "control-plane startup fingerprint validation",
      );
      if (initialActivation.currentFingerprint !== candidate.bootstrapFingerprint) {
        throw unavailable("Runtime fingerprint is staged but not activated.");
      }
      current = candidate;
      pendingLoaderCommit = true;
    }
    startupTransition = Promise.resolve(options.verifyReady?.(writerFence));
    await runStartupStage(
      startupTransition,
      deadlines.publicationMs,
      "control-plane key canary verification",
    );
    const acknowledgementOperation = options.store.acknowledgeNode({
      nodeId: options.node.nodeId,
      bootstrapFingerprint: current.bootstrapFingerprint,
      effectiveRuntimeFingerprint: current.effectiveRuntimeFingerprint,
      appliedToken: snapshotToken(current),
      writerFence,
    });
    startupTransition = acknowledgementOperation;
    const initialAcknowledgement = await runStartupStage(
      acknowledgementOperation,
      deadlines.publicationMs,
      "control-plane initial acknowledgement",
    );
    if (initialAcknowledgement.status !== "applied") {
      throw unavailable("Control-plane initial acknowledgement lost its writer lease.");
    }
    if (pendingLoaderCommit && !options.loader.commit(current)) {
      throw unavailable("Control-plane startup snapshot was superseded.");
    }
    lastHealth = assertRedactedControlPlaneHealth(
      await runStartupStage(
        options.store.health(),
        deadlines.detectionMs,
        "control-plane initial health",
      ),
    );
  } catch (error) {
    if (!writerFence && startupRegistration) {
      scheduleLateRegistrationCleanup(startupRegistration);
    }
    void startupTransition?.then(
      () => undefined,
      () => undefined,
    );
    await revokeNodeWithinDeadline("control-plane failed-startup revocation", writerFence);
    throw error;
  }

  let stale = false;
  let disconnectedAt = 0;
  let closed = false;
  let connectivityEpoch = 0;
  const activePublications = new Set<AbortController>();
  const markStale = (): ControlPlaneWriterFence | undefined => {
    const staleFence = writerFence;
    connectivityEpoch += 1;
    stale = true;
    disconnectedAt ||= Date.now();
    writerFence = undefined;
    return staleFence;
  };
  const heartbeatIntervalMs = Math.max(1_000, Math.floor(options.node.ttlMs / 3));
  let heartbeatDueAt = performance.now() + heartbeatIntervalMs;
  let sweepInFlight: Promise<unknown> | undefined;
  let unsettledRefreshStage: Promise<void> | undefined;
  const runRefreshStage = async <T>(
    operation: Promise<T>,
    timeoutMs: number,
    stage: string,
  ): Promise<T> => {
    try {
      return await withHardDeadline(operation, timeoutMs, stage);
    } catch (error) {
      const unsettled = operation.then(
        () => undefined,
        () => undefined,
      );
      unsettledRefreshStage = unsettled;
      void unsettled.finally(() => {
        if (unsettledRefreshStage === unsettled) unsettledRefreshStage = undefined;
      });
      throw error;
    }
  };
  let activeRefresh: Promise<ControlPlaneRuntimeSnapshot> | undefined;
  let leaseTransition: Promise<void> = Promise.resolve();
  const serializeLeaseTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = leaseTransition.then(operation, operation);
    leaseTransition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let healthInFlight: Promise<ControlPlaneHealthSummary> | undefined;
  let liveRevalidationInFlight: ReturnType<ControlPlaneStore["acknowledgeNode"]> | undefined;
  const readHealth = (): Promise<ControlPlaneHealthSummary> => {
    if (healthInFlight) return healthInFlight;
    const operation = options.store.health();
    healthInFlight = operation;
    const clearHealth = (): void => {
      if (healthInFlight === operation) healthInFlight = undefined;
    };
    void operation.then(clearHealth, clearHealth);
    return operation;
  };
  let queuedRefresh:
    | {
        deadlineAt: number;
        wakeToken?: ControlPlaneConvergenceToken | undefined;
        promise: Promise<ControlPlaneRuntimeSnapshot>;
        resolve(snapshot: ControlPlaneRuntimeSnapshot): void;
        reject(error: unknown): void;
      }
    | undefined;

  const performRefresh = async (deadlineAt: number): Promise<ControlPlaneRuntimeSnapshot> => {
    if (closed) throw unavailable("Control-plane activation is closed.");
    if (unsettledRefreshStage) {
      throw unavailable("A timed-out control-plane stage is still settling.");
    }
    if (revocationsInFlight.size > 0) {
      throw unavailable("A prior control-plane revocation is still settling.");
    }
    const refreshConnectivityEpoch = connectivityEpoch;
    const runStage: DeadlineRunner = (operation, timeoutMs, stage) => {
      const remainingMs = Math.floor(deadlineAt - Date.now());
      if (remainingMs <= 0) {
        throw unavailable("Control-plane convergence exceeded its end-to-end deadline.");
      }
      return runRefreshStage(operation, Math.min(timeoutMs, remainingMs), stage);
    };
    try {
      const observed = await runStage(
        options.store.convergenceToken(),
        deadlines.detectionMs,
        "control-plane change detection",
      );
      if (
        current.backend === "postgres" &&
        !stale &&
        compareSnapshotToken(current, observed) >= 0 &&
        performance.now() < heartbeatDueAt
      ) {
        return current;
      }
      if (
        current.backend === "postgres" &&
        !stale &&
        compareSnapshotToken(current, observed) >= 0
      ) {
        const heartbeatFence = await serializeLeaseTransition(async () => {
          const renewedFence = await registerAppliedSnapshot(
            options,
            current,
            deadlines.publicationMs,
            runStage,
          );
          await runStage(
            Promise.resolve(options.verifyReady?.(renewedFence)),
            deadlines.publicationMs,
            "control-plane heartbeat key canary verification",
          );
          const heartbeat = await runStage(
            options.store.acknowledgeNode({
              nodeId: options.node.nodeId,
              bootstrapFingerprint: current.bootstrapFingerprint,
              effectiveRuntimeFingerprint: current.effectiveRuntimeFingerprint,
              appliedToken: snapshotToken(current),
              writerFence: renewedFence,
            }),
            deadlines.publicationMs,
            "control-plane heartbeat acknowledgement",
          );
          if (heartbeat.status !== "applied") {
            throw unavailable("Control-plane heartbeat lost its writer lease.");
          }
          return renewedFence;
        });
        heartbeatDueAt = performance.now() + heartbeatIntervalMs;
        writerFence = heartbeatFence;
        return current;
      }
      const candidate = await runStage(
        options.loader.reload(options.loadContext),
        deadlines.compositionMs,
        "control-plane snapshot composition",
      );
      if (candidate === current && !stale && performance.now() < heartbeatDueAt) return current;
      if (compareSnapshotToken(candidate, observed) < 0) {
        throw unavailable("Composed runtime snapshot did not reach the observed SQL token.");
      }
      const candidateActivation = await runStage(
        options.store.activationState(),
        deadlines.detectionMs,
        "control-plane fingerprint validation",
      );
      if (candidateActivation.currentFingerprint !== candidate.bootstrapFingerprint) {
        throw unavailable("Runtime fingerprint is staged but not activated.");
      }
      // Registration renews both expiries; acknowledgement alone advances the
      // applied tuple. Renew when due without adding a registration transaction to
      // every converged write.
      const leaseRenewalDue =
        !writerFence ||
        writerFence.authorityGeneration !== candidate.authorityGeneration ||
        performance.now() >= heartbeatDueAt;
      const candidateWriterFence = leaseRenewalDue
        ? await serializeLeaseTransition(() =>
            registerAppliedSnapshot(options, candidate, deadlines.publicationMs, runStage),
          )
        : writerFence;
      if (!candidateWriterFence) {
        throw unavailable("Control-plane writer lease is unavailable.");
      }
      const publication = new AbortController();
      activePublications.add(publication);
      let publicationCompleted = false;
      try {
        await serializeLeaseTransition(() =>
          runStage(
            Promise.resolve(options.verifyReady?.(candidateWriterFence)),
            deadlines.publicationMs,
            "control-plane snapshot readiness",
          ),
        );
        await runStage(
          Promise.resolve(options.publish?.(candidate, { signal: publication.signal })),
          deadlines.publicationMs,
          "control-plane snapshot publication",
        );
        publicationCompleted = true;
        if (closed || refreshConnectivityEpoch !== connectivityEpoch) {
          throw unavailable("Control-plane connectivity changed during snapshot publication.");
        }
        const acknowledgement = await serializeLeaseTransition(() =>
          runStage(
            options.store.acknowledgeNode({
              nodeId: options.node.nodeId,
              bootstrapFingerprint: candidate.bootstrapFingerprint,
              effectiveRuntimeFingerprint: candidate.effectiveRuntimeFingerprint,
              appliedToken: snapshotToken(candidate),
              writerFence: candidateWriterFence,
            }),
            deadlines.publicationMs,
            "control-plane snapshot acknowledgement",
          ),
        );
        if (acknowledgement.status !== "applied") {
          if (acknowledgement.reason === "token-behind") {
            throw new SupersededControlPlaneRefresh();
          }
          throw unavailable("Runtime snapshot acknowledgement lost its writer lease.");
        }
        if (closed || refreshConnectivityEpoch !== connectivityEpoch) {
          throw unavailable("Control-plane connectivity changed during snapshot acknowledgement.");
        }
        if (!options.loader.commit(candidate)) {
          throw new SupersededControlPlaneRefresh();
        }
      } catch (error) {
        publication.abort();
        let rollbackFailure: unknown;
        if (publicationCompleted && !closed) {
          const rollback = new AbortController();
          try {
            await runStage(
              Promise.resolve(options.publish?.(current, { signal: rollback.signal })),
              deadlines.publicationMs,
              "control-plane snapshot publication rollback",
            );
          } catch (rollbackError) {
            rollback.abort();
            rollbackFailure = rollbackError;
          }
        }
        if (rollbackFailure !== undefined) throw rollbackFailure;
        throw error;
      } finally {
        activePublications.delete(publication);
      }
      if (leaseRenewalDue) heartbeatDueAt = performance.now() + heartbeatIntervalMs;
      writerFence = candidateWriterFence;
      current = candidate;
      stale = false;
      disconnectedAt = 0;
      return current;
    } catch (error) {
      if (error instanceof SupersededControlPlaneRefresh) {
        throw unavailable("Runtime snapshot publication was superseded by a newer SQL token.");
      }
      const failedFence = markStale();
      await revokeNodeWithinDeadline("control-plane node revocation", failedFence);
      throw error;
    }
  };

  const launchRefresh = (
    deadlineAt = Date.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
  ): Promise<ControlPlaneRuntimeSnapshot> => {
    const running = performRefresh(deadlineAt);
    activeRefresh = running;
    const launchQueuedRefresh = (): void => {
      if (activeRefresh === running) activeRefresh = undefined;
      const queued = queuedRefresh;
      queuedRefresh = undefined;
      if (queued) void launchRefresh(queued.deadlineAt).then(queued.resolve, queued.reject);
    };
    void running.then(launchQueuedRefresh, launchQueuedRefresh);
    return running;
  };

  const refresh = (
    wakeToken?: ControlPlaneConvergenceToken | undefined,
  ): Promise<ControlPlaneRuntimeSnapshot> => {
    if (!activeRefresh) return launchRefresh();
    const deadlineAt = Date.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms;
    if (queuedRefresh) {
      if (
        wakeToken &&
        (!queuedRefresh.wakeToken ||
          compareConvergenceTokens(wakeToken, queuedRefresh.wakeToken) > 0)
      ) {
        queuedRefresh.wakeToken = wakeToken;
      }
      return queuedRefresh.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<ControlPlaneRuntimeSnapshot>();
    queuedRefresh = { deadlineAt, promise, resolve, reject, wakeToken };
    return promise;
  };

  let dialectUnsubscribe: () => Promise<void> = async () => {};
  try {
    dialectUnsubscribe = await options.store.subscribeToChanges((token) => {
      void refresh(token).catch(() => undefined);
    });
  } catch {
    // Notifications are an optimization; tuple polling remains authoritative.
  }
  const interval = setInterval(
    () => {
      void refresh().catch(() => undefined);
    },
    Math.min(pollingIntervalMs, heartbeatIntervalMs),
  );
  interval.unref();
  const sweepInterval = setInterval(
    () => {
      if (sweepInFlight) return;
      sweepInFlight = options.store
        .sweepOverdueNodes(STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms)
        .catch(() => undefined)
        .finally(() => {
          sweepInFlight = undefined;
        });
    },
    Math.max(1_000, pollingIntervalMs),
  );
  sweepInterval.unref();

  return Object.freeze({
    identity: options.store.identity,
    current() {
      return current;
    },
    read(operation) {
      if (!stale) return Object.freeze({ snapshot: current, stale: false });
      if (operation !== "catalog-read" && operation !== "runtime-metadata-read") {
        throw unavailable("Control-plane live authority is unavailable.");
      }
      return Object.freeze({
        snapshot: current,
        stale: true,
        staleAgeMs: Math.max(0, Date.now() - disconnectedAt),
      });
    },
    async requireLive(_operation) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const fence = writerFence;
        const snapshot = current;
        if (stale || closed || !fence) {
          throw unavailable("Control-plane live authority is unavailable.");
        }
        try {
          let acknowledgement = liveRevalidationInFlight;
          if (!acknowledgement) {
            const operation = serializeLeaseTransition(async () => {
              if (writerFence !== fence || current !== snapshot) {
                return { status: "rejected" as const, reason: "lease-revoked" as const };
              }
              // Writer-fence validation alone cannot prove that this node has applied
              // the current effective/security tuple. The acknowledgement is the
              // fail-closed admission check for every live or security operation.
              return withHardDeadline(
                options.store.acknowledgeNode({
                  nodeId: options.node.nodeId,
                  bootstrapFingerprint: snapshot.bootstrapFingerprint,
                  effectiveRuntimeFingerprint: snapshot.effectiveRuntimeFingerprint,
                  appliedToken: snapshotToken(snapshot),
                  writerFence: fence,
                }),
                deadlines.detectionMs,
                "control-plane live authority revalidation",
              );
            });
            liveRevalidationInFlight = operation;
            acknowledgement = operation;
            const clearLiveRevalidation = (): void => {
              if (liveRevalidationInFlight === operation) {
                liveRevalidationInFlight = undefined;
              }
            };
            void operation.then(clearLiveRevalidation, clearLiveRevalidation);
          }
          const result = await acknowledgement;
          if (result.status === "applied") {
            if (performance.now() >= heartbeatDueAt) {
              await refresh();
              const renewedFence = writerFence;
              if (stale || closed || !renewedFence || current !== snapshot) continue;
              return renewedFence;
            }
            return fence;
          }
          if (result.reason === "token-behind") {
            await refresh();
            continue;
          }
          if (writerFence !== fence) continue;
        } catch {
          if (writerFence !== fence) continue;
        }
        const failedFence = markStale();
        await revokeNodeWithinDeadline("control-plane live-authority revocation", failedFence);
        throw unavailable("Control-plane live authority is unavailable.");
      }
      throw unavailable("Control-plane live authority is unavailable.");
    },
    writerFenceForFinalGuard() {
      if (stale || closed || !writerFence) {
        throw unavailable("Control-plane live authority is unavailable.");
      }
      return writerFence;
    },
    refresh,
    async health() {
      if (!stale) {
        try {
          lastHealth = assertRedactedControlPlaneHealth(
            await withHardDeadline(readHealth(), deadlines.detectionMs, "control-plane health"),
          );
          return lastHealth;
        } catch {
          const failedFence = markStale();
          void revokeNodeWithinDeadline("control-plane health-failure revocation", failedFence);
        }
      }
      return assertRedactedControlPlaneHealth({
        ...lastHealth,
        readiness: "stale-read-only",
        connectivity: "unavailable",
        staleAgeMs: Math.max(0, Date.now() - disconnectedAt),
        convergence: options.store.backend === "sqlite" ? "single-node" : "overdue",
        guidanceCode: "storage-unavailable",
      });
    },
    async detailedDiagnostics(reauthorize) {
      let authorized = false;
      try {
        authorized = await withHardDeadline(
          reauthorize(),
          deadlines.detectionMs,
          "control-plane diagnostics reauthorization",
        );
      } catch {
        throw unavailable("Control-plane diagnostics authorization is unavailable.");
      }
      if (!authorized || stale) {
        throw unavailable("Control-plane diagnostics authorization is unavailable.");
      }
      const diagnostics = assertDetailedControlPlaneDiagnostics(
        await withHardDeadline(
          options.store.detailedDiagnostics(),
          deadlines.detectionMs,
          "control-plane detailed diagnostics",
        ),
      );
      try {
        authorized = await withHardDeadline(
          reauthorize(),
          deadlines.detectionMs,
          "control-plane diagnostics final reauthorization",
        );
      } catch {
        throw unavailable("Control-plane diagnostics authorization is unavailable.");
      }
      if (!authorized || stale) {
        throw unavailable("Control-plane diagnostics authorization is unavailable.");
      }
      return diagnostics;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearInterval(sweepInterval);
      const queued = queuedRefresh;
      queuedRefresh = undefined;
      queued?.reject(unavailable("Control-plane activation is closed."));
      for (const publication of activePublications) publication.abort();
      await dialectUnsubscribe();
      await withHardDeadline(
        Promise.all([
          activeRefresh?.then(
            () => undefined,
            () => undefined,
          ) ?? Promise.resolve(),
          leaseTransition,
        ]).then(() => undefined),
        STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
        "control-plane shutdown drain",
      ).catch(() => undefined);
      const shutdownFence = markStale();
      await revokeNodeWithinDeadline("control-plane shutdown revocation", shutdownFence);
    },
  });
}

async function registerAppliedSnapshot(
  options: ActivatedControlPlaneOptions,
  snapshot: ControlPlaneRuntimeSnapshot,
  deadlineMs: number,
  runDeadline: DeadlineRunner = withHardDeadline,
): Promise<ControlPlaneWriterFence> {
  return requireReadyWriterFence(
    await runDeadline(
      nodeRegistration(options, snapshot),
      deadlineMs,
      "control-plane node readiness",
    ),
  );
}

function nodeRegistration(
  options: ActivatedControlPlaneOptions,
  snapshot: ControlPlaneRuntimeSnapshot,
): Promise<ControlPlaneNodeRegistrationResult> {
  return options.store.registerNode({
    ...options.node,
    bootstrapFingerprint: snapshot.bootstrapFingerprint,
    effectiveRuntimeFingerprint: snapshot.effectiveRuntimeFingerprint,
    appliedToken: snapshotToken(snapshot),
  });
}

function requireReadyWriterFence(
  registration: ControlPlaneNodeRegistrationResult,
): ControlPlaneWriterFence {
  if (
    (registration.status !== "ready" && registration.status !== "catching-up") ||
    !registration.writerFence
  ) {
    throw unavailable(`Control-plane node readiness failed: ${registration.status}.`);
  }
  return registration.writerFence;
}

function snapshotToken(snapshot: ControlPlaneRuntimeSnapshot): ControlPlaneConvergenceToken {
  return {
    authorityGeneration: snapshot.authorityGeneration,
    effectiveGeneration: snapshot.effectiveGeneration,
    securityEpoch: snapshot.securityEpoch,
  };
}

function compareSnapshotToken(
  snapshot: ControlPlaneRuntimeSnapshot,
  token: ControlPlaneConvergenceToken,
): number {
  return (
    snapshot.authorityGeneration - token.authorityGeneration ||
    snapshot.effectiveGeneration - token.effectiveGeneration ||
    snapshot.securityEpoch - token.securityEpoch
  );
}

function compareConvergenceTokens(
  left: ControlPlaneConvergenceToken,
  right: ControlPlaneConvergenceToken,
): number {
  return (
    left.authorityGeneration - right.authorityGeneration ||
    left.effectiveGeneration - right.effectiveGeneration ||
    left.securityEpoch - right.securityEpoch
  );
}

function validateActivationDeadlines(deadlines: ControlPlaneActivationDeadlines): void {
  const values = [deadlines.detectionMs, deadlines.compositionMs, deadlines.publicationMs];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    values.reduce((total, value) => total + value, 0) >
      STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Control-plane stage deadlines must fit the five-second convergence envelope.",
    );
  }
}

async function withHardDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(unavailable(`${stage} exceeded its hard deadline.`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class SupersededControlPlaneRefresh extends Error {}

function unavailable(message: string): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", message);
}

export type InternalControlPlaneStorageMigrationRequest = Readonly<{
  target: "global";
  mode: "offline";
}>;

export type InternalControlPlaneStorageMigrationResult = Readonly<{
  status: "migrated" | "already-migrated";
  backend: "sqlite" | "postgres";
  authorityToken?: string | undefined;
  manifestSha256?: string | undefined;
}>;

/**
 * Internal U7 seam only. Production runtime construction intentionally does not create or call
 * this service until U10 owns the storage activation boundary.
 */
export type InternalControlPlaneStorageMigrationService = Readonly<{
  migrate(
    request: InternalControlPlaneStorageMigrationRequest,
  ): Promise<InternalControlPlaneStorageMigrationResult>;
}>;

export function createInternalControlPlaneStorageMigrationService(
  options: Readonly<{
    initialize(
      request: InternalControlPlaneStorageMigrationRequest,
      persistence?: ControlPlaneMigrationPersistence,
    ): Promise<InternalControlPlaneStorageMigrationResult>;
    persistence?: ControlPlaneMigrationPersistenceOptions | undefined;
  }>,
): InternalControlPlaneStorageMigrationService {
  const persistence = options.persistence
    ? createControlPlaneMigrationPersistence(options.persistence)
    : undefined;
  return {
    async migrate(request) {
      if (request.target !== "global" || request.mode !== "offline") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Internal storage migration requires the global offline target",
        );
      }
      const migrationRequest = { target: "global", mode: "offline" } as const;
      return persistence
        ? options.initialize(migrationRequest, persistence)
        : options.initialize(migrationRequest);
    },
  };
}
