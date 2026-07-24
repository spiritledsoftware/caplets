import { randomUUID } from "node:crypto";
import { eq, lt, lte, ne, or } from "drizzle-orm";
import { DASHBOARD_SESSION_IDLE_TIMEOUT_MS, type DashboardSessionRecord } from "../dashboard/types";
import { CapletsError } from "../errors";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

type DeleteOptions = {
  expectedSecretHash?: string | undefined;
  operatorInitiated?: boolean | undefined;
};

export class DashboardSessionRepository {
  constructor(private readonly database: HostDatabase) {}

  async create(session: DashboardSessionRecord): Promise<boolean> {
    const persisted = parseDashboardSessionRecord(session);
    if (!persisted) {
      throw new CapletsError("REQUEST_INVALID", "Dashboard session record is invalid.");
    }
    return this.database.dialect === "sqlite"
      ? await createSqlite(this.database.db, persisted)
      : await createPostgres(this.database.db, persisted);
  }

  async get(sessionId: string): Promise<DashboardSessionRecord | undefined> {
    const row =
      this.database.dialect === "sqlite"
        ? await this.database.db
            .select()
            .from(sqlite.dashboardSessions)
            .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.dashboardSessions)
              .where(eq(postgres.dashboardSessions.sessionId, sessionId))
              .limit(1)
          )[0];
    return parseDashboardSessionRecord(row);
  }

  async touch(
    sessionId: string,
    expectedSecretHash: string,
    now: Date,
  ): Promise<DashboardSessionRecord | undefined> {
    return this.database.dialect === "sqlite"
      ? await touchSqlite(this.database.db, sessionId, expectedSecretHash, now)
      : await touchPostgres(this.database.db, sessionId, expectedSecretHash, now);
  }

  async delete(sessionId: string, options: DeleteOptions = {}): Promise<boolean> {
    return this.database.dialect === "sqlite"
      ? await deleteSqlite(this.database.db, sessionId, options)
      : await deletePostgres(this.database.db, sessionId, options);
  }

  async cleanupExpired(now: Date): Promise<number> {
    const nowText = now.toISOString();
    const idleCutoff = new Date(now.getTime() - DASHBOARD_SESSION_IDLE_TIMEOUT_MS).toISOString();
    return this.database.dialect === "sqlite"
      ? (
          await this.database.db
            .delete(sqlite.dashboardSessions)
            .where(
              or(
                lte(sqlite.dashboardSessions.expiresAt, nowText),
                lt(sqlite.dashboardSessions.lastUsedAt, idleCutoff),
                ne(sqlite.dashboardSessions.role, "operator"),
              ),
            )
            .run()
        ).rowsAffected
      : (
          await this.database.db
            .delete(postgres.dashboardSessions)
            .where(
              or(
                lte(postgres.dashboardSessions.expiresAt, nowText),
                lt(postgres.dashboardSessions.lastUsedAt, idleCutoff),
                ne(postgres.dashboardSessions.role, "operator"),
              ),
            )
            .returning({ sessionId: postgres.dashboardSessions.sessionId })
        ).length;
  }
}

async function createSqlite(
  db: SqliteHostDatabase,
  session: DashboardSessionRecord,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const created =
      (
        await transaction
          .insert(sqlite.dashboardSessions)
          .values(session)
          .onConflictDoNothing()
          .run()
      ).rowsAffected > 0;
    if (created) {
      await transaction
        .insert(sqlite.operatorActivity)
        .values(
          activityValues(session.operatorClientId, "dashboard.session.create", session.sessionId),
        )
        .run();
    }
    return created;
  });
}

async function createPostgres(
  db: PostgresHostDatabase,
  session: DashboardSessionRecord,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const created = await transaction
      .insert(postgres.dashboardSessions)
      .values(session)
      .onConflictDoNothing()
      .returning({ sessionId: postgres.dashboardSessions.sessionId });
    if (created.length > 0) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activityValues(session.operatorClientId, "dashboard.session.create", session.sessionId),
        );
    }
    return created.length > 0;
  });
}

async function touchSqlite(
  db: SqliteHostDatabase,
  sessionId: string,
  expectedSecretHash: string,
  now: Date,
): Promise<DashboardSessionRecord | undefined> {
  return await db.transaction(async (transaction) => {
    const row = await transaction
      .select()
      .from(sqlite.dashboardSessions)
      .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
      .get();
    const session = parseDashboardSessionRecord(row);
    if (!session) {
      if (row) {
        await transaction
          .delete(sqlite.dashboardSessions)
          .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
          .run();
      }
      return undefined;
    }
    if (session.secretHash !== expectedSecretHash) return undefined;
    if (sessionExpired(session, now)) {
      await transaction
        .delete(sqlite.dashboardSessions)
        .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
        .run();
      return undefined;
    }
    const lastUsedAt = now.toISOString();
    await transaction
      .update(sqlite.dashboardSessions)
      .set({ lastUsedAt })
      .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
      .run();
    return { ...session, lastUsedAt };
  });
}

async function touchPostgres(
  db: PostgresHostDatabase,
  sessionId: string,
  expectedSecretHash: string,
  now: Date,
): Promise<DashboardSessionRecord | undefined> {
  return await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(postgres.dashboardSessions)
      .where(eq(postgres.dashboardSessions.sessionId, sessionId))
      .for("update")
      .limit(1);
    const session = parseDashboardSessionRecord(row);
    if (!session) {
      if (row) {
        await transaction
          .delete(postgres.dashboardSessions)
          .where(eq(postgres.dashboardSessions.sessionId, sessionId));
      }
      return undefined;
    }
    if (session.secretHash !== expectedSecretHash) return undefined;
    if (sessionExpired(session, now)) {
      await transaction
        .delete(postgres.dashboardSessions)
        .where(eq(postgres.dashboardSessions.sessionId, sessionId));
      return undefined;
    }
    const lastUsedAt = now.toISOString();
    await transaction
      .update(postgres.dashboardSessions)
      .set({ lastUsedAt })
      .where(eq(postgres.dashboardSessions.sessionId, sessionId));
    return { ...session, lastUsedAt };
  });
}

async function deleteSqlite(
  db: SqliteHostDatabase,
  sessionId: string,
  options: DeleteOptions,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const row = await transaction
      .select()
      .from(sqlite.dashboardSessions)
      .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
      .get();
    if (!row) return false;
    const session = parseDashboardSessionRecord(row);
    if (
      options.expectedSecretHash !== undefined &&
      session?.secretHash !== options.expectedSecretHash
    ) {
      return false;
    }
    await transaction
      .delete(sqlite.dashboardSessions)
      .where(eq(sqlite.dashboardSessions.sessionId, sessionId))
      .run();
    if (options.operatorInitiated && session) {
      await transaction
        .insert(sqlite.operatorActivity)
        .values(activityValues(session.operatorClientId, "dashboard.session.delete", sessionId))
        .run();
    }
    return true;
  });
}

async function deletePostgres(
  db: PostgresHostDatabase,
  sessionId: string,
  options: DeleteOptions,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(postgres.dashboardSessions)
      .where(eq(postgres.dashboardSessions.sessionId, sessionId))
      .for("update")
      .limit(1);
    if (!row) return false;
    const session = parseDashboardSessionRecord(row);
    if (
      options.expectedSecretHash !== undefined &&
      session?.secretHash !== options.expectedSecretHash
    ) {
      return false;
    }
    await transaction
      .delete(postgres.dashboardSessions)
      .where(eq(postgres.dashboardSessions.sessionId, sessionId));
    if (options.operatorInitiated && session) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(activityValues(session.operatorClientId, "dashboard.session.delete", sessionId));
    }
    return true;
  });
}

function parseDashboardSessionRecord(value: unknown): DashboardSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    typeof record.secretHash !== "string" ||
    record.secretHash.length === 0 ||
    typeof record.operatorClientId !== "string" ||
    record.operatorClientId.length === 0 ||
    record.role !== "operator" ||
    typeof record.csrfToken !== "string" ||
    record.csrfToken.length === 0 ||
    !isCanonicalTimestamp(record.createdAt) ||
    !isCanonicalTimestamp(record.expiresAt) ||
    !isCanonicalTimestamp(record.lastUsedAt)
  ) {
    return undefined;
  }
  return {
    sessionId: record.sessionId,
    secretHash: record.secretHash,
    operatorClientId: record.operatorClientId,
    role: "operator",
    csrfToken: record.csrfToken,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function sessionExpired(session: DashboardSessionRecord, now: Date): boolean {
  if (Date.parse(session.expiresAt) <= now.getTime()) return true;
  return now.getTime() - Date.parse(session.lastUsedAt) > 60 * 60_000;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function activityValues(
  operatorClientId: string,
  action: string,
  sessionId: string,
): {
  activityKey: string;
  operatorClientId: string;
  action: string;
  targetKind: string;
  targetKey: string;
  outcome: string;
  metadata: Record<string, never>;
  createdAt: string;
} {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind: "dashboard_session",
    targetKey: sessionId,
    outcome: "succeeded",
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}
