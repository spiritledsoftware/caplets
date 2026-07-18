import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(dirname(here), "src/storage/drizzle/postgres");

for (const name of readdirSync(migrationsDir)) {
  if (!name.endsWith(".sql")) continue;
  const path = join(migrationsDir, name);
  const sql = readFileSync(path, "utf8");
  const normalized = sql.replaceAll('REFERENCES "public".', "REFERENCES ");
  if (normalized !== sql) writeFileSync(path, normalized);
}
