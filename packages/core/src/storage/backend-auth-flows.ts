import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { defaultStateBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import type { StoredOAuthTokenBundle, StoredOAuthTokenBundleView } from "../auth/store";
import { ensureVaultKey, loadVaultKey } from "../vault/keys";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import { writeBackendAuthTokenBundleInTransaction } from "./backend-auth";
import type {
  PostgresHostDatabase,
  PostgresHostTransaction,
  SqliteHostDatabase,
  SqliteHostTransaction,
  HostDatabase,
} from "./types";
import type { VaultValueStoreOptions } from "./vault-values";

export const BACKEND_AUTH_FLOW_ENVELOPE_VERSION = 1;
export const DEFAULT_BACKEND_AUTH_FLOW_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_BACKEND_AUTH_FLOW_PRUNE_BATCH = 1_000;

export type BackendAuthFlowStatus =
  | "pending"
  | "completing"
  | "completed"
  | "expired"
  | "failed"
  | "unknown";

export type BackendAuthFlowSerializableState = {
  version: number;
  flowId: string;
  server: string;
};

export type BackendAuthFlowView = {
  flowId: string;
  server: string;
  status: BackendAuthFlowStatus;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  claimedAt?: string | undefined;
  terminalAt?: string | undefined;
};

export type BackendAuthFlowClaim<T extends BackendAuthFlowSerializableState> = {
  acquired: true;
  flow: BackendAuthFlowView;
  claimToken: string;
  completionCorrelation: string;
  startingBackendAuthGeneration?: number | undefined;
  state: T;
};

export type BackendAuthFlowClaimResult<T extends BackendAuthFlowSerializableState> =
  | BackendAuthFlowClaim<T>
  | {
      acquired: false;
      reason: "not_found" | "in_progress" | "terminal" | "expired";
      flow?: BackendAuthFlowView | undefined;
    };

export type BackendAuthFlowRepositoryOptions = VaultValueStoreOptions;

export type BackendAuthFlowCompletionInput = {
  flowId: string;
  server: string;
  claimToken: string;
  completionCorrelation: string;
  expectedGeneration: number;
  bundle: StoredOAuthTokenBundle;
  operatorClientId?: string | undefined;
  now?: Date | undefined;
};

type BackendAuthFlowRow = typeof sqlite.backendAuthFlows.$inferSelect;
type EncryptedFlowEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authTag: string;
};

const TERMINAL_STATUSES: BackendAuthFlowStatus[] = ["completed", "expired", "failed", "unknown"];
const NONCE_BYTES = 12;
const FLOW_AAD_DOMAIN = Buffer.from("caplets-backend-auth-flow", "utf8");

export class BackendAuthFlowRepository {
  readonly root: string;
  readonly keyFile: string;
  readonly env: Record<string, string | undefined>;

  constructor(
    private readonly database: HostDatabase,
    options: BackendAuthFlowRepositoryOptions = {},
  ) {
    this.root = options.root ?? join(defaultStateBaseDir(options.env), "caplets", "vault");
    this.keyFile = options.keyFile ?? join(this.root, "vault-key");
    this.env = options.env ?? process.env;
  }

  private flowEncryptionKey(create: boolean): Buffer {
    if (this.database.dialect === "postgres" && this.env.CAPLETS_ENCRYPTION_KEY === undefined) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL backend auth flows require CAPLETS_ENCRYPTION_KEY.",
      );
    }
    return create
      ? ensureVaultKey({ keyFile: this.keyFile, env: this.env })
      : loadVaultKey({ keyFile: this.keyFile, env: this.env });
  }

  async create<T extends BackendAuthFlowSerializableState>(input: {
    flowId: string;
    server: string;
    state: T;
    expiresAt: Date;
    startingBackendAuthGeneration?: number | undefined;
    completionCorrelation?: string | undefined;
    now?: Date | undefined;
  }): Promise<BackendAuthFlowView> {
    validateIdentity(input.flowId, input.server);
    if (
      input.startingBackendAuthGeneration !== undefined &&
      (!Number.isSafeInteger(input.startingBackendAuthGeneration) ||
        input.startingBackendAuthGeneration < 0)
    ) {
      throw new CapletsError("REQUEST_INVALID", "Starting backend auth generation is invalid.");
    }
    if (input.completionCorrelation !== undefined) {
      validateOpaqueToken(input.completionCorrelation, "completion correlation");
    }
    const now = input.now ?? new Date();
    validateTimestampOrder(now, input.expiresAt);
    const plaintext = serializeState(input.state, input.flowId, input.server);
    const encryptedPayload = encryptState(
      plaintext,
      this.flowEncryptionKey(true),
      input.flowId,
      input.server,
    );
    const nowText = now.toISOString();
    const values = {
      flowId: input.flowId,
      server: input.server,
      status: "pending" as const,
      envelopeVersion: BACKEND_AUTH_FLOW_ENVELOPE_VERSION,
      encryptedPayload,
      startingBackendAuthGeneration: input.startingBackendAuthGeneration ?? null,
      completionCorrelation: input.completionCorrelation ?? randomUUID(),
      completedBackendAuthGeneration: null,
      claimToken: null,
      claimedAt: null,
      createdAt: nowText,
      expiresAt: input.expiresAt.toISOString(),
      updatedAt: nowText,
      terminalAt: null,
    };
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db.insert(sqlite.backendAuthFlows).values(values).returning().get()
        : (await this.database.db.insert(postgres.backendAuthFlows).values(values).returning())[0];
    if (!row) throw new CapletsError("INTERNAL_ERROR", "Backend auth flow was not persisted.");
    return viewForRow(row);
  }

  async get(flowId: string, now = new Date()): Promise<BackendAuthFlowView | undefined> {
    validateFlowId(flowId);
    await this.expire(flowId, now);
    const row = await this.readRow(flowId);
    return row ? viewForRow(row) : undefined;
  }

  async list(
    input: {
      server?: string | undefined;
      status?: BackendAuthFlowStatus | undefined;
      now?: Date | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<BackendAuthFlowView[]> {
    if (input.server !== undefined && (!input.server.trim() || input.server.length > 512)) {
      throw new CapletsError("REQUEST_INVALID", "Backend auth flow server is invalid.");
    }
    const status = input.status === undefined ? undefined : parseStatus(input.status);
    const limit = validateBatchLimit(input.limit);
    await this.expireDue({ now: input.now, limit: MAX_BACKEND_AUTH_FLOW_PRUNE_BATCH });
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.backendAuthFlows)
            .where(
              and(
                input.server ? eq(sqlite.backendAuthFlows.server, input.server) : undefined,
                status ? eq(sqlite.backendAuthFlows.status, status) : undefined,
              ),
            )
            .orderBy(asc(sqlite.backendAuthFlows.createdAt))
            .limit(limit)
            .all()
        : await this.database.db
            .select()
            .from(postgres.backendAuthFlows)
            .where(
              and(
                input.server ? eq(postgres.backendAuthFlows.server, input.server) : undefined,
                status ? eq(postgres.backendAuthFlows.status, status) : undefined,
              ),
            )
            .orderBy(asc(postgres.backendAuthFlows.createdAt))
            .limit(limit);
    return rows.map(viewForRow);
  }

  async claim<
    T extends BackendAuthFlowSerializableState = BackendAuthFlowSerializableState,
  >(input: {
    flowId: string;
    claimToken?: string | undefined;
    now?: Date | undefined;
  }): Promise<BackendAuthFlowClaimResult<T>> {
    validateFlowId(input.flowId);
    const encryptionKey = this.flowEncryptionKey(false);
    const now = input.now ?? new Date();
    await this.expire(input.flowId, now);
    const claimToken = input.claimToken ?? randomUUID();
    validateOpaqueToken(claimToken, "claim token");
    const nowText = now.toISOString();
    const claim =
      this.database.dialect === "sqlite"
        ? this.database.db.transaction((transaction) => {
            const row = transaction
              .update(sqlite.backendAuthFlows)
              .set({ status: "completing", claimToken, claimedAt: nowText, updatedAt: nowText })
              .where(
                and(
                  eq(sqlite.backendAuthFlows.flowId, input.flowId),
                  eq(sqlite.backendAuthFlows.status, "pending"),
                  gt(sqlite.backendAuthFlows.expiresAt, nowText),
                ),
              )
              .returning()
              .get();
            return row ? claimedFlow<T>(row, encryptionKey, claimToken) : undefined;
          })
        : await this.database.db.transaction(async (transaction) => {
            const [row] = await transaction
              .update(postgres.backendAuthFlows)
              .set({ status: "completing", claimToken, claimedAt: nowText, updatedAt: nowText })
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, input.flowId),
                  eq(postgres.backendAuthFlows.status, "pending"),
                  gt(postgres.backendAuthFlows.expiresAt, nowText),
                ),
              )
              .returning();
            return row ? claimedFlow<T>(row, encryptionKey, claimToken) : undefined;
          });
    return claim ?? (await this.claimFailure(input.flowId));
  }

  async completeClaim(input: BackendAuthFlowCompletionInput): Promise<StoredOAuthTokenBundleView> {
    validateCompletionInput(input);
    const nowText = (input.now ?? new Date()).toISOString();
    const completed =
      this.database.dialect === "sqlite"
        ? this.database.db.transaction((transaction) =>
            completeClaimSqlite(transaction, input, nowText),
          )
        : await this.database.db.transaction(
            async (transaction) => await completeClaimPostgres(transaction, input, nowText),
          );
    if (!completed) {
      throw new CapletsError(
        "AUTH_FAILED",
        `Auth flow ${input.flowId} is no longer actively claimed.`,
        { kind: "backend_auth_flow_claim_lost", flowId: input.flowId },
      );
    }
    return completed;
  }

  async release(input: {
    flowId: string;
    claimToken: string;
    now?: Date | undefined;
  }): Promise<boolean> {
    validateFlowId(input.flowId);
    validateOpaqueToken(input.claimToken, "claim token");
    const nowText = (input.now ?? new Date()).toISOString();
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set({ status: "pending", claimToken: null, claimedAt: null, updatedAt: nowText })
            .where(
              and(
                eq(sqlite.backendAuthFlows.flowId, input.flowId),
                eq(sqlite.backendAuthFlows.status, "completing"),
                eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .get()
        : (
            await this.database.db
              .update(postgres.backendAuthFlows)
              .set({ status: "pending", claimToken: null, claimedAt: null, updatedAt: nowText })
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, input.flowId),
                  eq(postgres.backendAuthFlows.status, "completing"),
                  eq(postgres.backendAuthFlows.claimToken, input.claimToken),
                ),
              )
              .returning({ flowId: postgres.backendAuthFlows.flowId })
          )[0];
    return row !== undefined;
  }

  async heartbeat(input: {
    flowId: string;
    claimToken: string;
    now?: Date | undefined;
  }): Promise<boolean> {
    validateFlowId(input.flowId);
    validateOpaqueToken(input.claimToken, "claim token");
    const nowText = (input.now ?? new Date()).toISOString();
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set({ claimedAt: nowText, updatedAt: nowText })
            .where(
              and(
                eq(sqlite.backendAuthFlows.flowId, input.flowId),
                eq(sqlite.backendAuthFlows.status, "completing"),
                eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
                gt(sqlite.backendAuthFlows.expiresAt, nowText),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .get()
        : (
            await this.database.db
              .update(postgres.backendAuthFlows)
              .set({ claimedAt: nowText, updatedAt: nowText })
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, input.flowId),
                  eq(postgres.backendAuthFlows.status, "completing"),
                  eq(postgres.backendAuthFlows.claimToken, input.claimToken),
                  gt(postgres.backendAuthFlows.expiresAt, nowText),
                ),
              )
              .returning({ flowId: postgres.backendAuthFlows.flowId })
          )[0];
    return row !== undefined;
  }

  async finalize(input: {
    flowId: string;
    claimToken: string;
    completionCorrelation: string;
    backendAuthGeneration: number;
    now?: Date | undefined;
  }): Promise<boolean> {
    validateFlowId(input.flowId);
    validateOpaqueToken(input.claimToken, "claim token");
    validateOpaqueToken(input.completionCorrelation, "completion correlation");
    validateGeneration(input.backendAuthGeneration);
    const nowText = (input.now ?? new Date()).toISOString();
    const values = {
      status: "completed" as const,
      encryptedPayload: null,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      completedBackendAuthGeneration: input.backendAuthGeneration,
      claimToken: null,
      claimedAt: null,
      terminalAt: nowText,
      updatedAt: nowText,
    };
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set(values)
            .where(
              and(
                eq(sqlite.backendAuthFlows.flowId, input.flowId),
                eq(sqlite.backendAuthFlows.status, "completing"),
                eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
                eq(sqlite.backendAuthFlows.completionCorrelation, input.completionCorrelation),
                or(
                  isNull(sqlite.backendAuthFlows.startingBackendAuthGeneration),
                  lt(
                    sqlite.backendAuthFlows.startingBackendAuthGeneration,
                    input.backendAuthGeneration,
                  ),
                ),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .get()
        : (
            await this.database.db
              .update(postgres.backendAuthFlows)
              .set(values)
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, input.flowId),
                  eq(postgres.backendAuthFlows.status, "completing"),
                  eq(postgres.backendAuthFlows.claimToken, input.claimToken),
                  eq(postgres.backendAuthFlows.completionCorrelation, input.completionCorrelation),
                  or(
                    isNull(postgres.backendAuthFlows.startingBackendAuthGeneration),
                    lt(
                      postgres.backendAuthFlows.startingBackendAuthGeneration,
                      input.backendAuthGeneration,
                    ),
                  ),
                ),
              )
              .returning({ flowId: postgres.backendAuthFlows.flowId })
          )[0];
    return row !== undefined;
  }

  async terminalizeClaim(input: {
    flowId: string;
    claimToken: string;
    status: "failed" | "unknown";
    now?: Date | undefined;
  }): Promise<boolean> {
    validateFlowId(input.flowId);
    validateOpaqueToken(input.claimToken, "claim token");
    if (input.status !== "failed" && input.status !== "unknown") {
      throw new CapletsError("REQUEST_INVALID", "Backend auth terminal status is invalid.");
    }
    const nowText = (input.now ?? new Date()).toISOString();
    const values = {
      ...terminalValues(input.status, nowText),
      completedBackendAuthGeneration: null,
    };
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set(values)
            .where(
              and(
                eq(sqlite.backendAuthFlows.flowId, input.flowId),
                eq(sqlite.backendAuthFlows.status, "completing"),
                eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .get()
        : (
            await this.database.db
              .update(postgres.backendAuthFlows)
              .set(values)
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, input.flowId),
                  eq(postgres.backendAuthFlows.status, "completing"),
                  eq(postgres.backendAuthFlows.claimToken, input.claimToken),
                ),
              )
              .returning({ flowId: postgres.backendAuthFlows.flowId })
          )[0];
    return row !== undefined;
  }

  async reconcileAbandoned(input: {
    flowId: string;
    abandonedBefore: Date;
    observedCompletionCorrelation?: string | undefined;
    observedBackendAuthGeneration?: number | undefined;
    now?: Date | undefined;
  }): Promise<BackendAuthFlowView | undefined> {
    validateFlowId(input.flowId);
    if (input.observedCompletionCorrelation !== undefined) {
      validateOpaqueToken(input.observedCompletionCorrelation, "completion correlation");
    }
    if (input.observedBackendAuthGeneration !== undefined) {
      validateGeneration(input.observedBackendAuthGeneration);
    }
    return this.database.dialect === "sqlite"
      ? reconcileAbandonedSqlite(this.database.db, input)
      : await reconcileAbandonedPostgres(this.database.db, input);
  }

  async expire(flowId: string, now = new Date()): Promise<boolean> {
    validateFlowId(flowId);
    const nowText = now.toISOString();
    const values = terminalValues("expired", nowText);
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set(values)
            .where(
              and(
                eq(sqlite.backendAuthFlows.flowId, flowId),
                inArray(sqlite.backendAuthFlows.status, ["pending", "completing"]),
                lte(sqlite.backendAuthFlows.expiresAt, nowText),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .get()
        : (
            await this.database.db
              .update(postgres.backendAuthFlows)
              .set(values)
              .where(
                and(
                  eq(postgres.backendAuthFlows.flowId, flowId),
                  inArray(postgres.backendAuthFlows.status, ["pending", "completing"]),
                  lte(postgres.backendAuthFlows.expiresAt, nowText),
                ),
              )
              .returning({ flowId: postgres.backendAuthFlows.flowId })
          )[0];
    return row !== undefined;
  }

  async expireDue(
    input: { now?: Date | undefined; limit?: number | undefined } = {},
  ): Promise<number> {
    const now = input.now ?? new Date();
    const limit = validateBatchLimit(input.limit);
    const rows = await this.selectExpirable(now.toISOString(), limit);
    if (rows.length === 0) return 0;
    const nowText = now.toISOString();
    return await this.expireIds(
      rows.map((row) => row.flowId),
      nowText,
    );
  }

  async prune(
    input: {
      now?: Date | undefined;
      retentionMs?: number | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<number> {
    const now = input.now ?? new Date();
    const retentionMs = input.retentionMs ?? DEFAULT_BACKEND_AUTH_FLOW_RETENTION_MS;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Backend auth flow retention must be non-negative.",
      );
    }
    const limit = validateBatchLimit(input.limit);
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    return this.database.dialect === "sqlite"
      ? pruneSqlite(this.database.db, cutoff, limit)
      : await prunePostgres(this.database.db, cutoff, limit);
  }

  private async claimFailure<T extends BackendAuthFlowSerializableState>(
    flowId: string,
  ): Promise<BackendAuthFlowClaimResult<T>> {
    const row = await this.readRow(flowId);
    if (!row) return { acquired: false, reason: "not_found" };
    const flow = viewForRow(row);
    if (row.status === "completing" || row.status === "pending") {
      return { acquired: false, reason: "in_progress", flow };
    }
    if (row.status === "expired") return { acquired: false, reason: "expired", flow };
    return { acquired: false, reason: "terminal", flow };
  }

  private async readRow(flowId: string): Promise<BackendAuthFlowRow | undefined> {
    return this.database.dialect === "sqlite"
      ? this.database.db
          .select()
          .from(sqlite.backendAuthFlows)
          .where(eq(sqlite.backendAuthFlows.flowId, flowId))
          .get()
      : (
          await this.database.db
            .select()
            .from(postgres.backendAuthFlows)
            .where(eq(postgres.backendAuthFlows.flowId, flowId))
            .limit(1)
        )[0];
  }

  private async selectExpirable(
    nowText: string,
    limit: number,
  ): Promise<Array<{ flowId: string }>> {
    return this.database.dialect === "sqlite"
      ? this.database.db
          .select({ flowId: sqlite.backendAuthFlows.flowId })
          .from(sqlite.backendAuthFlows)
          .where(
            and(
              inArray(sqlite.backendAuthFlows.status, ["pending", "completing"]),
              lte(sqlite.backendAuthFlows.expiresAt, nowText),
            ),
          )
          .orderBy(asc(sqlite.backendAuthFlows.expiresAt))
          .limit(limit)
          .all()
      : await this.database.db
          .select({ flowId: postgres.backendAuthFlows.flowId })
          .from(postgres.backendAuthFlows)
          .where(
            and(
              inArray(postgres.backendAuthFlows.status, ["pending", "completing"]),
              lte(postgres.backendAuthFlows.expiresAt, nowText),
            ),
          )
          .orderBy(asc(postgres.backendAuthFlows.expiresAt))
          .limit(limit);
  }

  private async expireIds(flowIds: string[], nowText: string): Promise<number> {
    const values = terminalValues("expired", nowText);
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .update(sqlite.backendAuthFlows)
            .set(values)
            .where(
              and(
                inArray(sqlite.backendAuthFlows.flowId, flowIds),
                inArray(sqlite.backendAuthFlows.status, ["pending", "completing"]),
                lte(sqlite.backendAuthFlows.expiresAt, nowText),
              ),
            )
            .returning({ flowId: sqlite.backendAuthFlows.flowId })
            .all()
        : await this.database.db
            .update(postgres.backendAuthFlows)
            .set(values)
            .where(
              and(
                inArray(postgres.backendAuthFlows.flowId, flowIds),
                inArray(postgres.backendAuthFlows.status, ["pending", "completing"]),
                lte(postgres.backendAuthFlows.expiresAt, nowText),
              ),
            )
            .returning({ flowId: postgres.backendAuthFlows.flowId });
    return rows.length;
  }
}

function claimedFlow<T extends BackendAuthFlowSerializableState>(
  row: BackendAuthFlowRow,
  encryptionKey: Buffer,
  claimToken: string,
): BackendAuthFlowClaim<T> {
  if (
    row.envelopeVersion !== BACKEND_AUTH_FLOW_ENVELOPE_VERSION ||
    !row.encryptedPayload ||
    !row.completionCorrelation
  ) {
    throw new CapletsError("CONFIG_INVALID", "Pending backend auth flow payload is missing.");
  }
  return {
    acquired: true,
    flow: viewForRow(row),
    claimToken,
    completionCorrelation: row.completionCorrelation,
    ...(row.startingBackendAuthGeneration === null
      ? {}
      : { startingBackendAuthGeneration: row.startingBackendAuthGeneration }),
    state: deserializeState<T>(row.encryptedPayload, encryptionKey, row.flowId, row.server),
  };
}

function completeClaimSqlite(
  transaction: SqliteHostTransaction,
  input: BackendAuthFlowCompletionInput,
  nowText: string,
): StoredOAuthTokenBundleView | undefined {
  const row = transaction
    .select()
    .from(sqlite.backendAuthFlows)
    .where(eq(sqlite.backendAuthFlows.flowId, input.flowId))
    .get();
  if (!completionClaimMatches(row, input)) return undefined;
  if (row.expiresAt <= nowText) {
    transaction
      .update(sqlite.backendAuthFlows)
      .set(terminalValues("expired", nowText))
      .where(
        and(
          eq(sqlite.backendAuthFlows.flowId, input.flowId),
          eq(sqlite.backendAuthFlows.status, "completing"),
          eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
          eq(sqlite.backendAuthFlows.completionCorrelation, input.completionCorrelation),
        ),
      )
      .run();
    return undefined;
  }
  const persisted = writeBackendAuthTokenBundleInTransaction(
    input.bundle,
    {
      expectedGeneration: input.expectedGeneration,
      ...(input.operatorClientId ? { operatorClientId: input.operatorClientId } : {}),
    },
    { dialect: "sqlite", db: transaction },
  );
  const completed = transaction
    .update(sqlite.backendAuthFlows)
    .set({
      ...terminalValues("completed", nowText),
      completedBackendAuthGeneration: persisted.generation,
    })
    .where(
      and(
        eq(sqlite.backendAuthFlows.flowId, input.flowId),
        eq(sqlite.backendAuthFlows.status, "completing"),
        eq(sqlite.backendAuthFlows.claimToken, input.claimToken),
        eq(sqlite.backendAuthFlows.completionCorrelation, input.completionCorrelation),
        eq(sqlite.backendAuthFlows.startingBackendAuthGeneration, input.expectedGeneration),
        gt(sqlite.backendAuthFlows.expiresAt, nowText),
      ),
    )
    .returning({ flowId: sqlite.backendAuthFlows.flowId })
    .get();
  if (!completed) {
    throw new CapletsError("INTERNAL_ERROR", "Backend auth flow completion fence was lost.");
  }
  return persisted;
}

async function completeClaimPostgres(
  transaction: PostgresHostTransaction,
  input: BackendAuthFlowCompletionInput,
  nowText: string,
): Promise<StoredOAuthTokenBundleView | undefined> {
  const [row] = await transaction
    .select()
    .from(postgres.backendAuthFlows)
    .where(eq(postgres.backendAuthFlows.flowId, input.flowId))
    .for("update")
    .limit(1);
  if (!completionClaimMatches(row, input)) return undefined;
  if (row.expiresAt <= nowText) {
    await transaction
      .update(postgres.backendAuthFlows)
      .set(terminalValues("expired", nowText))
      .where(
        and(
          eq(postgres.backendAuthFlows.flowId, input.flowId),
          eq(postgres.backendAuthFlows.status, "completing"),
          eq(postgres.backendAuthFlows.claimToken, input.claimToken),
          eq(postgres.backendAuthFlows.completionCorrelation, input.completionCorrelation),
        ),
      );
    return undefined;
  }
  const persisted = await writeBackendAuthTokenBundleInTransaction(
    input.bundle,
    {
      expectedGeneration: input.expectedGeneration,
      ...(input.operatorClientId ? { operatorClientId: input.operatorClientId } : {}),
    },
    { dialect: "postgres", db: transaction },
  );
  const [completed] = await transaction
    .update(postgres.backendAuthFlows)
    .set({
      ...terminalValues("completed", nowText),
      completedBackendAuthGeneration: persisted.generation,
    })
    .where(
      and(
        eq(postgres.backendAuthFlows.flowId, input.flowId),
        eq(postgres.backendAuthFlows.status, "completing"),
        eq(postgres.backendAuthFlows.claimToken, input.claimToken),
        eq(postgres.backendAuthFlows.completionCorrelation, input.completionCorrelation),
        eq(postgres.backendAuthFlows.startingBackendAuthGeneration, input.expectedGeneration),
        gt(postgres.backendAuthFlows.expiresAt, nowText),
      ),
    )
    .returning({ flowId: postgres.backendAuthFlows.flowId });
  if (!completed) {
    throw new CapletsError("INTERNAL_ERROR", "Backend auth flow completion fence was lost.");
  }
  return persisted;
}

function completionClaimMatches(
  row: BackendAuthFlowRow | undefined,
  input: BackendAuthFlowCompletionInput,
): row is BackendAuthFlowRow {
  return Boolean(
    row &&
    row.server === input.server &&
    row.status === "completing" &&
    row.claimToken === input.claimToken &&
    row.completionCorrelation === input.completionCorrelation &&
    row.startingBackendAuthGeneration === input.expectedGeneration,
  );
}

function reconcileAbandonedSqlite(
  database: SqliteHostDatabase,
  input: {
    flowId: string;
    abandonedBefore: Date;
    observedCompletionCorrelation?: string | undefined;
    observedBackendAuthGeneration?: number | undefined;
    now?: Date | undefined;
  },
): BackendAuthFlowView | undefined {
  return database.transaction((transaction) => {
    const row = transaction
      .select()
      .from(sqlite.backendAuthFlows)
      .where(eq(sqlite.backendAuthFlows.flowId, input.flowId))
      .get();
    if (!isAbandonedRow(row, input.abandonedBefore)) return undefined;
    const nowText = (input.now ?? new Date()).toISOString();
    const completed = correlationsMatch(row, input);
    const updated = transaction
      .update(sqlite.backendAuthFlows)
      .set({
        ...terminalValues(completed ? "completed" : "unknown", nowText),
        completedBackendAuthGeneration: completed ? input.observedBackendAuthGeneration! : null,
      })
      .where(
        and(
          eq(sqlite.backendAuthFlows.flowId, input.flowId),
          eq(sqlite.backendAuthFlows.status, "completing"),
          eq(sqlite.backendAuthFlows.claimToken, row.claimToken!),
          eq(sqlite.backendAuthFlows.completionCorrelation, row.completionCorrelation!),
        ),
      )
      .returning()
      .get();
    return updated ? viewForRow(updated) : undefined;
  });
}

async function reconcileAbandonedPostgres(
  database: PostgresHostDatabase,
  input: {
    flowId: string;
    abandonedBefore: Date;
    observedCompletionCorrelation?: string | undefined;
    observedBackendAuthGeneration?: number | undefined;
    now?: Date | undefined;
  },
): Promise<BackendAuthFlowView | undefined> {
  return await database.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(postgres.backendAuthFlows)
      .where(eq(postgres.backendAuthFlows.flowId, input.flowId))
      .for("update")
      .limit(1);
    if (!isAbandonedRow(row, input.abandonedBefore)) return undefined;
    const nowText = (input.now ?? new Date()).toISOString();
    const completed = correlationsMatch(row, input);
    const [updated] = await transaction
      .update(postgres.backendAuthFlows)
      .set({
        ...terminalValues(completed ? "completed" : "unknown", nowText),
        completedBackendAuthGeneration: completed ? input.observedBackendAuthGeneration! : null,
      })
      .where(
        and(
          eq(postgres.backendAuthFlows.flowId, input.flowId),
          eq(postgres.backendAuthFlows.status, "completing"),
          eq(postgres.backendAuthFlows.claimToken, row.claimToken!),
          eq(postgres.backendAuthFlows.completionCorrelation, row.completionCorrelation!),
        ),
      )
      .returning();
    return updated ? viewForRow(updated) : undefined;
  });
}

function pruneSqlite(database: SqliteHostDatabase, cutoff: string, limit: number): number {
  return database.transaction((transaction) => {
    const rows = transaction
      .select({ flowId: sqlite.backendAuthFlows.flowId })
      .from(sqlite.backendAuthFlows)
      .where(
        and(
          inArray(sqlite.backendAuthFlows.status, TERMINAL_STATUSES),
          lte(sqlite.backendAuthFlows.terminalAt, cutoff),
        ),
      )
      .orderBy(asc(sqlite.backendAuthFlows.terminalAt))
      .limit(limit)
      .all();
    if (rows.length === 0) return 0;
    return transaction
      .delete(sqlite.backendAuthFlows)
      .where(
        inArray(
          sqlite.backendAuthFlows.flowId,
          rows.map((row) => row.flowId),
        ),
      )
      .returning({ flowId: sqlite.backendAuthFlows.flowId })
      .all().length;
  });
}

async function prunePostgres(
  database: PostgresHostDatabase,
  cutoff: string,
  limit: number,
): Promise<number> {
  return await database.transaction(async (transaction) => {
    const rows = await transaction
      .select({ flowId: postgres.backendAuthFlows.flowId })
      .from(postgres.backendAuthFlows)
      .where(
        and(
          inArray(postgres.backendAuthFlows.status, TERMINAL_STATUSES),
          lte(postgres.backendAuthFlows.terminalAt, cutoff),
        ),
      )
      .orderBy(asc(postgres.backendAuthFlows.terminalAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;
    const deleted = await transaction
      .delete(postgres.backendAuthFlows)
      .where(
        inArray(
          postgres.backendAuthFlows.flowId,
          rows.map((row) => row.flowId),
        ),
      )
      .returning({ flowId: postgres.backendAuthFlows.flowId });
    return deleted.length;
  });
}

function isAbandonedRow(
  row: BackendAuthFlowRow | undefined,
  abandonedBefore: Date,
): row is BackendAuthFlowRow & {
  claimToken: string;
  claimedAt: string;
  completionCorrelation: string;
} {
  return Boolean(
    row?.status === "completing" &&
    row.claimToken &&
    row.claimedAt &&
    row.completionCorrelation &&
    row.claimedAt <= abandonedBefore.toISOString(),
  );
}

function correlationsMatch(
  row: BackendAuthFlowRow & { completionCorrelation: string },
  input: {
    observedCompletionCorrelation?: string | undefined;
    observedBackendAuthGeneration?: number | undefined;
  },
): boolean {
  return (
    input.observedCompletionCorrelation === row.completionCorrelation &&
    input.observedBackendAuthGeneration !== undefined &&
    (row.startingBackendAuthGeneration === null ||
      input.observedBackendAuthGeneration > row.startingBackendAuthGeneration)
  );
}

function terminalValues(status: "completed" | "expired" | "failed" | "unknown", nowText: string) {
  return {
    status,
    encryptedPayload: null,
    startingBackendAuthGeneration: null,
    completionCorrelation: null,
    claimToken: null,
    claimedAt: null,
    terminalAt: nowText,
    updatedAt: nowText,
  };
}

function viewForRow(row: BackendAuthFlowRow): BackendAuthFlowView {
  const status = parseStatus(row.status);
  return {
    flowId: row.flowId,
    server: row.server,
    status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt } : {}),
  };
}

function parseStatus(value: string): BackendAuthFlowStatus {
  if (
    value === "pending" ||
    value === "completing" ||
    value === "completed" ||
    value === "expired" ||
    value === "failed" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new CapletsError("CONFIG_INVALID", "Backend auth flow status is invalid.");
}

function serializeState(
  state: BackendAuthFlowSerializableState,
  flowId: string,
  server: string,
): string {
  if (!isPlainObject(state) || !Number.isSafeInteger(state.version) || state.version < 1) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow state version is invalid.");
  }
  if (state.flowId !== flowId || state.server !== server) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow state identity does not match.");
  }
  assertJsonValue(state, new Set());
  return JSON.stringify(state);
}

function deserializeState<T extends BackendAuthFlowSerializableState>(
  envelope: unknown,
  key: Buffer,
  flowId: string,
  server: string,
): T {
  const parsedEnvelope = parseEnvelope(envelope);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parsedEnvelope.nonce, "base64url"),
    );
    decipher.setAAD(flowAad(flowId, server));
    decipher.setAuthTag(Buffer.from(parsedEnvelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsedEnvelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const state = JSON.parse(plaintext) as BackendAuthFlowSerializableState;
    serializeState(state, flowId, server);
    return state as T;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_INVALID", "Backend auth flow payload could not be decrypted.");
  }
}

function encryptState(
  plaintext: string,
  key: Buffer,
  flowId: string,
  server: string,
): EncryptedFlowEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(flowAad(flowId, server));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: BACKEND_AUTH_FLOW_ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

function flowAad(flowId: string, server: string): Buffer {
  const encodedFlowId = Buffer.from(flowId, "utf8");
  const encodedServer = Buffer.from(server, "utf8");
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(BACKEND_AUTH_FLOW_ENVELOPE_VERSION, 0);
  header.writeUInt32BE(encodedFlowId.byteLength, 4);
  header.writeUInt32BE(encodedServer.byteLength, 8);
  return Buffer.concat([FLOW_AAD_DOMAIN, header, encodedFlowId, encodedServer]);
}

function parseEnvelope(value: unknown): EncryptedFlowEnvelope {
  if (!isPlainObject(value)) {
    throw new CapletsError("CONFIG_INVALID", "Backend auth flow envelope is invalid.");
  }
  if (
    value.version !== BACKEND_AUTH_FLOW_ENVELOPE_VERSION ||
    value.algorithm !== "aes-256-gcm" ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.authTag !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Backend auth flow envelope is invalid.");
  }
  return value as EncryptedFlowEnvelope;
}

function assertJsonValue(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow state must be JSON serializable.");
  }
  if (seen.has(value)) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow state must not be cyclic.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    if (!isPlainObject(value)) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Backend auth flow state must contain plain objects.",
      );
    }
    for (const nested of Object.values(value)) assertJsonValue(nested, seen);
  }
  seen.delete(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateCompletionInput(input: BackendAuthFlowCompletionInput): void {
  validateIdentity(input.flowId, input.server);
  validateOpaqueToken(input.claimToken, "claim token");
  validateOpaqueToken(input.completionCorrelation, "completion correlation");
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new CapletsError("REQUEST_INVALID", "Expected backend auth generation is invalid.");
  }
  if (input.bundle.server !== input.server) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Backend auth flow credential server does not match.",
    );
  }
  const correlation = input.bundle.metadata?.backendAuthFlow;
  if (
    !isPlainObject(correlation) ||
    correlation.flowId !== input.flowId ||
    correlation.completionCorrelation !== input.completionCorrelation
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Backend auth flow credential correlation is invalid.",
    );
  }
}

function validateIdentity(flowId: string, server: string): void {
  validateFlowId(flowId);
  if (!server.trim() || server.length > 512) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow server is invalid.");
  }
}

function validateFlowId(flowId: string): void {
  if (!flowId.trim() || flowId.length > 512) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow ID is invalid.");
  }
}

function validateOpaqueToken(value: string, label: string): void {
  if (!value.trim() || value.length > 512) {
    throw new CapletsError("REQUEST_INVALID", `Backend auth flow ${label} is invalid.`);
  }
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth generation is invalid.");
  }
}

function validateTimestampOrder(now: Date, expiresAt: Date): void {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt.getTime())) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow timestamps are invalid.");
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new CapletsError("REQUEST_INVALID", "Backend auth flow expiry must be in the future.");
  }
}

function validateBatchLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKEND_AUTH_FLOW_PRUNE_BATCH) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Backend auth flow batch limit must be between 1 and ${MAX_BACKEND_AUTH_FLOW_PRUNE_BATCH}.`,
    );
  }
  return limit;
}
