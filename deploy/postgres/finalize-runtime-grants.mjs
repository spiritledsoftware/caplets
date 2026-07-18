#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/app/dist/index.js");
const { Pool } = require("pg");
const configPath = process.env.CAPLETS_CONFIG || "/tmp/caplets-migrator-config.json";
const storage = JSON.parse(readFileSync(configPath, "utf8")).storage;
if (storage?.type !== "postgres" || typeof storage.connectionString !== "string") {
  throw new Error("rendered PostgreSQL migrator config is required");
}
const schema = storage.schema || "caplets";
if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
  throw new Error("invalid PostgreSQL schema");
}
const quotedSchema = `"${schema}"`;
const runtimeRole = "caplets_runtime";
const pool = new Pool({ connectionString: storage.connectionString });

try {
  await pool.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${runtimeRole}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedSchema} TO ${runtimeRole}`,
  );
  await pool.query(
    `REVOKE ALL ON TABLE ${quotedSchema}."caplets_migrations", ${quotedSchema}."caplets_schema" FROM ${runtimeRole}`,
  );
  await pool.query(`GRANT SELECT ON TABLE ${quotedSchema}."caplets_schema" TO ${runtimeRole}`);

  const sequences = await pool.query(
    `SELECT sequence.relname AS sequence_name, owner_table.relname AS owner_table
       FROM pg_class sequence
       JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
       LEFT JOIN pg_depend dependency
         ON dependency.objid = sequence.oid AND dependency.deptype IN ('a', 'i')
       LEFT JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid
      WHERE sequence.relkind = 'S' AND namespace.nspname = $1`,
    [schema],
  );
  for (const row of sequences.rows) {
    const sequence = `"${String(row.sequence_name).replaceAll('"', '""')}"`;
    if (row.owner_table === "caplets_migrations" || row.owner_table === "caplets_schema") {
      await pool.query(`REVOKE ALL ON SEQUENCE ${quotedSchema}.${sequence} FROM ${runtimeRole}`);
    } else {
      await pool.query(
        `GRANT USAGE, SELECT ON SEQUENCE ${quotedSchema}.${sequence} TO ${runtimeRole}`,
      );
    }
  }
} finally {
  await pool.end();
}
