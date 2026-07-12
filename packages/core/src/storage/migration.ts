import { createHash, randomUUID } from "node:crypto";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityAuxiliaryExport,
  AuthorityAuxiliarySession,
  AuthorityExport,
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuthorityHealth,
  AuthorityLifecycleDiagnostic,
  AuthorityMigrationStage,
  AuthorityMigrationStageContext,
  AuthorityMigrationTarget,
  AuthorityProviderKind,
  AuthorityRestoreResult,
  MaintenanceFence,
  MaintenanceFenceContext,
  MaintenanceFenceLease,
  WritableAuthority,
} from "./types";

export type {
  AuthorityLifecycleDiagnostic,
  AuthorityMigrationStage,
  AuthorityMigrationStageContext,
  MaintenanceFence,
  MaintenanceFenceContext,
  MaintenanceFenceLease,
} from "./types";

export type AuthorityInventoryDomain = {
  /** Stable domain identifier, never a source path. */
  name: string;
  count: number;
  schemaVersion: number;
  redactedDigest: string;
};

export type AuthorityInventoryExclusion = {
  kind:
    | "provider-credentials"
    | "encryption-key-bytes"
    | "staged-files"
    | "replica-local-artifacts"
    | "client-local-state"
    | "setup-attempts"
    | "live-sessions"
    | "logs-journals-caches";
  reason: string;
};

export type AuthorityInventory = {
  identity: {
    authorityId: string;
    provider: AuthorityProviderKind;
    namespace: string;
  };
  schemaVersion: number;
  head: AuthorityHead;
  generation: AuthorityGenerationIdentity;
  domains: AuthorityInventoryDomain[];
  exclusions: AuthorityInventoryExclusion[];
  /** Complete canonical source export digest used for the race recheck. */
  sourceDigest: string;
};

export type AuthorityInventoryOptions = {
  /** Additional typed top-level domain names owned by a deployment. */
  knownDomains?: readonly string[];
};

export type MigrationStage = AuthorityMigrationStage;
export type MigrationTargetAdapter = {
  stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<MigrationStage>;
  /** Read the provider-owned candidate before publication. */
  readMigrationStage(
    stage: MigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport>;
  /** Publish the already verified candidate exactly once. */
  publishMigrationStage(
    stage: MigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult | void>;
  /** Remove an unselected candidate after a failed verification/race. */
  invalidateMigrationStage(
    stage: MigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void>;
};

export type MigrationOptions = {
  source: WritableAuthority;
  target: WritableAuthority;
  fence?: MaintenanceFence;
  sourceFence?: MaintenanceFence;
  destinationFence?: MaintenanceFence;
  targetFence?: MaintenanceFence;
  dryRun?: boolean;
  targetNamespace?: string;
  targetSchemaVersion?: number;
  knownDomains?: readonly string[];
  owner?: string;
  now?: () => Date;
};

export type MigrationDryRunResult = {
  kind: "dry-run";
  inventory: AuthorityInventory;
  target: {
    authorityId: string;
    provider: AuthorityProviderKind;
    namespace: string;
  };
  sourceDigest: string;
};

export type MigrationCutoverCoordinates = {
  authorityId: string;
  provider: AuthorityProviderKind;
  namespace: string;
  generationId: string;
  sequence: number;
  digest: string;
};

export type MigrationApplyResult = {
  kind: "applied";
  cutover: MigrationCutoverCoordinates;
  diagnostics?: AuthorityLifecycleDiagnostic[];
};

export type MigrationResult = MigrationDryRunResult | MigrationApplyResult;

const DEFAULT_EXCLUSIONS: readonly AuthorityInventoryExclusion[] = [
  {
    kind: "provider-credentials",
    reason: "Deployment-native authority credentials are never authority records.",
  },
  {
    kind: "encryption-key-bytes",
    reason: "External encryption keys and resolver output stay outside exports.",
  },
  {
    kind: "staged-files",
    reason: "Staged filesystem sources remain immutable and separately owned.",
  },
  {
    kind: "replica-local-artifacts",
    reason: "Replica-local logs, journals, and recovery state are rebuildable.",
  },
  {
    kind: "client-local-state",
    reason: "Remote profiles, Cloud auth, and client caches are client-owned.",
  },
  { kind: "setup-attempts", reason: "Ephemeral setup attempts are not durable authority state." },
  {
    kind: "live-sessions",
    reason: "Live MCP, Attach, and workspace sessions remain replica-local.",
  },
  {
    kind: "logs-journals-caches",
    reason: "Logs, telemetry, temporary files, and observed-output caches are excluded.",
  },
];

const KNOWN_DOMAINS = new Set([
  "config",
  "caplets",
  "records",
  "lock",
  "lockfile",
  "settings",
  "vault",
  "vaultRecords",
  "vaultGrants",
  "pairingCodes",
  "pendingLogins",
  "clients",
  "remoteCredentials",
  "serverCredentials",
  "replays",
  "oauth",
  "oauthCredentials",
  "oidc",
  "oidcCredentials",
  "sessions",
  "dashboardSessions",
  "sessionTouches",
  "activity",
  "activities",
  "successActivity",
  "securityEvents",
  "failedEvents",
  "setupActivity",
  "failedEventWatermark",
  "setupApprovals",
  "receipts",
  "catalog",
  "host",
  "currentHost",
]);

/**
 * Inventory the complete typed authority export. This intentionally does not
 * walk the filesystem: unknown top-level records are an apply blocker.
 */
export async function inventoryAuthority(
  authority: WritableAuthority,
  options: AuthorityInventoryOptions = {},
): Promise<AuthorityInventory> {
  const { inventory } = await loadInventory(authority, options);
  return inventory;
}

/** Compute the canonical digest used to detect a source race. */
export function authorityExportDigest(state: AuthorityExport): string {
  const encoded = stableJsonStringify(state);
  if (typeof encoded !== "string") {
    throw new CapletsError("CONFIG_INVALID", "Authority export is not serializable");
  }
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

/**
 * Perform a fenced, empty-target migration. Apply returns cutover coordinates
 * and optional cleanup diagnostics; dry-run returns typed inventory without
 * staging or publishing a candidate.
 */
export async function migrateAuthority(options: MigrationOptions): Promise<MigrationResult> {
  const sourceHealth = await safeHealth(options.source, "source");
  const targetHealth = await safeHealth(options.target, "destination");
  const sourceFence = options.sourceFence ?? options.fence ?? options.source.maintenanceFence?.();
  const destinationFence =
    options.destinationFence ??
    options.targetFence ??
    options.fence ??
    options.target.maintenanceFence?.();
  if (!sourceFence || !destinationFence) {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "Authority lifecycle requires injected source and destination maintenance fences",
    );
  }
  const sourceNamespace = sourceNamespaceFor(options.source, sourceHealth);
  const targetNamespace =
    options.targetNamespace ?? targetNamespaceFor(options.target, targetHealth, sourceNamespace);
  const owner = options.owner ?? `migration-${randomUUID()}`;
  const targetSchemaVersion = resolveTargetSchemaVersion(
    options.target,
    options.targetSchemaVersion,
  );
  const sourceContext: MaintenanceFenceContext = {
    operation: "migration",
    role: "source",
    authorityId: sourceHealth.authorityId,
    namespace: sourceNamespace,
    owner,
  };
  const destinationContext: MaintenanceFenceContext = {
    operation: "migration",
    role: "destination",
    authorityId: targetHealth.authorityId,
    namespace: targetNamespace,
    owner,
  };

  let completedResult: MigrationResult | undefined;
  const sourceLease = await sourceFence.acquire(sourceContext);
  let destinationLease: MaintenanceFenceLease | void;
  try {
    await assertSourceFence(sourceFence, sourceContext);
    destinationLease = await destinationFence.acquire(destinationContext);
    try {
      const inventoryOptions: AuthorityInventoryOptions = options.knownDomains
        ? { knownDomains: options.knownDomains }
        : {};
      const loaded = await loadInventory(options.source, inventoryOptions);
      const targetHead = await options.target.readHead();
      if (targetHead !== null) {
        throw new CapletsError("CONFIG_EXISTS", "Migration destination must be empty");
      }
      await assertStagedCollisions(options.target, loaded.state);
      const targetIdentity = {
        authorityId: targetHealth.authorityId,
        provider: targetHealth.provider,
        namespace: targetNamespace,
      } as const;
      if (options.dryRun) {
        completedResult = {
          kind: "dry-run",
          inventory: loaded.inventory,
          target: targetIdentity,
          sourceDigest: loaded.inventory.sourceDigest,
        };
        return completedResult;
      }

      const adapter = createWritableAuthorityMigrationAdapter(options.target);
      const migratedState = buildMigratedState(
        loaded.state,
        targetIdentity,
        targetSchemaVersion,
        options,
      );
      let stage: MigrationStage | undefined;
      let published = false;
      try {
        stage = await adapter.stageMigration(migratedState, { owner });
        const staged = await adapter.readMigrationStage(stage, { owner });
        assertStagedStateMatches(migratedState, staged);
        await assertHealthyWritable(options.target, "destination staging");

        const rechecked = await options.source.exportState();
        if (authorityExportDigest(rechecked) !== loaded.inventory.sourceDigest) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "Source authority changed during migration; staged state was invalidated",
          );
        }

        try {
          await adapter.publishMigrationStage(stage, { owner });
        } catch (error) {
          const resolved = await readPublishedState(options.target, migratedState).catch(
            () => false,
          );
          if (!resolved) throw error;
        }

        const publishedState = await readPublishedState(options.target, migratedState);
        if (!publishedState) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "Migration publication did not produce the verified target generation",
          );
        }
        published = true;
        await assertHealthyWritable(options.target, "destination cutover");
        completedResult = {
          kind: "applied",
          cutover: {
            authorityId: targetIdentity.authorityId,
            provider: targetIdentity.provider,
            namespace: targetIdentity.namespace,
            generationId: migratedState.generation.id,
            sequence: migratedState.generation.sequence,
            digest: migratedState.generation.digest,
          },
        };
        return completedResult;
      } catch (error) {
        if (stage && !published) {
          await adapter.invalidateMigrationStage(stage, { owner });
        }
        throw error;
      }
    } finally {
      const diagnostic = await releaseFence(destinationFence, destinationLease, destinationContext);
      if (diagnostic && completedResult?.kind === "applied") {
        completedResult.diagnostics = [...(completedResult.diagnostics ?? []), diagnostic];
      }
    }
  } finally {
    const diagnostic = await releaseFence(sourceFence, sourceLease, sourceContext);
    if (diagnostic && completedResult?.kind === "applied") {
      completedResult.diagnostics = [...(completedResult.diagnostics ?? []), diagnostic];
    }
  }
}

/** Explicit name useful to hosts that call lifecycle operations generically. */
export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  return await migrateAuthority(options);
}

async function loadInventory(
  authority: WritableAuthority,
  options: AuthorityInventoryOptions,
): Promise<{ state: AuthorityExport; inventory: AuthorityInventory }> {
  const state = await authority.exportState();
  validateExport(state);
  const head = await authority.readHead();
  if (authorityGenerationDigest(state.generation) !== state.generation.digest) {
    throw new CapletsError("CONFIG_INVALID", "Authority export generation digest is invalid");
  }
  if (!head || !sameHead(head, state.generation)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority export does not match its authoritative head",
    );
  }
  const generation = state.generation;
  const snapshot = generation.snapshot;
  if (!isRecord(snapshot)) {
    throw new CapletsError("CONFIG_INVALID", "Authority snapshot is malformed");
  }
  const known = new Set(KNOWN_DOMAINS);
  for (const domain of options.knownDomains ?? []) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(domain)) {
      throw new CapletsError("CONFIG_INVALID", "Authority inventory domain name is invalid");
    }
    known.add(domain);
  }
  const domains: AuthorityInventoryDomain[] = [];
  for (const [name, value] of Object.entries(snapshot)) {
    if (!known.has(name)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Unknown host-owned authority record domain: ${name}`,
      );
    }
    assertDomainShape(name, value);
    domains.push({
      name: canonicalDomainName(name),
      count: domainCount(name, value),
      schemaVersion: generation.schemaVersion,
      redactedDigest: redactedDigest(value),
    });
  }
  domains.sort((left, right) => left.name.localeCompare(right.name));
  const identity = {
    authorityId: generation.authorityId,
    provider: generation.provenance.provider,
    namespace: generation.provenance.namespace,
  } as const;
  return {
    state,
    inventory: {
      identity,
      schemaVersion: generation.schemaVersion,
      head,
      generation: {
        authorityId: generation.authorityId,
        id: generation.id,
        sequence: generation.sequence,
        predecessorId: generation.predecessorId,
      },
      domains,
      exclusions: DEFAULT_EXCLUSIONS.map((entry) => ({ ...entry })),
      sourceDigest: authorityExportDigest(state),
    },
  };
}

function validateExport(state: AuthorityExport): void {
  if (
    !state ||
    typeof state !== "object" ||
    !state.generation ||
    typeof state.auxiliaryWatermark !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority export is malformed");
  }
  const generation = state.generation;
  if (
    typeof generation.authorityId !== "string" ||
    typeof generation.id !== "string" ||
    !Number.isSafeInteger(generation.sequence) ||
    generation.sequence < 1 ||
    (generation.predecessorId !== null && typeof generation.predecessorId !== "string") ||
    !Number.isSafeInteger(generation.schemaVersion) ||
    generation.schemaVersion < 1 ||
    typeof generation.digest !== "string" ||
    !generation.provenance ||
    typeof generation.provenance !== "object" ||
    typeof generation.provenance.provider !== "string" ||
    typeof generation.provenance.namespace !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority export generation is malformed");
  }
  if (!isRecord(generation.snapshot) || Array.isArray(generation.snapshot)) {
    throw new CapletsError("CONFIG_INVALID", "Authority snapshot is malformed");
  }
}

function assertDomainShape(name: string, value: unknown): void {
  if (value === null || value === undefined) {
    throw new CapletsError("CONFIG_INVALID", `Authority domain ${name} is malformed`);
  }
  if (name === "remoteCredentials") {
    assertRemoteCredentialsDomain(value);
    return;
  }
  if (name === "setupActivity") {
    assertSetupActivityDomain(value);
    return;
  }
  if (name === "config" && !isRecord(value)) {
    throw new CapletsError("CONFIG_INVALID", "Authority config domain is malformed");
  }
  if (
    [
      "caplets",
      "records",
      "lock",
      "lockfile",
      "settings",
      "vault",
      "vaultRecords",
      "vaultGrants",
      "pairingCodes",
      "pendingLogins",
      "clients",
      "serverCredentials",
      "replays",
      "oauth",
      "oauthCredentials",
      "oidc",
      "oidcCredentials",
      "sessions",
      "dashboardSessions",
      "sessionTouches",
      "activity",
      "activities",
      "successActivity",
      "securityEvents",
      "failedEvents",
      "setupApprovals",
      "receipts",
      "catalog",
      "host",
      "currentHost",
    ].includes(name) &&
    typeof value !== "object"
  ) {
    throw new CapletsError("CONFIG_INVALID", `Authority domain ${name} is malformed`);
  }
  if (name === "failedEventWatermark" && typeof value !== "string" && typeof value !== "number") {
    throw new CapletsError("CONFIG_INVALID", "Authority failed-event watermark is malformed");
  }
}
const REMOTE_ROOT_KEYS: Record<string, true> = {
  version: true,
  pairingCodes: true,
  pendingLogins: true,
  clients: true,
};
const REMOTE_PAIRING_KEYS: Record<string, true> = {
  codeId: true,
  hostUrl: true,
  secretHash: true,
  clientLabel: true,
  createdAt: true,
  expiresAt: true,
  attempts: true,
  maxAttempts: true,
  usedAt: true,
};
const REMOTE_PENDING_KEYS: Record<string, true> = {
  flowId: true,
  hostUrl: true,
  hostIdentity: true,
  operatorCodeHash: true,
  pendingRefreshHash: true,
  supersededPendingRefreshHashes: true,
  pendingRefreshReplay: true,
  pendingCompletionHash: true,
  completionReplay: true,
  clientLabel: true,
  requestedRole: true,
  grantedRole: true,
  clientFingerprint: true,
  sourceHint: true,
  createdAt: true,
  codeExpiresAt: true,
  flowExpiresAt: true,
  status: true,
  operatorCodeFingerprint: true,
  approvedAt: true,
  deniedAt: true,
  cancelledAt: true,
  exchangedAt: true,
};
const REMOTE_CLIENT_KEYS: Record<string, true> = {
  clientId: true,
  clientLabel: true,
  role: true,
  hostUrl: true,
  accessTokenHash: true,
  accessExpiresAt: true,
  refreshTokenHash: true,
  supersededRefreshTokenHashes: true,
  refreshFamilyId: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
};
const REMOTE_SUPERSEDED_KEYS: Record<string, true> = {
  hash: true,
  supersededAt: true,
};
const REMOTE_PENDING_REPLAY_KEYS: Record<string, true> = {
  refreshHash: true,
  expiresAt: true,
  encryptedResponse: true,
};
const REMOTE_COMPLETION_REPLAY_KEYS: Record<string, true> = {
  expiresAt: true,
  encryptedCredentials: true,
};
const SETUP_ACTIVITY_KEYS: Record<string, true> = {
  kind: true,
  decision: true,
  projectFingerprint: true,
  capletId: true,
  contentHash: true,
  targetKind: true,
  actor: true,
  occurredAt: true,
  expectedGeneration: true,
};

function assertRemoteCredentialsDomain(value: unknown): void {
  const root = requireRecord(value, "remoteCredentials");
  assertAllowedKeys(root, REMOTE_ROOT_KEYS, "remoteCredentials");
  if (
    root.version !== 1 ||
    !Array.isArray(root.pairingCodes) ||
    !Array.isArray(root.pendingLogins) ||
    !Array.isArray(root.clients)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority remoteCredentials domain is malformed");
  }
  root.pairingCodes.forEach((entry: unknown, index: number) =>
    assertRemotePairingCode(entry, `remoteCredentials.pairingCodes[${index}]`),
  );
  root.pendingLogins.forEach((entry: unknown, index: number) =>
    assertRemotePendingLogin(entry, `remoteCredentials.pendingLogins[${index}]`),
  );
  root.clients.forEach((entry: unknown, index: number) =>
    assertRemoteClient(entry, `remoteCredentials.clients[${index}]`),
  );
}

function assertRemotePairingCode(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, REMOTE_PAIRING_KEYS, label);
  requireStrings(record, ["codeId", "hostUrl", "secretHash", "createdAt", "expiresAt"], label);
  optionalStrings(record, ["clientLabel", "usedAt"], label);
  requireIntegers(record, ["attempts", "maxAttempts"], label);
}

function assertRemotePendingLogin(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, REMOTE_PENDING_KEYS, label);
  requireStrings(
    record,
    [
      "flowId",
      "hostUrl",
      "operatorCodeHash",
      "pendingRefreshHash",
      "pendingCompletionHash",
      "clientLabel",
      "createdAt",
      "codeExpiresAt",
      "flowExpiresAt",
      "operatorCodeFingerprint",
    ],
    label,
    ["operatorCodeFingerprint"],
  );
  assertOptionalEncryptedReplay(
    record.pendingRefreshReplay,
    `${label}.pendingRefreshReplay`,
    "encryptedResponse",
    REMOTE_PENDING_REPLAY_KEYS,
    ["refreshHash"],
  );
  assertOptionalEncryptedReplay(
    record.completionReplay,
    `${label}.completionReplay`,
    "encryptedCredentials",
    REMOTE_COMPLETION_REPLAY_KEYS,
    [],
  );
  requireEnums(
    record,
    ["status"],
    ["pending", "approved", "denied", "cancelled", "expired", "exchanged"],
    label,
  );
  assertSupersededRefreshTokens(
    record.supersededPendingRefreshHashes,
    `${label}.supersededPendingRefreshHashes`,
  );
}

function assertRemoteClient(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, REMOTE_CLIENT_KEYS, label);
  requireStrings(
    record,
    [
      "clientId",
      "clientLabel",
      "hostUrl",
      "accessTokenHash",
      "accessExpiresAt",
      "refreshTokenHash",
      "refreshFamilyId",
      "createdAt",
    ],
    label,
  );
  optionalStrings(record, ["lastUsedAt", "revokedAt"], label);
  requireEnums(record, ["role"], ["access", "operator"], label);
  assertSupersededRefreshTokens(
    record.supersededRefreshTokenHashes,
    `${label}.supersededRefreshTokenHashes`,
  );
}

function assertSupersededRefreshTokens(value: unknown, label: string): void {
  if (!Array.isArray(value))
    throw new CapletsError("CONFIG_INVALID", `Authority ${label} is malformed`);
  value.forEach((entry: unknown, index: number) => {
    const record = requireRecord(entry, `${label}[${index}]`);
    assertAllowedKeys(record, REMOTE_SUPERSEDED_KEYS, `${label}[${index}]`);
    requireStrings(record, ["hash", "supersededAt"], `${label}[${index}]`);
  });
}

function assertOptionalEncryptedReplay(
  value: unknown,
  label: string,
  encryptedKey: string,
  allowedKeys: Record<string, true>,
  requiredFields: readonly string[],
): void {
  if (value === undefined) return;
  const record = requireRecord(value, label);
  assertAllowedKeys(record, allowedKeys, label);
  requireStrings(record, ["expiresAt", ...requiredFields], label);
  if (record[encryptedKey] === undefined)
    throw new CapletsError("CONFIG_INVALID", `Authority ${label} is malformed`);
  assertEncryptedRecord(record[encryptedKey], `${label}.${encryptedKey}`);
}

function assertEncryptedRecord(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  const keys: Record<string, true> = {
    version: true,
    algorithm: true,
    nonce: true,
    ciphertext: true,
    authTag: true,
    valueBytes: true,
    createdAt: true,
    updatedAt: true,
  };
  assertAllowedKeys(record, keys, label);
  if (
    record.version !== 1 ||
    record.algorithm !== "aes-256-gcm" ||
    typeof record.nonce !== "string" ||
    typeof record.ciphertext !== "string" ||
    typeof record.authTag !== "string" ||
    !Number.isSafeInteger(record.valueBytes) ||
    record.valueBytes < 0
  ) {
    throw new CapletsError("CONFIG_INVALID", `Authority ${label} is not an encrypted Vault record`);
  }
  requireStrings(record, ["createdAt", "updatedAt"], label);
}

function assertSetupActivityDomain(value: unknown): void {
  if (!Array.isArray(value))
    throw new CapletsError("CONFIG_INVALID", "Authority setupActivity domain is malformed");
  value.forEach((entry: unknown, index: number) => {
    const label = `setupActivity[${index}]`;
    const record = requireRecord(entry, label);
    assertAllowedKeys(record, SETUP_ACTIVITY_KEYS, label);
    requireStrings(record, ["projectFingerprint", "capletId", "contentHash", "occurredAt"], label);
    requireEnums(record, ["kind"], ["setup_approval"], label);
    requireEnums(record, ["decision"], ["grant", "deny", "revoke"], label);
    requireEnums(record, ["targetKind"], ["local_host", "remote_host", "hosted_sandbox"], label);
    requireEnums(record, ["actor"], ["cli-interactive", "cli-yes", "ui", "automation"], label);
    assertExpectedGeneration(record.expectedGeneration, `${label}.expectedGeneration`);
  });
}

function assertExpectedGeneration(value: unknown, label: string): void {
  if (value === null) return;
  const record = requireRecord(value, label);
  const keys: Record<string, true> = {
    authorityId: true,
    id: true,
    sequence: true,
    predecessorId: true,
  };
  assertAllowedKeys(record, keys, label);
  requireStrings(record, ["authorityId", "id"], label);
  requireIntegers(record, ["sequence"], label);
  if (record.predecessorId !== null && typeof record.predecessorId !== "string") {
    throw new CapletsError("CONFIG_INVALID", `Authority ${label} is malformed`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) throw new CapletsError("CONFIG_INVALID", `Authority ${label} is malformed`);
  return value;
}

function assertAllowedKeys(
  record: Record<string, any>,
  allowed: Record<string, true>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed[key] !== true)
      throw new CapletsError("CONFIG_INVALID", `Unknown authority field in ${label}: ${key}`);
  }
}

function requireStrings(
  record: Record<string, any>,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  for (const key of keys) {
    if (typeof record[key] !== "string" && !(optional.includes(key) && record[key] === undefined)) {
      throw new CapletsError("CONFIG_INVALID", `Authority ${label}.${key} is malformed`);
    }
  }
}

function optionalStrings(
  record: Record<string, any>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of keys) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new CapletsError("CONFIG_INVALID", `Authority ${label}.${key} is malformed`);
    }
  }
}

function requireIntegers(
  record: Record<string, any>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of keys) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) {
      throw new CapletsError("CONFIG_INVALID", `Authority ${label}.${key} is malformed`);
    }
  }
}

function requireEnums(
  record: Record<string, any>,
  keys: readonly string[],
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  for (const key of keys) {
    if (record[key] === undefined && optional.includes(key)) continue;
    if (typeof record[key] !== "string" || !allowed.includes(record[key])) {
      throw new CapletsError("CONFIG_INVALID", `Authority ${label}.${key} is malformed`);
    }
  }
}

function canonicalDomainName(name: string): string {
  if (name === "records") return "caplets";
  if (name === "lockfile") return "lock";
  if (name === "vaultRecords" || name === "vaultGrants") return "vault";
  if (name === "oauthCredentials" || name === "oidcCredentials") return "oauth";
  if (name === "dashboardSessions" || name === "sessionTouches") return "sessions";
  if (name === "activities" || name === "successActivity") return "activity";
  if (name === "failedEvents" || name === "failedEventWatermark") return "security-events";
  return name;
}

function domainCount(name: string, value: unknown): number {
  if (name === "config" || name === "failedEventWatermark") return 1;
  if (name === "remoteCredentials" && isRecord(value)) {
    return (
      (Array.isArray(value.pairingCodes) ? value.pairingCodes.length : 0) +
      (Array.isArray(value.pendingLogins) ? value.pendingLogins.length : 0) +
      (Array.isArray(value.clients) ? value.clients.length : 0)
    );
  }
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return 1;
}

function redactedDigest(value: unknown): string {
  const encoded = stableJsonStringify(redactForDigest(value));
  if (typeof encoded !== "string")
    throw new CapletsError("CONFIG_INVALID", "Authority domain is not serializable");
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

function redactForDigest(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactForDigest(entry));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      output[nestedKey] = redactForDigest(nestedValue, nestedKey);
    }
    return output;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:secret|token|password|credential|private|keybytes|key_bytes|resolver|authorization)/iu.test(
    key,
  );
}
function buildMigratedState(
  source: AuthorityExport,
  target: { authorityId: string; provider: AuthorityProviderKind; namespace: string },
  targetSchemaVersion: number,
  options: MigrationOptions,
): AuthorityExport {
  const id = `migration-${randomUUID()}`;
  const snapshot = convertSnapshot(source.generation.snapshot, target.authorityId, id);
  const generation: AuthorityGeneration = {
    authorityId: target.authorityId,
    id,
    sequence: 1,
    predecessorId: null,
    schemaVersion: targetSchemaVersion,
    committedAt: (options.now ?? (() => new Date()))().toISOString(),
    provenance: { provider: target.provider, namespace: target.namespace },
    digest: "",
    snapshot,
  };
  generation.digest = digestForTarget(generation, target.provider);
  const targetGenerationIdentity: AuthorityGenerationIdentity = {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
  return {
    generation,
    auxiliaryWatermark: source.auxiliaryWatermark,
    ...(source.receipts
      ? {
          receipts: source.receipts.map((receipt) => {
            const cloned = structuredClone(receipt);
            return {
              ...cloned,
              generation: targetGenerationIdentity,
              result: cloned.result === undefined ? null : cloned.result,
            };
          }),
        }
      : {}),
    ...(source.auxiliary ? { auxiliary: normalizeAuxiliaryForTarget(source.auxiliary) } : {}),
  };
}
function normalizeAuxiliaryForTarget(value: AuthorityAuxiliaryExport): AuthorityAuxiliaryExport {
  const auxiliary = structuredClone(value);
  if (auxiliary.sessions === undefined) return auxiliary;
  if (!isRecord(auxiliary.sessions)) {
    throw new CapletsError("CONFIG_INVALID", "Authority auxiliary sessions are malformed");
  }
  const sessions: Record<string, AuthorityAuxiliarySession> = {};
  for (const [sessionId, rawSession] of Object.entries(auxiliary.sessions)) {
    if (
      !isRecord(rawSession) ||
      typeof rawSession.revision !== "string" ||
      typeof rawSession.lastUsedAt !== "string"
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Authority auxiliary session ${sessionId} is malformed`,
      );
    }
    if (rawSession.revoked !== undefined && typeof rawSession.revoked !== "boolean") {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Authority auxiliary session ${sessionId} is malformed`,
      );
    }
    sessions[sessionId] = {
      revision: rawSession.revision,
      lastUsedAt: rawSession.lastUsedAt,
      revoked: rawSession.revoked ?? false,
    };
  }
  auxiliary.sessions = sessions;
  return auxiliary;
}

function convertSnapshot(
  value: unknown,
  targetAuthorityId: string,
  generationId: string,
  recordId?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => convertSnapshot(entry, targetAuthorityId, generationId, recordId));
  }
  if (!isRecord(value)) return value;
  if (isProvenance(value)) {
    const stableRecordId = recordId ?? stableRecordIdentity(value);
    return {
      kind: "authority",
      authorityId: targetAuthorityId,
      recordId: stableRecordId,
      generationId,
    };
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedRecordId = key === "caplets" || key === "records" ? recordId : recordId;
    if ((key === "caplets" || key === "records") && isRecord(nested)) {
      const records: Record<string, unknown> = {};
      for (const [id, record] of Object.entries(nested)) {
        records[id] = convertSnapshot(record, targetAuthorityId, generationId, id);
      }
      output[key] = records;
      continue;
    }
    output[key] = convertSnapshot(nested, targetAuthorityId, generationId, nestedRecordId);
  }
  return output;
}

function isProvenance(value: Record<string, unknown>): boolean {
  return (
    typeof value.kind === "string" &&
    (value.kind === "global-config" ||
      value.kind === "global-file" ||
      value.kind === "project-config" ||
      value.kind === "project-file" ||
      value.kind === "authority") &&
    (typeof value.path === "string" || typeof value.authorityId === "string")
  );
}

function stableRecordIdentity(value: Record<string, unknown>): string {
  if (typeof value.recordId === "string") return value.recordId;
  if (typeof value.identity === "string") return value.identity;
  const encoded = stableJsonStringify({
    kind: value.kind,
    path: typeof value.path === "string" ? value.path : "",
  });
  return `record-${createHash("sha256")
    .update(encoded ?? "", "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

/** Provider-compatible digest for an already validated authority generation. */
export function authorityGenerationDigest(generation: AuthorityGeneration): string {
  return digestForTarget(generation, generation.provenance.provider);
}

function digestForTarget(generation: AuthorityGeneration, provider: AuthorityProviderKind): string {
  const payload = {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
    schemaVersion: generation.schemaVersion,
    committedAt: generation.committedAt,
    ...(provider === "sqlite" || provider === "postgresql"
      ? {}
      : { provenance: generation.provenance }),
    snapshot: generation.snapshot,
  };
  const encoded = stableJsonStringify(payload);
  return `sha256:${createHash("sha256")
    .update(encoded ?? "", "utf8")
    .digest("hex")}`;
}

/**
 * Adapt a WritableAuthority only when it exposes a real provider-owned
 * candidate lifecycle. RestoreState is intentionally never used as staging:
 * providers must keep an unselected candidate unreachable until publish.
 */
export function createWritableAuthorityMigrationAdapter(
  authority: WritableAuthority,
): MigrationTargetAdapter {
  const native = authority as WritableAuthority & Partial<AuthorityMigrationTarget>;
  if (
    typeof native.stageMigration === "function" &&
    typeof native.readMigrationStage === "function" &&
    typeof native.publishMigrationStage === "function" &&
    typeof native.invalidateMigrationStage === "function"
  ) {
    return {
      stageMigration: (state, context) => native.stageMigration!(state, context),
      readMigrationStage: (stage, context) => native.readMigrationStage!(stage, context),
      publishMigrationStage: (stage, context) => native.publishMigrationStage!(stage, context),
      invalidateMigrationStage: (stage, context) =>
        native.invalidateMigrationStage!(stage, context),
    };
  }

  const legacy = authority as WritableAuthority & {
    stageState?: MigrationTargetAdapter["stageMigration"];
    readStagedState?: MigrationTargetAdapter["readMigrationStage"];
    publishStagedState?: MigrationTargetAdapter["publishMigrationStage"];
    invalidateStagedState?: MigrationTargetAdapter["invalidateMigrationStage"];
  };
  if (
    typeof legacy.stageState === "function" &&
    typeof legacy.readStagedState === "function" &&
    typeof legacy.publishStagedState === "function" &&
    typeof legacy.invalidateStagedState === "function"
  ) {
    return {
      stageMigration: (state, context) => legacy.stageState!(state, context),
      readMigrationStage: (stage, context) => legacy.readStagedState!(stage, context),
      publishMigrationStage: (stage, context) => legacy.publishStagedState!(stage, context),
      invalidateMigrationStage: (stage, context) => legacy.invalidateStagedState!(stage, context),
    };
  }

  throw new CapletsError(
    "UNSUPPORTED_OPERATION",
    "Authority provider does not expose transactional migration staging",
  );
}

function assertStagedStateMatches(expected: AuthorityExport, actual: AuthorityExport): void {
  validateExport(actual);
  if (
    actual.generation.authorityId !== expected.generation.authorityId ||
    actual.generation.id !== expected.generation.id ||
    actual.generation.sequence !== expected.generation.sequence ||
    actual.generation.predecessorId !== expected.generation.predecessorId ||
    actual.generation.schemaVersion !== expected.generation.schemaVersion ||
    actual.generation.digest !== expected.generation.digest
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Staged destination read-back does not match the canonical migration state",
    );
  }
  if (
    Boolean(expected.receipts) !== Boolean(actual.receipts) ||
    (expected.receipts &&
      actual.receipts &&
      authorityExportDigest({
        generation: actual.generation,
        auxiliaryWatermark: actual.auxiliaryWatermark,
        receipts: actual.receipts,
      }) !==
        authorityExportDigest({
          generation: expected.generation,
          auxiliaryWatermark: expected.auxiliaryWatermark,
          receipts: expected.receipts,
        }))
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Staged destination receipts do not match the canonical migration state",
    );
  }
  if (
    Boolean(expected.auxiliary) !== Boolean(actual.auxiliary) ||
    (expected.auxiliary &&
      actual.auxiliary &&
      stableJsonStringify(actual.auxiliary) !== stableJsonStringify(expected.auxiliary))
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Staged destination auxiliary state does not match the canonical migration state",
    );
  }
}

async function readPublishedState(
  authority: WritableAuthority,
  expected: AuthorityExport,
): Promise<boolean> {
  const head = await authority.readHead();
  if (!head || !sameHead(head, expected.generation)) return false;
  const generation = await authority.readGeneration(head.id);
  if (!generation || generation.digest !== expected.generation.digest) return false;
  const actual = await authority.exportState();
  assertStagedStateMatches(expected, actual);
  return true;
}

async function assertStagedCollisions(
  authority: WritableAuthority,
  state: AuthorityExport,
): Promise<void> {
  const snapshot = state.generation.snapshot;
  if (!isRecord(snapshot)) return;
  const records = snapshot.caplets ?? snapshot.records;
  const ids: string[] = [];
  if (Array.isArray(records)) {
    for (const record of records) {
      if (!isRecord(record) || typeof record.id !== "string" || record.id.length === 0) {
        throw new CapletsError("CONFIG_INVALID", "Authority Caplet record identity is malformed");
      }
      ids.push(record.id);
    }
  } else if (isRecord(records)) {
    ids.push(...Object.keys(records));
  }
  const candidate = authority as WritableAuthority & {
    assertCapletIdAvailable?: (id: string) => Promise<void> | void;
    assertStagedIdsAvailable?: (ids: readonly string[]) => Promise<void> | void;
  };
  if (candidate.assertStagedIdsAvailable) {
    await candidate.assertStagedIdsAvailable(ids);
    return;
  }
  if (candidate.assertCapletIdAvailable) {
    for (const id of ids) await candidate.assertCapletIdAvailable(id);
  }
}

async function assertSourceFence(
  fence: MaintenanceFence,
  context: MaintenanceFenceContext,
): Promise<void> {
  if (fence.assertReadOnly) {
    await fence.assertReadOnly(context);
    return;
  }
  if (fence.assertStopped) {
    await fence.assertStopped(context);
    return;
  }
  throw new CapletsError(
    "UNSUPPORTED_OPERATION",
    "Source migration fence cannot prove stopped or read-only state",
  );
}

async function releaseFence(
  fence: MaintenanceFence,
  lease: MaintenanceFenceLease | void,
  context: MaintenanceFenceContext,
): Promise<AuthorityLifecycleDiagnostic | undefined> {
  let failed = false;
  try {
    if (fence.release) {
      await fence.release(lease, context);
    } else if (lease && typeof lease.release === "function") {
      await lease.release();
    }
  } catch {
    failed = true;
  }
  if (!failed) return undefined;

  // A fence implementation may fail after clearing its provider record but
  // before completing local teardown. Retry the lease-owned local release
  // once, without allowing cleanup failure to replace verified success.
  if (fence.release && lease && typeof lease.release === "function") {
    try {
      await lease.release();
    } catch {
      // The warning below is intentionally the only surfaced cleanup result.
    }
  }
  return {
    code: "MAINTENANCE_FENCE_RELEASE_FAILED",
    severity: "warning",
    operation: context.operation,
    phase: "cleanup",
    retryable: false,
    message: `${context.operation} completed and was verified, but ${context.role} maintenance fence cleanup failed; do not retry the operation automatically.`,
  };
}

async function safeHealth(authority: WritableAuthority, label: string): Promise<AuthorityHealth> {
  const health = await authority.health();
  if (!health || typeof health.authorityId !== "string" || typeof health.provider !== "string") {
    throw new CapletsError("CONFIG_INVALID", `${label} authority health is malformed`);
  }
  return health;
}

async function assertHealthyWritable(authority: WritableAuthority, label: string): Promise<void> {
  const health = await safeHealth(authority, label);
  if (health.connectivity !== "healthy" || !health.writable) {
    throw new CapletsError("SERVER_UNAVAILABLE", `${label} authority is not healthy and writable`);
  }
}

function sourceNamespaceFor(authority: WritableAuthority, health: AuthorityHealth): string {
  const candidate = authority as WritableAuthority & { namespace?: unknown };
  return typeof candidate.namespace === "string"
    ? candidate.namespace
    : health.activeGeneration
      ? "default"
      : "default";
}

function targetNamespaceFor(
  authority: WritableAuthority,
  health: AuthorityHealth,
  fallback: string,
): string {
  const candidate = authority as WritableAuthority & { namespace?: unknown };
  return typeof candidate.namespace === "string" ? candidate.namespace : fallback;
}

function resolveTargetSchemaVersion(
  authority: WritableAuthority,
  explicit: number | undefined,
): number {
  const capability = authority.schemaVersion;
  if (explicit !== undefined) {
    if (!Number.isSafeInteger(explicit) || explicit < 1) {
      throw new CapletsError("CONFIG_INVALID", "Target authority schema version is invalid");
    }
    if (capability !== undefined && capability !== explicit) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Target authority schema version override is incompatible",
      );
    }
    return explicit;
  }
  if (typeof capability !== "number" || !Number.isSafeInteger(capability) || capability < 1) {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "Target authority does not expose a logical schema version",
    );
  }
  return capability;
}

function sameHead(head: AuthorityHead, generation: AuthorityGeneration): boolean {
  return (
    head.authorityId === generation.authorityId &&
    head.id === generation.id &&
    head.sequence === generation.sequence &&
    head.predecessorId === generation.predecessorId &&
    head.digest === generation.digest
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
