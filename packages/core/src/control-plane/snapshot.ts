import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute as isAbsolutePath, normalize as normalizePath } from "node:path";
import {
  MutableHostSettingSchema,
  composeRuntimeConfigLayers,
  runtimeFingerprintsForConfigLayers,
  type CapletsConfig,
  type ConfigSource,
  type ConfigWithSources,
  type ConfigVaultResolver,
  type MutableHostSetting,
  type RuntimeConfigInput,
  type RuntimeConfigLayerInput,
} from "../config";
import {
  createBootstrapFingerprintSnapshot,
  isDeclaredRuntimeLocalPathField,
  effectiveRuntimeFingerprintForConfig,
} from "../caplet-source/runtime-fingerprint";
import { CapletsError } from "../errors";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletAssetRow,
  CanonicalCapletBackendRow,
  CanonicalCapletReferenceRow,
  PortableJson,
} from "./caplets/model";
import type { ControlPlaneSnapshot, ControlPlaneStoreIdentity } from "./types";

export type ControlPlaneRuntimeActivation = Readonly<{
  currentFingerprint?: string | undefined;
  stagedNextFingerprint?: string | undefined;
}>;

export type ControlPlaneRuntimePrerequisites = {
  backend: "sqlite" | "postgres";
  identity: ControlPlaneStoreIdentity;
  storage: { status: "verified" | "unverified" };
  migration: { status: "current" | "blocked" };
  keys: { status: "verified" | "unverified" };
  canary: { status: "verified" | "unverified" };
  schema: { status: "current" | "blocked"; version: number };
  manifest: { status: "verified" | "unverified"; version: number };
  compatibility: {
    status: "compatible" | "incompatible";
    binaryVersion: string;
    schemaVersion: number;
    keyVersion: number;
    manifestVersion: number;
  };
  authority: {
    status: "active" | "inactive";
    authorityGeneration: number;
    securityEpoch: number;
  };
  activation: ControlPlaneRuntimeActivation;
};

export type ControlPlaneRuntimeHydration = Readonly<{
  snapshot: ControlPlaneSnapshot;
  prerequisites: ControlPlaneRuntimePrerequisites;
}>;

export type SqliteBootstrapAdoptionRequest = Readonly<{
  previousFingerprint?: string | undefined;
  nextFingerprint: string;
  expectedEffectiveRuntimeFingerprint: string;
  expectedAuthorityGeneration: number;
  expectedEffectiveGeneration: number;
  expectedSecurityEpoch: number;
}>;

export type RuntimeOwnershipLayer = Readonly<{
  owner: "sql" | "filesystem";
  source: ConfigSource;
  provenance?: Readonly<{
    id?: string | undefined;
    contentHash?: string | undefined;
  }>;
}>;

export type RuntimeCapletOwnership = Readonly<{
  id: string;
  owner: "sql" | "filesystem";
  source: ConfigSource;
  effective: boolean;
  runtimeStatus: "effective" | "shadowed" | "dormant";
  shadowChain: readonly RuntimeOwnershipLayer[];
  underlyingSql?: RuntimeOwnershipLayer | undefined;
}>;

export type RuntimeHostSettingOwnership = Readonly<{
  key: string;
  owner: "sql" | "filesystem";
  source: ConfigSource;
  effective: boolean;
  shadowChain: readonly RuntimeOwnershipLayer[];
  underlyingSql?: RuntimeOwnershipLayer | undefined;
}>;

export type ControlPlaneRuntimeSnapshot = Readonly<{
  config: CapletsConfig;
  configWithSources: ConfigWithSources;
  sqlSnapshot: ControlPlaneSnapshot;
  backend: "sqlite" | "postgres";
  identity: ControlPlaneStoreIdentity;
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
  bootstrapFingerprint: string;
  effectiveRuntimeFingerprint: string;
  caplets: Readonly<Record<string, RuntimeCapletOwnership>>;
  hostSettings: Readonly<Record<string, RuntimeHostSettingOwnership>>;
}>;

export type ComposeControlPlaneRuntimeSnapshotInput = Readonly<{
  hydration: ControlPlaneRuntimeHydration;
  filesystemLayers: readonly RuntimeConfigLayerInput[];
  resolvedRuntimeInputs: unknown;
  hiddenCommitments: readonly string[];
  providerVersions: Readonly<Record<string, string | number>>;
  adoptSqliteBootstrapFingerprint?:
    | ((request: SqliteBootstrapAdoptionRequest) => Promise<ControlPlaneRuntimeHydration>)
    | undefined;
  resolveSqlAssetPath?:
    | ((capletId: string, logicalPath: string, asset: CanonicalCapletAssetRow) => string)
    | undefined;
  vaultResolver?: ConfigVaultResolver | undefined;
}>;

export type ControlPlaneRuntimeSnapshotLoadContext = Readonly<{
  vaultResolver?: ConfigVaultResolver | undefined;
}>;

export type ControlPlaneRuntimeSnapshotLoader = Readonly<{
  initialize(
    context?: ControlPlaneRuntimeSnapshotLoadContext,
  ): Promise<ControlPlaneRuntimeSnapshot>;
  reload(context?: ControlPlaneRuntimeSnapshotLoadContext): Promise<ControlPlaneRuntimeSnapshot>;
  commit(snapshot: ControlPlaneRuntimeSnapshot): boolean;
  current(): ControlPlaneRuntimeSnapshot | undefined;
}>;

export type ControlPlaneRuntimeSnapshotLoaderOptions = Readonly<{
  hydrate(): Promise<ControlPlaneRuntimeHydration>;
  loadFilesystemLayers():
    | readonly RuntimeConfigLayerInput[]
    | Promise<readonly RuntimeConfigLayerInput[]>;
  resolvedRuntimeInputs(): unknown | Promise<unknown>;
  hiddenCommitments(): readonly string[] | Promise<readonly string[]>;
  providerVersions():
    | Readonly<Record<string, string | number>>
    | Promise<Readonly<Record<string, string | number>>>;
  adoptSqliteBootstrapFingerprint?: ComposeControlPlaneRuntimeSnapshotInput["adoptSqliteBootstrapFingerprint"];
  resolveSqlAssetPath?: ComposeControlPlaneRuntimeSnapshotInput["resolveSqlAssetPath"];
  vaultResolver?: ConfigVaultResolver | undefined;
}>;

export async function composeControlPlaneRuntimeSnapshot(
  input: ComposeControlPlaneRuntimeSnapshotInput,
): Promise<ControlPlaneRuntimeSnapshot> {
  const initialHydration = input.hydration;
  assertControlPlaneRuntimePrerequisites(initialHydration);
  const filesystemRuntimeFingerprints = validatedFilesystemRuntimeFingerprints(
    input.filesystemLayers,
    input.vaultResolver,
  );
  const bootstrapFingerprint = createBootstrapFingerprintSnapshot({
    filesystemInputs: [
      ...input.filesystemLayers.map((layer) => layer.input),
      { declaredInputFingerprints: filesystemRuntimeFingerprints },
    ],
    resolvedRuntimeInputs: input.resolvedRuntimeInputs,
    hiddenCommitments: input.hiddenCommitments,
    providerVersions: input.providerVersions,
  }).fingerprint;

  // The complete candidate is projected and parsed before SQLite is allowed to persist an
  // adopted fingerprint. After adoption only validated metadata is published.
  let sqlProjection = projectSqlRuntimeInput(initialHydration.snapshot, input.resolveSqlAssetPath);
  let sqlLayer: RuntimeConfigLayerInput = {
    input: sqlProjection.input,
    source: { kind: "sql", path: "" },
  };
  let configWithSources = composeRuntimeConfigLayers([sqlLayer, ...input.filesystemLayers], {
    vaultResolver: input.vaultResolver,
    quarantineUnavailableInputs: true,
  });
  let caplets = composeCapletOwnership(configWithSources, sqlProjection);
  let hostSettings = composeHostSettingOwnership(configWithSources, sqlProjection);
  let effectiveRuntimeFingerprint = validatedEffectiveRuntimeFingerprint(
    configWithSources,
    caplets,
    sqlProjection,
    filesystemRuntimeFingerprints,
  );
  const hydration = await resolveBootstrapActivation(
    initialHydration,
    bootstrapFingerprint,
    effectiveRuntimeFingerprint,
    input.adoptSqliteBootstrapFingerprint,
  );
  if (hydration !== initialHydration) {
    sqlProjection = projectSqlRuntimeInput(hydration.snapshot, input.resolveSqlAssetPath);
    sqlLayer = { input: sqlProjection.input, source: { kind: "sql", path: "" } };
    configWithSources = composeRuntimeConfigLayers([sqlLayer, ...input.filesystemLayers], {
      vaultResolver: input.vaultResolver,
      quarantineUnavailableInputs: true,
    });
    caplets = composeCapletOwnership(configWithSources, sqlProjection);
    hostSettings = composeHostSettingOwnership(configWithSources, sqlProjection);
    const adoptedEffectiveRuntimeFingerprint = validatedEffectiveRuntimeFingerprint(
      configWithSources,
      caplets,
      sqlProjection,
      filesystemRuntimeFingerprints,
    );
    if (adoptedEffectiveRuntimeFingerprint !== effectiveRuntimeFingerprint) {
      throw notReady("SQLite bootstrap fingerprint adoption changed effective runtime content");
    }
    effectiveRuntimeFingerprint = adoptedEffectiveRuntimeFingerprint;
  }

  const runtime: ControlPlaneRuntimeSnapshot = {
    config: configWithSources.config,
    configWithSources,
    sqlSnapshot: hydration.snapshot,
    backend: hydration.prerequisites.backend,
    identity: Object.freeze({ ...hydration.snapshot.identity }),
    authorityGeneration: hydration.snapshot.versions.authorityGeneration,
    effectiveGeneration: hydration.snapshot.versions.effectiveGeneration,
    securityEpoch: hydration.snapshot.versions.securityEpoch,
    bootstrapFingerprint,
    effectiveRuntimeFingerprint,
    caplets: Object.freeze(caplets),
    hostSettings: Object.freeze(hostSettings),
  };
  return Object.freeze(runtime);
}

export function createControlPlaneRuntimeSnapshotLoader(
  options: ControlPlaneRuntimeSnapshotLoaderOptions,
): ControlPlaneRuntimeSnapshotLoader {
  let current: ControlPlaneRuntimeSnapshot | undefined;
  let initializing: Promise<ControlPlaneRuntimeSnapshot> | undefined;
  let activeReload: Promise<ControlPlaneRuntimeSnapshot> | undefined;
  let pendingReload:
    | Readonly<{
        context: ControlPlaneRuntimeSnapshotLoadContext;
        sequence: number;
        promise: Promise<ControlPlaneRuntimeSnapshot>;
        resolve(snapshot: ControlPlaneRuntimeSnapshot): void;
        reject(error: unknown): void;
      }>
    | undefined;
  let issuedSequence = 0;
  let committedSequence = 0;
  const candidateSequences = new WeakMap<ControlPlaneRuntimeSnapshot, number>();

  const compose = async (
    sequence: number,
    context: ControlPlaneRuntimeSnapshotLoadContext = {},
  ): Promise<ControlPlaneRuntimeSnapshot> => {
    // Hydration/migration is deliberately awaited before filesystem evaluation. No partial
    // filesystem-only generation exists even transiently in the internal factory path.
    const hydration = await options.hydrate();
    const filesystemLayers = await options.loadFilesystemLayers();
    const [resolvedRuntimeInputs, hiddenCommitments, providerVersions] = await Promise.all([
      options.resolvedRuntimeInputs(),
      options.hiddenCommitments(),
      options.providerVersions(),
    ]);
    const snapshot = await composeControlPlaneRuntimeSnapshot({
      hydration,
      filesystemLayers,
      resolvedRuntimeInputs,
      hiddenCommitments,
      providerVersions,
      ...(options.adoptSqliteBootstrapFingerprint
        ? { adoptSqliteBootstrapFingerprint: options.adoptSqliteBootstrapFingerprint }
        : {}),
      ...(options.resolveSqlAssetPath ? { resolveSqlAssetPath: options.resolveSqlAssetPath } : {}),
      vaultResolver: runtimeVaultResolver(options.vaultResolver, context.vaultResolver),
    });
    if (
      current &&
      snapshot.backend === "sqlite" &&
      current.backend === snapshot.backend &&
      current.identity.logicalHostId === snapshot.identity.logicalHostId &&
      current.identity.storeId === snapshot.identity.storeId &&
      current.identity.operationNamespace === snapshot.identity.operationNamespace &&
      current.authorityGeneration === snapshot.authorityGeneration &&
      current.effectiveGeneration === snapshot.effectiveGeneration &&
      current.securityEpoch === snapshot.securityEpoch &&
      current.bootstrapFingerprint === snapshot.bootstrapFingerprint &&
      current.effectiveRuntimeFingerprint === snapshot.effectiveRuntimeFingerprint
    ) {
      return current;
    }
    candidateSequences.set(snapshot, sequence);
    return snapshot;
  };

  const commit = (snapshot: ControlPlaneRuntimeSnapshot): boolean => {
    let sequence = candidateSequences.get(snapshot);
    if (sequence === undefined) {
      issuedSequence += 1;
      sequence = issuedSequence;
    }
    if (sequence < committedSequence || !canCommitRuntimeSnapshot(current, snapshot)) return false;
    current = snapshot;
    committedSequence = sequence;
    return true;
  };

  const launchReload = (
    context: ControlPlaneRuntimeSnapshotLoadContext,
    sequence: number,
  ): Promise<ControlPlaneRuntimeSnapshot> => {
    const running = compose(sequence, context);
    activeReload = running;
    void running.then(
      () => {
        if (activeReload === running) activeReload = undefined;
        const queued = pendingReload;
        pendingReload = undefined;
        if (!queued) return;
        launchReload(queued.context, queued.sequence).then(queued.resolve, queued.reject);
      },
      () => {
        if (activeReload === running) activeReload = undefined;
        const queued = pendingReload;
        pendingReload = undefined;
        if (!queued) return;
        launchReload(queued.context, queued.sequence).then(queued.resolve, queued.reject);
      },
    );
    return running;
  };

  return Object.freeze({
    initialize(context = {}) {
      if (current) return Promise.resolve(current);
      initializing ??= compose(++issuedSequence, context).then((snapshot) => {
        if (!commit(snapshot)) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Control-plane runtime initialization was superseded",
          );
        }
        return snapshot;
      });
      return initializing.catch((error: unknown) => {
        initializing = undefined;
        throw error;
      });
    },
    reload(context = {}) {
      if (!current) {
        return Promise.reject(
          new CapletsError(
            "SERVER_UNAVAILABLE",
            "Control-plane runtime must initialize before reload",
          ),
        );
      }
      if (!activeReload) return launchReload(context, ++issuedSequence);
      if (pendingReload) {
        pendingReload = Object.freeze({
          ...pendingReload,
          context,
          sequence: ++issuedSequence,
        });
        return pendingReload.promise;
      }
      let resolve!: (snapshot: ControlPlaneRuntimeSnapshot) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ControlPlaneRuntimeSnapshot>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      pendingReload = Object.freeze({
        context,
        sequence: ++issuedSequence,
        promise,
        resolve,
        reject,
      });
      return promise;
    },
    commit,
    current() {
      return current;
    },
  });
}

function runtimeVaultResolver(
  sqlResolver: ConfigVaultResolver | undefined,
  filesystemResolver: ConfigVaultResolver | undefined,
): ConfigVaultResolver {
  return (reference) => {
    const resolver = reference.origin.kind === "sql" ? sqlResolver : filesystemResolver;
    return (
      resolver?.(reference) ?? {
        reason: "unavailable",
        referenceName: reference.referenceName,
        capletId: reference.capletId,
        origin: reference.origin,
      }
    );
  };
}

function canCommitRuntimeSnapshot(
  current: ControlPlaneRuntimeSnapshot | undefined,
  candidate: ControlPlaneRuntimeSnapshot,
): boolean {
  if (!current) return true;
  if (
    current.backend !== candidate.backend ||
    current.identity.logicalHostId !== candidate.identity.logicalHostId ||
    current.identity.storeId !== candidate.identity.storeId ||
    current.identity.operationNamespace !== candidate.identity.operationNamespace
  ) {
    return false;
  }
  if (candidate.securityEpoch < current.securityEpoch) return false;
  if (candidate.authorityGeneration > current.authorityGeneration) return true;
  if (candidate.authorityGeneration < current.authorityGeneration) return false;
  return candidate.effectiveGeneration >= current.effectiveGeneration;
}

export function assertControlPlaneRuntimePrerequisites(
  hydration: ControlPlaneRuntimeHydration,
): void {
  const { prerequisites, snapshot } = hydration;
  if (prerequisites.backend !== "sqlite" && prerequisites.backend !== "postgres") {
    throw notReady("Storage backend is unsupported");
  }
  assertIdentity(snapshot.identity, prerequisites.identity);
  if (prerequisites.storage.status !== "verified") {
    throw notReady("Storage identity is not verified");
  }
  if (prerequisites.migration.status !== "current") {
    throw notReady("Control-plane migration is not current");
  }
  if (prerequisites.keys.status !== "verified") {
    throw notReady("Key capabilities are not verified");
  }
  if (prerequisites.canary.status !== "verified") {
    throw notReady("Storage canary is not verified");
  }
  if (prerequisites.schema.status !== "current" || prerequisites.schema.version < 1) {
    throw notReady("Control-plane schema is not current");
  }
  if (prerequisites.manifest.status !== "verified" || prerequisites.manifest.version < 1) {
    throw notReady("Migration manifest is not verified");
  }
  const compatibility = prerequisites.compatibility;
  if (
    compatibility.status !== "compatible" ||
    !compatibility.binaryVersion ||
    compatibility.schemaVersion < 1 ||
    compatibility.keyVersion < 1 ||
    compatibility.manifestVersion < 1
  ) {
    throw notReady("Runtime compatibility is not verified");
  }
  const authority = prerequisites.authority;
  if (
    authority.status !== "active" ||
    authority.authorityGeneration !== snapshot.versions.authorityGeneration ||
    authority.securityEpoch !== snapshot.versions.securityEpoch
  ) {
    throw notReady("Control-plane authority is not active");
  }
  for (const fingerprint of [
    prerequisites.activation.currentFingerprint,
    prerequisites.activation.stagedNextFingerprint,
  ]) {
    if (fingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw notReady("Bootstrap activation fingerprint is invalid");
    }
  }
}

export type RuntimeMutationTargetResolution =
  | Readonly<{
      status: "allowed";
      owner: "sql";
      source: ConfigSource;
      effectiveChanged: boolean;
    }>
  | Readonly<{
      status: "rejected";
      owner: "filesystem";
      source: ConfigSource;
      reason: "filesystem-owned";
    }>
  | Readonly<{ status: "not-found" }>;

export function resolveControlPlaneCapletMutationTarget(
  snapshot: ControlPlaneRuntimeSnapshot,
  id: string,
  options: Readonly<{ underlyingSql?: boolean | undefined }> = {},
): RuntimeMutationTargetResolution {
  const row = snapshot.caplets[id];
  if (!row) return { status: "not-found" };
  if (options.underlyingSql) {
    const sql = row.owner === "sql" ? row.shadowChain.at(-1) : row.underlyingSql;
    return sql
      ? {
          status: "allowed",
          owner: "sql",
          source: sql.source,
          effectiveChanged: row.owner === "sql",
        }
      : { status: "not-found" };
  }
  return row.owner === "filesystem"
    ? { status: "rejected", owner: "filesystem", source: row.source, reason: "filesystem-owned" }
    : {
        status: "allowed",
        owner: "sql",
        source: row.source,
        effectiveChanged: true,
      };
}

export function resolveControlPlaneHostSettingMutationTarget(
  snapshot: ControlPlaneRuntimeSnapshot,
  key: string,
  options: Readonly<{ underlyingSql?: boolean | undefined }> = {},
): RuntimeMutationTargetResolution {
  const row = snapshot.hostSettings[key];
  if (!row) return { status: "not-found" };
  if (options.underlyingSql) {
    const sql = row.owner === "sql" ? row.shadowChain.at(-1) : row.underlyingSql;
    return sql
      ? {
          status: "allowed",
          owner: "sql",
          source: sql.source,
          effectiveChanged: row.owner === "sql",
        }
      : { status: "not-found" };
  }
  return row.owner === "filesystem"
    ? { status: "rejected", owner: "filesystem", source: row.source, reason: "filesystem-owned" }
    : { status: "allowed", owner: "sql", source: row.source, effectiveChanged: true };
}

type SqlRuntimeProjection = Readonly<{
  input: RuntimeConfigInput;
  capletProvenance: Readonly<Record<string, RuntimeOwnershipLayer["provenance"]>>;
  dormantCapletIds: ReadonlySet<string>;
  settingKeys: readonly string[];
  materializedAssetCommitments: ReadonlyMap<string, string>;
}>;

type CachedSqlCapletProjection = Readonly<{
  input: RuntimeConfigInput;
  projectedIds: readonly string[];
  provenance: RuntimeOwnershipLayer["provenance"];
}>;

const sqlCapletProjectionCache = new Map<string, CachedSqlCapletProjection>();
const MAX_CACHED_SQL_CAPLET_PROJECTIONS = 10_000;
const sqlCapletProvenanceCache = new Map<string, RuntimeOwnershipLayer["provenance"]>();
const validatedSqlAssetRows = new Set<string>();
const materializedSqlAssetValidationCache = new Map<
  string,
  Readonly<{ device: number; inode: number; size: number; mtimeMs: number; ctimeMs: number }>
>();
const MAX_CACHED_SQL_ASSET_VALIDATIONS = 50_000;
function validatedFilesystemRuntimeFingerprints(
  layers: readonly RuntimeConfigLayerInput[],
  vaultResolver: ConfigVaultResolver | undefined,
): readonly string[] {
  const fingerprints = runtimeFingerprintsForConfigLayers(layers, {
    vaultResolver,
    quarantineUnavailableInputs: true,
  });
  if (fingerprints.some((fingerprint) => !fingerprint.valid)) {
    throw notReady("Filesystem declared inputs are missing or unreadable");
  }
  return fingerprints.map((fingerprint) => fingerprint.artifactFingerprint);
}

function validatedEffectiveRuntimeFingerprint(
  composed: ConfigWithSources,
  caplets: Readonly<Record<string, RuntimeCapletOwnership>>,
  sql: SqlRuntimeProjection,
  filesystemRuntimeFingerprints: readonly string[],
): string {
  const canonicalConfig = configWithCanonicalSqlAssetCommitments(
    composed.config,
    caplets,
    sql.materializedAssetCommitments,
  );
  return createHash("sha256")
    .update("caplets:effective-runtime:fingerprint:v2\0")
    .update(
      JSON.stringify({
        config: effectiveRuntimeFingerprintForConfig(canonicalConfig),
        filesystemRuntimeFingerprints,
      }),
    )
    .digest("hex");
}

function configWithCanonicalSqlAssetCommitments(
  config: CapletsConfig,
  caplets: Readonly<Record<string, RuntimeCapletOwnership>>,
  commitments: ReadonlyMap<string, string>,
): CapletsConfig {
  if (commitments.size === 0) return config;
  const canonical = structuredClone(config) as unknown as Record<string, Record<string, unknown>>;
  for (const [id, ownership] of Object.entries(caplets)) {
    if (ownership.owner !== "sql" || !ownership.effective) continue;
    for (const backendKey of [
      "mcpServers",
      "openapiEndpoints",
      "googleDiscoveryApis",
      "graphqlEndpoints",
      "httpApis",
      "cliTools",
      "capletSets",
    ]) {
      const backend = canonical[backendKey]?.[id];
      if (backend !== undefined) {
        canonical[backendKey]![id] = replaceMaterializedAssetPaths(backend, commitments);
      }
    }
  }
  return canonical as unknown as CapletsConfig;
}

function replaceMaterializedAssetPaths(
  value: unknown,
  commitments: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return commitments.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceMaterializedAssetPaths(entry, commitments));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      replaceMaterializedAssetPaths(nested, commitments),
    ]),
  );
}

function projectSqlRuntimeInput(
  snapshot: ControlPlaneSnapshot,
  resolveSqlAssetPath: ComposeControlPlaneRuntimeSnapshotInput["resolveSqlAssetPath"],
): SqlRuntimeProjection {
  const input: RuntimeConfigInput = {};
  const capletProvenance: Record<string, RuntimeOwnershipLayer["provenance"]> = {};
  const dormantCapletIds = new Set<string>();
  const seenRuntimeIds = new Set<string>();
  const materializedAssetCommitments = new Map<string, string>();
  for (const entry of snapshot.caplets) {
    if (entry.aggregate.ownership !== "sql") {
      throw notReady(`Control-plane Caplet ${entry.aggregate.id} has invalid ownership`);
    }
    const dormant = entry.aggregate.activation === "setup-required";
    let projectedIds: readonly string[];
    let provenance: RuntimeOwnershipLayer["provenance"];
    const cacheKey = sqlCapletProjectionCacheKey(snapshot, entry.aggregate);
    if (!resolveSqlAssetPath) {
      let cached = sqlCapletProjectionCache.get(cacheKey);
      if (!cached) {
        const projectedInput: RuntimeConfigInput = {};
        projectedIds = projectSqlCaplet(
          projectedInput,
          entry.aggregate,
          cacheKey,
          entry.projection.backends,
          entry.projection.references,
          entry.projection.assets,
          undefined,
          materializedAssetCommitments,
          !dormant,
          new Set(),
        );
        provenance = sqlCapletProvenance(cacheKey, entry.aggregate);
        cached = Object.freeze({
          input: projectedInput,
          projectedIds: Object.freeze(projectedIds),
          provenance,
        });
        cacheSqlCapletProjection(cacheKey, cached);
      } else {
        projectedIds = cached.projectedIds;
        provenance = cached.provenance;
      }
      applyCachedSqlCapletProjection(input, cached, seenRuntimeIds);
    } else {
      projectedIds = projectSqlCaplet(
        input,
        entry.aggregate,
        cacheKey,
        entry.projection.backends,
        entry.projection.references,
        entry.projection.assets,
        resolveSqlAssetPath,
        materializedAssetCommitments,
        !dormant,
        seenRuntimeIds,
      );
      provenance = sqlCapletProvenance(cacheKey, entry.aggregate);
    }
    const ownershipIds = projectedIds.length > 0 ? projectedIds : [entry.aggregate.id];
    if (dormant) ownershipIds.forEach((id) => dormantCapletIds.add(id));
    for (const id of ownershipIds) capletProvenance[id] = provenance;
  }

  const settingKeys: string[] = [];
  for (const setting of snapshot.hostSettings) {
    if (setting.key === "native.daemon-url") continue;
    const parsed = MutableHostSettingSchema.parse({ key: setting.key, value: setting.value });
    settingKeys.push(parsed.key);
    applyMutableHostSetting(input, parsed);
  }
  const projection = Object.freeze({
    input,
    capletProvenance: Object.freeze(capletProvenance),
    dormantCapletIds,
    settingKeys: Object.freeze(settingKeys),
    materializedAssetCommitments,
  });
  return projection;
}

function sqlCapletProjectionCacheKey(
  snapshot: ControlPlaneSnapshot,
  aggregate: CanonicalCapletAggregate,
): string {
  return [
    snapshot.identity.logicalHostId,
    snapshot.identity.storeId,
    snapshot.identity.operationNamespace,
    aggregate.id,
    aggregate.aggregateVersion,
    aggregate.activation,
  ].join("\0");
}

function sqlCapletProvenance(
  cacheKey: string,
  aggregate: CanonicalCapletAggregate,
): RuntimeOwnershipLayer["provenance"] {
  const cached = sqlCapletProvenanceCache.get(cacheKey);
  if (cached) return cached;
  const provenance = Object.freeze({
    ...(aggregate.installationProvenanceId ? { id: aggregate.installationProvenanceId } : {}),
    contentHash: createHash("sha256").update(JSON.stringify(aggregate.portable)).digest("hex"),
  });
  if (sqlCapletProvenanceCache.size >= MAX_CACHED_SQL_CAPLET_PROJECTIONS) {
    const oldestKey = sqlCapletProvenanceCache.keys().next().value;
    if (oldestKey !== undefined) sqlCapletProvenanceCache.delete(oldestKey);
  }
  sqlCapletProvenanceCache.set(cacheKey, provenance);
  return provenance;
}

function cacheSqlCapletProjection(key: string, projection: CachedSqlCapletProjection): void {
  if (sqlCapletProjectionCache.size >= MAX_CACHED_SQL_CAPLET_PROJECTIONS) {
    const oldestKey = sqlCapletProjectionCache.keys().next().value;
    if (oldestKey !== undefined) sqlCapletProjectionCache.delete(oldestKey);
  }
  sqlCapletProjectionCache.set(key, projection);
}

function cacheSqlAssetValidation(cache: Set<string>, key: string): void {
  if (cache.size >= MAX_CACHED_SQL_ASSET_VALIDATIONS) {
    const oldestKey = cache.values().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.add(key);
}

function applyCachedSqlCapletProjection(
  input: RuntimeConfigInput,
  cached: CachedSqlCapletProjection,
  seenRuntimeIds: Set<string>,
): void {
  for (const id of cached.projectedIds) {
    if (seenRuntimeIds.has(id)) throw notReady(`SQL Caplet runtime identity ${id} is duplicated`);
    seenRuntimeIds.add(id);
  }
  for (const backendKey of [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
    "cliTools",
    "capletSets",
  ] as const) {
    const projected = cached.input[backendKey];
    if (!projected) continue;
    Object.assign((input[backendKey] ??= {}), projected);
  }
}

function projectSqlCaplet(
  input: RuntimeConfigInput,
  aggregate: CanonicalCapletAggregate,
  cacheKey: string,
  backends: readonly CanonicalCapletBackendRow[],
  references: readonly CanonicalCapletReferenceRow[],
  assets: readonly CanonicalCapletAssetRow[],
  resolveSqlAssetPath: ComposeControlPlaneRuntimeSnapshotInput["resolveSqlAssetPath"],
  materializedAssetCommitments: Map<string, string>,
  effective: boolean,
  seenRuntimeIds: Set<string>,
): string[] {
  const projectedIds: string[] = [];
  const assetsByPath = new Map<string, CanonicalCapletAssetRow>();
  for (const asset of assets) {
    if (assetsByPath.has(asset.path)) {
      throw notReady(`SQL Caplet ${aggregate.id} has a duplicate asset path`);
    }
    const validationKey = `${cacheKey}\0${asset.path}\0${asset.contentHash}`;
    if (!validatedSqlAssetRows.has(validationKey)) {
      if (createHash("sha256").update(asset.content).digest("hex") !== asset.contentHash) {
        throw notReady(`SQL Caplet ${aggregate.id} has an asset content hash mismatch`);
      }
      cacheSqlAssetValidation(validatedSqlAssetRows, validationKey);
    }
    assetsByPath.set(asset.path, asset);
  }
  const localReferencePaths = new Set<string>();
  for (const { reference } of references) {
    if (reference.type !== "local") continue;
    if (!assetsByPath.has(reference.path)) {
      throw notReady(`SQL Caplet ${aggregate.id} has a dangling local asset reference`);
    }
    localReferencePaths.add(reference.path);
  }
  const materializedAssetPaths = new Map<string, string>();
  for (const backend of backends) {
    const id = backend.childId ?? aggregate.id;
    if (seenRuntimeIds.has(id)) throw notReady(`SQL Caplet runtime identity ${id} is duplicated`);
    seenRuntimeIds.add(id);
    const common = portableCommonRuntimeFields(aggregate);
    const config = effective
      ? resolvePortableRuntimeReferences(
          backend.config,
          aggregate.id,
          localReferencePaths,
          assetsByPath,
          materializedAssetPaths,
          materializedAssetCommitments,
          resolveSqlAssetPath,
        )
      : backend.config;
    if (!isRecord(config)) throw notReady(`SQL Caplet ${id} backend config is invalid`);
    if (effective) {
      const backendKey = runtimeBackendKey(backend.kind);
      const target = (input[backendKey] ??= {});
      target[id] = {
        ...common,
        ...config,
        ...(aggregate.activation === "disabled" ? { disabled: true } : {}),
      };
    }
    projectedIds.push(id);
  }
  if (projectedIds.length === 0 && aggregate.activation !== "setup-required") {
    throw notReady(`SQL Caplet ${aggregate.id} has no runtime backend`);
  }
  return projectedIds;
}

function portableCommonRuntimeFields(aggregate: CanonicalCapletAggregate): Record<string, unknown> {
  const source = isRecord(aggregate.portable.frontmatter.source)
    ? aggregate.portable.frontmatter.source
    : {};
  const commonKeys: Record<string, true> = {
    tags: true,
    exposure: true,
    shadowing: true,
    setup: true,
    projectBinding: true,
    runtime: true,
  };
  return {
    name: aggregate.portable.name,
    description: aggregate.portable.description,
    ...Object.fromEntries(Object.entries(source).filter(([key]) => commonKeys[key])),
  };
}

function runtimeBackendKey(
  kind: CanonicalCapletBackendRow["kind"],
):
  | "mcpServers"
  | "openapiEndpoints"
  | "googleDiscoveryApis"
  | "graphqlEndpoints"
  | "httpApis"
  | "cliTools"
  | "capletSets" {
  const keyByKind = {
    mcp: "mcpServers",
    openapi: "openapiEndpoints",
    googleDiscovery: "googleDiscoveryApis",
    graphql: "graphqlEndpoints",
    http: "httpApis",
    cli: "cliTools",
    caplets: "capletSets",
  } as const;
  return keyByKind[kind];
}

function resolvePortableRuntimeReferences(
  value: PortableJson,
  capletId: string,
  localReferencePaths: ReadonlySet<string>,
  assetsByPath: ReadonlyMap<string, CanonicalCapletAssetRow>,
  materializedAssetPaths: Map<string, string>,
  materializedAssetCommitments: Map<string, string>,
  resolveSqlAssetPath: ComposeControlPlaneRuntimeSnapshotInput["resolveSqlAssetPath"],
  path: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    const field = path.at(-1);
    if (field === "cwd") {
      throw notReady(`SQL Caplet ${capletId} cannot use a host working directory`);
    }
    if (localReferencePaths.has(value)) {
      return materializeSqlAssetPath(
        capletId,
        value,
        assetsByPath,
        materializedAssetPaths,
        materializedAssetCommitments,
        resolveSqlAssetPath,
      );
    }
    if (isDeclaredRuntimeLocalPathField(field ?? "")) {
      throw notReady(`SQL Caplet ${capletId} has an unresolved local asset reference`);
    }
    if (field === "command" && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) {
      throw notReady(`SQL Caplet ${capletId} has a non-portable executable command`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((nested, index) =>
      resolvePortableRuntimeReferences(
        nested,
        capletId,
        localReferencePaths,
        assetsByPath,
        materializedAssetPaths,
        materializedAssetCommitments,
        resolveSqlAssetPath,
        [...path, String(index)],
      ),
    );
  }
  if (!isRecord(value)) return value;
  if (value.type === "local" && typeof value.path === "string") {
    if (!localReferencePaths.has(value.path)) {
      throw notReady(`SQL Caplet ${capletId} has an unresolved local asset reference`);
    }
    return materializeSqlAssetPath(
      capletId,
      value.path,
      assetsByPath,
      materializedAssetPaths,
      materializedAssetCommitments,
      resolveSqlAssetPath,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      resolvePortableRuntimeReferences(
        nested as PortableJson,
        capletId,
        localReferencePaths,
        assetsByPath,
        materializedAssetPaths,
        materializedAssetCommitments,
        resolveSqlAssetPath,
        [...path, key],
      ),
    ]),
  );
}

function materializeSqlAssetPath(
  capletId: string,
  logicalPath: string,
  assetsByPath: ReadonlyMap<string, CanonicalCapletAssetRow>,
  materializedAssetPaths: Map<string, string>,
  materializedAssetCommitments: Map<string, string>,
  resolveSqlAssetPath: ComposeControlPlaneRuntimeSnapshotInput["resolveSqlAssetPath"],
): string {
  const materialized = materializedAssetPaths.get(logicalPath);
  if (materialized) return materialized;
  if (
    logicalPath.startsWith("/") ||
    logicalPath.startsWith("\\") ||
    logicalPath.split(/[\\/]/u).includes("..")
  ) {
    throw notReady(`SQL Caplet ${capletId} has an unsafe local asset reference`);
  }
  if (!resolveSqlAssetPath) {
    throw notReady(`SQL Caplet ${capletId} requires asset materialization before exposure`);
  }
  const asset = assetsByPath.get(logicalPath);
  if (!asset) throw notReady(`SQL Caplet ${capletId} has a dangling local asset reference`);
  const resolved = resolveSqlAssetPath(capletId, logicalPath, asset);
  if (!isAbsolutePath(resolved) || normalizePath(resolved) !== resolved) {
    throw notReady(`SQL Caplet ${capletId} asset materialization returned an unsafe path`);
  }
  let metadata: {
    device: number;
    inode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
  try {
    const stats = statSync(resolved);
    metadata = {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    };
  } catch {
    throw notReady(`SQL Caplet ${capletId} asset materialization is unreadable`);
  }
  if (metadata.size !== asset.content.byteLength) {
    throw notReady(`SQL Caplet ${capletId} asset materialization size does not match`);
  }
  const validationKey = `${resolved}\0${asset.contentHash}`;
  const cachedValidation = materializedSqlAssetValidationCache.get(validationKey);
  if (
    !cachedValidation ||
    cachedValidation.device !== metadata.device ||
    cachedValidation.inode !== metadata.inode ||
    cachedValidation.size !== metadata.size ||
    cachedValidation.mtimeMs !== metadata.mtimeMs ||
    cachedValidation.ctimeMs !== metadata.ctimeMs
  ) {
    let materializedHash: string;
    try {
      materializedHash = createHash("sha256").update(readFileSync(resolved)).digest("hex");
    } catch {
      throw notReady(`SQL Caplet ${capletId} asset materialization is unreadable`);
    }
    if (materializedHash !== asset.contentHash) {
      throw notReady(`SQL Caplet ${capletId} asset materialization hash does not match`);
    }
    if (materializedSqlAssetValidationCache.size >= MAX_CACHED_SQL_ASSET_VALIDATIONS) {
      const oldestKey = materializedSqlAssetValidationCache.keys().next().value;
      if (oldestKey !== undefined) materializedSqlAssetValidationCache.delete(oldestKey);
    }
    materializedSqlAssetValidationCache.set(validationKey, Object.freeze(metadata));
  }
  const commitment = `sql-asset:${asset.contentHash}:${logicalPath}`;
  const existingCommitment = materializedAssetCommitments.get(resolved);
  if (existingCommitment && existingCommitment !== commitment) {
    throw notReady(`SQL Caplet ${capletId} materialized conflicting assets to one path`);
  }
  materializedAssetCommitments.set(resolved, commitment);
  materializedAssetPaths.set(logicalPath, resolved);
  return resolved;
}

function applyMutableHostSetting(input: RuntimeConfigInput, setting: MutableHostSetting): void {
  if (setting.key === "telemetry") {
    input.telemetry = setting.value;
    return;
  }
  if (setting.key === "namespaceAliases") {
    input.namespaceAliases = setting.value;
    return;
  }
  const leaf = setting.key.slice("options.".length);
  if (leaf === "defaultSearchLimit" || leaf === "maxSearchLimit") {
    input[leaf] = setting.value;
    return;
  }
  if (leaf.startsWith("completion.")) {
    const completion = isRecord(input.completion) ? input.completion : {};
    completion[leaf.slice("completion.".length)] = setting.value;
    input.completion = completion;
    return;
  }
  const options = isRecord(input.options) ? input.options : {};
  options[leaf] = setting.value;
  input.options = options;
}

function composeCapletOwnership(
  composed: ConfigWithSources,
  sql: SqlRuntimeProjection,
): Record<string, RuntimeCapletOwnership> {
  const rows: Record<string, RuntimeCapletOwnership> = {};
  const ids = new Set([...Object.keys(composed.sources), ...Object.keys(sql.capletProvenance)]);
  for (const id of ids) {
    const effectiveSource = composed.sources[id];
    const sources = [
      ...(composed.shadows[id] ?? []),
      ...(effectiveSource ? [effectiveSource] : []),
    ];
    const hasSqlSource = sources.some((source) => source.kind === "sql");
    const shadowChain = [
      ...(!hasSqlSource && sql.capletProvenance[id]
        ? [ownershipLayer({ kind: "sql", path: "" }, sql.capletProvenance[id])]
        : []),
      ...sources.map((source) => ownershipLayer(source, sql.capletProvenance[id])),
    ];
    const sqlLayer = shadowChain.find((layer) => layer.owner === "sql");
    if (!effectiveSource && sqlLayer) {
      rows[id] = {
        id,
        owner: "sql",
        source: sqlLayer.source,
        effective: false,
        runtimeStatus: sql.dormantCapletIds.has(id) ? "dormant" : "shadowed",
        shadowChain,
        underlyingSql: sqlLayer,
      };
      continue;
    }
    if (!effectiveSource) continue;
    const owner = ownerForSource(effectiveSource);
    rows[id] = {
      id,
      owner,
      source: effectiveSource,
      effective: owner === "sql",
      runtimeStatus: owner === "sql" && sql.dormantCapletIds.has(id) ? "dormant" : "effective",
      shadowChain,
      ...(sqlLayer ? { underlyingSql: sqlLayer } : {}),
    };
  }
  return rows;
}

function composeHostSettingOwnership(
  composed: ConfigWithSources,
  sql: SqlRuntimeProjection,
): Record<string, RuntimeHostSettingOwnership> {
  const rows: Record<string, RuntimeHostSettingOwnership> = {};
  const settingSources = composed.settingSources ?? {};
  const settingShadows = composed.settingShadows ?? {};
  const keys = new Set([...Object.keys(settingSources), ...sql.settingKeys]);
  for (const key of keys) {
    const effectiveSource = settingSources[key];
    const sources = [...(settingShadows[key] ?? []), ...(effectiveSource ? [effectiveSource] : [])];
    const shadowChain = sources.map((source) => ownershipLayer(source));
    const sqlLayer = shadowChain.find((layer) => layer.owner === "sql");
    if (!effectiveSource && sqlLayer) {
      rows[key] = {
        key,
        owner: "sql",
        source: sqlLayer.source,
        effective: false,
        shadowChain,
        underlyingSql: sqlLayer,
      };
      continue;
    }
    if (!effectiveSource) continue;
    const owner = ownerForSource(effectiveSource);
    rows[key] = {
      key,
      owner,
      source: effectiveSource,
      effective: owner === "sql",
      shadowChain,
      ...(sqlLayer ? { underlyingSql: sqlLayer } : {}),
    };
  }
  return rows;
}

function ownershipLayer(
  source: ConfigSource,
  provenance?: RuntimeOwnershipLayer["provenance"],
): RuntimeOwnershipLayer {
  return Object.freeze({
    owner: ownerForSource(source),
    source: Object.freeze({ ...source }),
    ...(source.kind === "sql" && provenance ? { provenance } : {}),
  });
}

function ownerForSource(source: ConfigSource): "sql" | "filesystem" {
  return source.kind === "sql" ? "sql" : "filesystem";
}

async function resolveBootstrapActivation(
  hydration: ControlPlaneRuntimeHydration,
  candidateFingerprint: string,
  expectedEffectiveRuntimeFingerprint: string,
  adoptSqlite: ComposeControlPlaneRuntimeSnapshotInput["adoptSqliteBootstrapFingerprint"],
): Promise<ControlPlaneRuntimeHydration> {
  const current = hydration.prerequisites.activation.currentFingerprint;
  if (current === candidateFingerprint) return hydration;
  if (current === undefined && hydration.prerequisites.backend === "postgres") return hydration;
  if (hydration.prerequisites.backend === "postgres") {
    if (hydration.prerequisites.activation.stagedNextFingerprint === candidateFingerprint) {
      throw notReady("Staged Postgres bootstrap fingerprint is not ready until cluster activation");
    }
    throw notReady("Postgres bootstrap fingerprint does not match current or staged activation");
  }
  if (!adoptSqlite) {
    throw notReady("SQLite bootstrap fingerprint changed without an atomic adoption capability");
  }
  const adopted = await adoptSqlite({
    ...(current === undefined ? {} : { previousFingerprint: current }),
    nextFingerprint: candidateFingerprint,
    expectedEffectiveRuntimeFingerprint,
    expectedAuthorityGeneration: hydration.snapshot.versions.authorityGeneration,
    expectedEffectiveGeneration: hydration.snapshot.versions.effectiveGeneration,
    expectedSecurityEpoch: hydration.snapshot.versions.securityEpoch,
  });
  assertControlPlaneRuntimePrerequisites(adopted);
  if (adopted.prerequisites.backend !== "sqlite") {
    throw notReady("SQLite bootstrap fingerprint adoption changed the storage backend");
  }
  assertIdentity(hydration.snapshot.identity, adopted.snapshot.identity);
  const authorityAdvanced =
    current === undefined
      ? adopted.snapshot.versions.authorityGeneration >=
        hydration.snapshot.versions.authorityGeneration
      : adopted.snapshot.versions.authorityGeneration >
        hydration.snapshot.versions.authorityGeneration;
  if (
    adopted.prerequisites.activation.currentFingerprint !== candidateFingerprint ||
    !authorityAdvanced ||
    adopted.snapshot.versions.effectiveGeneration <
      hydration.snapshot.versions.effectiveGeneration ||
    adopted.snapshot.versions.securityEpoch < hydration.snapshot.versions.securityEpoch
  ) {
    throw notReady("SQLite bootstrap fingerprint adoption did not publish a fresh authority");
  }
  return adopted;
}

function assertIdentity(left: ControlPlaneStoreIdentity, right: ControlPlaneStoreIdentity): void {
  if (
    left.logicalHostId !== right.logicalHostId ||
    left.storeId !== right.storeId ||
    left.operationNamespace !== right.operationNamespace
  ) {
    throw notReady("Control-plane logical host, store, or operation namespace does not match");
  }
}

function notReady(message: string): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
