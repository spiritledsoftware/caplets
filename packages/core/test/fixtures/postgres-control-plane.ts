import { createRequire } from "node:module";
import { createArtifactProviderIdentity } from "../../src/control-plane/artifacts/provider";
import {
  attachVerifiedPostgresPools,
  type PostgresControlPlaneDialect,
  type PostgresPool,
} from "../../src/control-plane/dialect/postgres";
import {
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../../src/control-plane/dialect/migrations";
import type { ResolvedPostgresStorage } from "../../src/control-plane/storage-config";
import type { ControlPlaneStoreIdentity } from "../../src/control-plane/types";

const require = createRequire(import.meta.url);

type PostgresPoolConstructor = new (
  configuration: Readonly<Record<string, unknown>>,
) => PostgresPool;

export type PostgresRuntimeNodeFixture = Readonly<{
  dialect: PostgresControlPlaneDialect;
  close(): Promise<void>;
}>;

export type PostgresControlPlaneFixture = Readonly<{
  dialect: PostgresControlPlaneDialect;
  adminQuery<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  openRuntimeNode(): Promise<PostgresRuntimeNodeFixture>;
  close(): Promise<void>;
}>;

export async function openPostgresControlPlaneFixture(
  input: Readonly<{
    adminUrl: string;
    assetRoot: string;
    identity: ControlPlaneStoreIdentity;
    environment: MigrationEnvironment;
    rolePrefix: string;
    keyProviderManifest: string;
  }>,
): Promise<PostgresControlPlaneFixture> {
  const Pool = postgresPoolConstructor();
  const admin = new Pool({ connectionString: input.adminUrl, max: 2 });
  const runtimeRole = `${input.rolePrefix}_runtime`;
  const migratorRole = `${input.rolePrefix}_migrator`;
  const maintenanceRole = `${input.rolePrefix}_maintenance`;
  const runtimePassword = `${input.rolePrefix}-runtime-password`;
  const migratorPassword = `${input.rolePrefix}-migrator-password`;
  const maintenancePassword = `${input.rolePrefix}-maintenance-password`;
  const databaseName = new URL(input.adminUrl).pathname.slice(1);
  const runtimeDialects = new Set<PostgresControlPlaneDialect>();
  let dialect: PostgresControlPlaneDialect | undefined;
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS caplets CASCADE;
      DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)};
      DROP ROLE IF EXISTS ${quoteIdentifier(migratorRole)};
      DROP ROLE IF EXISTS ${quoteIdentifier(maintenanceRole)};
      CREATE ROLE ${quoteIdentifier(runtimeRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${runtimePassword}';
      CREATE ROLE ${quoteIdentifier(migratorRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${migratorPassword}';
      CREATE ROLE ${quoteIdentifier(maintenanceRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${maintenancePassword}';
      GRANT CREATE ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(migratorRole)};
    `);
    const storage = postgresStorage(input.identity, input.keyProviderManifest);
    const registry = await loadMigrationRegistry({
      dialect: "postgres",
      assetRoot: input.assetRoot,
    });
    dialect = await attachVerifiedPostgresPools({
      storage,
      pools: postgresPools(Pool, input.adminUrl, [
        [runtimeRole, runtimePassword],
        [migratorRole, migratorPassword],
        [maintenanceRole, maintenancePassword],
      ]),
      roles: {
        runtime: runtimeRole,
        migrator: migratorRole,
        maintenance: maintenanceRole,
      },
      registry,
      environment: input.environment,
    });
    await dialect.migrate();
    await admin.query(`
      GRANT USAGE ON SCHEMA caplets TO ${quoteIdentifier(runtimeRole)};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caplets
        TO ${quoteIdentifier(runtimeRole)};
      REVOKE UPDATE, DELETE ON caplets.cp_operator_activity FROM ${quoteIdentifier(runtimeRole)};
      REVOKE INSERT, UPDATE, DELETE ON caplets.cp_retention FROM ${quoteIdentifier(runtimeRole)};
      REVOKE ALL ON ALL TABLES IN SCHEMA caplets FROM ${quoteIdentifier(maintenanceRole)};
    `);
    const openDialect = dialect;
    return {
      dialect: openDialect,
      async adminQuery<T>(sql: string, parameters: readonly unknown[] = []) {
        const result = await admin.query(sql, parameters);
        return result.rows as readonly T[];
      },
      async openRuntimeNode() {
        const pools = postgresPools(
          Pool,
          input.adminUrl,
          [
            [runtimeRole, runtimePassword],
            [migratorRole, migratorPassword],
            [maintenanceRole, maintenancePassword],
          ],
          2,
        );
        let nodeDialect: PostgresControlPlaneDialect | undefined;
        try {
          nodeDialect = await attachVerifiedPostgresPools({
            storage,
            pools,
            roles: {
              runtime: runtimeRole,
              migrator: migratorRole,
              maintenance: maintenanceRole,
            },
            registry,
            environment: input.environment,
          });
          const openedDialect = nodeDialect;
          await openedDialect.migrate();
          runtimeDialects.add(openedDialect);
          let closed = false;
          return {
            dialect: openedDialect,
            async close() {
              if (closed) return;
              closed = true;
              runtimeDialects.delete(openedDialect);
              await openedDialect.close();
            },
          };
        } catch (error) {
          await nodeDialect?.close().catch(() => undefined);
          if (!nodeDialect) await closePools(pools);
          throw error;
        }
      },
      async close() {
        await Promise.all(
          [...runtimeDialects].map((nodeDialect) => nodeDialect.close().catch(() => undefined)),
        );
        runtimeDialects.clear();
        await openDialect.close();
        await dropFixture(admin, runtimeRole, migratorRole, maintenanceRole);
      },
    };
  } catch (error) {
    await dialect?.close().catch(() => undefined);
    await dropFixture(admin, runtimeRole, migratorRole, maintenanceRole);
    throw error;
  }
}
export async function inspectPostgresControlPlaneFixtureCleanup(
  adminUrl: string,
  rolePrefix: string,
): Promise<Readonly<{ schemaPresent: boolean; roles: readonly string[] }>> {
  const Pool = postgresPoolConstructor();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const result = await admin.query(
      `SELECT to_regnamespace('caplets') IS NOT NULL AS "schemaPresent",
        to_jsonb(ARRAY(
          SELECT rolname
          FROM pg_roles
          WHERE rolname = ANY($1)
          ORDER BY rolname
        )) AS roles`,
      [[`${rolePrefix}_runtime`, `${rolePrefix}_migrator`, `${rolePrefix}_maintenance`]],
    );
    const row = result.rows[0] as
      | Readonly<{ schemaPresent: boolean; roles: readonly string[] }>
      | undefined;
    if (!row) throw new Error("Postgres cleanup inspection returned no row");
    return row;
  } finally {
    await admin.end();
  }
}

function postgresPoolConstructor(): PostgresPoolConstructor {
  const moduleValue: unknown = require("pg");
  if (!moduleValue || typeof moduleValue !== "object" || !("Pool" in moduleValue)) {
    throw new Error("Postgres test driver does not expose Pool");
  }
  const Pool = moduleValue.Pool;
  if (typeof Pool !== "function") throw new Error("Postgres test Pool is invalid");
  return Pool as PostgresPoolConstructor;
}

function postgresPools(
  Pool: PostgresPoolConstructor,
  adminUrl: string,
  credentials: readonly (readonly [string, string])[],
  max = 4,
) {
  const [runtime, migrator, maintenance] = credentials.map(([role, password]) => {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return new Pool({ connectionString: url.href, max });
  });
  if (!runtime || !migrator || !maintenance) {
    throw new Error("Postgres fixture roles are incomplete");
  }
  return { runtime, migrator, maintenance };
}

function postgresStorage(
  identity: ControlPlaneStoreIdentity,
  keyProviderManifest: string,
): ResolvedPostgresStorage {
  return {
    backend: "postgres",
    ...identity,
    stateRoot: "/tmp/caplets-u6-postgres",
    keyProviderManifest,
    artifacts: {
      kind: "s3",
      identity: createArtifactProviderIdentity({
        kind: "s3",
        provider: "https://objects.invalid/caplets",
        namespace: "u6-conformance",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
      }),
    },
  };
}

async function closePools(pools: {
  runtime: PostgresPool;
  migrator: PostgresPool;
  maintenance: PostgresPool;
}): Promise<void> {
  await Promise.all([
    pools.runtime.end().catch(() => undefined),
    pools.migrator.end().catch(() => undefined),
    pools.maintenance.end().catch(() => undefined),
  ]);
}

async function dropFixture(
  admin: PostgresPool,
  runtimeRole: string,
  migratorRole: string,
  maintenanceRole: string,
): Promise<void> {
  try {
    await admin.query("DROP SCHEMA IF EXISTS caplets CASCADE");
    for (const role of [runtimeRole, migratorRole, maintenanceRole]) {
      const identifier = quoteIdentifier(role);
      await admin.query(`DROP OWNED BY ${identifier} CASCADE`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${identifier}`).catch(() => undefined);
    }
  } finally {
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("Unsafe Postgres fixture identifier");
  return `"${value}"`;
}
