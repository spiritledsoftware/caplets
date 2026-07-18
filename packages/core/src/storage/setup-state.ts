import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { CapletsError } from "../errors";
import {
  parseSetupApproval,
  parseSetupAttempt,
  type LegacySetupMigrationSnapshot,
  type SetupApprovalInput,
} from "../setup/local-store";
import type { SetupApproval, SetupAttempt, SetupTargetKind } from "../setup/types";
import { stableJsonStringify } from "../stable-json";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  SqliteHostDatabase,
} from "./types";

export const SETUP_APPROVALS_NAMESPACE = "setup-approvals";
export const SETUP_ATTEMPTS_NAMESPACE = "setup-attempts";

const DEFAULT_PROJECT_FINGERPRINT = "default";

export type SetupStateStoreOptions = {
  now?: () => Date;
  maxAttempts?: number;
  retentionDays?: number;
};

export type SetupStateMutationOptions = {
  expectedGeneration?: number | undefined;
  operatorClientId?: string | undefined;
};

type SetupAttemptsPayload = {
  attempts: SetupAttempt[];
};

export class SetupStateStore {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retentionDays: number;

  constructor(
    private readonly database: HostDatabase,
    options: SetupStateStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retentionDays = options.retentionDays ?? 7;
  }

  async getApproval(
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<SetupApproval | undefined>;
  async getApproval(
    projectFingerprint: string,
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<SetupApproval | undefined>;
  async getApproval(
    ...args: [string, string, SetupTargetKind] | [string, string, string, SetupTargetKind]
  ): Promise<SetupApproval | undefined> {
    const identity = approvalIdentity(args);
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select({ payload: sqlite.setupApprovals.payload })
            .from(sqlite.setupApprovals)
            .where(sqliteApprovalWhere(identity))
            .get()
        : (
            await this.database.db
              .select({ payload: postgres.setupApprovals.payload })
              .from(postgres.setupApprovals)
              .where(postgresApprovalWhere(identity))
              .limit(1)
          )[0];
    return row ? parseSetupApproval(row.payload) : undefined;
  }

  async approve(
    input: SetupApprovalInput,
    options: SetupStateMutationOptions = {},
  ): Promise<SetupApproval> {
    const approval = parseSetupApproval(input);
    const timestamp = this.now().toISOString();
    if (this.database.dialect === "sqlite") {
      mutateApprovalSqlite(this.database.db, approval, options, timestamp);
    } else {
      await mutateApprovalPostgres(this.database.db, approval, options, timestamp);
    }
    return approval;
  }

  async setApproval(
    input: SetupApprovalInput,
    options: SetupStateMutationOptions = {},
  ): Promise<SetupApproval> {
    return await this.approve(input, options);
  }

  async recordAttempt(input: SetupAttempt, options: SetupStateMutationOptions = {}): Promise<void> {
    const attempt = parseSetupAttempt(input);
    const timestamp = this.now().toISOString();
    const transition = (payload: unknown | undefined): SetupAttemptsPayload => {
      const attempts = payload === undefined ? [] : parseAttemptsPayload(payload).attempts;
      return { attempts: this.prunedAttempts([...attempts, attempt]) };
    };
    if (this.database.dialect === "sqlite") {
      mutateAttemptsSqlite(this.database.db, attempt, options, timestamp, transition);
    } else {
      await mutateAttemptsPostgres(this.database.db, attempt, options, timestamp, transition);
    }
  }

  async setAttempt(attempt: SetupAttempt, options: SetupStateMutationOptions = {}): Promise<void> {
    await this.recordAttempt(attempt, options);
  }

  async getAttempt(
    projectFingerprint: string,
    capletId: string,
    attemptId: string,
  ): Promise<SetupAttempt | undefined> {
    const attempts = await this.listAttempts(projectFingerprint, capletId);
    return attempts.find((attempt) => attempt.attemptId === attemptId);
  }

  async listAttempts(capletId: string): Promise<SetupAttempt[]>;
  async listAttempts(projectFingerprint: string, capletId: string): Promise<SetupAttempt[]>;
  async listAttempts(...args: [string] | [string, string]): Promise<SetupAttempt[]> {
    const [projectFingerprint, capletId] =
      args.length === 1 ? [DEFAULT_PROJECT_FINGERPRINT, args[0]] : args;
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select({ payload: sqlite.setupAttemptSets.payload })
            .from(sqlite.setupAttemptSets)
            .where(
              and(
                eq(sqlite.setupAttemptSets.projectFingerprint, projectFingerprint),
                eq(sqlite.setupAttemptSets.capletId, capletId),
              ),
            )
            .get()
        : (
            await this.database.db
              .select({ payload: postgres.setupAttemptSets.payload })
              .from(postgres.setupAttemptSets)
              .where(
                and(
                  eq(postgres.setupAttemptSets.projectFingerprint, projectFingerprint),
                  eq(postgres.setupAttemptSets.capletId, capletId),
                ),
              )
              .limit(1)
          )[0];
    return row ? parseAttemptsPayload(row.payload).attempts : [];
  }

  async clearAttempts(capletId: string, options?: SetupStateMutationOptions): Promise<boolean>;
  async clearAttempts(
    projectFingerprint: string,
    capletId: string,
    options?: SetupStateMutationOptions,
  ): Promise<boolean>;
  async clearAttempts(
    ...args: [string, (string | SetupStateMutationOptions)?, SetupStateMutationOptions?]
  ): Promise<boolean> {
    const [projectFingerprint, capletId, options] =
      typeof args[1] === "string"
        ? [args[0], args[1], args[2] ?? {}]
        : [DEFAULT_PROJECT_FINGERPRINT, args[0], args[1] ?? {}];
    const timestamp = this.now().toISOString();
    return this.database.dialect === "sqlite"
      ? clearAttemptsSqlite(this.database.db, projectFingerprint, capletId, options, timestamp)
      : await clearAttemptsPostgres(
          this.database.db,
          projectFingerprint,
          capletId,
          options,
          timestamp,
        );
  }

  async assertLegacySnapshotImportable(snapshot: LegacySetupMigrationSnapshot): Promise<void> {
    const validated = validateLegacySetupSnapshot(snapshot);
    if (this.database.dialect === "sqlite") {
      inspectLegacySetupSqlite(this.database.db, validated);
    } else {
      await inspectLegacySetupPostgres(this.database.db, validated);
    }
  }

  async importLegacySnapshot(snapshot: LegacySetupMigrationSnapshot): Promise<void> {
    const validated = validateLegacySetupSnapshot(snapshot);
    if (validated.approvals.length === 0 && validated.attemptSets.length === 0) return;
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) => {
        const pending = inspectLegacySetupSqlite(transaction, validated);
        if (pending.approvals.length > 0) {
          transaction.insert(sqlite.setupApprovals).values(pending.approvals).run();
        }
        if (pending.attemptSets.length > 0) {
          transaction.insert(sqlite.setupAttemptSets).values(pending.attemptSets).run();
        }
      });
      return;
    }
    await this.database.db.transaction(async (transaction) => {
      for (const approval of validated.approvals) {
        await lockPostgresKey(transaction, SETUP_APPROVALS_NAMESPACE, approvalKey(approval));
      }
      for (const attempts of validated.attemptSets) {
        await lockPostgresKey(
          transaction,
          SETUP_ATTEMPTS_NAMESPACE,
          attemptsKey(attempts.projectFingerprint, attempts.capletId),
        );
      }
      const pending = await inspectLegacySetupPostgres(transaction, validated);
      if (pending.approvals.length > 0) {
        await transaction.insert(postgres.setupApprovals).values(pending.approvals);
      }
      if (pending.attemptSets.length > 0) {
        await transaction.insert(postgres.setupAttemptSets).values(pending.attemptSets);
      }
    });
  }
  importLegacySnapshotInTransaction(
    snapshot: LegacySetupMigrationSnapshot,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const validated = validateLegacySetupSnapshot(snapshot);
    if (validated.approvals.length === 0 && validated.attemptSets.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importLegacySetupSqlite(transaction.db, validated)
      : importLegacySetupPostgres(transaction.db, validated);
  }

  async verifyLegacySnapshot(snapshot: LegacySetupMigrationSnapshot): Promise<void> {
    const validated = validateLegacySetupSnapshot(snapshot);
    const pending =
      this.database.dialect === "sqlite"
        ? inspectLegacySetupSqlite(this.database.db, validated)
        : await inspectLegacySetupPostgres(this.database.db, validated);
    if (pending.approvals.length > 0 || pending.attemptSets.length > 0) {
      throw new CapletsError("INTERNAL_ERROR", "Setup state failed post-migration verification.");
    }
  }
  verifyLegacySnapshotInTransaction(
    snapshot: LegacySetupMigrationSnapshot,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const validated = validateLegacySetupSnapshot(snapshot);
    if (transaction.dialect === "sqlite") {
      verifyLegacySetupPending(inspectLegacySetupSqlite(transaction.db, validated));
      return;
    }
    return inspectLegacySetupPostgres(transaction.db, validated).then(verifyLegacySetupPending);
  }

  retention(): { maxAttempts: number; days: number } {
    return { maxAttempts: this.maxAttempts, days: this.retentionDays };
  }

  private prunedAttempts(attempts: SetupAttempt[]): SetupAttempt[] {
    const cutoffMs = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    return attempts
      .filter((attempt) => new Date(attempt.finishedAt).getTime() >= cutoffMs)
      .slice(-this.maxAttempts);
  }
}

type LegacySetupAttemptSet = {
  projectFingerprint: string;
  capletId: string;
  attempts: SetupAttempt[];
};

type ValidatedLegacySetupSnapshot = {
  approvals: SetupApproval[];
  attemptSets: LegacySetupAttemptSet[];
};

type LegacySetupApprovalRow = {
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  generation: number;
  payload: SetupApproval;
  approvedAt: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
};

type LegacySetupAttemptSetRow = {
  projectFingerprint: string;
  capletId: string;
  generation: number;
  payload: SetupAttemptsPayload;
  createdAt: string;
  updatedAt: string;
};

type LegacySetupPendingRows = {
  approvals: LegacySetupApprovalRow[];
  attemptSets: LegacySetupAttemptSetRow[];
};

type SqliteSetupDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresSetupDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];
function importLegacySetupSqlite(
  database: SqliteSetupDatabase,
  snapshot: ValidatedLegacySetupSnapshot,
): void {
  const pending = inspectLegacySetupSqlite(database, snapshot);
  if (pending.approvals.length > 0) {
    database.insert(sqlite.setupApprovals).values(pending.approvals).run();
  }
  if (pending.attemptSets.length > 0) {
    database.insert(sqlite.setupAttemptSets).values(pending.attemptSets).run();
  }
}

async function importLegacySetupPostgres(
  database: PostgresSetupDatabase,
  snapshot: ValidatedLegacySetupSnapshot,
): Promise<void> {
  for (const approval of snapshot.approvals) {
    await lockPostgresKey(database, SETUP_APPROVALS_NAMESPACE, approvalKey(approval));
  }
  for (const attempts of snapshot.attemptSets) {
    await lockPostgresKey(
      database,
      SETUP_ATTEMPTS_NAMESPACE,
      attemptsKey(attempts.projectFingerprint, attempts.capletId),
    );
  }
  const pending = await inspectLegacySetupPostgres(database, snapshot);
  if (pending.approvals.length > 0) {
    await database.insert(postgres.setupApprovals).values(pending.approvals);
  }
  if (pending.attemptSets.length > 0) {
    await database.insert(postgres.setupAttemptSets).values(pending.attemptSets);
  }
}

function verifyLegacySetupPending(pending: {
  approvals: LegacySetupApprovalRow[];
  attemptSets: LegacySetupAttemptSetRow[];
}): void {
  if (pending.approvals.length > 0 || pending.attemptSets.length > 0) {
    throw new CapletsError("INTERNAL_ERROR", "Setup state failed post-migration verification.");
  }
}

function validateLegacySetupSnapshot(
  snapshot: LegacySetupMigrationSnapshot,
): ValidatedLegacySetupSnapshot {
  const approvalIdentities = new Set<string>();
  const approvals = snapshot.approvals.map((input) => {
    const approval = parseSetupApproval(input);
    const identity = approvalKey(approval);
    if (
      approvalIdentities.has(identity) ||
      !Number.isFinite(Date.parse(approval.approvedAt)) ||
      new Date(approval.approvedAt).toISOString() !== approval.approvedAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "Legacy setup approvals are invalid.");
    }
    approvalIdentities.add(identity);
    return approval;
  });
  const grouped = new Map<string, LegacySetupAttemptSet>();
  const attemptIdentities = new Set<string>();
  for (const input of snapshot.attempts) {
    const attempt = parseSetupAttempt(input);
    const identity = JSON.stringify([
      attempt.projectFingerprint,
      attempt.capletId,
      attempt.attemptId,
    ]);
    if (
      attemptIdentities.has(identity) ||
      !Number.isFinite(Date.parse(attempt.startedAt)) ||
      !Number.isFinite(Date.parse(attempt.finishedAt)) ||
      new Date(attempt.startedAt).toISOString() !== attempt.startedAt ||
      new Date(attempt.finishedAt).toISOString() !== attempt.finishedAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "Legacy setup attempts are invalid.");
    }
    attemptIdentities.add(identity);
    const key = attemptsKey(attempt.projectFingerprint, attempt.capletId);
    const set = grouped.get(key) ?? {
      projectFingerprint: attempt.projectFingerprint,
      capletId: attempt.capletId,
      attempts: [],
    };
    set.attempts.push(attempt);
    grouped.set(key, set);
  }
  return {
    approvals: approvals.sort((left, right) => approvalKey(left).localeCompare(approvalKey(right))),
    attemptSets: [...grouped.values()].sort((left, right) =>
      attemptsKey(left.projectFingerprint, left.capletId).localeCompare(
        attemptsKey(right.projectFingerprint, right.capletId),
      ),
    ),
  };
}

function inspectLegacySetupSqlite(
  database: SqliteSetupDatabase,
  snapshot: ValidatedLegacySetupSnapshot,
): LegacySetupPendingRows {
  const pending: LegacySetupPendingRows = { approvals: [], attemptSets: [] };
  for (const approval of snapshot.approvals) {
    const existing = database
      .select({ payload: sqlite.setupApprovals.payload })
      .from(sqlite.setupApprovals)
      .where(sqliteApprovalWhere(approval))
      .get();
    if (
      existing &&
      stableJsonStringify(parseSetupApproval(existing.payload)) !== stableJsonStringify(approval)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Setup approval for ${approval.capletId} conflicts with the legacy snapshot.`,
      );
    }
    if (!existing) pending.approvals.push(legacySetupApprovalRow(approval));
  }
  for (const set of snapshot.attemptSets) {
    const existing = database
      .select({ payload: sqlite.setupAttemptSets.payload })
      .from(sqlite.setupAttemptSets)
      .where(
        and(
          eq(sqlite.setupAttemptSets.projectFingerprint, set.projectFingerprint),
          eq(sqlite.setupAttemptSets.capletId, set.capletId),
        ),
      )
      .get();
    if (
      existing &&
      stableJsonStringify(parseAttemptsPayload(existing.payload).attempts) !==
        stableJsonStringify(set.attempts)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Setup attempts for ${set.capletId} conflict with the legacy snapshot.`,
      );
    }
    if (!existing) pending.attemptSets.push(legacySetupAttemptSetRow(set));
  }
  return pending;
}

async function inspectLegacySetupPostgres(
  database: PostgresSetupDatabase,
  snapshot: ValidatedLegacySetupSnapshot,
): Promise<LegacySetupPendingRows> {
  const pending: LegacySetupPendingRows = { approvals: [], attemptSets: [] };
  for (const approval of snapshot.approvals) {
    const [existing] = await database
      .select({ payload: postgres.setupApprovals.payload })
      .from(postgres.setupApprovals)
      .where(postgresApprovalWhere(approval))
      .limit(1);
    if (
      existing &&
      stableJsonStringify(parseSetupApproval(existing.payload)) !== stableJsonStringify(approval)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Setup approval for ${approval.capletId} conflicts with the legacy snapshot.`,
      );
    }
    if (!existing) pending.approvals.push(legacySetupApprovalRow(approval));
  }
  for (const set of snapshot.attemptSets) {
    const [existing] = await database
      .select({ payload: postgres.setupAttemptSets.payload })
      .from(postgres.setupAttemptSets)
      .where(
        and(
          eq(postgres.setupAttemptSets.projectFingerprint, set.projectFingerprint),
          eq(postgres.setupAttemptSets.capletId, set.capletId),
        ),
      )
      .limit(1);
    if (
      existing &&
      stableJsonStringify(parseAttemptsPayload(existing.payload).attempts) !==
        stableJsonStringify(set.attempts)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Setup attempts for ${set.capletId} conflict with the legacy snapshot.`,
      );
    }
    if (!existing) pending.attemptSets.push(legacySetupAttemptSetRow(set));
  }
  return pending;
}

function legacySetupApprovalRow(approval: SetupApproval): LegacySetupApprovalRow {
  return {
    projectFingerprint: approval.projectFingerprint,
    capletId: approval.capletId,
    contentHash: approval.contentHash,
    targetKind: approval.targetKind,
    generation: 1,
    payload: approval,
    approvedAt: approval.approvedAt,
    actor: approval.actor,
    createdAt: approval.approvedAt,
    updatedAt: approval.approvedAt,
  };
}

function legacySetupAttemptSetRow(set: LegacySetupAttemptSet): LegacySetupAttemptSetRow {
  const createdAt = set.attempts
    .map((attempt) => attempt.startedAt)
    .sort((left, right) => left.localeCompare(right))[0] as string;
  const updatedAt = set.attempts
    .map((attempt) => attempt.finishedAt)
    .sort((left, right) => right.localeCompare(left))[0] as string;
  return {
    projectFingerprint: set.projectFingerprint,
    capletId: set.capletId,
    generation: 1,
    payload: { attempts: set.attempts },
    createdAt,
    updatedAt,
  };
}

type ApprovalIdentity = {
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
};

function approvalIdentity(
  args: [string, string, SetupTargetKind] | [string, string, string, SetupTargetKind],
): ApprovalIdentity {
  const [projectFingerprint, capletId, contentHash, targetKind] =
    args.length === 3 ? [DEFAULT_PROJECT_FINGERPRINT, args[0], args[1], args[2]] : args;
  return { projectFingerprint, capletId, contentHash, targetKind };
}

function sqliteApprovalWhere(identity: ApprovalIdentity) {
  return and(
    eq(sqlite.setupApprovals.projectFingerprint, identity.projectFingerprint),
    eq(sqlite.setupApprovals.capletId, identity.capletId),
    eq(sqlite.setupApprovals.contentHash, identity.contentHash),
    eq(sqlite.setupApprovals.targetKind, identity.targetKind),
  );
}

function postgresApprovalWhere(identity: ApprovalIdentity) {
  return and(
    eq(postgres.setupApprovals.projectFingerprint, identity.projectFingerprint),
    eq(postgres.setupApprovals.capletId, identity.capletId),
    eq(postgres.setupApprovals.contentHash, identity.contentHash),
    eq(postgres.setupApprovals.targetKind, identity.targetKind),
  );
}

function mutateApprovalSqlite(
  db: SqliteHostDatabase,
  approval: SetupApproval,
  options: SetupStateMutationOptions,
  timestamp: string,
): void {
  db.transaction((transaction) => {
    const current = transaction
      .select({ generation: sqlite.setupApprovals.generation })
      .from(sqlite.setupApprovals)
      .where(sqliteApprovalWhere(approval))
      .get();
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    transaction
      .insert(sqlite.setupApprovals)
      .values({
        ...approval,
        generation: (current?.generation ?? 0) + 1,
        payload: approval,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          sqlite.setupApprovals.projectFingerprint,
          sqlite.setupApprovals.capletId,
          sqlite.setupApprovals.contentHash,
          sqlite.setupApprovals.targetKind,
        ],
        set: {
          generation: (current?.generation ?? 0) + 1,
          payload: approval,
          approvedAt: approval.approvedAt,
          actor: approval.actor,
          updatedAt: timestamp,
        },
      })
      .run();
    insertSqliteActivity(
      transaction,
      options,
      "setup.approve",
      "setup_approval",
      approvalKey(approval),
      timestamp,
      {
        projectFingerprint: approval.projectFingerprint,
        capletId: approval.capletId,
        contentHash: approval.contentHash,
        targetKind: approval.targetKind,
      },
    );
  });
}

async function mutateApprovalPostgres(
  db: PostgresHostDatabase,
  approval: SetupApproval,
  options: SetupStateMutationOptions,
  timestamp: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const key = approvalKey(approval);
    await lockPostgresKey(transaction, "setup-approval", key);
    const [current] = await transaction
      .select({ generation: postgres.setupApprovals.generation })
      .from(postgres.setupApprovals)
      .where(postgresApprovalWhere(approval))
      .for("update")
      .limit(1);
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    await transaction
      .insert(postgres.setupApprovals)
      .values({
        ...approval,
        generation: (current?.generation ?? 0) + 1,
        payload: approval,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          postgres.setupApprovals.projectFingerprint,
          postgres.setupApprovals.capletId,
          postgres.setupApprovals.contentHash,
          postgres.setupApprovals.targetKind,
        ],
        set: {
          generation: (current?.generation ?? 0) + 1,
          payload: approval,
          approvedAt: approval.approvedAt,
          actor: approval.actor,
          updatedAt: timestamp,
        },
      });
    await insertPostgresActivity(
      transaction,
      options,
      "setup.approve",
      "setup_approval",
      key,
      timestamp,
      {
        projectFingerprint: approval.projectFingerprint,
        capletId: approval.capletId,
        contentHash: approval.contentHash,
        targetKind: approval.targetKind,
      },
    );
  });
}

function mutateAttemptsSqlite(
  db: SqliteHostDatabase,
  attempt: SetupAttempt,
  options: SetupStateMutationOptions,
  timestamp: string,
  transition: (payload: unknown | undefined) => SetupAttemptsPayload,
): void {
  db.transaction((transaction) => {
    const current = transaction
      .select({
        generation: sqlite.setupAttemptSets.generation,
        payload: sqlite.setupAttemptSets.payload,
      })
      .from(sqlite.setupAttemptSets)
      .where(
        and(
          eq(sqlite.setupAttemptSets.projectFingerprint, attempt.projectFingerprint),
          eq(sqlite.setupAttemptSets.capletId, attempt.capletId),
        ),
      )
      .get();
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    const payload = transition(current?.payload);
    transaction
      .insert(sqlite.setupAttemptSets)
      .values({
        projectFingerprint: attempt.projectFingerprint,
        capletId: attempt.capletId,
        generation: (current?.generation ?? 0) + 1,
        payload,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [sqlite.setupAttemptSets.projectFingerprint, sqlite.setupAttemptSets.capletId],
        set: {
          generation: (current?.generation ?? 0) + 1,
          payload,
          updatedAt: timestamp,
        },
      })
      .run();
    const key = attemptsKey(attempt.projectFingerprint, attempt.capletId);
    insertSqliteActivity(
      transaction,
      options,
      "setup.attempt.record",
      "setup_attempts",
      key,
      timestamp,
      {
        projectFingerprint: attempt.projectFingerprint,
        capletId: attempt.capletId,
        attemptId: attempt.attemptId,
        status: attempt.status,
      },
    );
  });
}

async function mutateAttemptsPostgres(
  db: PostgresHostDatabase,
  attempt: SetupAttempt,
  options: SetupStateMutationOptions,
  timestamp: string,
  transition: (payload: unknown | undefined) => SetupAttemptsPayload,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const key = attemptsKey(attempt.projectFingerprint, attempt.capletId);
    await lockPostgresKey(transaction, "setup-attempts", key);
    const [current] = await transaction
      .select({
        generation: postgres.setupAttemptSets.generation,
        payload: postgres.setupAttemptSets.payload,
      })
      .from(postgres.setupAttemptSets)
      .where(
        and(
          eq(postgres.setupAttemptSets.projectFingerprint, attempt.projectFingerprint),
          eq(postgres.setupAttemptSets.capletId, attempt.capletId),
        ),
      )
      .for("update")
      .limit(1);
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    const payload = transition(current?.payload);
    await transaction
      .insert(postgres.setupAttemptSets)
      .values({
        projectFingerprint: attempt.projectFingerprint,
        capletId: attempt.capletId,
        generation: (current?.generation ?? 0) + 1,
        payload,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [postgres.setupAttemptSets.projectFingerprint, postgres.setupAttemptSets.capletId],
        set: {
          generation: (current?.generation ?? 0) + 1,
          payload,
          updatedAt: timestamp,
        },
      });
    await insertPostgresActivity(
      transaction,
      options,
      "setup.attempt.record",
      "setup_attempts",
      key,
      timestamp,
      {
        projectFingerprint: attempt.projectFingerprint,
        capletId: attempt.capletId,
        attemptId: attempt.attemptId,
        status: attempt.status,
      },
    );
  });
}

function clearAttemptsSqlite(
  db: SqliteHostDatabase,
  projectFingerprint: string,
  capletId: string,
  options: SetupStateMutationOptions,
  timestamp: string,
): boolean {
  return db.transaction((transaction) => {
    const where = and(
      eq(sqlite.setupAttemptSets.projectFingerprint, projectFingerprint),
      eq(sqlite.setupAttemptSets.capletId, capletId),
    );
    const current = transaction
      .select({ generation: sqlite.setupAttemptSets.generation })
      .from(sqlite.setupAttemptSets)
      .where(where)
      .get();
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    if (!current) return false;
    transaction.delete(sqlite.setupAttemptSets).where(where).run();
    const key = attemptsKey(projectFingerprint, capletId);
    insertSqliteActivity(
      transaction,
      options,
      "setup.attempt.clear",
      "setup_attempts",
      key,
      timestamp,
      {
        projectFingerprint,
        capletId,
      },
    );
    return true;
  });
}

async function clearAttemptsPostgres(
  db: PostgresHostDatabase,
  projectFingerprint: string,
  capletId: string,
  options: SetupStateMutationOptions,
  timestamp: string,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const key = attemptsKey(projectFingerprint, capletId);
    await lockPostgresKey(transaction, "setup-attempts", key);
    const where = and(
      eq(postgres.setupAttemptSets.projectFingerprint, projectFingerprint),
      eq(postgres.setupAttemptSets.capletId, capletId),
    );
    const [current] = await transaction
      .select({ generation: postgres.setupAttemptSets.generation })
      .from(postgres.setupAttemptSets)
      .where(where)
      .for("update")
      .limit(1);
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    if (!current) return false;
    await transaction.delete(postgres.setupAttemptSets).where(where);
    await insertPostgresActivity(
      transaction,
      options,
      "setup.attempt.clear",
      "setup_attempts",
      key,
      timestamp,
      {
        projectFingerprint,
        capletId,
      },
    );
    return true;
  });
}

function parseAttemptsPayload(value: unknown): SetupAttemptsPayload {
  if (!isRecord(value) || !Array.isArray(value.attempts)) {
    throw new CapletsError("INTERNAL_ERROR", "Persisted setup attempt list is invalid.");
  }
  return { attempts: value.attempts.map(parseSetupAttempt) };
}

function assertExpectedGeneration(
  currentGeneration: number | undefined,
  expectedGeneration: number | undefined,
): void {
  if (expectedGeneration === undefined || currentGeneration === expectedGeneration) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Authoritative Setup State changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedGeneration,
      currentGeneration: currentGeneration ?? 0,
    },
  );
}

function approvalKey(identity: ApprovalIdentity): string {
  return JSON.stringify([
    identity.projectFingerprint,
    identity.capletId,
    identity.contentHash,
    identity.targetKind,
  ]);
}

function attemptsKey(projectFingerprint: string, capletId: string): string {
  return JSON.stringify([projectFingerprint, capletId]);
}

function activityValues(
  operatorClientId: string,
  action: string,
  targetKind: string,
  targetKey: string,
  timestamp: string,
  metadata: Record<string, unknown>,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind,
    targetKey,
    outcome: "succeeded",
    metadata,
    createdAt: timestamp,
  };
}

function insertSqliteActivity(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  options: SetupStateMutationOptions,
  action: string,
  targetKind: string,
  targetKey: string,
  timestamp: string,
  metadata: Record<string, unknown>,
): void {
  const operatorClientId = options.operatorClientId?.trim();
  if (!operatorClientId) return;
  transaction
    .insert(sqlite.operatorActivity)
    .values(activityValues(operatorClientId, action, targetKind, targetKey, timestamp, metadata))
    .run();
}

async function insertPostgresActivity(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  options: SetupStateMutationOptions,
  action: string,
  targetKind: string,
  targetKey: string,
  timestamp: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const operatorClientId = options.operatorClientId?.trim();
  if (!operatorClientId) return;
  await transaction
    .insert(postgres.operatorActivity)
    .values(activityValues(operatorClientId, action, targetKind, targetKey, timestamp, metadata));
}

async function lockPostgresKey(
  transaction: PostgresSetupDatabase,
  namespace: string,
  key: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([namespace, key])}, 0))`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
