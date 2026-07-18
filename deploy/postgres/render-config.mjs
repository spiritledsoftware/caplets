#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "migrator" && mode !== "runtime") {
  throw new Error("usage: render-config.mjs <migrator|runtime>");
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const schema = process.env.CAPLETS_POSTGRES_SCHEMA || "caplets";
if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
  throw new Error("CAPLETS_POSTGRES_SCHEMA must match ^[a-z_][a-z0-9_]{0,62}$");
}

const role = mode === "migrator" ? "caplets_migrator" : "caplets_runtime";
const password = required(
  mode === "migrator" ? "CAPLETS_POSTGRES_MIGRATOR_PASSWORD" : "CAPLETS_POSTGRES_RUNTIME_PASSWORD",
);
const host = process.env.CAPLETS_POSTGRES_HOST || "caplets-postgres";
const port = process.env.CAPLETS_POSTGRES_PORT || "5432";
const database = process.env.CAPLETS_POSTGRES_DATABASE || "caplets";
const target = process.env.CAPLETS_CONFIG || "/tmp/caplets-config.json";
const basePath = process.env.CAPLETS_BASE_CONFIG;
const config =
  basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : { version: 1 };
const previousStorage = config.storage && typeof config.storage === "object" ? config.storage : {};
const connection = new URL("postgresql://localhost");
connection.username = role;
connection.password = password;
connection.hostname = host;
connection.port = port;
connection.pathname = `/${database}`;

config.storage = {
  type: "postgres",
  connectionString: connection.toString(),
  schema,
  ...(previousStorage.assets ? { assets: previousStorage.assets } : {}),
  ...(previousStorage.bundleLimits ? { bundleLimits: previousStorage.bundleLimits } : {}),
};

writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
