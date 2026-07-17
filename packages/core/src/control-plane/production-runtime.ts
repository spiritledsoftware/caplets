import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open as openFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { version as packageVersion } from "../../package.json";
import { readCapletsLockfile, validateLockfileDestination } from "../cli/lockfile";
import { cloudAuthPath } from "../cloud-auth/store";
import {
  defaultStorageStateDir,
  loadLocalRuntimeConfig,
  loadRuntimeConfigLayers,
  resolveConfigPath,
  resolveCapletsRoot,
  resolveProjectConfigPath,
  runtimeFingerprintsForConfigLayers,
  vaultResolverForAuthDir,
  type ConfigVaultResolver,
  type DeploymentSecretReference,
  type LocalOverlayConfigWarning,
  type RuntimeConfigLayerInput,
  type ServeStorageConfig,
} from "../config";
import { defaultAuthDir, defaultCapletsLockfilePath } from "../config/paths";
import { createBootstrapFingerprintSnapshot } from "../caplet-source/runtime-fingerprint";
import type { CurrentHostManagementDependencies } from "../current-host/operations";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import { decryptVaultValue, type VaultEncryptedRecord } from "../vault/crypto";
import { loadVaultKey } from "../vault/keys";
import {
  readLegacyLocalSetupState,
  removeMigratedLegacyLocalSetupState,
} from "../setup/local-store";
import type {
  ControlPlaneAuthorizationDecision,
  ControlPlaneAuthorizationRequest,
} from "./authorization";
import { createControlPlaneRepository } from "./caplets/repository";
import {
  assertPostgresConnectionProfile,
  openPostgresOperationalControlPlaneDialect,
  openPostgresRuntimeControlPlaneDialect,
  verifyPostgresOldNodesDrained,
  type PostgresConnectionProfile,
} from "./dialect/postgres";
import { openSqliteControlPlaneDialect } from "./dialect/sqlite";
import type { MigrationEnvironment } from "./dialect/migrations";
import {
  fileV1AssociatedData,
  loadFileV1KeyProvider,
  type FileV1KeyProvider,
} from "./key-provider/file-v1";
import { FILE_V1_RUNTIME_PURPOSES } from "./key-provider/manifest";
import {
  createProductionPostgresVerifier,
  createProductionS3CanaryVerifier,
  type ProductionStorageAdapterOptions,
} from "./production-adapters";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema/definition";
import {
  finalizeBackupInventory,
  recordBackupInventory,
  writeRecoveryEnvelope,
  type RecoveryEnvelopeSink,
  type RecoveryWrappedKeySink,
} from "./migration/backup";
import {
  acquireLegacyMigrationExclusion,
  resumeLegacyMigrationExclusion,
} from "./migration/exclusion";
import {
  recoveryEnvelopeBindingDigest,
  type RecoveryEnvelopeBinding,
  type RecoveryKeyReference,
} from "./migration/manifest";
import {
  acquireLegacyMigrationMutex,
  runFreshControlPlaneInitialization,
  runLegacyControlPlaneInitialization,
  type LegacyControlPlaneInitializationOptions,
  type LegacyControlPlaneInitializationResult,
  type LegacyMigrationExclusionLease,
  type U6ProtectedLegacyRecord,
  type VerifiedLegacyMigrationSource,
  type VerifiedLegacyRecord,
} from "./migration/legacy";
import {
  createControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistence,
} from "./migration/persistence";
import {
  createControlPlaneSecurityRepository,
  type ControlPlaneSecurityRepository,
} from "./security/repository";
import { createControlPlaneKeyRotationManager } from "./security/key-rotation";
import {
  KeyCanaryProofCache,
  RuntimeAssetCache,
  keyCanaryProofKey,
  type AssetCacheCandidate,
} from "./runtime-caches";
import {
  createActivatedControlPlane,
  createControlPlaneMaintenanceCoordinator,
  createControlPlaneService,
  type ActivatedControlPlane,
  type ControlPlaneMaintenanceCoordinator,
} from "./service";
import {
  createControlPlaneRuntimeSnapshotLoader,
  type ControlPlaneRuntimeHydration,
  type ControlPlaneRuntimeSnapshot,
  type ControlPlaneRuntimeSnapshotLoader,
} from "./snapshot";
import {
  resolveDeploymentSecret,
  resolveStorageDeployment,
  type ResolveStorageDeploymentOptions,
  type ResolvedPostgresStorage,
  type ResolvedStorageDeployment,
} from "./storage-config";
import type { ControlPlaneStore } from "./store";
import type { ControlPlaneTransactionalDialect } from "./store";
import type { ControlPlaneStoreIdentity } from "./types";

const PROVIDER_VERSIONS = Object.freeze({
  runtimeAbi: 1,
  schema: CONTROL_PLANE_SCHEMA_VERSION,
  keyProviderAbi: 1,
  manifest: 1,
});
const SQL_VAULT_HYDRATION_CONCURRENCY = 16;

export type ProductionControlPlaneOptions = Readonly<{
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  nodeId?: string | undefined;
  storage?: Omit<ResolveStorageDeploymentOptions, "verifyPostgres" | "verifyS3Canary"> &
    Readonly<{
      verifyPostgres?: ResolveStorageDeploymentOptions["verifyPostgres"];
      verifyS3Canary?: ResolveStorageDeploymentOptions["verifyS3Canary"];
      adapters?: ProductionStorageAdapterOptions | undefined;
    }>;
}>;

export type ProductionControlPlane = Readonly<{
  storage: ResolvedStorageDeployment;
  store: ControlPlaneStore;
  loader: ControlPlaneRuntimeSnapshotLoader;
  activated: ActivatedControlPlane;
  management: CurrentHostManagementDependencies;
  security: ControlPlaneSecurityRepository;
  maintenance: ControlPlaneMaintenanceCoordinator;
  vaultResolver: ConfigVaultResolver;
  initialSnapshot: ControlPlaneRuntimeSnapshot;
  bindSnapshotPublisher(
    publisher: (
      snapshot: ControlPlaneRuntimeSnapshot,
      publication: Readonly<{ signal: AbortSignal }>,
    ) => Promise<void>,
  ): void;
  close(): Promise<void>;
}>;

export type ProductionPostgresOperationalStartupOptions = Readonly<{
  storage: Extract<ServeStorageConfig, { kind: "postgres" }>;
  deployment: ResolvedPostgresStorage;
  env?: NodeJS.ProcessEnv | undefined;
  nodeId?: string | undefined;
  resolveSecret?: ((reference: DeploymentSecretReference) => Promise<string>) | undefined;
  initializeLegacy?: (
    persistence: ControlPlaneMigrationPersistence,
  ) => Promise<LegacyControlPlaneInitializationResult>;
  openDialect?: typeof openPostgresOperationalControlPlaneDialect | undefined;
  verifyOldNodesDrained?: ((profile: PostgresConnectionProfile) => Promise<boolean>) | undefined;
}>;

export type ProductionPostgresOperationalStartupResult =
  | Readonly<{ role: "migrator"; migrations: readonly string[] }>
  | Readonly<{
      role: "maintenance";
      initialization: LegacyControlPlaneInitializationResult;
    }>;

export async function createProductionControlPlane(
  options: ProductionControlPlaneOptions = {},
): Promise<ProductionControlPlane> {
  const runtimeEnv = options.env ?? process.env;
  const configPath = resolveConfigPath(options.configPath);
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const bootstrapVaultResolver = vaultResolverForAuthDir(options.authDir, runtimeEnv);
  const config = loadLocalRuntimeConfig(configPath, projectConfigPath, {
    vaultResolver: bootstrapVaultResolver,
    ...(options.writeWarning === undefined ? {} : { writeWarning: options.writeWarning }),
  });
  if (config.serve?.storage?.kind === "postgres" && config.serve.storage.processRole !== "online") {
    throw new CapletsError(
      "CONFIG_INVALID",
      "A serving Postgres process requires the isolated online runtime role; operational roles must use one-shot startup.",
    );
  }
  const adapterOptions = options.storage?.adapters;
  const deployment = await resolveStorageDeployment(config.serve?.storage, {
    ...options.storage,
    defaultStateRoot: options.storage?.defaultStateRoot ?? defaultStorageStateDir(runtimeEnv),
    resolveSecret:
      options.storage?.resolveSecret ??
      ((reference) => resolveProductionSecret(reference, runtimeEnv)),
    verifyPostgres:
      options.storage?.verifyPostgres ?? createProductionPostgresVerifier(adapterOptions),
    verifyS3Canary:
      options.storage?.verifyS3Canary ?? createProductionS3CanaryVerifier(adapterOptions),
  });
  const environment = migrationEnvironment(config.serve?.storage, false);
  const dialect = await openProductionDialect(
    deployment,
    config.serve?.storage,
    environment,
    runtimeEnv,
  );
  let activated: ActivatedControlPlane | undefined;
  let abortPendingAssets: (() => Promise<void>) | undefined;
  try {
    if (deployment.backend === "sqlite") {
      await dialect.migrate();
    }
    const identity = Object.freeze({
      logicalHostId: deployment.logicalHostId,
      storeId: deployment.storeId,
      operationNamespace: deployment.operationNamespace,
    });
    const nodeId = options.nodeId ?? productionNodeId(options.env ?? process.env);
    const migration = createControlPlaneMigrationPersistence({ identity, dialect, nodeId });
    if (deployment.backend === "sqlite") {
      const initialization = await runProductionSqliteInitialization({
        migration,
        identity,
        stateRoot: deployment.stateRoot,
        keyProviderManifest: deployment.keyProviderManifest,
        configPath,
        authDir: options.authDir,
        env: options.env ?? process.env,
      });
      if (initialization.status === "not-ready") {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Another node owns the legacy storage migration election.",
        );
      }
    } else {
      await assertFinalizedProductionInitialization(migration);
    }
    const store = createControlPlaneRepository({ identity, dialect });
    await store.initialize();
    let availableKeyProvider = await loadFileV1KeyProvider({
      manifestPath: deployment.keyProviderManifest,
      expectedLogicalHostId: deployment.logicalHostId,
      expectedStoreId: deployment.storeId,
      expectedProfile: "online",
    });
    const keyRotation = createControlPlaneKeyRotationManager({ identity, dialect });
    await Promise.all(
      FILE_V1_RUNTIME_PURPOSES.map(async (purpose) => {
        await keyRotation.registerActiveVersion({
          purpose,
          provider: availableKeyProvider,
        });
      }),
    );
    const activeProvider = async (): Promise<FileV1KeyProvider> => {
      const inventory = await keyRotation.listInventory();
      return availableKeyProvider.withActiveVersions(
        Object.fromEntries(
          FILE_V1_RUNTIME_PURPOSES.map((purpose) => {
            const active = inventory.find(
              (candidate) => candidate.purpose === purpose && candidate.state === "active",
            );
            if (!active) {
              throw new CapletsError(
                "SERVER_UNAVAILABLE",
                `SQL has no active key version for ${purpose}.`,
              );
            }
            return [purpose, active.keyVersion];
          }),
        ),
      );
    };
    let keyProvider = await activeProvider();
    const security = createControlPlaneSecurityRepository({
      identity,
      dialect,
      keyProvider,
      mutationAuthority() {
        if (!activated) return undefined;
        return {
          securityEpoch: activated.current().securityEpoch,
          writerFence: activated.writerFenceForFinalGuard(),
        };
      },
    });
    const vaultHydration = await createSqlVaultResolutionHydrator(security);
    const sqlVaultResolver = vaultHydration.resolver;
    const filesystemLayers = (): RuntimeConfigLayerInput[] =>
      loadRuntimeConfigLayers(configPath, projectConfigPath);
    const resolvedRuntimeInputs = Object.freeze({ backend: deployment.backend });
    // Key material convergence is fenced by the SQL inventory/canary protocol. Keeping it out of
    // the bootstrap fingerprint permits a compatible old+new provider bundle to roll safely.
    const hiddenCommitments = Object.freeze<string[]>([]);
    const materializedAssets = new RuntimeAssetCache(deployment.stateRoot);
    const canaryProofs = new KeyCanaryProofCache();
    let pendingAssetCandidate: AssetCacheCandidate | undefined;
    let unacknowledgedAssetPublication:
      | Readonly<{
          snapshot: ControlPlaneRuntimeSnapshot;
          candidate: AssetCacheCandidate;
        }>
      | undefined;
    abortPendingAssets = async () => {
      if (!pendingAssetCandidate) return;
      await materializedAssets.abort(pendingAssetCandidate);
      pendingAssetCandidate = undefined;
    };
    const hydrate = async (): Promise<ControlPlaneRuntimeHydration> => {
      if (pendingAssetCandidate) {
        await materializedAssets.abort(pendingAssetCandidate);
        pendingAssetCandidate = undefined;
      }
      await vaultHydration.refresh();
      const snapshot = await store.loadSnapshot();
      const candidate = await materializedAssets.prepare(
        snapshot.caplets.flatMap((entry) =>
          entry.projection.assets.map((asset) => ({
            capletId: entry.aggregate.id,
            logicalPath: asset.path,
            contentHash: asset.contentHash,
            content: asset.content,
          })),
        ),
      );
      pendingAssetCandidate = candidate;
      let activation: ControlPlaneRuntimeHydration["prerequisites"]["activation"];
      try {
        activation = await store.activationState();
      } catch (error) {
        if (
          !(error instanceof CapletsError) ||
          error.code !== "SERVER_UNAVAILABLE" ||
          !error.message.includes("runtime activation is not initialized")
        ) {
          throw error;
        }
        activation = {};
      }
      return {
        snapshot,
        prerequisites: {
          backend: deployment.backend,
          identity,
          storage: { status: "verified" },
          migration: { status: "current" },
          keys: { status: "verified" },
          canary: { status: "verified" },
          schema: { status: "current", version: CONTROL_PLANE_SCHEMA_VERSION },
          manifest: { status: "verified", version: 1 },
          compatibility: {
            status: "compatible",
            binaryVersion: packageVersion,
            schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
            keyVersion: 1,
            manifestVersion: 1,
          },
          authority: {
            status: "active",
            authorityGeneration: snapshot.versions.authorityGeneration,
            securityEpoch: snapshot.versions.securityEpoch,
          },
          activation,
        },
      };
    };
    const loader = createControlPlaneRuntimeSnapshotLoader({
      hydrate,
      loadFilesystemLayers: filesystemLayers,
      resolvedRuntimeInputs: () => resolvedRuntimeInputs,
      hiddenCommitments: () => hiddenCommitments,
      providerVersions: () => PROVIDER_VERSIONS,
      async adoptSqliteBootstrapFingerprint(request) {
        if (!store.adoptSqliteActivationFingerprint) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "SQLite runtime fingerprint adoption is unavailable.",
          );
        }
        await store.adoptSqliteActivationFingerprint(request);
        return hydrate();
      },
      resolveSqlAssetPath(capletId, logicalPath, asset) {
        const path = materializedAssets.resolve(capletId, logicalPath, asset.contentHash);
        if (!path) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "SQL asset materialization is unavailable for the complete snapshot.",
          );
        }
        return path;
      },
      vaultResolver: sqlVaultResolver,
    });
    const layers = filesystemLayers();
    const bootstrapFingerprint = bootstrapFingerprintFor(
      layers,
      resolvedRuntimeInputs,
      hiddenCommitments,
      sqlVaultResolver,
    );
    let publish:
      | ((
          snapshot: ControlPlaneRuntimeSnapshot,
          publication: Readonly<{ signal: AbortSignal }>,
        ) => Promise<void>)
      | undefined;
    const publisherReady = Promise.withResolvers<void>();
    activated = await createActivatedControlPlane({
      store,
      loader,
      node: {
        nodeId,
        bootstrapFingerprint,
        compatibility: {
          binaryVersion: packageVersion,
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          keyVersion: 1,
          manifestVersion: 1,
          schemaManifestFingerprint: schemaManifestFingerprint(),
          providerCommitment: keyProvider.manifest.compatibilityCommitment,
          keyCanaryCommitment: createHash("sha256")
            .update(`canary:${keyProvider.manifest.compatibilityCommitment}`)
            .digest("hex"),
          capabilities: [
            "ordered-tuple-polling",
            "writer-fence-v1",
            "complete-snapshot-v1",
            ...keyProvider.manifest.compatibilityKeys.map(
              (key) =>
                `key-material:${key.purpose}:${key.keyVersion}:${key.keyId}:${key.commitment}`,
            ),
          ],
        },
        ttlMs: 5_000,
      },
      loadContext: { vaultResolver: sqlVaultResolver },
      async publish(snapshot, publication) {
        await publisherReady.promise;
        const candidate = pendingAssetCandidate;
        if (publication.signal.aborted || !publish) {
          if (candidate) {
            pendingAssetCandidate = undefined;
            await materializedAssets.abort(candidate);
          }
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "The production snapshot publisher is not available.",
          );
        }
        if (!candidate) {
          const rejected = unacknowledgedAssetPublication;
          if (!rejected || rejected.snapshot === snapshot) {
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              "The production snapshot publisher has no rollback generation.",
            );
          }
          await publish(snapshot, publication);
          await materializedAssets.rollback(rejected.candidate);
          unacknowledgedAssetPublication = undefined;
          return;
        }
        try {
          await materializedAssets.commit(candidate);
          pendingAssetCandidate = undefined;
          await publish(snapshot, publication);
          unacknowledgedAssetPublication = { snapshot, candidate };
        } catch (error) {
          if (pendingAssetCandidate === candidate) {
            pendingAssetCandidate = undefined;
            await materializedAssets.abort(candidate);
          } else {
            await materializedAssets.rollback(candidate);
          }
          throw error;
        }
      },
      async verifyReady(writerFence) {
        const nextProvider = await activeProvider();
        const inventory = await keyRotation.listInventory();
        const verifiable = inventory.filter(
          (candidate) => candidate.state === "active" || candidate.state === "staged",
        );
        canaryProofs.beginFence(writerFence);
        const proofKeys = new Map<string, string>();
        for (const version of verifiable) {
          const material = nextProvider.manifest.compatibilityKeys.find(
            (candidate) =>
              candidate.purpose === version.purpose &&
              candidate.keyVersion === version.keyVersion &&
              candidate.keyId === version.keyId,
          );
          if (!material) {
            throw new CapletsError(
              "AUTH_FAILED",
              "The production key provider does not match SQL key inventory.",
            );
          }
          proofKeys.set(
            `${version.purpose}\u001f${version.keyVersion}\u001f${version.keyId}`,
            keyCanaryProofKey({
              nodeId,
              purpose: version.purpose,
              keyId: version.keyId,
              keyVersion: version.keyVersion,
              materialCommitment: material.commitment,
            }),
          );
        }
        canaryProofs.reconcile(new Set(proofKeys.values()));
        for (const purpose of FILE_V1_RUNTIME_PURPOSES) {
          const versions = verifiable.filter((candidate) => candidate.purpose === purpose);
          if (!versions.some((candidate) => candidate.state === "active")) {
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              `SQL has no active key version for ${purpose}.`,
            );
          }
          for (const version of versions) {
            const proofKey = proofKeys.get(
              `${version.purpose}\u001f${version.keyVersion}\u001f${version.keyId}`,
            )!;
            if (canaryProofs.has(proofKey)) continue;
            const verification = await keyRotation.verifyNodeCanary({
              nodeId,
              purpose,
              keyVersion: version.keyVersion,
              provider: nextProvider,
              writerFence,
            });
            if (!verification.verified) {
              throw new CapletsError(
                "AUTH_FAILED",
                "The production node could not verify its SQL-bound key canary.",
              );
            }
            canaryProofs.record(proofKey);
          }
        }
        security.updateActiveKeyProvider(nextProvider);
        keyProvider = nextProvider;
      },
    });
    if (pendingAssetCandidate) {
      await materializedAssets.commit(pendingAssetCandidate);
      pendingAssetCandidate = undefined;
    }
    const legacySetupState = readLegacyLocalSetupState({ env: options.env ?? process.env });
    if (legacySetupState) {
      await security.importLegacySetupState(legacySetupState);
      removeMigratedLegacyLocalSetupState(legacySetupState);
    }
    const developmentDecision = async (
      request: ControlPlaneAuthorizationRequest,
      revalidate = true,
    ): Promise<ControlPlaneAuthorizationDecision> => {
      if (
        request.actorId !== "development_unauthenticated" ||
        request.logicalHostId !== identity.logicalHostId ||
        request.storeId !== identity.storeId ||
        request.operationNamespace !== identity.operationNamespace
      ) {
        return { status: "denied", reason: "target-mismatch" };
      }
      return {
        status: "authorized",
        authorization: {
          ...identity,
          actorId: request.actorId,
          role: "operator",
          securityEpoch: activated!.current().securityEpoch,
          writerFence: revalidate
            ? await activated!.requireLive("mutation")
            : activated!.writerFenceForFinalGuard(),
        },
      };
    };
    const localizeAuthorization = async (
      decision: ControlPlaneAuthorizationDecision,
      revalidate = true,
    ): Promise<ControlPlaneAuthorizationDecision> => {
      if (decision.status === "denied") return decision;
      const current = activated!.current();
      if (decision.authorization.securityEpoch !== current.securityEpoch) {
        return { status: "denied", reason: "unavailable" };
      }
      return {
        status: "authorized",
        authorization: {
          ...decision.authorization,
          writerFence: revalidate
            ? await activated!.requireLive("mutation")
            : activated!.writerFenceForFinalGuard(),
        },
      };
    };
    const authorization = {
      async authorize(request: ControlPlaneAuthorizationRequest) {
        if (
          config.serve?.allowUnauthenticatedHttp &&
          request.actorId === "development_unauthenticated"
        ) {
          return developmentDecision(request);
        }
        return localizeAuthorization(await security.authorize(request));
      },
      async authorizeInTransaction(
        transaction: Parameters<NonNullable<typeof security.authorizeInTransaction>>[0],
        request: ControlPlaneAuthorizationRequest,
      ) {
        if (
          config.serve?.allowUnauthenticatedHttp &&
          request.actorId === "development_unauthenticated"
        ) {
          return developmentDecision(request, false);
        }
        return localizeAuthorization(
          await security.authorizeInTransaction!(transaction, request),
          false,
        );
      },
    };
    const controlPlaneService = createControlPlaneService({ store, authorization });
    const management: CurrentHostManagementDependencies = Object.freeze({
      storage: controlPlaneService,
      loadRuntimeSnapshot: async () => activated!.current(),
      applyCommitted() {
        // The durable receipt remains locally pending until the coalesced publisher acknowledges
        // a complete snapshot; awaiting every intermediate token would defeat burst coalescing.
        void activated!.refresh().catch(() => undefined);
      },
    });
    const active = activated;
    const maintenance = createControlPlaneMaintenanceCoordinator({
      store,
      activated: active,
      keyRotation,
      security,
      nodeId,
      loadKeyProvider: async () =>
        loadFileV1KeyProvider({
          manifestPath: deployment.keyProviderManifest,
          expectedLogicalHostId: deployment.logicalHostId,
          expectedStoreId: deployment.storeId,
          expectedProfile: "online",
        }),
      rememberKeyProvider(provider) {
        availableKeyProvider = provider;
      },
      async activateKeyProvider(provider) {
        availableKeyProvider = provider;
        const nextProvider = await activeProvider();
        security.updateActiveKeyProvider(nextProvider);
        keyProvider = nextProvider;
      },
    });
    return Object.freeze({
      storage: deployment,
      store,
      loader,
      activated: active,
      management,
      security,
      maintenance,
      vaultResolver: sqlVaultResolver,
      initialSnapshot: active.current(),
      bindSnapshotPublisher(value) {
        if (publish) {
          throw new CapletsError(
            "CONFIG_EXISTS",
            "The production snapshot publisher is already bound.",
          );
        }
        publish = value;
        publisherReady.resolve();
      },
      async close() {
        await active.close();
        await dialect.close();
      },
    });
  } catch (error) {
    await abortPendingAssets?.().catch(() => undefined);
    await activated?.close().catch(() => undefined);
    await dialect.close().catch(() => undefined);
    throw error;
  }
}

export function bindProductionSnapshotPublisher(
  production: ProductionControlPlane,
  publisher: (
    snapshot: ControlPlaneRuntimeSnapshot,
    publication: Readonly<{ signal: AbortSignal }>,
  ) => Promise<void>,
): void {
  production.bindSnapshotPublisher(publisher);
}

export type ProductionControlPlaneInitializationResult = LegacyControlPlaneInitializationResult;

export type ProductionControlPlaneOfflineMigrationOptions = Readonly<
  Pick<
    ProductionControlPlaneOptions,
    "configPath" | "projectConfigPath" | "authDir" | "writeWarning" | "env"
  >
>;

/**
 * Explicit one-shot U7 migration path. This never constructs or activates an online
 * runtime, so legacy mutable authority can be excluded before ordinary startup.
 */
export async function runProductionControlPlaneOfflineMigration(
  options: ProductionControlPlaneOfflineMigrationOptions = {},
): Promise<ProductionControlPlaneInitializationResult> {
  const configPath = resolveConfigPath(options.configPath);
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const env = options.env ?? process.env;
  const config = loadLocalRuntimeConfig(configPath, projectConfigPath, {
    vaultResolver: vaultResolverForAuthDir(options.authDir, env),
    ...(options.writeWarning === undefined ? {} : { writeWarning: options.writeWarning }),
  });
  const configuredStorage = config.serve?.storage;
  const offlineStorage =
    configuredStorage?.kind === "postgres"
      ? ({
          ...configuredStorage,
          processRole: "maintenance",
          keyProviderManifest: join(
            dirname(configuredStorage.keyProviderManifest),
            "maintenance.json",
          ),
        } as const)
      : configuredStorage;
  const adapterOptions: ProductionStorageAdapterOptions | undefined = undefined;
  const deployment = await resolveStorageDeployment(offlineStorage, {
    defaultStateRoot: defaultStorageStateDir(env),
    resolveSecret: (reference) => resolveProductionSecret(reference, env),
    verifyPostgres: createProductionPostgresVerifier(adapterOptions),
    verifyS3Canary: createProductionS3CanaryVerifier(adapterOptions),
  });

  if (deployment.backend === "postgres") {
    if (!offlineStorage || offlineStorage.kind !== "postgres") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Resolved Postgres storage configuration is absent.",
      );
    }
    await runProductionPostgresOperationalStartup({
      storage: { ...offlineStorage, processRole: "migrator" },
      deployment,
      env,
    });
    const maintenance = await runProductionPostgresOperationalStartup({
      storage: offlineStorage,
      deployment,
      env,
      initializeLegacy: (migration) =>
        runProductionOfflineLegacyInitialization({
          backend: "postgres",
          migration,
          identity: deployment,
          stateRoot: deployment.stateRoot,
          keyProviderManifest: deployment.keyProviderManifest,
          configPath,
          authDir: options.authDir,
          env,
        }),
    });
    if (maintenance.role !== "maintenance") {
      throw new CapletsError("INTERNAL_ERROR", "Offline migration did not use maintenance role.");
    }
    return maintenance.initialization;
  }

  const dialect = await openSqliteControlPlaneDialect({
    storage: deployment,
    environment: migrationEnvironment(offlineStorage, false),
    assetRoot: productionMigrationAssetRoot(),
  });
  try {
    await dialect.migrate();
    const identity = Object.freeze({
      logicalHostId: deployment.logicalHostId,
      storeId: deployment.storeId,
      operationNamespace: deployment.operationNamespace,
    });
    const migration = createControlPlaneMigrationPersistence({
      identity,
      dialect,
      nodeId: productionNodeId(env),
    });
    return await runProductionOfflineLegacyInitialization({
      backend: "sqlite",
      migration,
      identity,
      stateRoot: deployment.stateRoot,
      keyProviderManifest: deployment.keyProviderManifest,
      configPath,
      authDir: options.authDir,
      env,
    });
  } finally {
    await dialect.close();
  }
}

export async function runProductionPostgresOperationalStartup(
  options: ProductionPostgresOperationalStartupOptions,
): Promise<ProductionPostgresOperationalStartupResult> {
  const { storage } = options;
  if (storage.processRole === "online" || !storage.migration.designated) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "One-shot Postgres startup requires an explicitly designated migrator or maintenance role.",
    );
  }
  if (storage.processRole === "maintenance" && !options.initializeLegacy) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Maintenance startup requires explicit U7 legacy initialization inputs.",
    );
  }
  const profile = await resolveProductionPostgresProcessProfile(
    storage,
    options.env ?? process.env,
    options.resolveSecret,
  );
  const verifyDrained = options.verifyOldNodesDrained ?? verifyPostgresOldNodesDrained;
  const oldNodesDrained = await verifyDrained(profile);
  if (!oldNodesDrained) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Postgres migration requires every old ready-node lease and writer fence to be drained.",
    );
  }
  const dialect = await (options.openDialect ?? openPostgresOperationalControlPlaneDialect)({
    storage: options.deployment,
    purpose: storage.processRole,
    profile,
    runtimeRole: storage.connection.roles.runtime.role,
    environment: migrationEnvironment(storage, oldNodesDrained),
    assetRoot: productionMigrationAssetRoot(),
  });
  try {
    if (storage.processRole === "migrator") {
      const gateId = postgresMigrationDrainGateId(options.deployment);
      const drain = await dialect.beginMigrationDrain(gateId);
      let outcome: "finalized" | "rolled-back" = "rolled-back";
      try {
        if (!(await verifyDrained(profile))) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "An old Postgres node re-entered before the durable migration drain was established.",
          );
        }
        const migrations = await dialect.migrate();
        outcome = "finalized";
        await dialect.releaseMigrationDrain(gateId, outcome);
        return { role: "migrator", migrations };
      } catch (error) {
        if (drain.status === "active") {
          await dialect.releaseMigrationDrain(gateId, outcome);
        }
        throw error;
      }
    }
    if (!(await verifyDrained(profile))) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "An old Postgres node re-entered after the maintenance drain preflight.",
      );
    }
    const identity = Object.freeze({
      logicalHostId: options.deployment.logicalHostId,
      storeId: options.deployment.storeId,
      operationNamespace: options.deployment.operationNamespace,
    });
    const persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect,
      nodeId: options.nodeId ?? productionNodeId(options.env ?? process.env),
    });
    const initialization = await options.initializeLegacy!(persistence);
    if (initialization.status === "not-ready") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Another Postgres maintenance node owns the legacy migration election.",
      );
    }
    return { role: "maintenance", initialization };
  } finally {
    await dialect.close();
  }
}

const OFFLINE_LEGACY_MIGRATION_GUIDANCE =
  "Legacy mutable control-plane state requires protected offline migration. Stop every legacy replica, then run `caplets storage migrate --global --offline`; SQL authority was not activated.";

async function assertFinalizedProductionInitialization(
  migration: ControlPlaneMigrationPersistence,
): Promise<void> {
  const journal = await migration.inspectInitializationJournal();
  const supported =
    journal?.state === "finalized" &&
    ((journal.kind === "fresh" && journal.migrationId === "fresh-v1") ||
      (journal.kind === "legacy" && journal.migrationId === "legacy-v1"));
  if (!supported) throw offlineLegacyMigrationRequired();
}
async function runProductionOfflineLegacyInitialization(
  input: Readonly<{
    backend: "sqlite" | "postgres";
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
    keyProviderManifest: string;
    configPath: string;
    authDir?: string | undefined;
    env: NodeJS.ProcessEnv;
  }>,
): Promise<LegacyControlPlaneInitializationResult> {
  const journal = await input.migration.inspectInitializationJournal();
  if (journal?.kind === "legacy" && journal.state === "finalized") {
    return runLegacyControlPlaneInitialization(
      finalizedLegacyAdoptionOptions(input, input.backend, "offline"),
    );
  }
  if (journal?.kind === "fresh") {
    if (journal.migrationId !== "fresh-v1") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "The durable control-plane initialization journal is unsupported.",
      );
    }
    return runFreshControlPlaneInitialization({
      backend: input.backend,
      destination: input.migration.legacyDestination,
      election: input.migration.election,
      mutex: {
        acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
      },
    });
  }
  if (journal && (journal.kind !== "legacy" || journal.migrationId !== "legacy-v1")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Offline legacy migration cannot replace an existing initialization journal.",
    );
  }
  const legacyPresent = hasReviewedLegacyMutableAuthority(
    input.configPath,
    input.authDir,
    input.env,
  );
  if (!legacyPresent) {
    return runFreshControlPlaneInitialization({
      backend: input.backend,
      destination: input.migration.legacyDestination,
      election: input.migration.election,
      mutex: {
        acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
      },
    });
  }
  const source = discoverAutomaticLegacySource(input.configPath, input.authDir, input.env);
  if (!source) throw offlineLegacyMigrationRequired();
  const manifestRoot = dirname(input.keyProviderManifest);
  const [migrator, backupWriter] = await Promise.all([
    loadFileV1KeyProvider({
      manifestPath: join(manifestRoot, "migrator.json"),
      expectedLogicalHostId: input.identity.logicalHostId,
      expectedStoreId: input.identity.storeId,
      expectedProfile: "migrator",
    }),
    loadFileV1KeyProvider({
      manifestPath: join(manifestRoot, "backup-writer.json"),
      expectedLogicalHostId: input.identity.logicalHostId,
      expectedStoreId: input.identity.storeId,
      expectedProfile: "backup-writer",
    }),
  ]);
  const adapters = createProductionLegacyAdapters(input, source, migrator, backupWriter, "offline");
  return runLegacyControlPlaneInitialization({
    backend: input.backend,
    mode: "offline",
    migrationId: "legacy-v1",
    source,
    destination: input.migration.legacyDestination,
    election: input.migration.election,
    mutex: {
      acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
    },
    acquireExclusion: (options) =>
      acquireLegacyMigrationExclusion(withOfflinePlatformProof(options)),
    resumePostActivation: adapters.resumePostActivation,
    protectedRecovery: adapters.protectedRecovery,
    credentialProtection: adapters.credentialProtection,
  });
}

async function runProductionSqliteInitialization(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
    keyProviderManifest: string;
    configPath: string;
    authDir?: string | undefined;
    env: NodeJS.ProcessEnv;
  }>,
): Promise<LegacyControlPlaneInitializationResult> {
  const journal = await input.migration.inspectInitializationJournal();
  if (journal?.kind === "legacy") {
    if (journal.migrationId !== "legacy-v1" || journal.state !== "finalized") {
      throw offlineLegacyMigrationRequired();
    }
    return runLegacyControlPlaneInitialization(
      finalizedLegacyAdoptionOptions(input, "sqlite", "automatic"),
    );
  }
  if (journal && (journal.kind !== "fresh" || journal.migrationId !== "fresh-v1")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "The durable control-plane initialization journal is unsupported.",
    );
  }

  const legacyPresent = hasReviewedLegacyMutableAuthority(
    input.configPath,
    input.authDir,
    input.env,
  );
  if (!legacyPresent) {
    return runFreshControlPlaneInitialization({
      backend: "sqlite",
      destination: input.migration.legacyDestination,
      election: input.migration.election,
      mutex: {
        acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
      },
    });
  }
  const source = discoverAutomaticLegacySource(input.configPath, input.authDir, input.env);
  if (!source) throw offlineLegacyMigrationRequired();

  const manifestRoot = dirname(input.keyProviderManifest);
  const [migrator, backupWriter] = await Promise.all([
    loadFileV1KeyProvider({
      manifestPath: join(manifestRoot, "migrator.json"),
      expectedLogicalHostId: input.identity.logicalHostId,
      expectedStoreId: input.identity.storeId,
      expectedProfile: "migrator",
    }),
    loadFileV1KeyProvider({
      manifestPath: join(manifestRoot, "backup-writer.json"),
      expectedLogicalHostId: input.identity.logicalHostId,
      expectedStoreId: input.identity.storeId,
      expectedProfile: "backup-writer",
    }),
  ]);
  const adapters = createProductionLegacyAdapters(input, source, migrator, backupWriter);
  try {
    return await runLegacyControlPlaneInitialization({
      backend: "sqlite",
      mode: "automatic",
      migrationId: "legacy-v1",
      source,
      destination: input.migration.legacyDestination,
      election: input.migration.election,
      mutex: {
        acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
      },
      acquireExclusion: (options) =>
        acquireLegacyMigrationExclusion(withAutomaticPlatformProof(options)),
      resumePostActivation: adapters.resumePostActivation,
      protectedRecovery: adapters.protectedRecovery,
      credentialProtection: adapters.credentialProtection,
    });
  } catch (error) {
    if (error instanceof CapletsError && error.code === "INTERNAL_ERROR") throw error;
    throw offlineLegacyMigrationRequired();
  }
}

function finalizedLegacyAdoptionOptions(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    stateRoot: string;
  }>,
  backend: "sqlite" | "postgres",
  mode: "automatic" | "offline",
): LegacyControlPlaneInitializationOptions {
  const unavailable = async (): Promise<never> => {
    throw offlineLegacyMigrationRequired();
  };
  return {
    backend,
    mode,
    migrationId: "legacy-v1",
    source: {
      sourceBoundaryPath: input.stateRoot,
      mutablePaths: [],
      globalCapletsRoot: "global-caplets",
      globalLockfilePath: "caplets.lock.json",
      reviewedSources: [],
    },
    destination: input.migration.legacyDestination,
    election: input.migration.election,
    mutex: {
      acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
    },
    acquireExclusion: unavailable,
    resumePostActivation: unavailable,
    protectedRecovery: { protect: unavailable },
    credentialProtection: { protectAndVerify: unavailable },
  };
}

function discoverAutomaticLegacySource(
  configPath: string,
  configuredAuthDir: string | undefined,
  env: NodeJS.ProcessEnv,
): LegacyControlPlaneInitializationOptions["source"] | undefined {
  type ReviewedSource =
    LegacyControlPlaneInitializationOptions["source"]["reviewedSources"][number];
  type OfflineSource = NonNullable<
    LegacyControlPlaneInitializationOptions["source"]["offlineSourcePaths"]
  >[number];
  type PreservedSource = NonNullable<
    LegacyControlPlaneInitializationOptions["source"]["preservedSources"]
  >[number];

  const authDir = resolve(configuredAuthDir ?? defaultAuthDir(env));
  const stateBoundary = dirname(authDir);
  const configuredVaultRoot = configuredAuthDir
    ? join(authDir, "vault")
    : join(stateBoundary, "vault");
  const lockfilePath = configuredAuthDir
    ? join(stateBoundary, "caplets.lock.json")
    : defaultCapletsLockfilePath(env);
  const capletsRoot = resolve(resolveCapletsRoot(configPath));
  const cloudCredentialsPath = resolve(
    configuredAuthDir ? join(authDir, "cloud-auth.json") : cloudAuthPath({ env }),
  );
  const reviewedSources: ReviewedSource[] = [];
  const preservedSources: PreservedSource[] = [];
  const offlineSourcePaths: OfflineSource[] = [];
  const physicalSources = new Set<string>();
  const logicalSources = new Set<string>();

  const addOfflineSource = (
    sourcePath: string,
    logicalPath: string,
    kind?: "file" | "directory",
  ): boolean => {
    const physical = resolve(sourcePath);
    if (!existsSync(physical)) return false;
    const actualKind = lstatSync(physical).isDirectory() ? "directory" : "file";
    if (
      (kind && actualKind !== kind) ||
      physicalSources.has(physical) ||
      logicalSources.has(logicalPath)
    ) {
      return false;
    }
    physicalSources.add(physical);
    logicalSources.add(logicalPath);
    offlineSourcePaths.push({ sourcePath: physical, logicalPath, kind: actualKind });
    return true;
  };
  const addReviewedFile = (
    physicalPath: string,
    logicalPath: string,
    domain: ReviewedSource["domain"],
  ) => {
    if (!existsSync(physicalPath) || !lstatSync(physicalPath).isFile()) return;
    reviewedSources.push({ relativePath: logicalPath, domain });
  };
  const addJsonDirectory = (
    physicalRoot: string,
    logicalRoot: string,
    domain: ReviewedSource["domain"],
  ): boolean => {
    if (!existsSync(physicalRoot)) return true;
    for (const entry of readdirSync(physicalRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      addReviewedFile(join(physicalRoot, entry.name), `${logicalRoot}/${entry.name}`, domain);
    }
    return true;
  };

  const lockfilePresent = existsSync(lockfilePath);
  const lockfile = lockfilePresent
    ? addOfflineSource(lockfilePath, "caplets.lock.json", "file")
      ? readCapletsLockfile(lockfilePath)
      : undefined
    : undefined;
  if (lockfilePresent && !lockfile) return undefined;
  for (const entry of lockfile?.entries ?? []) {
    const physicalPath = validateLockfileDestination(capletsRoot, entry.destination);
    if (
      physicalPath === resolve(configPath) ||
      !addOfflineSource(
        physicalPath,
        `global-caplets/${entry.destination.split(/[\\/]/u).join("/")}`,
        entry.kind,
      )
    ) {
      return undefined;
    }
  }

  if (existsSync(authDir) && !addOfflineSource(authDir, "auth", "directory")) return undefined;
  if (
    existsSync(configuredVaultRoot) &&
    !isPathInsideAny(configuredVaultRoot, physicalSources) &&
    !addOfflineSource(configuredVaultRoot, "vault", "directory")
  ) {
    return undefined;
  }
  if (
    existsSync(cloudCredentialsPath) &&
    !isPathInsideAny(cloudCredentialsPath, physicalSources) &&
    !addOfflineSource(cloudCredentialsPath, "cloud-auth.json", "file")
  ) {
    return undefined;
  }

  if (existsSync(authDir)) {
    for (const entry of readdirSync(authDir, { withFileTypes: true })) {
      const path = join(authDir, entry.name);
      if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        resolve(path) !== cloudCredentialsPath
      ) {
        addReviewedFile(path, `auth/${entry.name}`, "oauth-token");
      }
    }
  }
  const remoteServerRoot = join(authDir, "remote-server");
  addReviewedFile(
    join(remoteServerRoot, "remote-server-credentials.json"),
    "auth/remote-server/remote-server-credentials.json",
    "remote-server-state",
  );
  addReviewedFile(
    join(remoteServerRoot, "dashboard-sessions.json"),
    "auth/remote-server/dashboard-sessions.json",
    "dashboard-session",
  );
  const remoteProfilesRoot = join(authDir, "remote-profiles");
  if (
    !addJsonDirectory(
      join(remoteProfilesRoot, "profiles"),
      "auth/remote-profiles/profiles",
      "remote-profile",
    ) ||
    !addJsonDirectory(
      join(remoteProfilesRoot, "credentials"),
      "auth/remote-profiles/credentials",
      "remote-profile-credential",
    ) ||
    !addJsonDirectory(
      join(remoteProfilesRoot, "selections"),
      "auth/remote-profiles/selections",
      "remote-profile",
    )
  ) {
    return undefined;
  }

  const vaultLogicalRoot = physicalSources.has(resolve(configuredVaultRoot))
    ? "vault"
    : "auth/vault";
  const valuesRoot = join(configuredVaultRoot, "values");
  if (!addJsonDirectory(valuesRoot, `${vaultLogicalRoot}/values`, "vault-value")) {
    return undefined;
  }
  addReviewedFile(
    join(configuredVaultRoot, "access-grants.json"),
    `${vaultLogicalRoot}/access-grants.json`,
    "vault-grant",
  );
  const vaultKeyPath = join(configuredVaultRoot, "vault-key");
  if (existsSync(vaultKeyPath)) {
    preservedSources.push({
      relativePath: `${vaultLogicalRoot}/vault-key`,
      kind: "file",
    });
  }
  addReviewedFile(
    cloudCredentialsPath,
    isPathInsideAny(cloudCredentialsPath, new Set([authDir]))
      ? `auth/${logicalRelative(authDir, cloudCredentialsPath)}`
      : "cloud-auth.json",
    "cloud-auth",
  );

  return {
    sourceBoundaryPath: stateBoundary,
    mutablePaths: [],
    offlineSourcePaths,
    globalCapletsRoot: "global-caplets",
    globalLockfilePath: "caplets.lock.json",
    reviewedSources,
    ...(preservedSources.length > 0 ? { preservedSources } : {}),
  };
}

function isPathInsideAny(path: string, roots: ReadonlySet<string>): boolean {
  const candidate = resolve(path);
  for (const root of roots) {
    const relativePath = relative(resolve(root), candidate);
    if (
      relativePath === "" ||
      (!relativePath.startsWith("..") &&
        !relativePath.startsWith("/") &&
        !relativePath.startsWith("\\"))
    ) {
      return true;
    }
  }
  return false;
}

function logicalRelative(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/u).join("/");
}

function withAutomaticPlatformProof(
  options: Parameters<typeof acquireLegacyMigrationExclusion>[0],
): Parameters<typeof acquireLegacyMigrationExclusion>[0] {
  if (process.platform === "linux") {
    return { ...options, platformOptions: { linux: { proof: { kind: "automatic" } } } };
  }
  if (process.platform === "darwin") {
    return { ...options, platformOptions: { macos: { proof: { kind: "automatic" } } } };
  }
  return options;
}

function withOfflinePlatformProof(
  options: Parameters<typeof acquireLegacyMigrationExclusion>[0],
): Parameters<typeof acquireLegacyMigrationExclusion>[0] {
  const proof = { kind: "offline", allReplicasStopped: true } as const;
  if (process.platform === "linux") {
    return { ...options, platformOptions: { linux: { proof } } };
  }
  if (process.platform === "darwin") {
    return { ...options, platformOptions: { macos: { proof } } };
  }
  return options;
}

function createProductionLegacyAdapters(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
    env: NodeJS.ProcessEnv;
  }>,
  source: LegacyControlPlaneInitializationOptions["source"],
  migrator: FileV1KeyProvider,
  backupWriter: FileV1KeyProvider,
  mode: "automatic" | "offline" = "automatic",
): Pick<
  LegacyControlPlaneInitializationOptions,
  "resumePostActivation" | "protectedRecovery" | "credentialProtection"
> {
  let sealedSource: LegacyMigrationExclusionLease["sealedSource"] | undefined;
  return {
    async resumePostActivation(metadata) {
      const resumeOptions = {
        sourceBoundaryPath: source.sourceBoundaryPath,
        mutablePaths: source.mutablePaths,
        mode,
      };
      const resumed = await resumeLegacyMigrationExclusion(
        mode === "automatic"
          ? withAutomaticPlatformProof(resumeOptions)
          : withOfflinePlatformProof(resumeOptions),
        metadata.exclusionCleanupId,
      );
      await resumed.completeActivation({ protectedRecoveryDurable: true });
      await resumed.release();
    },
    protectedRecovery: {
      async protect(recoveryInput) {
        sealedSource = recoveryInput.sealedSource;
        return protectLegacyRecoveryBundle(
          input,
          backupWriter,
          recoveryInput.migrationId,
          recoveryInput.source,
          recoveryInput.sealedSource,
        );
      },
    },
    credentialProtection: {
      async protectAndVerify(record) {
        if (!sealedSource) throw offlineLegacyMigrationRequired();
        return protectLegacyRecord(input, migrator, sealedSource, record);
      },
    },
  };
}

async function protectLegacyRecoveryBundle(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
  }>,
  backupWriter: FileV1KeyProvider,
  migrationId: string,
  source: VerifiedLegacyMigrationSource,
  sealedSource: LegacyMigrationExclusionLease["sealedSource"],
): Promise<Readonly<{ durable: true; bundleId: string }>> {
  const backupId = `legacy-${migrationId}-${source.manifestSha256.slice(0, 32)}`;
  const recoveryKey = backupWriter.manifest.compatibilityKeys.find(
    (entry) => entry.purpose === "backup-recovery",
  );
  if (!recoveryKey) throw offlineLegacyMigrationRequired();
  const providerIdentity = backupWriter.manifest.compatibilityCommitment;
  const recoveryKeyReference: RecoveryKeyReference = {
    provider: "file-v1",
    providerIdentity,
    logicalHostId: input.identity.logicalHostId,
    storeId: input.identity.storeId,
    profile: "offline-recovery",
    purpose: "backup-recovery",
    keyId: recoveryKey.keyId,
    keyVersion: recoveryKey.keyVersion,
  };
  const entityManifest = [
    ["tracked-caplet", source.trackedCaplets],
    ["legacy-record", source.records],
    ["quarantine", source.quarantines],
  ]
    .map(([entity, values]) => ({
      entity: entity as string,
      count: (values as readonly unknown[]).length,
      sha256: createHash("sha256").update(stableJsonStringify(values)).digest("hex"),
    }))
    .sort((left, right) => left.entity.localeCompare(right.entity));
  const binding: RecoveryEnvelopeBinding = {
    logicalHostId: input.identity.logicalHostId,
    storeId: input.identity.storeId,
    sourceBackend: "sqlite",
    requiredSchemaNames: ["legacy-filesystem-v1"],
    schemaChecksums: [{ name: "legacy-filesystem-v1", sha256: source.manifestSha256 }],
    authorityToken: `legacy-authority-${source.manifestSha256}`,
    effectiveToken: `legacy-effective-${source.manifestSha256}`,
    securityToken: `legacy-security-${source.manifestSha256}`,
    requiredEntityNames: entityManifest.map((entry) => entry.entity),
    entityManifest,
    recoveryKeyReference,
  };
  const recoveryRoot = join(input.stateRoot, "artifacts", "legacy-recovery", backupId);
  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  const envelopePath = join(recoveryRoot, "envelope.frames");
  const wrappedKeyPath = join(recoveryRoot, "wrapped-key.bin");
  const envelopeReference = `file-v1:${backupId}:envelope`;
  const wrappedKeyReference = `file-v1:${backupId}:wrapped-key`;
  const existing = await input.migration.recoveryBackupLifecycle.transaction((transaction) =>
    transaction.readBackupIntent(backupId),
  );
  if (existing?.phase === "finalized") {
    if (
      !existing.headerDigest ||
      !existing.terminalManifestDigest ||
      !existing.wrappedKeyDigest ||
      !existing.finalizedAt
    ) {
      throw offlineLegacyMigrationRequired();
    }
    await persistLegacyBackupInventory(input.migration, {
      backupId,
      bindingDigest: existing.bindingDigest,
      headerDigest: existing.headerDigest,
      terminalManifestDigest: existing.terminalManifestDigest,
      wrappedKeyDigest: existing.wrappedKeyDigest,
      providerIdentity,
      envelopeReference,
      wrappedKeyReference,
      recoveryKeyReference,
      createdAt: existing.createdAt,
      finalizedAt: existing.finalizedAt,
    });
    return { durable: true, bundleId: backupId };
  }
  if (existing) throw offlineLegacyMigrationRequired();

  let envelopeCreated = false;
  const envelopeSink: RecoveryEnvelopeSink = {
    providerIdentity,
    envelopeBytesReference: envelopeReference,
    async writeEnvelopeBytes(bytes) {
      const handle = await openFile(envelopePath, envelopeCreated ? "a" : "wx", 0o600);
      envelopeCreated = true;
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
  const wrappedKeySink: RecoveryWrappedKeySink = {
    providerIdentity,
    wrappedKeyReference,
    async writeWrappedKey(_reference, bytes) {
      const handle = await openFile(wrappedKeyPath, "wx", 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
  const createdAt = new Date().toISOString();
  const backupIntent = {
    version: 1 as const,
    backupId,
    bindingDigest: recoveryEnvelopeBindingDigest(binding),
    providerIdentity,
    envelopeBytesReference: envelopeReference,
    wrappedKeyReference,
    recoveryKeyReference,
    createdAt,
    phase: "staged" as const,
  };
  const result = await writeRecoveryEnvelope({
    binding,
    source: serializeSealedLegacySource(sealedSource),
    wrapAuthority: {
      reference: recoveryKeyReference,
      async wrapDataKey(dataKey) {
        return backupWriter.wrap("backup-wrap", dataKey).bytes;
      },
    },
    envelopeSink,
    wrappedKeySink,
    backupLifecycle: input.migration.recoveryBackupLifecycle,
    backupIntent,
    finalizedAt: createdAt,
  });
  await persistLegacyBackupInventory(input.migration, {
    backupId,
    bindingDigest: result.bindingDigest,
    headerDigest: result.headerDigest,
    terminalManifestDigest: result.terminalManifestDigest,
    wrappedKeyDigest: result.wrappedKeyDigest,
    providerIdentity,
    envelopeReference,
    wrappedKeyReference,
    recoveryKeyReference,
    createdAt,
    finalizedAt: createdAt,
  });
  return { durable: true, bundleId: backupId };
}

async function persistLegacyBackupInventory(
  migration: ControlPlaneMigrationPersistence,
  input: Readonly<{
    backupId: string;
    bindingDigest: string;
    headerDigest: string;
    terminalManifestDigest: string;
    wrappedKeyDigest: string;
    providerIdentity: string;
    envelopeReference: string;
    wrappedKeyReference: string;
    recoveryKeyReference: RecoveryKeyReference;
    createdAt: string;
    finalizedAt: string;
  }>,
): Promise<void> {
  const retentionUntil = new Date(
    Date.parse(input.createdAt) + 30 * 24 * 60 * 60_000,
  ).toISOString();
  await recordBackupInventory(migration.backupLifecycle, {
    backupId: input.backupId,
    bindingDigest: input.bindingDigest,
    headerDigest: input.headerDigest,
    terminalManifestDigest: input.terminalManifestDigest,
    wrappedKeyDigest: input.wrappedKeyDigest,
    providerIdentity: input.providerIdentity,
    envelopeBytesReference: input.envelopeReference,
    wrappedKeyReference: input.wrappedKeyReference,
    recoveryKeyReference: input.recoveryKeyReference,
    createdAt: input.createdAt,
    retentionUntil,
    state: "staged",
  });
  await finalizeBackupInventory(migration.backupLifecycle, {
    backupId: input.backupId,
    headerDigest: input.headerDigest,
    terminalManifestDigest: input.terminalManifestDigest,
    retentionUntil,
    finalizedAt: input.finalizedAt,
  });
}

async function* serializeSealedLegacySource(
  sealedSource: LegacyMigrationExclusionLease["sealedSource"],
): AsyncIterable<Uint8Array> {
  const entries: unknown[] = [];
  for (const mapping of sealedSource.sources ?? []) {
    collectRecoveryEntries(mapping.path, mapping.logicalPath, entries);
  }
  yield Buffer.from(stableJsonStringify({ version: 1, entries }), "utf8");
}

function collectRecoveryEntries(path: string, logicalPath: string, entries: unknown[]): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw offlineLegacyMigrationRequired();
  if (metadata.isFile()) {
    entries.push({
      path: logicalPath,
      kind: "file",
      mode: metadata.mode & 0o777,
      content: readFileSync(path).toString("base64"),
    });
    return;
  }
  if (!metadata.isDirectory()) throw offlineLegacyMigrationRequired();
  entries.push({ path: logicalPath, kind: "directory", mode: metadata.mode & 0o777 });
  for (const entry of readdirSync(path).sort()) {
    collectRecoveryEntries(join(path, entry), join(logicalPath, entry), entries);
  }
}

function protectLegacyRecord(
  input: Readonly<{ identity: ControlPlaneStoreIdentity; env: NodeJS.ProcessEnv }>,
  migrator: FileV1KeyProvider,
  sealedSource: LegacyMigrationExclusionLease["sealedSource"],
  record: VerifiedLegacyRecord,
): U6ProtectedLegacyRecord {
  let canonical = record.canonical;
  const protectCredentialBytes = (
    value: unknown,
    recordId: string,
  ): Readonly<{
    envelope: Buffer;
    keyVersion: number;
  }> => {
    if (!(value instanceof Uint8Array)) throw offlineLegacyMigrationRequired();
    const plaintext = Buffer.from(value);
    const nonce = randomBytes(12);
    const aad = fileV1AssociatedData({
      logicalHostId: input.identity.logicalHostId,
      storeId: input.identity.storeId,
      purpose: "active-record",
      recordId,
    });
    const protectedValue = migrator.encrypt("active-record", plaintext, nonce, aad);
    const verified = migrator.decrypt(
      "active-record",
      protectedValue.keyVersion,
      protectedValue.ciphertext,
      nonce,
      protectedValue.authenticationTag,
      aad,
    );
    if (!verified.equals(plaintext)) throw offlineLegacyMigrationRequired();
    plaintext.fill(0);
    return {
      envelope: Buffer.from(
        stableJsonStringify({
          version: 1,
          algorithm: "AES-256-GCM",
          aadVersion: 1,
          keyVersion: protectedValue.keyVersion,
          nonce: nonce.toString("base64url"),
          ciphertext: protectedValue.ciphertext.toString("base64url"),
          authenticationTag: protectedValue.authenticationTag.toString("base64url"),
        }),
        "utf8",
      ),
      keyVersion: protectedValue.keyVersion,
    };
  };
  if (record.domain === "vault-value") {
    const valuesMarker = "/values/";
    const valuesIndex = record.sourcePath.lastIndexOf(valuesMarker);
    if (valuesIndex <= 0) throw offlineLegacyMigrationRequired();
    const keyPath = resolveSealedLogicalPath(
      sealedSource,
      `${record.sourcePath.slice(0, valuesIndex)}/vault-key`,
    );
    const legacyKey = loadVaultKey({ keyFile: keyPath, env: input.env });
    const fields = canonical.fields as Record<string, unknown>;
    const legacyRecord: VaultEncryptedRecord = {
      version: fields.recordVersion as 1,
      algorithm: fields.algorithm as "aes-256-gcm",
      nonce: Buffer.from(fields.nonce as Uint8Array).toString("base64url"),
      ciphertext: Buffer.from(fields.ciphertext as Uint8Array).toString("base64url"),
      authTag: Buffer.from(fields.authTag as Uint8Array).toString("base64url"),
      valueBytes: fields.valueBytes as number,
      createdAt: fields.createdAt as string,
      updatedAt: fields.updatedAt as string,
    };
    const plaintext = Buffer.from(decryptVaultValue(legacyRecord, legacyKey), "utf8");
    const nonce = randomBytes(12);
    const aad = fileV1AssociatedData({
      logicalHostId: input.identity.logicalHostId,
      storeId: input.identity.storeId,
      purpose: "vault-record",
      recordId: String(canonical.identity.referenceName),
    });
    const protectedValue = migrator.encrypt("vault-record", plaintext, nonce, aad);
    const verified = migrator.decrypt(
      "vault-record",
      protectedValue.keyVersion,
      protectedValue.ciphertext,
      nonce,
      protectedValue.authenticationTag,
      aad,
    );
    if (!verified.equals(plaintext)) throw offlineLegacyMigrationRequired();
    canonical = {
      ...canonical,
      fields: {
        ...fields,
        ciphertext: protectedValue.ciphertext,
        nonce,
        authTag: protectedValue.authenticationTag,
        keyVersion: protectedValue.keyVersion,
        algorithm: "AES-256-GCM",
        aadVersion: 1,
      },
    };
    plaintext.fill(0);
    legacyKey.fill(0);
  } else if (record.domain === "remote-profile-credential") {
    const credentialId = String(canonical.identity.credentialId);
    const protectedCredential = protectCredentialBytes(
      canonical.fields.verifierOrCiphertext,
      credentialId,
    );
    canonical = {
      ...canonical,
      fields: {
        ...canonical.fields,
        purpose: "remote-profile",
        protection: "encrypted-envelope",
        verifierOrCiphertext: protectedCredential.envelope,
        algorithm: "AES-256-GCM",
        verifierVersion: 1,
        keyVersion: protectedCredential.keyVersion,
      },
    };
  } else if (record.domain === "cloud-auth") {
    const credentialId = String(canonical.identity.credentialId);
    const protectedAccess = protectCredentialBytes(
      canonical.fields.accessCiphertext,
      `${credentialId}:access`,
    );
    const protectedRefresh =
      canonical.fields.refreshCiphertext === undefined
        ? undefined
        : protectCredentialBytes(canonical.fields.refreshCiphertext, `${credentialId}:refresh`);
    canonical = {
      ...canonical,
      fields: {
        ...canonical.fields,
        purpose: "cloud-auth",
        protection: "encrypted-envelope",
        verifierOrCiphertext: protectedAccess.envelope,
        accessCiphertext: protectedAccess.envelope,
        ...(protectedRefresh ? { refreshCiphertext: protectedRefresh.envelope } : {}),
        algorithm: "AES-256-GCM",
        verifierVersion: 1,
        keyVersion: protectedAccess.keyVersion,
      },
    };
  } else if (record.domain === "remote-profile") {
    const credentialId = String(canonical.identity.credentialId);
    const protectedProfile = protectCredentialBytes(
      Buffer.from(stableJsonStringify(canonical.fields), "utf8"),
      credentialId,
    );
    canonical = {
      ...canonical,
      fields: {
        ...(canonical.fields.createdAt ? { createdAt: canonical.fields.createdAt } : {}),
        ...(canonical.fields.updatedAt ? { updatedAt: canonical.fields.updatedAt } : {}),
        ...(canonical.fields.ownerId ? { ownerId: canonical.fields.ownerId } : {}),
        purpose: "remote-profile",
        protection: "encrypted-envelope",
        verifierOrCiphertext: protectedProfile.envelope,
        algorithm: "AES-256-GCM",
        verifierVersion: 1,
        keyVersion: protectedProfile.keyVersion,
      },
    };
  } else if (record.domain === "dashboard-session") {
    const verifier = canonical.fields.verifier;
    const csrfVerifier = canonical.fields.csrfVerifier;
    if (!(verifier instanceof Uint8Array) || !(csrfVerifier instanceof Uint8Array)) {
      throw offlineLegacyMigrationRequired();
    }
    const computeVerifier = (value: Uint8Array, recordId: string) =>
      migrator.compute(
        "credential-verifier",
        Buffer.concat([
          fileV1AssociatedData({
            logicalHostId: input.identity.logicalHostId,
            storeId: input.identity.storeId,
            purpose: "credential-verifier",
            recordId,
          }),
          Buffer.from(value),
        ]),
      );
    const sessionId = String(canonical.identity.sessionId);
    const protectedVerifier = computeVerifier(verifier, sessionId);
    const protectedCsrfVerifier = computeVerifier(csrfVerifier, `${sessionId}:csrf`);
    canonical = {
      ...canonical,
      fields: {
        ...canonical.fields,
        verifier: protectedVerifier.bytes,
        algorithm: "HMAC-SHA-256",
        verifierVersion: 1,
        keyVersion: protectedVerifier.keyVersion,
        csrfVerifier: protectedCsrfVerifier.bytes,
        csrfAlgorithm: "HMAC-SHA-256",
        csrfKeyVersion: protectedCsrfVerifier.keyVersion,
      },
    };
  }
  const commitment = createHash("sha256")
    .update(stableJsonStringify({ ...record, canonical }))
    .digest("hex");
  return { ...record, canonical, protection: { verifiedBy: "u6", commitment } };
}

function resolveSealedLogicalPath(
  sealedSource: LegacyMigrationExclusionLease["sealedSource"],
  logicalPath: string,
): string {
  for (const mapping of sealedSource.sources ?? []) {
    if (mapping.logicalPath === ".") return join(mapping.path, logicalPath);
    if (logicalPath === mapping.logicalPath) return mapping.path;
    if (logicalPath.startsWith(`${mapping.logicalPath}/`)) {
      return join(mapping.path, logicalPath.slice(mapping.logicalPath.length + 1));
    }
  }
  throw offlineLegacyMigrationRequired();
}

function hasReviewedLegacyMutableAuthority(
  configPath: string,
  configuredAuthDir: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const defaultAuth = defaultAuthDir(env);
  const defaultLegacyRoot = dirname(defaultAuth);
  const candidates = [
    defaultAuth,
    join(defaultLegacyRoot, "vault"),
    defaultCapletsLockfilePath(env),
    cloudAuthPath({ env }),
    join(dirname(configPath), "cloud-auth.json"),
    ...(configuredAuthDir
      ? [
          configuredAuthDir,
          join(configuredAuthDir, "vault"),
          join(dirname(configuredAuthDir), "caplets.lock.json"),
          join(configuredAuthDir, "cloud-auth.json"),
        ]
      : []),
  ];
  return candidates.some((path) => pathContainsLegacyState(path));
}

function pathContainsLegacyState(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.isDirectory() && pathContainsLegacyState(join(path, entry.name))),
    );
  } catch {
    // A regular file, symlink, unreadable path, or concurrently changing path is never proof-new.
    return true;
  }
}

function offlineLegacyMigrationRequired(): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", OFFLINE_LEGACY_MIGRATION_GUIDANCE);
}

async function openProductionDialect(
  deployment: ResolvedStorageDeployment,
  storage: ServeStorageConfig | undefined,
  environment: MigrationEnvironment,
  env: NodeJS.ProcessEnv,
): Promise<ControlPlaneTransactionalDialect & { migrate(): unknown; close(): Promise<void> }> {
  if (deployment.backend === "sqlite") {
    return openSqliteControlPlaneDialect({
      storage: deployment,
      environment,
      assetRoot: productionMigrationAssetRoot(),
    });
  }
  if (!storage || storage.kind !== "postgres") {
    throw new CapletsError("CONFIG_INVALID", "Resolved Postgres storage configuration is absent.");
  }
  const runtime = await resolveProductionPostgresRuntimeProfile(storage, env);
  return openPostgresRuntimeControlPlaneDialect({
    storage: deployment,
    runtime,
    environment,
    assetRoot: productionMigrationAssetRoot(),
  });
}

export async function resolveProductionPostgresRuntimeProfile(
  storage: Extract<ServeStorageConfig, { kind: "postgres" }>,
  env: NodeJS.ProcessEnv,
  resolveSecret: (reference: DeploymentSecretReference) => Promise<string> = (reference) =>
    resolveProductionSecret(reference, env),
): Promise<PostgresConnectionProfile> {
  if (storage.processRole !== "online") {
    throw new CapletsError(
      "CONFIG_INVALID",
      "A serving Postgres process requires the isolated online runtime role.",
    );
  }
  return resolveProductionPostgresProcessProfile(storage, env, resolveSecret);
}

export async function resolveProductionPostgresProcessProfile(
  storage: Extract<ServeStorageConfig, { kind: "postgres" }>,
  env: NodeJS.ProcessEnv,
  resolveSecret: (reference: DeploymentSecretReference) => Promise<string> = (reference) =>
    resolveProductionSecret(reference, env),
): Promise<PostgresConnectionProfile> {
  const configured =
    storage.connection.roles[storage.processRole === "online" ? "runtime" : storage.processRole];
  const profile: PostgresConnectionProfile = {
    role: configured.role,
    connectionString: await resolveSecret(configured.credential),
    tls: {
      mode: "verify-full",
      servername: storage.connection.tls.serverName,
      ca:
        storage.connection.tls.ca === undefined
          ? ""
          : await resolveSecret(storage.connection.tls.ca),
    },
  };
  assertPostgresConnectionProfile(profile);
  return profile;
}

async function resolveProductionSecret(
  reference: DeploymentSecretReference,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (reference.kind === "env") {
    const value = env[reference.name];
    if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new CapletsError("AUTH_FAILED", "Deployment environment reference is unavailable.");
    }
    return value;
  }
  return resolveDeploymentSecret(reference, {});
}

function productionMigrationAssetRoot(): URL {
  const packaged = new URL("./control-plane/migrations/", import.meta.url);
  return existsSync(packaged) ? packaged : new URL("../../drizzle/", import.meta.url);
}

function migrationEnvironment(
  storage: ServeStorageConfig | undefined,
  oldNodesDrained: boolean,
): MigrationEnvironment {
  const postgres = storage?.kind === "postgres";
  const designated = postgres && storage.migration.designated && storage.processRole !== "online";
  return {
    binaryVersion: packageVersion,
    supportedSchemaVersion: 1,
    keyVersion: 1,
    manifestVersion: 1,
    verifiedSchemaAwareBackup: !postgres || designated,
    oldNodesDrained: !postgres || oldNodesDrained,
    retainedKeyVersions: [1],
    hostAdministrator: !postgres || designated,
  };
}

function bootstrapFingerprintFor(
  layers: readonly RuntimeConfigLayerInput[],
  resolvedRuntimeInputs: unknown,
  hiddenCommitments: readonly string[],
  vaultResolver: ReturnType<typeof vaultResolverForAuthDir>,
): string {
  const declaredInputFingerprints = runtimeFingerprintsForConfigLayers(layers, {
    vaultResolver,
  }).map((fingerprint) => fingerprint.artifactFingerprint);
  return createBootstrapFingerprintSnapshot({
    filesystemInputs: [...layers.map((layer) => layer.input), { declaredInputFingerprints }],
    resolvedRuntimeInputs,
    hiddenCommitments,
    providerVersions: PROVIDER_VERSIONS,
  }).fingerprint;
}

function productionNodeId(env: NodeJS.ProcessEnv): string {
  const configured = env.CAPLETS_NODE_ID;
  if (configured && /^[A-Za-z0-9._:-]{1,128}$/u.test(configured)) return configured;
  return `node-${process.pid}-${randomUUID()}`;
}

function postgresMigrationDrainGateId(storage: ResolvedPostgresStorage): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "postgres-migration-drain-v1",
        storage.logicalHostId,
        storage.storeId,
        packageVersion,
        schemaManifestFingerprint(),
      ]),
    )
    .digest("hex");
}

function schemaManifestFingerprint(): string {
  return createHash("sha256")
    .update(`caplets-control-plane-schema:${CONTROL_PLANE_SCHEMA_VERSION}`)
    .digest("hex");
}

function sqlVaultResolutionKey(
  reference: Readonly<{
    referenceName: string;
    capletId: string;
    origin: Readonly<{ kind: string; path: string }>;
  }>,
): string {
  return stableJsonStringify([
    reference.referenceName,
    reference.capletId,
    reference.origin.kind,
    reference.origin.path,
  ]);
}

export async function createSqlVaultResolutionHydrator(
  security: Pick<ControlPlaneSecurityRepository, "listAccess" | "revealValue">,
): Promise<
  Readonly<{
    resolver: ConfigVaultResolver;
    refresh(): Promise<void>;
  }>
> {
  let resolutions = await loadSqlVaultResolutions(security);
  let reuseInitialResult = true;
  return Object.freeze({
    resolver(reference) {
      return (
        resolutions.get(sqlVaultResolutionKey(reference)) ?? {
          reason: "ungranted",
          referenceName: reference.referenceName,
          capletId: reference.capletId,
          origin: reference.origin,
        }
      );
    },
    async refresh() {
      if (reuseInitialResult) {
        reuseInitialResult = false;
        return;
      }
      resolutions = await loadSqlVaultResolutions(security);
    },
  });
}

async function loadSqlVaultResolutions(
  security: Pick<ControlPlaneSecurityRepository, "listAccess" | "revealValue">,
): Promise<Map<string, { storedKey: string; value: string }>> {
  const grants = await security.listAccess();
  const storedKeys = [...new Set(grants.map((grant) => grant.storedKey))];
  const values = new Map<string, string>();
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from(
      { length: Math.min(SQL_VAULT_HYDRATION_CONCURRENCY, storedKeys.length) },
      async () => {
        while (!failed) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= storedKeys.length) return;
          const storedKey = storedKeys[index]!;
          try {
            values.set(storedKey, await security.revealValue(storedKey));
          } catch (error) {
            if (error instanceof CapletsError && error.code === "CONFIG_NOT_FOUND") continue;
            failed = true;
            failure = error;
          }
        }
      },
    ),
  );
  if (failed) throw failure;
  const resolutions = new Map<string, { storedKey: string; value: string }>();
  for (const grant of grants) {
    const value = values.get(grant.storedKey);
    if (value !== undefined) {
      resolutions.set(sqlVaultResolutionKey(grant), { storedKey: grant.storedKey, value });
    }
  }
  return resolutions;
}
