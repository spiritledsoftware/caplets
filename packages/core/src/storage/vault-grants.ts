import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { ConfigSourceKind } from "../config";
import { CapletsError } from "../errors";
import { requireOperator, type OperatorPrincipal } from "./installations";
import {
  MAX_STORAGE_PAGE_LIMIT,
  storagePageLimit,
  type KeysetSortDirection,
  type StorageKeysetPage,
} from "./keyset-page";
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
  resourceVersion: string;
  createdAt: string;
  createdBy: string;
};
export type VaultGrantPageKey = {
  subjectKind: StoredVaultGrant["subjectKind"];
  subjectKey: string;
  referenceName: string;
};
export type VaultGrantActiveOrigin = {
  capletId: string;
  originKind: ConfigSourceKind;
  originPath?: string | undefined;
};

export type VaultGrantPageOptions = {
  limit?: number | undefined;
  after?: VaultGrantPageKey | undefined;
  sort?: KeysetSortDirection | undefined;
  vaultKey?: string | undefined;
  capletId?: string | undefined;
  referenceName?: string | undefined;
  activeOrigins?: readonly VaultGrantActiveOrigin[] | undefined;
};

export type VaultGrantLookupInput = {
  capletId: string;
  vaultKey: string;
  referenceName: string;
  originKind: ConfigSourceKind;
  originPath?: string | undefined;
};

export type VaultGrantMatchOptions = {
  vaultKey: string;
  capletId?: string | undefined;
  referenceName?: string | undefined;
};

type NormalizedVaultGrantLookupInput = VaultGrantLookupInput;
type NormalizedVaultGrantMatchOptions = VaultGrantMatchOptions;

export type VaultGrantInput = {
  capletId: string;
  vaultKey: string;
  referenceName?: string | undefined;
  originKind: ConfigSourceKind;
  originPath?: string | undefined;
  createOnly?: boolean | undefined;
  expectedResourceVersion?: string | undefined;
  operator: OperatorPrincipal;
};

export type LegacyVaultGrantImport = {
  capletId: string;
  vaultKey: string;
  referenceName: string;
  originKind: ConfigSourceKind;
  originPath: string | null;
  createdAt: string;
};

export type VaultGrantRevokeInput = {
  capletId: string;
  vaultKey: string;
  referenceName?: string | undefined;
  originKind?: ConfigSourceKind | undefined;
  originPath?: string | undefined;
  expectedResourceVersion?: string | undefined;
  operator: OperatorPrincipal;
};

type NormalizedGrantInput = Omit<VaultGrantInput, "referenceName"> & {
  referenceName: string;
};

type NormalizedRevokeInput = Omit<VaultGrantRevokeInput, "referenceName"> & {
  referenceName: string;
};

export type PreparedVaultGrant = {
  input: Omit<VaultGrantInput, "referenceName"> & { referenceName: string };
  resourceVersion: string;
  operatorId: string;
};

export function prepareVaultGrant(input: VaultGrantInput): PreparedVaultGrant {
  return {
    input: normalizeGrantInput(input),
    resourceVersion: randomUUID(),
    operatorId: requireOperator(input.operator),
  };
}

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

  async grant(input: VaultGrantInput): Promise<string> {
    const prepared = prepareVaultGrant(input);
    const createdAt = new Date().toISOString();
    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction((transaction) =>
        grantPreparedVaultSqlite(transaction, prepared, createdAt),
      );
    }
    return await this.database.db.transaction(
      async (transaction) => await grantPreparedVaultPostgres(transaction, prepared, createdAt),
    );
  }

  async revoke(input: VaultGrantRevokeInput): Promise<boolean> {
    const operatorId = requireOperator(input.operator);
    const normalized = normalizeRevokeInput(input);
    return this.database.dialect === "sqlite"
      ? revokeSqlite(this.database.db, normalized, operatorId)
      : await revokePostgres(this.database.db, normalized, operatorId);
  }

  async assertLegacyGrantsImportable(
    grants: LegacyVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyGrantImports(grants);
    if (this.database.dialect === "sqlite") {
      assertLegacyGrantsMatchSqlite(this.database.db, validated, operatorId);
    } else {
      await assertLegacyGrantsMatchPostgres(this.database.db, validated, operatorId);
    }
  }

  async importLegacyGrants(
    grants: LegacyVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyGrantImports(grants);
    if (validated.length === 0) return;
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) =>
        importLegacyGrantsSqlite(transaction, validated, operatorId),
      );
      return;
    }
    await this.database.db.transaction(
      async (transaction) => await importLegacyGrantsPostgres(transaction, validated, operatorId),
    );
  }

  importLegacyGrantsInTransaction(
    grants: LegacyVaultGrantImport[],
    operator: OperatorPrincipal,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyGrantImports(grants);
    if (validated.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importLegacyGrantsSqlite(transaction.db, validated, operatorId)
      : importLegacyGrantsPostgres(transaction.db, validated, operatorId);
  }

  async verifyLegacyGrants(
    grants: LegacyVaultGrantImport[],
    operator: OperatorPrincipal,
  ): Promise<void> {
    const operatorId = requireOperator(operator);
    const stored = await this.list();
    for (const grant of validateLegacyGrantImports(grants)) {
      const match = stored.find(
        (candidate) =>
          candidate.capletId === grant.capletId &&
          candidate.vaultKey === grant.vaultKey &&
          candidate.referenceName === grant.referenceName &&
          candidate.originKind === grant.originKind &&
          candidate.originPath === grant.originPath &&
          candidate.createdAt === grant.createdAt &&
          candidate.createdBy === operatorId,
      );
      if (!match) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Vault grant for ${grant.capletId} failed post-migration verification.`,
        );
      }
    }
  }
  verifyLegacyGrantsInTransaction(
    grants: LegacyVaultGrantImport[],
    operator: OperatorPrincipal,
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const operatorId = requireOperator(operator);
    const validated = validateLegacyGrantImports(grants);
    return transaction.dialect === "sqlite"
      ? verifyLegacyGrantsSqlite(transaction.db, validated, operatorId)
      : verifyLegacyGrantsPostgres(transaction.db, validated, operatorId);
  }

  async get(input: VaultGrantLookupInput): Promise<StoredVaultGrant | undefined> {
    const normalized = normalizeVaultGrantLookupInput(input);
    if (this.database.dialect === "sqlite") {
      const subject = lookupSubjectSqlite(this.database.db, normalized);
      if (!subject) return undefined;
      const row = this.database.db
        .select({
          grant: sqlite.vaultAccessGrants,
          recordCapletId: sqlite.capletRecords.capletId,
        })
        .from(sqlite.vaultAccessGrants)
        .leftJoin(
          sqlite.capletRecords,
          eq(sqlite.capletRecords.recordKey, sqlite.vaultAccessGrants.recordKey),
        )
        .where(
          and(
            grantIdentityWhere(sqlite.vaultAccessGrants, subject, normalized.referenceName),
            eq(sqlite.vaultAccessGrants.vaultKey, normalized.vaultKey),
          ),
        )
        .limit(1)
        .get();
      return row ? storedGrant(row.grant, row.recordCapletId) : undefined;
    }

    const subject = await lookupSubjectPostgres(this.database.db, normalized);
    if (!subject) return undefined;
    const [row] = await this.database.db
      .select({
        grant: postgres.vaultAccessGrants,
        recordCapletId: postgres.capletRecords.capletId,
      })
      .from(postgres.vaultAccessGrants)
      .leftJoin(
        postgres.capletRecords,
        eq(postgres.capletRecords.recordKey, postgres.vaultAccessGrants.recordKey),
      )
      .where(
        and(
          grantIdentityWhere(postgres.vaultAccessGrants, subject, normalized.referenceName),
          eq(postgres.vaultAccessGrants.vaultKey, normalized.vaultKey),
        ),
      )
      .limit(1);
    return row ? storedGrant(row.grant, row.recordCapletId) : undefined;
  }

  async countByVaultKey(vaultKey: string): Promise<number> {
    const normalizedVaultKey = validateGrantName(vaultKey);
    if (this.database.dialect === "sqlite") {
      return (
        this.database.db
          .select({ value: count() })
          .from(sqlite.vaultAccessGrants)
          .where(eq(sqlite.vaultAccessGrants.vaultKey, normalizedVaultKey))
          .get()?.value ?? 0
      );
    }
    const [row] = await this.database.db
      .select({ value: count() })
      .from(postgres.vaultAccessGrants)
      .where(eq(postgres.vaultAccessGrants.vaultKey, normalizedVaultKey));
    return row?.value ?? 0;
  }

  async listMatching(options: VaultGrantMatchOptions): Promise<StoredVaultGrant[]> {
    const normalized = normalizeVaultGrantMatchOptions(options);
    const items: StoredVaultGrant[] = [];
    let after: VaultGrantPageKey | undefined;
    do {
      const page = await this.listPage({
        ...normalized,
        limit: MAX_STORAGE_PAGE_LIMIT,
        after,
      });
      items.push(...page.items);
      after = page.nextKey;
    } while (after !== undefined);
    return items;
  }

  async listPage(
    options: VaultGrantPageOptions,
  ): Promise<StorageKeysetPage<StoredVaultGrant, VaultGrantPageKey>> {
    const normalized = normalizeGrantPageOptions(options);
    if (this.database.dialect === "sqlite") {
      const after = normalized.after;
      const rows = this.database.db
        .select({
          grant: sqlite.vaultAccessGrants,
          recordCapletId: sqlite.capletRecords.capletId,
        })
        .from(sqlite.vaultAccessGrants)
        .leftJoin(
          sqlite.capletRecords,
          eq(sqlite.capletRecords.recordKey, sqlite.vaultAccessGrants.recordKey),
        )
        .where(
          and(
            activeVaultGrantSubjectsSqlite(
              sqlite.vaultAccessGrants.subjectKind,
              sqlite.vaultAccessGrants.subjectKey,
              sqlite.capletRecords.capletId,
              normalized.activeSubjects,
            ),
            after === undefined ? undefined : vaultGrantAfterSqlite(after, normalized.sort),
            normalized.capletId === undefined
              ? undefined
              : or(
                  eq(sqlite.capletRecords.capletId, normalized.capletId),
                  eq(sqlite.vaultAccessGrants.capletId, normalized.capletId),
                ),
            normalized.vaultKey === undefined
              ? undefined
              : eq(sqlite.vaultAccessGrants.vaultKey, normalized.vaultKey),
            normalized.referenceName === undefined
              ? undefined
              : eq(sqlite.vaultAccessGrants.referenceName, normalized.referenceName),
          ),
        )
        .orderBy(
          normalized.sort === "asc"
            ? asc(sqlite.vaultAccessGrants.subjectKind)
            : desc(sqlite.vaultAccessGrants.subjectKind),
          normalized.sort === "asc"
            ? asc(sqlite.vaultAccessGrants.subjectKey)
            : desc(sqlite.vaultAccessGrants.subjectKey),
          normalized.sort === "asc"
            ? asc(sqlite.vaultAccessGrants.referenceName)
            : desc(sqlite.vaultAccessGrants.referenceName),
        )
        .limit(normalized.limit + 1)
        .all();
      return grantPage(rows, normalized.limit);
    }

    const after = normalized.after;
    const rows = await this.database.db
      .select({
        grant: postgres.vaultAccessGrants,
        recordCapletId: postgres.capletRecords.capletId,
      })
      .from(postgres.vaultAccessGrants)
      .leftJoin(
        postgres.capletRecords,
        eq(postgres.capletRecords.recordKey, postgres.vaultAccessGrants.recordKey),
      )
      .where(
        and(
          activeVaultGrantSubjectsPostgres(
            postgres.vaultAccessGrants.subjectKind,
            postgres.vaultAccessGrants.subjectKey,
            postgres.capletRecords.capletId,
            normalized.activeSubjects,
          ),
          after === undefined ? undefined : vaultGrantAfterPostgres(after, normalized.sort),
          normalized.capletId === undefined
            ? undefined
            : or(
                eq(postgres.capletRecords.capletId, normalized.capletId),
                eq(postgres.vaultAccessGrants.capletId, normalized.capletId),
              ),
          normalized.vaultKey === undefined
            ? undefined
            : eq(postgres.vaultAccessGrants.vaultKey, normalized.vaultKey),
          normalized.referenceName === undefined
            ? undefined
            : eq(postgres.vaultAccessGrants.referenceName, normalized.referenceName),
        ),
      )
      .orderBy(
        normalized.sort === "asc"
          ? asc(sql`${postgres.vaultAccessGrants.subjectKind} collate "C"`)
          : desc(sql`${postgres.vaultAccessGrants.subjectKind} collate "C"`),
        normalized.sort === "asc"
          ? asc(sql`${postgres.vaultAccessGrants.subjectKey} collate "C"`)
          : desc(sql`${postgres.vaultAccessGrants.subjectKey} collate "C"`),
        normalized.sort === "asc"
          ? asc(sql`${postgres.vaultAccessGrants.referenceName} collate "C"`)
          : desc(sql`${postgres.vaultAccessGrants.referenceName} collate "C"`),
      )
      .limit(normalized.limit + 1);
    return grantPage(rows, normalized.limit);
  }

  async list(
    capletId?: string,
    activeOrigins?: readonly VaultGrantActiveOrigin[],
  ): Promise<StoredVaultGrant[]> {
    const items: StoredVaultGrant[] = [];
    let after: VaultGrantPageKey | undefined;
    do {
      const page = await this.listPage({
        limit: MAX_STORAGE_PAGE_LIMIT,
        after,
        ...(capletId === undefined ? {} : { capletId }),
        ...(activeOrigins === undefined ? {} : { activeOrigins }),
      });
      items.push(...page.items);
      after = page.nextKey;
    } while (after !== undefined);
    return items;
  }
}

type ActiveVaultGrantSubjects = {
  recordCapletIds: readonly string[];
  fileSubjectKeys: readonly string[];
};

function activeVaultGrantSubjectsSqlite(
  subjectKind: AnyColumn,
  subjectKey: AnyColumn,
  recordCapletId: AnyColumn,
  activeSubjects: ActiveVaultGrantSubjects | undefined,
): SQL | undefined {
  if (activeSubjects === undefined) return undefined;
  const recordCapletIds = JSON.stringify(activeSubjects.recordCapletIds);
  const fileSubjectKeys = JSON.stringify(activeSubjects.fileSubjectKeys);
  return or(
    and(
      eq(subjectKind, "record"),
      sql`exists (
        select 1 from json_each(${recordCapletIds}) as active_record
        where active_record.value = ${recordCapletId}
      )`,
    ),
    and(
      eq(subjectKind, "file"),
      sql`exists (
        select 1 from json_each(${fileSubjectKeys}) as active_file
        where active_file.value = ${subjectKey}
      )`,
    ),
  );
}

function activeVaultGrantSubjectsPostgres(
  subjectKind: AnyColumn,
  subjectKey: AnyColumn,
  recordCapletId: AnyColumn,
  activeSubjects: ActiveVaultGrantSubjects | undefined,
): SQL | undefined {
  if (activeSubjects === undefined) return undefined;
  const recordCapletIds = JSON.stringify(activeSubjects.recordCapletIds);
  const fileSubjectKeys = JSON.stringify(activeSubjects.fileSubjectKeys);
  return or(
    and(
      eq(subjectKind, "record"),
      sql`exists (
        select 1
        from jsonb_array_elements_text(${recordCapletIds}::jsonb) as active_record(value)
        where active_record.value = ${recordCapletId}
      )`,
    ),
    and(
      eq(subjectKind, "file"),
      sql`exists (
        select 1
        from jsonb_array_elements_text(${fileSubjectKeys}::jsonb) as active_file(value)
        where active_file.value = ${subjectKey}
      )`,
    ),
  );
}
function vaultGrantAfterSqlite(
  after: VaultGrantPageKey,
  sort: KeysetSortDirection,
): SQL | undefined {
  const compare = sort === "asc" ? gt : lt;
  return or(
    compare(sqlite.vaultAccessGrants.subjectKind, after.subjectKind),
    and(
      eq(sqlite.vaultAccessGrants.subjectKind, after.subjectKind),
      compare(sqlite.vaultAccessGrants.subjectKey, after.subjectKey),
    ),
    and(
      eq(sqlite.vaultAccessGrants.subjectKind, after.subjectKind),
      eq(sqlite.vaultAccessGrants.subjectKey, after.subjectKey),
      compare(sqlite.vaultAccessGrants.referenceName, after.referenceName),
    ),
  );
}

function vaultGrantAfterPostgres(
  after: VaultGrantPageKey,
  sort: KeysetSortDirection,
): SQL | undefined {
  return sort === "asc"
    ? or(
        sql`${postgres.vaultAccessGrants.subjectKind} collate "C" > ${after.subjectKind}`,
        and(
          sql`${postgres.vaultAccessGrants.subjectKind} collate "C" = ${after.subjectKind}`,
          sql`${postgres.vaultAccessGrants.subjectKey} collate "C" > ${after.subjectKey}`,
        ),
        and(
          sql`${postgres.vaultAccessGrants.subjectKind} collate "C" = ${after.subjectKind}`,
          sql`${postgres.vaultAccessGrants.subjectKey} collate "C" = ${after.subjectKey}`,
          sql`${postgres.vaultAccessGrants.referenceName} collate "C" > ${after.referenceName}`,
        ),
      )
    : or(
        sql`${postgres.vaultAccessGrants.subjectKind} collate "C" < ${after.subjectKind}`,
        and(
          sql`${postgres.vaultAccessGrants.subjectKind} collate "C" = ${after.subjectKind}`,
          sql`${postgres.vaultAccessGrants.subjectKey} collate "C" < ${after.subjectKey}`,
        ),
        and(
          sql`${postgres.vaultAccessGrants.subjectKind} collate "C" = ${after.subjectKind}`,
          sql`${postgres.vaultAccessGrants.subjectKey} collate "C" = ${after.subjectKey}`,
          sql`${postgres.vaultAccessGrants.referenceName} collate "C" < ${after.referenceName}`,
        ),
      );
}
type VaultGrantJoinedRow = {
  grant: typeof sqlite.vaultAccessGrants.$inferSelect;
  recordCapletId: string | null;
};

function grantPage(
  rows: VaultGrantJoinedRow[],
  limit: number,
): StorageKeysetPage<StoredVaultGrant, VaultGrantPageKey> {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(({ grant, recordCapletId }) => storedGrant(grant, recordCapletId));
  if (rows.length <= limit) return { items };
  const last = pageRows[pageRows.length - 1]!.grant;
  return {
    items,
    nextKey: {
      subjectKind: last.subjectKind as VaultGrantPageKey["subjectKind"],
      subjectKey: last.subjectKey,
      referenceName: last.referenceName,
    },
  };
}

function normalizeGrantPageOptions(options: VaultGrantPageOptions): {
  limit: number;
  sort: KeysetSortDirection;
  after?: VaultGrantPageKey | undefined;
  vaultKey?: string | undefined;
  capletId?: string | undefined;
  referenceName?: string | undefined;
  activeSubjects?: ActiveVaultGrantSubjects | undefined;
} {
  const limit = storagePageLimit(options.limit);
  const after = options.after === undefined ? undefined : normalizeVaultGrantPageKey(options.after);
  const vaultKey = options.vaultKey === undefined ? undefined : validateGrantName(options.vaultKey);
  const referenceName =
    options.referenceName === undefined ? undefined : validateGrantName(options.referenceName);
  if (options.capletId !== undefined) validateCapletId(options.capletId);
  const activeSubjects =
    options.activeOrigins === undefined
      ? undefined
      : normalizeActiveVaultGrantSubjects(options.activeOrigins);
  return {
    limit,
    sort: options.sort ?? "asc",
    ...(after === undefined ? {} : { after }),
    ...(vaultKey === undefined ? {} : { vaultKey }),
    ...(options.capletId === undefined ? {} : { capletId: options.capletId }),
    ...(referenceName === undefined ? {} : { referenceName }),
    ...(activeSubjects === undefined ? {} : { activeSubjects }),
  };
}

function normalizeActiveVaultGrantSubjects(activeOrigins: readonly VaultGrantActiveOrigin[]): {
  recordCapletIds: readonly string[];
  fileSubjectKeys: readonly string[];
} {
  const recordCapletIds = new Set<string>();
  const fileSubjectKeys = new Set<string>();
  for (const origin of activeOrigins) {
    validateCapletId(origin.capletId);
    validateOrigin(origin.originKind, origin.originPath);
    if (origin.originKind === "stored-record") {
      recordCapletIds.add(origin.capletId);
    } else {
      if (origin.originPath === undefined) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Vault grants for filesystem Caplets require an exact config origin path.",
        );
      }
      fileSubjectKeys.add(fileSubjectKey(origin.capletId, origin.originKind, origin.originPath));
    }
  }
  return {
    recordCapletIds: [...recordCapletIds],
    fileSubjectKeys: [...fileSubjectKeys],
  };
}

function normalizeVaultGrantPageKey(after: VaultGrantPageKey): VaultGrantPageKey {
  if (
    (after.subjectKind !== "file" && after.subjectKind !== "record") ||
    typeof after.subjectKey !== "string" ||
    !after.subjectKey
  ) {
    throw new CapletsError("REQUEST_INVALID", "Vault grant page key is invalid.");
  }
  return {
    subjectKind: after.subjectKind,
    subjectKey: after.subjectKey,
    referenceName: validateGrantName(after.referenceName),
  };
}
function normalizeVaultGrantLookupInput(
  input: VaultGrantLookupInput,
): NormalizedVaultGrantLookupInput {
  validateCapletId(input.capletId);
  validateOrigin(input.originKind, input.originPath);
  return {
    ...input,
    vaultKey: validateGrantName(input.vaultKey),
    referenceName: validateGrantName(input.referenceName),
  };
}

function normalizeVaultGrantMatchOptions(
  options: VaultGrantMatchOptions,
): NormalizedVaultGrantMatchOptions {
  if (options.capletId !== undefined) validateCapletId(options.capletId);
  return {
    vaultKey: validateGrantName(options.vaultKey),
    ...(options.capletId === undefined ? {} : { capletId: options.capletId }),
    ...(options.referenceName === undefined
      ? {}
      : { referenceName: validateGrantName(options.referenceName) }),
  };
}

type SqliteVaultGrantDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresVaultGrantDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];
function importLegacyGrantsSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
): void {
  const rows = assertLegacyGrantsMatchSqlite(database, grants, operatorId);
  const pending = rows.filter((row) => row.existing === undefined);
  if (pending.length > 0) {
    database
      .insert(sqlite.vaultAccessGrants)
      .values(pending.map((row) => row.values))
      .run();
  }
}

async function importLegacyGrantsPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
): Promise<void> {
  for (const grant of grants) {
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        "vault-legacy-grant",
        grant.capletId,
        grant.originKind,
        grant.originPath,
        grant.referenceName,
      ])}, 0))`,
    );
  }
  const rows = await assertLegacyGrantsMatchPostgres(database, grants, operatorId);
  const pending = rows.filter((row) => row.existing === undefined);
  if (pending.length > 0) {
    await database.insert(postgres.vaultAccessGrants).values(pending.map((row) => row.values));
  }
}

function verifyLegacyGrantsSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
): void {
  const rows = assertLegacyGrantsMatchSqlite(database, grants, operatorId);
  if (rows.some((row) => row.existing === undefined)) {
    throw new CapletsError("INTERNAL_ERROR", "A Vault grant failed post-migration verification.");
  }
}

async function verifyLegacyGrantsPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
): Promise<void> {
  const rows = await assertLegacyGrantsMatchPostgres(database, grants, operatorId);
  if (rows.some((row) => row.existing === undefined)) {
    throw new CapletsError("INTERNAL_ERROR", "A Vault grant failed post-migration verification.");
  }
}

function validateLegacyGrantImports(grants: LegacyVaultGrantImport[]): LegacyVaultGrantImport[] {
  const identities = new Set<string>();
  const validated = grants.map((grant) => {
    validateCapletId(grant.capletId);
    const vaultKey = validateGrantName(grant.vaultKey);
    const referenceName = validateGrantName(grant.referenceName);
    const originValid =
      Object.hasOwn(CONFIG_SOURCE_KINDS, grant.originKind) &&
      (grant.originKind === "stored-record"
        ? grant.originPath === null
        : typeof grant.originPath === "string" && grant.originPath.length > 0);
    const identity = JSON.stringify([
      grant.capletId,
      grant.originKind,
      grant.originPath,
      referenceName,
    ]);
    if (
      identities.has(identity) ||
      !originValid ||
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
      left.originKind.localeCompare(right.originKind) ||
      (left.originPath ?? "").localeCompare(right.originPath ?? "") ||
      left.referenceName.localeCompare(right.referenceName),
  );
}

function assertLegacyGrantsMatchSqlite(
  database: SqliteVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
) {
  return grants.map((grant) => {
    const subject = legacyGrantSubjectSqlite(database, grant);
    const values = legacyGrantValues(subject, grant, operatorId);
    const existing = database
      .select()
      .from(sqlite.vaultAccessGrants)
      .where(
        and(
          eq(sqlite.vaultAccessGrants.subjectKind, subject.kind),
          eq(sqlite.vaultAccessGrants.subjectKey, subject.key),
          eq(sqlite.vaultAccessGrants.referenceName, grant.referenceName),
        ),
      )
      .get();
    if (existing && !legacyGrantMatches(existing, values)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault grant for ${grant.capletId} conflicts with the legacy snapshot.`,
      );
    }
    return { existing, values };
  });
}

async function assertLegacyGrantsMatchPostgres(
  database: PostgresVaultGrantDatabase,
  grants: LegacyVaultGrantImport[],
  operatorId: string,
) {
  const rows = [];
  for (const grant of grants) {
    const subject = await legacyGrantSubjectPostgres(database, grant);
    const values = legacyGrantValues(subject, grant, operatorId);
    const [existing] = await database
      .select()
      .from(postgres.vaultAccessGrants)
      .where(
        and(
          eq(postgres.vaultAccessGrants.subjectKind, subject.kind),
          eq(postgres.vaultAccessGrants.subjectKey, subject.key),
          eq(postgres.vaultAccessGrants.referenceName, grant.referenceName),
        ),
      )
      .limit(1);
    if (existing && !legacyGrantMatches(existing, values)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault grant for ${grant.capletId} conflicts with the legacy snapshot.`,
      );
    }
    rows.push({ existing, values });
  }
  return rows;
}

function legacyGrantSubjectSqlite(
  database: SqliteVaultGrantDatabase,
  grant: LegacyVaultGrantImport,
): VaultGrantSubject {
  if (grant.originKind !== "stored-record") {
    return fileSubject(grant.capletId, grant.originKind, grant.originPath as string);
  }
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
  return { kind: "record", key: recordKey, recordKey, capletId: null };
}

async function legacyGrantSubjectPostgres(
  database: PostgresVaultGrantDatabase,
  grant: LegacyVaultGrantImport,
): Promise<VaultGrantSubject> {
  if (grant.originKind !== "stored-record") {
    return fileSubject(grant.capletId, grant.originKind, grant.originPath as string);
  }
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
  return { kind: "record", key: record.recordKey, recordKey: record.recordKey, capletId: null };
}

type LegacyGrantRow = {
  subjectKind: "record" | "file";
  subjectKey: string;
  recordKey: string | null;
  capletId: string | null;
  vaultKey: string;
  referenceName: string;
  originKind: ConfigSourceKind;
  originPath: string | null;
  resourceVersion: string;
  createdAt: string;
  createdBy: string;
};

function legacyGrantValues(
  subject: VaultGrantSubject,
  grant: LegacyVaultGrantImport,
  operatorId: string,
): LegacyGrantRow {
  return {
    subjectKind: subject.kind,
    subjectKey: subject.key,
    recordKey: subject.recordKey,
    capletId: subject.capletId,
    vaultKey: grant.vaultKey,
    referenceName: grant.referenceName,
    originKind: grant.originKind,
    originPath: grant.originPath,
    resourceVersion: legacyGrantResourceVersion(subject, grant.referenceName),
    createdAt: grant.createdAt,
    createdBy: operatorId,
  };
}

function legacyGrantMatches(
  existing: typeof sqlite.vaultAccessGrants.$inferSelect,
  expected: LegacyGrantRow,
): boolean {
  return (
    existing.subjectKind === expected.subjectKind &&
    existing.subjectKey === expected.subjectKey &&
    existing.recordKey === expected.recordKey &&
    existing.capletId === expected.capletId &&
    existing.vaultKey === expected.vaultKey &&
    existing.referenceName === expected.referenceName &&
    existing.originKind === expected.originKind &&
    existing.originPath === expected.originPath &&
    existing.createdAt === expected.createdAt &&
    existing.createdBy === expected.createdBy
  );
}

export function grantPreparedVaultSqlite(
  db: SqliteVaultGrantDatabase,
  prepared: PreparedVaultGrant,
  createdAt: string,
  recordActivity = true,
): string {
  const subject = sqliteSubject(db, prepared.input);
  const values = grantValues(
    subject,
    prepared.input,
    prepared.resourceVersion,
    prepared.operatorId,
    createdAt,
  );
  if (prepared.input.expectedResourceVersion === undefined) {
    if (prepared.input.createOnly === true) {
      const inserted = db
        .insert(sqlite.vaultAccessGrants)
        .values(values)
        .onConflictDoNothing()
        .run();
      if (inserted.changes !== 1) {
        throw new CapletsError("CONFIG_EXISTS", "Vault grant already exists.");
      }
    } else {
      db.insert(sqlite.vaultAccessGrants)
        .values(values)
        .onConflictDoUpdate({
          target: [
            sqlite.vaultAccessGrants.subjectKind,
            sqlite.vaultAccessGrants.subjectKey,
            sqlite.vaultAccessGrants.referenceName,
          ],
          set: grantReplacementValues(values),
        })
        .run();
    }
  } else {
    const updated = db
      .update(sqlite.vaultAccessGrants)
      .set(grantReplacementValues(values))
      .where(
        and(
          grantIdentityWhere(sqlite.vaultAccessGrants, subject, prepared.input.referenceName),
          eq(sqlite.vaultAccessGrants.resourceVersion, prepared.input.expectedResourceVersion),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw staleVaultGrant(prepared.input.expectedResourceVersion);
    }
  }
  if (recordActivity) {
    db.insert(sqlite.operatorActivity)
      .values(
        activity(
          prepared.operatorId,
          "vault.grant",
          subject,
          prepared.input.vaultKey,
          prepared.input.referenceName,
          createdAt,
        ),
      )
      .run();
  }
  return prepared.resourceVersion;
}

export async function grantPreparedVaultPostgres(
  db: PostgresVaultGrantDatabase,
  prepared: PreparedVaultGrant,
  createdAt: string,
  recordActivity = true,
): Promise<string> {
  const subject = await postgresSubject(db, prepared.input);
  const values = grantValues(
    subject,
    prepared.input,
    prepared.resourceVersion,
    prepared.operatorId,
    createdAt,
  );
  if (prepared.input.expectedResourceVersion === undefined) {
    if (prepared.input.createOnly === true) {
      const inserted = await db
        .insert(postgres.vaultAccessGrants)
        .values(values)
        .onConflictDoNothing()
        .returning({ subjectKey: postgres.vaultAccessGrants.subjectKey });
      if (inserted.length !== 1) {
        throw new CapletsError("CONFIG_EXISTS", "Vault grant already exists.");
      }
    } else {
      await db
        .insert(postgres.vaultAccessGrants)
        .values(values)
        .onConflictDoUpdate({
          target: [
            postgres.vaultAccessGrants.subjectKind,
            postgres.vaultAccessGrants.subjectKey,
            postgres.vaultAccessGrants.referenceName,
          ],
          set: grantReplacementValues(values),
        });
    }
  } else {
    const updated = await db
      .update(postgres.vaultAccessGrants)
      .set(grantReplacementValues(values))
      .where(
        and(
          grantIdentityWhere(postgres.vaultAccessGrants, subject, prepared.input.referenceName),
          eq(postgres.vaultAccessGrants.resourceVersion, prepared.input.expectedResourceVersion),
        ),
      )
      .returning({ subjectKey: postgres.vaultAccessGrants.subjectKey });
    if (updated.length !== 1) {
      throw staleVaultGrant(prepared.input.expectedResourceVersion);
    }
  }
  if (recordActivity) {
    await db
      .insert(postgres.operatorActivity)
      .values(
        activity(
          prepared.operatorId,
          "vault.grant",
          subject,
          prepared.input.vaultKey,
          prepared.input.referenceName,
          createdAt,
        ),
      );
  }
  return prepared.resourceVersion;
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
            input.expectedResourceVersion === undefined
              ? undefined
              : eq(sqlite.vaultAccessGrants.resourceVersion, input.expectedResourceVersion),
          ),
        )
        .run().changes > 0;
    if (!removed && input.expectedResourceVersion !== undefined) {
      throw staleVaultGrant(input.expectedResourceVersion);
    }
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
          input.expectedResourceVersion === undefined
            ? undefined
            : eq(postgres.vaultAccessGrants.resourceVersion, input.expectedResourceVersion),
        ),
      )
      .returning({ subjectKey: postgres.vaultAccessGrants.subjectKey });
    if (removed.length === 0 && input.expectedResourceVersion !== undefined) {
      throw staleVaultGrant(input.expectedResourceVersion);
    }
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

type VaultGrantValues = {
  subjectKind: "record" | "file";
  subjectKey: string;
  recordKey: string | null;
  capletId: string | null;
  vaultKey: string;
  referenceName: string;
  originKind: ConfigSourceKind;
  originPath: string | null;
  resourceVersion: string;
  createdAt: string;
  createdBy: string;
};

function grantValues(
  subject: VaultGrantSubject,
  input: NormalizedGrantInput,
  resourceVersion: string,
  operatorId: string,
  createdAt: string,
): VaultGrantValues {
  return {
    subjectKind: subject.kind,
    subjectKey: subject.key,
    recordKey: subject.recordKey,
    capletId: subject.capletId,
    vaultKey: input.vaultKey,
    referenceName: input.referenceName,
    originKind: input.originKind,
    originPath: input.originPath ?? null,
    resourceVersion,
    createdAt,
    createdBy: operatorId,
  };
}
type VaultGrantIdentityColumns = {
  subjectKind: AnyColumn;
  subjectKey: AnyColumn;
  referenceName: AnyColumn;
};

function grantIdentityWhere(
  table: VaultGrantIdentityColumns,
  subject: VaultGrantSubject,
  referenceName: string,
) {
  return and(
    eq(table.subjectKind, subject.kind),
    eq(table.subjectKey, subject.key),
    eq(table.referenceName, referenceName),
  );
}

function grantReplacementValues(values: VaultGrantValues) {
  return {
    vaultKey: values.vaultKey,
    originKind: values.originKind,
    originPath: values.originPath,
    resourceVersion: values.resourceVersion,
    createdAt: values.createdAt,
    createdBy: values.createdBy,
  };
}
function sqliteSubject(
  db: SqliteVaultGrantDatabase,
  input: NormalizedGrantInput,
): VaultGrantSubject {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = sqliteRecordKey(db, input.capletId, true) as string;
  return { kind: "record", key: recordKey, recordKey, capletId: null };
}

async function postgresSubject(
  db: PostgresVaultGrantDatabase,
  input: NormalizedGrantInput,
): Promise<VaultGrantSubject> {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = (await postgresRecordKey(db, input.capletId, true)) as string;
  return { kind: "record", key: recordKey, recordKey, capletId: null };
}
function lookupSubjectSqlite(
  db: SqliteVaultGrantDatabase,
  input: NormalizedVaultGrantLookupInput,
): VaultGrantSubject | undefined {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = sqliteRecordKey(db, input.capletId, false);
  return recordKey ? { kind: "record", key: recordKey, recordKey, capletId: null } : undefined;
}

async function lookupSubjectPostgres(
  db: PostgresVaultGrantDatabase,
  input: NormalizedVaultGrantLookupInput,
): Promise<VaultGrantSubject | undefined> {
  if (input.originKind !== "stored-record") {
    return fileSubject(input.capletId, input.originKind, input.originPath as string);
  }
  const recordKey = await postgresRecordKey(db, input.capletId, false);
  return recordKey ? { kind: "record", key: recordKey, recordKey, capletId: null } : undefined;
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
  db: SqliteVaultGrantDatabase,
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
  db: PostgresVaultGrantDatabase,
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
    typeof grant.resourceVersion === "string" &&
    grant.resourceVersion.length > 0 &&
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
    resourceVersion: grant.resourceVersion,
    createdAt: grant.createdAt,
    createdBy: grant.createdBy,
  };
}

function normalizeGrantInput(input: VaultGrantInput): NormalizedGrantInput {
  validateCapletId(input.capletId);
  validateOrigin(input.originKind, input.originPath);
  const expectedResourceVersion = normalizeExpectedResourceVersion(input.expectedResourceVersion);
  if (input.createOnly !== undefined && typeof input.createOnly !== "boolean") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault grant create-only must be a boolean when provided.",
    );
  }
  if (input.createOnly !== undefined && expectedResourceVersion !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault grant create-only and expected resource version are mutually exclusive.",
    );
  }
  return {
    ...input,
    vaultKey: validateGrantName(input.vaultKey),
    referenceName: validateGrantName(input.referenceName ?? input.vaultKey),
    ...(expectedResourceVersion === undefined ? {} : { expectedResourceVersion }),
  };
}

function normalizeRevokeInput(input: VaultGrantRevokeInput): NormalizedRevokeInput {
  validateCapletId(input.capletId);
  if (input.originKind !== undefined) validateOrigin(input.originKind, input.originPath);
  const expectedResourceVersion = normalizeExpectedResourceVersion(input.expectedResourceVersion);
  return {
    ...input,
    vaultKey: validateGrantName(input.vaultKey),
    referenceName: validateGrantName(input.referenceName ?? input.vaultKey),
    ...(expectedResourceVersion === undefined ? {} : { expectedResourceVersion }),
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

function normalizeExpectedResourceVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "Expected Vault grant resource version is invalid.");
  }
  return value;
}

function legacyGrantResourceVersion(subject: VaultGrantSubject, referenceName: string): string {
  return `legacy-v16-${createHash("sha256")
    .update(JSON.stringify([subject.kind, subject.key, referenceName]))
    .digest("base64url")}`;
}

function staleVaultGrant(expectedResourceVersion: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "Vault grant changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedResourceVersion,
    },
  );
}
