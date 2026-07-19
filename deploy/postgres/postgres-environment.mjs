import { readFileSync } from "node:fs";

export function readCredential(name) {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (direct && file) throw new Error(`set ${name} or ${name}_FILE, not both`);
  if (direct) return direct;
  if (!file) throw new Error(`${name} or ${name}_FILE is required`);
  const value = readFileSync(file, "utf8").replace(/\r?\n$/u, "");
  if (!value) throw new Error(`${name}_FILE must not be empty`);
  return value;
}

export function postgresSchema() {
  const schema = process.env.CAPLETS_POSTGRES_SCHEMA || "caplets";
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("CAPLETS_POSTGRES_SCHEMA must match ^[a-z_][a-z0-9_]{0,62}$");
  }
  return schema;
}

export function postgresConnectionString(user, password) {
  const connection = new URL("postgresql://localhost");
  connection.username = user;
  connection.password = password;
  connection.hostname = process.env.CAPLETS_POSTGRES_HOST || "caplets-postgres";
  connection.port = process.env.CAPLETS_POSTGRES_PORT || "5432";
  connection.pathname = `/${process.env.CAPLETS_POSTGRES_DATABASE || "caplets"}`;
  return connection.toString();
}

export function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}
