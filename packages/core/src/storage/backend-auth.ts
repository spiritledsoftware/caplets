import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import {
  isStoredOAuthTokenBundle,
  type StoredOAuthTokenBundle,
  type StoredOAuthTokenBundleView,
} from "../auth/store";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

export type BackendAuthMutationOptions = {
  expectedGeneration?: number | undefined;
  operatorClientId?: string | undefined;
};

type BackendAuthRow = {
  server: string;
  generation: number;
  tokenBundle: unknown;
  createdAt: string;
  updatedAt: string;
};

export class BackendAuthStateStore {
  constructor(private readonly database: HostDatabase) {}

  async readTokenBundle(server: string): Promise<StoredOAuthTokenBundleView | undefined> {
    validateServer(server);
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.backendAuthStates)
            .where(eq(sqlite.backendAuthStates.server, server))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.backendAuthStates)
              .where(eq(postgres.backendAuthStates.server, server))
              .limit(1)
          )[0];
    return row ? tokenBundleView(row, server) : undefined;
  }

  async listTokenBundles(): Promise<StoredOAuthTokenBundleView[]> {
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.backendAuthStates)
            .orderBy(asc(sqlite.backendAuthStates.server))
            .all()
        : await this.database.db
            .select()
            .from(postgres.backendAuthStates)
            .orderBy(asc(postgres.backendAuthStates.server));
    return rows.map((row) => tokenBundleView(row, row.server));
  }

  async writeTokenBundle(
    bundle: StoredOAuthTokenBundle,
    options: BackendAuthMutationOptions = {},
  ): Promise<StoredOAuthTokenBundleView> {
    const server = bundle.server;
    validateServer(server);
    const validatedBundle: unknown = bundle;
    if (!isStoredOAuthTokenBundle(validatedBundle)) {
      throw new CapletsError("REQUEST_INVALID", `Invalid OAuth token bundle for ${server}.`);
    }
    validateMutationOptions(options);
    return this.database.dialect === "sqlite"
      ? writeSqlite(this.database.db, validatedBundle, options)
      : await writePostgres(this.database.db, validatedBundle, options);
  }

  async assertLegacyBundlesImportable(bundles: StoredOAuthTokenBundle[]): Promise<void> {
    const validated = validateLegacyBundles(bundles);
    if (this.database.dialect === "sqlite") {
      assertLegacyBundlesMatchSqlite(this.database.db, validated);
    } else {
      await assertLegacyBundlesMatchPostgres(this.database.db, validated);
    }
  }

  async importLegacyBundles(bundles: StoredOAuthTokenBundle[]): Promise<void> {
    const validated = validateLegacyBundles(bundles);
    if (validated.length === 0) return;
    const timestamp = new Date().toISOString();
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) => {
        assertLegacyBundlesMatchSqlite(transaction, validated);
        const values = validated
          .filter(
            (bundle) =>
              !transaction
                .select({ server: sqlite.backendAuthStates.server })
                .from(sqlite.backendAuthStates)
                .where(eq(sqlite.backendAuthStates.server, bundle.server))
                .get(),
          )
          .map((bundle) => ({
            server: bundle.server,
            generation: 1,
            tokenBundle: bundle,
            createdAt: timestamp,
            updatedAt: timestamp,
          }));
        if (values.length > 0) {
          transaction.insert(sqlite.backendAuthStates).values(values).run();
        }
      });
      return;
    }
    await this.database.db.transaction(async (transaction) => {
      for (const bundle of validated) await lockPostgresState(transaction, bundle.server);
      await assertLegacyBundlesMatchPostgres(transaction, validated);
      const existing = await transaction
        .select({ server: postgres.backendAuthStates.server })
        .from(postgres.backendAuthStates);
      const existingServers = new Set(existing.map((row) => row.server));
      const values = validated
        .filter((bundle) => !existingServers.has(bundle.server))
        .map((bundle) => ({
          server: bundle.server,
          generation: 1,
          tokenBundle: bundle,
          createdAt: timestamp,
          updatedAt: timestamp,
        }));
      if (values.length > 0) await transaction.insert(postgres.backendAuthStates).values(values);
    });
  }

  async verifyLegacyBundles(bundles: StoredOAuthTokenBundle[]): Promise<void> {
    for (const bundle of validateLegacyBundles(bundles)) {
      const stored = await this.readTokenBundle(bundle.server);
      if (!stored || stableJsonStringify(stored.bundle) !== stableJsonStringify(bundle)) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Backend auth state for ${bundle.server} failed post-migration verification.`,
        );
      }
    }
  }

  async deleteTokenBundle(
    server: string,
    options: BackendAuthMutationOptions = {},
  ): Promise<boolean> {
    validateServer(server);
    validateMutationOptions(options);
    return this.database.dialect === "sqlite"
      ? deleteSqlite(this.database.db, server, options)
      : await deletePostgres(this.database.db, server, options);
  }
}

type SqliteBackendAuthDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresBackendAuthDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];

function validateLegacyBundles(bundles: StoredOAuthTokenBundle[]): StoredOAuthTokenBundle[] {
  const servers = new Set<string>();
  const validated = bundles.map((bundle) => {
    const candidate: unknown = bundle;
    if (!isStoredOAuthTokenBundle(candidate)) {
      throw new CapletsError("CONFIG_INVALID", "A legacy OAuth token bundle is invalid.");
    }
    validateServer(candidate.server);
    if (servers.has(candidate.server)) {
      throw new CapletsError("CONFIG_INVALID", "Legacy OAuth token bundles contain duplicates.");
    }
    servers.add(candidate.server);
    return candidate;
  });
  return validated.sort((left, right) => left.server.localeCompare(right.server));
}

function assertLegacyBundlesMatchSqlite(
  database: SqliteBackendAuthDatabase,
  bundles: StoredOAuthTokenBundle[],
): void {
  for (const bundle of bundles) {
    const row = database
      .select()
      .from(sqlite.backendAuthStates)
      .where(eq(sqlite.backendAuthStates.server, bundle.server))
      .get();
    if (
      row &&
      stableJsonStringify(tokenBundleView(row, bundle.server).bundle) !==
        stableJsonStringify(bundle)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Backend auth state for ${bundle.server} conflicts with the legacy snapshot.`,
      );
    }
  }
}

async function assertLegacyBundlesMatchPostgres(
  database: PostgresBackendAuthDatabase,
  bundles: StoredOAuthTokenBundle[],
): Promise<void> {
  for (const bundle of bundles) {
    const [row] = await database
      .select()
      .from(postgres.backendAuthStates)
      .where(eq(postgres.backendAuthStates.server, bundle.server))
      .limit(1);
    if (
      row &&
      stableJsonStringify(tokenBundleView(row, bundle.server).bundle) !==
        stableJsonStringify(bundle)
    ) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Backend auth state for ${bundle.server} conflicts with the legacy snapshot.`,
      );
    }
  }
}

function writeSqlite(
  db: SqliteHostDatabase,
  bundle: StoredOAuthTokenBundle,
  options: BackendAuthMutationOptions,
): StoredOAuthTokenBundleView {
  return db.transaction((transaction) => {
    const current = transaction
      .select()
      .from(sqlite.backendAuthStates)
      .where(eq(sqlite.backendAuthStates.server, bundle.server))
      .get();
    if (current) tokenBundleView(current, bundle.server);
    assertExpectedGeneration(current, options.expectedGeneration);
    const generation = (current?.generation ?? 0) + 1;
    const now = new Date().toISOString();
    transaction
      .insert(sqlite.backendAuthStates)
      .values({
        server: bundle.server,
        generation,
        tokenBundle: bundle,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sqlite.backendAuthStates.server,
        set: { generation, tokenBundle: bundle, updatedAt: now },
      })
      .run();
    if (options.operatorClientId) {
      transaction
        .insert(sqlite.operatorActivity)
        .values(
          activityValues(
            options.operatorClientId,
            "backend_auth_written",
            bundle.server,
            generation,
            now,
          ),
        )
        .run();
    }
    return { bundle, generation };
  });
}

async function writePostgres(
  db: PostgresHostDatabase,
  bundle: StoredOAuthTokenBundle,
  options: BackendAuthMutationOptions,
): Promise<StoredOAuthTokenBundleView> {
  return await db.transaction(async (transaction) => {
    await lockPostgresState(transaction, bundle.server);
    const [current] = await transaction
      .select()
      .from(postgres.backendAuthStates)
      .where(eq(postgres.backendAuthStates.server, bundle.server))
      .for("update")
      .limit(1);
    if (current) tokenBundleView(current, bundle.server);
    assertExpectedGeneration(current, options.expectedGeneration);
    const generation = (current?.generation ?? 0) + 1;
    const now = new Date().toISOString();
    await transaction
      .insert(postgres.backendAuthStates)
      .values({
        server: bundle.server,
        generation,
        tokenBundle: bundle,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: postgres.backendAuthStates.server,
        set: { generation, tokenBundle: bundle, updatedAt: now },
      });
    if (options.operatorClientId) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activityValues(
            options.operatorClientId,
            "backend_auth_written",
            bundle.server,
            generation,
            now,
          ),
        );
    }
    return { bundle, generation };
  });
}

function deleteSqlite(
  db: SqliteHostDatabase,
  server: string,
  options: BackendAuthMutationOptions,
): boolean {
  return db.transaction((transaction) => {
    const current = transaction
      .select()
      .from(sqlite.backendAuthStates)
      .where(eq(sqlite.backendAuthStates.server, server))
      .get();
    if (current) tokenBundleView(current, server);
    assertExpectedGeneration(current, options.expectedGeneration);
    if (!current) return false;
    const now = new Date().toISOString();
    transaction
      .delete(sqlite.backendAuthStates)
      .where(eq(sqlite.backendAuthStates.server, server))
      .run();
    if (options.operatorClientId) {
      transaction
        .insert(sqlite.operatorActivity)
        .values(
          activityValues(
            options.operatorClientId,
            "backend_auth_deleted",
            server,
            current.generation,
            now,
          ),
        )
        .run();
    }
    return true;
  });
}

async function deletePostgres(
  db: PostgresHostDatabase,
  server: string,
  options: BackendAuthMutationOptions,
): Promise<boolean> {
  return await db.transaction(async (transaction) => {
    await lockPostgresState(transaction, server);
    const [current] = await transaction
      .select()
      .from(postgres.backendAuthStates)
      .where(eq(postgres.backendAuthStates.server, server))
      .for("update")
      .limit(1);
    if (current) tokenBundleView(current, server);
    assertExpectedGeneration(current, options.expectedGeneration);
    if (!current) return false;
    const now = new Date().toISOString();
    await transaction
      .delete(postgres.backendAuthStates)
      .where(eq(postgres.backendAuthStates.server, server));
    if (options.operatorClientId) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activityValues(
            options.operatorClientId,
            "backend_auth_deleted",
            server,
            current.generation,
            now,
          ),
        );
    }
    return true;
  });
}

async function lockPostgresState(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  server: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["backend-auth", server])}, 0))`,
  );
}

function tokenBundleView(row: BackendAuthRow, expectedServer: string): StoredOAuthTokenBundleView {
  if (
    row.server !== expectedServer ||
    !Number.isInteger(row.generation) ||
    row.generation < 1 ||
    !isStoredOAuthTokenBundle(row.tokenBundle) ||
    row.tokenBundle.server !== expectedServer
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      `Stored backend auth state for ${expectedServer} is invalid.`,
    );
  }
  return { bundle: row.tokenBundle, generation: row.generation };
}

function assertExpectedGeneration(
  current: Pick<BackendAuthRow, "generation"> | undefined,
  expectedGeneration: number | undefined,
): void {
  if (expectedGeneration === undefined) return;
  if (current?.generation === expectedGeneration) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Authoritative Host State changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedGeneration,
      currentGeneration: current?.generation ?? 0,
    },
  );
}

function activityValues(
  operatorClientId: string,
  action: "backend_auth_written" | "backend_auth_deleted",
  server: string,
  generation: number,
  createdAt: string,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind: "backend_auth",
    targetKey: server,
    outcome: "succeeded",
    metadata: { generation },
    createdAt,
  };
}

function validateServer(server: string): void {
  if (!server.trim() || server.includes("/") || server.includes("\\") || server.includes("..")) {
    throw new CapletsError("REQUEST_INVALID", `Invalid auth store server name ${server}`);
  }
}

function validateMutationOptions(options: BackendAuthMutationOptions): void {
  if (options.operatorClientId !== undefined && !options.operatorClientId.trim()) {
    throw new CapletsError("REQUEST_INVALID", "Operator client ID is required when provided.");
  }
}
