import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  defaultStorageStateDir,
  type DeploymentSecretReference,
  type PostgresProcessRole,
  type PostgresStorageConfig,
  type ServeStorageConfig,
} from "../config";
import {
  readAuthorizedLocalAuthorityDescriptor,
  transitionLocalAuthorityDescriptor,
  type LocalAuthorityDescriptor,
  type LocalAuthorityDescriptorFile,
  type LocalAuthorityDescriptorPort,
  type LocalAuthorityOwner,
} from "../current-host/authority";
import { CapletsError } from "../errors";
import {
  createArtifactProviderIdentity,
  type ArtifactProviderIdentity,
} from "./artifacts/provider";
import {
  bootstrapSqliteFileV1,
  fileV1CompatibilityCommitment,
  fileV1VersionFloors,
  loadFileV1KeyProvider,
  type FileV1VersionFloors,
} from "./key-provider/file-v1";
import { FILE_V1_RUNTIME_PURPOSES } from "./key-provider/manifest";
import {
  assertSecureStateDirectory,
  createOrOpenSecureStateRoot,
  ensureSecureStateDirectory,
  inspectSecureRegularFile,
  readBoundedSecureFile,
  readBoundedSecureFileWithMetadata,
  replaceSecureFileAtomically,
  type SecureFileMetadata,
  type SecureFilesystemOptions,
  type SecureStateRoot,
  withSecureStateDirectory,
  writeSecureFileExclusive,
  writeSecureJsonExclusive,
  withSecureMutableRegularFile,
} from "./secure-state";

const require = createRequire(import.meta.url);

const AUTHORITY_FILE = "authority.json";
const STORAGE_BINDING_FILE = "storage-binding.json";
const OPERATION_NAMESPACE_PATTERN = /^operations_[0-9A-HJKMNP-TV-Z]{26}$/u;

export type PostgresVerificationRequest = {
  connectionString: string;
  tls: { mode: "verify-full"; serverName: string; ca?: string | undefined };
  role: string;
  roleKind: "runtime" | "migrator" | "maintenance";
};

export type PostgresVerificationResult = {
  logicalHostId: string;
  storeId: string;
  tlsPeerServerName: string;
  databaseRole: string;
  canSetRole: boolean;
  inheritedRoles: string[];
  privileges: {
    superuser: boolean;
    createDatabase: boolean;
    createRole: boolean;
    replication: boolean;
    bypassRowLevelSecurity: boolean;
  };
  operationNamespace?: string | undefined;
  databaseIdentity: string;
};

export type S3CanaryVerificationRequest = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  identity: ArtifactProviderIdentity;
  expectedCanary: string;
  createIfMissing: boolean;
};

export type S3CanaryVerificationResult = {
  identity: ArtifactProviderIdentity;
  matches: boolean;
};

export type SqliteVerificationRequest = {
  path: string;
  identity: Pick<SecureFileMetadata, "device" | "inode" | "revision">;
};

export type KeyRotationAuthorizationRequest = {
  backend: "sqlite" | "postgres";
  logicalHostId: string;
  storeId: string;
  currentGeneration: number;
  candidateGeneration: number;
  currentKeyCommitment: string;
  candidateKeyCommitment: string;
  currentVersionFloors: FileV1VersionFloors;
  candidateVersionFloors: FileV1VersionFloors;
};

export type ResolveStorageDeploymentOptions = {
  defaultStateRoot?: string | undefined;
  expectedOwner?: LocalAuthorityOwner | undefined;
  filesystem?: SecureFilesystemOptions | undefined;
  resolveSecret?: ((reference: DeploymentSecretReference) => Promise<string>) | undefined;
  verifySqliteFile?: ((request: SqliteVerificationRequest) => Promise<void>) | undefined;
  authorizeKeyRotation?:
    | ((request: KeyRotationAuthorizationRequest) => Promise<boolean>)
    | undefined;
  verifyPostgres?:
    | ((request: PostgresVerificationRequest) => Promise<PostgresVerificationResult>)
    | undefined;
  verifyS3Canary?:
    | ((request: S3CanaryVerificationRequest) => Promise<S3CanaryVerificationResult>)
    | undefined;
};

export type ResolvedSqliteStorage = {
  backend: "sqlite";
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  stateRoot: string;
  databasePath: string;
  keyProviderManifest: string;
  artifacts: { kind: "filesystem"; root: string };
};

export type ResolvedPostgresStorage = {
  backend: "postgres";
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  stateRoot: string;
  keyProviderManifest: string;
  artifacts: { kind: "s3"; identity: ArtifactProviderIdentity };
};

export type ResolvedStorageDeployment = ResolvedSqliteStorage | ResolvedPostgresStorage;

type StorageBinding = {
  version: 1;
  backend: "sqlite" | "postgres";
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  databaseIdentity: string;
  artifactIdentity: string;
  artifactCanary: string;
  keyProviderGeneration: number;
  keyProviderCommitment: string;
  keyVersionFloors: FileV1VersionFloors;
};
type LoadedStorageBinding = {
  value: StorageBinding;
  revision: string;
};

type StorageCompatibility = {
  keyProvider: Buffer;
  keyProviderGeneration: number;
  keyVersionFloors: FileV1VersionFloors;
  databaseIdentity: string;
  artifactIdentity: string;
  artifactCanary: string;
};

const storageCompatibility = new WeakMap<ResolvedStorageDeployment, StorageCompatibility>();

export type OfflineTransferStorageRole = "source" | "destination";

/**
 * Dedicated offline transfer resolver. Callers must present an existing SQLite authority as the
 * source and an isolated Postgres descriptor as the destination; the serving runtime never calls
 * this entry point.
 */
export async function resolveOfflineTransferStorageDeployment(
  storage: ServeStorageConfig | undefined,
  role: OfflineTransferStorageRole,
  options: ResolveStorageDeploymentOptions = {},
): Promise<ResolvedStorageDeployment> {
  if (
    (role === "source" && storage?.kind === "postgres") ||
    (role === "destination" && storage?.kind !== "postgres")
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      role === "source"
        ? "Offline SQL transfer source must resolve to SQLite."
        : "Offline SQL transfer destination must resolve to Postgres.",
    );
  }
  const deployment = await resolveStorageDeploymentInternal(storage, options);
  if (
    (role === "source" && deployment.backend !== "sqlite") ||
    (role === "destination" && deployment.backend !== "postgres")
  ) {
    throw new CapletsError("CONFIG_INVALID", "Offline SQL transfer storage role is invalid.");
  }
  return deployment;
}

export async function resolveStorageDeployment(
  storage: ServeStorageConfig | undefined,
  options: ResolveStorageDeploymentOptions = {},
): Promise<ResolvedStorageDeployment> {
  return resolveStorageDeploymentInternal(storage, options);
}

async function resolveStorageDeploymentInternal(
  storage: ServeStorageConfig | undefined,
  options: ResolveStorageDeploymentOptions,
): Promise<ResolvedStorageDeployment> {
  const expectedOwner = options.expectedOwner ?? currentOwner();
  const stateRoot = resolve(
    storage?.stateRoot ?? options.defaultStateRoot ?? defaultStorageStateDir(),
  );
  const filesystem: SecureFilesystemOptions = {
    ...options.filesystem,
    ...(expectedOwner.kind === "posix"
      ? { expectedUid: expectedOwner.uid }
      : { expectedServiceSid: expectedOwner.sid }),
  };
  const secureRoot = await createOrOpenSecureStateRoot(stateRoot, filesystem);
  const authorityPort = new SecureAuthorityDescriptorPort(
    join(stateRoot, AUTHORITY_FILE),
    expectedOwner,
    filesystem,
  );
  let authority = await readAuthorizedLocalAuthorityDescriptor(authorityPort, expectedOwner);
  if (!authority) {
    if (!secureRoot.fresh || (await readdir(stateRoot)).length !== 0) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Storage authority descriptor is absent from non-fresh or partial state.",
      );
    }
    authority = {
      version: 1,
      state: "unbound",
      logicalHostId:
        storage?.kind === "postgres" ? storage.logicalHostId : generateCrockfordIdentifier("host"),
      owner: expectedOwner,
      authorityGeneration: 0,
      authorityToken: generateCrockfordIdentifier("authority"),
    };
    await writeSecureJsonExclusive(join(stateRoot, AUTHORITY_FILE), authority, filesystem);
    authority = await readAuthorizedLocalAuthorityDescriptor(authorityPort, expectedOwner);
    if (!authority) throw new CapletsError("AUTH_FAILED", "Storage authority bootstrap failed.");
  }

  if (!secureRoot.fresh && authority.state === "unbound") {
    throw new CapletsError(
      "AUTH_FAILED",
      "Storage authority is partially initialized and requires recovery.",
    );
  }

  if (storage?.kind === "postgres") {
    return resolvePostgresStorage(
      storage,
      options,
      secureRoot,
      authorityPort,
      authority,
      filesystem,
    );
  }
  return resolveSqliteStorage(storage, options, secureRoot, authorityPort, authority, filesystem);
}

export function assertStorageBootstrapCompatible(
  left: ResolvedStorageDeployment,
  right: ResolvedStorageDeployment,
): void {
  const identityMatches =
    left.backend === right.backend &&
    left.logicalHostId === right.logicalHostId &&
    left.storeId === right.storeId &&
    left.operationNamespace === right.operationNamespace;
  const leftCompatibility = storageCompatibility.get(left);
  const rightCompatibility = storageCompatibility.get(right);
  const compatibilityMatches =
    leftCompatibility !== undefined &&
    rightCompatibility !== undefined &&
    leftCompatibility.databaseIdentity === rightCompatibility.databaseIdentity &&
    leftCompatibility.artifactIdentity === rightCompatibility.artifactIdentity &&
    leftCompatibility.keyProvider.byteLength === rightCompatibility.keyProvider.byteLength &&
    timingSafeEqual(leftCompatibility.keyProvider, rightCompatibility.keyProvider);
  if (!identityMatches || !compatibilityMatches) {
    throw new CapletsError("AUTH_FAILED", "Storage bootstrap compatibility verification failed.");
  }
}

export function storageArtifactProviderBinding(
  storage: ResolvedStorageDeployment,
): Readonly<{ identityId: string; expectedCanary: string }> {
  const compatibility = storageCompatibility.get(storage);
  if (!compatibility) {
    throw new CapletsError("AUTH_FAILED", "Storage artifact compatibility is unavailable.");
  }
  return {
    identityId: compatibility.artifactIdentity,
    expectedCanary: compatibility.artifactCanary,
  };
}

/**
 * Returns only a domain-separated compatibility commitment. Resolved credentials never
 * participate, so two verified credentials for the same store remain bootstrap-compatible.
 */
export function storageBootstrapFingerprintCommitment(storage: ResolvedStorageDeployment): string {
  const compatibility = storageCompatibility.get(storage);
  if (!compatibility) {
    throw new CapletsError("AUTH_FAILED", "Storage bootstrap compatibility is unavailable.");
  }
  return createHash("sha256")
    .update("caplets.storage-bootstrap-compatibility.v1\0")
    .update(
      JSON.stringify({
        backend: storage.backend,
        logicalHostId: storage.logicalHostId,
        storeId: storage.storeId,
        operationNamespace: storage.operationNamespace,
        databaseIdentity: compatibility.databaseIdentity,
        artifactIdentity: compatibility.artifactIdentity,
        keyProviderCommitment: compatibility.keyProvider.toString("hex"),
        keyProviderGeneration: compatibility.keyProviderGeneration,
        keyVersionFloors: compatibility.keyVersionFloors,
      }),
    )
    .digest("hex");
}

async function resolveSqliteStorage(
  storage: Extract<ServeStorageConfig, { kind: "sqlite" }> | undefined,
  options: ResolveStorageDeploymentOptions,
  secureRoot: SecureStateRoot,
  authorityPort: LocalAuthorityDescriptorPort,
  authority: LocalAuthorityDescriptor,
  filesystem: SecureFilesystemOptions,
): Promise<ResolvedSqliteStorage> {
  const stateRoot = secureRoot.path;
  const databasePath = resolve(storage?.databasePath ?? join(stateRoot, "control-plane.sqlite"));
  const artifactsRoot = resolve(storage?.artifacts?.root ?? join(stateRoot, "artifacts"));
  assertWithinRoot(stateRoot, databasePath, "SQLite database");
  assertWithinRoot(stateRoot, artifactsRoot, "SQLite artifact");
  let databaseIdentity: string;
  let artifactIdentity: string;

  let storeId: string;
  let operationNamespace: string;
  let keyProviderManifest: string;
  let keyProviderCommitment: Buffer;
  let keyProviderGeneration: number;
  let keyVersionFloors: FileV1VersionFloors;
  let existingBinding: LoadedStorageBinding | undefined;
  if (authority.state === "bound") {
    existingBinding = await readStorageBinding(stateRoot, filesystem);
    assertStorageBinding(existingBinding.value, "sqlite", authority);
    storeId = authority.storeId;
    operationNamespace = authority.operationNamespace;
    keyProviderManifest = resolve(
      storage?.keyProviderManifest ?? join(stateRoot, "key-provider", "manifests", "online.json"),
    );
    const keyProvider = await loadFileV1KeyProvider({
      manifestPath: keyProviderManifest,
      expectedLogicalHostId: authority.logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: "online",
      minimumGeneration: existingBinding.value.keyProviderGeneration,
      filesystem,
    });
    keyProviderGeneration = keyProvider.manifest.generation;
    keyProviderCommitment = fileV1CompatibilityCommitment(keyProvider);
    keyVersionFloors = fileV1VersionFloors(keyProvider);
  } else {
    if (!secureRoot.fresh) {
      throw new CapletsError(
        "AUTH_FAILED",
        "SQLite storage authority is not safely bootstrap-able.",
      );
    }
    if (storage?.keyProviderManifest !== undefined) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Fresh SQLite storage creates its complete local key profile atomically.",
      );
    }
    storeId = generateCrockfordIdentifier("store");
    operationNamespace = generateCrockfordIdentifier("operations");
    const bootstrap = await bootstrapSqliteFileV1({
      root: stateRoot,
      logicalHostId: authority.logicalHostId,
      storeId,
      secureRoot,
      filesystem,
    });
    keyProviderManifest = bootstrap.profileManifestPaths.online;
    const keyProvider = await loadFileV1KeyProvider({
      manifestPath: keyProviderManifest,
      expectedLogicalHostId: authority.logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: "online",
      filesystem,
    });
    keyProviderGeneration = keyProvider.manifest.generation;
    keyProviderCommitment = fileV1CompatibilityCommitment(keyProvider);
    keyVersionFloors = fileV1VersionFloors(keyProvider);
  }
  const keyProviderCommitmentHex = keyProviderCommitment.toString("hex");

  await authorizeKeyRotationIfNeeded(
    "sqlite",
    existingBinding?.value,
    keyProviderGeneration,
    keyVersionFloors,
    keyProviderCommitmentHex,
    options,
  );

  const artifactCanary = existingBinding?.value.artifactCanary ?? randomBytes(32).toString("hex");
  const artifact = await resolveFilesystemArtifactCanary(
    artifactsRoot,
    authority.logicalHostId,
    storeId,
    artifactCanary,
    existingBinding === undefined,
    filesystem,
  );
  await verifySqliteDatabase(
    databasePath,
    authority.logicalHostId,
    storeId,
    existingBinding === undefined,
    filesystem,
    options,
  );
  databaseIdentity = deploymentCommitment(
    "sqlite-database",
    JSON.stringify([authority.logicalHostId, storeId]),
  );
  artifactIdentity = artifact.identity;
  if (existingBinding) {
    assertStorageResourceBinding(existingBinding.value, {
      databaseIdentity,
      artifactIdentity,
      keyProviderGeneration,
      keyProviderCommitment: keyProviderCommitmentHex,
      keyVersionFloors,
    });
  }
  if (existingBinding && keyProviderGeneration > existingBinding.value.keyProviderGeneration) {
    await advanceStorageBinding(
      stateRoot,
      existingBinding,
      {
        ...existingBinding.value,
        keyProviderGeneration,
        keyProviderCommitment: keyProviderCommitmentHex,
        keyVersionFloors,
      },
      filesystem,
    );
  }

  if (authority.state === "unbound") {
    const binding: StorageBinding = {
      version: 1,
      backend: "sqlite",
      logicalHostId: authority.logicalHostId,
      storeId,
      operationNamespace,
      databaseIdentity,
      artifactIdentity,
      artifactCanary,
      keyProviderGeneration,
      keyProviderCommitment: keyProviderCommitmentHex,
      keyVersionFloors,
    };
    await writeSecureJsonExclusive(join(stateRoot, STORAGE_BINDING_FILE), binding, filesystem);
    const next: LocalAuthorityDescriptor = {
      ...authority,
      state: "bound",
      storeId,
      operationNamespace,
    };
    if (
      !(await transitionLocalAuthorityDescriptor(
        authorityPort,
        authority.owner,
        authority,
        next,
        "bind",
      ))
    ) {
      throw new CapletsError("AUTH_FAILED", "Concurrent storage authority binding was rejected.");
    }
  }

  const resolved: ResolvedSqliteStorage = {
    backend: "sqlite",
    logicalHostId: authority.logicalHostId,
    storeId,
    operationNamespace,
    stateRoot,
    databasePath,
    keyProviderManifest,
    artifacts: { kind: "filesystem", root: artifactsRoot },
  };
  storageCompatibility.set(resolved, {
    keyProvider: keyProviderCommitment,
    keyProviderGeneration,
    keyVersionFloors,
    databaseIdentity,
    artifactIdentity,
    artifactCanary,
  });
  return resolved;
}

async function resolvePostgresStorage(
  storage: PostgresStorageConfig,
  options: ResolveStorageDeploymentOptions,
  secureRoot: SecureStateRoot,
  authorityPort: LocalAuthorityDescriptorPort,
  authority: LocalAuthorityDescriptor,
  filesystem: SecureFilesystemOptions,
): Promise<ResolvedPostgresStorage> {
  if (authority.logicalHostId !== storage.logicalHostId) {
    throw new CapletsError("AUTH_FAILED", "Postgres logical-host authority does not match.");
  }
  if (authority.state === "transfer-pending") {
    throw new CapletsError("AUTH_FAILED", "Postgres storage authority transfer is incomplete.");
  }
  let existingBinding: LoadedStorageBinding | undefined;
  if (authority.state === "bound") {
    existingBinding = await readStorageBinding(secureRoot.path, filesystem);
    assertStorageBinding(existingBinding.value, "postgres", authority);
    if (authority.storeId !== storage.expectedStoreId) {
      throw new CapletsError("AUTH_FAILED", "Postgres store authority does not match.");
    }
  }

  const expectedProfile = profileForPostgresProcess(storage.processRole);
  const keyProvider = await loadFileV1KeyProvider({
    manifestPath: storage.keyProviderManifest,
    expectedLogicalHostId: storage.logicalHostId,
    expectedStoreId: storage.expectedStoreId,
    expectedProfile,
    minimumGeneration: existingBinding?.value.keyProviderGeneration,
    filesystem,
  });
  const keyProviderCommitment = fileV1CompatibilityCommitment(keyProvider);
  const keyVersionFloors = fileV1VersionFloors(keyProvider);
  const keyProviderCommitmentHex = keyProviderCommitment.toString("hex");
  await authorizeKeyRotationIfNeeded(
    "postgres",
    existingBinding?.value,
    keyProvider.manifest.generation,
    keyVersionFloors,
    keyProviderCommitmentHex,
    options,
  );
  const canonicalEndpoint = new URL(storage.artifacts.endpoint).toString().replace(/\/+$/u, "");
  const identity = createArtifactProviderIdentity({
    kind: "s3",
    provider: `${canonicalEndpoint}/${storage.artifacts.bucket}`,
    namespace: storage.artifacts.prefix,
    logicalHostId: storage.logicalHostId,
    storeId: storage.expectedStoreId,
  });
  if (existingBinding) {
    assertStorageKeyAndArtifactBinding(existingBinding.value, {
      artifactIdentity: identity.identityId,
      keyProviderGeneration: keyProvider.manifest.generation,
      keyProviderCommitment: keyProviderCommitmentHex,
      keyVersionFloors,
    });
  }

  const roleKind = roleKindForProcess(storage.processRole);
  const role = storage.connection.roles[roleKind];
  const resolveSecret =
    options.resolveSecret ?? ((reference) => resolveDeploymentSecret(reference, filesystem));
  let connectionString: string;
  let ca: string | undefined;
  let accessKeyId: string;
  let secretAccessKey: string;
  let resolvedArtifactCanary: string;
  try {
    [connectionString, ca, accessKeyId, secretAccessKey, resolvedArtifactCanary] =
      await Promise.all([
        resolveSecret(role.credential),
        storage.connection.tls.ca
          ? resolveSecret(storage.connection.tls.ca)
          : Promise.resolve(undefined),
        resolveSecret(storage.artifacts.credentials.accessKeyId),
        resolveSecret(storage.artifacts.credentials.secretAccessKey),
        resolveSecret(storage.artifacts.canary),
      ]);
  } catch {
    throw new CapletsError("AUTH_FAILED", "Deployment credential reference could not be resolved.");
  }
  if (!/^[a-f0-9]{64}$/u.test(resolvedArtifactCanary)) {
    throw new CapletsError("AUTH_FAILED", "Shared artifact provider canary is invalid.");
  }
  const artifactCanary = existingBinding?.value.artifactCanary ?? resolvedArtifactCanary;
  if (artifactCanary !== resolvedArtifactCanary) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Shared artifact provider canary does not match binding.",
    );
  }

  assertPostgresConnectionReference(connectionString, role.role, storage.connection.tls.serverName);

  if (!options.verifyPostgres) {
    throw new CapletsError("REQUEST_INVALID", "Postgres verification adapter is required.");
  }
  let postgres: PostgresVerificationResult;
  try {
    postgres = await options.verifyPostgres({
      connectionString,
      tls: { ...storage.connection.tls, ca },
      role: role.role,
      roleKind,
    });
  } catch {
    throw new CapletsError("AUTH_FAILED", "Postgres peer and role verification failed.");
  }
  assertVerifiedPostgresIdentity(storage, role.role, postgres);
  if (
    (postgres.operationNamespace !== undefined &&
      !OPERATION_NAMESPACE_PATTERN.test(postgres.operationNamespace)) ||
    (authority.state === "bound" &&
      postgres.operationNamespace !== undefined &&
      postgres.operationNamespace !== authority.operationNamespace)
  ) {
    throw new CapletsError("AUTH_FAILED", "Postgres operation namespace does not match authority.");
  }
  if (!/^[a-f0-9]{64}$/u.test(postgres.databaseIdentity)) {
    throw new CapletsError("AUTH_FAILED", "Postgres database identity is invalid.");
  }
  if (existingBinding) {
    assertStorageResourceBinding(existingBinding.value, {
      databaseIdentity: postgres.databaseIdentity,
      artifactIdentity: identity.identityId,
      keyProviderGeneration: keyProvider.manifest.generation,
      keyProviderCommitment: keyProviderCommitmentHex,
      keyVersionFloors,
    });
  }

  if (!options.verifyS3Canary) {
    throw new CapletsError("REQUEST_INVALID", "Shared S3 canary verification adapter is required.");
  }
  let canary: S3CanaryVerificationResult;
  try {
    canary = await options.verifyS3Canary({
      endpoint: storage.artifacts.endpoint,
      region: storage.artifacts.region,
      bucket: storage.artifacts.bucket,
      prefix: storage.artifacts.prefix,
      accessKeyId,
      secretAccessKey,
      identity,
      expectedCanary: artifactCanary,
      createIfMissing: existingBinding === undefined,
    });
  } catch {
    throw new CapletsError("AUTH_FAILED", "Shared artifact provider canary verification failed.");
  }
  if (!canary.matches || canary.identity.identityId !== identity.identityId) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Shared artifact provider canary or identity does not match.",
    );
  }
  if (
    existingBinding &&
    keyProvider.manifest.generation > existingBinding.value.keyProviderGeneration
  ) {
    await advanceStorageBinding(
      secureRoot.path,
      existingBinding,
      {
        ...existingBinding.value,
        keyProviderGeneration: keyProvider.manifest.generation,
        keyProviderCommitment: keyProviderCommitmentHex,
        keyVersionFloors,
      },
      filesystem,
    );
  }

  let operationNamespace: string;
  if (authority.state === "unbound") {
    operationNamespace = postgres.operationNamespace ?? generateCrockfordIdentifier("operations");
    const binding: StorageBinding = {
      version: 1,
      backend: "postgres",
      logicalHostId: storage.logicalHostId,
      storeId: storage.expectedStoreId,
      operationNamespace,
      databaseIdentity: postgres.databaseIdentity,
      artifactIdentity: identity.identityId,
      artifactCanary,
      keyProviderGeneration: keyProvider.manifest.generation,
      keyProviderCommitment: keyProviderCommitmentHex,
      keyVersionFloors,
    };
    await writeSecureJsonExclusive(
      join(secureRoot.path, STORAGE_BINDING_FILE),
      binding,
      filesystem,
    );
    const next: LocalAuthorityDescriptor = {
      ...authority,
      state: "bound",
      storeId: storage.expectedStoreId,
      operationNamespace,
    };
    if (
      !(await transitionLocalAuthorityDescriptor(
        authorityPort,
        authority.owner,
        authority,
        next,
        "bind",
      ))
    ) {
      throw new CapletsError("AUTH_FAILED", "Concurrent storage authority binding was rejected.");
    }
  } else {
    operationNamespace = authority.operationNamespace;
  }

  const resolved: ResolvedPostgresStorage = {
    backend: "postgres",
    logicalHostId: storage.logicalHostId,
    storeId: storage.expectedStoreId,
    operationNamespace,
    stateRoot: secureRoot.path,
    keyProviderManifest: storage.keyProviderManifest,
    artifacts: { kind: "s3", identity },
  };
  storageCompatibility.set(resolved, {
    keyProvider: keyProviderCommitment,
    keyProviderGeneration: keyProvider.manifest.generation,
    keyVersionFloors,
    databaseIdentity: postgres.databaseIdentity,
    artifactIdentity: identity.identityId,
    artifactCanary,
  });
  return resolved;
}

class SecureAuthorityDescriptorPort implements LocalAuthorityDescriptorPort {
  readonly #path: string;
  readonly #owner: LocalAuthorityOwner;
  readonly #filesystem: SecureFilesystemOptions;

  constructor(path: string, owner: LocalAuthorityOwner, filesystem: SecureFilesystemOptions) {
    this.#path = path;
    this.#owner = owner;
    this.#filesystem = filesystem;
  }

  async readNoFollow(): Promise<LocalAuthorityDescriptorFile | undefined> {
    const pathFile = await lstat(this.#path).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw new CapletsError("AUTH_FAILED", "Storage authority could not be inspected.");
    });
    if (!pathFile) return undefined;
    const file = await readBoundedSecureFileWithMetadata(this.#path, {
      ...this.#filesystem,
      maxBytes: 64 * 1024,
      expectedUid: this.#owner.kind === "posix" ? this.#owner.uid : undefined,
    });
    return {
      revision: file.metadata.revision,
      kind: "regular",
      followedSymlink: false,
      owner: this.#owner,
      ...(this.#owner.kind === "posix"
        ? { posixMode: file.metadata.posixMode }
        : { windowsDaclRestricted: file.metadata.windowsDaclRestricted }),
      contents: file.bytes.toString("utf8"),
    };
  }

  compareAndSwap(expectedRevision: string, descriptor: LocalAuthorityDescriptor): Promise<boolean> {
    return replaceSecureFileAtomically(
      this.#path,
      expectedRevision,
      Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8"),
      {
        ...this.#filesystem,
        maxBytes: 64 * 1024,
        expectedUid: this.#owner.kind === "posix" ? this.#owner.uid : undefined,
      },
    );
  }
}

async function resolveFilesystemArtifactCanary(
  root: string,
  logicalHostId: string,
  storeId: string,
  expectedCanary: string,
  createIfMissing: boolean,
  filesystem: SecureFilesystemOptions,
): Promise<{ identity: string }> {
  if (createIfMissing) await ensureSecureStateDirectory(root, filesystem);
  else await assertSecureStateDirectory(root, filesystem);
  const path = join(root, ".caplets-storage-canary-v1.json");
  if (createIfMissing) {
    await writeSecureJsonExclusive(
      path,
      { version: 1, logicalHostId, storeId, canary: expectedCanary },
      filesystem,
    );
  }
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = await readBoundedSecureFile(path, { ...filesystem, maxBytes: 4 * 1024 });
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CapletsError("AUTH_FAILED", "Filesystem artifact provider canary is absent.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapletsError("AUTH_FAILED", "Filesystem artifact provider canary is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "canary,logicalHostId,storeId,version" ||
    record.version !== 1 ||
    record.logicalHostId !== logicalHostId ||
    record.storeId !== storeId ||
    record.canary !== expectedCanary
  ) {
    throw new CapletsError("AUTH_FAILED", "Filesystem artifact provider canary does not match.");
  }
  return {
    identity: createHash("sha256")
      .update("filesystem-artifacts")
      .update("\0")
      .update(bytes)
      .digest("hex"),
  };
}

export async function resolveDeploymentSecret(
  reference: DeploymentSecretReference,
  filesystem: SecureFilesystemOptions,
): Promise<string> {
  if (reference.kind === "env") {
    const value = process.env[reference.name];
    if (!value || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new CapletsError("AUTH_FAILED", "Deployment environment reference is unavailable.");
    }
    return value;
  }
  const bytes = await readBoundedSecureFile(reference.path, { ...filesystem, maxBytes: 64 * 1024 });
  return bytes.toString("utf8").trimEnd();
}

async function verifySqliteDatabase(
  path: string,
  logicalHostId: string,
  storeId: string,
  allowCreate: boolean,
  filesystem: SecureFilesystemOptions,
  options: ResolveStorageDeploymentOptions,
): Promise<SecureFileMetadata> {
  if (allowCreate) await ensureSecureStateDirectory(dirname(path), filesystem);
  else await assertSecureStateDirectory(dirname(path), filesystem);

  type DatabaseConnection = {
    exec(statement: string): void;
    pragma(statement: string, options?: { simple?: boolean }): unknown;
    prepare(statement: string): {
      get(): unknown;
      run(...values: unknown[]): unknown;
    };
    close(): void;
  };
  type DatabaseConstructor = new (
    filename: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => DatabaseConnection;
  const Database = require("better-sqlite3") as DatabaseConstructor;
  if (!(await pathExists(path))) {
    if (!allowCreate) {
      throw new CapletsError("AUTH_FAILED", "Bound SQLite database is absent.");
    }
    await writeSecureFileExclusive(path, Buffer.alloc(0), filesystem);
    try {
      await withSecureStateDirectory(dirname(path), filesystem, async (pinnedParent) => {
        let created: DatabaseConnection | undefined;
        try {
          created = new Database(join(pinnedParent, basename(path)));
          created.exec(
            'CREATE TABLE "__caplets_storage_identity_v1" (' +
              '"singleton" INTEGER PRIMARY KEY CHECK ("singleton" = 1), ' +
              '"logical_host_id" TEXT NOT NULL, "store_id" TEXT NOT NULL)',
          );
          created
            .prepare(
              'INSERT INTO "__caplets_storage_identity_v1" ' +
                '("singleton", "logical_host_id", "store_id") VALUES (1, ?, ?)',
            )
            .run(logicalHostId, storeId);
        } finally {
          created?.close();
        }
      });
    } catch {
      throw new CapletsError("AUTH_FAILED", "Owner-private SQLite creation failed.");
    }
  }

  if (process.platform === "win32") {
    const identity = await inspectSecureRegularFile(path, filesystem);
    if (!options.verifySqliteFile) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Windows SQLite verification requires an opened-handle identity adapter.",
      );
    }
    await options.verifySqliteFile({ path, identity });
    return identity;
  }
  try {
    const verified = await withSecureMutableRegularFile(path, filesystem, async (_handle) => {
      let database: DatabaseConnection | undefined;
      try {
        // Open the verified path so SQLite can resolve its live WAL/SHM companions.
        // withSecureRegularFile pins and rechecks the database inode around this use.
        database = new Database(path, { readonly: true, fileMustExist: true });
        const result = database.pragma("quick_check", { simple: true });
        if (result !== "ok") throw new Error("quick check failed");
        const stored = database
          .prepare(
            'SELECT "logical_host_id" AS "logicalHostId", "store_id" AS "storeId" ' +
              'FROM "__caplets_storage_identity_v1" WHERE "singleton" = 1',
          )
          .get() as { logicalHostId?: unknown; storeId?: unknown } | undefined;
        if (stored?.logicalHostId !== logicalHostId || stored.storeId !== storeId) {
          throw new Error("storage identity mismatch");
        }
      } finally {
        database?.close();
      }
    });
    return verified.metadata;
  } catch {
    throw new CapletsError("AUTH_FAILED", "Owner-private SQLite verification failed.");
  }
}

export function normalizedPostgresConnectionReference(
  connectionString: string,
  expectedRole: string,
  serverName: string,
): URL {
  try {
    const connection = new URL(connectionString);
    const database = connection.pathname.replace(/^\/+/u, "");
    const sslModes = connection.searchParams.getAll("sslmode");
    if (
      (connection.protocol !== "postgres:" && connection.protocol !== "postgresql:") ||
      decodeURIComponent(connection.username) !== expectedRole ||
      connection.password.length === 0 ||
      connection.hostname.length === 0 ||
      connection.hostname.toLowerCase() !== serverName.toLowerCase() ||
      database.length === 0 ||
      ["postgres", "template0", "template1"].includes(database) ||
      connection.hash.length > 0 ||
      sslModes.length !== 1 ||
      (sslModes[0] !== "require" && sslModes[0] !== "verify-full") ||
      [...connection.searchParams.keys()].some((key) => key !== "sslmode")
    ) {
      throw new Error("invalid connection target");
    }
    connection.search = "";
    return connection;
  } catch {
    throw new Error("Postgres connection string is invalid");
  }
}

function assertPostgresConnectionReference(
  connectionString: string,
  expectedRole: string,
  serverName: string,
): void {
  try {
    normalizedPostgresConnectionReference(connectionString, expectedRole, serverName);
  } catch {
    throw new CapletsError("AUTH_FAILED", "Postgres role credential reference is invalid.");
  }
}

function assertVerifiedPostgresIdentity(
  storage: PostgresStorageConfig,
  expectedRole: string,
  result: PostgresVerificationResult,
): void {
  if (
    result.logicalHostId !== storage.logicalHostId ||
    result.storeId !== storage.expectedStoreId
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Postgres logical-host or store identity does not match.",
    );
  }
  if (result.tlsPeerServerName !== storage.connection.tls.serverName) {
    throw new CapletsError("AUTH_FAILED", "Postgres verified TLS peer does not match.");
  }
  if (
    result.databaseRole !== expectedRole ||
    result.canSetRole !== false ||
    !Array.isArray(result.inheritedRoles) ||
    result.inheritedRoles.some((role) => typeof role !== "string") ||
    result.inheritedRoles.length > 0 ||
    hasUnexpectedPostgresPrivileges(result.privileges)
  ) {
    throw new CapletsError("AUTH_FAILED", "Postgres role has unexpected identity or privileges.");
  }
}

function hasUnexpectedPostgresPrivileges(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "bypassRowLevelSecurity",
    "createDatabase",
    "createRole",
    "replication",
    "superuser",
  ];
  const keys = Object.keys(record).sort();
  return (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => record[key] !== false)
  );
}

async function readStorageBinding(
  stateRoot: string,
  filesystem: SecureFilesystemOptions,
): Promise<LoadedStorageBinding> {
  let value: unknown;
  let revision = "";
  try {
    const file = await readBoundedSecureFileWithMetadata(join(stateRoot, STORAGE_BINDING_FILE), {
      ...filesystem,
      maxBytes: 16 * 1024,
    });
    revision = file.metadata.revision;
    value = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    throw new CapletsError("AUTH_FAILED", "Storage identity binding is absent or invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapletsError("AUTH_FAILED", "Storage identity binding is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "artifactIdentity",
    "artifactCanary",
    "backend",
    "databaseIdentity",
    "keyProviderCommitment",
    "keyProviderGeneration",
    "keyVersionFloors",
    "logicalHostId",
    "operationNamespace",
    "storeId",
    "version",
  ].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.version !== 1 ||
    (record.backend !== "sqlite" && record.backend !== "postgres") ||
    typeof record.logicalHostId !== "string" ||
    typeof record.storeId !== "string" ||
    typeof record.operationNamespace !== "string" ||
    typeof record.databaseIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.databaseIdentity) ||
    typeof record.artifactIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.artifactIdentity) ||
    typeof record.artifactCanary !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.artifactCanary) ||
    !Number.isSafeInteger(record.keyProviderGeneration) ||
    (record.keyProviderGeneration as number) <= 0 ||
    typeof record.keyProviderCommitment !== "string" ||
    !isFileV1VersionFloors(record.keyVersionFloors) ||
    !/^[a-f0-9]{64}$/u.test(record.keyProviderCommitment)
  ) {
    throw new CapletsError("AUTH_FAILED", "Storage identity binding is invalid.");
  }
  return { value: record as StorageBinding, revision };
}

function assertStorageBinding(
  binding: StorageBinding,
  backend: StorageBinding["backend"],
  authority: Extract<LocalAuthorityDescriptor, { state: "bound" }>,
): void {
  if (
    binding.backend !== backend ||
    binding.logicalHostId !== authority.logicalHostId ||
    binding.storeId !== authority.storeId ||
    binding.operationNamespace !== authority.operationNamespace
  ) {
    throw new CapletsError("AUTH_FAILED", "Storage backend or authority binding drifted.");
  }
}

async function authorizeKeyRotationIfNeeded(
  backend: StorageBinding["backend"],
  current: StorageBinding | undefined,
  candidateGeneration: number,
  candidateVersionFloors: FileV1VersionFloors,
  candidateKeyCommitment: string,
  options: ResolveStorageDeploymentOptions,
): Promise<void> {
  if (!current) return;
  if (
    candidateGeneration < current.keyProviderGeneration ||
    !keyVersionFloorsCanAdvance(
      current.keyVersionFloors,
      candidateVersionFloors,
      candidateGeneration === current.keyProviderGeneration,
    )
  ) {
    throw new CapletsError("AUTH_FAILED", "Storage key version floors cannot move backwards.");
  }
  if (candidateGeneration === current.keyProviderGeneration) return;
  let authorized = false;
  try {
    authorized =
      (await options.authorizeKeyRotation?.({
        backend,
        logicalHostId: current.logicalHostId,
        storeId: current.storeId,
        currentGeneration: current.keyProviderGeneration,
        candidateGeneration,
        currentKeyCommitment: current.keyProviderCommitment,
        candidateKeyCommitment,
        currentVersionFloors: current.keyVersionFloors,
        candidateVersionFloors,
      })) === true;
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Storage key rotation requires durable retirement authorization.",
    );
  }
}

function keyVersionFloorsCanAdvance(
  current: FileV1VersionFloors,
  candidate: FileV1VersionFloors,
  requireEqual: boolean,
): boolean {
  return FILE_V1_RUNTIME_PURPOSES.every((purpose) => {
    const left = current[purpose];
    const right = candidate[purpose];
    return requireEqual
      ? left.activeVersion === right.activeVersion &&
          left.minimumLiveVersion === right.minimumLiveVersion &&
          sameLiveVersions(left.liveVersions, right.liveVersions)
      : right.activeVersion >= left.activeVersion &&
          right.minimumLiveVersion >= left.minimumLiveVersion;
  });
}

function sameLiveVersions(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((version, index) => version === right[index]);
}

function isFileV1VersionFloors(value: unknown): value is FileV1VersionFloors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...FILE_V1_RUNTIME_PURPOSES].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return FILE_V1_RUNTIME_PURPOSES.every((purpose) => {
    const floor = record[purpose];
    if (!floor || typeof floor !== "object" || Array.isArray(floor)) return false;
    const fields = floor as Record<string, unknown>;
    const liveVersions = fields.liveVersions;
    if (
      Object.keys(fields).sort().join(",") !== "activeVersion,liveVersions,minimumLiveVersion" ||
      !Number.isSafeInteger(fields.activeVersion) ||
      !Number.isSafeInteger(fields.minimumLiveVersion) ||
      !Array.isArray(liveVersions) ||
      liveVersions.length === 0 ||
      liveVersions.length > 3 ||
      liveVersions.some(
        (version, index) =>
          !Number.isSafeInteger(version) ||
          (version as number) <= 0 ||
          (index > 0 && (liveVersions[index - 1] as number) >= (version as number)),
      )
    ) {
      return false;
    }
    return (
      fields.minimumLiveVersion === liveVersions[0] && fields.activeVersion === liveVersions.at(-1)
    );
  });
}

function assertStorageKeyAndArtifactBinding(
  binding: StorageBinding,
  expected: Pick<
    StorageBinding,
    "artifactIdentity" | "keyProviderGeneration" | "keyProviderCommitment" | "keyVersionFloors"
  >,
): void {
  if (
    binding.artifactIdentity !== expected.artifactIdentity ||
    expected.keyProviderGeneration < binding.keyProviderGeneration ||
    (expected.keyProviderGeneration === binding.keyProviderGeneration &&
      (binding.keyProviderCommitment !== expected.keyProviderCommitment ||
        !keyVersionFloorsCanAdvance(binding.keyVersionFloors, expected.keyVersionFloors, true)))
  ) {
    throw new CapletsError("AUTH_FAILED", "Storage provider or key binding drifted.");
  }
}

function assertStorageResourceBinding(
  binding: StorageBinding,
  expected: Pick<
    StorageBinding,
    | "databaseIdentity"
    | "artifactIdentity"
    | "keyProviderGeneration"
    | "keyProviderCommitment"
    | "keyVersionFloors"
  >,
): void {
  assertStorageKeyAndArtifactBinding(binding, expected);
  if (binding.databaseIdentity !== expected.databaseIdentity) {
    throw new CapletsError("AUTH_FAILED", "Storage provider or key binding drifted.");
  }
}

async function advanceStorageBinding(
  stateRoot: string,
  current: LoadedStorageBinding,
  next: StorageBinding,
  filesystem: SecureFilesystemOptions,
): Promise<void> {
  const path = join(stateRoot, STORAGE_BINDING_FILE);
  const replaced = await replaceSecureFileAtomically(
    path,
    current.revision,
    Buffer.from(`${JSON.stringify(next)}\n`, "utf8"),
    filesystem,
  );
  if (replaced) return;
  const concurrent = await readStorageBinding(stateRoot, filesystem);
  if (JSON.stringify(concurrent.value) !== JSON.stringify(next)) {
    throw new CapletsError("AUTH_FAILED", "Concurrent storage key rotation was rejected.");
  }
}

function deploymentCommitment(kind: string, value: string): string {
  return createHash("sha256").update(kind).update("\0").update(value).digest("hex");
}

function profileForPostgresProcess(
  role: PostgresProcessRole,
): "online" | "migrator" | "maintenance" {
  if (role === "online") return "online";
  return role;
}

function roleKindForProcess(role: PostgresProcessRole): "runtime" | "migrator" | "maintenance" {
  return role === "online" ? "runtime" : role;
}

function assertWithinRoot(root: string, path: string, label: string): void {
  const pathRelativeToRoot = relative(root, path);
  if (
    isAbsolute(pathRelativeToRoot) ||
    pathRelativeToRoot.startsWith("..") ||
    pathRelativeToRoot === ""
  ) {
    throw new CapletsError("REQUEST_INVALID", `${label} path must stay inside secure state.`);
  }
}

function currentOwner(): LocalAuthorityOwner {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Windows storage authority requires an explicit service SID and DACL verifier.",
    );
  }
  return { kind: "posix", uid };
}

function generateCrockfordIdentifier(
  prefix: "host" | "store" | "operations" | "authority",
): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let identifier = "";
  for (const byte of bytes) identifier += alphabet[byte % alphabet.length];
  return `${prefix}_${identifier}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
