import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityExport,
  AuthorityGeneration,
  AuthorityLifecycleDiagnostic,
  AuthorityProviderKind,
  AuthorityRestoreResult,
  WritableAuthority,
} from "./types";
import {
  authorityGenerationDigest,
  type MaintenanceFence,
  type MaintenanceFenceContext,
  type MaintenanceFenceLease,
} from "./migration";

const BACKUP_MAGIC = Buffer.from("CAPLETS-AUTHORITY-BACKUP\\0", "utf8");
const BACKUP_FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm" as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

type BackupAlgorithm = typeof ALGORITHM;

export type BackupKeyMaterial =
  | Uint8Array
  | string
  | {
      key: Uint8Array | string;
    };

export type AuthorityBackupHeader = {
  magic: "caplets-authority-backup";
  formatVersion: 1;
  algorithm: BackupAlgorithm;
  provider: AuthorityProviderKind;
  authorityId: string;
  namespace: string;
  schemaVersion: number;
  generationId: string;
  generationSequence: number;
  generationPredecessorId: string | null;
  generationDigest: string;
  auxiliaryWatermark: string;
  keyFingerprint: string;
};

export type AuthorityBackup = {
  bytes: Uint8Array;
  header: AuthorityBackupHeader;
};

export type CreateAuthorityBackupOptions = {
  key: BackupKeyMaterial;
};

export type RestoreAuthorityBackupOptions = {
  key: BackupKeyMaterial;
  fence?: MaintenanceFence;
  targetFence?: MaintenanceFence;
  targetNamespace?: string;
  expectedSchemaVersion?: number;
  owner?: string;
};

export type DecodedAuthorityBackup = {
  header: AuthorityBackupHeader;
  state: AuthorityExport;
};

/** Create an authenticated-header, AES-GCM encrypted authority backup. */
export async function createAuthorityBackup(
  authority: WritableAuthority,
  options: CreateAuthorityBackupOptions,
): Promise<AuthorityBackup> {
  const key = normalizeBackupKey(options.key);
  const state = await authority.exportState();
  validateExport(state);
  const generation = state.generation;
  const header = makeHeader(generation, state.auxiliaryWatermark, fingerprint(key));
  const headerBytes = encodeHeader(header);
  const aad = authenticatedHeaderBytes(headerBytes);
  const body = stableJsonStringify({ export: state });
  if (typeof body !== "string")
    throw new CapletsError("CONFIG_INVALID", "Authority export is not serializable");
  const bodyBytes = Buffer.from(body, "utf8");
  if (bodyBytes.byteLength > MAX_BACKUP_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup exceeds the 64 MiB limit");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bodyBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bytes = Buffer.concat([
    BACKUP_MAGIC,
    encodeLength(headerBytes.byteLength),
    headerBytes,
    nonce,
    tag,
    ciphertext,
  ]);
  return { bytes, header };
}

/** Parse and authenticate an authority backup using the externally supplied key. */
export async function decodeAuthorityBackup(
  input: AuthorityBackup | Uint8Array,
  keyMaterial: BackupKeyMaterial,
): Promise<DecodedAuthorityBackup> {
  const key = normalizeBackupKey(keyMaterial);
  const bytes = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(input.bytes);
  if (bytes.byteLength < BACKUP_MAGIC.byteLength + 4 + NONCE_BYTES + TAG_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup is truncated");
  }
  if (!bytes.subarray(0, BACKUP_MAGIC.byteLength).equals(BACKUP_MAGIC)) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup magic is invalid");
  }
  const headerLength = bytes.readUInt32BE(BACKUP_MAGIC.byteLength);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup header length is invalid");
  }
  const headerStart = BACKUP_MAGIC.byteLength + 4;
  const headerEnd = headerStart + headerLength;
  const nonceStart = headerEnd;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  if (ciphertextStart > bytes.byteLength) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup is truncated");
  }
  const headerBytes = bytes.subarray(headerStart, headerEnd);
  const header = parseHeader(headerBytes);
  if (header.keyFingerprint !== fingerprint(key)) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Authority backup key does not match authenticated key fingerprint",
    );
  }
  const nonce = bytes.subarray(nonceStart, tagStart);
  const tag = bytes.subarray(tagStart, ciphertextStart);
  const ciphertext = bytes.subarray(ciphertextStart);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(authenticatedHeaderBytes(headerBytes));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.export)) {
      throw new Error("backup body shape");
    }
    const state = parsed.export as AuthorityExport;
    validateExport(state);
    if (authorityGenerationDigest(state.generation) !== state.generation.digest) {
      throw new Error("backup generation digest");
    }
    assertHeaderMatchesState(header, state);
    return { header, state };
  } catch {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup authentication or body decoding failed",
    );
  }
}

/** Restore a verified backup to an empty authority under a real maintenance fence. */
export async function restoreAuthorityBackup(
  authority: WritableAuthority,
  input: AuthorityBackup | Uint8Array,
  options: RestoreAuthorityBackupOptions,
): Promise<AuthorityRestoreResult> {
  const decoded = await decodeAuthorityBackup(input, options.key);
  const health = await authority.health();
  const namespace =
    options.targetNamespace ?? authorityNamespace(authority, decoded.header.namespace);
  if (health.authorityId !== decoded.header.authorityId) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup identity does not match restore target",
    );
  }
  if (health.provider !== decoded.header.provider) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup provider does not match restore target",
    );
  }
  if (namespace !== decoded.header.namespace) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup namespace does not match restore target",
    );
  }
  const targetSchemaVersion = options.expectedSchemaVersion ?? schemaVersionOf(authority);
  if (targetSchemaVersion !== undefined && targetSchemaVersion !== decoded.header.schemaVersion) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup schema version does not match restore target",
    );
  }
  if (health.connectivity !== "healthy" || !health.writable) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Restore target authority is not healthy and writable",
    );
  }
  if ((await authority.readHead()) !== null) {
    throw new CapletsError("CONFIG_EXISTS", "Restore target authority must be empty");
  }
  const fence = options.targetFence ?? options.fence ?? authority.maintenanceFence?.();
  if (!fence) {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "Authority restore requires a destination maintenance fence",
    );
  }
  const owner = options.owner ?? `restore-${randomBytes(8).toString("hex")}`;
  const context: MaintenanceFenceContext = {
    operation: "restore",
    role: "destination",
    authorityId: health.authorityId,
    namespace,
    owner,
  };
  let completedRestore: AuthorityRestoreResult | undefined;
  const lease = await fence.acquire(context);
  try {
    if ((await authority.readHead()) !== null) {
      throw new CapletsError("CONFIG_EXISTS", "Restore target authority must remain empty");
    }
    let restoreResult: AuthorityRestoreResult;
    try {
      restoreResult = await authority.restoreState(decoded.state);
    } catch (error) {
      const head = await authority.readHead().catch(() => null);
      if (head) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Authority restore was interrupted after publication",
        );
      }
      throw error;
    }
    const head = await authority.readHead();
    if (
      !head ||
      head.id !== decoded.state.generation.id ||
      head.digest !== decoded.state.generation.digest
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Authority restore read-back does not match authenticated backup",
      );
    }
    const generation = await authority.readGeneration(head.id);
    if (
      generation.digest !== decoded.state.generation.digest ||
      authorityGenerationDigest(generation) !== generation.digest
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Authority restore generation digest does not match authenticated backup",
      );
    }
    if (
      restoreResult.generation.authorityId !== decoded.state.generation.authorityId ||
      restoreResult.generation.id !== decoded.state.generation.id ||
      restoreResult.generation.sequence !== decoded.state.generation.sequence ||
      restoreResult.generation.predecessorId !== decoded.state.generation.predecessorId ||
      restoreResult.auxiliaryWatermark !== decoded.state.auxiliaryWatermark
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Authority restore result does not preserve generation or auxiliary watermark",
      );
    }
    completedRestore = restoreResult;
    return completedRestore;
  } finally {
    const diagnostic = await releaseFence(fence, lease, context);
    if (diagnostic && completedRestore) {
      completedRestore.diagnostics = [...(completedRestore.diagnostics ?? []), diagnostic];
    }
  }
}

/** Stable path-independent header reader for operator previews. */
export function readAuthorityBackupHeader(
  input: AuthorityBackup | Uint8Array,
): AuthorityBackupHeader {
  const bytes = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(input.bytes);
  if (bytes.byteLength < BACKUP_MAGIC.byteLength + 4) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup is truncated");
  }
  if (!bytes.subarray(0, BACKUP_MAGIC.byteLength).equals(BACKUP_MAGIC)) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup magic is invalid");
  }
  const headerLength = bytes.readUInt32BE(BACKUP_MAGIC.byteLength);
  const start = BACKUP_MAGIC.byteLength + 4;
  const end = start + headerLength;
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || end > bytes.byteLength) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup header length is invalid");
  }
  return parseHeader(bytes.subarray(start, end));
}

function makeHeader(
  generation: AuthorityGeneration,
  auxiliaryWatermark: string,
  keyFingerprint: string,
): AuthorityBackupHeader {
  if (
    generation.provenance.provider !== "filesystem" &&
    generation.provenance.provider !== "sqlite" &&
    generation.provenance.provider !== "postgresql" &&
    generation.provenance.provider !== "s3"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup provider is invalid");
  }
  return {
    magic: "caplets-authority-backup",
    formatVersion: BACKUP_FORMAT_VERSION,
    algorithm: ALGORITHM,
    provider: generation.provenance.provider,
    authorityId: generation.authorityId,
    namespace: generation.provenance.namespace,
    schemaVersion: generation.schemaVersion,
    generationId: generation.id,
    generationSequence: generation.sequence,
    generationPredecessorId: generation.predecessorId,
    generationDigest: generation.digest,
    auxiliaryWatermark,
    keyFingerprint,
  };
}

function encodeHeader(header: AuthorityBackupHeader): Buffer {
  const encoded = stableJsonStringify(header);
  if (typeof encoded !== "string")
    throw new CapletsError("CONFIG_INVALID", "Authority backup header is not serializable");
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.byteLength > MAX_HEADER_BYTES)
    throw new CapletsError("CONFIG_INVALID", "Authority backup header is too large");
  return bytes;
}

function parseHeader(bytes: Uint8Array): AuthorityBackupHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new CapletsError("CONFIG_INVALID", "Authority backup header is invalid");
  }
  if (
    !isRecord(parsed) ||
    parsed.magic !== "caplets-authority-backup" ||
    parsed.formatVersion !== 1 ||
    parsed.algorithm !== ALGORITHM ||
    (parsed.provider !== "filesystem" &&
      parsed.provider !== "sqlite" &&
      parsed.provider !== "postgresql" &&
      parsed.provider !== "s3") ||
    typeof parsed.authorityId !== "string" ||
    typeof parsed.namespace !== "string" ||
    !Number.isSafeInteger(parsed.schemaVersion) ||
    parsed.schemaVersion < 1 ||
    typeof parsed.generationId !== "string" ||
    !Number.isSafeInteger(parsed.generationSequence) ||
    parsed.generationSequence < 1 ||
    (parsed.generationPredecessorId !== null &&
      typeof parsed.generationPredecessorId !== "string") ||
    typeof parsed.generationDigest !== "string" ||
    typeof parsed.auxiliaryWatermark !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(parsed.keyFingerprint)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority backup header is invalid");
  }
  return parsed as unknown as AuthorityBackupHeader;
}

function assertHeaderMatchesState(header: AuthorityBackupHeader, state: AuthorityExport): void {
  const generation = state.generation;
  if (
    generation.authorityId !== header.authorityId ||
    generation.provenance.provider !== header.provider ||
    generation.provenance.namespace !== header.namespace ||
    generation.schemaVersion !== header.schemaVersion ||
    generation.id !== header.generationId ||
    generation.sequence !== header.generationSequence ||
    generation.predecessorId !== header.generationPredecessorId ||
    generation.digest !== header.generationDigest ||
    state.auxiliaryWatermark !== header.auxiliaryWatermark
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority backup header does not match authenticated body",
    );
  }
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
    typeof generation.committedAt !== "string" ||
    !generation.provenance ||
    typeof generation.provenance !== "object" ||
    typeof generation.provenance.provider !== "string" ||
    typeof generation.provenance.namespace !== "string" ||
    typeof generation.digest !== "string" ||
    !isRecord(generation.snapshot)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority export is malformed");
  }
}

function normalizeBackupKey(input: BackupKeyMaterial): Buffer {
  const material =
    typeof input === "object" && !(input instanceof Uint8Array) && "key" in input
      ? input.key
      : input;
  const bytes =
    typeof material === "string" ? Buffer.from(material, "utf8") : Buffer.from(material);
  if (bytes.byteLength === 0)
    throw new CapletsError("AUTH_FAILED", "Authority backup key is empty");
  return createHash("sha256").update(bytes).digest();
}

function fingerprint(key: Uint8Array): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function authenticatedHeaderBytes(header: Uint8Array): Buffer {
  return Buffer.concat([BACKUP_MAGIC, encodeLength(header.byteLength), Buffer.from(header)]);
}

function encodeLength(length: number): Buffer {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(length, 0);
  return encoded;
}

function authorityNamespace(authority: WritableAuthority, fallback: string): string {
  const candidate = authority as WritableAuthority & { namespace?: unknown };
  return typeof candidate.namespace === "string" ? candidate.namespace : fallback;
}

function schemaVersionOf(authority: WritableAuthority): number | undefined {
  const candidate = authority as WritableAuthority & { schemaVersion?: unknown };
  return typeof candidate.schemaVersion === "number" ? candidate.schemaVersion : undefined;
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
  if (fence.release && lease && typeof lease.release === "function") {
    try {
      await lease.release();
    } catch {
      // Surface one cleanup warning while preserving verified restore success.
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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
