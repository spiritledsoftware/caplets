import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open as openFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { version as packageVersion } from "../../package.json";
import {
  readCapletsLockfile,
  validateLockfileDestination,
  parseCapletsLockfile,
  type CapletsLockEntry,
} from "../cli/lockfile";
import { cloudAuthPath } from "../cloud-auth/store";
import {
  defaultStorageStateDir,
  loadGlobalConfig,
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
import {
  createCurrentHostOfflineTransferClient,
  createCurrentHostPortableOperations,
  type CurrentHostManagementDependencies,
  type CurrentHostOfflineTransferClient,
  type CurrentHostOperationBinding,
  type CurrentHostOperationReceipt,
  type CurrentHostPortableOperations,
  type CurrentHostPortableRejectedReason,
} from "../current-host/operations";
import type { PersistGlobalCatalogChangeInput } from "../current-host/catalog-operations";
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
import { createPortableCapletExportService } from "./caplets/export";
import { createOfflineSqlTransferOperations } from "./operations";
import { createPortableCapletImportService, relationalProjection } from "./caplets/import";
import { decodePortableCapletArtifact } from "./caplets/portable-codec";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
} from "./caplets/model";
import {
  createControlPlaneRepository,
  TransactionBoundCapletMutationError,
  type TransactionBoundCapletMutation,
} from "./caplets/repository";
import { FilesystemArtifactProvider } from "./artifacts/filesystem";
import {
  createArtifactSessionManager,
  type ConsumeImportProposalResult,
} from "./artifacts/sessions";
import type { ArtifactProvider, ArtifactProviderIdentity } from "./artifacts/provider";
import {
  assertPostgresConnectionProfile,
  openPostgresOperationalControlPlaneDialect,
  openPostgresRuntimeControlPlaneDialect,
  verifyPostgresOldNodesDrained,
  type PostgresConnectionProfile,
  type PostgresControlPlaneDialect,
} from "./dialect/postgres";
import { openSqliteControlPlaneDialect, type SqliteControlPlaneDialect } from "./dialect/sqlite";
import type { MigrationActivationEvidence, MigrationEnvironment } from "./dialect/migrations";
import {
  fileV1AssociatedData,
  loadFileV1KeyProvider,
  type FileV1KeyProvider,
} from "./key-provider/file-v1";
import type { FileV1Profile } from "./key-provider/manifest";
import { FILE_V1_RUNTIME_PURPOSES } from "./key-provider/manifest";
import {
  createProductionPostgresVerifier,
  createProductionSecureFilesystemOptions,
  createProductionS3ArtifactProvider,
  createProductionS3CanaryVerifier,
  type ProductionStorageAdapterOptions,
} from "./production-adapters";
import { CONTROL_PLANE_SCHEMA_VERSION } from "./schema/definition";
import {
  finalizeBackupInventory,
  recordBackupInventory,
  writeRecoveryEnvelope,
  type RecoveryEnvelopeSink,
  type RecoveryBackupIntent,
  type RecoveryWrappedKeySink,
} from "./migration/backup";
import {
  acquireLegacyMigrationExclusion,
  resumeLegacyMigrationExclusion,
  resumeWindowsLegacyMigrationExclusion,
} from "./migration/exclusion";
import { createProductionSqliteToPostgresTransferPort } from "./migration/production-transfer";
import { createSqliteToPostgresTransferCoordinator } from "./migration/transfer";
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
  storageArtifactProviderBinding,
  resolveOfflineTransferStorageDeployment,
  storageBootstrapFingerprintCommitment,
  type ResolveStorageDeploymentOptions,
  type ResolvedPostgresStorage,
  type ResolvedStorageDeployment,
  type S3CanaryVerificationRequest,
} from "./storage-config";
import type { ControlPlaneSqlTransaction, ControlPlaneStore } from "./store";
import type {
  CapletManagementMutation,
  ControlPlaneActivity,
  ControlPlaneFinalAuthorization,
  ControlPlaneMutationResult,
  UntrustedCapletManagementMutation,
  ControlPlaneProvenance,
  ControlPlaneStoreIdentity,
} from "./types";

const PROVIDER_VERSIONS = Object.freeze({
  runtimeAbi: 1,
  schema: CONTROL_PLANE_SCHEMA_VERSION,
  keyProviderAbi: 1,
  manifest: 1,
});
type ProductionMetadataReadTransaction = Omit<ControlPlaneSqlTransaction, "select"> &
  Readonly<{
    select<Row extends Record<string, unknown>>(
      tableName: string,
      filter: Readonly<{ equals: Readonly<Record<string, unknown>> }>,
      order?: readonly Readonly<{ column: string; direction: "desc" }>[],
    ): Promise<readonly Row[]>;
  }>;

function isProductionRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
      windowsLegacyExclusionOwnerSid?: string | undefined;
    }>;
}>;

export type ProductionControlPlane = Readonly<{
  storage: ResolvedStorageDeployment;
  store: ControlPlaneStore;
  loader: ControlPlaneRuntimeSnapshotLoader;
  portable: CurrentHostPortableOperations;
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
  let verifiedS3Request: S3CanaryVerificationRequest | undefined;
  const verifyS3Canary =
    options.storage?.verifyS3Canary ?? createProductionS3CanaryVerifier(adapterOptions);
  const secureFilesystem = await createProductionSecureFilesystemOptions();
  const deployment = await resolveStorageDeployment(config.serve?.storage, {
    ...options.storage,
    defaultStateRoot: options.storage?.defaultStateRoot ?? defaultStorageStateDir(runtimeEnv),
    expectedOwner: options.storage?.expectedOwner ?? secureFilesystem.expectedOwner,
    filesystem: options.storage?.filesystem ?? secureFilesystem.filesystem,
    resolveSecret:
      options.storage?.resolveSecret ??
      ((reference) => resolveProductionSecret(reference, runtimeEnv)),
    verifyPostgres:
      options.storage?.verifyPostgres ?? createProductionPostgresVerifier(adapterOptions),
    verifyS3Canary: async (request) => {
      const result = await verifyS3Canary(request);
      verifiedS3Request = request;
      return result;
    },
  });
  const environment = migrationEnvironment(config.serve?.storage, false);
  const dialect = await openProductionDialect(
    deployment,
    config.serve?.storage,
    environment,
    runtimeEnv,
  );
  let activated: ActivatedControlPlane | undefined;
  let artifactProviderClose: (() => void) | undefined;
  let abortPendingAssets: (() => Promise<void>) | undefined;
  try {
    if (deployment.backend === "sqlite") {
      environment.activationEvidence = await loadMigrationActivationEvidence(
        dialect,
        deployment,
        "online",
      );
      await dialect.migrate();
    }
    const identity = Object.freeze({
      logicalHostId: deployment.logicalHostId,
      storeId: deployment.storeId,
      operationNamespace: deployment.operationNamespace,
    });
    const artifactBinding = storageArtifactProviderBinding(deployment);
    let artifactProvider: ArtifactProvider;
    if (deployment.backend === "sqlite") {
      const providerIdentity: ArtifactProviderIdentity = {
        kind: "filesystem",
        provider: "owner-private",
        namespace: "portable",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        identityId: artifactBinding.identityId,
      };
      artifactProvider = new FilesystemArtifactProvider(
        deployment.artifacts.root,
        providerIdentity,
      );
    } else {
      if (!verifiedS3Request) {
        throw new CapletsError(
          "AUTH_FAILED",
          "Verified S3 artifact provider request is unavailable.",
        );
      }
      const created = createProductionS3ArtifactProvider(verifiedS3Request, adapterOptions);
      artifactProvider = created.provider;
      artifactProviderClose = created.close;
    }
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
        windowsLegacyExclusionOwnerSid:
          options.storage?.windowsLegacyExclusionOwnerSid ??
          (secureFilesystem.expectedOwner.kind === "windows"
            ? secureFilesystem.expectedOwner.sid
            : undefined),
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
    const sessions = createArtifactSessionManager({
      identity,
      dialect,
      provider: artifactProvider,
      expectedProviderIdentity: artifactProvider.identity,
      expectedCanary: artifactBinding.expectedCanary,
    });
    const mutationFailureReason = (
      result: ControlPlaneMutationResult,
    ): CurrentHostPortableRejectedReason => {
      if (result.status === "denied") {
        return result.reason === "revoked-role" ? "revoked-actor" : "stale-generation";
      }
      if (result.status === "conflict") return "stale-generation";
      if (result.status === "unavailable" || result.status === "indeterminate") {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Portable SQL mutation outcome requires authoritative operation lookup.",
        );
      }
      throw new CapletsError("INTERNAL_ERROR", "Committed portable mutation was misclassified.");
    };
    const authorizationFailure = (
      decision: Extract<ControlPlaneAuthorizationDecision, { status: "denied" }>,
    ): Exclude<ControlPlaneFinalAuthorization, { status: "authorized" }> =>
      decision.reason === "unavailable"
        ? { status: "unavailable" }
        : {
            status: "denied",
            reason:
              decision.reason === "namespace-mismatch"
                ? "stale-authority"
                : decision.reason === "revoked" || decision.reason === "role-insufficient"
                  ? "revoked-role"
                  : "wrong-store",
          };
    const authorizeCapletMutation = async (
      input: UntrustedCapletManagementMutation,
    ): Promise<CapletManagementMutation | ControlPlaneMutationResult> => {
      if (input.binding.logicalHostId !== store.identity.logicalHostId) {
        return { status: "denied", reason: "wrong-host" };
      }
      if (input.binding.storeId !== store.identity.storeId) {
        return { status: "denied", reason: "wrong-store" };
      }
      const request: ControlPlaneAuthorizationRequest = {
        actorId: input.binding.actorId,
        logicalHostId: input.binding.logicalHostId,
        storeId: input.binding.storeId,
        operationNamespace: input.binding.operationNamespace,
        requiredRole: "operator",
      };
      const decision = await authorization.authorize(request);
      if (decision.status === "denied") return authorizationFailure(decision);
      if (decision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
        return { status: "denied", reason: "stale-security" };
      }
      const reservation = await store.reserveOperation(input.binding, input.aggregateId);
      if (reservation.status === "unavailable") return { status: "unavailable" };
      if (reservation.status === "conflict") {
        return { status: "conflict", reason: "operation-reservation" };
      }
      if (reservation.status === "committed") {
        return { status: "committed", receipt: reservation.receipt };
      }
      return {
        ...input,
        expectedSecurityEpoch: decision.authorization.securityEpoch,
        writerFence: decision.authorization.writerFence,
        finalAuthorization: async (transaction) => {
          const finalDecision = await authorization.authorizeInTransaction(transaction, request);
          if (finalDecision.status === "denied") return authorizationFailure(finalDecision);
          if (finalDecision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
            return { status: "denied", reason: "stale-security" };
          }
          return {
            status: "authorized",
            securityEpoch: finalDecision.authorization.securityEpoch,
            writerFence: finalDecision.authorization.writerFence,
          };
        },
      };
    };
    const commitCanonicalCaplet = async (
      input: Readonly<{
        binding: CurrentHostOperationBinding;
        aggregate: CanonicalCapletAggregate;
        projection: CanonicalCapletRelationalProjection;
        provenance: ControlPlaneProvenance;
        activity: ControlPlaneActivity;
        expectedAggregateVersion: number;
        expectedAuthorityGeneration: number;
        expectedSecurityEpoch: number;
      }>,
    ) =>
      controlPlaneService.mutateCaplet({
        ...input,
        aggregateId: input.aggregate.id,
        localApplication: "pending",
      });
    const targetFor = async (capletId: string) => {
      const runtime = activated!.current();
      const sqlSnapshot = await store.loadSnapshot();
      const existing = sqlSnapshot.caplets.find((entry) => entry.aggregate.id === capletId);
      return {
        current: {
          ...runtime,
          sqlSnapshot,
          authorityGeneration: sqlSnapshot.versions.authorityGeneration,
          effectiveGeneration: sqlSnapshot.versions.effectiveGeneration,
          securityEpoch: sqlSnapshot.versions.securityEpoch,
        },
        existing,
        filesystemOwned: runtime.caplets[capletId]?.owner === "filesystem",
        fence: {
          authorityGeneration: sqlSnapshot.versions.authorityGeneration,
          effectiveGeneration: sqlSnapshot.versions.effectiveGeneration,
          securityEpoch: sqlSnapshot.versions.securityEpoch,
          runtimeFingerprint: runtime.effectiveRuntimeFingerprint,
          aggregateVersion: existing?.aggregate.aggregateVersion ?? 0,
        },
      };
    };
    const imports = createPortableCapletImportService({
      sessions,
      async loadTarget({ capletId }) {
        const target = await targetFor(capletId);
        return {
          existingSql: target.existing
            ? {
                aggregateVersion: target.existing.aggregate.aggregateVersion,
                portable: target.existing.aggregate.portable,
              }
            : undefined,
          filesystemOwned: target.filesystemOwned,
          fence: target.fence,
        };
      },
      async activate() {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Production portable activation must use the durable mutation path.",
        );
      },
    });
    const exports = createPortableCapletExportService({
      sessions,
      async loadCaplet({ capletId, selector }) {
        const current = activated!.current();
        const source = current.sqlSnapshot.caplets.find((entry) => entry.aggregate.id === capletId);
        if (!source) throw new CapletsError("CONFIG_NOT_FOUND", "SQL Caplet is unavailable.");
        if (
          selector === "effective" &&
          (current.caplets[capletId]?.owner !== "sql" ||
            !source.aggregate.effective ||
            source.aggregate.activation !== "active")
        ) {
          throw new CapletsError(
            "CONFIG_NOT_FOUND",
            "The effective Caplet is not the underlying SQL aggregate.",
          );
        }
        return source;
      },
    });
    const loadGlobalCatalogProvenance = async (
      capletIds: readonly string[] | undefined,
    ): Promise<readonly CapletsLockEntry[]> =>
      dialect.snapshotTransaction(async (transaction) => {
        // The dialect schemas expose provenance, while the neutral mutation table union
        // intentionally hides it from ordinary repository consumers.
        const provenanceTransaction = transaction as ProductionMetadataReadTransaction;
        const rows = await provenanceTransaction.select<Record<string, unknown>>(
          "capletProvenance",
          {
            equals: {
              logicalHostId: identity.logicalHostId,
              storeId: identity.storeId,
            },
          },
          [{ column: "aggregateVersion", direction: "desc" }],
        );
        const requested = capletIds ? new Set(capletIds) : undefined;
        const seen = new Set<string>();
        const entries: CapletsLockEntry[] = [];
        for (const row of rows) {
          const capletId = typeof row.capletId === "string" ? row.capletId : undefined;
          if (!capletId || seen.has(capletId) || (requested && !requested.has(capletId))) continue;
          const source: unknown =
            typeof row.source === "string" ? JSON.parse(row.source) : row.source;
          if (!source || typeof source !== "object" || !("lockEntry" in source)) continue;
          const [lockEntry] = parseCapletsLockfile(
            { version: 1, entries: [source.lockEntry] },
            `SQL installation provenance for ${capletId}`,
          ).entries;
          if (!lockEntry || lockEntry.id !== capletId) continue;
          seen.add(capletId);
          entries.push(lockEntry);
        }
        return entries.sort((left, right) => left.id.localeCompare(right.id));
      });
    const loadInstallationProvenance = async (
      capletId: string,
      provenanceId: string | undefined,
    ): Promise<ControlPlaneProvenance> => {
      if (!provenanceId) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "SQL Caplet installation provenance is absent.",
        );
      }
      return dialect.snapshotTransaction(async (transaction) => {
        const provenanceTransaction = transaction as ProductionMetadataReadTransaction;
        const [row] = await provenanceTransaction.select<Record<string, unknown>>(
          "capletProvenance",
          {
            equals: {
              logicalHostId: identity.logicalHostId,
              storeId: identity.storeId,
              id: provenanceId,
              capletId,
            },
          },
        );
        const source: unknown =
          typeof row?.source === "string" ? JSON.parse(row.source) : row?.source;
        const riskSummary: unknown =
          typeof row?.riskSummary === "string" ? JSON.parse(row.riskSummary) : row?.riskSummary;
        if (
          !row ||
          typeof row.sourceKind !== "string" ||
          !isProductionRecord(source) ||
          typeof row.contentHash !== "string" ||
          (riskSummary !== undefined && !isProductionRecord(riskSummary))
        ) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "SQL Caplet installation provenance is invalid.",
          );
        }
        return {
          id: provenanceId,
          sourceKind: row.sourceKind,
          source,
          contentHash: row.contentHash,
          ...(typeof row.runtimeFingerprint === "string"
            ? { runtimeFingerprint: row.runtimeFingerprint }
            : {}),
          ...(typeof row.installedAt === "string" ? { installedAt: row.installedAt } : {}),
          ...(typeof row.resolvedRevision === "string"
            ? { resolvedRevision: row.resolvedRevision }
            : {}),
          ...(riskSummary ? { riskSummary } : {}),
          ...(typeof row.ownerId === "string" ? { ownerId: row.ownerId } : {}),
        };
      });
    };
    const persistGlobalCatalogChange = async (
      input: PersistGlobalCatalogChangeInput,
    ): Promise<Readonly<{ installed: (typeof input.artifacts)[number]["installed"][] }>> => {
      for (const artifact of input.artifacts) {
        const target = await targetFor(artifact.portable.id);
        if (target.filesystemOwned) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "A filesystem-owned Caplet cannot be replaced by global SQL catalog persistence.",
          );
        }
        const operationId = `catalog_${randomUUID()}`;
        const binding: CurrentHostOperationBinding = {
          operationId,
          target: "global",
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          operationNamespace: identity.operationNamespace,
          actorId: input.principal.clientId,
          requestIdentity: createHash("sha256")
            .update(
              stableJsonStringify({
                action: input.action,
                source: input.source,
                lockEntry: artifact.lockEntry,
                portable: artifact.portable,
              }),
            )
            .digest("hex"),
          operationClass: "logical-state",
        };
        const hasSetup = artifact.portable.references.some(
          (reference) => reference.type === "unresolved-setup",
        );
        const activation = hasSetup ? ("setup-required" as const) : ("active" as const);
        const aggregateVersion = target.fence.aggregateVersion + 1;
        const provenance: ControlPlaneProvenance = {
          id: `provenance:${operationId}`,
          sourceKind: "global-catalog",
          source: {
            action: input.action,
            ...input.source,
            lockEntry: artifact.lockEntry,
          },
          contentHash: createHash("sha256")
            .update(stableJsonStringify(artifact.portable))
            .digest("hex"),
          ...(artifact.lockEntry.runtimeFingerprint
            ? { runtimeFingerprint: artifact.lockEntry.runtimeFingerprint.artifactFingerprint }
            : {}),
          ...(artifact.lockEntry.source.type === "git" && artifact.lockEntry.source.resolvedRevision
            ? { resolvedRevision: artifact.lockEntry.source.resolvedRevision }
            : {}),
          installedAt: artifact.lockEntry.installedAt,
          riskSummary: artifact.lockEntry.risk,
          ownerId: input.principal.clientId,
        };
        const aggregate: CanonicalCapletAggregate = {
          modelVersion: 1,
          id: artifact.portable.id,
          aggregateVersion,
          ownership: "sql",
          activation,
          effective: activation === "active",
          portable: artifact.portable,
          installationProvenanceId: provenance.id,
          updateState: "current",
        };
        const projection = relationalProjection(
          artifact.portable,
          aggregateVersion,
          target.fence,
          input.principal.clientId,
          new Date(),
          target.existing !== undefined,
        );
        const result = await commitCanonicalCaplet({
          binding,
          aggregate,
          projection,
          provenance,
          expectedAggregateVersion: target.fence.aggregateVersion,
          expectedAuthorityGeneration: target.fence.authorityGeneration,
          expectedSecurityEpoch: target.fence.securityEpoch,
          activity: {
            id: `activity:${operationId}`,
            action: `catalog-${input.action}`,
            target: { type: "caplet", id: aggregate.id, selector: "underlying-sql" },
            detail: { sourceKind: provenance.sourceKind },
          },
        });
        if (result.status !== "committed") {
          const reason = mutationFailureReason(result);
          throw new CapletsError(
            "REQUEST_INVALID",
            `Global catalog SQL persistence was rejected: ${reason}.`,
          );
        }
        void activated!.refresh().catch(() => undefined);
      }
      return { installed: input.artifacts.map((artifact) => artifact.installed) };
    };
    const portable = createCurrentHostPortableOperations({
      sessions,
      imports,
      exports,
      loadGlobalCatalogProvenance,
      persistGlobalCatalogChange,
      async status() {
        const health = await activated!.health();
        return {
          kind: "portable_status",
          status:
            health.readiness === "ready"
              ? "live"
              : health.readiness === "stale-read-only"
                ? "stale-read-only"
                : "not-ready",
          health,
          guidanceCode: health.guidanceCode,
        };
      },
      async activate({ principal, operation }) {
        const proposal = await sessions.readImportProposal(operation.proposalId);
        if (!proposal) {
          return { kind: operation.kind, status: "rejected", reason: "not-found" };
        }
        if (proposal.actorId !== principal.clientId) {
          return { kind: operation.kind, status: "rejected", reason: "wrong-actor" };
        }
        if (proposal.operationId !== operation.binding.operationId) {
          return { kind: operation.kind, status: "rejected", reason: "wrong-operation" };
        }
        if (proposal.proposalHash !== operation.proposalHash) {
          return { kind: operation.kind, status: "rejected", reason: "proposal-mismatch" };
        }
        if (proposal.state === "consumed") {
          return { kind: operation.kind, status: "rejected", reason: "consumed" };
        }
        const now = new Date();
        if (proposal.state !== "previewed" || Date.parse(proposal.expiresAt) <= now.getTime()) {
          return { kind: operation.kind, status: "rejected", reason: "expired" };
        }
        const bytes = await sessions.readFinalizedArtifact(
          proposal.artifactId,
          principal.clientId,
          operation.binding.operationId,
        );
        const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
        const imported = decodePortableCapletArtifact(bytes);
        if (imported.id !== proposal.capletId) {
          return { kind: operation.kind, status: "rejected", reason: "changed-bytes" };
        }
        const target = await targetFor(imported.id);
        if (
          target.filesystemOwned ||
          proposal.expectedAuthorityGeneration !== target.fence.authorityGeneration ||
          proposal.expectedEffectiveGeneration !== target.fence.effectiveGeneration ||
          proposal.expectedAggregateVersion !== target.fence.aggregateVersion ||
          proposal.expectedSecurityEpoch !== target.fence.securityEpoch ||
          proposal.expectedRuntimeFingerprint !== target.fence.runtimeFingerprint
        ) {
          return { kind: operation.kind, status: "rejected", reason: "stale-generation" };
        }
        const activation = proposal.setupDependencies.some(
          (dependency) => dependency.status === "required",
        )
          ? ("setup-required" as const)
          : ("active" as const);
        const aggregateVersion = target.fence.aggregateVersion + 1;
        const provenance: ControlPlaneProvenance = {
          id: `provenance:${operation.proposalId}`,
          sourceKind: "portable-import",
          source: { artifactId: proposal.artifactId, proposalId: proposal.proposalId },
          contentHash: artifactSha256,
          installedAt: now.toISOString(),
          ownerId: principal.clientId,
        };
        const aggregate: CanonicalCapletAggregate = {
          modelVersion: 1,
          id: imported.id,
          aggregateVersion,
          ownership: "sql",
          activation,
          effective: activation === "active",
          portable: imported,
          installationProvenanceId: provenance.id,
          updateState: "current",
        };
        const projection = relationalProjection(
          imported,
          aggregateVersion,
          target.fence,
          principal.clientId,
          now,
          target.existing !== undefined,
        );
        const mutation: UntrustedCapletManagementMutation = {
          binding: operation.binding,
          aggregateId: aggregate.id,
          aggregate,
          projection,
          provenance,
          expectedAggregateVersion: target.fence.aggregateVersion,
          expectedAuthorityGeneration: target.fence.authorityGeneration,
          expectedSecurityEpoch: target.fence.securityEpoch,
          localApplication: "pending",
          activity: {
            id: `activity:${operation.binding.operationId}`,
            action: "portable-import",
            target: { type: "caplet", id: aggregate.id, selector: "underlying-sql" },
            detail: { proposalId: proposal.proposalId },
          },
        };
        const prepared = await authorizeCapletMutation(mutation);
        if ("status" in prepared && prepared.status !== "committed") {
          return {
            kind: operation.kind,
            status: "rejected",
            reason: mutationFailureReason(prepared),
          };
        }
        let transactionBound: TransactionBoundCapletMutation | undefined;
        let consumed: ConsumeImportProposalResult<CurrentHostOperationReceipt>;
        try {
          consumed = await sessions.consumeImportProposal(
            {
              actorId: principal.clientId,
              operationId: operation.binding.operationId,
              proposalId: operation.proposalId,
              proposalHash: operation.proposalHash,
              artifactSha256,
              fence: target.fence,
              now,
            },
            async (transaction) => {
              if ("status" in prepared) return prepared.receipt;
              transactionBound = await store.mutateCapletInTransaction(transaction, prepared);
              return transactionBound.result.receipt;
            },
          );
        } catch (error) {
          if (error instanceof TransactionBoundCapletMutationError) {
            return {
              kind: operation.kind,
              status: "rejected",
              reason: mutationFailureReason(error.result),
            };
          }
          throw error;
        }
        if (consumed.status === "rejected") {
          return {
            kind: operation.kind,
            status: "rejected",
            reason: consumed.reason,
          };
        }
        if (transactionBound) {
          const acknowledged = await transactionBound.afterCommit();
          if (acknowledged.status !== "committed") {
            const durable = await store.lookupOrReserveNotCommitted(operation.binding);
            if (durable.status !== "committed") {
              throw new CapletsError(
                "SERVER_UNAVAILABLE",
                "Portable import commit acknowledgement requires authoritative recovery.",
              );
            }
          }
        }
        void activated!.refresh().catch(() => undefined);
        return {
          kind: operation.kind,
          status: "committed",
          receipt: consumed.value,
          caplet: {
            id: aggregate.id,
            activation: aggregate.activation,
            setupDependencies: proposal.setupDependencies,
          },
        };
      },
      async revalidate({ principal, operation }) {
        const target = await targetFor(operation.capletId);
        const caplet = target.existing;
        if (
          !caplet ||
          caplet.aggregate.activation !== "setup-required" ||
          caplet.aggregate.aggregateVersion !== operation.expectedAggregateVersion ||
          target.current.authorityGeneration !==
            operation.expectedAuthorityToken.authorityGeneration ||
          target.current.effectiveGeneration !==
            operation.expectedAuthorityToken.effectiveGeneration ||
          target.current.securityEpoch !== operation.expectedSecurityEpoch
        ) {
          return {
            kind: operation.kind,
            status: "rejected",
            reason: "stale-caplet",
          };
        }
        const required = caplet.aggregate.portable.references.filter(
          (reference) => reference.type === "unresolved-setup",
        );
        const resolved = await Promise.all(
          required.map(async (dependency) => {
            if (runtimeEnv[dependency.name]) return true;
            return (await security.getStatus(dependency.name)).present;
          }),
        );
        if (resolved.some((present) => !present)) {
          return {
            kind: operation.kind,
            status: "rejected",
            reason: "setup-incomplete",
          };
        }
        const aggregateVersion = caplet.aggregate.aggregateVersion + 1;
        const occurredAt = new Date().toISOString();
        const aggregate: CanonicalCapletAggregate = {
          ...caplet.aggregate,
          aggregateVersion,
          activation: "active",
          effective: true,
        };
        const projection: CanonicalCapletRelationalProjection = {
          ...caplet.projection,
          activationHistory: [
            ...caplet.projection.activationHistory,
            {
              capletId: aggregate.id,
              sequence: caplet.projection.activationHistory.length + 1,
              from: "setup-required",
              to: "active",
              reason: "setup-remediated",
              actorId: principal.clientId,
              aggregateVersion,
              authorityVersion: target.fence.authorityGeneration,
              effectiveVersion: target.fence.effectiveGeneration + 1,
              occurredAt,
            },
          ],
        };
        const provenance = await loadInstallationProvenance(
          aggregate.id,
          aggregate.installationProvenanceId,
        );
        const result = await commitCanonicalCaplet({
          binding: operation.binding,
          aggregate,
          projection,
          expectedAggregateVersion: operation.expectedAggregateVersion,
          expectedAuthorityGeneration: operation.expectedAuthorityToken.authorityGeneration,
          expectedSecurityEpoch: operation.expectedSecurityEpoch,
          provenance,
          activity: {
            id: `activity:${operation.binding.operationId}`,
            action: "portable-setup-revalidated",
            target: { type: "caplet", id: aggregate.id, selector: "underlying-sql" },
          },
        });
        if (result.status !== "committed") {
          return {
            kind: operation.kind,
            status: "rejected",
            reason: mutationFailureReason(result),
          };
        }
        void activated!.refresh().catch(() => undefined);
        return {
          kind: operation.kind,
          status: "committed",
          receipt: result.receipt,
          caplet: { id: aggregate.id, activation: aggregate.activation },
        };
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
      portable,
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
        artifactProviderClose?.();
      },
    });
  } catch (error) {
    await abortPendingAssets?.().catch(() => undefined);
    await activated?.close().catch(() => undefined);
    await dialect.close().catch(() => undefined);
    artifactProviderClose?.();
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

export type ProductionCurrentHostOfflineTransferClientOptions = Readonly<{
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  destinationConfigPath: string;
  authDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
}>;

export async function createProductionCurrentHostOfflineTransferClient(
  options: ProductionCurrentHostOfflineTransferClientOptions,
): Promise<CurrentHostOfflineTransferClient & Readonly<{ close(): Promise<void> }>> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const configPath = resolveConfigPath(options.configPath);
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  const authDir = options.authDir ?? defaultAuthDir(env);
  const vaultResolver = vaultResolverForAuthDir(authDir, env);
  const sourceConfig = loadLocalRuntimeConfig(configPath, projectConfigPath, {
    vaultResolver,
  });
  const destinationConfig = loadGlobalConfig(options.destinationConfigPath, {
    vaultResolver,
  });
  if (
    sourceConfig.serve?.storage?.kind === "postgres" ||
    destinationConfig.serve?.storage?.kind !== "postgres"
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Offline SQL transfer requires an active SQLite source and a Postgres destination.",
    );
  }
  const destinationStorage = destinationConfig.serve.storage;
  if (destinationStorage.processRole === "online" || !destinationStorage.migration.designated) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Offline SQL transfer destination requires a designated operational Postgres role.",
    );
  }
  const secureFilesystem = await createProductionSecureFilesystemOptions();
  const adapterOptions: ProductionStorageAdapterOptions | undefined = undefined;
  const sourceDeployment = await resolveOfflineTransferStorageDeployment(
    sourceConfig.serve?.storage,
    "source",
    {
      defaultStateRoot: defaultStorageStateDir(env),
      expectedOwner: secureFilesystem.expectedOwner,
      filesystem: secureFilesystem.filesystem,
      resolveSecret: (reference) => resolveProductionSecret(reference, env),
    },
  );
  let verifiedS3Request: S3CanaryVerificationRequest | undefined;
  const destinationDeployment = await resolveOfflineTransferStorageDeployment(
    destinationStorage,
    "destination",
    {
      defaultStateRoot: defaultStorageStateDir(env),
      expectedOwner: secureFilesystem.expectedOwner,
      filesystem: secureFilesystem.filesystem,
      resolveSecret: (reference) => resolveProductionSecret(reference, env),
      verifyPostgres: createProductionPostgresVerifier(adapterOptions),
      verifyS3Canary: async (request) => {
        const result = await createProductionS3CanaryVerifier(adapterOptions)(request);
        verifiedS3Request = request;
        return result;
      },
    },
  );
  if (
    sourceDeployment.backend !== "sqlite" ||
    destinationDeployment.backend !== "postgres" ||
    sourceDeployment.logicalHostId !== destinationDeployment.logicalHostId ||
    sourceDeployment.storeId !== destinationDeployment.storeId ||
    sourceDeployment.operationNamespace !== destinationDeployment.operationNamespace
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Offline SQL transfer source and destination authority identities do not match.",
    );
  }
  if (!verifiedS3Request) {
    throw new CapletsError("AUTH_FAILED", "Verified destination artifact identity is unavailable.");
  }
  const migratorStorage = { ...destinationStorage, processRole: "migrator" as const };
  const migratorProfile = await resolveProductionPostgresProcessProfile(migratorStorage, env);
  const migratorEnvironment = migrationEnvironment(migratorStorage, true);
  const migrator = await openPostgresOperationalControlPlaneDialect({
    storage: destinationDeployment,
    purpose: "migrator",
    profile: migratorProfile,
    runtimeRole: destinationStorage.connection.roles.runtime.role,
    environment: migratorEnvironment,
    assetRoot: productionMigrationAssetRoot(),
  });
  try {
    migratorEnvironment.activationEvidence = await loadMigrationActivationEvidence(
      migrator,
      destinationDeployment,
      "migrator",
    );
    await migrator.migrate();
  } finally {
    await migrator.close();
  }
  const sourceDialect = await openSqliteControlPlaneDialect({
    storage: sourceDeployment,
    environment: migrationEnvironment(sourceConfig.serve?.storage, true),
    assetRoot: productionMigrationAssetRoot(),
  });
  const maintenanceStorage = {
    ...destinationStorage,
    processRole: "maintenance" as const,
  };
  const maintenanceProfile = await resolveProductionPostgresProcessProfile(maintenanceStorage, env);
  const destinationDialect = await openPostgresOperationalControlPlaneDialect({
    storage: destinationDeployment,
    purpose: "maintenance",
    profile: maintenanceProfile,
    runtimeRole: destinationStorage.connection.roles.runtime.role,
    environment: migrationEnvironment(maintenanceStorage, true),
    assetRoot: productionMigrationAssetRoot(),
  });
  let closed = false;
  try {
    const identity = Object.freeze({
      logicalHostId: sourceDeployment.logicalHostId,
      storeId: sourceDeployment.storeId,
      operationNamespace: sourceDeployment.operationNamespace,
    });
    const sourceStore = createControlPlaneRepository({ identity, dialect: sourceDialect });
    const destinationStore = createControlPlaneRepository({
      identity,
      dialect: destinationDialect,
    });
    await Promise.all([sourceStore.initialize(), destinationStore.initialize()]);
    const sourceKeyProvider = await loadFileV1KeyProvider({
      manifestPath: join(dirname(sourceDeployment.keyProviderManifest), "transfer-source.json"),
      expectedLogicalHostId: identity.logicalHostId,
      expectedStoreId: identity.storeId,
      expectedProfile: "transfer-source",
      filesystem: secureFilesystem.filesystem,
    });
    const destinationKeyProvider = await loadFileV1KeyProvider({
      manifestPath: join(
        dirname(destinationDeployment.keyProviderManifest),
        "transfer-destination.json",
      ),
      expectedLogicalHostId: identity.logicalHostId,
      expectedStoreId: identity.storeId,
      expectedProfile: "transfer-destination",
      filesystem: secureFilesystem.filesystem,
    });
    const port = createProductionSqliteToPostgresTransferPort({
      identity,
      source: sourceDialect,
      destination: destinationDialect,
      sourceStore,
      destinationStore,
      sourceDescriptorDigest: storageBootstrapFingerprintCommitment(sourceDeployment),
      destinationDescriptorDigest: storageBootstrapFingerprintCommitment(destinationDeployment),
      sourceKeyProviderIdentity: sourceKeyProvider.manifest.compatibilityCommitment,
      destinationKeyProviderIdentity: destinationKeyProvider.manifest.compatibilityCommitment,
      stateRoot: destinationDeployment.stateRoot,
    });
    const coordinator = createSqliteToPostgresTransferCoordinator({ port });
    const operations = createOfflineSqlTransferOperations({
      authorizeLocalGlobalAdministration: () => true,
      resolveCoordinator: () => coordinator,
    });
    const client = createCurrentHostOfflineTransferClient({
      authorizeLocalHostAdministrator: () => undefined,
      resolveTransferOperations: () => operations,
    });
    return Object.freeze({
      ...client,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([sourceDialect.close(), destinationDialect.close()]);
      },
    });
  } catch (error) {
    await Promise.allSettled([sourceDialect.close(), destinationDialect.close()]);
    throw error;
  }
}

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
  const secureFilesystem = await createProductionSecureFilesystemOptions();
  const deployment = await resolveStorageDeployment(offlineStorage, {
    defaultStateRoot: defaultStorageStateDir(env),
    expectedOwner: secureFilesystem.expectedOwner,
    filesystem: secureFilesystem.filesystem,
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
          windowsLegacyExclusionOwnerSid:
            secureFilesystem.expectedOwner.kind === "windows"
              ? secureFilesystem.expectedOwner.sid
              : undefined,
        }),
    });
    if (maintenance.role !== "maintenance") {
      throw new CapletsError("INTERNAL_ERROR", "Offline migration did not use maintenance role.");
    }
    return maintenance.initialization;
  }

  const environment = migrationEnvironment(offlineStorage, false);
  const dialect = await openSqliteControlPlaneDialect({
    storage: deployment,
    environment,
    assetRoot: productionMigrationAssetRoot(),
  });
  try {
    environment.activationEvidence = await loadMigrationActivationEvidence(
      dialect,
      deployment,
      "maintenance",
    );
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
      windowsLegacyExclusionOwnerSid:
        secureFilesystem.expectedOwner.kind === "windows"
          ? secureFilesystem.expectedOwner.sid
          : undefined,
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
  const environment = migrationEnvironment(storage, oldNodesDrained);
  const dialect = await (options.openDialect ?? openPostgresOperationalControlPlaneDialect)({
    storage: options.deployment,
    purpose: storage.processRole,
    profile,
    runtimeRole: storage.connection.roles.runtime.role,
    environment,
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
        environment.activationEvidence = await loadMigrationActivationEvidence(
          dialect,
          options.deployment,
          "migrator",
        );
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
    windowsLegacyExclusionOwnerSid?: string | undefined;
  }>,
): Promise<LegacyControlPlaneInitializationResult> {
  const journal = await input.migration.inspectInitializationJournal();
  if (journal?.kind === "legacy") {
    if (journal.migrationId !== "legacy-v1" || journal.state === "inactive") {
      throw offlineLegacyMigrationRequired();
    }
    if (journal.state === "finalized") {
      return runLegacyControlPlaneInitialization(
        finalizedLegacyAdoptionOptions(input, input.backend, "offline"),
      );
    }
    return resumeActiveProductionLegacyInitialization(input, input.backend);
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
    windowsLegacyExclusionOwnerSid?: string | undefined;
  }>,
): Promise<LegacyControlPlaneInitializationResult> {
  const journal = await input.migration.inspectInitializationJournal();
  if (journal?.kind === "legacy") {
    if (journal.migrationId !== "legacy-v1") throw offlineLegacyMigrationRequired();
    if (journal.state === "finalized") {
      return runLegacyControlPlaneInitialization(
        finalizedLegacyAdoptionOptions(input, "sqlite", "automatic"),
      );
    }
    if (journal.state !== "active") throw offlineLegacyMigrationRequired();
    return resumeActiveProductionLegacyInitialization(input, "sqlite");
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
  return resumeProductionSqliteLegacyInitialization(input);
}

async function resumeActiveProductionLegacyInitialization(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    stateRoot: string;
    configPath: string;
    authDir?: string | undefined;
    env: NodeJS.ProcessEnv;
    windowsLegacyExclusionOwnerSid?: string | undefined;
  }>,
  backend: "sqlite" | "postgres",
): Promise<LegacyControlPlaneInitializationResult> {
  const authDir = resolve(input.authDir ?? defaultAuthDir(input.env));
  const source: LegacyControlPlaneInitializationOptions["source"] = {
    sourceBoundaryPath: dirname(authDir),
    mutablePaths: [],
    globalCapletsRoot: "global-caplets",
    globalLockfilePath: "caplets.lock.json",
    reviewedSources: [],
  };
  const unavailable = async (): Promise<never> => {
    throw offlineLegacyMigrationRequired();
  };
  return runLegacyControlPlaneInitialization({
    backend,
    mode: "offline",
    migrationId: "legacy-v1",
    source,
    destination: input.migration.legacyDestination,
    election: input.migration.election,
    mutex: {
      acquire: () => acquireLegacyMigrationMutex(join(input.stateRoot, "legacy-migration.lock")),
    },
    acquireExclusion: unavailable,
    resumePostActivation: (metadata) =>
      resumeProductionLegacyPostActivation(
        source,
        "offline",
        metadata,
        input.windowsLegacyExclusionOwnerSid,
      ),
    protectedRecovery: { protect: unavailable },
    credentialProtection: { protectAndVerify: unavailable },
  });
}

async function resumeProductionSqliteLegacyInitialization(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
    keyProviderManifest: string;
    configPath: string;
    authDir?: string | undefined;
    env: NodeJS.ProcessEnv;
    windowsLegacyExclusionOwnerSid?: string | undefined;
  }>,
): Promise<LegacyControlPlaneInitializationResult> {
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

async function resumeProductionLegacyPostActivation(
  source: LegacyControlPlaneInitializationOptions["source"],
  mode: "automatic" | "offline",
  metadata: Parameters<LegacyControlPlaneInitializationOptions["resumePostActivation"]>[0],
  windowsOwnerSid?: string | undefined,
): Promise<void> {
  const resumeOptions = {
    sourceBoundaryPath: source.sourceBoundaryPath,
    mutablePaths: source.mutablePaths,
    mode,
  };
  let proofed: Parameters<typeof resumeLegacyMigrationExclusion>[0];
  const useWindows = process.platform === "win32" || windowsOwnerSid !== undefined;
  if (useWindows) {
    if (!windowsOwnerSid) throw offlineLegacyMigrationRequired();
    proofed = {
      ...resumeOptions,
      platform: "win32",
      platformOptions: {
        windows: {
          expectedOwnerSid: windowsOwnerSid,
          expectedServices: [],
          proof:
            mode === "automatic"
              ? { kind: "automatic" }
              : { kind: "offline", allReplicasStopped: true },
        },
      },
    };
  } else {
    proofed =
      mode === "automatic"
        ? withAutomaticPlatformProof(resumeOptions)
        : withOfflinePlatformProof(resumeOptions);
  }
  const resumed = useWindows
    ? await resumeWindowsLegacyMigrationExclusion(proofed, metadata.exclusionCleanupId)
    : await resumeLegacyMigrationExclusion(proofed, metadata.exclusionCleanupId);
  await resumed.completeActivation({ protectedRecoveryDurable: true });
  await resumed.release();
}

function createProductionLegacyAdapters(
  input: Readonly<{
    migration: ControlPlaneMigrationPersistence;
    identity: ControlPlaneStoreIdentity;
    stateRoot: string;
    env: NodeJS.ProcessEnv;
    windowsLegacyExclusionOwnerSid?: string | undefined;
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
      await resumeProductionLegacyPostActivation(
        source,
        mode,
        metadata,
        input.windowsLegacyExclusionOwnerSid,
      );
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
  const baseBackupId = `legacy-${migrationId}-${source.manifestSha256.slice(0, 32)}`;
  let backupId = baseBackupId;
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
  let existing: RecoveryBackupIntent | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    existing = await input.migration.recoveryBackupLifecycle.transaction((transaction) =>
      transaction.readBackupIntent(backupId),
    );
    if (!existing || existing.phase === "finalized") break;
    await rm(join(input.stateRoot, "artifacts", "legacy-recovery", backupId), {
      recursive: true,
      force: true,
    });
    const retryIdentity = createHash("sha256")
      .update(stableJsonStringify(existing))
      .digest("hex")
      .slice(0, 16);
    backupId = `${baseBackupId}-retry-${retryIdentity}`;
  }
  if (existing && existing.phase !== "finalized") throw offlineLegacyMigrationRequired();
  const recoveryRoot = join(input.stateRoot, "artifacts", "legacy-recovery", backupId);
  const envelopePath = join(recoveryRoot, "envelope.frames");
  const wrappedKeyPath = join(recoveryRoot, "wrapped-key.bin");
  const envelopeReference = `file-v1:${backupId}:envelope`;
  const wrappedKeyReference = `file-v1:${backupId}:wrapped-key`;
  if (!existing) {
    // A crash can durably create one or both files before the lifecycle intent is committed.
    // With the migration mutex/election held, absence of an intent proves these deterministic
    // bytes are not a committed recovery bundle, so discard them before the resumable retry.
    await rm(recoveryRoot, { recursive: true, force: true });
  }
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
  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });

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
): Promise<SqliteControlPlaneDialect | PostgresControlPlaneDialect> {
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

type MigrationEvidenceDialect = SqliteControlPlaneDialect | PostgresControlPlaneDialect;

type MigrationHistoryEvidenceRow = Readonly<{
  destinationSchemaVersion: number | bigint;
  appliedAt: string;
}>;

type MigrationBackupEvidenceRow = Readonly<{
  backupId: string;
  manifestHash: string;
  sourceIdentity: string;
  state: string;
  finalizedAt: string;
}>;

type MigrationKeyEvidenceRow = Readonly<{
  keyId: string;
  purpose: string;
  keyVersion: number | bigint;
  state: string;
}>;

async function loadMigrationActivationEvidence(
  dialect: MigrationEvidenceDialect,
  deployment: ResolvedStorageDeployment,
  profile: FileV1Profile,
): Promise<MigrationActivationEvidence | undefined> {
  let history: readonly MigrationHistoryEvidenceRow[];
  if (dialect.backend === "sqlite") {
    const [historyTable] = dialect.migrationQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name = '__caplets_migration_history_v1' LIMIT 1",
    );
    history = historyTable
      ? dialect.migrationQuery<MigrationHistoryEvidenceRow>(
          'SELECT destination_schema_version AS "destinationSchemaVersion", ' +
            'applied_at AS "appliedAt" FROM "__caplets_migration_history_v1" ' +
            "ORDER BY applied_at, migration_id",
        )
      : [];
  } else {
    history = await dialect.migrationQuery<MigrationHistoryEvidenceRow>(
      'SELECT destination_schema_version AS "destinationSchemaVersion", ' +
        'applied_at AS "appliedAt" FROM "caplets_control"."__caplets_migration_history_v1" ' +
        "ORDER BY applied_at, migration_id",
    );
  }
  if (history.length === 0) {
    const tables =
      dialect.backend === "sqlite"
        ? dialect.migrationQuery<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cp_%' LIMIT 1",
          )
        : await dialect.migrationQuery<{ name: string }>(
            "SELECT table_name AS name FROM information_schema.tables " +
              "WHERE table_schema = 'caplets_control' AND table_name LIKE 'cp_%' LIMIT 1",
          );
    if (tables.length !== 0) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Migration history is absent from a non-empty control-plane schema.",
      );
    }
    return { kind: "empty-bootstrap" };
  }
  const current = history.at(-1);
  if (!current) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Migration history is unavailable.");
  }
  const sourceSchemaVersion = Number(current.destinationSchemaVersion);
  if (!Number.isSafeInteger(sourceSchemaVersion) || sourceSchemaVersion < 0) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Migration history schema evidence is invalid.");
  }
  const identityParameters = [deployment.logicalHostId, deployment.storeId] as const;
  const backups =
    dialect.backend === "sqlite"
      ? dialect.migrationQuery<MigrationBackupEvidenceRow>(
          'SELECT backup_id AS "backupId", manifest_hash AS "manifestHash", ' +
            'source_identity AS "sourceIdentity", state, updated_at AS "finalizedAt" ' +
            "FROM cp_backup WHERE logical_host_id = ? AND store_id = ? AND state = 'finalized' " +
            "ORDER BY updated_at DESC",
          identityParameters,
        )
      : await dialect.migrationQuery<MigrationBackupEvidenceRow>(
          'SELECT backup_id AS "backupId", manifest_hash AS "manifestHash", ' +
            'source_identity AS "sourceIdentity", state, updated_at AS "finalizedAt" ' +
            'FROM "caplets_control"."cp_backup" WHERE logical_host_id = $1 AND store_id = $2 ' +
            "AND state = 'finalized' ORDER BY updated_at DESC",
          identityParameters,
        );
  const backup = backups.find(
    (candidate) =>
      candidate.sourceIdentity === `${deployment.logicalHostId}:${deployment.storeId}` &&
      /^[a-f0-9]{64}$/u.test(candidate.manifestHash) &&
      Number.isFinite(Date.parse(candidate.finalizedAt)) &&
      Date.parse(candidate.finalizedAt) >= Date.parse(current.appliedAt),
  );
  if (!backup) return undefined;
  const keys =
    dialect.backend === "sqlite"
      ? dialect.migrationQuery<MigrationKeyEvidenceRow>(
          'SELECT key_id AS "keyId", purpose, key_version AS "keyVersion", state ' +
            "FROM cp_key_inventory WHERE logical_host_id = ? AND store_id = ? " +
            "AND state != 'destroyed'",
          identityParameters,
        )
      : await dialect.migrationQuery<MigrationKeyEvidenceRow>(
          'SELECT key_id AS "keyId", purpose, key_version AS "keyVersion", state ' +
            'FROM "caplets_control"."cp_key_inventory" WHERE logical_host_id = $1 AND store_id = $2 ' +
            "AND state != 'destroyed'",
          identityParameters,
        );
  const secureFilesystem = await createProductionSecureFilesystemOptions();
  const provider = await loadFileV1KeyProvider({
    manifestPath: join(dirname(deployment.keyProviderManifest), `${profile}.json`),
    expectedLogicalHostId: deployment.logicalHostId,
    expectedStoreId: deployment.storeId,
    expectedProfile: profile,
    filesystem: secureFilesystem.filesystem,
  });
  const byVersion = new Map<number, typeof provider.manifest.compatibilityKeys>();
  for (const key of provider.manifest.compatibilityKeys) {
    const entries = byVersion.get(key.keyVersion) ?? [];
    byVersion.set(key.keyVersion, [...entries, key]);
  }
  const retainedKeyVersions = [...byVersion]
    .filter(([, expected]) =>
      expected.every((entry) =>
        keys.some(
          (row) =>
            row.keyId === entry.keyId &&
            row.purpose === entry.purpose &&
            Number(row.keyVersion) === entry.keyVersion &&
            row.state !== "destroyed",
        ),
      ),
    )
    .map(([version]) => version)
    .sort((left, right) => left - right);
  return {
    kind: "store-bound",
    logicalHostId: deployment.logicalHostId,
    storeId: deployment.storeId,
    backup: {
      backupId: backup.backupId,
      manifestHash: backup.manifestHash,
      sourceSchemaVersion,
      finalizedAt: backup.finalizedAt,
    },
    retainedKeyVersions,
  };
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
    oldNodesDrained: !postgres || oldNodesDrained,
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
