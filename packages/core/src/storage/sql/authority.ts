import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { CapletsError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";
import {
  MAX_AUTHORITY_GENERATION_BYTES,
  type AuthorityAuxiliaryExport,
  type AuthorityCommitResult,
  type AuthorityExport,
  type AuthorityGeneration,
  type AuthorityMigrationStage,
  type AuthorityMigrationStageContext,
  type AuthorityGenerationIdentity,
  type AuthorityHead,
  type AuthorityHealth,
  type AuthorityReceipt,
  type AuthorityRestoreResult,
  type AuxiliaryCommit,
  type AuxiliaryCommitResult,
  type AuxiliaryRead,
  type MaintenanceFence,
  type MaintenanceFenceContext,
  type MaintenanceFenceLease,
  type RedactedAuthorityEvent,
  type SemanticCommandEnvelope,
  type WritableAuthority,
} from "../types";
import {
  runSqliteMigrations,
  verifyPostgresSchema,
  verifySqliteSchema,
  withPostgresStatementTimeout,
  type SqlMigration,
} from "./migrate";
import { POSTGRES_LOGICAL_SCHEMA_VERSION } from "./schema-postgres";
import { SQLITE_LOGICAL_SCHEMA_VERSION } from "./schema-sqlite";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

const require = createRequire(import.meta.url);

type BetterSqlite3Constructor = new (
  filename: string,
  options?: { timeout?: number },
) => BetterSqlite3.Database;

type DrizzleSqliteFactory = (db: BetterSqlite3.Database) => BetterSQLite3Database;

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const loaded = require("better-sqlite3") as
    | { default?: BetterSqlite3Constructor }
    | BetterSqlite3Constructor;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

function loadDrizzleSqlite(): DrizzleSqliteFactory {
  const loaded = require("drizzle-orm/better-sqlite3") as { drizzle: DrizzleSqliteFactory };
  return loaded.drizzle;
}

function loadPostgres(): typeof postgres {
  const loaded = require("postgres") as { default?: typeof postgres } | typeof postgres;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

function boundedMilliseconds(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > 60_000) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} must be a finite value between 1ms and 60000ms`,
    );
  }
  return Math.floor(resolved);
}

async function withPostgresTeardownTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new CapletsError("SERVER_UNAVAILABLE", `${label} timed out`)),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
    void promise.catch(() => undefined);
  }
}

export type SqlCommandContext<TCommand> = {
  snapshot: unknown;
  command: TCommand;
  envelope: SemanticCommandEnvelope<TCommand>;
};

export type SqlCommandApplication<TSnapshot = unknown, TResult = unknown> = {
  snapshot: TSnapshot;
  result?: TResult;
};

export type SqlCommandApplier<TSnapshot, TCommand> = (
  context: SqlCommandContext<TCommand>,
) => SqlCommandApplication<TSnapshot> | Promise<SqlCommandApplication<TSnapshot>>;

export type SqlAuthorityBaseOptions<TSnapshot = unknown, TCommand = unknown> = {
  authorityId: string;
  namespace: string;
  schemaVersion?: number;
  initialSnapshot?: TSnapshot;
  applyCommand?: SqlCommandApplier<TSnapshot, TCommand>;
  receiptTtlMs?: number;
  clock?: () => Date;
  verifySchema?: boolean;
  maintenanceLeaseMs?: number;
  maintenanceRenewIntervalMs?: number;
};

export type SqliteAuthorityOptions<
  TSnapshot = unknown,
  TCommand = unknown,
> = SqlAuthorityBaseOptions<TSnapshot, TCommand> & {
  databasePath: string;
  busyTimeoutMs?: number;
  checkpointEvery?: number;
  migrations?: readonly SqlMigration[];
};

export type PostgresAuthorityOptions<
  TSnapshot = unknown,
  TCommand = unknown,
> = SqlAuthorityBaseOptions<TSnapshot, TCommand> & {
  connectionString?: string;
  client?: Sql;
  maintenanceClient?: Sql;
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full" | Record<string, unknown>;
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  prepare?: boolean;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  migrations?: readonly SqlMigration[];
};

type SqliteHeadRow = {
  authority_id: string;
  namespace: string;
  generation_id: string | null;
  sequence: number;
  predecessor_id: string | null;
  schema_version: number;
  digest: string | null;
  committed_at: string | null;
};

type SqliteGenerationRow = {
  authority_id: string;
  generation_id: string;
  sequence: number;
  predecessor_id: string | null;
  schema_version: number;
  digest: string;
  committed_at: string;
  snapshot_json: string;
};

type SqliteReceiptRow = {
  authority_id: string;
  current_host_id: string;
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  generation_id: string;
  result_json: string;
  expires_at: string;
};

type SqliteSessionRow = {
  authority_id: string;
  session_id: string;
  revision: number;
  last_used_at: string;
  revoked: number;
};

type SqliteEventRow = {
  authority_id: string;
  watermark: number;
  kind: string;
  occurred_at: string;
  event_json: string;
};

type SqlMaintenanceLeaseRow = {
  authority_id: string;
  namespace: string;
  owner: string;
  token: string;
  deadline_at: string;
  version: number;
};

type SqlMaintenanceState = {
  context: MaintenanceFenceContext;
  token: string;
  lease: MaintenanceFenceLease;
  timer: ReturnType<typeof setInterval>;
  renewing: boolean;
  released: boolean;
};

type PgHeadRow = SqliteHeadRow;
type PgGenerationRow = SqliteGenerationRow;
type PgReceiptRow = SqliteReceiptRow;
type PgSessionRow = SqliteSessionRow;
type PgEventRow = SqliteEventRow;
type PgReceiptJoinRow = PgReceiptRow & {
  generation_authority_id: string | null;
  generation_row_id: string | null;
  generation_sequence: number | null;
  generation_predecessor_id: string | null;
  generation_schema_version: number | null;
  generation_digest: string | null;
  generation_committed_at: string | null;
  generation_snapshot_json: string | null;
};

const POSTGRES_BULK_INSERT_ROWS = 2_000;

type CommandEnvelopeResult = {
  snapshot: unknown;
  result: unknown;
};
type SqlPreparedAuxiliary = {
  watermark: number;
  sessions: Record<string, { revision: string; lastUsedAt: string; revoked: boolean }>;
  securityEvents: RedactedAuthorityEvent[];
  securityEventWatermarks: string[];
};

type SqlPreparedRestore = {
  generation: AuthorityGeneration;
  receipts: AuthorityReceipt<unknown>[];
  auxiliary: SqlPreparedAuxiliary;
};

type SqlMigrationStageToken = {
  authorityId: string;
  candidateAuthorityId: string;
  generationId: string;
  owner: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSqlMigrationStageToken(
  stage: AuthorityMigrationStage,
  authorityId: string,
  owner: string,
): SqlMigrationStageToken {
  if (
    !isRecord(stage.token) ||
    typeof stage.token.authorityId !== "string" ||
    typeof stage.token.candidateAuthorityId !== "string" ||
    typeof stage.token.generationId !== "string" ||
    typeof stage.token.owner !== "string" ||
    stage.token.authorityId !== authorityId ||
    stage.token.owner !== owner ||
    stage.token.candidateAuthorityId.length === 0 ||
    stage.token.generationId.length === 0
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority migration stage token is invalid");
  }
  return {
    authorityId: stage.token.authorityId,
    candidateAuthorityId: stage.token.candidateAuthorityId,
    generationId: stage.token.generationId,
    owner: stage.token.owner,
  };
}

function sqlMigrationCandidateAuthorityId(
  authorityId: string,
  owner: string,
  generationId: string,
): string {
  const suffix = createHash("sha256")
    .update(`${authorityId}\0${owner}\0${generationId}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${authorityId}:migration:${suffix}`;
}

function parseSqlInteger(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  return parsed;
}

function parseSqlWatermark(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  return parseSqlInteger(value, label);
}

function parseSqlTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

function parseSqlGenerationIdentity(value: unknown, label: string): AuthorityGenerationIdentity {
  if (
    !isRecord(value) ||
    typeof value.authorityId !== "string" ||
    value.authorityId.length === 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.predecessorId !== null && typeof value.predecessorId !== "string")
  ) {
    throw new CapletsError("CONFIG_INVALID", `${label} is invalid`);
  }
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

function parseSqlGeneration(
  value: unknown,
  expected: {
    authorityId: string;
    namespace: string;
    provider: "sqlite" | "postgresql";
    schemaVersion: number;
  },
): AuthorityGeneration {
  if (
    !isRecord(value) ||
    typeof value.authorityId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.digest !== "string" ||
    typeof value.schemaVersion !== "number" ||
    typeof value.committedAt !== "string" ||
    !isRecord(value.provenance)
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority generation is invalid");
  }
  const sequence = typeof value.sequence === "number" ? value.sequence : Number.NaN;
  const predecessorId = value.predecessorId;
  const generation = {
    authorityId: value.authorityId,
    id: value.id,
    sequence,
    predecessorId,
    schemaVersion: value.schemaVersion,
    digest: value.digest,
    committedAt: value.committedAt,
    provenance: {
      provider: value.provenance.provider,
      namespace: value.provenance.namespace,
    },
    snapshot: value.snapshot,
  } as AuthorityGeneration;
  if (
    generation.authorityId !== expected.authorityId ||
    generation.provenance.provider !== expected.provider ||
    generation.provenance.namespace !== expected.namespace ||
    generation.schemaVersion !== expected.schemaVersion ||
    typeof generation.id !== "string" ||
    generation.id.length === 0 ||
    !Number.isSafeInteger(generation.sequence) ||
    generation.sequence < 1 ||
    (generation.predecessorId !== null && typeof generation.predecessorId !== "string") ||
    typeof generation.digest !== "string" ||
    parseSqlTimestamp(generation.committedAt, "SQL authority generation committedAt") !==
      generation.committedAt
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "SQL authority generation identity does not match the target",
    );
  }
  validateGenerationDigest(generation);
  const snapshotJson = safeJson(generation.snapshot, "Authority snapshot");
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_AUTHORITY_GENERATION_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
  }
  return generation;
}

function receiptKeyForSqlValues(
  currentHostId: string,
  principalId: string,
  idempotencyKey: string,
): string {
  return `${currentHostId}\0${principalId}\0${idempotencyKey}`;
}

function parseSqlReceipt(
  value: unknown,
  options: { authorityId: string; nowMs: number },
): AuthorityReceipt<unknown> {
  if (
    !isRecord(value) ||
    typeof value.currentHostId !== "string" ||
    value.currentHostId.length === 0 ||
    typeof value.principalId !== "string" ||
    value.principalId.length === 0 ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length === 0 ||
    typeof value.requestDigest !== "string" ||
    value.requestDigest.length === 0 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority receipt is invalid");
  }
  const generation = parseSqlGenerationIdentity(
    value.generation,
    "SQL authority receipt generation",
  );
  if (generation.authorityId !== options.authorityId) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "SQL authority receipt authority does not match the export",
    );
  }
  if (Date.parse(value.expiresAt) <= options.nowMs) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority restore contains an expired receipt");
  }
  safeJson(value.result, "Authority receipt result");
  return {
    currentHostId: value.currentHostId,
    principalId: value.principalId,
    idempotencyKey: value.idempotencyKey,
    requestDigest: value.requestDigest,
    generation,
    result: structuredClone(value.result),
    expiresAt: value.expiresAt,
  };
}

function parseSqlSecurityEvent(value: unknown): RedactedAuthorityEvent {
  if (
    !isRecord(value) ||
    (value.kind !== "rejected" && value.kind !== "conflicted") ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    (value.attemptedGenerationId !== undefined &&
      (typeof value.attemptedGenerationId !== "string" ||
        value.attemptedGenerationId.length === 0)) ||
    (value.idempotencyKeyHash !== undefined &&
      (typeof value.idempotencyKeyHash !== "string" || value.idempotencyKeyHash.length === 0))
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority security event is invalid");
  }
  safeJson(value, "Security event");
  return structuredClone(value) as RedactedAuthorityEvent;
}

function parseSqlAuxiliary(value: unknown, watermark: number): SqlPreparedAuxiliary {
  if (value === undefined) {
    return { watermark, sessions: {}, securityEvents: [], securityEventWatermarks: [] };
  }
  if (
    !isRecord(value) ||
    typeof value.watermark !== "string" ||
    parseSqlWatermark(value.watermark, "SQL authority auxiliary watermark") !== watermark ||
    !isRecord(value.sessions) ||
    Array.isArray(value.sessions) ||
    !Array.isArray(value.securityEvents)
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority auxiliary export is invalid");
  }
  const sessions: Record<string, { revision: string; lastUsedAt: string; revoked: boolean }> = {};
  for (const sessionId of Object.keys(value.sessions).sort()) {
    if (sessionId.length === 0)
      throw new CapletsError("CONFIG_INVALID", "SQL authority session ID is invalid");
    const raw = value.sessions[sessionId];
    if (
      !isRecord(raw) ||
      typeof raw.revision !== "string" ||
      !/^(?:0|[1-9]\d*)$/u.test(raw.revision) ||
      parseSqlInteger(raw.revision, "SQL authority session revision") > watermark ||
      typeof raw.lastUsedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.lastUsedAt)) ||
      typeof raw.revoked !== "boolean"
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQL authority auxiliary session is invalid");
    }
    sessions[sessionId] = {
      revision: raw.revision,
      lastUsedAt: raw.lastUsedAt,
      revoked: raw.revoked,
    };
  }
  const cursors = value.securityEventWatermarks;
  if (
    cursors !== undefined &&
    (!Array.isArray(cursors) || cursors.length !== value.securityEvents.length)
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority security event cursors are invalid");
  }
  const securityEvents: RedactedAuthorityEvent[] = [];
  const securityEventWatermarks: string[] = [];
  let previousWatermark = 0;
  for (let index = 0; index < value.securityEvents.length; index += 1) {
    const event = parseSqlSecurityEvent(value.securityEvents[index]);
    const rawCursor = cursors?.[index];
    const cursor =
      rawCursor === undefined
        ? watermark - value.securityEvents.length + index + 1
        : parseSqlWatermark(rawCursor, "SQL authority security event cursor");
    if (cursor < 1 || cursor > watermark || cursor <= previousWatermark) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQL authority security event cursors are not ordered",
      );
    }
    previousWatermark = cursor;
    securityEvents.push(event);
    securityEventWatermarks.push(String(cursor));
  }
  return { watermark, sessions, securityEvents, securityEventWatermarks };
}

function prepareSqlRestoreState(
  value: unknown,
  expected: {
    authorityId: string;
    namespace: string;
    provider: "sqlite" | "postgresql";
    schemaVersion: number;
  },
  nowMs: number,
): SqlPreparedRestore {
  if (!isRecord(value))
    throw new CapletsError("CONFIG_INVALID", "SQL authority export is malformed");
  const generation = parseSqlGeneration(value.generation, expected);
  const watermark = parseSqlWatermark(value.auxiliaryWatermark, "SQL authority export watermark");
  const auxiliary = parseSqlAuxiliary(value.auxiliary, watermark);
  const rawReceipts = value.receipts;
  if (rawReceipts !== undefined && !Array.isArray(rawReceipts)) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority receipt export is invalid");
  }
  const seen = new Set<string>();
  const receipts = (rawReceipts ?? []).map((entry) => {
    const receipt = parseSqlReceipt(entry, { authorityId: expected.authorityId, nowMs });
    const key = receiptKeyForSqlValues(
      receipt.currentHostId,
      receipt.principalId,
      receipt.idempotencyKey,
    );
    if (seen.has(key))
      throw new CapletsError("CONFIG_INVALID", "SQL authority receipt export contains duplicates");
    seen.add(key);
    return {
      ...receipt,
      generation: {
        authorityId: generation.authorityId,
        id: generation.id,
        sequence: generation.sequence,
        predecessorId: generation.predecessorId,
      },
    };
  });
  receipts.sort((left, right) =>
    receiptKeyForSqlValues(left.currentHostId, left.principalId, left.idempotencyKey).localeCompare(
      receiptKeyForSqlValues(right.currentHostId, right.principalId, right.idempotencyKey),
    ),
  );
  return { generation, receipts, auxiliary };
}

function buildSqlExport(input: {
  provider: "sqlite" | "postgresql";
  authorityId: string;
  namespace: string;
  schemaVersion: number;
  head: SqliteHeadRow;
  generation: SqliteGenerationRow;
  receiptRows: SqliteReceiptRow[];
  receiptGenerationRows: Map<string, SqliteGenerationRow>;
  sessionRows: SqliteSessionRow[];
  eventRows: SqliteEventRow[];
  auxiliaryWatermark: unknown;
  nowMs: number;
}): AuthorityExport {
  if (
    input.head.authority_id !== input.authorityId ||
    input.head.namespace !== input.namespace ||
    !input.head.generation_id ||
    !input.head.digest ||
    input.head.sequence < 1
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority head is invalid");
  }
  if (
    input.generation.authority_id !== input.authorityId ||
    input.generation.generation_id !== input.head.generation_id ||
    input.generation.sequence !== input.head.sequence ||
    input.generation.predecessor_id !== input.head.predecessor_id ||
    input.generation.digest !== input.head.digest
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority head does not match its generation");
  }
  const generation = parseSqlGeneration(
    {
      ...asGeneration(input.generation),
      provenance: { provider: input.provider, namespace: input.namespace },
    },
    {
      authorityId: input.authorityId,
      namespace: input.namespace,
      provider: input.provider,
      schemaVersion: input.schemaVersion,
    },
  );
  const watermark = parseSqlInteger(input.auxiliaryWatermark, "SQL authority auxiliary watermark");
  const sessions: Record<string, { revision: string; lastUsedAt: string; revoked: boolean }> = {};
  for (const row of input.sessionRows) {
    if (
      row.authority_id !== input.authorityId ||
      typeof row.session_id !== "string" ||
      row.session_id.length === 0 ||
      (row.revoked !== 0 && row.revoked !== 1)
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQL authority session record is invalid");
    }
    const revision = parseSqlInteger(row.revision, "SQL authority session revision");
    if (revision > watermark)
      throw new CapletsError("CONFIG_INVALID", "SQL authority session revision exceeds watermark");
    sessions[row.session_id] = {
      revision: String(revision),
      lastUsedAt: parseSqlTimestamp(row.last_used_at, "SQL authority session lastUsedAt"),
      revoked: row.revoked === 1,
    };
  }
  const securityEvents: RedactedAuthorityEvent[] = [];
  const securityEventWatermarks: string[] = [];
  let previousWatermark = 0;
  for (const row of input.eventRows) {
    if (row.authority_id !== input.authorityId)
      throw new CapletsError("CONFIG_INVALID", "SQL authority security event identity is invalid");
    const eventWatermark = parseSqlInteger(row.watermark, "SQL authority security event watermark");
    if (eventWatermark < 1 || eventWatermark > watermark || eventWatermark <= previousWatermark) {
      throw new CapletsError("CONFIG_INVALID", "SQL authority security event watermark is invalid");
    }
    const event = parseSqlSecurityEvent(decodeJson(row.event_json));
    if (event.kind !== row.kind || event.occurredAt !== row.occurred_at) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQL authority security event metadata does not match its payload",
      );
    }
    previousWatermark = eventWatermark;
    securityEvents.push(event);
    securityEventWatermarks.push(String(eventWatermark));
  }
  const receipts: AuthorityReceipt<unknown>[] = [];
  const receiptKeys = new Set<string>();
  for (const row of input.receiptRows) {
    if (row.authority_id !== input.authorityId)
      throw new CapletsError("CONFIG_INVALID", "SQL authority receipt identity is invalid");
    const generationRow = input.receiptGenerationRows.get(row.generation_id);
    if (!generationRow)
      throw new CapletsError("CONFIG_INVALID", "Authority receipt references a missing generation");
    const receipt = parseSqlReceipt(
      {
        currentHostId: row.current_host_id,
        principalId: row.principal_id,
        idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest,
        generation: generationIdentity(generationRow),
        result: decodeJson(row.result_json),
        expiresAt: row.expires_at,
      },
      { authorityId: input.authorityId, nowMs: input.nowMs },
    );
    const key = receiptKeyForSqlValues(
      receipt.currentHostId,
      receipt.principalId,
      receipt.idempotencyKey,
    );
    if (receiptKeys.has(key))
      throw new CapletsError("CONFIG_INVALID", "SQL authority has duplicate receipt records");
    receiptKeys.add(key);
    receipts.push(receipt);
  }
  receipts.sort((left, right) =>
    receiptKeyForSqlValues(left.currentHostId, left.principalId, left.idempotencyKey).localeCompare(
      receiptKeyForSqlValues(right.currentHostId, right.principalId, right.idempotencyKey),
    ),
  );
  const auxiliary: AuthorityAuxiliaryExport = {
    watermark: String(watermark),
    sessions,
    securityEvents,
    securityEventWatermarks,
  };
  return { generation, auxiliaryWatermark: String(watermark), receipts, auxiliary };
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CapletsError("CONFIG_INVALID", "SQL authority persisted JSON is invalid");
  }
}

function safeJson(value: unknown, label: string): string {
  try {
    const encoded = stableJsonStringify(value);
    if (encoded === undefined) throw new Error(`${label} is not serializable`);
    return encoded;
  } catch {
    throw new CapletsError("REQUEST_INVALID", `${label} is not serializable`);
  }
}

function digestGeneration(input: {
  authorityId: string;
  id: string;
  sequence: number;
  predecessorId: string | null;
  schemaVersion: number;
  committedAt: string;
  snapshot: unknown;
}): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(input)).digest("hex")}`;
}

function generationIdentity(row: {
  authority_id: string;
  generation_id: string;
  sequence: number;
  predecessor_id: string | null;
}): AuthorityGenerationIdentity {
  return {
    authorityId: row.authority_id,
    id: row.generation_id,
    sequence: row.sequence,
    predecessorId: row.predecessor_id,
  };
}

function matchesExpected(
  expected: AuthorityGenerationIdentity | null,
  head: AuthorityHead | null,
): boolean {
  if (!expected) return head === null;
  return Boolean(
    head &&
    expected.authorityId === head.authorityId &&
    expected.id === head.id &&
    expected.sequence === head.sequence &&
    expected.predecessorId === head.predecessorId,
  );
}
function semanticSessionExists(snapshot: unknown, sessionId: string): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const root = snapshot as Record<string, unknown>;
  for (const value of [root.dashboardSessions, root.sessions]) {
    if (Array.isArray(value)) {
      if (
        value.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).sessionId === sessionId,
        )
      )
        return true;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as { sessions?: unknown };
      if (Array.isArray(record.sessions)) {
        if (
          record.sessions.some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as Record<string, unknown>).sessionId === sessionId,
          )
        )
          return true;
        continue;
      }
      if (Object.hasOwn(value, sessionId)) return true;
    }
  }
  return false;
}
function validateGenerationDigest(generation: AuthorityGeneration): void {
  if (!Number.isSafeInteger(generation.sequence) || generation.sequence < 1) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority generation sequence is invalid");
  }
  const expected = digestGeneration({
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
    schemaVersion: generation.schemaVersion,
    committedAt: generation.committedAt,
    snapshot: generation.snapshot,
  });
  if (expected !== generation.digest) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority generation digest is invalid");
  }
}

function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".").map((part) => Number.parseInt(part, 10));
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function authorityError(error: unknown, provider: "sqlite" | "postgresql"): CapletsError {
  if (error instanceof CapletsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|busy|locked|deadlock|serialization/i.test(message)) {
    return new CapletsError("SERVER_UNAVAILABLE", `${provider} authority operation timed out`);
  }
  if (/unique|duplicate|constraint/i.test(message)) {
    return new CapletsError("REQUEST_INVALID", `${provider} authority operation conflicted`);
  }
  return new CapletsError("SERVER_UNAVAILABLE", `${provider} authority operation failed`);
}

function commandValue(command: unknown, key: string): unknown {
  if (command && typeof command === "object" && key in command) {
    return command[key as keyof typeof command];
  }
  return undefined;
}

async function resolveCommand<TSnapshot, TCommand>(
  options: SqlAuthorityBaseOptions<TSnapshot, TCommand>,
  snapshot: unknown,
  envelope: SemanticCommandEnvelope<TCommand>,
): Promise<CommandEnvelopeResult> {
  if (options.applyCommand) {
    const result = await options.applyCommand({ snapshot, command: envelope.command, envelope });
    return { snapshot: result.snapshot, result: result.result ?? null };
  }
  const candidate = commandValue(envelope.command, "snapshot");
  return {
    snapshot: candidate === undefined ? snapshot : candidate,
    result: commandValue(envelope.command, "result") ?? null,
  };
}

function asGeneration<TSnapshot>(
  row: SqliteGenerationRow | PgGenerationRow,
): AuthorityGeneration<TSnapshot> {
  const snapshot = decodeJson<TSnapshot>(row.snapshot_json);
  const expectedDigest = digestGeneration({
    authorityId: row.authority_id,
    id: row.generation_id,
    sequence: row.sequence,
    predecessorId: row.predecessor_id,
    schemaVersion: row.schema_version,
    committedAt: row.committed_at,
    snapshot,
  });
  if (expectedDigest !== row.digest) {
    throw new CapletsError("CONFIG_INVALID", "SQL authority generation digest is invalid");
  }
  return {
    authorityId: row.authority_id,
    id: row.generation_id,
    sequence: row.sequence,
    predecessorId: row.predecessor_id,
    schemaVersion: row.schema_version,
    digest: row.digest,
    committedAt: row.committed_at,
    provenance: { provider: "sqlite", namespace: "" },
    snapshot,
  };
}

function sqliteHealth<TSnapshot, TCommand>(
  authority: SqliteAuthority<TSnapshot, TCommand>,
  head: AuthorityHead | null,
): AuthorityHealth {
  return {
    provider: "sqlite",
    authorityId: authority.authorityId,
    connectivity: "healthy",
    writable: true,
    activeGeneration: head,
    refresh: "current",
  };
}

export type SqliteBackupMetadata = {
  totalPages: number;
  remainingPages: number;
};

export class SqliteAuthority<TSnapshot = unknown, TCommand = unknown> implements WritableAuthority<
  TSnapshot,
  TCommand
> {
  readonly authorityId: string;
  readonly namespace: string;
  readonly schemaVersion: number;
  private readonly db!: BetterSqlite3.Database;
  private readonly drizzleDb: BetterSQLite3Database;
  private readonly options: SqliteAuthorityOptions<TSnapshot, TCommand>;
  private readonly now: () => Date;
  private commitsSinceCheckpoint = 0;
  private closed = false;
  private readonly maintenanceLeaseMs: number;
  private readonly maintenanceRenewIntervalMs: number;
  private readonly maintenanceLeases = new Map<string, SqlMaintenanceState>();

  constructor(options: SqliteAuthorityOptions<TSnapshot, TCommand>) {
    if (typeof process !== "undefined" && process.versions.bun) {
      throw new CapletsError("UNSUPPORTED_OPERATION", "SQLite authority requires Node.js");
    }
    if (
      options.databasePath !== ":memory:" &&
      (options.databasePath.length === 0 ||
        options.databasePath.includes("\0") ||
        options.databasePath.startsWith("//") ||
        options.databasePath.startsWith("\\\\") ||
        /^(?:file|https?|nfs|smb|cifs):\/\//i.test(options.databasePath))
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQLite authority path must be local");
    }
    const configuredSchemaVersion = options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION;
    const migrations = options.migrations;
    const migrationVersion = migrations?.at(-1)?.version ?? SQLITE_LOGICAL_SCHEMA_VERSION;
    if (configuredSchemaVersion !== migrationVersion) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQLite authority schema version is incompatible with its migration history",
      );
    }
    const busyTimeoutMs = boundedMilliseconds(options.busyTimeoutMs, 2_000, "SQLite busy timeout");
    const checkpointEvery = options.checkpointEvery ?? 20;
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1 || checkpointEvery > 10_000) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQLite checkpoint interval must be a positive integer",
      );
    }
    const maintenanceLeaseMs = boundedMilliseconds(
      options.maintenanceLeaseMs,
      15_000,
      "SQLite maintenance lease",
    );
    const maintenanceRenewIntervalMs = boundedMilliseconds(
      options.maintenanceRenewIntervalMs,
      Math.max(1, Math.floor(maintenanceLeaseMs / 3)),
      "SQLite maintenance renewal interval",
    );
    if (maintenanceRenewIntervalMs >= maintenanceLeaseMs) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQLite maintenance renewal interval must be shorter than the lease",
      );
    }
    this.authorityId = options.authorityId;
    this.namespace = options.namespace;
    this.schemaVersion = configuredSchemaVersion;
    this.options = options;
    this.maintenanceLeaseMs = maintenanceLeaseMs;
    this.maintenanceRenewIntervalMs = maintenanceRenewIntervalMs;
    this.now = options.clock ?? (() => new Date());
    const databasePath =
      options.databasePath === ":memory:" ? options.databasePath : resolve(options.databasePath);
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    try {
      const BetterSqlite3 = loadBetterSqlite3();
      this.db = new BetterSqlite3(databasePath, { timeout: busyTimeoutMs });
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
      if (options.verifySchema === false) {
        runSqliteMigrations(this.db, {
          authorityId: options.authorityId,
          namespace: options.namespace,
          busyTimeoutMs,
          ...(migrations ? { migrations } : {}),
        });
      } else {
        verifySqliteSchema(this.db, {
          authorityId: options.authorityId,
          namespace: options.namespace,
          ...(migrations ? { migrations } : {}),
        });
      }
      this.sqliteRuntimeVersion();
      this.db
        .prepare(
          "INSERT INTO authority_heads (authority_id, namespace, schema_version) VALUES (?, ?, ?) ON CONFLICT(authority_id) DO NOTHING",
        )
        .run(options.authorityId, options.namespace, configuredSchemaVersion);
      this.db
        .prepare(
          "INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version) VALUES (?, ?, ?) ON CONFLICT(authority_id) DO UPDATE SET logical_schema_version = excluded.logical_schema_version",
        )
        .run(options.authorityId, options.namespace, configuredSchemaVersion);
      this.drizzleDb = loadDrizzleSqlite()(this.db);
    } catch (error) {
      try {
        this.db?.close();
      } catch {
        // The constructor error is authoritative.
      }
      throw authorityError(error, "sqlite");
    }
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

  static async open<TSnapshot = unknown, TCommand = unknown>(
    options: SqliteAuthorityOptions<TSnapshot, TCommand>,
  ): Promise<SqliteAuthority<TSnapshot, TCommand>> {
    return new SqliteAuthority(options);
  }

  async readHead(): Promise<AuthorityHead | null> {
    this.ensureOpen();
    const row = this.db
      .prepare(
        "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
      )
      .get(this.authorityId) as SqliteHeadRow | undefined;
    if (!row || !row.generation_id || !row.digest || !row.committed_at || row.sequence < 1)
      return null;
    return {
      authorityId: row.authority_id,
      id: row.generation_id,
      sequence: row.sequence,
      predecessorId: row.predecessor_id,
      digest: row.digest,
    };
  }

  async readGeneration(id: string): Promise<AuthorityGeneration<TSnapshot>> {
    this.ensureOpen();
    const row = this.db
      .prepare(
        "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
      )
      .get(this.authorityId, id) as SqliteGenerationRow | undefined;
    if (!row) throw new CapletsError("CONFIG_NOT_FOUND", "SQL authority generation was not found");
    const generation = asGeneration<TSnapshot>(row);
    return {
      ...generation,
      provenance: { provider: "sqlite", namespace: this.namespace },
    };
  }

  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityCommitResult<TResult>> {
    this.ensureOpen();
    if (envelope.authorityId !== this.authorityId)
      throw new CapletsError("REQUEST_INVALID", "Authority identity does not match the connection");
    const current = await this.readCurrentSnapshot();
    const candidate = await resolveCommand(this.options, current, envelope);
    const snapshotJson = safeJson(candidate.snapshot, "Authority snapshot");
    if (Buffer.byteLength(snapshotJson, "utf8") > MAX_AUTHORITY_GENERATION_BYTES) {
      throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
    }
    const now = this.now();
    const committedAt = now.toISOString();
    const receiptExpiry = new Date(
      now.getTime() + (this.options.receiptTtlMs ?? 24 * 60 * 60 * 1000),
    ).toISOString();
    const id = randomUUID();
    const transaction = this.db.transaction((): AuthorityCommitResult<TResult> => {
      this.assertMaintenanceWriteAllowedSqlite();
      const receipt = this.db
        .prepare(
          "SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ? AND current_host_id = ? AND principal_id = ? AND idempotency_key = ? AND expires_at > ?",
        )
        .get(
          this.authorityId,
          envelope.currentHostId,
          envelope.principalId,
          envelope.idempotencyKey,
          committedAt,
        ) as SqliteReceiptRow | undefined;
      if (receipt) {
        if (receipt.request_digest !== envelope.requestDigest)
          throw new CapletsError(
            "REQUEST_INVALID",
            "Idempotency key was reused with a different request",
          );
        const generationRow = this.db
          .prepare(
            "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
          )
          .get(this.authorityId, receipt.generation_id) as SqliteGenerationRow | undefined;
        if (!generationRow)
          throw new CapletsError(
            "CONFIG_INVALID",
            "Authority receipt references a missing generation",
          );
        const generation = generationIdentity(generationRow);
        const authorityReceipt: AuthorityReceipt<TResult> = {
          currentHostId: receipt.current_host_id,
          principalId: receipt.principal_id,
          idempotencyKey: receipt.idempotency_key,
          requestDigest: receipt.request_digest,
          generation,
          result: decodeJson<TResult>(receipt.result_json),
          expiresAt: receipt.expires_at,
        };
        return { kind: "replayed", generation, receipt: authorityReceipt };
      }
      const headRow = this.db
        .prepare(
          "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
        )
        .get(this.authorityId) as SqliteHeadRow | undefined;
      const head =
        headRow &&
        headRow.generation_id &&
        headRow.digest &&
        headRow.committed_at &&
        headRow.sequence > 0
          ? {
              authorityId: headRow.authority_id,
              id: headRow.generation_id,
              sequence: headRow.sequence,
              predecessorId: headRow.predecessor_id,
              digest: headRow.digest,
            }
          : null;
      if (!matchesExpected(envelope.expectedGeneration, head))
        return { kind: "conflict", active: head };
      const sequence = (head?.sequence ?? 0) + 1;
      const predecessorId = head?.id ?? null;
      const digest = digestGeneration({
        authorityId: this.authorityId,
        id,
        sequence,
        predecessorId,
        schemaVersion: this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
        committedAt,
        snapshot: candidate.snapshot,
      });
      this.db
        .prepare(
          "INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.authorityId,
          id,
          sequence,
          predecessorId,
          this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
          digest,
          committedAt,
          snapshotJson,
        );
      this.db
        .prepare(
          "UPDATE authority_heads SET namespace = ?, generation_id = ?, sequence = ?, predecessor_id = ?, schema_version = ?, digest = ?, committed_at = ? WHERE authority_id = ?",
        )
        .run(
          this.namespace,
          id,
          sequence,
          predecessorId,
          this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
          digest,
          committedAt,
          this.authorityId,
        );
      const resultJson = safeJson(candidate.result, "Authority receipt result");
      this.db
        .prepare(
          "INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.authorityId,
          envelope.currentHostId,
          envelope.principalId,
          envelope.idempotencyKey,
          envelope.requestDigest,
          id,
          resultJson,
          receiptExpiry,
        );
      const generation = { authorityId: this.authorityId, id, sequence, predecessorId };
      const authorityReceipt: AuthorityReceipt<TResult> = {
        currentHostId: envelope.currentHostId,
        principalId: envelope.principalId,
        idempotencyKey: envelope.idempotencyKey,
        requestDigest: envelope.requestDigest,
        generation,
        result: decodeJson<TResult>(resultJson),
        expiresAt: receiptExpiry,
      };
      return { kind: "committed", generation, receipt: authorityReceipt };
    });
    try {
      const result = transaction.immediate();
      this.commitsSinceCheckpoint += result.kind === "committed" ? 1 : 0;
      if (this.commitsSinceCheckpoint >= (this.options.checkpointEvery ?? 20)) {
        this.checkpoint();
        this.commitsSinceCheckpoint = 0;
      }
      return result;
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    this.ensureOpen();
    if (request.kind === "session_touch") {
      const row = this.db
        .prepare(
          "SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ? AND session_id = ?",
        )
        .get(this.authorityId, request.sessionId) as SqliteSessionRow | undefined;
      return row
        ? {
            sessionId: row.session_id,
            revision: String(row.revision),
            lastUsedAt: row.last_used_at,
            revoked: row.revoked === 1,
          }
        : null;
    }
    const after = request.afterWatermark ? Number.parseInt(request.afterWatermark, 10) : 0;
    const rows = this.db
      .prepare(
        "SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ? AND watermark > ? ORDER BY watermark LIMIT ?",
      )
      .all(this.authorityId, after, request.limit) as SqliteEventRow[];
    const meta = this.db
      .prepare("SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?")
      .get(this.authorityId) as { auxiliary_watermark: number };
    return {
      watermark: String(meta?.auxiliary_watermark ?? after),
      events: rows.map((row) => decodeJson(row.event_json)),
    };
  }

  async commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    this.ensureOpen();
    try {
      const result = this.db
        .transaction((): AuxiliaryCommitResult => {
          this.assertMaintenanceWriteAllowedSqlite();
          const meta = this.db
            .prepare("SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?")
            .get(this.authorityId) as { auxiliary_watermark: number };
          if (command.kind === "remove_session_touch") {
            const deleted = this.db
              .prepare("DELETE FROM authority_sessions WHERE authority_id = ? AND session_id = ?")
              .run(this.authorityId, command.sessionId);
            if (deleted.changes === 0) {
              return { kind: "unchanged", watermark: String(meta.auxiliary_watermark) };
            }
            const watermark = meta.auxiliary_watermark + 1;
            this.db
              .prepare(
                "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
              )
              .run(watermark, this.authorityId);
            return { kind: "applied", watermark: String(watermark) };
          }
          if (command.kind === "session_touch") {
            const headRow = this.db
              .prepare(
                "SELECT authority_id, generation_id, sequence, predecessor_id, digest FROM authority_heads WHERE authority_id = ?",
              )
              .get(this.authorityId) as
              | {
                  authority_id: string;
                  generation_id: string | null;
                  sequence: number;
                  predecessor_id: string | null;
                  digest: string | null;
                }
              | undefined;
            const currentHead =
              headRow?.generation_id && headRow.digest && headRow.sequence > 0
                ? {
                    authorityId: headRow.authority_id,
                    id: headRow.generation_id,
                    sequence: headRow.sequence,
                    predecessorId: headRow.predecessor_id,
                    digest: headRow.digest,
                  }
                : null;
            if (!matchesExpected(command.expectedGeneration, currentHead))
              return { kind: "conflict" };
            const session = this.db
              .prepare(
                "SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ? AND session_id = ?",
              )
              .get(this.authorityId, command.sessionId) as SqliteSessionRow | undefined;
            if (!session) {
              if (command.expectedRevision !== "" || !currentHead) return { kind: "missing" };
              const generationRow = this.db
                .prepare(
                  "SELECT snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
                )
                .get(this.authorityId, currentHead.id) as { snapshot_json: string } | undefined;
              if (
                !generationRow ||
                !semanticSessionExists(decodeJson(generationRow.snapshot_json), command.sessionId)
              )
                return { kind: "missing" };
              const watermark = meta.auxiliary_watermark + 1;
              this.db
                .prepare(
                  "INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (?, ?, ?, ?, 0)",
                )
                .run(this.authorityId, command.sessionId, watermark, command.lastUsedAt);
              this.db
                .prepare(
                  "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
                )
                .run(watermark, this.authorityId);
              return { kind: "applied", watermark: String(watermark) };
            }
            if (session.revoked) return { kind: "revoked" };
            if (String(session.revision) !== command.expectedRevision) return { kind: "conflict" };
            if (command.lastUsedAt <= session.last_used_at)
              return { kind: "unchanged", watermark: String(meta.auxiliary_watermark) };
            const watermark = meta.auxiliary_watermark + 1;
            this.db
              .prepare(
                "UPDATE authority_sessions SET revision = ?, last_used_at = ? WHERE authority_id = ? AND session_id = ? AND revision = ? AND revoked = 0",
              )
              .run(
                watermark,
                command.lastUsedAt,
                this.authorityId,
                command.sessionId,
                session.revision,
              );
            this.db
              .prepare(
                "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
              )
              .run(watermark, this.authorityId);
            return { kind: "applied", watermark: String(watermark) };
          }
          const watermark = meta.auxiliary_watermark + 1;
          const eventJson = safeJson(command.event, "Security event");
          this.db
            .prepare(
              "INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              this.authorityId,
              watermark,
              command.event.kind,
              command.event.occurredAt,
              eventJson,
            );
          this.db
            .prepare(
              "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
            )
            .run(watermark, this.authorityId);
          return { kind: "applied", watermark: String(watermark) };
        })
        .immediate();
      return result;
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async health(): Promise<AuthorityHealth> {
    if (this.closed)
      return {
        provider: "sqlite",
        authorityId: this.authorityId,
        connectivity: "unavailable",
        writable: false,
        activeGeneration: null,
        refresh: "failed",
        code: "CLOSED",
      };
    try {
      return sqliteHealth(this, await this.readHead());
    } catch {
      return {
        provider: "sqlite",
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
    this.ensureOpen();
    const now = this.now();
    const nowIso = now.toISOString();
    try {
      const exported = this.db
        .transaction((): AuthorityExport => {
          this.assertMaintenanceWriteAllowedSqlite();
          const head = this.db
            .prepare(
              "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
            )
            .get(this.authorityId) as SqliteHeadRow | undefined;
          if (!head?.generation_id)
            throw new CapletsError("CONFIG_NOT_FOUND", "SQL authority has no committed generation");
          const generation = this.db
            .prepare(
              "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
            )
            .get(this.authorityId, head.generation_id) as SqliteGenerationRow | undefined;
          if (!generation)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority head references a missing generation",
            );
          const receiptRows = this.db
            .prepare(
              "SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ? AND expires_at > ? ORDER BY current_host_id, principal_id, idempotency_key",
            )
            .all(this.authorityId, nowIso) as SqliteReceiptRow[];
          const receiptGenerationRows = new Map<string, SqliteGenerationRow>();
          for (const row of receiptRows) {
            if (receiptGenerationRows.has(row.generation_id)) continue;
            const receiptGeneration = this.db
              .prepare(
                "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
              )
              .get(this.authorityId, row.generation_id) as SqliteGenerationRow | undefined;
            if (!receiptGeneration)
              throw new CapletsError(
                "CONFIG_INVALID",
                "Authority receipt references a missing generation",
              );
            receiptGenerationRows.set(row.generation_id, receiptGeneration);
          }
          const sessionRows = this.db
            .prepare(
              "SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ? ORDER BY session_id",
            )
            .all(this.authorityId) as SqliteSessionRow[];
          const eventRows = this.db
            .prepare(
              "SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ? ORDER BY watermark",
            )
            .all(this.authorityId) as SqliteEventRow[];
          const meta = this.db
            .prepare("SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?")
            .get(this.authorityId) as { auxiliary_watermark: number } | undefined;
          return buildSqlExport({
            provider: "sqlite",
            authorityId: this.authorityId,
            namespace: this.namespace,
            schemaVersion: this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
            head,
            generation,
            receiptRows,
            receiptGenerationRows,
            sessionRows,
            eventRows,
            auxiliaryWatermark: meta?.auxiliary_watermark,
            nowMs: now.getTime(),
          });
        })
        .immediate();
      return exported;
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult> {
    this.ensureOpen();
    const prepared = prepareSqlRestoreState(
      state,
      {
        authorityId: this.authorityId,
        namespace: this.namespace,
        provider: "sqlite",
        schemaVersion: this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
      },
      this.now().getTime(),
    );
    const snapshotJson = safeJson(prepared.generation.snapshot, "Authority snapshot");
    const auxiliaryEventRows = prepared.auxiliary.securityEvents.map((event, index) => ({
      watermark: Number(prepared.auxiliary.securityEventWatermarks[index]),
      event,
    }));
    try {
      this.db
        .transaction(() => {
          this.assertMaintenanceWriteAllowedSqlite();
          const head = this.db
            .prepare(
              "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
            )
            .get(this.authorityId) as SqliteHeadRow | undefined;
          const meta = this.db
            .prepare(
              "SELECT authority_id, namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?",
            )
            .get(this.authorityId) as
            | {
                authority_id: string;
                namespace: string;
                logical_schema_version: number;
                auxiliary_watermark: number;
              }
            | undefined;
          if (
            !head ||
            !meta ||
            head.namespace !== this.namespace ||
            meta.namespace !== this.namespace ||
            meta.logical_schema_version !==
              (this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION)
          ) {
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority target schema identity is invalid",
            );
          }
          const occupied =
            head.generation_id !== null ||
            head.sequence !== 0 ||
            head.digest !== null ||
            head.committed_at !== null ||
            meta.auxiliary_watermark !== 0 ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_generations WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_receipts WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_sessions WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_events WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            );
          if (occupied)
            throw new CapletsError(
              "CONFIG_EXISTS",
              "SQL authority restore requires an empty target",
            );
          this.db
            .prepare(
              "INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              this.authorityId,
              prepared.generation.id,
              prepared.generation.sequence,
              prepared.generation.predecessorId,
              prepared.generation.schemaVersion,
              prepared.generation.digest,
              prepared.generation.committedAt,
              snapshotJson,
            );
          this.db
            .prepare(
              "UPDATE authority_heads SET namespace = ?, generation_id = ?, sequence = ?, predecessor_id = ?, schema_version = ?, digest = ?, committed_at = ? WHERE authority_id = ?",
            )
            .run(
              this.namespace,
              prepared.generation.id,
              prepared.generation.sequence,
              prepared.generation.predecessorId,
              prepared.generation.schemaVersion,
              prepared.generation.digest,
              prepared.generation.committedAt,
              this.authorityId,
            );
          for (const receipt of prepared.receipts) {
            this.db
              .prepare(
                "INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                receipt.currentHostId,
                receipt.principalId,
                receipt.idempotencyKey,
                receipt.requestDigest,
                prepared.generation.id,
                safeJson(receipt.result, "Authority receipt result"),
                receipt.expiresAt,
              );
          }
          for (const [sessionId, session] of Object.entries(prepared.auxiliary.sessions)) {
            this.db
              .prepare(
                "INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                sessionId,
                Number(session.revision),
                session.lastUsedAt,
                session.revoked ? 1 : 0,
              );
          }
          for (const row of auxiliaryEventRows) {
            this.db
              .prepare(
                "INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                row.watermark,
                row.event.kind,
                row.event.occurredAt,
                safeJson(row.event, "Security event"),
              );
          }
          this.db
            .prepare(
              "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
            )
            .run(prepared.auxiliary.watermark, this.authorityId);
        })
        .immediate();
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
    return {
      generation: {
        authorityId: prepared.generation.authorityId,
        id: prepared.generation.id,
        sequence: prepared.generation.sequence,
        predecessorId: prepared.generation.predecessorId,
      },
      auxiliaryWatermark: String(prepared.auxiliary.watermark),
    };
  }

  async stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage> {
    this.ensureOpen();
    if (context.owner.length === 0)
      throw new CapletsError("CONFIG_INVALID", "SQL authority migration owner is missing");
    const prepared = prepareSqlRestoreState(
      state,
      {
        authorityId: this.authorityId,
        namespace: this.namespace,
        provider: "sqlite",
        schemaVersion: this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
      },
      this.now().getTime(),
    );
    const candidateAuthorityId = sqlMigrationCandidateAuthorityId(
      this.authorityId,
      context.owner,
      prepared.generation.id,
    );
    const candidateGeneration = {
      ...prepared.generation,
      authorityId: candidateAuthorityId,
      digest: digestGeneration({
        authorityId: candidateAuthorityId,
        id: prepared.generation.id,
        sequence: prepared.generation.sequence,
        predecessorId: prepared.generation.predecessorId,
        schemaVersion: prepared.generation.schemaVersion,
        committedAt: prepared.generation.committedAt,
        snapshot: prepared.generation.snapshot,
      }),
    };
    const snapshotJson = safeJson(candidateGeneration.snapshot, "Authority snapshot");
    const auxiliaryEventRows = prepared.auxiliary.securityEvents.map((event, index) => ({
      watermark: Number(prepared.auxiliary.securityEventWatermarks[index]),
      event,
    }));
    const token: SqlMigrationStageToken = {
      authorityId: this.authorityId,
      candidateAuthorityId,
      generationId: prepared.generation.id,
      owner: context.owner,
    };
    try {
      this.db
        .transaction(() => {
          this.assertMaintenanceWriteAllowedSqlite();
          const head = this.db
            .prepare(
              "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
            )
            .get(this.authorityId) as SqliteHeadRow | undefined;
          const meta = this.db
            .prepare(
              "SELECT namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?",
            )
            .get(this.authorityId) as
            | { namespace: string; logical_schema_version: number; auxiliary_watermark: number }
            | undefined;
          if (
            !head ||
            !meta ||
            head.namespace !== this.namespace ||
            meta.namespace !== this.namespace ||
            meta.logical_schema_version !==
              (this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION)
          ) {
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority target schema identity is invalid",
            );
          }
          const occupied =
            head.generation_id !== null ||
            head.sequence !== 0 ||
            head.digest !== null ||
            head.committed_at !== null ||
            meta.auxiliary_watermark !== 0 ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_generations WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_receipts WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_sessions WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_events WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            );
          if (occupied)
            throw new CapletsError("CONFIG_EXISTS", "SQL authority migration target is not empty");
          const candidateHead = this.db
            .prepare(
              "SELECT generation_id, sequence, digest, committed_at FROM authority_heads WHERE authority_id = ?",
            )
            .get(candidateAuthorityId) as
            | {
                generation_id: string | null;
                sequence: number;
                digest: string | null;
                committed_at: string | null;
              }
            | undefined;
          if (candidateHead) {
            const existing = this.db
              .prepare(
                "SELECT digest FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
              )
              .get(candidateAuthorityId, prepared.generation.id) as { digest: string } | undefined;
            if (
              candidateHead.generation_id === null &&
              existing?.digest === candidateGeneration.digest
            )
              return;
            if (candidateHead.generation_id !== null || existing) {
              throw new CapletsError(
                "CONFIG_EXISTS",
                "SQL authority migration candidate already exists",
              );
            }
            this.db
              .prepare("DELETE FROM authority_receipts WHERE authority_id = ?")
              .run(candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_sessions WHERE authority_id = ?")
              .run(candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_events WHERE authority_id = ?")
              .run(candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_generations WHERE authority_id = ?")
              .run(candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_schema_meta WHERE authority_id = ?")
              .run(candidateAuthorityId);
          }
          if (!candidateHead) {
            this.db
              .prepare(
                "INSERT INTO authority_heads (authority_id, namespace, schema_version) VALUES (?, ?, ?)",
              )
              .run(candidateAuthorityId, this.namespace, candidateGeneration.schemaVersion);
          } else {
            this.db
              .prepare(
                "UPDATE authority_heads SET namespace = ?, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ?, digest = NULL, committed_at = NULL WHERE authority_id = ?",
              )
              .run(this.namespace, candidateGeneration.schemaVersion, candidateAuthorityId);
          }
          this.db
            .prepare(
              "INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version, auxiliary_watermark) VALUES (?, ?, ?, 0)",
            )
            .run(candidateAuthorityId, this.namespace, candidateGeneration.schemaVersion);
          this.db
            .prepare(
              "INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              candidateAuthorityId,
              candidateGeneration.id,
              candidateGeneration.sequence,
              candidateGeneration.predecessorId,
              candidateGeneration.schemaVersion,
              candidateGeneration.digest,
              candidateGeneration.committedAt,
              snapshotJson,
            );
          for (const receipt of prepared.receipts) {
            this.db
              .prepare(
                "INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                candidateAuthorityId,
                receipt.currentHostId,
                receipt.principalId,
                receipt.idempotencyKey,
                receipt.requestDigest,
                candidateGeneration.id,
                safeJson(receipt.result, "Authority receipt result"),
                receipt.expiresAt,
              );
          }
          for (const [sessionId, session] of Object.entries(prepared.auxiliary.sessions)) {
            this.db
              .prepare(
                "INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                candidateAuthorityId,
                sessionId,
                Number(session.revision),
                session.lastUsedAt,
                session.revoked ? 1 : 0,
              );
          }
          for (const row of auxiliaryEventRows) {
            this.db
              .prepare(
                "INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                candidateAuthorityId,
                row.watermark,
                row.event.kind,
                row.event.occurredAt,
                safeJson(row.event, "Security event"),
              );
          }
          this.db
            .prepare(
              "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
            )
            .run(prepared.auxiliary.watermark, candidateAuthorityId);
        })
        .immediate();
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
    return { token };
  }

  async readMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      return this.db
        .transaction(() => {
          const candidateHead = this.db
            .prepare("SELECT namespace, generation_id FROM authority_heads WHERE authority_id = ?")
            .get(token.candidateAuthorityId) as
            | { namespace: string; generation_id: string | null }
            | undefined;
          if (!candidateHead || candidateHead.namespace !== this.namespace)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          if (candidateHead.generation_id)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const candidateRow = this.db
            .prepare(
              "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
            )
            .get(token.candidateAuthorityId, token.generationId) as SqliteGenerationRow | undefined;
          if (!candidateRow)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const parsed = asGeneration(candidateRow);
          const targetDigest = digestGeneration({
            authorityId: this.authorityId,
            id: parsed.id,
            sequence: parsed.sequence,
            predecessorId: parsed.predecessorId,
            schemaVersion: parsed.schemaVersion,
            committedAt: parsed.committedAt,
            snapshot: parsed.snapshot,
          });
          const generation: SqliteGenerationRow = {
            ...candidateRow,
            authority_id: this.authorityId,
            digest: targetDigest,
          };
          const receiptRows = (
            this.db
              .prepare(
                "SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ? ORDER BY current_host_id, principal_id, idempotency_key",
              )
              .all(token.candidateAuthorityId) as SqliteReceiptRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const receiptGenerationRows = new Map<string, SqliteGenerationRow>([
            [token.generationId, generation],
          ]);
          const sessionRows = (
            this.db
              .prepare(
                "SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ? ORDER BY session_id",
              )
              .all(token.candidateAuthorityId) as SqliteSessionRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const eventRows = (
            this.db
              .prepare(
                "SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ? ORDER BY watermark",
              )
              .all(token.candidateAuthorityId) as SqliteEventRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const meta = this.db
            .prepare("SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?")
            .get(token.candidateAuthorityId) as { auxiliary_watermark: number } | undefined;
          const syntheticHead: SqliteHeadRow = {
            authority_id: this.authorityId,
            namespace: this.namespace,
            generation_id: generation.generation_id,
            sequence: generation.sequence,
            predecessor_id: generation.predecessor_id,
            schema_version: generation.schema_version,
            digest: generation.digest,
            committed_at: generation.committed_at,
          };
          return buildSqlExport({
            provider: "sqlite",
            authorityId: this.authorityId,
            namespace: this.namespace,
            schemaVersion: this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
            head: syntheticHead,
            generation,
            receiptRows,
            receiptGenerationRows,
            sessionRows,
            eventRows,
            auxiliaryWatermark: meta?.auxiliary_watermark,
            nowMs: this.now().getTime(),
          });
        })
        .immediate();
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async publishMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      return this.db
        .transaction(() => {
          this.assertMaintenanceWriteAllowedSqlite();
          const head = this.db
            .prepare(
              "SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ?",
            )
            .get(this.authorityId) as SqliteHeadRow | undefined;
          const meta = this.db
            .prepare(
              "SELECT namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?",
            )
            .get(this.authorityId) as
            | { namespace: string; logical_schema_version: number; auxiliary_watermark: number }
            | undefined;
          if (
            !head ||
            !meta ||
            head.namespace !== this.namespace ||
            meta.namespace !== this.namespace ||
            meta.logical_schema_version !==
              (this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION)
          )
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority target schema identity is invalid",
            );
          if (head.generation_id) {
            if (head.generation_id !== token.generationId)
              throw new CapletsError(
                "CONFIG_EXISTS",
                "SQL authority migration target is no longer empty",
              );
            const generation = this.db
              .prepare(
                "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
              )
              .get(this.authorityId, token.generationId) as SqliteGenerationRow | undefined;
            if (!generation)
              throw new CapletsError(
                "CONFIG_INVALID",
                "SQL authority migration candidate is unavailable",
              );
            this.db
              .prepare("DELETE FROM authority_receipts WHERE authority_id = ?")
              .run(token.candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_sessions WHERE authority_id = ?")
              .run(token.candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_events WHERE authority_id = ?")
              .run(token.candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_generations WHERE authority_id = ?")
              .run(token.candidateAuthorityId);
            this.db
              .prepare("DELETE FROM authority_schema_meta WHERE authority_id = ?")
              .run(token.candidateAuthorityId);
            this.db
              .prepare(
                "UPDATE authority_heads SET generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ?, digest = NULL, committed_at = NULL WHERE authority_id = ?",
              )
              .run(
                this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
                token.candidateAuthorityId,
              );
            return {
              generation: generationIdentity(generation),
              auxiliaryWatermark: String(meta.auxiliary_watermark),
            };
          }
          const occupied =
            head.sequence !== 0 ||
            head.digest !== null ||
            head.committed_at !== null ||
            meta.auxiliary_watermark !== 0 ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_generations WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_receipts WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_sessions WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            ) ||
            Boolean(
              this.db
                .prepare("SELECT 1 FROM authority_events WHERE authority_id = ? LIMIT 1")
                .get(this.authorityId),
            );
          if (occupied)
            throw new CapletsError(
              "CONFIG_EXISTS",
              "SQL authority migration target is no longer empty",
            );
          const candidateHead = this.db
            .prepare("SELECT namespace, generation_id FROM authority_heads WHERE authority_id = ?")
            .get(token.candidateAuthorityId) as
            | { namespace: string; generation_id: string | null }
            | undefined;
          const candidateMeta = this.db
            .prepare(
              "SELECT namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ?",
            )
            .get(token.candidateAuthorityId) as
            | { namespace: string; logical_schema_version: number; auxiliary_watermark: number }
            | undefined;
          if (
            !candidateHead ||
            candidateHead.namespace !== this.namespace ||
            candidateHead.generation_id !== null ||
            !candidateMeta ||
            candidateMeta.namespace !== this.namespace
          )
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const candidateRow = this.db
            .prepare(
              "SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ? AND generation_id = ?",
            )
            .get(token.candidateAuthorityId, token.generationId) as SqliteGenerationRow | undefined;
          if (!candidateRow)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const parsed = asGeneration(candidateRow);
          const targetGeneration: SqliteGenerationRow = {
            ...candidateRow,
            authority_id: this.authorityId,
            digest: digestGeneration({
              authorityId: this.authorityId,
              id: parsed.id,
              sequence: parsed.sequence,
              predecessorId: parsed.predecessorId,
              schemaVersion: parsed.schemaVersion,
              committedAt: parsed.committedAt,
              snapshot: parsed.snapshot,
            }),
          };
          this.db
            .prepare(
              "INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              this.authorityId,
              targetGeneration.generation_id,
              targetGeneration.sequence,
              targetGeneration.predecessor_id,
              targetGeneration.schema_version,
              targetGeneration.digest,
              targetGeneration.committed_at,
              targetGeneration.snapshot_json,
            );
          const receipts = this.db
            .prepare(
              "SELECT current_host_id, principal_id, idempotency_key, request_digest, result_json, expires_at FROM authority_receipts WHERE authority_id = ? AND generation_id = ?",
            )
            .all(token.candidateAuthorityId, token.generationId) as Array<{
            current_host_id: string;
            principal_id: string;
            idempotency_key: string;
            request_digest: string;
            result_json: string;
            expires_at: string;
          }>;
          for (const receipt of receipts) {
            this.db
              .prepare(
                "INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                receipt.current_host_id,
                receipt.principal_id,
                receipt.idempotency_key,
                receipt.request_digest,
                token.generationId,
                receipt.result_json,
                receipt.expires_at,
              );
          }
          const sessions = this.db
            .prepare(
              "SELECT session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ?",
            )
            .all(token.candidateAuthorityId) as Array<{
            session_id: string;
            revision: number;
            last_used_at: string;
            revoked: number;
          }>;
          for (const session of sessions) {
            this.db
              .prepare(
                "INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                session.session_id,
                session.revision,
                session.last_used_at,
                session.revoked,
              );
          }
          const events = this.db
            .prepare(
              "SELECT watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ?",
            )
            .all(token.candidateAuthorityId) as Array<{
            watermark: number;
            kind: string;
            occurred_at: string;
            event_json: string;
          }>;
          for (const event of events) {
            this.db
              .prepare(
                "INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                this.authorityId,
                event.watermark,
                event.kind,
                event.occurred_at,
                event.event_json,
              );
          }
          this.db
            .prepare(
              "UPDATE authority_schema_meta SET auxiliary_watermark = ? WHERE authority_id = ?",
            )
            .run(candidateMeta.auxiliary_watermark, this.authorityId);
          this.db
            .prepare(
              "UPDATE authority_heads SET namespace = ?, generation_id = ?, sequence = ?, predecessor_id = ?, schema_version = ?, digest = ?, committed_at = ? WHERE authority_id = ?",
            )
            .run(
              this.namespace,
              targetGeneration.generation_id,
              targetGeneration.sequence,
              targetGeneration.predecessor_id,
              targetGeneration.schema_version,
              targetGeneration.digest,
              targetGeneration.committed_at,
              this.authorityId,
            );
          this.db
            .prepare("DELETE FROM authority_receipts WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_sessions WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_events WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_generations WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_schema_meta WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare(
              "UPDATE authority_heads SET namespace = ?, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ?, digest = NULL, committed_at = NULL WHERE authority_id = ?",
            )
            .run(this.namespace, targetGeneration.schema_version, token.candidateAuthorityId);
          return {
            generation: generationIdentity(targetGeneration),
            auxiliaryWatermark: String(candidateMeta.auxiliary_watermark),
          };
        })
        .immediate();
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async invalidateMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      this.db
        .transaction(() => {
          this.assertMaintenanceWriteAllowedSqlite();
          const head = this.db
            .prepare("SELECT generation_id FROM authority_heads WHERE authority_id = ?")
            .get(this.authorityId) as { generation_id: string | null } | undefined;
          if (head?.generation_id) {
            if (head.generation_id === token.generationId) return;
            throw new CapletsError(
              "CONFIG_EXISTS",
              "SQL authority migration candidate was replaced",
            );
          }
          const candidate = this.db
            .prepare("SELECT 1 FROM authority_heads WHERE authority_id = ?")
            .get(token.candidateAuthorityId);
          if (!candidate) return;
          this.db
            .prepare("DELETE FROM authority_receipts WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_sessions WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_events WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_generations WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare("DELETE FROM authority_schema_meta WHERE authority_id = ?")
            .run(token.candidateAuthorityId);
          this.db
            .prepare(
              "UPDATE authority_heads SET namespace = ?, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ?, digest = NULL, committed_at = NULL WHERE authority_id = ?",
            )
            .run(
              this.namespace,
              this.options.schemaVersion ?? SQLITE_LOGICAL_SCHEMA_VERSION,
              token.candidateAuthorityId,
            );
        })
        .immediate();
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  sqlitePragmas(): {
    foreignKeys: number;
    journalMode: string;
    synchronous: number;
    busyTimeout: number;
  } {
    this.ensureOpen();
    return {
      foreignKeys: Number(this.db.pragma("foreign_keys", { simple: true })),
      journalMode: String(this.db.pragma("journal_mode", { simple: true })),
      synchronous: Number(this.db.pragma("synchronous", { simple: true })),
      busyTimeout: Number(this.db.pragma("busy_timeout", { simple: true })),
    };
  }

  sqliteRuntimeVersion(): string {
    this.ensureOpen();
    const row = this.db.prepare("SELECT sqlite_version() AS version").get() as
      | { version: string }
      | undefined;
    const version = row?.version ?? "";
    if (!versionAtLeast(version, "3.46.0"))
      throw new CapletsError(
        "UNSUPPORTED_OPERATION",
        "SQLite runtime is below the supported WAL-reset version",
      );
    return version;
  }

  async backup(destinationPath: string): Promise<SqliteBackupMetadata> {
    this.ensureOpen();
    if (
      destinationPath.length === 0 ||
      destinationPath.includes("\0") ||
      destinationPath.startsWith("//") ||
      destinationPath.startsWith("\\\\") ||
      /^(?:file|https?|nfs|smb|cifs):\/\//i.test(destinationPath)
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQLite backup path must be local");
    }
    try {
      const resolvedPath = resolve(destinationPath);
      mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
      const metadata = await this.db.backup(resolvedPath);
      chmodSync(resolvedPath, 0o600);
      return metadata;
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  checkpoint(): void {
    this.ensureOpen();
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      throw authorityError(error, "sqlite");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const state of this.maintenanceLeases.values()) {
      await this.releaseMaintenanceFence(state.lease, state.context);
    }
    this.closed = true;
    this.db.close();
  }

  private validateMaintenanceContext(context: MaintenanceFenceContext): void {
    if (
      context.authorityId !== this.authorityId ||
      context.namespace !== this.namespace ||
      context.owner.length === 0
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQLite maintenance fence identity does not match");
    }
  }

  private maintenanceKey(context: MaintenanceFenceContext): string {
    return `${context.operation}:${context.role}:${context.owner}`;
  }

  private maintenanceHeld(): CapletsError {
    return new CapletsError(
      "SERVER_UNAVAILABLE",
      "SQLite authority is held by a maintenance owner",
    );
  }

  private readSqliteMaintenanceLease(): SqlMaintenanceLeaseRow | undefined {
    return this.db
      .prepare(
        "SELECT authority_id, namespace, owner, token, deadline_at, version FROM authority_maintenance_leases WHERE authority_id = ?",
      )
      .get(this.authorityId) as SqlMaintenanceLeaseRow | undefined;
  }

  private markExpiredSqliteLease(row: SqlMaintenanceLeaseRow): void {
    this.db
      .prepare(
        "DELETE FROM authority_maintenance_leases WHERE authority_id = ? AND token = ? AND owner = ?",
      )
      .run(this.authorityId, row.token, row.owner);
    for (const state of this.maintenanceLeases.values()) {
      if (state.token === row.token) {
        state.released = true;
        clearInterval(state.timer);
      }
    }
  }

  private assertMaintenanceWriteAllowedSqlite(): void {
    const row = this.readSqliteMaintenanceLease();
    if (!row) return;
    if (Date.parse(row.deadline_at) <= this.now().getTime()) {
      this.markExpiredSqliteLease(row);
      return;
    }
    const local = [...this.maintenanceLeases.values()].find(
      (state) => !state.released && state.token === row.token && state.context.owner === row.owner,
    );
    if (!local) throw this.maintenanceHeld();
  }

  private async acquireMaintenanceFence(
    context: MaintenanceFenceContext,
  ): Promise<MaintenanceFenceLease> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    const key = this.maintenanceKey(context);
    const existingLocal = this.maintenanceLeases.get(key);
    if (existingLocal && !existingLocal.released) return existingLocal.lease;
    let token: string;
    try {
      const acquire = this.db.transaction(() => {
        const row = this.readSqliteMaintenanceLease();
        const now = this.now().getTime();
        if (row && Date.parse(row.deadline_at) > now) throw this.maintenanceHeld();
        if (row) this.markExpiredSqliteLease(row);
        token = randomUUID();
        this.db
          .prepare(
            "INSERT INTO authority_maintenance_leases (authority_id, namespace, owner, token, deadline_at, version) VALUES (?, ?, ?, ?, ?, 1)",
          )
          .run(
            this.authorityId,
            this.namespace,
            context.owner,
            token,
            new Date(now + this.maintenanceLeaseMs).toISOString(),
          );
      });
      acquire.immediate();
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "sqlite");
    }
    const leaseToken = token!;
    const lease: MaintenanceFenceLease = {
      token: leaseToken,
      renew: async () => await this.renewMaintenanceFence({ token: leaseToken }, context),
      release: async () => await this.releaseMaintenanceFence({ token: leaseToken }, context),
    };
    const timer = setInterval(() => {
      void this.renewMaintenanceFence({ token: leaseToken }, context).catch(() => undefined);
    }, this.maintenanceRenewIntervalMs);
    timer.unref?.();
    this.maintenanceLeases.set(key, {
      context,
      token: leaseToken,
      lease,
      timer,
      renewing: false,
      released: false,
    });
    return lease;
  }

  private async assertMaintenanceFence(context: MaintenanceFenceContext): Promise<void> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    try {
      const verify = this.db.transaction(() => {
        const row = this.readSqliteMaintenanceLease();
        if (!row || Date.parse(row.deadline_at) <= this.now().getTime()) {
          if (row) this.markExpiredSqliteLease(row);
          throw this.maintenanceHeld();
        }
        const local = [...this.maintenanceLeases.values()].find(
          (state) =>
            !state.released && state.token === row.token && state.context.owner === context.owner,
        );
        if (!local) throw this.maintenanceHeld();
      });
      verify.immediate();
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "sqlite");
    }
  }

  private async renewMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token)
      throw new CapletsError("CONFIG_INVALID", "SQLite maintenance lease token is missing");
    const state = [...this.maintenanceLeases.values()].find(
      (candidate) => candidate.token === token && candidate.context.owner === context.owner,
    );
    if (!state || state.released) throw this.maintenanceHeld();
    if (state.renewing) return;
    state.renewing = true;
    try {
      try {
        const renew = this.db.transaction(() => {
          const row = this.readSqliteMaintenanceLease();
          const now = this.now().getTime();
          if (
            !row ||
            row.token !== token ||
            row.owner !== context.owner ||
            Date.parse(row.deadline_at) <= now
          ) {
            if (row?.token === token) this.markExpiredSqliteLease(row);
            throw this.maintenanceHeld();
          }
          this.db
            .prepare(
              "UPDATE authority_maintenance_leases SET deadline_at = ? WHERE authority_id = ? AND owner = ? AND token = ?",
            )
            .run(
              new Date(now + this.maintenanceLeaseMs).toISOString(),
              this.authorityId,
              context.owner,
              token,
            );
        });
        renew.immediate();
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        throw authorityError(error, "sqlite");
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
    const key = this.maintenanceKey(context);
    const state = this.maintenanceLeases.get(key);
    if (!state || state.token !== token || state.context.owner !== context.owner) return;
    if (state && state.token === token) {
      state.released = true;
      clearInterval(state.timer);
      this.maintenanceLeases.delete(key);
    }
    if (this.closed) return;
    try {
      const release = this.db.transaction(() => {
        this.db
          .prepare(
            "DELETE FROM authority_maintenance_leases WHERE authority_id = ? AND owner = ? AND token = ?",
          )
          .run(this.authorityId, context.owner, token);
      });
      release.immediate();
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "sqlite");
    }
  }

  private async readCurrentSnapshot(): Promise<unknown> {
    const generation = await this.readCurrentGeneration();
    return generation?.snapshot ?? this.options.initialSnapshot ?? null;
  }

  private async readCurrentGeneration(): Promise<AuthorityGeneration<TSnapshot> | null> {
    const head = await this.readHead();
    return head ? this.readGeneration(head.id) : null;
  }

  private ensureOpen(): void {
    if (this.closed) throw new CapletsError("SERVER_UNAVAILABLE", "SQLite authority is closed");
  }
}

export class PostgresAuthority<
  TSnapshot = unknown,
  TCommand = unknown,
> implements WritableAuthority<TSnapshot, TCommand> {
  readonly schemaVersion: number;
  readonly authorityId: string;
  readonly namespace: string;
  private readonly client: Sql;
  private readonly maintenanceClient: Sql | undefined;
  private readonly options: PostgresAuthorityOptions<TSnapshot, TCommand>;
  private readonly now: () => Date;
  private closed = false;
  private readonly maintenanceLeaseMs: number;
  private readonly maintenanceRenewIntervalMs: number;
  private readonly maintenanceLeases = new Map<string, SqlMaintenanceState>();

  private constructor(client: Sql, options: PostgresAuthorityOptions<TSnapshot, TCommand>) {
    this.client = client;
    this.options = options;
    this.maintenanceClient = options.maintenanceClient;
    this.authorityId = options.authorityId;
    this.schemaVersion = options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION;
    this.namespace = options.namespace;
    this.now = options.clock ?? (() => new Date());
    const maintenanceLeaseMs = boundedMilliseconds(
      options.maintenanceLeaseMs,
      15_000,
      "PostgreSQL maintenance lease",
    );
    const maintenanceRenewIntervalMs = boundedMilliseconds(
      options.maintenanceRenewIntervalMs,
      Math.max(1, Math.floor(maintenanceLeaseMs / 3)),
      "PostgreSQL maintenance renewal interval",
    );
    if (maintenanceRenewIntervalMs >= maintenanceLeaseMs) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL maintenance renewal interval must be shorter than the lease",
      );
    }
    this.maintenanceLeaseMs = maintenanceLeaseMs;
    this.maintenanceRenewIntervalMs = maintenanceRenewIntervalMs;
  }

  static async open<TSnapshot = unknown, TCommand = unknown>(
    options: PostgresAuthorityOptions<TSnapshot, TCommand>,
  ): Promise<PostgresAuthority<TSnapshot, TCommand>> {
    const configuredSchemaVersion = options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION;
    const migrationVersion = options.migrations?.at(-1)?.version ?? POSTGRES_LOGICAL_SCHEMA_VERSION;
    if (configuredSchemaVersion !== migrationVersion) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL authority schema version is incompatible with its migration history",
      );
    }
    const lockTimeoutMs = boundedMilliseconds(
      options.lockTimeoutMs,
      500,
      "PostgreSQL lock timeout",
    );
    boundedMilliseconds(options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout");
    const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 5;
    if (
      !Number.isFinite(connectTimeoutSeconds) ||
      connectTimeoutSeconds < 1 ||
      connectTimeoutSeconds > 60
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL connect timeout must be between 1 and 60 seconds",
      );
    }
    if (!options.client && !options.connectionString) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL authority requires a connection string or client",
      );
    }
    if (
      options.maxConnections !== undefined &&
      (!Number.isSafeInteger(options.maxConnections) ||
        options.maxConnections < 1 ||
        options.maxConnections > 100)
    ) {
      throw new CapletsError("CONFIG_INVALID", "PostgreSQL pool size must be between 1 and 100");
    }
    if (
      options.idleTimeoutSeconds !== undefined &&
      (!Number.isFinite(options.idleTimeoutSeconds) ||
        options.idleTimeoutSeconds < 0 ||
        options.idleTimeoutSeconds > 86_400)
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL idle timeout must be between 0 and 86400 seconds",
      );
    }
    const client =
      options.client ??
      loadPostgres()(options.connectionString!, {
        ssl: options.ssl ?? false,
        max: options.maxConnections ?? 10,
        idle_timeout: options.idleTimeoutSeconds,
        connect_timeout: Math.ceil(connectTimeoutSeconds),
        prepare: options.prepare ?? false,
      });
    const authority = new PostgresAuthority(client, options);
    try {
      if (options.verifySchema !== false) {
        await verifyPostgresSchema(client, {
          authorityId: options.authorityId,
          namespace: options.namespace,
          ...(options.statementTimeoutMs === undefined
            ? {}
            : { statementTimeoutMs: options.statementTimeoutMs }),
          ...(options.migrations ? { migrations: options.migrations } : {}),
        });
      }
      await withPostgresStatementTimeout(client, options.statementTimeoutMs, async (tx) => {
        const headRows =
          await tx`SELECT namespace FROM authority_heads WHERE authority_id = ${options.authorityId}`;
        const head = headRows[0] as { namespace: string } | undefined;
        if (head && head.namespace !== options.namespace) {
          throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority namespace does not match");
        }
        const metaRows =
          await tx`SELECT namespace FROM authority_schema_meta WHERE authority_id = ${options.authorityId}`;
        const meta = metaRows[0] as { namespace: string } | undefined;
        if (meta && meta.namespace !== options.namespace) {
          throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority namespace does not match");
        }
        await tx`INSERT INTO authority_heads (authority_id, namespace, schema_version) VALUES (${options.authorityId}, ${options.namespace}, ${configuredSchemaVersion}) ON CONFLICT (authority_id) DO NOTHING`;
        await tx`INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version, auxiliary_watermark) VALUES (${options.authorityId}, ${options.namespace}, ${configuredSchemaVersion}, 0) ON CONFLICT (authority_id) DO UPDATE SET logical_schema_version = EXCLUDED.logical_schema_version`;
      });
      return authority;
    } catch (error) {
      if (!options.client)
        await client.end({
          timeout: Math.ceil(lockTimeoutMs / 1_000),
        });
      throw authorityError(error, "postgresql");
    }
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
    this.ensureOpen();
    try {
      const rows = await withPostgresStatementTimeout(
        this.client,
        this.options.statementTimeoutMs,
        async (tx) =>
          tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId}`,
      );
      const row = rows[0] as PgHeadRow | undefined;
      if (!row || !row.generation_id || !row.digest || !row.committed_at || row.sequence < 1)
        return null;
      return {
        authorityId: row.authority_id,
        id: row.generation_id,
        sequence: row.sequence,
        predecessorId: row.predecessor_id,
        digest: row.digest,
      };
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async readGeneration(id: string): Promise<AuthorityGeneration<TSnapshot>> {
    this.ensureOpen();
    try {
      const rows = await withPostgresStatementTimeout(
        this.client,
        this.options.statementTimeoutMs,
        async (tx) =>
          tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${id}`,
      );
      const row = rows[0] as PgGenerationRow | undefined;
      if (!row)
        throw new CapletsError("CONFIG_NOT_FOUND", "SQL authority generation was not found");
      const generation = asGeneration<TSnapshot>(row);
      return { ...generation, provenance: { provider: "postgresql", namespace: this.namespace } };
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityCommitResult<TResult>> {
    this.ensureOpen();
    if (envelope.authorityId !== this.authorityId)
      throw new CapletsError("REQUEST_INVALID", "Authority identity does not match the connection");
    const committedAt = this.now().toISOString();
    const id = randomUUID();
    try {
      const result = await this.client.begin<AuthorityCommitResult<TResult>>(
        async (tx: TransactionSql) => {
          await tx.unsafe(
            `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
            [],
            { prepare: false },
          );
          await tx.unsafe(
            `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
            [],
            { prepare: false },
          );
          const headRows =
            await tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
          const headRow = headRows[0] as PgHeadRow | undefined;
          if (!headRow)
            throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority head row is missing");
          await this.assertMaintenanceWriteAllowedPostgres(tx);
          const head =
            headRow.generation_id && headRow.digest && headRow.committed_at && headRow.sequence > 0
              ? {
                  authorityId: headRow.authority_id,
                  id: headRow.generation_id,
                  sequence: headRow.sequence,
                  predecessorId: headRow.predecessor_id,
                  digest: headRow.digest,
                }
              : null;
          const receiptRows =
            await tx`SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ${this.authorityId} AND current_host_id = ${envelope.currentHostId} AND principal_id = ${envelope.principalId} AND idempotency_key = ${envelope.idempotencyKey} AND expires_at > ${committedAt}`;
          const receipt = receiptRows[0] as PgReceiptRow | undefined;
          if (receipt) {
            if (receipt.request_digest !== envelope.requestDigest)
              throw new CapletsError(
                "REQUEST_INVALID",
                "Idempotency key was reused with a different request",
              );
            const generationRows =
              await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${receipt.generation_id}`;
            const generationRow = generationRows[0] as PgGenerationRow | undefined;
            if (!generationRow)
              throw new CapletsError(
                "CONFIG_INVALID",
                "Authority receipt references a missing generation",
              );
            const generation = generationIdentity(generationRow);
            const authorityReceipt: AuthorityReceipt<TResult> = {
              currentHostId: receipt.current_host_id,
              principalId: receipt.principal_id,
              idempotencyKey: receipt.idempotency_key,
              requestDigest: receipt.request_digest,
              generation,
              result: decodeJson<TResult>(receipt.result_json),
              expiresAt: receipt.expires_at,
            };
            return { kind: "replayed", generation, receipt: authorityReceipt };
          }
          if (!matchesExpected(envelope.expectedGeneration, head))
            return { kind: "conflict", active: head };
          let current: unknown = this.options.initialSnapshot ?? null;
          if (head) {
            const currentRows =
              await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${head.id}`;
            const currentRow = currentRows[0] as PgGenerationRow | undefined;
            if (!currentRow)
              throw new CapletsError(
                "CONFIG_INVALID",
                "PostgreSQL authority head references a missing generation",
              );
            current = decodeJson(currentRow.snapshot_json);
          }
          const candidate = await resolveCommand(this.options, current, envelope);
          const snapshotJson = safeJson(candidate.snapshot, "Authority snapshot");
          if (Buffer.byteLength(snapshotJson, "utf8") > MAX_AUTHORITY_GENERATION_BYTES)
            throw new CapletsError(
              "CONFIG_INVALID",
              "Authority generation exceeds the 64 MiB limit",
            );
          const sequence = (head?.sequence ?? 0) + 1;
          const predecessorId = head?.id ?? null;
          const digest = digestGeneration({
            authorityId: this.authorityId,
            id,
            sequence,
            predecessorId,
            schemaVersion: this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION,
            committedAt,
            snapshot: candidate.snapshot,
          });
          const receiptExpiry = new Date(
            this.now().getTime() + (this.options.receiptTtlMs ?? 24 * 60 * 60 * 1000),
          ).toISOString();
          const resultJson = safeJson(candidate.result, "Authority receipt result");
          await tx`INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (${this.authorityId}, ${id}, ${sequence}, ${predecessorId}, ${this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION}, ${digest}, ${committedAt}, ${snapshotJson})`;
          await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = ${id}, sequence = ${sequence}, predecessor_id = ${predecessorId}, schema_version = ${this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION}, digest = ${digest}, committed_at = ${committedAt} WHERE authority_id = ${this.authorityId}`;
          await tx`INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (${this.authorityId}, ${envelope.currentHostId}, ${envelope.principalId}, ${envelope.idempotencyKey}, ${envelope.requestDigest}, ${id}, ${resultJson}, ${receiptExpiry})`;
          const generation = { authorityId: this.authorityId, id, sequence, predecessorId };
          const authorityReceipt: AuthorityReceipt<TResult> = {
            currentHostId: envelope.currentHostId,
            principalId: envelope.principalId,
            idempotencyKey: envelope.idempotencyKey,
            requestDigest: envelope.requestDigest,
            generation,
            result: decodeJson<TResult>(resultJson),
            expiresAt: receiptExpiry,
          };
          return { kind: "committed", generation, receipt: authorityReceipt };
        },
      );
      return result;
    } catch (error) {
      const mapped = authorityError(error, "postgresql");
      if (mapped.code === "SERVER_UNAVAILABLE") {
        try {
          const replay = await this.readReceipt(envelope);
          if (replay) return replay as AuthorityCommitResult<TResult>;
        } catch {
          // Preserve the original bounded provider error.
        }
      }
      throw mapped;
    }
  }
  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    this.ensureOpen();
    try {
      return await withPostgresStatementTimeout(
        this.client,
        this.options.statementTimeoutMs,
        async (tx) => {
          if (request.kind === "session_touch") {
            const rows =
              await tx`SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ${this.authorityId} AND session_id = ${request.sessionId}`;
            const row = rows[0] as PgSessionRow | undefined;
            return row
              ? {
                  sessionId: row.session_id,
                  revision: String(row.revision),
                  lastUsedAt: row.last_used_at,
                  revoked: row.revoked === 1,
                }
              : null;
          }
          const after = request.afterWatermark ? Number.parseInt(request.afterWatermark, 10) : 0;
          const rows =
            await tx`SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ${this.authorityId} AND watermark > ${after} ORDER BY watermark LIMIT ${request.limit}`;
          const metaRows =
            await tx`SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId}`;
          const meta = metaRows[0] as { auxiliary_watermark: number } | undefined;
          const eventRows = rows as unknown as PgEventRow[];
          return {
            watermark: String(meta?.auxiliary_watermark ?? after),
            events: eventRows.map((row) => decodeJson(row.event_json)),
          };
        },
      );
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }
  async commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    this.ensureOpen();
    try {
      return await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT authority_id, generation_id, sequence, predecessor_id, digest FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const headRow = headRows[0] as
          | {
              authority_id: string;
              generation_id: string | null;
              sequence: number;
              predecessor_id: string | null;
              digest: string | null;
            }
          | undefined;
        if (!headRow)
          throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority head row is missing");
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        const currentHead =
          headRow.generation_id && headRow.digest && headRow.sequence > 0
            ? {
                authorityId: headRow.authority_id,
                id: headRow.generation_id,
                sequence: headRow.sequence,
                predecessorId: headRow.predecessor_id,
                digest: headRow.digest,
              }
            : null;
        const metaRows =
          await tx`SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId}`;
        const meta = metaRows[0] as { auxiliary_watermark: number };
        if (command.kind === "remove_session_touch") {
          const deleted =
            await tx`DELETE FROM authority_sessions WHERE authority_id = ${this.authorityId} AND session_id = ${command.sessionId} RETURNING session_id`;
          if (deleted.length === 0) {
            return { kind: "unchanged", watermark: String(meta.auxiliary_watermark) };
          }
          const watermark = meta.auxiliary_watermark + 1;
          await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${watermark} WHERE authority_id = ${this.authorityId}`;
          return { kind: "applied", watermark: String(watermark) };
        }
        if (command.kind === "session_touch") {
          if (!matchesExpected(command.expectedGeneration, currentHead))
            return { kind: "conflict" };
          const sessionRows =
            await tx`SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ${this.authorityId} AND session_id = ${command.sessionId} FOR UPDATE`;
          const session = sessionRows[0] as PgSessionRow | undefined;
          if (!session) {
            if (command.expectedRevision !== "" || !currentHead) return { kind: "missing" };
            const generationRows =
              await tx`SELECT snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${currentHead.id}`;
            const generationRow = generationRows[0] as { snapshot_json: string } | undefined;
            if (
              !generationRow ||
              !semanticSessionExists(decodeJson(generationRow.snapshot_json), command.sessionId)
            )
              return { kind: "missing" };
            const watermark = meta.auxiliary_watermark + 1;
            await tx`INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (${this.authorityId}, ${command.sessionId}, ${watermark}, ${command.lastUsedAt}, 0)`;
            await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${watermark} WHERE authority_id = ${this.authorityId}`;
            return { kind: "applied", watermark: String(watermark) };
          }
          if (session.revoked) return { kind: "revoked" };
          if (String(session.revision) !== command.expectedRevision) return { kind: "conflict" };
          if (command.lastUsedAt <= session.last_used_at)
            return { kind: "unchanged", watermark: String(meta.auxiliary_watermark) };
          const watermark = meta.auxiliary_watermark + 1;
          await tx`UPDATE authority_sessions SET revision = ${watermark}, last_used_at = ${command.lastUsedAt} WHERE authority_id = ${this.authorityId} AND session_id = ${command.sessionId} AND revision = ${session.revision} AND revoked = 0`;
          await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${watermark} WHERE authority_id = ${this.authorityId}`;
          return { kind: "applied", watermark: String(watermark) };
        }
        const watermark = meta.auxiliary_watermark + 1;
        const eventJson = safeJson(command.event, "Security event");
        await tx`INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (${this.authorityId}, ${watermark}, ${command.event.kind}, ${command.event.occurredAt}, ${eventJson})`;
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${watermark} WHERE authority_id = ${this.authorityId}`;
        return { kind: "applied", watermark: String(watermark) };
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async health(): Promise<AuthorityHealth> {
    if (this.closed)
      return {
        provider: "postgresql",
        authorityId: this.authorityId,
        connectivity: "unavailable",
        writable: false,
        activeGeneration: null,
        refresh: "failed",
        code: "CLOSED",
      };
    try {
      return {
        provider: "postgresql",
        authorityId: this.authorityId,
        connectivity: "healthy",
        writable: true,
        activeGeneration: await this.readHead(),
        refresh: "current",
      };
    } catch {
      return {
        provider: "postgresql",
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
    this.ensureOpen();
    const now = this.now();
    const nowIso = now.toISOString();
    try {
      return await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const head = headRows[0] as PgHeadRow | undefined;
        if (!head?.generation_id)
          throw new CapletsError("CONFIG_NOT_FOUND", "SQL authority has no committed generation");
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        const generationRows =
          await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${head.generation_id}`;
        const generation = generationRows[0] as PgGenerationRow | undefined;
        if (!generation)
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority head references a missing generation",
          );
        const receiptJoinRows = (await tx`SELECT
            r.authority_id,
            r.current_host_id,
            r.principal_id,
            r.idempotency_key,
            r.request_digest,
            r.generation_id,
            r.result_json,
            r.expires_at,
            g.authority_id AS generation_authority_id,
            g.generation_id AS generation_row_id,
            g.sequence AS generation_sequence,
            g.predecessor_id AS generation_predecessor_id,
            g.schema_version AS generation_schema_version,
            g.digest AS generation_digest,
            g.committed_at AS generation_committed_at,
            g.snapshot_json AS generation_snapshot_json
          FROM authority_receipts AS r
          LEFT JOIN authority_generations AS g
            ON g.authority_id = r.authority_id
            AND g.generation_id = r.generation_id
          WHERE r.authority_id = ${this.authorityId}
            AND r.expires_at > ${nowIso}
          ORDER BY r.current_host_id, r.principal_id, r.idempotency_key`) as unknown as PgReceiptJoinRow[];
        const receiptRows: PgReceiptRow[] = [];
        const receiptGenerationRows = new Map<string, PgGenerationRow>();
        for (const row of receiptJoinRows) {
          receiptRows.push({
            authority_id: row.authority_id,
            current_host_id: row.current_host_id,
            principal_id: row.principal_id,
            idempotency_key: row.idempotency_key,
            request_digest: row.request_digest,
            generation_id: row.generation_id,
            result_json: row.result_json,
            expires_at: row.expires_at,
          });
          if (
            row.generation_authority_id !== null &&
            row.generation_row_id !== null &&
            row.generation_sequence !== null &&
            row.generation_schema_version !== null &&
            row.generation_digest !== null &&
            row.generation_committed_at !== null &&
            row.generation_snapshot_json !== null
          ) {
            receiptGenerationRows.set(row.generation_id, {
              authority_id: row.generation_authority_id,
              generation_id: row.generation_row_id,
              sequence: row.generation_sequence,
              predecessor_id: row.generation_predecessor_id,
              schema_version: row.generation_schema_version,
              digest: row.generation_digest,
              committed_at: row.generation_committed_at,
              snapshot_json: row.generation_snapshot_json,
            });
          }
        }
        const sessionRows =
          (await tx`SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ${this.authorityId} ORDER BY session_id`) as unknown as PgSessionRow[];
        const eventRows =
          (await tx`SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ${this.authorityId} ORDER BY watermark`) as unknown as PgEventRow[];
        const metaRows =
          await tx`SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId}`;
        const meta = metaRows[0] as { auxiliary_watermark: number } | undefined;
        return buildSqlExport({
          provider: "postgresql",
          authorityId: this.authorityId,
          namespace: this.namespace,
          schemaVersion: this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION,
          head,
          generation,
          receiptRows,
          receiptGenerationRows,
          sessionRows,
          eventRows,
          auxiliaryWatermark: meta?.auxiliary_watermark,
          nowMs: now.getTime(),
        });
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult> {
    this.ensureOpen();
    const prepared = prepareSqlRestoreState(
      state,
      {
        authorityId: this.authorityId,
        namespace: this.namespace,
        provider: "postgresql",
        schemaVersion: this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION,
      },
      this.now().getTime(),
    );
    const snapshotJson = safeJson(prepared.generation.snapshot, "Authority snapshot");
    const auxiliaryEventRows = prepared.auxiliary.securityEvents.map((event, index) => ({
      watermark: Number(prepared.auxiliary.securityEventWatermarks[index]),
      event,
    }));
    try {
      await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const head = headRows[0] as PgHeadRow | undefined;
        const metaRows =
          await tx`SELECT authority_id, namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const meta = metaRows[0] as
          | {
              authority_id: string;
              namespace: string;
              logical_schema_version: number;
              auxiliary_watermark: number;
            }
          | undefined;
        if (
          !head ||
          !meta ||
          head.namespace !== this.namespace ||
          meta.namespace !== this.namespace ||
          meta.logical_schema_version !==
            (this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION)
        ) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority target schema identity is invalid",
          );
        }
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        const generationRows =
          await tx`SELECT 1 FROM authority_generations WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const receiptRows =
          await tx`SELECT 1 FROM authority_receipts WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const sessionRows =
          await tx`SELECT 1 FROM authority_sessions WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const eventRows =
          await tx`SELECT 1 FROM authority_events WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const occupied =
          head.generation_id !== null ||
          head.sequence !== 0 ||
          head.digest !== null ||
          head.committed_at !== null ||
          meta.auxiliary_watermark !== 0 ||
          generationRows.length > 0 ||
          receiptRows.length > 0 ||
          sessionRows.length > 0 ||
          eventRows.length > 0;
        if (occupied)
          throw new CapletsError("CONFIG_EXISTS", "SQL authority restore requires an empty target");
        await tx`INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (${this.authorityId}, ${prepared.generation.id}, ${prepared.generation.sequence}, ${prepared.generation.predecessorId}, ${prepared.generation.schemaVersion}, ${prepared.generation.digest}, ${prepared.generation.committedAt}, ${snapshotJson})`;
        await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = ${prepared.generation.id}, sequence = ${prepared.generation.sequence}, predecessor_id = ${prepared.generation.predecessorId}, schema_version = ${prepared.generation.schemaVersion}, digest = ${prepared.generation.digest}, committed_at = ${prepared.generation.committedAt} WHERE authority_id = ${this.authorityId}`;
        for (let start = 0; start < prepared.receipts.length; start += POSTGRES_BULK_INSERT_ROWS) {
          const rows = prepared.receipts
            .slice(start, start + POSTGRES_BULK_INSERT_ROWS)
            .map((receipt) => ({
              authority_id: this.authorityId,
              current_host_id: receipt.currentHostId,
              principal_id: receipt.principalId,
              idempotency_key: receipt.idempotencyKey,
              request_digest: receipt.requestDigest,
              generation_id: prepared.generation.id,
              result_json: safeJson(receipt.result, "Authority receipt result"),
              expires_at: receipt.expiresAt,
            }));
          await tx`INSERT INTO authority_receipts ${tx(
            rows,
            "authority_id",
            "current_host_id",
            "principal_id",
            "idempotency_key",
            "request_digest",
            "generation_id",
            "result_json",
            "expires_at",
          )}`;
        }
        const sessionEntries = Object.entries(prepared.auxiliary.sessions);
        for (let start = 0; start < sessionEntries.length; start += POSTGRES_BULK_INSERT_ROWS) {
          const rows = sessionEntries
            .slice(start, start + POSTGRES_BULK_INSERT_ROWS)
            .map(([sessionId, session]) => ({
              authority_id: this.authorityId,
              session_id: sessionId,
              revision: Number(session.revision),
              last_used_at: session.lastUsedAt,
              revoked: session.revoked ? 1 : 0,
            }));
          await tx`INSERT INTO authority_sessions ${tx(
            rows,
            "authority_id",
            "session_id",
            "revision",
            "last_used_at",
            "revoked",
          )}`;
        }
        for (let start = 0; start < auxiliaryEventRows.length; start += POSTGRES_BULK_INSERT_ROWS) {
          const rows = auxiliaryEventRows
            .slice(start, start + POSTGRES_BULK_INSERT_ROWS)
            .map((row) => ({
              authority_id: this.authorityId,
              watermark: row.watermark,
              kind: row.event.kind,
              occurred_at: row.event.occurredAt,
              event_json: safeJson(row.event, "Security event"),
            }));
          await tx`INSERT INTO authority_events ${tx(
            rows,
            "authority_id",
            "watermark",
            "kind",
            "occurred_at",
            "event_json",
          )}`;
        }
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${prepared.auxiliary.watermark} WHERE authority_id = ${this.authorityId}`;
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
    return {
      generation: {
        authorityId: prepared.generation.authorityId,
        id: prepared.generation.id,
        sequence: prepared.generation.sequence,
        predecessorId: prepared.generation.predecessorId,
      },
      auxiliaryWatermark: String(prepared.auxiliary.watermark),
    };
  }

  async stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage> {
    this.ensureOpen();
    if (context.owner.length === 0)
      throw new CapletsError("CONFIG_INVALID", "SQL authority migration owner is missing");
    const prepared = prepareSqlRestoreState(
      state,
      {
        authorityId: this.authorityId,
        namespace: this.namespace,
        provider: "postgresql",
        schemaVersion: this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION,
      },
      this.now().getTime(),
    );
    const candidateAuthorityId = sqlMigrationCandidateAuthorityId(
      this.authorityId,
      context.owner,
      prepared.generation.id,
    );
    const candidateGeneration = {
      ...prepared.generation,
      authorityId: candidateAuthorityId,
      digest: digestGeneration({
        authorityId: candidateAuthorityId,
        id: prepared.generation.id,
        sequence: prepared.generation.sequence,
        predecessorId: prepared.generation.predecessorId,
        schemaVersion: prepared.generation.schemaVersion,
        committedAt: prepared.generation.committedAt,
        snapshot: prepared.generation.snapshot,
      }),
    };
    const snapshotJson = safeJson(candidateGeneration.snapshot, "Authority snapshot");
    const auxiliaryEventRows = prepared.auxiliary.securityEvents.map((event, index) => ({
      watermark: Number(prepared.auxiliary.securityEventWatermarks[index]),
      event,
    }));
    const token: SqlMigrationStageToken = {
      authorityId: this.authorityId,
      candidateAuthorityId,
      generationId: prepared.generation.id,
      owner: context.owner,
    };
    try {
      await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const head = headRows[0] as PgHeadRow | undefined;
        const metaRows =
          await tx`SELECT namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const meta = metaRows[0] as
          | { namespace: string; logical_schema_version: number; auxiliary_watermark: number }
          | undefined;
        if (
          !head ||
          !meta ||
          head.namespace !== this.namespace ||
          meta.namespace !== this.namespace ||
          meta.logical_schema_version !==
            (this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION)
        ) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority target schema identity is invalid",
          );
        }
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        const generationRows =
          await tx`SELECT 1 FROM authority_generations WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const receiptRows =
          await tx`SELECT 1 FROM authority_receipts WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const sessionRows =
          await tx`SELECT 1 FROM authority_sessions WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const eventRows =
          await tx`SELECT 1 FROM authority_events WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const occupied =
          head.generation_id !== null ||
          head.sequence !== 0 ||
          head.digest !== null ||
          head.committed_at !== null ||
          meta.auxiliary_watermark !== 0 ||
          generationRows.length > 0 ||
          receiptRows.length > 0 ||
          sessionRows.length > 0 ||
          eventRows.length > 0;
        if (occupied)
          throw new CapletsError("CONFIG_EXISTS", "SQL authority migration target is not empty");
        const candidateRows =
          await tx`SELECT generation_id FROM authority_heads WHERE authority_id = ${candidateAuthorityId} FOR UPDATE`;
        if (candidateRows.length > 0) {
          const existingRows =
            await tx`SELECT digest FROM authority_generations WHERE authority_id = ${candidateAuthorityId} AND generation_id = ${prepared.generation.id}`;
          const existing = existingRows[0] as { digest: string } | undefined;
          if (existing?.digest === candidateGeneration.digest) return;
          if (existing) {
            throw new CapletsError(
              "CONFIG_EXISTS",
              "SQL authority migration candidate already exists",
            );
          }
          await tx`DELETE FROM authority_receipts WHERE authority_id = ${candidateAuthorityId}`;
          await tx`DELETE FROM authority_sessions WHERE authority_id = ${candidateAuthorityId}`;
          await tx`DELETE FROM authority_events WHERE authority_id = ${candidateAuthorityId}`;
          await tx`DELETE FROM authority_generations WHERE authority_id = ${candidateAuthorityId}`;
          await tx`DELETE FROM authority_schema_meta WHERE authority_id = ${candidateAuthorityId}`;
          await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ${candidateGeneration.schemaVersion}, digest = NULL, committed_at = NULL WHERE authority_id = ${candidateAuthorityId}`;
        } else {
          await tx`INSERT INTO authority_heads (authority_id, namespace, schema_version) VALUES (${candidateAuthorityId}, ${this.namespace}, ${candidateGeneration.schemaVersion})`;
        }
        await tx`INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version, auxiliary_watermark) VALUES (${candidateAuthorityId}, ${this.namespace}, ${candidateGeneration.schemaVersion}, 0)`;
        await tx`INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (${candidateAuthorityId}, ${candidateGeneration.id}, ${candidateGeneration.sequence}, ${candidateGeneration.predecessorId}, ${candidateGeneration.schemaVersion}, ${candidateGeneration.digest}, ${candidateGeneration.committedAt}, ${snapshotJson})`;
        for (const receipt of prepared.receipts) {
          const resultJson = safeJson(receipt.result, "Authority receipt result");
          await tx`INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (${candidateAuthorityId}, ${receipt.currentHostId}, ${receipt.principalId}, ${receipt.idempotencyKey}, ${receipt.requestDigest}, ${candidateGeneration.id}, ${resultJson}, ${receipt.expiresAt})`;
        }
        for (const [sessionId, session] of Object.entries(prepared.auxiliary.sessions)) {
          await tx`INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (${candidateAuthorityId}, ${sessionId}, ${Number(session.revision)}, ${session.lastUsedAt}, ${session.revoked ? 1 : 0})`;
        }
        for (const row of auxiliaryEventRows) {
          const eventJson = safeJson(row.event, "Security event");
          await tx`INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (${candidateAuthorityId}, ${row.watermark}, ${row.event.kind}, ${row.event.occurredAt}, ${eventJson})`;
        }
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${prepared.auxiliary.watermark} WHERE authority_id = ${candidateAuthorityId}`;
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
    return { token };
  }

  async readMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      return await withPostgresStatementTimeout(
        this.client,
        this.options.statementTimeoutMs,
        async (tx) => {
          const candidateHeadRows =
            await tx`SELECT namespace, generation_id FROM authority_heads WHERE authority_id = ${token.candidateAuthorityId}`;
          const candidateHead = candidateHeadRows[0] as
            | { namespace: string; generation_id: string | null }
            | undefined;
          if (
            !candidateHead ||
            candidateHead.namespace !== this.namespace ||
            candidateHead.generation_id
          )
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const generationRows =
            await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${token.candidateAuthorityId} AND generation_id = ${token.generationId}`;
          const candidateRow = generationRows[0] as PgGenerationRow | undefined;
          if (!candidateRow)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          const parsed = asGeneration(candidateRow);
          const generation: PgGenerationRow = {
            ...candidateRow,
            authority_id: this.authorityId,
            digest: digestGeneration({
              authorityId: this.authorityId,
              id: parsed.id,
              sequence: parsed.sequence,
              predecessorId: parsed.predecessorId,
              schemaVersion: parsed.schemaVersion,
              committedAt: parsed.committedAt,
              snapshot: parsed.snapshot,
            }),
          };
          const receiptRows = (
            (await tx`SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ${token.candidateAuthorityId} ORDER BY current_host_id, principal_id, idempotency_key`) as unknown as PgReceiptRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const receiptGenerationRows = new Map<string, PgGenerationRow>([
            [token.generationId, generation],
          ]);
          const sessionRows = (
            (await tx`SELECT authority_id, session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ${token.candidateAuthorityId} ORDER BY session_id`) as unknown as PgSessionRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const eventRows = (
            (await tx`SELECT authority_id, watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ${token.candidateAuthorityId} ORDER BY watermark`) as unknown as PgEventRow[]
          ).map((row) => ({ ...row, authority_id: this.authorityId }));
          const metaRows =
            await tx`SELECT auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${token.candidateAuthorityId}`;
          const meta = metaRows[0] as { auxiliary_watermark: number } | undefined;
          const syntheticHead: PgHeadRow = {
            authority_id: this.authorityId,
            namespace: this.namespace,
            generation_id: generation.generation_id,
            sequence: generation.sequence,
            predecessor_id: generation.predecessor_id,
            schema_version: generation.schema_version,
            digest: generation.digest,
            committed_at: generation.committed_at,
          };
          return buildSqlExport({
            provider: "postgresql",
            authorityId: this.authorityId,
            namespace: this.namespace,
            schemaVersion: this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION,
            head: syntheticHead,
            generation,
            receiptRows,
            receiptGenerationRows,
            sessionRows,
            eventRows,
            auxiliaryWatermark: meta?.auxiliary_watermark,
            nowMs: this.now().getTime(),
          });
        },
      );
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async publishMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      return await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT authority_id, namespace, generation_id, sequence, predecessor_id, schema_version, digest, committed_at FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const head = headRows[0] as PgHeadRow | undefined;
        const metaRows =
          await tx`SELECT namespace, logical_schema_version, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const meta = metaRows[0] as
          | { namespace: string; logical_schema_version: number; auxiliary_watermark: number }
          | undefined;
        if (
          !head ||
          !meta ||
          head.namespace !== this.namespace ||
          meta.namespace !== this.namespace ||
          meta.logical_schema_version !==
            (this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION)
        )
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority target schema identity is invalid",
          );
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        if (head.generation_id) {
          if (head.generation_id !== token.generationId)
            throw new CapletsError(
              "CONFIG_EXISTS",
              "SQL authority migration target is no longer empty",
            );
          const generationRows =
            await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${token.generationId}`;
          const generation = generationRows[0] as PgGenerationRow | undefined;
          if (!generation)
            throw new CapletsError(
              "CONFIG_INVALID",
              "SQL authority migration candidate is unavailable",
            );
          await tx`DELETE FROM authority_receipts WHERE authority_id = ${token.candidateAuthorityId}`;
          await tx`DELETE FROM authority_sessions WHERE authority_id = ${token.candidateAuthorityId}`;
          await tx`DELETE FROM authority_events WHERE authority_id = ${token.candidateAuthorityId}`;
          await tx`DELETE FROM authority_generations WHERE authority_id = ${token.candidateAuthorityId}`;
          await tx`DELETE FROM authority_schema_meta WHERE authority_id = ${token.candidateAuthorityId}`;
          await tx`UPDATE authority_heads SET generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ${this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION}, digest = NULL, committed_at = NULL WHERE authority_id = ${token.candidateAuthorityId}`;
          return {
            generation: generationIdentity(generation),
            auxiliaryWatermark: String(meta.auxiliary_watermark),
          };
        }
        const generationRows =
          await tx`SELECT 1 FROM authority_generations WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const receiptRows =
          await tx`SELECT 1 FROM authority_receipts WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const sessionRows =
          await tx`SELECT 1 FROM authority_sessions WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const eventRows =
          await tx`SELECT 1 FROM authority_events WHERE authority_id = ${this.authorityId} LIMIT 1`;
        const occupied =
          head.sequence !== 0 ||
          head.digest !== null ||
          head.committed_at !== null ||
          meta.auxiliary_watermark !== 0 ||
          generationRows.length > 0 ||
          receiptRows.length > 0 ||
          sessionRows.length > 0 ||
          eventRows.length > 0;
        if (occupied)
          throw new CapletsError(
            "CONFIG_EXISTS",
            "SQL authority migration target is no longer empty",
          );
        const candidateHeadRows =
          await tx`SELECT namespace, generation_id FROM authority_heads WHERE authority_id = ${token.candidateAuthorityId} FOR UPDATE`;
        const candidateHead = candidateHeadRows[0] as
          | { namespace: string; generation_id: string | null }
          | undefined;
        const candidateMetaRows =
          await tx`SELECT namespace, auxiliary_watermark FROM authority_schema_meta WHERE authority_id = ${token.candidateAuthorityId} FOR UPDATE`;
        const candidateMeta = candidateMetaRows[0] as
          | { namespace: string; auxiliary_watermark: number }
          | undefined;
        if (
          !candidateHead ||
          candidateHead.namespace !== this.namespace ||
          candidateHead.generation_id !== null ||
          !candidateMeta ||
          candidateMeta.namespace !== this.namespace
        )
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority migration candidate is unavailable",
          );
        const candidateGenerationRows =
          await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${token.candidateAuthorityId} AND generation_id = ${token.generationId}`;
        const candidateGeneration = candidateGenerationRows[0] as PgGenerationRow | undefined;
        if (!candidateGeneration)
          throw new CapletsError(
            "CONFIG_INVALID",
            "SQL authority migration candidate is unavailable",
          );
        const parsed = asGeneration(candidateGeneration);
        const targetGeneration: PgGenerationRow = {
          ...candidateGeneration,
          authority_id: this.authorityId,
          digest: digestGeneration({
            authorityId: this.authorityId,
            id: parsed.id,
            sequence: parsed.sequence,
            predecessorId: parsed.predecessorId,
            schemaVersion: parsed.schemaVersion,
            committedAt: parsed.committedAt,
            snapshot: parsed.snapshot,
          }),
        };
        await tx`INSERT INTO authority_generations (authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json) VALUES (${this.authorityId}, ${targetGeneration.generation_id}, ${targetGeneration.sequence}, ${targetGeneration.predecessor_id}, ${targetGeneration.schema_version}, ${targetGeneration.digest}, ${targetGeneration.committed_at}, ${targetGeneration.snapshot_json})`;
        const candidateReceipts =
          (await tx`SELECT current_host_id, principal_id, idempotency_key, request_digest, result_json, expires_at FROM authority_receipts WHERE authority_id = ${token.candidateAuthorityId} AND generation_id = ${token.generationId}`) as unknown as Array<{
            current_host_id: string;
            principal_id: string;
            idempotency_key: string;
            request_digest: string;
            result_json: string;
            expires_at: string;
          }>;
        for (const receipt of candidateReceipts) {
          await tx`INSERT INTO authority_receipts (authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at) VALUES (${this.authorityId}, ${receipt.current_host_id}, ${receipt.principal_id}, ${receipt.idempotency_key}, ${receipt.request_digest}, ${token.generationId}, ${receipt.result_json}, ${receipt.expires_at})`;
        }
        const candidateSessions =
          (await tx`SELECT session_id, revision, last_used_at, revoked FROM authority_sessions WHERE authority_id = ${token.candidateAuthorityId}`) as unknown as Array<{
            session_id: string;
            revision: number;
            last_used_at: string;
            revoked: number;
          }>;
        for (const session of candidateSessions) {
          await tx`INSERT INTO authority_sessions (authority_id, session_id, revision, last_used_at, revoked) VALUES (${this.authorityId}, ${session.session_id}, ${session.revision}, ${session.last_used_at}, ${session.revoked})`;
        }
        const candidateEvents =
          (await tx`SELECT watermark, kind, occurred_at, event_json FROM authority_events WHERE authority_id = ${token.candidateAuthorityId}`) as unknown as Array<{
            watermark: number;
            kind: string;
            occurred_at: string;
            event_json: string;
          }>;
        for (const event of candidateEvents) {
          await tx`INSERT INTO authority_events (authority_id, watermark, kind, occurred_at, event_json) VALUES (${this.authorityId}, ${event.watermark}, ${event.kind}, ${event.occurred_at}, ${event.event_json})`;
        }
        await tx`UPDATE authority_schema_meta SET auxiliary_watermark = ${candidateMeta.auxiliary_watermark} WHERE authority_id = ${this.authorityId}`;
        await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = ${targetGeneration.generation_id}, sequence = ${targetGeneration.sequence}, predecessor_id = ${targetGeneration.predecessor_id}, schema_version = ${targetGeneration.schema_version}, digest = ${targetGeneration.digest}, committed_at = ${targetGeneration.committed_at} WHERE authority_id = ${this.authorityId}`;
        await tx`DELETE FROM authority_receipts WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_sessions WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_events WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_generations WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_schema_meta WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ${candidateGeneration.schema_version}, digest = NULL, committed_at = NULL WHERE authority_id = ${token.candidateAuthorityId}`;
        return {
          generation: generationIdentity(targetGeneration),
          auxiliaryWatermark: String(candidateMeta.auxiliary_watermark),
        };
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }

  async invalidateMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void> {
    this.ensureOpen();
    const token = parseSqlMigrationStageToken(stage, this.authorityId, context.owner);
    try {
      await this.client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        const headRows =
          await tx`SELECT generation_id FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const head = headRows[0] as { generation_id: string | null } | undefined;
        if (head?.generation_id) {
          if (head.generation_id === token.generationId) return;
          throw new CapletsError("CONFIG_EXISTS", "SQL authority migration candidate was replaced");
        }
        await this.assertMaintenanceWriteAllowedPostgres(tx);
        const candidateRows =
          await tx`SELECT 1 FROM authority_heads WHERE authority_id = ${token.candidateAuthorityId} FOR UPDATE`;
        if (candidateRows.length === 0) return;
        await tx`DELETE FROM authority_receipts WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_sessions WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_events WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_generations WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`DELETE FROM authority_schema_meta WHERE authority_id = ${token.candidateAuthorityId}`;
        await tx`UPDATE authority_heads SET namespace = ${this.namespace}, generation_id = NULL, sequence = 0, predecessor_id = NULL, schema_version = ${this.options.schemaVersion ?? POSTGRES_LOGICAL_SCHEMA_VERSION}, digest = NULL, committed_at = NULL WHERE authority_id = ${token.candidateAuthorityId}`;
      });
    } catch (error) {
      throw authorityError(error, "postgresql");
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const releaseTimeoutMs = boundedMilliseconds(
      this.options.statementTimeoutMs,
      5_000,
      "PostgreSQL statement timeout",
    );
    const lockTimeoutMs = boundedMilliseconds(
      this.options.lockTimeoutMs,
      2_000,
      "PostgreSQL lock timeout",
    );
    let firstError: unknown;
    try {
      for (const state of this.maintenanceLeases.values()) {
        clearInterval(state.timer);
        try {
          await withPostgresTeardownTimeout(
            this.releaseMaintenanceFence(state.lease, state.context),
            releaseTimeoutMs,
            "PostgreSQL maintenance lease release",
          );
        } catch (error) {
          firstError ??= error;
        }
      }
    } finally {
      this.maintenanceLeases.clear();
      this.closed = true;
      const ownedClients: Sql[] = [];
      if (this.options.client === undefined) {
        ownedClients.push(this.client);
        if (this.maintenanceClient && this.maintenanceClient !== this.client)
          ownedClients.push(this.maintenanceClient);
      }
      for (const client of ownedClients) {
        try {
          await withPostgresTeardownTimeout(
            client.end({ timeout: Math.ceil(lockTimeoutMs / 1_000) }),
            releaseTimeoutMs,
            "PostgreSQL pool shutdown",
          );
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError) throw firstError;
  }

  private validateMaintenanceContext(context: MaintenanceFenceContext): void {
    if (
      context.authorityId !== this.authorityId ||
      context.namespace !== this.namespace ||
      context.owner.length === 0
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL maintenance fence identity does not match",
      );
    }
  }

  private maintenanceKey(context: MaintenanceFenceContext): string {
    return `${context.operation}:${context.role}:${context.owner}`;
  }

  private maintenanceHeld(): CapletsError {
    return new CapletsError(
      "SERVER_UNAVAILABLE",
      "PostgreSQL authority is held by a maintenance owner",
    );
  }

  private pgMaintenanceClient(): Sql {
    return this.maintenanceClient ?? this.client;
  }

  private markExpiredPostgresLease(row: SqlMaintenanceLeaseRow): void {
    for (const state of this.maintenanceLeases.values()) {
      if (state.token === row.token) {
        state.released = true;
        clearInterval(state.timer);
      }
    }
  }

  private async assertMaintenanceWriteAllowedPostgres(tx: TransactionSql): Promise<void> {
    const rows =
      await tx`SELECT authority_id, namespace, owner, token, deadline_at, version FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} FOR UPDATE`;
    const row = rows[0] as SqlMaintenanceLeaseRow | undefined;
    if (!row) return;
    if (Date.parse(row.deadline_at) <= this.now().getTime()) {
      await tx`DELETE FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} AND owner = ${row.owner} AND token = ${row.token}`;
      this.markExpiredPostgresLease(row);
      return;
    }
    const local = [...this.maintenanceLeases.values()].find(
      (state) => !state.released && state.token === row.token && state.context.owner === row.owner,
    );
    if (!local) throw this.maintenanceHeld();
  }

  private async acquireMaintenanceFence(
    context: MaintenanceFenceContext,
  ): Promise<MaintenanceFenceLease> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    const key = this.maintenanceKey(context);
    const existingLocal = this.maintenanceLeases.get(key);
    if (existingLocal && !existingLocal.released) return existingLocal.lease;
    let token = "";
    const client = this.pgMaintenanceClient();
    try {
      await client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx`SELECT authority_id FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const rows =
          await tx`SELECT authority_id, namespace, owner, token, deadline_at, version FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const row = rows[0] as SqlMaintenanceLeaseRow | undefined;
        const now = this.now().getTime();
        if (row && Date.parse(row.deadline_at) > now) throw this.maintenanceHeld();
        if (row) {
          await tx`DELETE FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} AND owner = ${row.owner} AND token = ${row.token}`;
          this.markExpiredPostgresLease(row);
        }
        token = randomUUID();
        await tx`INSERT INTO authority_maintenance_leases (authority_id, namespace, owner, token, deadline_at, version) VALUES (${this.authorityId}, ${this.namespace}, ${context.owner}, ${token}, ${new Date(now + this.maintenanceLeaseMs).toISOString()}, 1)`;
      });
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "postgresql");
    }
    const leaseToken = token;
    const lease: MaintenanceFenceLease = {
      token: leaseToken,
      renew: async () => await this.renewMaintenanceFence({ token: leaseToken }, context),
      release: async () => await this.releaseMaintenanceFence({ token: leaseToken }, context),
    };
    const timer = setInterval(() => {
      void this.renewMaintenanceFence({ token: leaseToken }, context).catch(() => undefined);
    }, this.maintenanceRenewIntervalMs);
    timer.unref?.();
    this.maintenanceLeases.set(key, {
      context,
      token: leaseToken,
      lease,
      timer,
      renewing: false,
      released: false,
    });
    return lease;
  }

  private async assertMaintenanceFence(context: MaintenanceFenceContext): Promise<void> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    const client = this.pgMaintenanceClient();
    try {
      await client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx`SELECT authority_id FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const rows =
          await tx`SELECT authority_id, namespace, owner, token, deadline_at, version FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        const row = rows[0] as SqlMaintenanceLeaseRow | undefined;
        if (!row || Date.parse(row.deadline_at) <= this.now().getTime()) {
          if (row) {
            await tx`DELETE FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} AND owner = ${row.owner} AND token = ${row.token}`;
            this.markExpiredPostgresLease(row);
          }
          throw this.maintenanceHeld();
        }
        const local = [...this.maintenanceLeases.values()].find(
          (state) =>
            !state.released && state.token === row.token && state.context.owner === context.owner,
        );
        if (!local) throw this.maintenanceHeld();
      });
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "postgresql");
    }
  }

  private async renewMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    this.ensureOpen();
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token)
      throw new CapletsError("CONFIG_INVALID", "PostgreSQL maintenance lease token is missing");
    const state = [...this.maintenanceLeases.values()].find(
      (candidate) => candidate.token === token && candidate.context.owner === context.owner,
    );
    if (!state || state.released) throw this.maintenanceHeld();
    if (state.renewing) return;
    state.renewing = true;
    try {
      const client = this.pgMaintenanceClient();
      try {
        await client.begin(async (tx: TransactionSql) => {
          await tx.unsafe(
            `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
            [],
            { prepare: false },
          );
          await tx`SELECT authority_id FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
          const rows =
            await tx`SELECT authority_id, namespace, owner, token, deadline_at, version FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} FOR UPDATE`;
          const row = rows[0] as SqlMaintenanceLeaseRow | undefined;
          const now = this.now().getTime();
          if (
            !row ||
            row.owner !== context.owner ||
            row.token !== token ||
            Date.parse(row.deadline_at) <= now
          ) {
            if (row?.token === token) {
              await tx`DELETE FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} AND owner = ${row.owner} AND token = ${row.token}`;
              this.markExpiredPostgresLease(row);
            }
            throw this.maintenanceHeld();
          }
          await tx`UPDATE authority_maintenance_leases SET deadline_at = ${new Date(now + this.maintenanceLeaseMs).toISOString()} WHERE authority_id = ${this.authorityId} AND owner = ${context.owner} AND token = ${token}`;
        });
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        throw authorityError(error, "postgresql");
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
    const key = this.maintenanceKey(context);
    const state = this.maintenanceLeases.get(key);
    if (!state || state.token !== token || state.context.owner !== context.owner) return;
    if (state && state.token === token) {
      state.released = true;
      clearInterval(state.timer);
      this.maintenanceLeases.delete(key);
    }
    if (this.closed) return;
    const client = this.pgMaintenanceClient();
    try {
      await client.begin(async (tx: TransactionSql) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = '${boundedMilliseconds(this.options.lockTimeoutMs, 500, "PostgreSQL lock timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx.unsafe(
          `SET LOCAL statement_timeout = '${boundedMilliseconds(this.options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout")}ms'`,
          [],
          { prepare: false },
        );
        await tx`SELECT authority_id FROM authority_heads WHERE authority_id = ${this.authorityId} FOR UPDATE`;
        await tx`DELETE FROM authority_maintenance_leases WHERE authority_id = ${this.authorityId} AND owner = ${context.owner} AND token = ${token}`;
      });
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw authorityError(error, "postgresql");
    }
  }

  private async readCurrentGeneration(): Promise<AuthorityGeneration<TSnapshot> | null> {
    const head = await this.readHead();
    return head ? this.readGeneration(head.id) : null;
  }

  private async readReceipt(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityCommitResult<unknown> | null> {
    return await withPostgresStatementTimeout(
      this.client,
      this.options.statementTimeoutMs,
      async (tx) => {
        const rows =
          await tx`SELECT authority_id, current_host_id, principal_id, idempotency_key, request_digest, generation_id, result_json, expires_at FROM authority_receipts WHERE authority_id = ${this.authorityId} AND current_host_id = ${envelope.currentHostId} AND principal_id = ${envelope.principalId} AND idempotency_key = ${envelope.idempotencyKey}`;
        const receipt = rows[0] as PgReceiptRow | undefined;
        if (!receipt) return null;
        if (receipt.request_digest !== envelope.requestDigest)
          throw new CapletsError(
            "REQUEST_INVALID",
            "Idempotency key was reused with a different request",
          );
        const generationRows =
          await tx`SELECT authority_id, generation_id, sequence, predecessor_id, schema_version, digest, committed_at, snapshot_json FROM authority_generations WHERE authority_id = ${this.authorityId} AND generation_id = ${receipt.generation_id}`;
        const row = generationRows[0] as PgGenerationRow | undefined;
        if (!row)
          throw new CapletsError(
            "CONFIG_INVALID",
            "Authority receipt references a missing generation",
          );
        const generation = generationIdentity(row);
        return {
          kind: "replayed",
          generation,
          receipt: {
            currentHostId: receipt.current_host_id,
            principalId: receipt.principal_id,
            idempotencyKey: receipt.idempotency_key,
            requestDigest: receipt.request_digest,
            generation,
            result: decodeJson(receipt.result_json),
            expiresAt: receipt.expires_at,
          },
        };
      },
    );
  }
  private ensureOpen(): void {
    if (this.closed) throw new CapletsError("SERVER_UNAVAILABLE", "PostgreSQL authority is closed");
  }
}

export async function createSqliteAuthority<TSnapshot = unknown, TCommand = unknown>(
  options: SqliteAuthorityOptions<TSnapshot, TCommand>,
): Promise<SqliteAuthority<TSnapshot, TCommand>> {
  return SqliteAuthority.open(options);
}

export async function createPostgresAuthority<TSnapshot = unknown, TCommand = unknown>(
  options: PostgresAuthorityOptions<TSnapshot, TCommand>,
): Promise<PostgresAuthority<TSnapshot, TCommand>> {
  return PostgresAuthority.open(options);
}
