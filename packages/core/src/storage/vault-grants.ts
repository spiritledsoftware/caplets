import { createHash, randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { ConfigSourceKind } from "../config";
import { CapletsError } from "../errors";
import { requireOperator, type OperatorPrincipal } from "./installations";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  SqliteHostDatabase,
} from "./types";

export type StoredVaultGrant = {
  subjectKind: "record" | "file";
  recordKey: string | null;
  capletId: string;
  vaultKey: string;
  referenceName: string;
  originKind: ConfigSourceKind;
  originPath: string | null;
  createdAt: string;
  createdBy: string;
};

export type VaultGrantInput = {
  capletId: string;
  vaultKey: string;
  referenceName?: string | undefined;
  originKind: ConfigSourceKind;
  originPath?: string | undefined;
  operator: OperatorPrincipal;
};

export type LegacyRecordVaultGrantImport = {
  capletId: string;
  vaultKey: string;
  referenceName: string;
  createdAt: string;
};

export type VaultGrantRevokeInput = {
  capletId: string;
  vaultKey: string;
  referenceName?: string | undefined;
  originKind?: ConfigSourceKind | undefined;
  originPath?: string | undefined;
  operator: OperatorPrincipal;
};

type NormalizedGrantInput = Omit<VaultGrantInput, "referenceName"> & {
  referenceName: string;
};

type NormalizedRevokeInput = Omit<VaultGrantRevokeInput, "referenceName"> & {
  referenceName: string;
};

type VaultGrantSubject =
  | {
      kind: "record";
      key: string;
      recordKey: string;
      capletId: null;
    }
  | {
      kind: "file";
      key: string;
      recordKey: null;
      capletId: string;
    };

const CONFIG_SOURCE_KINDS: Record<ConfigSourceKind, true> = {
  "stored-record": true,
  "global-config": true,
  "global-file": true,
  "project-config": true,
  "project-file": true,
};

export class VaultGrantStore {
  constructor(private readonly database: HostDatabase) {}

  async grant(input: VaultGrantInput): Promise<void> {
    const operatorId = requireOperator(input.operator);
    const normalized = normalizeGrantInput(input);
    if (this.database.dialect === "sqlite") {
      grantSqlite(this.database.db, normalized, operatorId);
    } else {
      await grantPostgres(this.database.db, normalized, operatorId);
    }
  }

  async revoke(input: VaultGrantRevokeInput): Promise<boolean> {
    const operatorId = requireOperator(input.operator);
    const normalized = normalizeRevokeInput(input);
    return this.database.dialect === "sqlite"
      ? revokeSqlite(this.database.db, normalized, operatorId)
      : await revokePostgres(this.database.db, normalized, operatorId);
  }

  async assertLegacyRecordGrantsImportable(
    grants: LegacyRecordVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyRecordGrantImports(grants);
    if (this.database.dialect === "sqlite") {
      assertLegacyRecordGrantsMatchSqlite(this.database.db, validated, operatorId);
    } else {
      await assertLegacyRecordGrantsMatchPostgres(this.database.db, validated, operatorId);
    }
  }

  async importLegacyRecordGrants(
    grants: LegacyRecordVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyRecordGrantImports(grants);
    if (validated.length === 0) return;
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) =>
        importLegacyRecordGrantsSqlite(transaction, validated, operatorId),
      );
      return;
    }
    await this.database.db.transaction(
      async (transaction) =>
        await importLegacyRecordGrantsPostgres(transaction, validated, operatorId),
    );
  }

  importLegacyRecordGrantsInTransaction(
    grants: LegacyRecordVaultGrantImport[],
    operator: OperatorPrincipal,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyRecordGrantImports(grants);
    if (validated.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importLegacyRecordGrantsSqlite(transaction.db, validated, operatorId)
      : importLegacyRecordGrantsPostgres(transaction.db, validated, operatorId);
  }

  async verifyLegacyRecordGrants(
    grants: LegacyRecordVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const stored = await this.list();
    for (const grant of validateLegacyRecordGrantImports(grants)) {
      const match = stored.find(
        (candidate) =>
          candidate.subjectKind === "record" &&
          candidate.capletId === grant.capletId &&
          candidate.vaultKey === grant.vaultKey &&
          candidate.referenceName === grant.referenceName &&
          candidate.originKind === "stored-record" &&
          candidate.originPath === null &&
          candidate.createdAt === grant.createdAt &&
          candidate.createdBy === operatorId,
      );
      if (!match) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Vault grant for Caplet Record ${grant.capletId} failed post-migration verification.`,
        );
      }
    }
  }
  verifyLegacyRecordGrantsInTransaction(
    grants: LegacyRecordVaultGrantImport[],
    operator: OperatorPrincipal,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyRecordGrantImports(grants);
    return transaction.dialect === "sqlite"
      ? verifyLegacyRecordGrantsSqlite(transaction.db, validated, operatorId)
      : verifyLegacyRecordGrantsPostgres(transaction.db, validated, operatorId);
  }

  async list(capletId?: string): Promise<StoredVaultGrant[]> {
    if (capletId !== undefined) validateCapletId(capletId);
    if (this.database.dialect === "sqlite") {
      const query = this.database.db
        .select({
          grant: sqlite.vaultAccessGrants,
          recordCapletId: sqlite.capletRecords.capletId,
        })
        .from(sqlite.vaultAccessGrants)
        .leftJoin(
          sqlite.capletRecords,
          eq(sqlite.capletRecords.recordKey, sqlite.vaultAccessGrants.recordKey),
        );
      const rows =
        capletId === undefined
          ? query.all()
          : query
              .where(
                or(
                  eq(sqlite.capletRecords.capletId, capletId),
                  eq(sqlite.vaultAccessGrants.capletId, capletId),
                ),
              )
              .all();
      return rows.map(({ grant, recordCapletId }) => storedGrant(grant, recordCapletId));
    }

    const query = this.database.db
      .select({
        grant: postgres.vaultAccessGrants,
        recordCapletId: postgres.capletRecords.capletId,
      })
      .from(postgres.vaultAccessGrants)
      .leftJoin(
        postgres.capletRecords,
        eq(postgres.capletRecords.recordKey, postgres.vaultAccessGrants.recordKey),
      );
    const rows =
      capletId === undefined
        ? await query
        : await query.where(
            or(
              eq(postgres.capletRecords.capletId, capletId),
              eq(postgres.vaultAccessGrants.capletId, capletId),
            ),
          );
    return rows.map(({ grant, recordCapletId }) => storedGrant(grant, recordCapletId));
  }
}

type SqliteVaultGrantDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresVaultGrantDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];
function importLegacyRecordGrantsSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
): void {
  const rows = assertLegacyRecordGrantsMatchSqlite(database, grants, operatorId);
  const pending = rows.filter((row) => row.existing === undefined);
  if (pending.length > 0) {
    database
      .insert(sqlite.vaultAccessGrants)
      .values(pending.map((row) => row.values))
      .run();
  }
}

async function importLegacyRecordGrantsPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
): Promise<void> {
  for (const grant of grants) {
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        "vault-legacy-grant",
        grant.capletId,
        grant.referenceName,
      ])}, 0))`,
    );
  }
  const rows = await assertLegacyRecordGrantsMatchPostgres(database, grants, operatorId);
  const pending = rows.filter((row) => row.existing === undefined);
  if (pending.length > 0) {
    await database.insert(postgres.vaultAccessGrants).values(pending.map((row) => row.values));
  }
}

function verifyLegacyRecordGrantsSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
): void {
  const rows = assertLegacyRecordGrantsMatchSqlite(database, grants, operatorId);
  if (rows.some((row) => row.existing === undefined)) {
    throw new CapletsError("INTERNAL_ERROR", "A Vault grant failed post-migration verification.");
  }
}

async function verifyLegacyRecordGrantsPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
): Promise<void> {
  const rows = await assertLegacyRecordGrantsMatchPostgres(database, grants, operatorId);
  if (rows.some((row) => row.existing === undefined)) {
    throw new CapletsError("INTERNAL_ERROR", "A Vault grant failed post-migration verification.");
  }
}

function validateLegacyRecordGrantImports(
  grants: LegacyRecordVaultGrantImport[],
): LegacyRecordVaultGrantImport[] {
  const identities = new Set<string>();
  const validated = grants.map((grant) => {
    validateCapletId(grant.capletId);
    const vaultKey = validateGrantName(grant.vaultKey);
    const referenceName = validateGrantName(grant.referenceName);
    const identity = JSON.stringify([grant.capletId, referenceName]);
    if (
      identities.has(identity) ||
      !Number.isFinite(Date.parse(grant.createdAt)) ||
      new Date(grant.createdAt).toISOString() !== grant.createdAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "Legacy Vault grants are invalid.");
    }
    identities.add(identity);
    return { ...grant, vaultKey, referenceName };
  });
  return validated.sort(
    (left, right) =>
      left.capletId.localeCompare(right.capletId) ||
      left.referenceName.localeCompare(right.referenceName),
  );
}

function assertLegacyRecordGrantsMatchSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
) {
  return grants.map((grant) => {
    const recordKey = database
      .select({ recordKey: sqlite.capletRecords.recordKey })
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, grant.capletId))
      .get()?.recordKey;
    if (!recordKey) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Record ${grant.capletId} required by a legacy Vault grant was not found.`,
      );
    }
    const values = legacyRecordGrantValues(recordKey, grant, operatorId);
    const existing = database
      .select()
      .from(sqlite.vaultAccessGrants)
      .where(
        and(
          eq(sqlite.vaultAccessGrants.subjectKind, "record"),
          eq(sqlite.vaultAccessGrants.subjectKey, recordKey),
          eq(sqlite.vaultAccessGrants.referenceName, grant.referenceName),
        ),
      )
      .get();
    if (existing && !legacyRecordGrantMatches(existing, values)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault grant for Caplet Record ${grant.capletId} conflicts with the legacy snapshot.`,
      );
    }
    return { existing, values };
  });
}

async function assertLegacyRecordGrantsMatchPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyRecordVaultGrantImport[],
  operatorId: string,
) {
  const rows = [];
  for (const grant of grants) {
    const [record] = await database
      .select({ recordKey: postgres.capletRecords.recordKey })
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, grant.capletId))
      .limit(1);
    if (!record) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Record ${grant.capletId} required by a legacy Vault grant was not found.`,
      );
    }
    const values = legacyRecordGrantValues(record.recordKey, grant, operatorId);
    const [existing] = await database
      .select()
      .from(postgres.vaultAccessGrants)
      .where(
        and(
          eq(postgres.vaultAccessGrants.subjectKind, "record"),
          eq(postgres.vaultAccessGrants.subjectKey, record.recordKey),
          eq(postgres.vaultAccessGrants.referenceName, grant.referenceName),
        ),
      )
      .limit(1);
    if (existing && !legacyRecordGrantMatches(existing, values)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault grant for Caplet Record ${grant.capletId} conflicts with the legacy snapshot.`,
      );
    }
    rows.push({ existing, values });
  }
  return rows;
}

type LegacyRecordGrantRow = {
  subjectKind: "record";
  subjectKey: string;
  recordKey: string;
  capletId: null;
  vaultKey: string;
  referenceName: string;
  originKind: "stored-record";
  originPath: null;
  createdAt: string;
  createdBy: string;
};

function legacyRecordGrantValues(
  recordKey: string,
  grant: LegacyRecordVaultGrantImport,
  operatorId: string,
): LegacyRecordGrantRow {
  return {
    subjectKind: "record" as const,
    subjectKey: recordKey,
    recordKey,
    capletId: null,
    vaultKey: grant.vaultKey,
    referenceName: grant.referenceName,
    originKind: "stored-record" as const,
    originPath: null,
    createdAt: grant.createdAt,
    createdBy: operatorId,
  };
}

function legacyRecordGrantMatches(
  existing: typeof sqlite.vaultAccessGrants.$inferSelect,
  expected: LegacyRecordGrantRow,
): boolean {
  return (
    existing.recordKey === expected.recordKey &&
    existing.capletId === null &&
    existing.vaultKey === expected.vaultKey &&
    existing.originKind === "stored-record" &&
    existing.originPath === null &&
    existing.createdAt === expected.createdAt &&
    existing.createdBy === expected.createdBy
  );
}

function grantSqlite(
  db: SqliteHostDatabase,
  input: NormalizedGrantInput,
  operatorId: string,
): void {
  db.transaction((transaction) => {
    const subject = sqliteSubject(transaction, input);
    const now = new Date().toISOString();
    transaction
      .insert(sqlite.vaultAccessGrants)
      .values(grantValues(subject, input, operatorId, now))
      .onConflictDoUpdate({
        target: [
          sqlite.vaultAccessGrants.subjectKind,
          sqlite.vaultAccessGrants.subjectKey,
          sqlite.vaultAccessGrants.referenceName,
        ],
        set: {
          vaultKey: input.vaultKey,
          originKind: input.originKind,
          originPath: input.originPath ?? null,
          createdAt: now,
          createdBy: operatorId,
        },
      })
      .run();
    transaction
      .insert(sqlite.operatorActivity)
      .values(
        activity(operatorId, "vault.grant", subject, input.vaultKey, input.referenceName, now),
      )
      .run();
  });
}

async function grantPostgres(
  db: PostgresHostDatabase,
  input: NormalizedGrantInput,
  operatorId: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const subject = await postgresSubject(transaction, input);
    const now = new Date().toISOString();
    await transaction
      .insert(postgres.vaultAccessGrants)
      .values(grantValues(subject, input, operatorId, now))
      .onConflictDoUpdate({
        target: [
          postgres.vaultAccessGrants.subjectKind,
          postgres.vaultAccessGrants.subjectKey,
          postgres.vaultAccessGrants.referenceName,
        ],
        set: {
          vaultKey: input.vaultKey,
          originKind: input.originKind,
          originPath: input.originPath ?? null,
          createdAt: now,
          createdBy: operatorId,
        },
      });
    await transaction
      .insert(postgres.operatorActivity)
      .values(
        activity(operatorId, "vault.grant", subject, input.vaultKey, input.referenceName, now),
      );
  });
}

function revokeSqlite(
  db: SqliteHostDatabase,
  input: NormalizedRevokeInput,
  operatorId: string,
): boolean {
  return db.transaction((transaction) => {
    const subject = input.originKind
      ? sqliteSubject(transaction, input as NormalizedGrantInput)
      : undefined;
    const recordKey = input.originKind
      ? undefined
      : sqliteRecordKey(transaction, input.capletId, false);
    const subjectMatch = subject
      ? and(
          eq(sqlite.vaultAccessGrants.subjectKind, subject.kind),
          eq(sqlite.vaultAccessGrants.subjectKey, subject.key),
        )
      : or(
          recordKey
            ? and(
                eq(sqlite.vaultAccessGrants.subjectKind, "record"),
                eq(sqlite.vaultAccessGrants.recordKey, recordKey),
              )
            : undefined,
          and(
            eq(sqlite.vaultAccessGrants.subjectKind, "file"),
            eq(sqlite.vaultAccessGrants.capletId, input.capletId),
          ),
        );
    const removed =
      transaction
        .delete(sqlite.vaultAccessGrants)
        .where(
          and(
            subjectMatch,
            eq(sqlite.vaultAccessGrants.referenceName, input.referenceName),
            eq(sqlite.vaultAccessGrants.vaultKey, input.vaultKey),
          ),
        )
        .run().changes > 0;
    if (removed) {
      const now = new Date().toISOString();
      transaction
        .insert(sqlite.operatorActivity)
        .values(
          activity(
            operatorId,
            "vault.revoke",
            subject ?? fileSubject(input.capletId, "global-file", ""),
            input.vaultKey,
            input.referenceName,
            now,
          ),
        )
        .run();
    }
    return removed;
  });
}

async function revokePostgres(
  db: PostgresHostDatabase,
  input: NormalizedRevokeInput,
  operatorId: string,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    const subject = input.originKind
      ? await postgresSubject(transaction, input as NormalizedGrantInput)
      : undefined;
    const recordKey = input.originKind
      ? undefined
      : await postgresRecordKey(transaction, input.capletId, false);
    const subjectMatch = subject
      ? and(
          eq(postgres.vaultAccessGrants.subjectKind, subject.kind),
          eq(postgres.vaultAccessGrants.subjectKey, subject.key),
        )
      : or(
          recordKey
            ? and(
                eq(postgres.vaultAccessGrants.subjectKind, "record"),
                eq(postgres.vaultAccessGrants.recordKey, recordKey),
              )
            : undefined,
          and(
            eq(postgres.vaultAccessGrants.subjectKind, "file"),
            eq(postgres.vaultAccessGrants.capletId, input.capletId),
          ),
        );
    const removed = await transaction
      .delete(postgres.vaultAccessGrants)
      .where(
        and(
          subjectMatch,
          eq(postgres.vaultAccessGrants.referenceName, input.referenceName),
          eq(postgres.vaultAccessGrants.vaultKey, input.vaultKey),
        ),
      )
      .returning({ subjectKey: postgres.vaultAccessGrants.subjectKey });
    if (removed.length > 0) {
      const now = new Date().toISOString();
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activity(
            operatorId,
            "vault.revoke",
            subject ?? fileSubject(input.capletId, "global-file", ""),
            input.vaultKey,
            input.referenceName,
            now,
          ),
        );
    }
    return removed.length > 0;
  });
}

function grantValues(
  subject: VaultGrantSubject,
  input: NormalizedGrantInput,
  operatorId: string,
  createdAt: string,
) {
  return {
    subjectKind: subject.kind,
    subjectKey: subject.key,
    recordKey: subject.recordKey,
    capletId: subject.capletId,
    vaultKey: input.vaultKey,
    referenceName: input.referenceName,
    originKind: input.originKind,
    originPath: input.originPath ?? null,
    createdAt,
    createdBy: operatorId,
  };
}

function sqliteSubject(
  db: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  input: NormalizedGrantInput,
): VaultGrantSubject {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = sqliteRecordKey(db, input.capletId, true) as string;
  return { kind: "record", key: recordKey, recordKey, capletId: null };
}

async function postgresSubject(
  db: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  input: NormalizedGrantInput,
): Promise<VaultGrantSubject> {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = (await postgresRecordKey(db, input.capletId, true)) as string;
  return { kind: "record", key: recordKey, recordKey, capletId: null };
}

function fileSubject(
  capletId: string,
  originKind: Exclude<ConfigSourceKind, "stored-record">,
  originPath: string,
): VaultGrantSubject {
  return {
    kind: "file",
    key: JSON.stringify([capletId, originKind, originPath]),
    recordKey: null,
    capletId,
  };
}

function sqliteRecordKey(
  db: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  capletId: string,
  required: boolean,
): string | undefined {
  const recordKey = db
    .select({ recordKey: sqlite.capletRecords.recordKey })
    .from(sqlite.capletRecords)
    .where(eq(sqlite.capletRecords.capletId, capletId))
    .get()?.recordKey;
  if (!recordKey && required) {
    throw new CapletsError("REQUEST_INVALID", `Caplet Record ${capletId} was not found.`);
  }
  return recordKey;
}

async function postgresRecordKey(
  db: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  capletId: string,
  required: boolean,
): Promise<string | undefined> {
  const [record] = await db
    .select({ recordKey: postgres.capletRecords.recordKey })
    .from(postgres.capletRecords)
    .where(eq(postgres.capletRecords.capletId, capletId))
    .limit(1);
  if (!record && required) {
    throw new CapletsError("REQUEST_INVALID", `Caplet Record ${capletId} was not found.`);
  }
  return record?.recordKey;
}

function storedGrant(
  grant: typeof sqlite.vaultAccessGrants.$inferSelect,
  recordCapletId: string | null,
): StoredVaultGrant {
  const commonValid =
    (grant.subjectKind === "record" || grant.subjectKind === "file") &&
    typeof grant.subjectKey === "string" &&
    typeof grant.vaultKey === "string" &&
    typeof grant.referenceName === "string" &&
    grant.originKind in CONFIG_SOURCE_KINDS &&
    typeof grant.createdAt === "string" &&
    typeof grant.createdBy === "string";
  const recordValid =
    grant.subjectKind === "record" &&
    grant.recordKey !== null &&
    grant.capletId === null &&
    grant.subjectKey === grant.recordKey &&
    grant.originKind === "stored-record" &&
    recordCapletId !== null;
  const fileValid =
    grant.subjectKind === "file" &&
    grant.recordKey === null &&
    grant.capletId !== null &&
    grant.originKind !== "stored-record" &&
    grant.originPath !== null &&
    grant.subjectKey ===
      fileSubjectKey(
        grant.capletId,
        grant.originKind as Exclude<ConfigSourceKind, "stored-record">,
        grant.originPath,
      );
  if (!commonValid || (!recordValid && !fileValid)) {
    throw new CapletsError("INTERNAL_ERROR", "Persisted Vault Access Grant subject is invalid.");
  }
  return {
    subjectKind: grant.subjectKind as StoredVaultGrant["subjectKind"],
    recordKey: grant.recordKey,
    capletId: recordCapletId ?? (grant.capletId as string),
    vaultKey: grant.vaultKey,
    referenceName: grant.referenceName,
    originKind: grant.originKind as ConfigSourceKind,
    originPath: grant.originPath,
    createdAt: grant.createdAt,
    createdBy: grant.createdBy,
  };
}

function normalizeGrantInput(input: VaultGrantInput): NormalizedGrantInput {
  validateCapletId(input.capletId);
  validateOrigin(input.originKind, input.originPath);
  return {
    ...input,
    vaultKey: validateGrantName(input.vaultKey),
    referenceName: validateGrantName(input.referenceName ?? input.vaultKey),
  };
}

function normalizeRevokeInput(input: VaultGrantRevokeInput): NormalizedRevokeInput {
  validateCapletId(input.capletId);
  if (input.originKind !== undefined) validateOrigin(input.originKind, input.originPath);
  return {
    ...input,
    vaultKey: validateGrantName(input.vaultKey),
    referenceName: validateGrantName(input.referenceName ?? input.vaultKey),
  };
}

function validateCapletId(capletId: string): void {
  if (!capletId.trim()) {
    throw new CapletsError("REQUEST_INVALID", "Vault grant Caplet ID is required.");
  }
}

function validateGrantName(name: string): string {
  if (!name.trim()) {
    throw new CapletsError("REQUEST_INVALID", "Vault grant names are required.");
  }
  return name;
}

function validateOrigin(originKind: ConfigSourceKind, originPath: string | undefined): void {
  if (!(originKind in CONFIG_SOURCE_KINDS)) {
    throw new CapletsError("REQUEST_INVALID", "Vault grant config origin kind is invalid.");
  }
  if (originKind !== "stored-record" && !originPath) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault grants for filesystem Caplets require an exact config origin path.",
    );
  }
}

function fileSubjectKey(
  capletId: string,
  originKind: Exclude<ConfigSourceKind, "stored-record">,
  originPath: string,
): string {
  return JSON.stringify([capletId, originKind, originPath]);
}

function activity(
  operatorClientId: string,
  action: string,
  subject: VaultGrantSubject,
  vaultKey: string,
  referenceName: string,
  createdAt: string,
) {
  const subjectFingerprint = createHash("sha256").update(subject.key).digest("hex").slice(0, 24);
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind: "vault_grant",
    targetKey: `${subject.kind}:${subjectFingerprint}:${vaultKey}`,
    outcome: "succeeded",
    metadata: { subjectKind: subject.kind, vaultKey, referenceName },
    createdAt,
  };
}
