import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import { storagePageLimit, type KeysetSortDirection, type StorageKeysetPage } from "./keyset-page";
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  SqliteHostDatabase,
} from "./types";

export type OperatorActivityOutcome = "success" | "failure";

export const OPERATOR_ACTIVITY_ACTION_MAX_LENGTH = 128;
export const OPERATOR_ACTIVITY_ACTION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;

export type OperatorActivityMetadata = Record<string, string | number | boolean | null>;

export type OperatorActivityTarget = {
  type: string;
  id: string;
  label?: string | undefined;
};

export type OperatorActivityEntry = {
  id: string;
  createdAt: string;
  actorClientId: string;
  action: string;
  outcome: OperatorActivityOutcome;
  target: OperatorActivityTarget;
  metadata?: OperatorActivityMetadata | undefined;
};

export type AppendOperatorActivityInput = {
  actorClientId: string;
  action: string;
  outcome?: OperatorActivityOutcome | undefined;
  target: OperatorActivityTarget;
  metadata?: OperatorActivityMetadata | undefined;
  now?: Date | undefined;
};

export type ListOperatorActivityInput = {
  limit?: number | undefined;
  after?: string | undefined;
  action?: string | undefined;
};

export type OperatorActivityPageKey = {
  createdAt: string;
  activityKey: string;
};

export type ListOperatorActivityPageInput = {
  limit?: number | undefined;
  after?: OperatorActivityPageKey | undefined;
  sort?: KeysetSortDirection | undefined;
  action?: string | undefined;
};

export type OperatorActivityPage = {
  entries: OperatorActivityEntry[];
  nextCursor?: string | undefined;
};

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;
const TARGET_LABEL_METADATA_KEY = "__capletsTargetLabel";

type ActivityRow = {
  activityKey: string;
  operatorClientId: string;
  action: string;
  targetKind: string;
  targetKey: string;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ActivityCursor = OperatorActivityPageKey;

/**
 * SQL-authoritative Operator activity with a dashboard-compatible projection.
 * Metadata is sanitized on append and again on read so unsafe fields are never exposed.
 */
export class OperatorActivityStore {
  constructor(private readonly database: HostDatabase) {}

  async append(input: AppendOperatorActivityInput): Promise<OperatorActivityEntry> {
    validateAppendInput(input);
    const metadata = sanitizeMetadata(input.metadata ?? {});
    if (input.target.label !== undefined) metadata[TARGET_LABEL_METADATA_KEY] = input.target.label;
    const row: ActivityRow = {
      activityKey: randomUUID(),
      operatorClientId: input.actorClientId,
      action: input.action,
      targetKind: input.target.type,
      targetKey: input.target.id,
      outcome: input.outcome === "failure" ? "failed" : "succeeded",
      metadata,
      createdAt: (input.now ?? new Date()).toISOString(),
    };

    if (this.database.dialect === "sqlite") {
      this.database.db.insert(sqlite.operatorActivity).values(row).run();
    } else {
      await this.database.db.insert(postgres.operatorActivity).values(row);
    }
    return activityEntry(row);
  }

  async assertLegacyEntriesImportable(entries: OperatorActivityEntry[]): Promise<void> {
    const rows = validateLegacyActivityEntries(entries);
    if (this.database.dialect === "sqlite") {
      inspectLegacyActivitySqlite(this.database.db, rows);
    } else {
      await inspectLegacyActivityPostgres(this.database.db, rows);
    }
  }

  async importLegacyEntries(entries: OperatorActivityEntry[]): Promise<void> {
    const rows = validateLegacyActivityEntries(entries);
    if (rows.length === 0) return;
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) => {
        const pending = inspectLegacyActivitySqlite(transaction, rows);
        if (pending.length > 0) {
          transaction.insert(sqlite.operatorActivity).values(pending).run();
        }
      });
      return;
    }
    await this.database.db.transaction(async (transaction) => {
      const pending = await inspectLegacyActivityPostgres(transaction, rows);
      if (pending.length > 0) {
        await transaction.insert(postgres.operatorActivity).values(pending);
      }
    });
  }
  importLegacyEntriesInTransaction(
    entries: OperatorActivityEntry[],
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const rows = validateLegacyActivityEntries(entries);
    if (rows.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importLegacyActivitySqlite(transaction.db, rows)
      : importLegacyActivityPostgres(transaction.db, rows);
  }

  async verifyLegacyEntries(entries: OperatorActivityEntry[]): Promise<void> {
    const rows = validateLegacyActivityEntries(entries);
    const pending =
      this.database.dialect === "sqlite"
        ? inspectLegacyActivitySqlite(this.database.db, rows)
        : await inspectLegacyActivityPostgres(this.database.db, rows);
    if (pending.length > 0) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Operator Activity failed post-migration verification.",
      );
    }
  }
  verifyLegacyEntriesInTransaction(
    entries: OperatorActivityEntry[],
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const rows = validateLegacyActivityEntries(entries);
    if (transaction.dialect === "sqlite") {
      verifyLegacyActivityPending(inspectLegacyActivitySqlite(transaction.db, rows));
      return;
    }
    return inspectLegacyActivityPostgres(transaction.db, rows).then(verifyLegacyActivityPending);
  }

  async listPage(
    input: ListOperatorActivityPageInput = {},
  ): Promise<StorageKeysetPage<OperatorActivityEntry, OperatorActivityPageKey>> {
    const limit = storagePageLimit(input.limit);
    const sort = input.sort ?? "desc";
    if (input.after !== undefined) validateActivityPageKey(input.after);
    const rows =
      this.database.dialect === "sqlite"
        ? this.listSqlite(limit + 1, input.after, input.action, sort)
        : await this.listPostgres(limit + 1, input.after, input.action, sort);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(activityEntry);
    if (!hasMore) return { items };
    const last = pageRows[pageRows.length - 1]!;
    return {
      items,
      nextKey: {
        createdAt: last.createdAt,
        activityKey: last.activityKey,
      },
    };
  }

  async list(input: ListOperatorActivityInput = {}): Promise<OperatorActivityPage> {
    const limit = boundedLimit(input.limit);
    const after = input.after ? await this.findCursor(input.after) : undefined;
    const page = await this.listPage({ limit, after, action: input.action });
    return {
      entries: page.items,
      ...(page.nextKey ? { nextCursor: page.nextKey.activityKey } : {}),
    };
  }

  private async findCursor(activityKey: string): Promise<ActivityCursor | undefined> {
    if (this.database.dialect === "sqlite") {
      return this.database.db
        .select({
          activityKey: sqlite.operatorActivity.activityKey,
          createdAt: sqlite.operatorActivity.createdAt,
        })
        .from(sqlite.operatorActivity)
        .where(eq(sqlite.operatorActivity.activityKey, activityKey))
        .get();
    }
    const [cursor] = await this.database.db
      .select({
        activityKey: postgres.operatorActivity.activityKey,
        createdAt: postgres.operatorActivity.createdAt,
      })
      .from(postgres.operatorActivity)
      .where(eq(postgres.operatorActivity.activityKey, activityKey))
      .limit(1);
    return cursor;
  }

  private listSqlite(
    limit: number,
    cursor: ActivityCursor | undefined,
    action: string | undefined,
    sort: KeysetSortDirection,
  ): ActivityRow[] {
    const conditions: SQL[] = [];
    if (action !== undefined) conditions.push(eq(sqlite.operatorActivity.action, action));
    if (cursor) {
      conditions.push(
        sort === "asc"
          ? or(
              gt(sqlite.operatorActivity.createdAt, cursor.createdAt),
              and(
                eq(sqlite.operatorActivity.createdAt, cursor.createdAt),
                gt(sqlite.operatorActivity.activityKey, cursor.activityKey),
              ),
            )!
          : or(
              lt(sqlite.operatorActivity.createdAt, cursor.createdAt),
              and(
                eq(sqlite.operatorActivity.createdAt, cursor.createdAt),
                lt(sqlite.operatorActivity.activityKey, cursor.activityKey),
              ),
            )!,
      );
    }
    return this.database.dialect === "sqlite"
      ? this.database.db
          .select()
          .from(sqlite.operatorActivity)
          .where(and(...conditions))
          .orderBy(
            sort === "asc"
              ? asc(sqlite.operatorActivity.createdAt)
              : desc(sqlite.operatorActivity.createdAt),
            sort === "asc"
              ? asc(sqlite.operatorActivity.activityKey)
              : desc(sqlite.operatorActivity.activityKey),
          )
          .limit(limit)
          .all()
      : [];
  }

  private async listPostgres(
    limit: number,
    cursor: ActivityCursor | undefined,
    action: string | undefined,
    sort: KeysetSortDirection,
  ): Promise<ActivityRow[]> {
    const conditions: SQL[] = [];
    if (action !== undefined) conditions.push(eq(postgres.operatorActivity.action, action));
    if (cursor) {
      conditions.push(
        sort === "asc"
          ? or(
              gt(postgres.operatorActivity.createdAt, cursor.createdAt),
              and(
                eq(postgres.operatorActivity.createdAt, cursor.createdAt),
                gt(postgres.operatorActivity.activityKey, cursor.activityKey),
              ),
            )!
          : or(
              lt(postgres.operatorActivity.createdAt, cursor.createdAt),
              and(
                eq(postgres.operatorActivity.createdAt, cursor.createdAt),
                lt(postgres.operatorActivity.activityKey, cursor.activityKey),
              ),
            )!,
      );
    }
    return this.database.dialect === "postgres"
      ? await this.database.db
          .select()
          .from(postgres.operatorActivity)
          .where(and(...conditions))
          .orderBy(
            sort === "asc"
              ? asc(postgres.operatorActivity.createdAt)
              : desc(postgres.operatorActivity.createdAt),
            sort === "asc"
              ? asc(postgres.operatorActivity.activityKey)
              : desc(postgres.operatorActivity.activityKey),
          )
          .limit(limit)
      : [];
  }
}

type SqliteActivityDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresActivityDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];
function importLegacyActivitySqlite(database: SqliteActivityDatabase, rows: ActivityRow[]): void {
  const pending = inspectLegacyActivitySqlite(database, rows);
  if (pending.length > 0) database.insert(sqlite.operatorActivity).values(pending).run();
}

async function importLegacyActivityPostgres(
  database: PostgresActivityDatabase,
  rows: ActivityRow[],
): Promise<void> {
  const pending = await inspectLegacyActivityPostgres(database, rows);
  if (pending.length > 0) await database.insert(postgres.operatorActivity).values(pending);
}

function verifyLegacyActivityPending(pending: ActivityRow[]): void {
  if (pending.length > 0) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Operator Activity failed post-migration verification.",
    );
  }
}

function validateLegacyActivityEntries(entries: OperatorActivityEntry[]): ActivityRow[] {
  const ids = new Set<string>();
  return entries.map((entry) => {
    validateAppendInput(entry);
    if (
      !entry.id ||
      ids.has(entry.id) ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      new Date(entry.createdAt).toISOString() !== entry.createdAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "Legacy Operator Activity is invalid.");
    }
    ids.add(entry.id);
    const row = legacyActivityRow(entry);
    if (stableJsonStringify(activityEntry(row)) !== stableJsonStringify(entry)) {
      throw new CapletsError("CONFIG_INVALID", "Legacy Operator Activity is invalid.");
    }
    return row;
  });
}

function legacyActivityRow(entry: OperatorActivityEntry): ActivityRow {
  const metadata = sanitizeMetadata(entry.metadata ?? {});
  if (entry.target.label !== undefined) metadata[TARGET_LABEL_METADATA_KEY] = entry.target.label;
  return {
    activityKey: entry.id,
    operatorClientId: entry.actorClientId,
    action: entry.action,
    targetKind: entry.target.type,
    targetKey: entry.target.id,
    outcome: entry.outcome === "failure" ? "failed" : "succeeded",
    metadata,
    createdAt: entry.createdAt,
  };
}

function inspectLegacyActivitySqlite(
  database: SqliteActivityDatabase,
  rows: ActivityRow[],
): ActivityRow[] {
  return rows.filter((row) => {
    const existing = database
      .select()
      .from(sqlite.operatorActivity)
      .where(eq(sqlite.operatorActivity.activityKey, row.activityKey))
      .get();
    if (
      existing &&
      stableJsonStringify(activityEntry(existing)) !== stableJsonStringify(activityEntry(row))
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        "Operator Activity conflicts with the legacy snapshot.",
      );
    }
    return existing === undefined;
  });
}

async function inspectLegacyActivityPostgres(
  database: PostgresActivityDatabase,
  rows: ActivityRow[],
): Promise<ActivityRow[]> {
  const pending: ActivityRow[] = [];
  for (const row of rows) {
    const [existing] = await database
      .select()
      .from(postgres.operatorActivity)
      .where(eq(postgres.operatorActivity.activityKey, row.activityKey))
      .limit(1);
    if (
      existing &&
      stableJsonStringify(activityEntry(existing)) !== stableJsonStringify(activityEntry(row))
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        "Operator Activity conflicts with the legacy snapshot.",
      );
    }
    if (!existing) pending.push(row);
  }
  return pending;
}

function activityEntry(row: ActivityRow): OperatorActivityEntry {
  if (
    typeof row.activityKey !== "string" ||
    typeof row.operatorClientId !== "string" ||
    typeof row.action !== "string" ||
    typeof row.targetKind !== "string" ||
    typeof row.targetKey !== "string" ||
    typeof row.createdAt !== "string" ||
    !row.metadata ||
    typeof row.metadata !== "object" ||
    Array.isArray(row.metadata)
  ) {
    throw new Error("Invalid SQL Operator activity entry.");
  }
  const outcome = dashboardOutcome(row.outcome);
  const targetLabel = row.metadata[TARGET_LABEL_METADATA_KEY];
  if (targetLabel !== undefined && typeof targetLabel !== "string") {
    throw new Error("Invalid SQL Operator activity entry.");
  }
  const metadata = sanitizeMetadata(row.metadata);
  delete metadata[TARGET_LABEL_METADATA_KEY];
  return {
    id: row.activityKey,
    createdAt: row.createdAt,
    actorClientId: row.operatorClientId,
    action: row.action,
    outcome,
    target: {
      type: row.targetKind,
      id: row.targetKey,
      ...(targetLabel !== undefined ? { label: targetLabel } : {}),
    },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function dashboardOutcome(outcome: string): OperatorActivityOutcome {
  if (outcome === "success" || outcome === "succeeded") return "success";
  if (outcome === "failure" || outcome === "failed") return "failure";
  throw new Error("Invalid SQL Operator activity outcome.");
}

function validateAppendInput(input: AppendOperatorActivityInput): void {
  if (
    typeof input.actorClientId !== "string" ||
    typeof input.action !== "string" ||
    !OPERATOR_ACTIVITY_ACTION_PATTERN.test(input.action) ||
    input.action.length > OPERATOR_ACTIVITY_ACTION_MAX_LENGTH ||
    !input.target ||
    typeof input.target.type !== "string" ||
    typeof input.target.id !== "string" ||
    (input.target.label !== undefined && typeof input.target.label !== "string") ||
    (input.outcome !== undefined && input.outcome !== "success" && input.outcome !== "failure")
  ) {
    throw new Error("Invalid Operator activity input.");
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>): OperatorActivityMetadata {
  const safe: OperatorActivityMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!isMetadataValue(value)) throw new Error("Invalid Operator activity metadata.");
    if (
      key === TARGET_LABEL_METADATA_KEY ||
      /(secret|token|credential|bearer|refresh|value|payload|argument|output|path)/iu.test(key) ||
      (typeof value === "string" &&
        (value.length > 256 ||
          /(cap_remote_access_|cap_remote_refresh_|cap_pending_|cap_login_)/u.test(value)))
    ) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function isMetadataValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function validateActivityPageKey(value: unknown): asserts value is OperatorActivityPageKey {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("createdAt" in value) ||
    !("activityKey" in value) ||
    typeof value.createdAt !== "string" ||
    typeof value.activityKey !== "string" ||
    !value.activityKey
  ) {
    throw new CapletsError("REQUEST_INVALID", "Operator Activity page key is invalid.");
  }
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
    throw new CapletsError("REQUEST_INVALID", "Operator Activity page key is invalid.");
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Math.trunc(limit)));
}
