import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { CapletsError } from "../errors";
import { advancePostgresConfigGeneration, advanceSqliteConfigGeneration } from "./coordination";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  PostgresHostTransaction,
  SqliteHostDatabase,
  SqliteHostTransaction,
} from "./types";

export type OperatorPrincipal = {
  clientId: string;
  role: "operator" | "access";
};

export type CapletInstallationView = {
  installationKey: string;
  capletId: string;
  recordKey: string;
  generation: number;
  status: "active" | "detached";
  sourceKind: string;
  sourceIdentity: string;
  channel: string | null;
  createdAt: string;
  updatedAt: string;
  detachedAt: string | null;
  detachedBy: string | null;
};

export type CapletInstallationObservationStatus =
  | "current"
  | "metadata-only"
  | "source-unavailable";

export type CapletInstallationObservationView = {
  observationKey: string;
  installationKey: string;
  resolvedRevision: string | null;
  contentHash: string | null;
  risk: Record<string, unknown> | null;
  status: CapletInstallationObservationStatus;
  observedAt: string;
};

export type OperatorActivityView = {
  activityKey: string;
  operatorClientId: string;
  action: string;
  targetKind: string;
  targetKey: string;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type InstallationSourceInput = {
  capletId: string;
  sourceKind: string;
  sourceIdentity: string;
  channel?: string | undefined;
  operator: OperatorPrincipal;
};

type InstallInput = InstallationSourceInput;

type DetachInput = {
  capletId: string;
  expectedGeneration: number;
  operator: OperatorPrincipal;
};

export type ReplaceDetachedInstallationInput = InstallationSourceInput & {
  expectedGeneration: number;
  detachedInstallationKey?: string | undefined;
};

export type AppendInstallationObservationInput = {
  capletId: string;
  expectedGeneration: number;
  status: CapletInstallationObservationStatus;
  resolvedRevision?: string | null | undefined;
  contentHash?: string | null | undefined;
  risk?: Record<string, unknown> | null | undefined;
  operator: OperatorPrincipal;
};

export class CapletInstallationStore {
  constructor(private readonly database: HostDatabase) {}

  async install(input: InstallInput): Promise<CapletInstallationView> {
    const operatorId = requireOperator(input.operator);
    if (this.database.dialect === "sqlite") installSqlite(this.database.db, input, operatorId);
    else await installPostgres(this.database.db, input, operatorId);
    const installed = await this.getActive(input.capletId);
    if (!installed)
      throw new CapletsError("INTERNAL_ERROR", `Installed Caplet ${input.capletId} was not found.`);
    return installed;
  }

  async replaceDetached(input: ReplaceDetachedInstallationInput): Promise<CapletInstallationView> {
    const operatorId = requireOperator(input.operator);
    if (this.database.dialect === "sqlite")
      replaceDetachedSqlite(this.database.db, input, operatorId);
    else await replaceDetachedPostgres(this.database.db, input, operatorId);
    const installed = await this.getActive(input.capletId);
    if (!installed)
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Replacement installation for ${input.capletId} was not found.`,
      );
    return installed;
  }

  async appendObservation(
    input: AppendInstallationObservationInput,
  ): Promise<CapletInstallationObservationView> {
    const operatorId = requireOperator(input.operator);
    return this.database.dialect === "sqlite"
      ? appendObservationSqlite(this.database.db, input, operatorId)
      : await appendObservationPostgres(this.database.db, input, operatorId);
  }

  async detach(input: DetachInput): Promise<CapletInstallationView | undefined> {
    const operatorId = requireOperator(input.operator);
    if (this.database.dialect === "sqlite") detachSqlite(this.database.db, input, operatorId);
    else await detachPostgres(this.database.db, input, operatorId);
    return await this.getLatest(input.capletId);
  }

  async getActive(capletId: string): Promise<CapletInstallationView | undefined> {
    return this.database.dialect === "sqlite"
      ? getSqlite(this.database.db, capletId, true)
      : await getPostgres(this.database.db, capletId, true);
  }
  getActiveInTransaction(
    capletId: string,
    transaction: HostDatabaseTransaction,
  ): CapletInstallationView | undefined | Promise<CapletInstallationView | undefined> {
    return transaction.dialect === "sqlite"
      ? getSqlite(transaction.db, capletId, true)
      : getPostgres(transaction.db, capletId, true);
  }

  async getLatest(capletId: string): Promise<CapletInstallationView | undefined> {
    return this.database.dialect === "sqlite"
      ? getSqlite(this.database.db, capletId, false)
      : await getPostgres(this.database.db, capletId, false);
  }

  async list(capletId: string): Promise<CapletInstallationView[]> {
    return this.database.dialect === "sqlite"
      ? listSqlite(this.database.db, capletId)
      : await listPostgres(this.database.db, capletId);
  }

  async getLatestObservation(
    capletId: string,
  ): Promise<CapletInstallationObservationView | undefined> {
    const installation = await this.getLatest(capletId);
    if (!installation) return undefined;
    return this.database.dialect === "sqlite"
      ? latestObservationSqlite(this.database.db, installation.installationKey)
      : await latestObservationPostgres(this.database.db, installation.installationKey);
  }

  async listObservations(capletId: string): Promise<CapletInstallationObservationView[]> {
    const installation = await this.getLatest(capletId);
    if (!installation) return [];
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.capletInstallationObservations)
            .where(
              eq(
                sqlite.capletInstallationObservations.installationKey,
                installation.installationKey,
              ),
            )
            .orderBy(
              desc(sqlite.capletInstallationObservations.observedAt),
              desc(sqlite.capletInstallationObservations.observationKey),
            )
            .all()
        : await this.database.db
            .select()
            .from(postgres.capletInstallationObservations)
            .where(
              eq(
                postgres.capletInstallationObservations.installationKey,
                installation.installationKey,
              ),
            )
            .orderBy(
              desc(postgres.capletInstallationObservations.observedAt),
              desc(postgres.capletInstallationObservations.observationKey),
            );
    return rows.map(observationView);
  }

  async listActivity(limit = 100): Promise<OperatorActivityView[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.operatorActivity)
            .orderBy(desc(sqlite.operatorActivity.createdAt))
            .limit(bounded)
            .all()
        : await this.database.db
            .select()
            .from(postgres.operatorActivity)
            .orderBy(desc(postgres.operatorActivity.createdAt))
            .limit(bounded);
    return rows as OperatorActivityView[];
  }
}

export function requireOperator(principal: OperatorPrincipal): string {
  if (principal.role !== "operator" || !principal.clientId.trim()) {
    throw new CapletsError("AUTH_REQUIRED", "An Operator Client is required for this operation.");
  }
  return principal.clientId;
}

function installSqlite(db: SqliteHostDatabase, input: InstallInput, operatorId: string): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.capletId))
      .get();
    if (!record)
      throw new CapletsError("REQUEST_INVALID", `Caplet Record ${input.capletId} was not found.`);
    const latest = transaction
      .select()
      .from(sqlite.capletInstallations)
      .where(eq(sqlite.capletInstallations.recordKey, record.recordKey))
      .orderBy(
        desc(sqlite.capletInstallations.updatedAt),
        desc(sqlite.capletInstallations.installationKey),
      )
      .limit(1)
      .get();
    assertFreshInstall(input.capletId, latest?.status);
    const now = new Date().toISOString();
    const installationKey = randomUUID();
    transaction
      .insert(sqlite.capletInstallations)
      .values({
        installationKey,
        recordKey: record.recordKey,
        generation: 1,
        status: "active",
        sourceKind: input.sourceKind,
        sourceIdentity: input.sourceIdentity,
        channel: input.channel ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    transaction
      .insert(sqlite.operatorActivity)
      .values(
        activity(operatorId, "caplet.install", "installation", installationKey, now, {
          capletId: input.capletId,
        }),
      )
      .run();
    advanceSqliteConfigGeneration(
      transaction,
      `install:${record.recordKey}:${installationKey}`,
      operatorId,
    );
  });
}

async function installPostgres(
  db: PostgresHostDatabase,
  input: InstallInput,
  operatorId: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.capletId))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("REQUEST_INVALID", `Caplet Record ${input.capletId} was not found.`);
    const [latest] = await transaction
      .select()
      .from(postgres.capletInstallations)
      .where(eq(postgres.capletInstallations.recordKey, record.recordKey))
      .orderBy(
        desc(postgres.capletInstallations.updatedAt),
        desc(postgres.capletInstallations.installationKey),
      )
      .limit(1);
    assertFreshInstall(input.capletId, latest?.status);
    const now = new Date().toISOString();
    const installationKey = randomUUID();
    await transaction.insert(postgres.capletInstallations).values({
      installationKey,
      recordKey: record.recordKey,
      generation: 1,
      status: "active",
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      channel: input.channel ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(postgres.operatorActivity).values(
      activity(operatorId, "caplet.install", "installation", installationKey, now, {
        capletId: input.capletId,
      }),
    );
    await advancePostgresConfigGeneration(
      transaction,
      `install:${record.recordKey}:${installationKey}`,
      operatorId,
    );
  });
}

function replaceDetachedSqlite(
  db: SqliteHostDatabase,
  input: ReplaceDetachedInstallationInput,
  operatorId: string,
): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.capletId))
      .get();
    if (!record)
      throw new CapletsError("REQUEST_INVALID", `Caplet Record ${input.capletId} was not found.`);
    const latest = transaction
      .select()
      .from(sqlite.capletInstallations)
      .where(eq(sqlite.capletInstallations.recordKey, record.recordKey))
      .orderBy(
        desc(sqlite.capletInstallations.updatedAt),
        desc(sqlite.capletInstallations.installationKey),
      )
      .limit(1)
      .get();
    assertDetachedReplacement(input, latest);
    const now = nextTimestamp(latest!.updatedAt);
    const installationKey = randomUUID();
    transaction
      .insert(sqlite.capletInstallations)
      .values({
        installationKey,
        recordKey: record.recordKey,
        generation: 1,
        status: "active",
        sourceKind: input.sourceKind,
        sourceIdentity: input.sourceIdentity,
        channel: input.channel ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    transaction
      .insert(sqlite.operatorActivity)
      .values(
        activity(operatorId, "caplet.replace_installation", "installation", installationKey, now, {
          capletId: input.capletId,
          detachedInstallationKey: latest!.installationKey,
        }),
      )
      .run();
    advanceSqliteConfigGeneration(
      transaction,
      `install:${record.recordKey}:${installationKey}`,
      operatorId,
    );
  });
}

async function replaceDetachedPostgres(
  db: PostgresHostDatabase,
  input: ReplaceDetachedInstallationInput,
  operatorId: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.capletId))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("REQUEST_INVALID", `Caplet Record ${input.capletId} was not found.`);
    const [latest] = await transaction
      .select()
      .from(postgres.capletInstallations)
      .where(eq(postgres.capletInstallations.recordKey, record.recordKey))
      .orderBy(
        desc(postgres.capletInstallations.updatedAt),
        desc(postgres.capletInstallations.installationKey),
      )
      .for("update")
      .limit(1);
    assertDetachedReplacement(input, latest);
    const now = nextTimestamp(latest!.updatedAt);
    const installationKey = randomUUID();
    await transaction.insert(postgres.capletInstallations).values({
      installationKey,
      recordKey: record.recordKey,
      generation: 1,
      status: "active",
      sourceKind: input.sourceKind,
      sourceIdentity: input.sourceIdentity,
      channel: input.channel ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(postgres.operatorActivity).values(
      activity(operatorId, "caplet.replace_installation", "installation", installationKey, now, {
        capletId: input.capletId,
        detachedInstallationKey: latest!.installationKey,
      }),
    );
    await advancePostgresConfigGeneration(
      transaction,
      `install:${record.recordKey}:${installationKey}`,
      operatorId,
    );
  });
}

function appendObservationSqlite(
  db: SqliteHostDatabase,
  input: AppendInstallationObservationInput,
  operatorId: string,
): CapletInstallationObservationView {
  return db.transaction((transaction) => {
    const current = activeSqlite(transaction, input.capletId);
    if (!current) throw missingActiveInstallation(input.capletId);
    if (current.generation !== input.expectedGeneration) throw staleInstallation(input.capletId);
    const latest = transaction
      .select()
      .from(sqlite.capletInstallationObservations)
      .where(eq(sqlite.capletInstallationObservations.installationKey, current.installationKey))
      .orderBy(
        desc(sqlite.capletInstallationObservations.observedAt),
        desc(sqlite.capletInstallationObservations.observationKey),
      )
      .limit(1)
      .get();
    const now = nextTimestamp(latest?.observedAt);
    const observation = observationValues(current.installationKey, input, now);
    const updated = transaction
      .update(sqlite.capletInstallations)
      .set({ generation: current.generation + 1, updatedAt: now })
      .where(
        and(
          eq(sqlite.capletInstallations.installationKey, current.installationKey),
          eq(sqlite.capletInstallations.generation, input.expectedGeneration),
          eq(sqlite.capletInstallations.status, "active"),
        ),
      )
      .run();
    if (updated.changes !== 1) throw staleInstallation(input.capletId);
    transaction.insert(sqlite.capletInstallationObservations).values(observation).run();
    transaction
      .insert(sqlite.operatorActivity)
      .values(
        activity(
          operatorId,
          "caplet.observe_source",
          "installation",
          current.installationKey,
          now,
          { capletId: input.capletId, status: input.status },
        ),
      )
      .run();
    return observationView(observation);
  });
}

async function appendObservationPostgres(
  db: PostgresHostDatabase,
  input: AppendInstallationObservationInput,
  operatorId: string,
): Promise<CapletInstallationObservationView> {
  return await db.transaction(async (transaction) => {
    const current = await activePostgres(transaction, input.capletId, true);
    if (!current) throw missingActiveInstallation(input.capletId);
    if (current.generation !== input.expectedGeneration) throw staleInstallation(input.capletId);
    const [latest] = await transaction
      .select()
      .from(postgres.capletInstallationObservations)
      .where(eq(postgres.capletInstallationObservations.installationKey, current.installationKey))
      .orderBy(
        desc(postgres.capletInstallationObservations.observedAt),
        desc(postgres.capletInstallationObservations.observationKey),
      )
      .limit(1);
    const now = nextTimestamp(latest?.observedAt);
    const observation = observationValues(current.installationKey, input, now);
    const [updated] = await transaction
      .update(postgres.capletInstallations)
      .set({ generation: current.generation + 1, updatedAt: now })
      .where(
        and(
          eq(postgres.capletInstallations.installationKey, current.installationKey),
          eq(postgres.capletInstallations.generation, input.expectedGeneration),
          eq(postgres.capletInstallations.status, "active"),
        ),
      )
      .returning({ installationKey: postgres.capletInstallations.installationKey });
    if (!updated) throw staleInstallation(input.capletId);
    await transaction.insert(postgres.capletInstallationObservations).values(observation);
    await transaction
      .insert(postgres.operatorActivity)
      .values(
        activity(
          operatorId,
          "caplet.observe_source",
          "installation",
          current.installationKey,
          now,
          { capletId: input.capletId, status: input.status },
        ),
      );
    return observationView(observation);
  });
}

function detachSqlite(db: SqliteHostDatabase, input: DetachInput, operatorId: string): void {
  db.transaction((transaction) => {
    const current = activeSqlite(transaction, input.capletId);
    if (!current) {
      assertNoStaleDetachedSqlite(transaction, input);
      return;
    }
    if (current.generation !== input.expectedGeneration) throw staleInstallation(input.capletId);
    const now = new Date().toISOString();
    const updated = transaction
      .update(sqlite.capletInstallations)
      .set({
        status: "detached",
        generation: current.generation + 1,
        detachedAt: now,
        detachedBy: operatorId,
        updatedAt: now,
      })
      .where(
        and(
          eq(sqlite.capletInstallations.installationKey, current.installationKey),
          eq(sqlite.capletInstallations.generation, input.expectedGeneration),
          eq(sqlite.capletInstallations.status, "active"),
        ),
      )
      .run();
    if (updated.changes !== 1) throw staleInstallation(input.capletId);
    transaction
      .insert(sqlite.operatorActivity)
      .values(
        activity(operatorId, "caplet.detach", "installation", current.installationKey, now, {
          capletId: input.capletId,
        }),
      )
      .run();
    advanceSqliteConfigGeneration(
      transaction,
      `detach:${current.installationKey}:${current.generation + 1}`,
      operatorId,
    );
  });
}

async function detachPostgres(
  db: PostgresHostDatabase,
  input: DetachInput,
  operatorId: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const current = await activePostgres(transaction, input.capletId, true);
    if (!current) {
      const latest = await latestPostgresInTransaction(transaction, input.capletId, true);
      if (latest && latest.generation !== input.expectedGeneration)
        throw staleInstallation(input.capletId);
      return;
    }
    if (current.generation !== input.expectedGeneration) throw staleInstallation(input.capletId);
    const now = new Date().toISOString();
    const [updated] = await transaction
      .update(postgres.capletInstallations)
      .set({
        status: "detached",
        generation: current.generation + 1,
        detachedAt: now,
        detachedBy: operatorId,
        updatedAt: now,
      })
      .where(
        and(
          eq(postgres.capletInstallations.installationKey, current.installationKey),
          eq(postgres.capletInstallations.generation, input.expectedGeneration),
          eq(postgres.capletInstallations.status, "active"),
        ),
      )
      .returning({ installationKey: postgres.capletInstallations.installationKey });
    if (!updated) throw staleInstallation(input.capletId);
    await transaction.insert(postgres.operatorActivity).values(
      activity(operatorId, "caplet.detach", "installation", current.installationKey, now, {
        capletId: input.capletId,
      }),
    );
    await advancePostgresConfigGeneration(
      transaction,
      `detach:${current.installationKey}:${current.generation + 1}`,
      operatorId,
    );
  });
}

function getSqlite(
  db: SqliteHostDatabase | SqliteHostTransaction,
  capletId: string,
  activeOnly: boolean,
): CapletInstallationView | undefined {
  const row = db
    .select({ installation: sqlite.capletInstallations, capletId: sqlite.capletRecords.capletId })
    .from(sqlite.capletInstallations)
    .innerJoin(
      sqlite.capletRecords,
      eq(sqlite.capletRecords.recordKey, sqlite.capletInstallations.recordKey),
    )
    .where(
      activeOnly
        ? and(
            eq(sqlite.capletRecords.capletId, capletId),
            eq(sqlite.capletInstallations.status, "active"),
          )
        : eq(sqlite.capletRecords.capletId, capletId),
    )
    .orderBy(
      desc(sqlite.capletInstallations.updatedAt),
      desc(sqlite.capletInstallations.installationKey),
    )
    .limit(1)
    .get();
  return row ? installationView(row.capletId, row.installation) : undefined;
}

async function getPostgres(
  db: PostgresHostDatabase | PostgresHostTransaction,
  capletId: string,
  activeOnly: boolean,
): Promise<CapletInstallationView | undefined> {
  const [row] = await db
    .select({
      installation: postgres.capletInstallations,
      capletId: postgres.capletRecords.capletId,
    })
    .from(postgres.capletInstallations)
    .innerJoin(
      postgres.capletRecords,
      eq(postgres.capletRecords.recordKey, postgres.capletInstallations.recordKey),
    )
    .where(
      activeOnly
        ? and(
            eq(postgres.capletRecords.capletId, capletId),
            eq(postgres.capletInstallations.status, "active"),
          )
        : eq(postgres.capletRecords.capletId, capletId),
    )
    .orderBy(
      desc(postgres.capletInstallations.updatedAt),
      desc(postgres.capletInstallations.installationKey),
    )
    .limit(1);
  return row ? installationView(row.capletId, row.installation) : undefined;
}

function listSqlite(db: SqliteHostDatabase, capletId: string): CapletInstallationView[] {
  return db
    .select({ installation: sqlite.capletInstallations, capletId: sqlite.capletRecords.capletId })
    .from(sqlite.capletInstallations)
    .innerJoin(
      sqlite.capletRecords,
      eq(sqlite.capletRecords.recordKey, sqlite.capletInstallations.recordKey),
    )
    .where(eq(sqlite.capletRecords.capletId, capletId))
    .orderBy(
      desc(sqlite.capletInstallations.updatedAt),
      desc(sqlite.capletInstallations.installationKey),
    )
    .all()
    .map((row) => installationView(row.capletId, row.installation));
}

async function listPostgres(
  db: PostgresHostDatabase,
  capletId: string,
): Promise<CapletInstallationView[]> {
  const rows = await db
    .select({
      installation: postgres.capletInstallations,
      capletId: postgres.capletRecords.capletId,
    })
    .from(postgres.capletInstallations)
    .innerJoin(
      postgres.capletRecords,
      eq(postgres.capletRecords.recordKey, postgres.capletInstallations.recordKey),
    )
    .where(eq(postgres.capletRecords.capletId, capletId))
    .orderBy(
      desc(postgres.capletInstallations.updatedAt),
      desc(postgres.capletInstallations.installationKey),
    );
  return rows.map((row) => installationView(row.capletId, row.installation));
}

function activeSqlite(
  db: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  capletId: string,
) {
  return db
    .select({
      installationKey: sqlite.capletInstallations.installationKey,
      generation: sqlite.capletInstallations.generation,
    })
    .from(sqlite.capletInstallations)
    .innerJoin(
      sqlite.capletRecords,
      eq(sqlite.capletRecords.recordKey, sqlite.capletInstallations.recordKey),
    )
    .where(
      and(
        eq(sqlite.capletRecords.capletId, capletId),
        eq(sqlite.capletInstallations.status, "active"),
      ),
    )
    .get();
}

async function activePostgres(
  db: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  capletId: string,
  lock = false,
) {
  const query = db
    .select({
      installationKey: postgres.capletInstallations.installationKey,
      generation: postgres.capletInstallations.generation,
    })
    .from(postgres.capletInstallations)
    .innerJoin(
      postgres.capletRecords,
      eq(postgres.capletRecords.recordKey, postgres.capletInstallations.recordKey),
    )
    .where(
      and(
        eq(postgres.capletRecords.capletId, capletId),
        eq(postgres.capletInstallations.status, "active"),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

function latestObservationSqlite(
  db: SqliteHostDatabase,
  installationKey: string,
): CapletInstallationObservationView | undefined {
  const row = db
    .select()
    .from(sqlite.capletInstallationObservations)
    .where(eq(sqlite.capletInstallationObservations.installationKey, installationKey))
    .orderBy(
      desc(sqlite.capletInstallationObservations.observedAt),
      desc(sqlite.capletInstallationObservations.observationKey),
    )
    .limit(1)
    .get();
  return row ? observationView(row) : undefined;
}

async function latestObservationPostgres(
  db: PostgresHostDatabase,
  installationKey: string,
): Promise<CapletInstallationObservationView | undefined> {
  const [row] = await db
    .select()
    .from(postgres.capletInstallationObservations)
    .where(eq(postgres.capletInstallationObservations.installationKey, installationKey))
    .orderBy(
      desc(postgres.capletInstallationObservations.observedAt),
      desc(postgres.capletInstallationObservations.observationKey),
    )
    .limit(1);
  return row ? observationView(row) : undefined;
}

function assertNoStaleDetachedSqlite(
  db: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  input: DetachInput,
): void {
  const latest = db
    .select({ generation: sqlite.capletInstallations.generation })
    .from(sqlite.capletInstallations)
    .innerJoin(
      sqlite.capletRecords,
      eq(sqlite.capletRecords.recordKey, sqlite.capletInstallations.recordKey),
    )
    .where(eq(sqlite.capletRecords.capletId, input.capletId))
    .orderBy(
      desc(sqlite.capletInstallations.updatedAt),
      desc(sqlite.capletInstallations.installationKey),
    )
    .limit(1)
    .get();
  if (latest && latest.generation !== input.expectedGeneration)
    throw staleInstallation(input.capletId);
}

async function latestPostgresInTransaction(
  db: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  capletId: string,
  lock: boolean,
) {
  const query = db
    .select({ generation: postgres.capletInstallations.generation })
    .from(postgres.capletInstallations)
    .innerJoin(
      postgres.capletRecords,
      eq(postgres.capletRecords.recordKey, postgres.capletInstallations.recordKey),
    )
    .where(eq(postgres.capletRecords.capletId, capletId))
    .orderBy(
      desc(postgres.capletInstallations.updatedAt),
      desc(postgres.capletInstallations.installationKey),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

function observationValues(
  installationKey: string,
  input: AppendInstallationObservationInput,
  observedAt: string,
) {
  return {
    observationKey: randomUUID(),
    installationKey,
    resolvedRevision: input.resolvedRevision ?? null,
    contentHash: input.contentHash ?? null,
    risk: input.risk ?? null,
    status: input.status,
    observedAt,
  };
}

function activity(
  operatorClientId: string,
  action: string,
  targetKind: string,
  targetKey: string,
  createdAt: string,
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
    createdAt,
  };
}

function installationView(
  capletId: string,
  row: Omit<CapletInstallationView, "capletId" | "status"> & { status: string },
): CapletInstallationView {
  if (row.status !== "active" && row.status !== "detached") {
    throw new CapletsError(
      "INTERNAL_ERROR",
      `Caplet installation has invalid status ${row.status}.`,
    );
  }
  return { capletId, ...row, status: row.status };
}

function observationView(row: {
  observationKey: string;
  installationKey: string;
  resolvedRevision: string | null;
  contentHash: string | null;
  risk: unknown;
  status: string;
  observedAt: string;
}): CapletInstallationObservationView {
  if (
    row.status !== "current" &&
    row.status !== "metadata-only" &&
    row.status !== "source-unavailable"
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      `Caplet installation observation has invalid status ${row.status}.`,
    );
  }
  if (row.risk !== null && !isRecord(row.risk)) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Caplet installation observation has an invalid risk payload.",
    );
  }
  assertTimestamp(row.observedAt);
  return { ...row, status: row.status, risk: row.risk };
}

function assertFreshInstall(capletId: string, status: string | undefined): void {
  if (status === "active")
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet ${capletId} already has an active installation.`,
    );
  if (status === "detached") {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${capletId} has a detached installation; use explicit replacement.`,
      { kind: "detached_installation_replacement_required" },
    );
  }
  if (status !== undefined)
    throw new CapletsError("INTERNAL_ERROR", `Caplet installation has invalid status ${status}.`);
}

function assertDetachedReplacement(
  input: ReplaceDetachedInstallationInput,
  latest:
    | { installationKey: string; generation: number; status: string; updatedAt: string }
    | undefined,
): void {
  if (!latest)
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${input.capletId} has no detached installation to replace.`,
      { kind: "detached_installation_required" },
    );
  if (latest.status === "active")
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet ${input.capletId} already has an active installation.`,
    );
  if (latest.status !== "detached")
    throw new CapletsError(
      "INTERNAL_ERROR",
      `Caplet installation has invalid status ${latest.status}.`,
    );
  if (
    (input.detachedInstallationKey !== undefined &&
      input.detachedInstallationKey !== latest.installationKey) ||
    input.expectedGeneration !== latest.generation
  ) {
    throw staleInstallation(input.capletId);
  }
}

function nextTimestamp(previous: string | undefined): string {
  if (previous === undefined) return new Date().toISOString();
  assertTimestamp(previous);
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CapletsError("INTERNAL_ERROR", "Caplet installation contains an invalid timestamp.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingActiveInstallation(capletId: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", `Caplet ${capletId} has no active installation.`);
}

function staleInstallation(capletId: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet installation ${capletId} changed after it was read; reload and retry.`,
    { kind: "stale_generation" },
  );
}
