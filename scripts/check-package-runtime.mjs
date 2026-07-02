import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const result = spawnSync(
  process.execPath,
  [join(repoRoot, "packages/cli/dist/index.js"), "--version"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  },
);

if (result.status !== 0) {
  process.stderr.write("Built Caplets CLI failed to start with --version.\n");
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const version = result.stdout.trim();
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
  process.stderr.write(
    `Built Caplets CLI printed an invalid version: ${JSON.stringify(version)}\n`,
  );
  process.exit(1);
}
