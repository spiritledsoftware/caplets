import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";

export const RECOVERY_ENVELOPE_VERSION = 1 as const;
export const RECOVERY_ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
export const DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT = 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const CANONICAL_ASCII_ID_PATTERN = /^[\x21-\x7e]{1,256}$/u;

export type RecoveryKeyReference = Readonly<{
  provider: string;
  providerIdentity: string;
  logicalHostId: string;
  storeId: string;
  profile: string;
  purpose: "backup-recovery";
  keyId: string;
  keyVersion: number;
}>;

export interface RecoveryWrapAuthority {
  readonly reference: RecoveryKeyReference;
  wrapDataKey(dataKey: Uint8Array): Promise<Uint8Array>;
}

export interface RecoveryUnwrapAuthority {
  readonly reference: RecoveryKeyReference;
  unwrapDataKey(wrappedDataKey: Uint8Array): Promise<Uint8Array>;
}

export type RecoverySchemaChecksum = Readonly<{
  name: string;
  sha256: string;
}>;

export type RecoveryEntityManifestEntry = Readonly<{
  entity: string;
  count: number;
  sha256: string;
}>;

/** Every value needed to prove a bundle belongs to one exact source authority. */
export type RecoveryEnvelopeBinding = Readonly<{
  logicalHostId: string;
  storeId: string;
  sourceBackend: "sqlite" | "postgres";
  requiredSchemaNames: readonly string[];
  schemaChecksums: readonly RecoverySchemaChecksum[];
  authorityToken: string;
  effectiveToken: string;
  securityToken: string;
  requiredEntityNames: readonly string[];
  entityManifest: readonly RecoveryEntityManifestEntry[];
  recoveryKeyReference: RecoveryKeyReference;
}>;

export type RecoveryEnvelopeHeader = Readonly<{
  type: "header";
  version: typeof RECOVERY_ENVELOPE_VERSION;
  algorithm: typeof RECOVERY_ENVELOPE_ALGORITHM;
  chunkPlaintextLimit: number;
  noncePrefix: string;
  wrappedKeyDigest: string;
  binding: RecoveryEnvelopeBinding;
}>;

export type RecoveryEnvelopeChunkMetadata = Readonly<{
  ordinal: number;
  plaintextLength: number;
  priorDigest: string;
  digest: string;
}>;

export type RecoveryEnvelopeChunkFrame = RecoveryEnvelopeChunkMetadata &
  Readonly<{
    type: "chunk";
    ciphertext: string;
    authenticationTag: string;
  }>;

export type RecoveryEnvelopeTerminalManifest = Readonly<{
  version: typeof RECOVERY_ENVELOPE_VERSION;
  headerDigest: string;
  chunkCount: number;
  plaintextLength: number;
  orderedChunkMetadataDigest: string;
  lastChunkDigest: string;
}>;

export type RecoveryEnvelopeTerminalFrame = Readonly<{
  type: "terminal";
  manifest: RecoveryEnvelopeTerminalManifest;
  authenticationTag: string;
}>;

export function assertRecoveryEnvelopeBinding(
  value: RecoveryEnvelopeBinding,
): asserts value is RecoveryEnvelopeBinding {
  assertCanonicalAsciiId(value.logicalHostId);
  assertCanonicalAsciiId(value.storeId);
  if (value.sourceBackend !== "sqlite" && value.sourceBackend !== "postgres") {
    throw invalidManifest();
  }
  assertCanonicalAsciiId(value.authorityToken);
  assertCanonicalAsciiId(value.effectiveToken);
  assertCanonicalAsciiId(value.securityToken);
  assertRecoveryKeyReference(value.recoveryKeyReference);
  if (
    value.recoveryKeyReference.logicalHostId !== value.logicalHostId ||
    value.recoveryKeyReference.storeId !== value.storeId
  ) {
    throw invalidManifest();
  }
  assertRequiredNames(value.requiredSchemaNames);
  assertCanonicalNamedEntries(
    value.schemaChecksums,
    (entry) => {
      if (!SAFE_NAME_PATTERN.test(entry.name) || !SHA256_PATTERN.test(entry.sha256)) {
        throw invalidManifest();
      }
    },
    (entry) => entry.name,
  );
  assertExactCoverage(
    value.requiredSchemaNames,
    value.schemaChecksums.map((entry) => entry.name),
  );
  assertRequiredNames(value.requiredEntityNames);
  assertCanonicalNamedEntries(
    value.entityManifest,
    (entry) => {
      if (
        !SAFE_NAME_PATTERN.test(entry.entity) ||
        !Number.isSafeInteger(entry.count) ||
        entry.count < 0 ||
        !SHA256_PATTERN.test(entry.sha256)
      ) {
        throw invalidManifest();
      }
    },
    (entry) => entry.entity,
  );
  assertExactCoverage(
    value.requiredEntityNames,
    value.entityManifest.map((entry) => entry.entity),
  );
}

export function assertRecoveryKeyReference(
  value: RecoveryKeyReference,
): asserts value is RecoveryKeyReference {
  assertCanonicalAsciiId(value.provider);
  assertCanonicalAsciiId(value.providerIdentity);
  assertCanonicalAsciiId(value.logicalHostId);
  assertCanonicalAsciiId(value.storeId);
  assertCanonicalAsciiId(value.profile);
  assertCanonicalAsciiId(value.keyId);
  if (
    value.purpose !== "backup-recovery" ||
    !Number.isSafeInteger(value.keyVersion) ||
    value.keyVersion < 1
  ) {
    throw invalidManifest();
  }
}

export function sameRecoveryKeyReference(
  left: RecoveryKeyReference,
  right: RecoveryKeyReference,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function sameRecoveryEnvelopeBinding(
  left: RecoveryEnvelopeBinding,
  right: RecoveryEnvelopeBinding,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function recoveryEnvelopeBindingDigest(binding: RecoveryEnvelopeBinding): string {
  assertRecoveryEnvelopeBinding(binding);
  return sha256(canonicalBytes(binding));
}

export function createRecoveryEnvelopeHeader(
  input: Readonly<{
    binding: RecoveryEnvelopeBinding;
    noncePrefix: Uint8Array;
    wrappedKeyDigest: string;
    chunkPlaintextLimit?: number | undefined;
  }>,
): RecoveryEnvelopeHeader {
  assertRecoveryEnvelopeBinding(input.binding);
  const chunkPlaintextLimit = input.chunkPlaintextLimit ?? DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT;
  if (
    input.noncePrefix.byteLength !== 4 ||
    !SHA256_PATTERN.test(input.wrappedKeyDigest) ||
    !Number.isSafeInteger(chunkPlaintextLimit) ||
    chunkPlaintextLimit < 1 ||
    chunkPlaintextLimit > DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT
  ) {
    throw invalidManifest();
  }
  return {
    type: "header",
    version: RECOVERY_ENVELOPE_VERSION,
    algorithm: RECOVERY_ENVELOPE_ALGORITHM,
    chunkPlaintextLimit,
    noncePrefix: Buffer.from(input.noncePrefix).toString("base64"),
    wrappedKeyDigest: input.wrappedKeyDigest,
    binding: structuredClone(input.binding),
  };
}

export function assertRecoveryEnvelopeHeader(
  value: RecoveryEnvelopeHeader,
): asserts value is RecoveryEnvelopeHeader {
  if (
    value.type !== "header" ||
    value.version !== RECOVERY_ENVELOPE_VERSION ||
    value.algorithm !== RECOVERY_ENVELOPE_ALGORITHM ||
    !Number.isSafeInteger(value.chunkPlaintextLimit) ||
    value.chunkPlaintextLimit < 1 ||
    value.chunkPlaintextLimit > DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT ||
    !SHA256_PATTERN.test(value.wrappedKeyDigest)
  ) {
    throw invalidManifest();
  }
  const noncePrefix = decodeCanonicalBase64(value.noncePrefix);
  if (noncePrefix.byteLength !== 4) throw invalidManifest();
  assertRecoveryEnvelopeBinding(value.binding);
}

export function recoveryEnvelopeHeaderDigest(header: RecoveryEnvelopeHeader): string {
  assertRecoveryEnvelopeHeader(header);
  return sha256(canonicalBytes(header));
}

export function recoveryChunkAssociatedData(
  input: Readonly<{
    headerDigest: string;
    ordinal: number;
    plaintextLength: number;
    priorDigest: string;
  }>,
): Buffer {
  assertChunkPosition(input);
  return canonicalBytes({
    domain: "caplets/recovery-envelope/chunk",
    version: RECOVERY_ENVELOPE_VERSION,
    headerDigest: input.headerDigest,
    ordinal: input.ordinal,
    plaintextLength: input.plaintextLength,
    priorDigest: input.priorDigest,
  });
}

export function recoveryChunkDigest(
  input: Readonly<{
    associatedData: Uint8Array;
    ciphertext: Uint8Array;
    authenticationTag: Uint8Array;
  }>,
): string {
  if (input.authenticationTag.byteLength !== 16) throw invalidManifest();
  const hash = createHash("sha256");
  hash.update(input.associatedData);
  hash.update(input.ciphertext);
  hash.update(input.authenticationTag);
  return hash.digest("hex");
}

export function recoveryTerminalAssociatedData(manifest: RecoveryEnvelopeTerminalManifest): Buffer {
  assertRecoveryTerminalManifest(manifest);
  return canonicalBytes({
    domain: "caplets/recovery-envelope/terminal",
    version: RECOVERY_ENVELOPE_VERSION,
    manifest,
  });
}

export function recoveryTerminalManifestDigest(manifest: RecoveryEnvelopeTerminalManifest): string {
  return sha256(recoveryTerminalAssociatedData(manifest));
}

export function assertRecoveryTerminalManifest(
  manifest: RecoveryEnvelopeTerminalManifest,
): asserts manifest is RecoveryEnvelopeTerminalManifest {
  if (
    manifest.version !== RECOVERY_ENVELOPE_VERSION ||
    !SHA256_PATTERN.test(manifest.headerDigest) ||
    !Number.isSafeInteger(manifest.chunkCount) ||
    manifest.chunkCount < 0 ||
    !Number.isSafeInteger(manifest.plaintextLength) ||
    manifest.plaintextLength < 0 ||
    !SHA256_PATTERN.test(manifest.orderedChunkMetadataDigest) ||
    !SHA256_PATTERN.test(manifest.lastChunkDigest) ||
    (manifest.chunkCount === 0 && manifest.lastChunkDigest !== manifest.headerDigest)
  ) {
    throw invalidManifest();
  }
}

export function recoveryChunkNonce(noncePrefix: Uint8Array, ordinal: number): Buffer {
  if (noncePrefix.byteLength !== 4 || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw invalidManifest();
  }
  const nonce = Buffer.allocUnsafe(12);
  Buffer.from(noncePrefix).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(ordinal), 4);
  return nonce;
}

export function recoveryTerminalNonce(noncePrefix: Uint8Array): Buffer {
  if (noncePrefix.byteLength !== 4) throw invalidManifest();
  const nonce = Buffer.alloc(12, 0xff);
  Buffer.from(noncePrefix).copy(nonce, 0);
  return nonce;
}

export function decodeRecoveryBase64(value: string): Buffer {
  return decodeCanonicalBase64(value);
}

export function canonicalRecoveryBytes(value: unknown): Buffer {
  return canonicalBytes(value);
}

export function sha256RecoveryBytes(value: Uint8Array): string {
  return sha256(value);
}

function assertChunkPosition(
  input: Readonly<{
    headerDigest: string;
    ordinal: number;
    plaintextLength: number;
    priorDigest: string;
  }>,
): void {
  if (
    !SHA256_PATTERN.test(input.headerDigest) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    !Number.isSafeInteger(input.plaintextLength) ||
    input.plaintextLength < 0 ||
    input.plaintextLength > DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT ||
    !SHA256_PATTERN.test(input.priorDigest)
  ) {
    throw invalidManifest();
  }
}

function assertCanonicalNamedEntries<T>(
  entries: readonly T[],
  validate: (entry: T) => void,
  name: (entry: T) => string,
): void {
  let prior: string | undefined;
  for (const entry of entries) {
    validate(entry);
    const current = name(entry);
    if (prior !== undefined && prior >= current) throw invalidManifest();
    prior = current;
  }
}

function assertRequiredNames(names: readonly string[]): void {
  if (names.length === 0) throw invalidManifest();
  assertCanonicalNamedEntries(
    names,
    (name) => {
      if (!SAFE_NAME_PATTERN.test(name)) throw invalidManifest();
    },
    (name) => name,
  );
}

function assertExactCoverage(required: readonly string[], actual: readonly string[]): void {
  if (required.length !== actual.length) throw invalidManifest();
  for (let index = 0; index < required.length; index += 1) {
    if (required[index] !== actual[index]) throw invalidManifest();
  }
}

function assertCanonicalAsciiId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_ASCII_ID_PATTERN.test(value)) {
    throw invalidManifest();
  }
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(stableJsonStringify(value), "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeCanonicalBase64(value: string): Buffer {
  if (typeof value !== "string" || value.length === 0) throw invalidManifest();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw invalidManifest();
  return decoded;
}

function invalidManifest(): CapletsError {
  return new CapletsError("AUTH_FAILED", "Recovery envelope verification failed.");
}

export const SQL_TRANSFER_MANIFEST_FORMAT = "caplets-sql-transfer-manifest-v1" as const;
export const MAX_SQL_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
export const SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES = [
  "normalized-state",
  "portable-projection",
  "effective-projection",
  "provenance",
  "activity",
  "consumed-operations",
  "lifecycle-ledgers",
] as const;

export type SqlTransferSemanticDomainName = (typeof SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES)[number];

export type SqlTransferIdentity = Readonly<{
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
}>;

export type SqlTransferDescriptorBinding = Readonly<{
  backend: "sqlite" | "postgres";
  descriptorDigest: string;
  keyProviderIdentity: string;
}>;

export type SqlTransferSemanticDomain = Readonly<{
  name: SqlTransferSemanticDomainName;
  count: number;
  sha256: string;
}>;

/**
 * Secret-free semantic commitment shared by the source ledger, destination ledger, recovery
 * backup, descriptor transition, and transfer-only key capabilities.
 */
export type SqlTransferSemanticManifest = Readonly<{
  format: typeof SQL_TRANSFER_MANIFEST_FORMAT;
  transferId: string;
  identity: SqlTransferIdentity;
  source: SqlTransferDescriptorBinding & Readonly<{ backend: "sqlite" }>;
  destination: SqlTransferDescriptorBinding & Readonly<{ backend: "postgres" }>;
  schemaDigest: string;
  semanticDomains: readonly SqlTransferSemanticDomain[];
  sourceAuthorityGeneration: number;
  sourceSecurityEpoch: number;
  sourceWriterEpoch: number;
  destinationAuthorityGeneration: number;
  projectedSecurityEpoch: number;
  invalidationDigest: string;
  expectedSealedSourceDigest: string;
  chunkCount: number;
  totalBytes: number;
  maxChunkBytes: number;
  requiredDestinationNodeIds: readonly string[];
}>;

export function assertSqlTransferSemanticManifest(
  value: SqlTransferSemanticManifest,
): asserts value is SqlTransferSemanticManifest {
  try {
    assertExactTransferKeys(value, [
      "format",
      "transferId",
      "identity",
      "source",
      "destination",
      "schemaDigest",
      "semanticDomains",
      "sourceAuthorityGeneration",
      "sourceSecurityEpoch",
      "sourceWriterEpoch",
      "destinationAuthorityGeneration",
      "projectedSecurityEpoch",
      "invalidationDigest",
      "expectedSealedSourceDigest",
      "chunkCount",
      "totalBytes",
      "maxChunkBytes",
      "requiredDestinationNodeIds",
    ]);
    if (
      value.format !== SQL_TRANSFER_MANIFEST_FORMAT ||
      !CANONICAL_ASCII_ID_PATTERN.test(value.transferId)
    ) {
      throw new Error("invalid transfer header");
    }
    assertTransferIdentity(value.identity);
    assertTransferDescriptor(value.source, "sqlite");
    assertTransferDescriptor(value.destination, "postgres");
    assertTransferHash(value.schemaDigest);
    assertTransferHash(value.invalidationDigest);
    assertTransferHash(value.expectedSealedSourceDigest);
    assertTransferVersion(value.sourceAuthorityGeneration);
    assertTransferVersion(value.sourceSecurityEpoch);
    assertTransferVersion(value.sourceWriterEpoch);
    assertTransferVersion(value.destinationAuthorityGeneration);
    assertTransferVersion(value.projectedSecurityEpoch);
    if (
      value.destinationAuthorityGeneration !== value.sourceAuthorityGeneration + 1 ||
      value.projectedSecurityEpoch <= value.sourceSecurityEpoch
    ) {
      throw new Error("invalid authority projection");
    }
    assertTransferSize(value.chunkCount, true);
    assertTransferSize(value.totalBytes, true);
    assertTransferSize(value.maxChunkBytes, false);
    if (
      value.maxChunkBytes > MAX_SQL_TRANSFER_CHUNK_BYTES ||
      (value.chunkCount === 0) !== (value.totalBytes === 0) ||
      value.totalBytes > value.chunkCount * value.maxChunkBytes
    ) {
      throw new Error("invalid chunk bounds");
    }
    if (
      !Array.isArray(value.semanticDomains) ||
      value.semanticDomains.length !== SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES.length
    ) {
      throw new Error("invalid semantic coverage");
    }
    for (const [index, domain] of value.semanticDomains.entries()) {
      assertExactTransferKeys(domain, ["name", "count", "sha256"]);
      if (domain.name !== SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES[index]) {
        throw new Error("non-canonical semantic domain");
      }
      assertTransferSize(domain.count, true);
      assertTransferHash(domain.sha256);
    }
    assertCanonicalTransferNodeIds(value.requiredDestinationNodeIds);
  } catch {
    throw invalidTransferManifest();
  }
}

export function sqlTransferManifestCanonicalBytes(manifest: SqlTransferSemanticManifest): Buffer {
  assertSqlTransferSemanticManifest(manifest);
  return canonicalBytes({
    domain: "caplets/sqlite-to-postgres-transfer/manifest/v1",
    manifest,
  });
}

export function sqlTransferManifestDigest(manifest: SqlTransferSemanticManifest): string {
  return sha256(sqlTransferManifestCanonicalBytes(manifest));
}

export function sameSqlTransferSemanticManifest(
  left: SqlTransferSemanticManifest,
  right: SqlTransferSemanticManifest,
): boolean {
  assertSqlTransferSemanticManifest(left);
  assertSqlTransferSemanticManifest(right);
  return isDeepStrictEqual(left, right);
}

function assertTransferIdentity(identity: SqlTransferIdentity): void {
  assertExactTransferKeys(identity, ["logicalHostId", "storeId", "operationNamespace"]);
  if (
    !CANONICAL_ASCII_ID_PATTERN.test(identity.logicalHostId) ||
    !CANONICAL_ASCII_ID_PATTERN.test(identity.storeId) ||
    !CANONICAL_ASCII_ID_PATTERN.test(identity.operationNamespace)
  ) {
    throw new Error("invalid transfer identity");
  }
}

function assertTransferDescriptor(
  descriptor: SqlTransferDescriptorBinding,
  backend: "sqlite" | "postgres",
): void {
  assertExactTransferKeys(descriptor, ["backend", "descriptorDigest", "keyProviderIdentity"]);
  if (
    descriptor.backend !== backend ||
    !CANONICAL_ASCII_ID_PATTERN.test(descriptor.keyProviderIdentity)
  ) {
    throw new Error("invalid transfer descriptor");
  }
  assertTransferHash(descriptor.descriptorDigest);
}

function assertCanonicalTransferNodeIds(nodeIds: readonly string[]): void {
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw new Error("insufficient destination readiness set");
  }
  let previous: string | undefined;
  for (const nodeId of nodeIds) {
    if (
      !CANONICAL_ASCII_ID_PATTERN.test(nodeId) ||
      (previous !== undefined && nodeId <= previous)
    ) {
      throw new Error("non-canonical destination readiness set");
    }
    previous = nodeId;
  }
}

function assertTransferHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("invalid transfer digest");
  }
}

function assertTransferVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("invalid transfer version");
  }
}

function assertTransferSize(value: unknown, allowZero: boolean): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new Error("invalid transfer size");
  }
}

function assertExactTransferKeys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid transfer object");
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error("invalid transfer fields");
  }
}

function invalidTransferManifest(): CapletsError {
  return new CapletsError("AUTH_FAILED", "SQL transfer manifest verification failed.");
}
