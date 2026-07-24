import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, lte, or, sql, type SQL } from "drizzle-orm";
import { CapletsError } from "../errors";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostTransaction, SqliteHostTransaction } from "./types";

export const DEFAULT_IDEMPOTENCY_PENDING_TTL_MS = 30_000;
export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;
export const DEFAULT_IDEMPOTENCY_MAX_ROWS_PER_PRINCIPAL = 1_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_IDEMPOTENCY_FINAL_BODY_BYTES = 1024 * 1024;
const MAX_IDEMPOTENCY_FINAL_BODY_ENVELOPE_CHARACTERS =
  Math.ceil((MAX_IDEMPOTENCY_FINAL_BODY_BYTES * 4) / 3) + 256;

const VISIBLE_ASCII_KEY = /^[\x21-\x7e]{1,128}$/u;
const MAX_IDENTITY_LENGTH = 512;
const MAX_RECONCILIATION_LINKS = 32;
const MAX_RECONCILIATION_LINK_LENGTH = 2_048;
const KEYED_REQUEST_FINGERPRINT = /^hmac-sha256:[a-f0-9]{64}$/u;
const IDEMPOTENCY_FINAL_BODY_ENVELOPE_VERSION = 1;
const IDEMPOTENCY_FINAL_BODY_NONCE_BYTES = 12;
const IDEMPOTENCY_FINAL_BODY_AUTH_TAG_BYTES = 16;
const IDEMPOTENCY_FINAL_BODY_AAD_DOMAIN = Buffer.from(
  "caplets-idempotency-final-response-body",
  "utf8",
);

type IdempotencyFinalBodyEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authTag: string;
};

type IdempotencyRecordKey = {
  principalClientId: string;
  operationId: string;
  idempotencyKey: string;
};

export type IdempotencyState = "pending" | "finalized" | "unknown";

export type IdempotencyFinalResponse = {
  status: number;
  contentType: string;
  body: string;
};

export type IdempotencyClaimInput = IdempotencyRecordKey & {
  requestFingerprintSource: string;
  reconciliationLinks?: readonly string[] | undefined;
  now?: Date | undefined;
};

export type IdempotencyClaimResult =
  | {
      outcome: "acquired";
      ownerToken: string;
      expiresAt: string;
    }
  | {
      outcome: "in_progress";
      retryAfterSeconds: number;
    }
  | {
      outcome: "conflict";
    }
  | {
      outcome: "replay";
      response: IdempotencyFinalResponse;
    }
  | {
      outcome: "unknown";
      reconciliationLinks: string[];
    }
  | {
      outcome: "capacity_exceeded";
    };

export type IdempotencyHeartbeatInput = IdempotencyRecordKey & {
  ownerToken: string;
  now?: Date | undefined;
};

export type IdempotencyFinalizeInput = IdempotencyRecordKey & {
  ownerToken: string;
  response: IdempotencyFinalResponse;
  now?: Date | undefined;
};

export type IdempotencyPruneResult = {
  transitionedToUnknown: number;
  deleted: number;
};

export type IdempotencyStoreOptions = {
  pendingTtlMs?: number | undefined;
  retentionMs?: number | undefined;
  maxRowsPerPrincipal?: number | undefined;
};

type IdempotencyRow = typeof sqlite.idempotencyRecords.$inferSelect;
type PreparedClaim = {
  key: IdempotencyRecordKey;
  requestHash: string;
  reconciliationLinks: string;
  ownerToken: string;
  now: Date;
  nowText: string;
  staleBeforeText: string;
  expiresAtText: string;
};

export class IdempotencyStore {
  private readonly pendingTtlMs: number;
  private readonly retentionMs: number;
  private readonly maxRowsPerPrincipal: number;

  constructor(
    private readonly database: HostDatabase,
    private readonly fingerprintRequest: (canonicalRequest: string) => string,
    private readonly responseEncryptionKey: (create: boolean) => Buffer,
    options: IdempotencyStoreOptions = {},
  ) {
    this.pendingTtlMs = positiveSafeInteger(
      options.pendingTtlMs ?? DEFAULT_IDEMPOTENCY_PENDING_TTL_MS,
      "pending TTL",
    );
    this.retentionMs = positiveSafeInteger(
      options.retentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS,
      "retention",
    );
    this.maxRowsPerPrincipal = positiveSafeInteger(
      options.maxRowsPerPrincipal ?? DEFAULT_IDEMPOTENCY_MAX_ROWS_PER_PRINCIPAL,
      "principal row limit",
    );
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const prepared = this.prepareClaim(input);
    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        (transaction) => this.claimSqlite(transaction, prepared),
        { behavior: "immediate" },
      );
    }
    return await this.database.db.transaction(
      async (transaction) => await this.claimPostgres(transaction, prepared),
    );
  }

  async heartbeat(input: IdempotencyHeartbeatInput): Promise<boolean> {
    validateRecordKey(input);
    validateOpaqueValue(input.ownerToken, "owner token");
    const now = validDate(input.now ?? new Date(), "heartbeat time");
    const nowText = now.toISOString();
    const staleBeforeText = new Date(now.getTime() - this.pendingTtlMs).toISOString();
    const unknownExpiryText = new Date(now.getTime() + this.retentionMs).toISOString();

    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        async (transaction) => {
          const updated = (
            await transaction
              .update(sqlite.idempotencyRecords)
              .set({ heartbeatAt: nowText, updatedAt: nowText })
              .where(
                and(
                  sqliteKeyWhere(input),
                  eq(sqlite.idempotencyRecords.state, "pending"),
                  eq(sqlite.idempotencyRecords.ownerToken, input.ownerToken),
                  gt(sqlite.idempotencyRecords.heartbeatAt, staleBeforeText),
                ),
              )
              .run()
          ).rowsAffected;
          if (updated > 0) return true;
          await transitionPendingToUnknownSqlite(
            transaction,
            sqliteKeyWhere(input),
            staleBeforeText,
            nowText,
            unknownExpiryText,
          );
          return false;
        },
        { behavior: "immediate" },
      );
    }

    return await this.database.db.transaction(async (transaction) => {
      const updated = await transaction
        .update(postgres.idempotencyRecords)
        .set({ heartbeatAt: nowText, updatedAt: nowText })
        .where(
          and(
            postgresKeyWhere(input),
            eq(postgres.idempotencyRecords.state, "pending"),
            eq(postgres.idempotencyRecords.ownerToken, input.ownerToken),
            gt(postgres.idempotencyRecords.heartbeatAt, staleBeforeText),
          ),
        )
        .returning({ idempotencyKey: postgres.idempotencyRecords.idempotencyKey });
      if (updated.length > 0) return true;
      await transitionPendingToUnknownPostgres(
        transaction,
        postgresKeyWhere(input),
        staleBeforeText,
        nowText,
        unknownExpiryText,
      );
      return false;
    });
  }

  async finalize(input: IdempotencyFinalizeInput): Promise<boolean> {
    validateRecordKey(input);
    validateOpaqueValue(input.ownerToken, "owner token");
    validateResponse(input.response);
    const now = validDate(input.now ?? new Date(), "finalization time");
    const nowText = now.toISOString();
    const staleBeforeText = new Date(now.getTime() - this.pendingTtlMs).toISOString();
    const expiresAt = new Date(now.getTime() + this.retentionMs).toISOString();
    const values = {
      state: "finalized" as const,
      ownerToken: null,
      responseStatus: input.response.status,
      responseContentType: input.response.contentType,
      responseBody: encryptFinalBody(input.response.body, this.responseEncryptionKey(true), input),
      heartbeatAt: null,
      terminalAt: nowText,
      updatedAt: nowText,
      expiresAt,
    };

    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        async (transaction) => {
          const updated = (
            await transaction
              .update(sqlite.idempotencyRecords)
              .set(values)
              .where(
                and(
                  sqliteKeyWhere(input),
                  eq(sqlite.idempotencyRecords.state, "pending"),
                  eq(sqlite.idempotencyRecords.ownerToken, input.ownerToken),
                  gt(sqlite.idempotencyRecords.heartbeatAt, staleBeforeText),
                ),
              )
              .run()
          ).rowsAffected;
          if (updated > 0) return true;
          await transitionPendingToUnknownSqlite(
            transaction,
            sqliteKeyWhere(input),
            staleBeforeText,
            nowText,
            expiresAt,
          );
          return false;
        },
        { behavior: "immediate" },
      );
    }

    return await this.database.db.transaction(async (transaction) => {
      const rows = await transaction
        .update(postgres.idempotencyRecords)
        .set(values)
        .where(
          and(
            postgresKeyWhere(input),
            eq(postgres.idempotencyRecords.state, "pending"),
            eq(postgres.idempotencyRecords.ownerToken, input.ownerToken),
            gt(postgres.idempotencyRecords.heartbeatAt, staleBeforeText),
          ),
        )
        .returning({ idempotencyKey: postgres.idempotencyRecords.idempotencyKey });
      if (rows.length > 0) return true;
      await transitionPendingToUnknownPostgres(
        transaction,
        postgresKeyWhere(input),
        staleBeforeText,
        nowText,
        expiresAt,
      );
      return false;
    });
  }

  async prune(input: { now?: Date | undefined } = {}): Promise<IdempotencyPruneResult> {
    const now = validDate(input.now ?? new Date(), "prune time");
    const nowText = now.toISOString();
    const staleBeforeText = new Date(now.getTime() - this.pendingTtlMs).toISOString();
    const unknownExpiryText = new Date(now.getTime() + this.retentionMs).toISOString();

    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        async (transaction) =>
          await pruneSqlite(transaction, staleBeforeText, nowText, unknownExpiryText),
        { behavior: "immediate" },
      );
    }
    return await this.database.db.transaction(
      async (transaction) =>
        await prunePostgres(transaction, staleBeforeText, nowText, unknownExpiryText),
    );
  }

  private prepareClaim(input: IdempotencyClaimInput): PreparedClaim {
    validateRecordKey(input);
    validateFingerprintSource(input.requestFingerprintSource);
    const requestHash = this.fingerprintRequest(input.requestFingerprintSource);
    validateRequestFingerprint(requestHash);
    const reconciliationLinks = validateReconciliationLinks(input.reconciliationLinks ?? []);
    const now = validDate(input.now ?? new Date(), "claim time");
    return {
      key: {
        principalClientId: input.principalClientId,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
      },
      requestHash,
      reconciliationLinks: JSON.stringify(reconciliationLinks),
      ownerToken: randomUUID(),
      now,
      nowText: now.toISOString(),
      staleBeforeText: new Date(now.getTime() - this.pendingTtlMs).toISOString(),
      expiresAtText: new Date(now.getTime() + this.retentionMs).toISOString(),
    };
  }

  private async claimSqlite(
    transaction: SqliteHostTransaction,
    input: PreparedClaim,
  ): Promise<IdempotencyClaimResult> {
    await prunePrincipalSqlite(
      transaction,
      input.key.principalClientId,
      input.staleBeforeText,
      input.nowText,
      input.expiresAtText,
    );
    const inserted =
      (
        await transaction
          .insert(sqlite.idempotencyRecords)
          .values(newRecordValues(input))
          .onConflictDoNothing()
          .run()
      ).rowsAffected > 0;
    if (inserted) {
      const rowCount = (
        await transaction
          .select({ count: count() })
          .from(sqlite.idempotencyRecords)
          .where(eq(sqlite.idempotencyRecords.principalClientId, input.key.principalClientId))
          .get()
      )?.count;
      if ((rowCount ?? 0) <= this.maxRowsPerPrincipal) return acquiredResult(input);
      await transaction
        .delete(sqlite.idempotencyRecords)
        .where(
          and(
            sqliteKeyWhere(input.key),
            eq(sqlite.idempotencyRecords.ownerToken, input.ownerToken),
          ),
        )
        .run();
      return { outcome: "capacity_exceeded" };
    }
    const row = await transaction
      .select()
      .from(sqlite.idempotencyRecords)
      .where(sqliteKeyWhere(input.key))
      .limit(1)
      .get();
    return existingClaimResult(row, input, this.pendingTtlMs, () =>
      this.responseEncryptionKey(false),
    );
  }

  private async claimPostgres(
    transaction: PostgresHostTransaction,
    input: PreparedClaim,
  ): Promise<IdempotencyClaimResult> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        "idempotency-principal",
        input.key.principalClientId,
      ])}, 0))`,
    );
    await prunePrincipalPostgres(
      transaction,
      input.key.principalClientId,
      input.staleBeforeText,
      input.nowText,
      input.expiresAtText,
    );
    const inserted = await transaction
      .insert(postgres.idempotencyRecords)
      .values(newRecordValues(input))
      .onConflictDoNothing()
      .returning({ idempotencyKey: postgres.idempotencyRecords.idempotencyKey });
    if (inserted.length > 0) {
      const [rowCount] = await transaction
        .select({ count: count() })
        .from(postgres.idempotencyRecords)
        .where(eq(postgres.idempotencyRecords.principalClientId, input.key.principalClientId));
      if ((rowCount?.count ?? 0) <= this.maxRowsPerPrincipal) return acquiredResult(input);
      await transaction
        .delete(postgres.idempotencyRecords)
        .where(
          and(
            postgresKeyWhere(input.key),
            eq(postgres.idempotencyRecords.ownerToken, input.ownerToken),
          ),
        );
      return { outcome: "capacity_exceeded" };
    }
    const [row] = await transaction
      .select()
      .from(postgres.idempotencyRecords)
      .where(postgresKeyWhere(input.key))
      .for("update")
      .limit(1);
    return existingClaimResult(row, input, this.pendingTtlMs, () =>
      this.responseEncryptionKey(false),
    );
  }
}

function newRecordValues(input: PreparedClaim) {
  return {
    ...input.key,
    requestHash: input.requestHash,
    state: "pending" as const,
    ownerToken: input.ownerToken,
    reconciliationLinks: input.reconciliationLinks,
    responseStatus: null,
    responseContentType: null,
    responseBody: null,
    createdAt: input.nowText,
    updatedAt: input.nowText,
    heartbeatAt: input.nowText,
    terminalAt: null,
    expiresAt: input.expiresAtText,
  };
}

function acquiredResult(input: PreparedClaim): IdempotencyClaimResult {
  return {
    outcome: "acquired",
    ownerToken: input.ownerToken,
    expiresAt: input.expiresAtText,
  };
}

function existingClaimResult(
  row: IdempotencyRow | undefined,
  input: PreparedClaim,
  pendingTtlMs: number,
  responseEncryptionKey: () => Buffer,
): IdempotencyClaimResult {
  if (!row) throw new CapletsError("INTERNAL_ERROR", "Idempotency claim race lost its record.");
  if (row.requestHash !== input.requestHash) return { outcome: "conflict" };
  const state = parseState(row.state);
  if (state === "unknown") {
    return { outcome: "unknown", reconciliationLinks: parseReconciliationLinks(row) };
  }
  if (state === "finalized") {
    if (
      row.responseStatus === null ||
      row.responseContentType === null ||
      row.responseBody === null
    ) {
      throw new CapletsError("INTERNAL_ERROR", "Finalized idempotency response is incomplete.");
    }
    return {
      outcome: "replay",
      response: {
        status: row.responseStatus,
        contentType: row.responseContentType,
        body: decryptFinalBody(row.responseBody, responseEncryptionKey(), input.key),
      },
    };
  }
  if (row.heartbeatAt === null) {
    throw new CapletsError("INTERNAL_ERROR", "Pending idempotency claim has no heartbeat.");
  }
  const retryAt = new Date(row.heartbeatAt).getTime() + pendingTtlMs;
  return {
    outcome: "in_progress",
    retryAfterSeconds: Math.max(1, Math.ceil((retryAt - input.now.getTime()) / 1_000)),
  };
}

async function prunePrincipalSqlite(
  transaction: SqliteHostTransaction,
  principalClientId: string,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<void> {
  await transitionPendingToUnknownSqlite(
    transaction,
    eq(sqlite.idempotencyRecords.principalClientId, principalClientId),
    staleBeforeText,
    nowText,
    unknownExpiryText,
  );
  await transaction
    .delete(sqlite.idempotencyRecords)
    .where(
      and(
        eq(sqlite.idempotencyRecords.principalClientId, principalClientId),
        terminalStateWhereSqlite(),
        lte(sqlite.idempotencyRecords.expiresAt, nowText),
      ),
    )
    .run();
}

async function prunePrincipalPostgres(
  transaction: PostgresHostTransaction,
  principalClientId: string,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<void> {
  await transitionPendingToUnknownPostgres(
    transaction,
    eq(postgres.idempotencyRecords.principalClientId, principalClientId),
    staleBeforeText,
    nowText,
    unknownExpiryText,
  );
  await transaction
    .delete(postgres.idempotencyRecords)
    .where(
      and(
        eq(postgres.idempotencyRecords.principalClientId, principalClientId),
        terminalStateWherePostgres(),
        lte(postgres.idempotencyRecords.expiresAt, nowText),
      ),
    );
}

async function pruneSqlite(
  transaction: SqliteHostTransaction,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<IdempotencyPruneResult> {
  const transitionedToUnknown = await transitionPendingToUnknownSqlite(
    transaction,
    undefined,
    staleBeforeText,
    nowText,
    unknownExpiryText,
  );
  const deleted = (
    await transaction
      .delete(sqlite.idempotencyRecords)
      .where(and(terminalStateWhereSqlite(), lte(sqlite.idempotencyRecords.expiresAt, nowText)))
      .run()
  ).rowsAffected;
  return { transitionedToUnknown, deleted };
}

async function prunePostgres(
  transaction: PostgresHostTransaction,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<IdempotencyPruneResult> {
  const transitionedToUnknown = await transitionPendingToUnknownPostgres(
    transaction,
    undefined,
    staleBeforeText,
    nowText,
    unknownExpiryText,
  );
  const deleted = await transaction
    .delete(postgres.idempotencyRecords)
    .where(and(terminalStateWherePostgres(), lte(postgres.idempotencyRecords.expiresAt, nowText)))
    .returning({ idempotencyKey: postgres.idempotencyRecords.idempotencyKey });
  return { transitionedToUnknown, deleted: deleted.length };
}

async function transitionPendingToUnknownSqlite(
  transaction: SqliteHostTransaction,
  scope: SQL | undefined,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<number> {
  return (
    await transaction
      .update(sqlite.idempotencyRecords)
      .set({
        state: "unknown",
        ownerToken: null,
        heartbeatAt: null,
        terminalAt: nowText,
        updatedAt: nowText,
        expiresAt: unknownExpiryText,
      })
      .where(
        and(
          scope,
          eq(sqlite.idempotencyRecords.state, "pending"),
          lte(sqlite.idempotencyRecords.heartbeatAt, staleBeforeText),
        ),
      )
      .run()
  ).rowsAffected;
}

async function transitionPendingToUnknownPostgres(
  transaction: PostgresHostTransaction,
  scope: SQL | undefined,
  staleBeforeText: string,
  nowText: string,
  unknownExpiryText: string,
): Promise<number> {
  const rows = await transaction
    .update(postgres.idempotencyRecords)
    .set({
      state: "unknown",
      ownerToken: null,
      heartbeatAt: null,
      terminalAt: nowText,
      updatedAt: nowText,
      expiresAt: unknownExpiryText,
    })
    .where(
      and(
        scope,
        eq(postgres.idempotencyRecords.state, "pending"),
        lte(postgres.idempotencyRecords.heartbeatAt, staleBeforeText),
      ),
    )
    .returning({ idempotencyKey: postgres.idempotencyRecords.idempotencyKey });
  return rows.length;
}

function sqliteKeyWhere(key: IdempotencyRecordKey) {
  return and(
    eq(sqlite.idempotencyRecords.principalClientId, key.principalClientId),
    eq(sqlite.idempotencyRecords.operationId, key.operationId),
    eq(sqlite.idempotencyRecords.idempotencyKey, key.idempotencyKey),
  );
}

function postgresKeyWhere(key: IdempotencyRecordKey) {
  return and(
    eq(postgres.idempotencyRecords.principalClientId, key.principalClientId),
    eq(postgres.idempotencyRecords.operationId, key.operationId),
    eq(postgres.idempotencyRecords.idempotencyKey, key.idempotencyKey),
  );
}

function terminalStateWhereSqlite() {
  return or(
    eq(sqlite.idempotencyRecords.state, "finalized"),
    eq(sqlite.idempotencyRecords.state, "unknown"),
  );
}

function terminalStateWherePostgres() {
  return or(
    eq(postgres.idempotencyRecords.state, "finalized"),
    eq(postgres.idempotencyRecords.state, "unknown"),
  );
}

function validateRecordKey(key: IdempotencyRecordKey): void {
  validateIdentity(key.principalClientId, "principal client ID");
  validateIdentity(key.operationId, "operation ID");
  if (!VISIBLE_ASCII_KEY.test(key.idempotencyKey)) {
    throw invalidInput(
      `Idempotency key must contain 1-${MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters.`,
    );
  }
}

function containsC0Control(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function validateIdentity(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_IDENTITY_LENGTH ||
    containsC0Control(value)
  ) {
    throw invalidInput(`Idempotency ${label} is invalid.`);
  }
}

function validateFingerprintSource(value: string): void {
  if (typeof value !== "string" || !value) {
    throw invalidInput("Idempotency request fingerprint source is invalid.");
  }
}

function validateRequestFingerprint(value: string): void {
  if (!KEYED_REQUEST_FINGERPRINT.test(value)) {
    throw new CapletsError("INTERNAL_ERROR", "Idempotency request fingerprint is invalid.");
  }
}

function validateOpaqueValue(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_IDENTITY_LENGTH ||
    containsC0Control(value)
  ) {
    throw invalidInput(`Idempotency ${label} is invalid.`);
  }
}

function validateReconciliationLinks(links: readonly string[]): string[] {
  if (!Array.isArray(links) || links.length > MAX_RECONCILIATION_LINKS) {
    throw invalidInput("Idempotency reconciliation links are invalid.");
  }
  return links.map((link) => {
    if (
      typeof link !== "string" ||
      !link ||
      link.length > MAX_RECONCILIATION_LINK_LENGTH ||
      containsC0Control(link)
    ) {
      throw invalidInput("Idempotency reconciliation link is invalid.");
    }
    return link;
  });
}

function validateResponse(response: IdempotencyFinalResponse): void {
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    throw invalidInput("Idempotency response status is invalid.");
  }
  if (
    typeof response.contentType !== "string" ||
    !response.contentType ||
    response.contentType.length > 512 ||
    containsC0Control(response.contentType)
  ) {
    throw invalidInput("Idempotency response content type is invalid.");
  }
  if (
    typeof response.body !== "string" ||
    Buffer.from(response.body, "utf8").toString("utf8") !== response.body
  ) {
    throw invalidInput("Idempotency response body must be a well-formed UTF-8 string.");
  }
  if (Buffer.byteLength(response.body, "utf8") > MAX_IDEMPOTENCY_FINAL_BODY_BYTES) {
    throw invalidInput(
      `Idempotency response body exceeds ${MAX_IDEMPOTENCY_FINAL_BODY_BYTES} bytes.`,
    );
  }
}

function encryptFinalBody(plaintext: string, key: Buffer, identity: IdempotencyRecordKey): string {
  const nonce = randomBytes(IDEMPOTENCY_FINAL_BODY_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(finalBodyAad(identity));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: IdempotencyFinalBodyEnvelope = {
    version: IDEMPOTENCY_FINAL_BODY_ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(envelope);
}

function decryptFinalBody(stored: string, key: Buffer, identity: IdempotencyRecordKey): string {
  const envelope = parseFinalBodyEnvelope(stored);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
    decipher.setAAD(finalBodyAad(identity));
    decipher.setAuthTag(envelope.authTag);
    const plaintextBytes = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    const plaintext = plaintextBytes.toString("utf8");
    if (!Buffer.from(plaintext, "utf8").equals(plaintextBytes)) {
      throw new Error("decrypted body is not UTF-8");
    }
    return plaintext;
  } catch {
    throw invalidStoredFinalBody();
  }
}

function finalBodyAad(identity: IdempotencyRecordKey): Buffer {
  const principalClientId = Buffer.from(identity.principalClientId, "utf8");
  const operationId = Buffer.from(identity.operationId, "utf8");
  const idempotencyKey = Buffer.from(identity.idempotencyKey, "utf8");
  const header = Buffer.allocUnsafe(16);
  header.writeUInt32BE(IDEMPOTENCY_FINAL_BODY_ENVELOPE_VERSION, 0);
  header.writeUInt32BE(principalClientId.byteLength, 4);
  header.writeUInt32BE(operationId.byteLength, 8);
  header.writeUInt32BE(idempotencyKey.byteLength, 12);
  return Buffer.concat([
    IDEMPOTENCY_FINAL_BODY_AAD_DOMAIN,
    header,
    principalClientId,
    operationId,
    idempotencyKey,
  ]);
}

function parseFinalBodyEnvelope(stored: string): {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
} {
  if (stored.length > MAX_IDEMPOTENCY_FINAL_BODY_ENVELOPE_CHARACTERS) {
    throw invalidStoredFinalBody();
  }
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    throw invalidStoredFinalBody();
  }
  if (!isPlainObject(value)) throw invalidStoredFinalBody();
  if (
    value.version !== IDEMPOTENCY_FINAL_BODY_ENVELOPE_VERSION ||
    value.algorithm !== "aes-256-gcm" ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.authTag !== "string"
  ) {
    throw invalidStoredFinalBody();
  }
  const ciphertext = decodeEnvelopeBytes(value.ciphertext);
  if (ciphertext.byteLength > MAX_IDEMPOTENCY_FINAL_BODY_BYTES) {
    throw invalidStoredFinalBody();
  }
  return {
    nonce: decodeEnvelopeBytes(value.nonce, IDEMPOTENCY_FINAL_BODY_NONCE_BYTES),
    ciphertext,
    authTag: decodeEnvelopeBytes(value.authTag, IDEMPOTENCY_FINAL_BODY_AUTH_TAG_BYTES),
  };
}

function decodeEnvelopeBytes(encoded: string, expectedLength?: number): Buffer {
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.toString("base64url") !== encoded ||
    (expectedLength !== undefined && decoded.byteLength !== expectedLength)
  ) {
    throw invalidStoredFinalBody();
  }
  return decoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidStoredFinalBody(): CapletsError {
  return new CapletsError(
    "CONFIG_INVALID",
    "Stored idempotency final response body is invalid or could not be decrypted.",
  );
}

function parseState(value: string): IdempotencyState {
  if (value === "pending" || value === "finalized" || value === "unknown") return value;
  throw new CapletsError("INTERNAL_ERROR", "Stored idempotency state is invalid.");
}

function parseReconciliationLinks(row: IdempotencyRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.reconciliationLinks);
    return validateReconciliationLinks(parsed as string[]);
  } catch {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Stored idempotency reconciliation links are invalid.",
    );
  }
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidInput(`Idempotency ${label} is invalid.`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`Idempotency ${label} must be a positive integer.`);
  }
  return value;
}

function invalidInput(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}
