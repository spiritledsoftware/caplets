#!/usr/bin/env node

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import {
  postgresConnectionString,
  postgresSchema,
  quoteIdentifier,
  readCredential,
} from "./postgres-environment.mjs";

const require = createRequire("/app/dist/index.js");
const { Pool } = require("pg");
const mode = process.argv[2] || "hardened";
if (mode !== "convenience" && mode !== "hardened") {
  throw new Error("usage: provision-roles.mjs [convenience|hardened]");
}

const database = process.env.CAPLETS_POSTGRES_DATABASE || "caplets";
const schema = postgresSchema();
const connection =
  mode === "convenience"
    ? await connectConvenience()
    : await connect(
        process.env.CAPLETS_POSTGRES_ADMIN_USER || "caplets_admin",
        readCredential("CAPLETS_POSTGRES_ADMIN_PASSWORD"),
      );
const { client, pool } = connection;

try {
  await client.query("BEGIN");
  if (mode === "convenience") {
    await provisionConvenienceRole(connection.bootstrapRole);
  } else {
    await provisionHardenedRoles();
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function provisionConvenienceRole(bootstrapRole) {
  const role = "caplets";
  const quotedRole = quoteIdentifier(role);
  const password = readCredential("CAPLETS_POSTGRES_PASSWORD");
  if (bootstrapRole) {
    await reconcileRole(role, password);
  } else {
    await reconcileConvenienceRole(role, password);
  }

  const quotedDatabase = quoteIdentifier(database);
  const quotedSchema = quoteIdentifier(schema);
  await client.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM PUBLIC`);
  await client.query(`ALTER DATABASE ${quotedDatabase} OWNER TO ${quotedRole}`);
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema} AUTHORIZATION ${quotedRole}`);
  await client.query(`ALTER SCHEMA ${quotedSchema} OWNER TO ${quotedRole}`);
  await client.query(`REVOKE ALL ON SCHEMA ${quotedSchema} FROM PUBLIC`);
  await client.query(
    `ALTER ROLE ${quotedRole} IN DATABASE ${quotedDatabase} SET search_path TO ${quotedSchema}`,
  );
  if (bootstrapRole) await rotateBootstrapPassword(bootstrapRole);
}

async function reconcileConvenienceRole(role, password) {
  const result = await client.query(
    "SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (result.rowCount !== 1) throw new Error(`PostgreSQL role ${role} does not exist`);

  const current = result.rows[0];
  if (
    !current.rolcanlogin ||
    current.rolinherit ||
    current.rolsuper ||
    current.rolcreatedb ||
    current.rolcreaterole ||
    current.rolreplication ||
    current.rolbypassrls
  ) {
    throw new Error(`PostgreSQL role ${role} has unexpected attributes`);
  }

  const statement = await client.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
    [role, password],
  );
  await client.query(statement.rows[0].sql);
}

async function rotateBootstrapPassword(role) {
  const statement = await client.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
    [role, randomBytes(48).toString("base64url")],
  );
  await client.query(statement.rows[0].sql);
}

async function provisionHardenedRoles() {
  const migratorRole = "caplets_migrator";
  const runtimeRole = "caplets_runtime";
  const quotedMigratorRole = quoteIdentifier(migratorRole);
  const quotedRuntimeRole = quoteIdentifier(runtimeRole);
  const migratorPassword = readCredential("CAPLETS_POSTGRES_MIGRATOR_PASSWORD");
  const runtimePassword = readCredential("CAPLETS_POSTGRES_RUNTIME_PASSWORD");
  await reconcileRole(migratorRole, migratorPassword);
  await reconcileRole(runtimeRole, runtimePassword);

  const quotedDatabase = quoteIdentifier(database);
  const quotedSchema = quoteIdentifier(schema);
  await client.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT, CREATE ON DATABASE ${quotedDatabase} TO ${quotedMigratorRole}`,
  );
  await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedRuntimeRole}`);
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${quotedSchema} AUTHORIZATION ${quotedMigratorRole}`,
  );
  await client.query(`ALTER SCHEMA ${quotedSchema} OWNER TO ${quotedMigratorRole}`);
  await client.query(`REVOKE ALL ON SCHEMA ${quotedSchema} FROM PUBLIC`);
  await client.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRuntimeRole}`);
  await client.query(
    `ALTER ROLE ${quotedMigratorRole} IN DATABASE ${quotedDatabase} SET search_path TO ${quotedSchema}`,
  );
  await client.query(
    `ALTER ROLE ${quotedRuntimeRole} IN DATABASE ${quotedDatabase} SET search_path TO ${quotedSchema}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedMigratorRole} IN SCHEMA ${quotedSchema} REVOKE ALL ON TABLES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedMigratorRole} IN SCHEMA ${quotedSchema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRuntimeRole}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedMigratorRole} IN SCHEMA ${quotedSchema} REVOKE ALL ON SEQUENCES FROM PUBLIC`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedMigratorRole} IN SCHEMA ${quotedSchema} GRANT USAGE, SELECT ON SEQUENCES TO ${quotedRuntimeRole}`,
  );
}

async function reconcileRole(role, password) {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (existing.rowCount === 0) await client.query(`CREATE ROLE ${quoteIdentifier(role)}`);
  const statement = await client.query(
    "SELECT format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
    [role, password],
  );
  await client.query(statement.rows[0].sql);
}

async function connectConvenience() {
  const password = readCredential("CAPLETS_POSTGRES_PASSWORD");
  let applicationError;
  try {
    return { ...(await connect("caplets", password)), bootstrapRole: undefined };
  } catch (error) {
    applicationError = error;
  }

  const bootstrapRole = process.env.CAPLETS_POSTGRES_ADMIN_USER || "postgres";
  try {
    return { ...(await connect(bootstrapRole, password)), bootstrapRole };
  } catch {
    throw applicationError;
  }
}

async function connect(role, password) {
  const pool = new Pool({ connectionString: postgresConnectionString(role, password) });
  try {
    return { client: await pool.connect(), pool };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
