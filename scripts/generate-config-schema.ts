import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capletJsonSchema } from "../packages/core/src/caplet-files.js";
import { configJsonSchema } from "../packages/core/src/config.js";

const repoRoot = join(process.cwd(), "../..");
const schemas = [
  { path: join(repoRoot, "schemas/caplets-config.schema.json"), schema: configJsonSchema() },
  { path: join(repoRoot, "schemas/caplet.schema.json"), schema: capletJsonSchema() },
];

if (process.argv.includes("--check")) {
  for (const entry of schemas) {
    const next = formatJson(`${JSON.stringify(entry.schema, null, 2)}\n`);
    const current = existsSync(entry.path) ? readFileSync(entry.path, "utf8") : "";
    if (current !== next) {
      console.error(`${entry.path} is out of date. Run pnpm schema:generate.`);
      process.exitCode = 1;
    }
  }
} else {
  for (const entry of schemas) {
    const next = formatJson(`${JSON.stringify(entry.schema, null, 2)}\n`);
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, next);
    console.log(`Generated ${entry.path}`);
  }
}

function formatJson(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-schema-"));
  const path = join(dir, "schema.json");
  try {
    writeFileSync(path, value);
    execFileSync("pnpm", ["exec", "oxfmt", path], { stdio: "ignore" });
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
