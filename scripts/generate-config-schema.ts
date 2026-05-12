import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configJsonSchema } from "../src/config.js";

const schemaPath = "schemas/caplets-config.schema.json";
const next = formatJson(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);

if (process.argv.includes("--check")) {
  const current = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
  if (current !== next) {
    console.error(`${schemaPath} is out of date. Run pnpm schema:generate.`);
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(schemaPath, next);
  console.log(`Generated ${schemaPath}`);
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
