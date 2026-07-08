import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const repoRoot = dirname(dirname(packageRoot));
const dashboardDir = join(repoRoot, "apps/dashboard");
const dashboardDistDir = join(dashboardDir, "dist");

if (process.env.TURBO_HASH && existsSync(dashboardDistDir)) {
  console.log(
    "Skipping nested dashboard build because Turbo already scheduled @caplets/dashboard#build.",
  );
  process.exit(0);
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["--dir", dashboardDir, "build"], { stdio: "inherit" });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
