import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandInput,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import {
  MAX_AUTHORITY_GENERATION_BYTES,
  type AuthorityAuxiliaryExport,
  type AuthorityCommitResult,
  type AuthorityExport,
  type AuthorityGeneration,
  type AuthorityGenerationId,
  type AuthorityGenerationIdentity,
  type AuthorityHead,
  type AuthorityHealth,
  type AuthorityMigrationStage,
  type AuthorityMigrationStageContext,
  type AuthorityReceipt,
  type AuthorityRestoreResult,
  type AuxiliaryCommit,
  type AuxiliaryCommitResult,
  type AuxiliaryRead,
  type MaintenanceFence,
  type MaintenanceFenceContext,
  type MaintenanceFenceLease,
  type SemanticCommandEnvelope,
  type WritableAuthority,
} from "./types";

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_LEASE_MS = 15_000;
const DEFAULT_MAINTENANCE_RENEW_INTERVAL_MS = 5_000;
const DEFAULT_CANDIDATE_TTL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RECEIPTS = 10_000;
const MAX_AUXILIARY_SESSIONS = 50_000;
const MAX_AUXILIARY_EVENTS = 10_000;
const AUXILIARY_STATE_VERSION = 1;
const RECEIPT_MANIFEST_VERSION = 1;
type S3RequestOptions = { abortSignal?: AbortSignal };
type S3Command = { input: unknown };

export type S3CredentialIdentity = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type S3CredentialProvider = () => S3CredentialIdentity | Promise<S3CredentialIdentity>;

/** Narrow transport seam used by fault-injected protocol tests. */
export type S3AuthorityClient = {
  send(command: S3Command, options?: S3RequestOptions): Promise<unknown>;
  destroy(): void;
};

export type S3AuthorityClientFactory = (
  credentials: S3CredentialIdentity | undefined,
) => S3AuthorityClient | Promise<S3AuthorityClient>;

export type S3CommandContext<TCommand> = {
  snapshot: unknown;
  command: TCommand;
  envelope: SemanticCommandEnvelope<TCommand>;
};

export type S3CommandApplication<TSnapshot = unknown, TResult = unknown> = {
  snapshot: TSnapshot;
  result?: TResult;
};

export type S3CommandApplier<TSnapshot, TCommand> = (
  context: S3CommandContext<TCommand>,
) => S3CommandApplication<TSnapshot> | Promise<S3CommandApplication<TSnapshot>>;

export type S3AuthorityOptions<TSnapshot = unknown, TCommand = unknown> = {
  authorityId: string;
  namespace: string;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: S3CredentialIdentity | S3CredentialProvider;
  credentialProvider?: S3CredentialProvider;
  client?: S3AuthorityClient;
  clientFactory?: S3AuthorityClientFactory;
  initialSnapshot?: TSnapshot;
  applyCommand?: S3CommandApplier<TSnapshot, TCommand>;
  schemaVersion?: number;
  receiptTtlMs?: number;
  candidateTtlMs?: number;
  maintenanceLeaseMs?: number;
  maintenanceRenewIntervalMs?: number;
  requestTimeoutMs?: number;
  clock?: () => Date;
};

type ObjectRecord = {
  body: Uint8Array;
  etag: string | undefined;
  metadata: Record<string, string>;
};

type HeadRecord = {
  head: AuthorityHead;
  etag: string;
  requestFingerprint?: string;
};

type CandidateRecord<TSnapshot = unknown, TResult = unknown> = {
  generation: AuthorityGeneration<TSnapshot>;
  result: TResult;
  requestFingerprint: string;
  deadlineAt: string;
};

type SessionRecord = {
  sessionId: string;
  lastUsedAt: string;
  revision: string;
  revoked: boolean;
};

type EventRecord = {
  watermark: string;
  event: unknown;
};
type ReceiptManifest = {
  version: typeof RECEIPT_MANIFEST_VERSION;
  authorityId: string;
  namespace: string;
  receipts: AuthorityReceipt<unknown>[];
  digest: string;
};

type AuxiliaryStateRecord = {
  version: typeof AUXILIARY_STATE_VERSION;
  authorityId: string;
  namespace: string;
  watermark: string;
  sessions: Record<string, SessionRecord>;
  events: EventRecord[];
  digest: string;
};

type AuxiliaryHeadRecord = {
  version: typeof AUXILIARY_STATE_VERSION;
  authorityId: string;
  namespace: string;
  watermark: string;
  digest: string;
};

type AuxiliarySnapshot = {
  state: AuxiliaryStateRecord;
  stateEtag?: string;
  head: AuxiliaryHeadRecord | null;
  headEtag?: string;
};

type AuxiliaryMutation<TResult> = {
  state: AuxiliaryStateRecord;
  result: TResult;
  changed: boolean;
};

type S3MaintenanceRecord = {
  version: 1;
  authorityId: string;
  namespace: string;
  owner: string;
  token: string;
  deadlineAt: string;
};

type S3MigrationStageRecord = {
  version: 1;
  authorityId: string;
  namespace: string;
  owner: string;
  token: string;
  generationId: string;
  generationDigest: string;
  deadlineAt: string;
};

type S3MaintenanceState = {
  context: MaintenanceFenceContext;
  token: string;
  etag: string;
  lease: MaintenanceFenceLease;
  timer: ReturnType<typeof setInterval>;
  renewing: boolean;
  released: boolean;
};

type SessionTouchCommand = Extract<AuxiliaryCommit, { kind: "session_touch" }>;

class S3RequestError extends Error {
  readonly status: number | undefined;
  readonly operation: string;

  constructor(operation: string, status: number | undefined) {
    super(`S3 ${operation} request failed`);
    this.name = "S3RequestError";
    this.operation = operation;
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return undefined;
}

function readProperty(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record?.[key];
}

function statusOf(error: unknown): number | undefined {
  const metadata = readProperty(error, "$metadata");
  const status = readProperty(metadata, "httpStatusCode");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function errorName(error: unknown): string {
  return typeof readProperty(error, "name") === "string" ? String(readProperty(error, "name")) : "";
}

function isMissingStatus(error: unknown): boolean {
  const status = error instanceof S3RequestError ? error.status : statusOf(error);
  return status === 404 || errorName(error) === "NoSuchKey" || errorName(error) === "NotFound";
}

function isPreconditionStatus(error: unknown): boolean {
  return (error instanceof S3RequestError ? error.status : statusOf(error)) === 412;
}

function isAmbiguousStatus(error: unknown): boolean {
  const status = error instanceof S3RequestError ? error.status : statusOf(error);
  return status === 409 || status === 404 || status === undefined;
}

function safeJson(value: unknown, label: string): string {
  try {
    const encoded = stableJsonStringify(value);
    if (typeof encoded !== "string") throw new Error(`${label} is not serializable`);
    return encoded;
  } catch {
    throw new CapletsError("REQUEST_INVALID", `${label} is not serializable`);
  }
}

function digestGeneration(generation: AuthorityGeneration): string {
  const payload = {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
    schemaVersion: generation.schemaVersion,
    committedAt: generation.committedAt,
    provenance: generation.provenance,
    snapshot: generation.snapshot,
  };
  return `sha256:${createHash("sha256").update(safeJson(payload, "Authority generation")).digest("hex")}`;
}

function identityOf(generation: AuthorityGeneration): AuthorityGenerationIdentity {
  return {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
}

function headOf(generation: AuthorityGeneration): AuthorityHead {
  return { ...identityOf(generation), digest: generation.digest };
}

function digestRecord(value: unknown, label: string): string {
  return `sha256:${createHash("sha256").update(safeJson(value, label), "utf8").digest("hex")}`;
}

function parseNonNegativeWatermark(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

function compareWatermarks(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber))
    return leftNumber - rightNumber;
  return left.localeCompare(right);
}

function isWatermarkAfter(current: string, after: string): boolean {
  return compareWatermarks(current, after) > 0;
}

function receiptIdentity(
  receipt: Pick<AuthorityReceipt<unknown>, "currentHostId" | "principalId" | "idempotencyKey">,
): string {
  return `${receipt.currentHostId}\u0000${receipt.principalId}\u0000${receipt.idempotencyKey}`;
}

function cloneReceipt(receipt: AuthorityReceipt<unknown>): AuthorityReceipt<unknown> {
  return {
    currentHostId: receipt.currentHostId,
    principalId: receipt.principalId,
    idempotencyKey: receipt.idempotencyKey,
    requestDigest: receipt.requestDigest,
    generation: { ...receipt.generation },
    result: structuredClone(receipt.result),
    expiresAt: receipt.expiresAt,
  };
}

function canonicalReceipts(
  receipts: readonly AuthorityReceipt<unknown>[],
): AuthorityReceipt<unknown>[] {
  return [...receipts]
    .map(cloneReceipt)
    .sort((left, right) => receiptIdentity(left).localeCompare(receiptIdentity(right)));
}

function redactEvent(event: unknown): EventRecord["event"] {
  const record = asRecord(event);
  if (
    !record ||
    (record.kind !== "rejected" && record.kind !== "conflicted") ||
    typeof record.occurredAt !== "string" ||
    typeof record.code !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "S3 authority security event is invalid");
  }
  const redacted: Record<string, unknown> = {
    kind: record.kind,
    occurredAt: record.occurredAt,
    code: record.code,
  };
  if (typeof record.attemptedGenerationId === "string")
    redacted.attemptedGenerationId = record.attemptedGenerationId;
  if (typeof record.idempotencyKeyHash === "string")
    redacted.idempotencyKeyHash = record.idempotencyKeyHash;
  return redacted;
}

function sameIdentity(
  left: AuthorityGenerationIdentity | null,
  right: AuthorityGenerationIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.authorityId === right.authorityId &&
    left.id === right.id &&
    left.sequence === right.sequence &&
    left.predecessorId === right.predecessorId
  );
}

function semanticSessionExists(snapshot: unknown, sessionId: string): boolean {
  const record = asRecord(snapshot);
  if (!record) return false;
  for (const candidate of [record.dashboardSessions, record.sessions]) {
    if (Array.isArray(candidate)) {
      if (candidate.some((entry) => asRecord(entry)?.sessionId === sessionId)) return true;
      continue;
    }
    const candidateRecord = asRecord(candidate);
    if (candidateRecord && Object.hasOwn(candidateRecord, sessionId)) return true;
  }
  return false;
}

function semanticSessionRevoked(snapshot: unknown, sessionId: string): boolean {
  const record = asRecord(snapshot);
  if (!record) return false;
  for (const candidate of [record.dashboardSessions, record.sessions]) {
    if (Array.isArray(candidate)) {
      const entry = candidate.find((value) => asRecord(value)?.sessionId === sessionId);
      if (entry && asRecord(entry)?.revoked === true) return true;
      continue;
    }
    const candidateRecord = asRecord(candidate);
    if (asRecord(candidateRecord?.[sessionId])?.revoked === true) return true;
  }
  return false;
}
function assertFiniteBound(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum = MAX_REQUEST_TIMEOUT_MS,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} must be a finite value between 1ms and ${maximum}ms`,
    );
  }
  return resolved;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function parseCredential(value: S3CredentialIdentity | string | Uint8Array): S3CredentialIdentity {
  if (typeof value === "string" || value instanceof Uint8Array) {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    try {
      const parsed = JSON.parse(text) as unknown;
      const record = asRecord(parsed);
      const accessKeyId = record?.accessKeyId;
      const secretAccessKey = record?.secretAccessKey;
      const sessionToken = record?.sessionToken;
      if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string")
        throw new Error("invalid credential");
      return {
        accessKeyId,
        secretAccessKey,
        ...(typeof sessionToken === "string" ? { sessionToken } : {}),
      };
    } catch {
      throw new CapletsError(
        "CONFIG_INVALID",
        "S3 credentials must resolve to an accessKeyId and secretAccessKey object",
      );
    }
  }
  if (typeof value.accessKeyId !== "string" || typeof value.secretAccessKey !== "string") {
    throw new CapletsError("CONFIG_INVALID", "S3 credentials are invalid");
  }
  return value;
}

function errorForRequest(error: unknown): CapletsError {
  if (error instanceof CapletsError) return error;
  if (error instanceof S3RequestError) {
    if (error.status === 404)
      return new CapletsError("CONFIG_NOT_FOUND", "S3 authority object was not found");
    if (error.status === 403)
      return new CapletsError("SERVER_UNAVAILABLE", "S3 authority access was denied");
    if (
      error.status === 408 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    ) {
      return new CapletsError(
        "SERVER_UNAVAILABLE",
        "S3 authority provider is temporarily unavailable",
      );
    }
    return new CapletsError("SERVER_UNAVAILABLE", "S3 authority operation failed");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CapletsError("SERVER_UNAVAILABLE", "S3 authority operation was aborted");
  }
  return new CapletsError("SERVER_UNAVAILABLE", "S3 authority operation failed");
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  const record = asRecord(body);
  const transform = record?.transformToByteArray;
  if (typeof transform === "function") {
    const result = transform.call(body);
    if (result instanceof Promise) return result as Promise<Uint8Array>;
    return result as Uint8Array;
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  throw new CapletsError("CONFIG_INVALID", "S3 authority response body is invalid");
}

export class S3Authority<TSnapshot = unknown, TCommand = unknown> implements WritableAuthority<
  TSnapshot,
  TCommand
> {
  readonly authorityId: string;
  readonly namespace: string;
  readonly bucket: string;
  readonly region: string;

  private readonly options: S3AuthorityOptions<TSnapshot, TCommand>;
  private readonly clock: () => Date;
  readonly schemaVersion: number;
  private readonly receiptTtlMs: number;
  private readonly candidateTtlMs: number;
  private readonly maintenanceLeaseMs: number;
  private readonly maintenanceRenewIntervalMs: number;
  private readonly maintenanceLeases = new Map<string, S3MaintenanceState>();
  private readonly requestTimeoutMs: number;
  private readonly rootPrefix: string;
  private readonly clients = new Set<S3AuthorityClient>();
  private readonly ownedClients = new Set<S3AuthorityClient>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: S3AuthorityOptions<TSnapshot, TCommand>) {
    if (!options.authorityId || !options.namespace || !options.bucket || !options.region) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "S3 authority identity and connection fields are required",
      );
    }
    this.authorityId = options.authorityId;
    this.namespace = options.namespace.replace(/^\/+|\/+$/gu, "");
    this.bucket = options.bucket;
    this.region = options.region;
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    this.receiptTtlMs = assertFiniteBound(
      options.receiptTtlMs,
      DEFAULT_RECEIPT_TTL_MS,
      "S3 receipt TTL",
      7 * 24 * 60 * 60 * 1000,
    );
    this.candidateTtlMs = assertFiniteBound(
      options.candidateTtlMs,
      DEFAULT_CANDIDATE_TTL_MS,
      "S3 candidate TTL",
    );
    this.maintenanceLeaseMs = assertFiniteBound(
      options.maintenanceLeaseMs,
      DEFAULT_MAINTENANCE_LEASE_MS,
      "S3 maintenance lease",
    );
    this.maintenanceRenewIntervalMs = assertFiniteBound(
      options.maintenanceRenewIntervalMs,
      Math.min(DEFAULT_MAINTENANCE_RENEW_INTERVAL_MS, Math.floor(this.maintenanceLeaseMs / 3)),
      "S3 maintenance renewal interval",
    );
    if (this.maintenanceRenewIntervalMs >= this.maintenanceLeaseMs) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "S3 maintenance renewal interval must be shorter than the lease",
      );
    }
    this.requestTimeoutMs = assertFiniteBound(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "S3 request timeout",
    );
    if (!Number.isSafeInteger(this.schemaVersion) || this.schemaVersion < 1) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority schema version is invalid");
    }
    this.rootPrefix = `${this.namespace}/`;
  }
  maintenanceFence(): MaintenanceFence {
    return {
      acquire: async (context) => await this.acquireMaintenanceFence(context),
      assertReadOnly: async (context) => await this.assertMaintenanceFence(context),
      assertStopped: async (context) => await this.assertMaintenanceFence(context),
      renew: async (lease, context) => await this.renewMaintenanceFence(lease, context),
      release: async (lease, context) => await this.releaseMaintenanceFence(lease, context),
    };
  }

  async readHead(): Promise<AuthorityHead | null> {
    this.assertOpen();
    const record = await this.readHeadRecord();
    return record?.head ?? null;
  }

  async readGeneration(id: AuthorityGenerationId): Promise<AuthorityGeneration<TSnapshot>> {
    this.assertOpen();
    return (await this.readCandidate<TSnapshot>(id)).generation;
  }

  private async readCandidate<TCandidateSnapshot = TSnapshot, TResult = unknown>(
    id: AuthorityGenerationId,
  ): Promise<CandidateRecord<TCandidateSnapshot, TResult>> {
    let object: ObjectRecord;
    try {
      object = await this.getObject(this.generationKey(id), "generation");
    } catch (error) {
      if (isMissingStatus(error))
        throw new CapletsError("CONFIG_NOT_FOUND", "S3 authority generation was not found");
      throw errorForRequest(error);
    }
    const candidate = this.parseCandidate<TCandidateSnapshot, TResult>(
      this.parseJson(object.body, "S3 authority generation"),
    );
    if (candidate.generation.id !== id)
      throw new CapletsError("CONFIG_INVALID", "S3 authority generation identity is invalid");
    this.validateGeneration(candidate.generation);
    return candidate;
  }

  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityCommitResult<TResult>> {
    this.assertOpen();
    if (envelope.authorityId !== this.authorityId)
      throw new CapletsError("REQUEST_INVALID", "Authority identity does not match the connection");
    this.preflightSnapshotSize(envelope.command);
    await this.assertMaintenanceWriteAllowed();
    const requestFingerprint = this.requestFingerprint(envelope);
    const existingReceipt = await this.readReceipt<TResult>(envelope);
    if (existingReceipt)
      return { kind: "replayed", generation: existingReceipt.generation, receipt: existingReceipt };

    const activeRecord = await this.readHeadRecord();
    const activeHead = activeRecord?.head ?? null;
    if (activeRecord?.requestFingerprint === requestFingerprint && activeHead) {
      if (activeHead.id !== this.candidateId(requestFingerprint)) {
        throw new CapletsError("CONFIG_INVALID", "S3 authority head candidate identity is invalid");
      }
      const published = await this.readCandidate<TSnapshot, TResult>(activeHead.id);
      if (
        published.requestFingerprint !== requestFingerprint ||
        published.generation.digest !== activeHead.digest
      ) {
        throw new CapletsError("CONFIG_INVALID", "S3 authority head candidate identity is invalid");
      }
      return this.publishCommitResult(envelope, published, "replayed");
    }
    if (!sameIdentity(envelope.expectedGeneration, activeHead))
      return { kind: "conflict", active: activeHead };
    const previous = activeHead ? await this.readGeneration(activeHead.id) : undefined;
    const commandResult = await this.resolveCommand(
      previous?.snapshot ?? this.options.initialSnapshot ?? null,
      envelope,
    );
    this.assertSnapshotSize(commandResult.snapshot);
    const now = this.clock();
    const deadlineAt = new Date(now.getTime() + this.candidateTtlMs).toISOString();
    const generation: AuthorityGeneration<TSnapshot> = {
      authorityId: this.authorityId,
      id: this.candidateId(requestFingerprint),
      sequence: (activeHead?.sequence ?? 0) + 1,
      predecessorId: activeHead?.id ?? null,
      schemaVersion: this.schemaVersion,
      digest: "",
      committedAt: now.toISOString(),
      provenance: { provider: "s3", namespace: this.namespace },
      snapshot: commandResult.snapshot as TSnapshot,
    };
    generation.digest = digestGeneration(generation);
    this.validateGeneration(generation);
    const candidate: CandidateRecord<TSnapshot, TResult> = {
      generation,
      result: commandResult.result as TResult,
      requestFingerprint,
      deadlineAt,
    };
    await this.publishCandidate(candidate);
    if (this.clock().getTime() >= Date.parse(deadlineAt)) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "S3 authority candidate commit deadline expired",
      );
    }
    await this.assertMaintenanceWriteAllowed();

    const head = headOf(generation);
    try {
      await this.publishHead(head, activeRecord?.etag, requestFingerprint);
    } catch (error) {
      if (isPreconditionStatus(error)) {
        const outcome = await this.resolveAmbiguousCommit<TResult>(envelope, candidate, activeHead);
        if (outcome) return outcome;
        return { kind: "conflict", active: await this.readHead() };
      }
      if (isAmbiguousStatus(error)) {
        const outcome = await this.resolveAmbiguousCommit<TResult>(envelope, candidate, activeHead);
        if (outcome) return outcome;
      }
      throw errorForRequest(error);
    }

    return this.publishCommitResult(envelope, candidate, "committed");
  }

  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    this.assertOpen();
    const snapshot = await this.readAuxiliarySnapshot();
    if (request.kind === "session_touch") {
      const session = snapshot.state.sessions[request.sessionId];
      if (session) return structuredClone(session);
      const legacy = await this.tryGetObject(this.sessionKey(request.sessionId), "session");
      return legacy ? this.parseSession(legacy.body) : undefined;
    }
    const events = snapshot.state.events
      .filter(
        ({ watermark }) =>
          !request.afterWatermark || isWatermarkAfter(watermark, request.afterWatermark),
      )
      .sort((left, right) => compareWatermarks(left.watermark, right.watermark));
    return events.slice(0, Math.max(0, request.limit)).map(({ event }) => structuredClone(event));
  }

  async commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    this.assertOpen();
    await this.assertMaintenanceWriteAllowed();
    if (command.kind === "session_touch") return await this.commitSessionTouch(command);
    return await this.commitSecurityEvent(command.event);
  }

  async health(): Promise<AuthorityHealth> {
    if (this.closed) {
      return {
        provider: "s3",
        authorityId: this.authorityId,
        connectivity: "unavailable",
        writable: false,
        activeGeneration: null,
        refresh: "failed",
        code: "CLOSED",
      };
    }
    try {
      const head = await this.readHead();
      return {
        provider: "s3",
        authorityId: this.authorityId,
        connectivity: "healthy",
        writable: true,
        activeGeneration: head,
        refresh: "current",
      };
    } catch {
      return {
        provider: "s3",
        authorityId: this.authorityId,
        connectivity: "degraded",
        writable: false,
        activeGeneration: null,
        refresh: "failed",
        code: "UNAVAILABLE",
      };
    }
  }

  async exportState(): Promise<AuthorityExport> {
    this.assertOpen();
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const head = await this.readHeadRecord();
      if (!head)
        throw new CapletsError("CONFIG_NOT_FOUND", "S3 authority has no committed generation");
      const generation = await this.readGeneration(head.head.id);
      const manifest = await this.readReceiptManifest();
      const auxiliary = await this.readAuxiliarySnapshot();
      const rereadHead = await this.readHeadRecord();
      if (
        rereadHead?.etag === head.etag &&
        rereadHead.head.digest === head.head.digest &&
        (await this.readReceiptManifest())?.etag === manifest?.etag &&
        (await this.readAuxiliarySnapshot()).state.digest === auxiliary.state.digest
      ) {
        const exportedAuxiliary: AuthorityAuxiliaryExport = {
          watermark: auxiliary.state.watermark,
          sessions: Object.fromEntries(
            Object.entries(auxiliary.state.sessions)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([sessionId, session]) => [
                sessionId,
                {
                  lastUsedAt: session.lastUsedAt,
                  revision: session.revision,
                  revoked: session.revoked,
                },
              ]),
          ),
          securityEvents: auxiliary.state.events
            .slice()
            .sort((left, right) => compareWatermarks(left.watermark, right.watermark))
            .map(
              ({ event }) =>
                structuredClone(event) as NonNullable<
                  AuthorityAuxiliaryExport["securityEvents"]
                >[number],
            ),
          securityEventWatermarks: auxiliary.state.events
            .slice()
            .sort((left, right) => compareWatermarks(left.watermark, right.watermark))
            .map(({ watermark }) => watermark),
        };
        return {
          generation,
          auxiliaryWatermark: auxiliary.state.watermark,
          receipts: canonicalReceipts(
            (manifest?.manifest.receipts ?? []).filter(
              (receipt) => Date.parse(receipt.expiresAt) > this.clock().getTime(),
            ),
          ),
          auxiliary: exportedAuxiliary,
        };
      }
    }
    throw new CapletsError("SERVER_UNAVAILABLE", "S3 authority export changed while being read");
  }

  async restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult> {
    this.assertOpen();
    await this.assertMaintenanceWriteAllowed();
    const generation = state?.generation;
    if (
      !generation ||
      generation.authorityId !== this.authorityId ||
      generation.provenance.provider !== "s3" ||
      generation.provenance.namespace !== this.namespace ||
      generation.schemaVersion !== this.schemaVersion
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "S3 authority restore identity or schema does not match",
      );
    }
    this.validateGeneration(generation);
    const receipts = this.parseExportReceipts(state.receipts, generation);
    const auxiliary = this.parseExportAuxiliary(state.auxiliary, state.auxiliaryWatermark);
    const active = await this.readHeadRecord();
    const manifest = await this.readReceiptManifest();
    const existingAuxiliary = await this.readAuxiliarySnapshot();
    if (active || manifest || existingAuxiliary.stateEtag || existingAuxiliary.headEtag) {
      throw new CapletsError("CONFIG_EXISTS", "S3 authority restore target must be empty");
    }
    const candidate: CandidateRecord = {
      generation,
      result: null,
      requestFingerprint: `restore-${generation.id}`,
      deadlineAt: new Date(this.clock().getTime() + this.candidateTtlMs).toISOString(),
    };
    try {
      await this.publishCandidate(candidate);
      await this.publishReceiptManifestCanonical(receipts);
      await this.publishAuxiliaryCanonical(auxiliary);
      await this.assertMaintenanceWriteAllowed();
      await this.publishHead(headOf(generation), undefined, candidate.requestFingerprint);
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw errorForRequest(error);
    }
    return { generation: identityOf(generation), auxiliaryWatermark: auxiliary.watermark };
  }

  async stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage> {
    this.assertOpen();
    await this.assertMaintenanceWriteAllowed();
    this.validateMigrationStageContext(context);
    const generation = state?.generation;
    if (
      !generation ||
      generation.authorityId !== this.authorityId ||
      generation.provenance.provider !== "s3" ||
      generation.provenance.namespace !== this.namespace ||
      generation.schemaVersion !== this.schemaVersion
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "S3 migration stage identity or schema does not match",
      );
    }
    this.validateGeneration(generation);
    const receipts = this.parseExportReceipts(state.receipts, generation);
    const auxiliary = this.parseExportAuxiliary(state.auxiliary, state.auxiliaryWatermark);
    const active = await this.readHeadRecord();
    const activeManifest = await this.readReceiptManifest();
    const existingAuxiliary = await this.readAuxiliarySnapshot();
    if (active || activeManifest || existingAuxiliary.stateEtag || existingAuxiliary.headEtag) {
      throw new CapletsError("CONFIG_EXISTS", "S3 migration target must be empty");
    }
    const token = `stage-${randomUUID()}`;
    const candidate: CandidateRecord = {
      generation,
      result: null,
      requestFingerprint: `migration-${token}`,
      deadlineAt: new Date(this.clock().getTime() + this.candidateTtlMs).toISOString(),
    };
    const marker: S3MigrationStageRecord = {
      version: 1,
      authorityId: this.authorityId,
      namespace: this.namespace,
      owner: context.owner,
      token,
      generationId: generation.id,
      generationDigest: generation.digest,
      deadlineAt: candidate.deadlineAt,
    };
    const manifestPayload = {
      version: RECEIPT_MANIFEST_VERSION as typeof RECEIPT_MANIFEST_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      receipts: canonicalReceipts(receipts),
    };
    const manifest: ReceiptManifest = {
      ...manifestPayload,
      digest: digestRecord(manifestPayload, "S3 migration stage receipt manifest"),
    };
    try {
      await this.putObject(
        this.migrationStageMarkerKey(token),
        safeJson(marker, "S3 migration stage"),
        { ifNoneMatch: "*" },
        "migration stage",
      );
      await this.putObject(
        this.migrationStageGenerationKey(token),
        safeJson(candidate, "S3 migration stage candidate"),
        { ifNoneMatch: "*" },
        "migration stage candidate",
      );
      await this.putObject(
        this.migrationStageReceiptsKey(token),
        safeJson(manifest, "S3 migration stage receipt manifest"),
        { ifNoneMatch: "*" },
        "migration stage receipts",
      );
      await this.putObject(
        this.migrationStageAuxiliaryKey(token),
        safeJson(auxiliary, "S3 migration stage auxiliary state"),
        { ifNoneMatch: "*" },
        "migration stage auxiliary",
      );
    } catch (error) {
      await this.invalidateMigrationStage({ token }, context).catch(() => undefined);
      if (error instanceof CapletsError) throw error;
      throw errorForRequest(error);
    }
    return { token };
  }

  async readMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport> {
    this.assertOpen();
    this.validateMigrationStageContext(context);
    const bundle = await this.readMigrationStageBundle(stage, context);
    return {
      generation: bundle.candidate.generation,
      auxiliaryWatermark: bundle.auxiliary.watermark,
      receipts: canonicalReceipts(bundle.receipts),
      auxiliary: this.exportAuxiliary(bundle.auxiliary),
    };
  }

  async publishMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult> {
    this.assertOpen();
    await this.assertMaintenanceWriteAllowed();
    this.validateMigrationStageContext(context);
    const bundle = await this.readMigrationStageBundle(stage, context);
    const active = await this.readHeadRecord();
    const manifest = await this.readReceiptManifest();
    const existingAuxiliary = await this.readAuxiliarySnapshot();
    if (active || manifest || existingAuxiliary.stateEtag || existingAuxiliary.headEtag) {
      throw new CapletsError("CONFIG_EXISTS", "S3 migration target must be empty");
    }
    try {
      await this.publishCandidate(bundle.candidate);
      await this.publishReceiptManifestCanonical(bundle.receipts);
      await this.publishAuxiliaryCanonical(bundle.auxiliary);
      await this.assertMaintenanceWriteAllowed();
      await this.publishHead(
        headOf(bundle.candidate.generation),
        undefined,
        bundle.candidate.requestFingerprint,
      );
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw errorForRequest(error);
    }
    await this.invalidateMigrationStage(stage, context);
    return {
      generation: identityOf(bundle.candidate.generation),
      auxiliaryWatermark: bundle.auxiliary.watermark,
    };
  }

  async invalidateMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void> {
    this.assertOpen();
    this.validateMigrationStageContext(context);
    const token = this.migrationStageToken(stage);
    await this.readMigrationStageRecord(token, context);
    for (const key of [
      this.migrationStageMarkerKey(token),
      this.migrationStageGenerationKey(token),
      this.migrationStageReceiptsKey(token),
      this.migrationStageAuxiliaryKey(token),
    ]) {
      try {
        await this.deleteObject(key, "migration stage cleanup");
      } catch (error) {
        if (isPreconditionStatus(error)) continue;
        throw errorForRequest(error);
      }
    }
  }

  async cleanupExpiredCandidates(options: { now?: Date } = {}): Promise<string[]> {
    this.assertOpen();
    const now = options.now ?? this.clock();
    const active = await this.readHeadRecord();
    const removed: string[] = [];
    const keys = await this.listObjects(this.generationsPrefix());
    for (const key of keys) {
      const object = await this.tryGetObject(key, "candidate cleanup");
      if (!object) continue;
      let candidate: CandidateRecord;
      try {
        candidate = this.parseCandidate(this.parseJson(object.body, "S3 authority candidate"));
      } catch {
        continue;
      }
      if (Date.parse(candidate.deadlineAt) > now.getTime()) continue;
      if (active?.head.id === candidate.generation.id) continue;
      try {
        await this.deleteObject(key, "candidate cleanup");
        removed.push(candidate.generation.id);
      } catch (error) {
        throw errorForRequest(error);
      }
    }
    return removed;
  }

  async probeCapabilities(): Promise<void> {
    this.assertOpen();
    const base = `${this.rootPrefix}capability-probe/${randomUUID()}`;
    const firstKey = `${base}/if-none.json`;
    const secondKey = `${base}/if-match.json`;
    try {
      const first = await this.putObject(
        firstKey,
        "probe",
        { ifNoneMatch: "*" },
        "capability probe",
      );
      if (!first.etag)
        throw new CapletsError(
          "UNSUPPORTED_CAPABILITY",
          "S3 provider did not return an ETag for a conditional probe",
        );
      try {
        await this.putObject(firstKey, "probe-again", { ifNoneMatch: "*" }, "capability probe");
        throw new CapletsError(
          "UNSUPPORTED_CAPABILITY",
          "S3 provider ignored If-None-Match conditions",
        );
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        if (!isPreconditionStatus(error)) {
          const status = error instanceof S3RequestError ? error.status : statusOf(error);
          if (status === 404 || status === 409)
            throw new CapletsError(
              "UNSUPPORTED_CAPABILITY",
              "S3 provider did not honor If-None-Match conditions",
            );
          throw errorForRequest(error);
        }
      }
      const second = await this.putObject(secondKey, "probe", {}, "capability probe");
      if (!second.etag)
        throw new CapletsError(
          "UNSUPPORTED_CAPABILITY",
          "S3 provider did not return an ETag for a probe object",
        );
      try {
        await this.putObject(
          secondKey,
          "probe-again",
          { ifMatch: "opaque-condition-probe-mismatch" },
          "capability probe",
        );
        throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider ignored If-Match conditions");
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        if (!isPreconditionStatus(error)) {
          const status = error instanceof S3RequestError ? error.status : statusOf(error);
          if (status === 404 || status === 409)
            throw new CapletsError(
              "UNSUPPORTED_CAPABILITY",
              "S3 provider did not honor If-Match conditions",
            );
          throw errorForRequest(error);
        }
      }
    } finally {
      try {
        await this.deleteObject(firstKey, "capability probe cleanup");
      } catch {
        // Probe failure remains authoritative; cleanup is best effort.
      }
      try {
        await this.deleteObject(secondKey, "capability probe cleanup");
      } catch {
        // Probe failure remains authoritative; cleanup is best effort.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closing = true;
    this.closePromise = (async () => {
      const states = [...this.maintenanceLeases.values()];
      for (const state of states) {
        state.released = true;
        clearInterval(state.timer);
      }
      for (const controller of this.controllers) {
        try {
          controller.abort();
        } catch {
          // Continue tearing down every controller.
        }
      }

      let releaseError: unknown;
      for (const state of states) {
        try {
          await this.releaseMaintenanceFence(state.lease, state.context);
        } catch (error) {
          releaseError ??= error;
        }
      }

      this.closed = true;
      this.closing = false;
      for (const client of this.clients) {
        try {
          client.destroy();
        } catch {
          // Shutdown remains idempotent even when a transport has already failed.
        }
      }
      this.controllers.clear();
      this.clients.clear();
      this.ownedClients.clear();
      this.maintenanceLeases.clear();
      if (releaseError) throw releaseError;
    })();
    return this.closePromise;
  }
  private validateMaintenanceContext(context: MaintenanceFenceContext): void {
    if (
      context.authorityId !== this.authorityId ||
      context.namespace !== this.namespace ||
      context.owner.length === 0
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 maintenance fence identity does not match");
    }
  }

  private maintenanceKey(): string {
    return `${this.rootPrefix}maintenance/lease.json`;
  }

  private maintenanceKeyFor(context: MaintenanceFenceContext): string {
    return `${context.operation}:${context.role}:${context.owner}`;
  }

  private maintenanceHeld(): CapletsError {
    return new CapletsError("SERVER_UNAVAILABLE", "S3 authority is held by a maintenance owner");
  }

  private parseMaintenanceRecord(body: Uint8Array): S3MaintenanceRecord {
    const value = this.parseJson(body, "S3 maintenance lease");
    const record = asRecord(value);
    if (
      !record ||
      record.version !== 1 ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      typeof record.owner !== "string" ||
      record.owner.length === 0 ||
      typeof record.token !== "string" ||
      record.token.length === 0 ||
      typeof record.deadlineAt !== "string" ||
      !Number.isFinite(Date.parse(record.deadlineAt))
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 maintenance lease is invalid");
    }
    return record as unknown as S3MaintenanceRecord;
  }

  private async readMaintenanceLease(): Promise<{
    record: S3MaintenanceRecord;
    etag: string;
  } | null> {
    const object = await this.tryGetObject(this.maintenanceKey(), "maintenance lease");
    if (!object) return null;
    if (!object.etag)
      throw new CapletsError(
        "UNSUPPORTED_CAPABILITY",
        "S3 provider omitted the maintenance lease ETag",
      );
    return { record: this.parseMaintenanceRecord(object.body), etag: object.etag };
  }

  private markExpiredS3Lease(token: string): void {
    for (const state of this.maintenanceLeases.values()) {
      if (state.token === token) {
        state.released = true;
        clearInterval(state.timer);
      }
    }
  }

  private async acquireMaintenanceFence(
    context: MaintenanceFenceContext,
  ): Promise<MaintenanceFenceLease> {
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const key = this.maintenanceKeyFor(context);
    const existingLocal = this.maintenanceLeases.get(key);
    if (existingLocal && !existingLocal.released) return existingLocal.lease;
    const expiresAt = Date.now() + this.requestTimeoutMs;
    while (Date.now() < expiresAt) {
      const current = await this.readMaintenanceLease();
      const now = this.clock().getTime();
      if (current && Date.parse(current.record.deadlineAt) > now) throw this.maintenanceHeld();
      if (current) {
        try {
          await this.deleteObject(
            this.maintenanceKey(),
            "maintenance lease takeover",
            current.etag,
          );
        } catch (error) {
          if (isPreconditionStatus(error)) continue;
          throw errorForRequest(error);
        }
        this.markExpiredS3Lease(current.record.token);
      }
      const token = randomUUID();
      const record: S3MaintenanceRecord = {
        version: 1,
        authorityId: this.authorityId,
        namespace: this.namespace,
        owner: context.owner,
        token,
        deadlineAt: new Date(now + this.maintenanceLeaseMs).toISOString(),
      };
      let created: { etag: string | undefined };
      try {
        created = await this.putObject(
          this.maintenanceKey(),
          safeJson(record, "S3 maintenance lease"),
          { ifNoneMatch: "*" },
          "maintenance lease acquire",
        );
      } catch (error) {
        if (isPreconditionStatus(error)) continue;
        throw errorForRequest(error);
      }
      if (!created.etag)
        throw new CapletsError(
          "UNSUPPORTED_CAPABILITY",
          "S3 provider omitted the maintenance lease ETag",
        );
      const lease: MaintenanceFenceLease = {
        token,
        renew: async () => await this.renewMaintenanceFence({ token }, context),
        release: async () => await this.releaseMaintenanceFence({ token }, context),
      };
      const timer = setInterval(() => {
        void this.renewMaintenanceFence({ token }, context).catch(() => undefined);
      }, this.maintenanceRenewIntervalMs);
      timer.unref?.();
      this.maintenanceLeases.set(key, {
        context,
        token,
        etag: created.etag,
        lease,
        timer,
        renewing: false,
        released: false,
      });
      return lease;
    }
    throw new CapletsError("SERVER_UNAVAILABLE", "S3 maintenance lease acquisition timed out");
  }

  private async assertMaintenanceFence(context: MaintenanceFenceContext): Promise<void> {
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const current = await this.readMaintenanceLease();
    if (!current || Date.parse(current.record.deadlineAt) <= this.clock().getTime()) {
      if (current) {
        try {
          await this.deleteObject(this.maintenanceKey(), "maintenance lease expiry", current.etag);
        } catch (error) {
          if (!isPreconditionStatus(error)) throw errorForRequest(error);
        }
      }
      throw this.maintenanceHeld();
    }
    const local = [...this.maintenanceLeases.values()].find(
      (state) =>
        !state.released &&
        state.context.owner === context.owner &&
        state.token === current.record.token,
    );
    if (!local) throw this.maintenanceHeld();
  }

  private async assertMaintenanceWriteAllowed(): Promise<void> {
    const current = await this.readMaintenanceLease();
    if (!current) return;
    if (Date.parse(current.record.deadlineAt) <= this.clock().getTime()) {
      try {
        await this.deleteObject(this.maintenanceKey(), "maintenance lease expiry", current.etag);
        this.markExpiredS3Lease(current.record.token);
        return;
      } catch (error) {
        if (isPreconditionStatus(error)) {
          const replacement = await this.readMaintenanceLease();
          if (!replacement) return;
          if (Date.parse(replacement.record.deadlineAt) <= this.clock().getTime()) return;
          const localReplacement = [...this.maintenanceLeases.values()].find(
            (state) =>
              !state.released &&
              state.token === replacement.record.token &&
              state.context.owner === replacement.record.owner,
          );
          if (localReplacement) return;
          throw this.maintenanceHeld();
        }
        throw errorForRequest(error);
      }
    }
    const local = [...this.maintenanceLeases.values()].find(
      (state) =>
        !state.released &&
        state.token === current.record.token &&
        state.context.owner === current.record.owner,
    );
    if (!local) throw this.maintenanceHeld();
  }

  private async renewMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token) throw new CapletsError("CONFIG_INVALID", "S3 maintenance lease token is missing");
    const state = [...this.maintenanceLeases.values()].find(
      (candidate) => candidate.token === token && candidate.context.owner === context.owner,
    );
    if (!state || state.released) throw this.maintenanceHeld();
    if (state.renewing) return;
    state.renewing = true;
    try {
      const current = await this.readMaintenanceLease();
      const now = this.clock().getTime();
      if (
        !current ||
        current.record.token !== token ||
        current.record.owner !== context.owner ||
        current.etag !== state.etag ||
        Date.parse(current.record.deadlineAt) <= now
      ) {
        state.released = true;
        clearInterval(state.timer);
        throw this.maintenanceHeld();
      }
      const updated: S3MaintenanceRecord = {
        ...current.record,
        deadlineAt: new Date(now + this.maintenanceLeaseMs).toISOString(),
      };
      try {
        const result = await this.putObject(
          this.maintenanceKey(),
          safeJson(updated, "S3 maintenance lease"),
          { ifMatch: state.etag },
          "maintenance lease renewal",
        );
        if (!result.etag)
          throw new CapletsError(
            "UNSUPPORTED_CAPABILITY",
            "S3 provider omitted the maintenance lease ETag",
          );
        state.etag = result.etag;
      } catch (error) {
        state.released = true;
        clearInterval(state.timer);
        if (error instanceof CapletsError) throw error;
        if (isPreconditionStatus(error)) throw this.maintenanceHeld();
        throw errorForRequest(error);
      }
    } finally {
      state.renewing = false;
    }
  }

  private async releaseMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token) return;
    const key = this.maintenanceKeyFor(context);
    const state = this.maintenanceLeases.get(key);
    if (!state || state.token !== token || state.context.owner !== context.owner) return;
    if (state && state.token === token) {
      state.released = true;
      clearInterval(state.timer);
      this.maintenanceLeases.delete(key);
    }
    if (this.closed) return;
    const current = await this.readMaintenanceLease();
    if (
      !current ||
      current.record.token !== token ||
      current.record.owner !== context.owner ||
      (state && current.etag !== state.etag)
    )
      return;
    try {
      await this.deleteObject(
        this.maintenanceKey(),
        "maintenance lease release",
        current.etag,
        this.closing,
      );
    } catch (error) {
      if (!isPreconditionStatus(error)) throw errorForRequest(error);
    }
  }

  private async commitSessionTouch(command: SessionTouchCommand): Promise<AuxiliaryCommitResult> {
    const activeRecord = await this.readHeadRecord();
    const activeSnapshot = activeRecord ? await this.readGeneration(activeRecord.head.id) : null;
    if (!sameIdentity(activeRecord?.head ?? null, command.expectedGeneration))
      return { kind: "conflict" };
    const sessionExists = semanticSessionExists(activeSnapshot?.snapshot, command.sessionId);
    const sessionRevoked = semanticSessionRevoked(activeSnapshot?.snapshot, command.sessionId);
    return await this.mutateAuxiliaryState<AuxiliaryCommitResult>(
      "session touch",
      (state): AuxiliaryMutation<AuxiliaryCommitResult> => {
        const current = state.sessions[command.sessionId];
        if (!sessionExists || sessionRevoked) {
          if (current && !current.revoked) {
            return {
              state: this.withAuxiliaryState(state, {
                sessions: { ...state.sessions, [command.sessionId]: { ...current, revoked: true } },
              }),
              result: { kind: "revoked" },
              changed: true,
            };
          }
          return {
            state,
            result: sessionRevoked || current?.revoked ? { kind: "revoked" } : { kind: "missing" },
            changed: false,
          };
        }
        if (!current) {
          if (command.expectedRevision !== "")
            return { state, result: { kind: "missing" }, changed: false };
          const watermark = this.nextAuxiliaryWatermark(state.watermark);
          const nextSession: SessionRecord = {
            sessionId: command.sessionId,
            lastUsedAt: command.lastUsedAt,
            revision: watermark,
            revoked: false,
          };
          return {
            state: this.withAuxiliaryState(state, {
              watermark,
              sessions: { ...state.sessions, [command.sessionId]: nextSession },
            }),
            result: { kind: "applied", watermark },
            changed: true,
          };
        }
        if (current.revoked) return { state, result: { kind: "revoked" }, changed: false };
        if (current.revision !== command.expectedRevision)
          return { state, result: { kind: "conflict" }, changed: false };
        if (current.lastUsedAt >= command.lastUsedAt)
          return {
            state,
            result: { kind: "unchanged", watermark: state.watermark },
            changed: false,
          };
        const watermark = this.nextAuxiliaryWatermark(state.watermark);
        return {
          state: this.withAuxiliaryState(state, {
            watermark,
            sessions: {
              ...state.sessions,
              [command.sessionId]: {
                ...current,
                lastUsedAt: command.lastUsedAt,
                revision: watermark,
              },
            },
          }),
          result: { kind: "applied", watermark },
          changed: true,
        };
      },
    );
  }

  private async commitSecurityEvent(event: unknown): Promise<AuxiliaryCommitResult> {
    const redacted = redactEvent(event);
    const eventJson = safeJson(redacted, "Security event");
    return await this.mutateAuxiliaryState("security event", (state) => {
      const duplicate = state.events.find(
        (entry) => stableJsonStringify(entry.event) === eventJson,
      );
      if (duplicate)
        return {
          state,
          result: { kind: "applied", watermark: duplicate.watermark },
          changed: false,
        };
      const watermark = this.nextAuxiliaryWatermark(state.watermark);
      const events = [...state.events, { watermark, event: structuredClone(redacted) }]
        .sort((left, right) => compareWatermarks(left.watermark, right.watermark))
        .slice(-MAX_AUXILIARY_EVENTS);
      return {
        state: this.withAuxiliaryState(state, { watermark, events }),
        result: { kind: "applied", watermark },
        changed: true,
      };
    });
  }

  private async mutateAuxiliaryState<TResult>(
    operation: string,
    mutator: (state: AuxiliaryStateRecord) => AuxiliaryMutation<TResult>,
  ): Promise<TResult> {
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readAuxiliarySnapshot();
      const mutation = mutator(current.state);
      if (!mutation.changed) {
        if (current.head?.digest !== current.state.digest) {
          try {
            await this.publishAuxiliaryHead(mutation.state, current.headEtag);
          } catch (error) {
            if (isPreconditionStatus(error)) continue;
            if (isAmbiguousStatus(error)) {
              const reread = await this.readAuxiliarySnapshot();
              if (reread.head?.digest === reread.state.digest) return mutation.result;
              continue;
            }
            throw errorForRequest(error);
          }
        }
        return mutation.result;
      }
      const body = safeJson(mutation.state, `S3 authority ${operation} state`);
      const stateConditions = current.stateEtag
        ? { ifMatch: current.stateEtag }
        : { ifNoneMatch: "*" };
      let headSource = current;
      try {
        await this.putObject(this.auxiliaryStateKey(), body, stateConditions, operation);
      } catch (error) {
        if (isPreconditionStatus(error)) continue;
        if (isAmbiguousStatus(error)) {
          const reread = await this.readAuxiliarySnapshot();
          if (reread.state.digest !== mutation.state.digest) continue;
          headSource = reread;
        } else {
          throw errorForRequest(error);
        }
      }
      try {
        await this.publishAuxiliaryHead(mutation.state, headSource.headEtag);
      } catch (error) {
        if (isPreconditionStatus(error)) {
          const reread = await this.readAuxiliarySnapshot();
          if (
            reread.state.digest === mutation.state.digest &&
            reread.head?.digest === mutation.state.digest
          )
            return mutation.result;
          continue;
        }
        if (isAmbiguousStatus(error)) {
          const reread = await this.readAuxiliarySnapshot();
          if (reread.head?.digest === mutation.state.digest) return mutation.result;
          continue;
        }
        throw errorForRequest(error);
      }
      return mutation.result;
    }
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "S3 authority auxiliary publication outcome is ambiguous",
    );
  }

  private emptyAuxiliaryState(): AuxiliaryStateRecord {
    const payload = {
      version: AUXILIARY_STATE_VERSION as typeof AUXILIARY_STATE_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      watermark: "0",
      sessions: {} as Record<string, SessionRecord>,
      events: [] as EventRecord[],
    };
    return { ...payload, digest: digestRecord(payload, "S3 authority auxiliary state") };
  }

  private withAuxiliaryState(
    current: AuxiliaryStateRecord,
    patch: {
      watermark?: string;
      sessions?: Record<string, SessionRecord>;
      events?: EventRecord[];
    },
  ): AuxiliaryStateRecord {
    const payload = {
      version: AUXILIARY_STATE_VERSION as typeof AUXILIARY_STATE_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      watermark: patch.watermark ?? current.watermark,
      sessions: Object.fromEntries(
        Object.entries(patch.sessions ?? current.sessions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sessionId, session]) => [
            sessionId,
            {
              sessionId,
              lastUsedAt: session.lastUsedAt,
              revision: session.revision,
              revoked: session.revoked,
            },
          ]),
      ) as Record<string, SessionRecord>,
      events: (patch.events ?? current.events)
        .map((entry) => ({ watermark: entry.watermark, event: redactEvent(entry.event) }))
        .sort((left, right) => compareWatermarks(left.watermark, right.watermark)),
    };
    return { ...payload, digest: digestRecord(payload, "S3 authority auxiliary state") };
  }

  private nextAuxiliaryWatermark(current: string): string {
    const value = Number(parseNonNegativeWatermark(current, "S3 authority auxiliary watermark"));
    if (value >= Number.MAX_SAFE_INTEGER)
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary watermark exhausted");
    return String(value + 1);
  }

  private async readAuxiliarySnapshot(): Promise<AuxiliarySnapshot> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [headObject, stateObject] = await Promise.all([
        this.tryGetObject(this.auxiliaryHeadKey(), "auxiliary head"),
        this.tryGetObject(this.auxiliaryStateKey(), "auxiliary state"),
      ]);
      if (!headObject && !stateObject) return { state: this.emptyAuxiliaryState(), head: null };
      if (!headObject || !stateObject) continue;
      if (!headObject.etag || !stateObject.etag)
        throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider omitted auxiliary ETags");
      const state = this.parseAuxiliaryState(
        this.parseJson(stateObject.body, "S3 authority auxiliary state"),
      );
      const head = this.parseAuxiliaryHead(
        this.parseJson(headObject.body, "S3 authority auxiliary head"),
      );
      if (head.digest !== state.digest || head.watermark !== state.watermark) continue;
      return { state, stateEtag: stateObject.etag, head, headEtag: headObject.etag };
    }
    throw new CapletsError("SERVER_UNAVAILABLE", "S3 authority auxiliary state is changing");
  }
  private parseAuxiliaryState(value: unknown): AuxiliaryStateRecord {
    const record = asRecord(value);
    const sessionsRecord = asRecord(record?.sessions);
    const eventsValue = record?.events;
    if (
      !record ||
      record.version !== AUXILIARY_STATE_VERSION ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      !sessionsRecord ||
      !Array.isArray(eventsValue) ||
      eventsValue.length > MAX_AUXILIARY_EVENTS ||
      Object.keys(sessionsRecord).length > MAX_AUXILIARY_SESSIONS ||
      typeof record.digest !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary state is invalid");
    }
    const sessions: Record<string, SessionRecord> = {};
    for (const [sessionId, valueForSession] of Object.entries(sessionsRecord)) {
      const session = asRecord(valueForSession);
      if (
        !session ||
        typeof session.lastUsedAt !== "string" ||
        typeof session.revision !== "string" ||
        typeof session.revoked !== "boolean"
      ) {
        throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary session is invalid");
      }
      sessions[sessionId] = {
        sessionId,
        lastUsedAt: session.lastUsedAt,
        revision: session.revision,
        revoked: session.revoked,
      };
    }
    const events: EventRecord[] = eventsValue.map((valueForEvent) => {
      const eventRecord = asRecord(valueForEvent);
      if (!eventRecord || typeof eventRecord.watermark !== "string" || !("event" in eventRecord)) {
        throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary event is invalid");
      }
      parseNonNegativeWatermark(eventRecord.watermark, "S3 authority auxiliary event watermark");
      return { watermark: eventRecord.watermark, event: redactEvent(eventRecord.event) };
    });
    const parsed = this.withAuxiliaryState(
      {
        version: AUXILIARY_STATE_VERSION,
        authorityId: this.authorityId,
        namespace: this.namespace,
        watermark: parseNonNegativeWatermark(record.watermark, "S3 authority auxiliary watermark"),
        sessions,
        events,
        digest: "",
      },
      {},
    );
    if (record.digest !== parsed.digest)
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary state digest is invalid");
    return parsed;
  }

  private parseAuxiliaryHead(value: unknown): AuxiliaryHeadRecord {
    const record = asRecord(value);
    if (
      !record ||
      record.version !== AUXILIARY_STATE_VERSION ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      typeof record.watermark !== "string" ||
      typeof record.digest !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary head is invalid");
    }
    parseNonNegativeWatermark(record.watermark, "S3 authority auxiliary head watermark");
    return record as unknown as AuxiliaryHeadRecord;
  }

  private async publishAuxiliaryHead(
    state: AuxiliaryStateRecord,
    etag: string | undefined,
  ): Promise<void> {
    const payload: AuxiliaryHeadRecord = {
      version: AUXILIARY_STATE_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      watermark: state.watermark,
      digest: state.digest,
    };
    const result = await this.putObject(
      this.auxiliaryHeadKey(),
      safeJson(payload, "S3 authority auxiliary head"),
      etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
      "auxiliary head",
    );
    if (!result.etag)
      throw new CapletsError(
        "UNSUPPORTED_CAPABILITY",
        "S3 provider omitted the auxiliary head ETag",
      );
  }

  private async publishAuxiliaryCanonical(state: AuxiliaryStateRecord): Promise<void> {
    const stateResult = await this.putObject(
      this.auxiliaryStateKey(),
      safeJson(state, "S3 authority auxiliary state"),
      { ifNoneMatch: "*" },
      "auxiliary restore",
    );
    if (!stateResult.etag)
      throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider omitted auxiliary state ETag");
    await this.publishAuxiliaryHead(state, undefined);
  }

  private parseExportAuxiliary(value: unknown, watermarkValue: unknown): AuxiliaryStateRecord {
    const watermark = parseNonNegativeWatermark(watermarkValue, "S3 authority export watermark");
    if (value === undefined) {
      const empty = this.emptyAuxiliaryState();
      return watermark === "0" ? empty : this.withAuxiliaryState(empty, { watermark });
    }
    const record = asRecord(value);
    const sessionsRecord = asRecord(record?.sessions);
    const securityEvents = record?.securityEvents;
    const cursors = record?.securityEventWatermarks;
    if (
      !record ||
      record.watermark !== watermark ||
      !sessionsRecord ||
      !Array.isArray(securityEvents)
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary export is invalid");
    }
    if (
      cursors !== undefined &&
      (!Array.isArray(cursors) || cursors.length !== securityEvents.length)
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary event cursors are invalid");
    }
    const sessions: Record<string, SessionRecord> = {};
    for (const [sessionId, valueForSession] of Object.entries(sessionsRecord)) {
      const session = asRecord(valueForSession);
      if (
        !session ||
        typeof session.lastUsedAt !== "string" ||
        typeof session.revision !== "string" ||
        (session.revoked !== undefined && typeof session.revoked !== "boolean")
      ) {
        throw new CapletsError("CONFIG_INVALID", "S3 authority auxiliary session is invalid");
      }
      sessions[sessionId] = {
        sessionId,
        lastUsedAt: session.lastUsedAt,
        revision: session.revision,
        revoked: session.revoked === true,
      };
    }
    const events: EventRecord[] = securityEvents.map((entry, index) => {
      const cursor = cursors?.[index];
      const eventWatermark =
        cursor ?? String(Math.max(1, Number(watermark) - securityEvents.length + index + 1));
      parseNonNegativeWatermark(eventWatermark, "S3 authority auxiliary event cursor");
      return { watermark: eventWatermark, event: redactEvent(entry) };
    });
    return this.withAuxiliaryState(
      {
        version: AUXILIARY_STATE_VERSION,
        authorityId: this.authorityId,
        namespace: this.namespace,
        watermark,
        sessions,
        events,
        digest: "",
      },
      {},
    );
  }

  private parseExportReceipts(
    value: unknown,
    generation: AuthorityGeneration,
  ): AuthorityReceipt<unknown>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_RECEIPTS)
      throw new CapletsError("CONFIG_INVALID", "S3 authority receipt export is invalid");
    const now = this.clock().getTime();
    const seen = new Set<string>();
    const receipts: AuthorityReceipt<unknown>[] = [];
    for (const entry of value) {
      const receipt = this.parseReceiptValue(entry);
      if (Date.parse(receipt.expiresAt) <= now)
        throw new CapletsError("CONFIG_INVALID", "S3 restore contains an expired receipt");
      if (receipt.generation.authorityId !== generation.authorityId)
        throw new CapletsError("CONFIG_INVALID", "S3 receipt authority does not match export");
      const key = receiptIdentity(receipt);
      if (seen.has(key))
        throw new CapletsError("CONFIG_INVALID", "S3 receipt export contains duplicates");
      seen.add(key);
      receipts.push(receipt);
    }
    return canonicalReceipts(receipts);
  }

  private async readReceiptManifest(): Promise<{ manifest: ReceiptManifest; etag: string } | null> {
    const object = await this.tryGetObject(this.receiptManifestKey(), "receipt manifest");
    if (!object) return null;
    if (!object.etag)
      throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider omitted receipt manifest ETag");
    const record = asRecord(this.parseJson(object.body, "S3 authority receipt manifest"));
    if (
      !record ||
      record.version !== RECEIPT_MANIFEST_VERSION ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      !Array.isArray(record.receipts) ||
      record.receipts.length > MAX_RECEIPTS ||
      typeof record.digest !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority receipt manifest is invalid");
    }
    const receipts = canonicalReceipts(
      record.receipts.map((entry) => this.parseReceiptValue(entry)),
    );
    const payload = {
      version: RECEIPT_MANIFEST_VERSION as typeof RECEIPT_MANIFEST_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      receipts,
    };
    const manifest: ReceiptManifest = {
      ...payload,
      digest: digestRecord(payload, "S3 authority receipt manifest"),
    };
    if (manifest.digest !== record.digest)
      throw new CapletsError("CONFIG_INVALID", "S3 authority receipt manifest digest is invalid");
    return { manifest, etag: object.etag };
  }

  private async publishReceiptManifestCanonical(
    receipts: readonly AuthorityReceipt<unknown>[],
  ): Promise<void> {
    const payload = {
      version: RECEIPT_MANIFEST_VERSION as typeof RECEIPT_MANIFEST_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      receipts: canonicalReceipts(receipts),
    };
    const manifest: ReceiptManifest = {
      ...payload,
      digest: digestRecord(payload, "S3 authority receipt manifest"),
    };
    const result = await this.putObject(
      this.receiptManifestKey(),
      safeJson(manifest, "S3 authority receipt manifest"),
      { ifNoneMatch: "*" },
      "receipt manifest restore",
    );
    if (!result.etag)
      throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider omitted receipt manifest ETag");
  }
  private async resolveAmbiguousCommit<TResult>(
    envelope: SemanticCommandEnvelope<TCommand>,
    candidate: CandidateRecord<TSnapshot, TResult>,
    previousHead: AuthorityHead | null,
  ): Promise<AuthorityCommitResult<TResult> | null> {
    const receipt = await this.readReceipt<TResult>(envelope);
    if (receipt) return { kind: "replayed", generation: receipt.generation, receipt };
    const current = await this.readHeadRecord();
    if (
      current?.head.id === candidate.generation.id &&
      current.head.digest === candidate.generation.digest
    ) {
      return this.publishCommitResult(envelope, candidate, "replayed");
    }
    if (!sameIdentity(current?.head ?? null, previousHead))
      return { kind: "conflict", active: current?.head ?? null };
    return null;
  }

  private async publishCommitResult<TResult>(
    envelope: SemanticCommandEnvelope<TCommand>,
    candidate: CandidateRecord<TSnapshot, TResult>,
    kind: "committed" | "replayed",
  ): Promise<AuthorityCommitResult<TResult>> {
    const generation = identityOf(candidate.generation);
    const receipt: AuthorityReceipt<TResult> = {
      currentHostId: envelope.currentHostId,
      principalId: envelope.principalId,
      idempotencyKey: envelope.idempotencyKey,
      requestDigest: envelope.requestDigest,
      generation,
      result: candidate.result,
      expiresAt: new Date(this.clock().getTime() + this.receiptTtlMs).toISOString(),
    };
    try {
      await this.publishReceipt(envelope, receipt);
    } catch (error) {
      throw errorForRequest(error);
    }
    return { kind, generation, receipt };
  }

  private async resolveCommand(
    snapshot: unknown,
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<S3CommandApplication<TSnapshot>> {
    if (this.options.applyCommand)
      return this.options.applyCommand({ snapshot, command: envelope.command, envelope });
    const command = asRecord(envelope.command);
    const nextSnapshot = command && "snapshot" in command ? command.snapshot : snapshot;
    const result = command && "result" in command ? command.result : null;
    return { snapshot: nextSnapshot as TSnapshot, result };
  }

  private preflightSnapshotSize(command: TCommand): void {
    if (this.options.applyCommand) return;
    const record = asRecord(command);
    if (!record || !("snapshot" in record)) return;
    this.assertEncodedSize(record.snapshot);
  }

  private assertSnapshotSize(snapshot: unknown): void {
    this.assertEncodedSize(snapshot);
  }

  private assertEncodedSize(value: unknown): void {
    const encoded = safeJson(value, "Authority snapshot");
    if (Buffer.byteLength(encoded, "utf8") > MAX_AUTHORITY_GENERATION_BYTES) {
      throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
    }
  }

  private validateGeneration(generation: AuthorityGeneration): void {
    if (
      generation.authorityId !== this.authorityId ||
      typeof generation.id !== "string" ||
      !generation.id ||
      !Number.isSafeInteger(generation.sequence) ||
      generation.sequence < 1 ||
      (generation.predecessorId !== null && typeof generation.predecessorId !== "string") ||
      !Number.isSafeInteger(generation.schemaVersion) ||
      generation.schemaVersion < 1 ||
      typeof generation.committedAt !== "string" ||
      typeof generation.digest !== "string" ||
      !asRecord(generation.provenance) ||
      typeof generation.provenance.namespace !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority generation is invalid");
    }
    this.assertSnapshotSize(generation.snapshot);
    const encodedGeneration = safeJson(generation, "Authority generation");
    if (Buffer.byteLength(encodedGeneration, "utf8") > MAX_AUTHORITY_GENERATION_BYTES) {
      throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
    }
    if (generation.digest !== digestGeneration(generation)) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority generation digest is invalid");
    }
  }

  private parseJson(body: Uint8Array, label: string): unknown {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
    }
  }

  private parseCandidate<TCandidateSnapshot = unknown, TResult = unknown>(
    value: unknown,
  ): CandidateRecord<TCandidateSnapshot, TResult> {
    const record = asRecord(value);
    const generation = asRecord(record?.generation);
    if (
      !record ||
      !generation ||
      typeof record.requestFingerprint !== "string" ||
      typeof record.deadlineAt !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority candidate is invalid");
    }
    const parsedGeneration = generation as unknown as AuthorityGeneration<TCandidateSnapshot>;
    return {
      generation: parsedGeneration,
      result: record.result as TResult,
      requestFingerprint: record.requestFingerprint,
      deadlineAt: record.deadlineAt,
    };
  }

  private validateMigrationStageContext(context: AuthorityMigrationStageContext): void {
    if (!context || typeof context.owner !== "string" || context.owner.length === 0) {
      throw new CapletsError("CONFIG_INVALID", "S3 migration stage owner is invalid");
    }
  }

  private migrationStageToken(stage: AuthorityMigrationStage): string {
    const token = stage?.token;
    if (
      typeof token !== "string" ||
      token.length < 7 ||
      token.length > 256 ||
      !/^stage-[A-Za-z0-9_-]+$/u.test(token)
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 migration stage token is invalid");
    }
    return token;
  }

  private async readMigrationStageRecord(
    token: string,
    context: AuthorityMigrationStageContext,
  ): Promise<S3MigrationStageRecord> {
    const object = await this.tryGetObject(this.migrationStageMarkerKey(token), "migration stage");
    if (!object) throw new CapletsError("CONFIG_NOT_FOUND", "S3 migration stage was not found");
    const record = asRecord(this.parseJson(object.body, "S3 migration stage"));
    if (
      !record ||
      record.version !== 1 ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      record.owner !== context.owner ||
      record.token !== token ||
      typeof record.generationId !== "string" ||
      typeof record.generationDigest !== "string" ||
      typeof record.deadlineAt !== "string" ||
      !Number.isFinite(Date.parse(record.deadlineAt))
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "S3 migration stage ownership or identity is invalid",
      );
    }
    return record as unknown as S3MigrationStageRecord;
  }

  private async readMigrationStageBundle(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<{
    marker: S3MigrationStageRecord;
    candidate: CandidateRecord;
    receipts: AuthorityReceipt<unknown>[];
    auxiliary: AuxiliaryStateRecord;
  }> {
    const token = this.migrationStageToken(stage);
    const marker = await this.readMigrationStageRecord(token, context);
    const candidateObject = await this.tryGetObject(
      this.migrationStageGenerationKey(token),
      "migration stage candidate",
    );
    if (!candidateObject)
      throw new CapletsError("CONFIG_NOT_FOUND", "S3 migration stage candidate was not found");
    const candidate = this.parseCandidate(
      this.parseJson(candidateObject.body, "S3 migration stage candidate"),
    );
    this.validateGeneration(candidate.generation);
    if (
      candidate.generation.id !== marker.generationId ||
      candidate.generation.digest !== marker.generationDigest ||
      candidate.requestFingerprint !== `migration-${token}` ||
      candidate.deadlineAt !== marker.deadlineAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 migration stage candidate identity is invalid");
    }

    const receiptsObject = await this.tryGetObject(
      this.migrationStageReceiptsKey(token),
      "migration stage receipts",
    );
    if (!receiptsObject)
      throw new CapletsError("CONFIG_NOT_FOUND", "S3 migration stage receipts were not found");
    const manifest = this.parseReceiptManifest(
      this.parseJson(receiptsObject.body, "S3 migration stage receipt manifest"),
      "S3 migration stage receipt manifest",
    );
    const receipts = this.parseExportReceipts(manifest.receipts, candidate.generation);

    const auxiliaryObject = await this.tryGetObject(
      this.migrationStageAuxiliaryKey(token),
      "migration stage auxiliary",
    );
    if (!auxiliaryObject)
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        "S3 migration stage auxiliary state was not found",
      );
    const auxiliary = this.parseAuxiliaryState(
      this.parseJson(auxiliaryObject.body, "S3 migration stage auxiliary state"),
    );
    return { marker, candidate, receipts, auxiliary };
  }

  private exportAuxiliary(state: AuxiliaryStateRecord): AuthorityAuxiliaryExport {
    const events = state.events
      .slice()
      .sort((left, right) => compareWatermarks(left.watermark, right.watermark));
    return {
      watermark: state.watermark,
      sessions: Object.fromEntries(
        Object.entries(state.sessions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sessionId, session]) => [
            sessionId,
            {
              lastUsedAt: session.lastUsedAt,
              revision: session.revision,
              revoked: session.revoked,
            },
          ]),
      ),
      securityEvents: events.map(
        ({ event }) =>
          structuredClone(event) as NonNullable<AuthorityAuxiliaryExport["securityEvents"]>[number],
      ),
      securityEventWatermarks: events.map(({ watermark }) => watermark),
    };
  }

  private parseReceiptManifest(value: unknown, label: string): ReceiptManifest {
    const record = asRecord(value);
    if (
      !record ||
      record.version !== RECEIPT_MANIFEST_VERSION ||
      record.authorityId !== this.authorityId ||
      record.namespace !== this.namespace ||
      !Array.isArray(record.receipts) ||
      record.receipts.length > MAX_RECEIPTS ||
      typeof record.digest !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
    }
    const receipts = canonicalReceipts(
      record.receipts.map((entry) => this.parseReceiptValue(entry)),
    );
    const payload = {
      version: RECEIPT_MANIFEST_VERSION as typeof RECEIPT_MANIFEST_VERSION,
      authorityId: this.authorityId,
      namespace: this.namespace,
      receipts,
    };
    const manifest: ReceiptManifest = {
      ...payload,
      digest: digestRecord(payload, label),
    };
    if (manifest.digest !== record.digest)
      throw new CapletsError("CONFIG_INVALID", `${label} digest is invalid`);
    return manifest;
  }

  private parseSession(body: Uint8Array): SessionRecord {
    const record = asRecord(this.parseJson(body, "S3 authority session"));
    if (
      !record ||
      typeof record.sessionId !== "string" ||
      typeof record.lastUsedAt !== "string" ||
      typeof record.revision !== "string" ||
      typeof record.revoked !== "boolean"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority session is invalid");
    }
    return record as unknown as SessionRecord;
  }

  private parseEvent(body: Uint8Array): EventRecord {
    const record = asRecord(this.parseJson(body, "S3 authority security event"));
    if (!record || typeof record.watermark !== "string" || !("event" in record))
      throw new CapletsError("CONFIG_INVALID", "S3 authority security event is invalid");
    return record as unknown as EventRecord;
  }

  private parseHead(value: unknown): { head: AuthorityHead; requestFingerprint?: string } {
    const record = asRecord(value);
    if (
      !record ||
      typeof record.authorityId !== "string" ||
      typeof record.id !== "string" ||
      typeof record.sequence !== "number" ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      (record.predecessorId !== null && typeof record.predecessorId !== "string") ||
      typeof record.digest !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority head is invalid");
    }
    if (record.authorityId !== this.authorityId)
      throw new CapletsError("CONFIG_INVALID", "S3 authority head identity does not match");
    return {
      head: {
        authorityId: record.authorityId,
        id: record.id,
        sequence: record.sequence,
        predecessorId: record.predecessorId,
        digest: record.digest,
      },
      ...(typeof record.requestFingerprint === "string"
        ? { requestFingerprint: record.requestFingerprint }
        : {}),
    };
  }

  private parseReceiptValue(value: unknown): AuthorityReceipt<unknown> {
    const record = asRecord(value);
    const generation = asRecord(record?.generation);
    if (
      !record ||
      typeof record.currentHostId !== "string" ||
      typeof record.principalId !== "string" ||
      typeof record.idempotencyKey !== "string" ||
      typeof record.requestDigest !== "string" ||
      !generation ||
      typeof generation.authorityId !== "string" ||
      typeof generation.id !== "string" ||
      typeof generation.sequence !== "number" ||
      !Number.isSafeInteger(generation.sequence) ||
      generation.sequence < 1 ||
      (generation.predecessorId !== null && typeof generation.predecessorId !== "string") ||
      typeof record.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(record.expiresAt))
    ) {
      throw new CapletsError("CONFIG_INVALID", "S3 authority receipt is invalid");
    }
    return {
      currentHostId: record.currentHostId,
      principalId: record.principalId,
      idempotencyKey: record.idempotencyKey,
      requestDigest: record.requestDigest,
      generation: {
        authorityId: generation.authorityId,
        id: generation.id,
        sequence: generation.sequence,
        predecessorId: generation.predecessorId,
      },
      result: structuredClone(record.result),
      expiresAt: record.expiresAt,
    };
  }

  private async readHeadRecord(): Promise<HeadRecord | null> {
    const object = await this.tryGetObject(this.headKey(), "head");
    if (!object) return null;
    if (!object.etag)
      throw new CapletsError("UNSUPPORTED_CAPABILITY", "S3 provider omitted the head ETag");
    const parsed = this.parseHead(this.parseJson(object.body, "S3 authority head"));
    await this.readGeneration(parsed.head.id);
    return {
      head: parsed.head,
      etag: object.etag,
      ...(parsed.requestFingerprint ? { requestFingerprint: parsed.requestFingerprint } : {}),
    };
  }

  private async readReceipt<TResult>(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityReceipt<TResult> | null> {
    const identity = `${envelope.currentHostId}\u0000${envelope.principalId}\u0000${envelope.idempotencyKey}`;
    const manifest = await this.readReceiptManifest();
    const fromManifest = manifest?.manifest.receipts.find(
      (receipt) => receiptIdentity(receipt) === identity,
    );
    if (fromManifest) {
      if (fromManifest.requestDigest !== envelope.requestDigest)
        throw new CapletsError(
          "REQUEST_INVALID",
          "Idempotency key was reused with a different request",
        );
      if (Date.parse(fromManifest.expiresAt) <= this.clock().getTime()) return null;
      return fromManifest as AuthorityReceipt<TResult>;
    }
    const object = await this.tryGetObject(this.receiptKey(envelope), "receipt");
    if (!object) return null;
    const receipt = this.parseReceiptValue(this.parseJson(object.body, "S3 authority receipt"));
    if (receipt.requestDigest !== envelope.requestDigest)
      throw new CapletsError(
        "REQUEST_INVALID",
        "Idempotency key was reused with a different request",
      );
    if (Date.parse(receipt.expiresAt) <= this.clock().getTime()) return null;
    await this.ensureReceiptManifest(receipt);
    return receipt as AuthorityReceipt<TResult>;
  }

  private async ensureReceiptManifest(receipt: AuthorityReceipt<unknown>): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readReceiptManifest();
      const now = this.clock().getTime();
      const retained = (current?.manifest.receipts ?? []).filter(
        (entry) => Date.parse(entry.expiresAt) > now,
      );
      const existing = retained.find(
        (entry) => receiptIdentity(entry) === receiptIdentity(receipt),
      );
      if (existing) {
        if (existing.requestDigest !== receipt.requestDigest)
          throw new CapletsError(
            "REQUEST_INVALID",
            "Idempotency key was reused with a different request",
          );
        return;
      }
      if (retained.length >= MAX_RECEIPTS)
        throw new CapletsError("CONFIG_INVALID", "S3 authority receipt capacity is exhausted");
      const payload = {
        version: RECEIPT_MANIFEST_VERSION as typeof RECEIPT_MANIFEST_VERSION,
        authorityId: this.authorityId,
        namespace: this.namespace,
        receipts: canonicalReceipts([...retained, receipt]),
      };
      const next: ReceiptManifest = {
        ...payload,
        digest: digestRecord(payload, "S3 authority receipt manifest"),
      };
      try {
        await this.putObject(
          this.receiptManifestKey(),
          safeJson(next, "S3 authority receipt manifest"),
          current?.etag ? { ifMatch: current.etag } : { ifNoneMatch: "*" },
          "receipt manifest",
        );
        return;
      } catch (error) {
        if (isPreconditionStatus(error)) continue;
        if (isAmbiguousStatus(error)) {
          const reread = await this.readReceiptManifest();
          const found = reread?.manifest.receipts.find(
            (entry) => receiptIdentity(entry) === receiptIdentity(receipt),
          );
          if (found?.requestDigest === receipt.requestDigest) return;
          continue;
        }
        throw errorForRequest(error);
      }
    }
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "S3 authority receipt manifest publication outcome is ambiguous",
    );
  }

  private async publishReceipt<TResult>(
    envelope: SemanticCommandEnvelope<TCommand>,
    receipt: AuthorityReceipt<TResult>,
  ): Promise<void> {
    const key = this.receiptKey(envelope);
    try {
      await this.putObject(
        key,
        safeJson(receipt, "Authority receipt"),
        { ifNoneMatch: "*" },
        "receipt",
      );
    } catch (error) {
      if (isPreconditionStatus(error)) {
        const existing = await this.readReceipt(envelope);
        if (!existing) throw errorForRequest(error);
      } else if (isAmbiguousStatus(error)) {
        const existing = await this.tryGetObject(key, "receipt");
        if (!existing)
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "S3 authority receipt publication outcome is ambiguous",
          );
      } else {
        throw errorForRequest(error);
      }
    }
    await this.ensureReceiptManifest(receipt as AuthorityReceipt<unknown>);
  }

  private async publishCandidate(candidate: CandidateRecord): Promise<void> {
    const key = this.generationKey(candidate.generation.id);
    try {
      await this.putObject(
        key,
        safeJson(candidate, "Authority generation"),
        { ifNoneMatch: "*" },
        "candidate",
      );
    } catch (error) {
      if (isPreconditionStatus(error) || isAmbiguousStatus(error)) {
        const existing = await this.tryGetObject(key, "candidate");
        if (!existing) {
          if (isAmbiguousStatus(error))
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              "S3 authority candidate publication outcome is ambiguous",
            );
          throw errorForRequest(error);
        }
        const parsed = this.parseCandidate(this.parseJson(existing.body, "S3 authority candidate"));
        if (
          parsed.requestFingerprint !== candidate.requestFingerprint ||
          parsed.generation.digest !== candidate.generation.digest
        ) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "S3 authority candidate identity was reused with a different request",
          );
        }
        return;
      }
      throw errorForRequest(error);
    }
  }

  private async publishHead(
    head: AuthorityHead,
    etag: string | undefined,
    requestFingerprint: string,
  ): Promise<void> {
    const conditions = etag ? { ifMatch: etag } : { ifNoneMatch: "*" };
    const result = await this.putObject(
      this.headKey(),
      safeJson({ ...head, requestFingerprint }, "Authority head"),
      conditions,
      "head",
    );
    if (!result.etag)
      throw new CapletsError(
        "UNSUPPORTED_CAPABILITY",
        "S3 provider did not return an ETag for the head",
      );
  }

  private async putObject(
    key: string,
    body: string,
    conditions: { ifMatch?: string; ifNoneMatch?: string },
    operation: string,
  ): Promise<{ etag: string | undefined }> {
    const bytes = new TextEncoder().encode(body);
    const input: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: "application/json",
      ...(conditions.ifMatch ? { IfMatch: conditions.ifMatch } : {}),
      ...(conditions.ifNoneMatch ? { IfNoneMatch: conditions.ifNoneMatch } : {}),
      Metadata: { "caplets-sha256": createHash("sha256").update(bytes).digest("hex") },
    };
    const output = await this.sendRaw(new PutObjectCommand(input), operation);
    const etag = readProperty(output, "ETag");
    return { etag: typeof etag === "string" ? etag : undefined };
  }

  private async getObject(key: string, operation: string): Promise<ObjectRecord> {
    try {
      return await this.withClient(async (client, signal) => {
        const output = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        });
        const body = await bodyBytes(readProperty(output, "Body"));
        const etag = readProperty(output, "ETag");
        const metadata = readProperty(output, "Metadata");
        const metadataRecord = asRecord(metadata);
        const normalizedMetadata = metadataRecord
          ? Object.fromEntries(
              Object.entries(metadataRecord).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {};
        const expectedHash = normalizedMetadata["caplets-sha256"];
        if (expectedHash && expectedHash !== createHash("sha256").update(body).digest("hex")) {
          throw new CapletsError("CONFIG_INVALID", `S3 ${operation} object integrity check failed`);
        }
        return {
          body,
          etag: typeof etag === "string" ? etag : undefined,
          metadata: normalizedMetadata,
        };
      }, operation);
    } catch (error) {
      if (error instanceof CapletsError || error instanceof S3RequestError) throw error;
      throw new S3RequestError(operation, statusOf(error));
    }
  }

  private async tryGetObject(key: string, operation: string): Promise<ObjectRecord | null> {
    try {
      return await this.getObject(key, operation);
    } catch (error) {
      if (isMissingStatus(error)) return null;
      if (error instanceof CapletsError) throw error;
      throw errorForRequest(error);
    }
  }

  private async deleteObject(
    key: string,
    operation: string,
    ifMatch?: string,
    allowClosing = false,
  ): Promise<void> {
    await this.sendRaw(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
      } as DeleteObjectCommandInput),
      operation,
      allowClosing,
    );
  }

  private async listObjects(prefix: string): Promise<string[]> {
    const output = await this.sendRaw(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
      "list",
    );
    const contents = readProperty(output, "Contents");
    if (!Array.isArray(contents)) return [];
    return contents.flatMap((entry) => {
      const key = readProperty(entry, "Key");
      return typeof key === "string" && key.startsWith(this.rootPrefix) ? [key] : [];
    });
  }
  private async latestAuxiliaryWatermark(): Promise<string> {
    const keys = await this.listObjects(this.eventsPrefix());
    let latest = "";
    for (const key of keys) {
      const object = await this.tryGetObject(key, "security event");
      if (!object) continue;
      const event = this.parseEvent(object.body);
      if (event.watermark > latest) latest = event.watermark;
    }
    return latest;
  }

  private async sendRaw(
    command: S3Command,
    operation: string,
    allowClosing = false,
  ): Promise<unknown> {
    this.assertOpen(allowClosing);
    try {
      return await this.withClient(
        (client, signal) => client.send(command, { abortSignal: signal }),
        operation,
      );
    } catch (error) {
      if (error instanceof CapletsError || error instanceof S3RequestError) throw error;
      throw new S3RequestError(operation, statusOf(error));
    }
  }

  private async withClient<T>(
    operation: (client: S3AuthorityClient, signal: AbortSignal) => Promise<T>,
    _label: string,
  ): Promise<T> {
    const credentials = await this.resolveCredentials();
    const usingInjected = Boolean(this.options.client);
    const client =
      this.options.client ??
      (this.options.clientFactory
        ? await this.options.clientFactory(credentials)
        : this.createSdkClient(credentials));
    this.clients.add(client);
    if (!usingInjected) this.ownedClients.add(client);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await operation(client, controller.signal);
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      if (!usingInjected) {
        this.ownedClients.delete(client);
        this.clients.delete(client);
        try {
          client.destroy();
        } catch {
          // The original request result remains authoritative.
        }
      }
    }
  }

  private async resolveCredentials(): Promise<S3CredentialIdentity | undefined> {
    const provider = this.options.credentialProvider ?? this.options.credentials;
    if (!provider) return undefined;
    const resolved = typeof provider === "function" ? await provider() : provider;
    return parseCredential(resolved);
  }

  private createSdkClient(credentials: S3CredentialIdentity | undefined): S3AuthorityClient {
    const config: S3ClientConfig = {
      region: this.region,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(this.options.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: this.options.forcePathStyle }),
      ...(credentials ? { credentials } : {}),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 1,
    };
    return new S3Client(config) as unknown as S3AuthorityClient;
  }

  private requestFingerprint(envelope: SemanticCommandEnvelope<TCommand>): string {
    return createHash("sha256")
      .update(
        `${this.authorityId}\0${envelope.currentHostId}\0${envelope.principalId}\0${envelope.idempotencyKey}\0${envelope.requestDigest}`,
      )
      .digest("hex");
  }

  private candidateId(fingerprint: string): string {
    return `candidate-${fingerprint}`;
  }

  private nextWatermark(): string {
    return this.clock().toISOString();
  }

  private headKey(): string {
    return `${this.rootPrefix}head.json`;
  }

  private generationsPrefix(): string {
    return `${this.rootPrefix}generations/`;
  }

  private generationKey(id: string): string {
    return `${this.generationsPrefix()}${encodeKeyPart(id)}.json`;
  }

  private receiptKey(envelope: SemanticCommandEnvelope<TCommand>): string {
    return `${this.rootPrefix}receipts/${encodeKeyPart(envelope.currentHostId)}/${encodeKeyPart(envelope.principalId)}/${encodeKeyPart(envelope.idempotencyKey)}.json`;
  }

  private receiptManifestKey(): string {
    return `${this.rootPrefix}receipts/manifest.json`;
  }

  private auxiliaryStateKey(): string {
    return `${this.rootPrefix}aux/state.json`;
  }

  private auxiliaryHeadKey(): string {
    return `${this.rootPrefix}aux/head.json`;
  }

  private sessionKey(sessionId: string): string {
    return `${this.rootPrefix}aux/sessions/${encodeKeyPart(sessionId)}.json`;
  }

  private eventsPrefix(): string {
    return `${this.rootPrefix}aux/events/`;
  }

  private migrationStagePrefix(token: string): string {
    return `${this.rootPrefix}staging/${encodeKeyPart(token)}/`;
  }

  private migrationStageMarkerKey(token: string): string {
    return `${this.migrationStagePrefix(token)}stage.json`;
  }

  private migrationStageGenerationKey(token: string): string {
    return `${this.migrationStagePrefix(token)}generation.json`;
  }

  private migrationStageReceiptsKey(token: string): string {
    return `${this.migrationStagePrefix(token)}receipts.json`;
  }

  private migrationStageAuxiliaryKey(token: string): string {
    return `${this.migrationStagePrefix(token)}auxiliary.json`;
  }

  private assertOpen(allowClosing = false): void {
    if (this.closed || (this.closing && !allowClosing)) {
      throw new CapletsError("SERVER_UNAVAILABLE", "S3 authority is closed");
    }
  }
}

export async function createS3Authority<TSnapshot = unknown, TCommand = unknown>(
  options: S3AuthorityOptions<TSnapshot, TCommand>,
): Promise<S3Authority<TSnapshot, TCommand>> {
  return new S3Authority(options);
}
