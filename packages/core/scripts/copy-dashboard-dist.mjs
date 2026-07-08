import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const repoRoot = dirname(dirname(packageRoot));
const sourceDir = join(repoRoot, "apps/dashboard/dist");
const targetDir = join(packageRoot, "dist/dashboard-static");

if (!existsSync(sourceDir)) {
  process.stderr.write(
    `Dashboard build output not found at ${sourceDir}. Run pnpm --filter @caplets/dashboard build first.\n`,
  );
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
