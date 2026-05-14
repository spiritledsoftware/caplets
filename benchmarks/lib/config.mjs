import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkServerDefinitions } from "./surface.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CAPLETS_CLI_PATH = join(REPO_ROOT, "dist", "index.js");

export function getBenchmarkPaths({ repoRoot = REPO_ROOT } = {}) {
  const absoluteRepoRoot = resolve(repoRoot);
  return {
    repoRoot: absoluteRepoRoot,
    fixtureServerPath: join(absoluteRepoRoot, "benchmarks", "fixtures", "mcp-server.mjs"),
    capletsCliPath: join(absoluteRepoRoot, "dist", "index.js"),
  };
}

export function createBenchmarkFixtureMcpServers({
  repoRoot = REPO_ROOT,
  fixtureServerPath,
  cwd,
  extra = {},
  ...inlineExtra
} = {}) {
  const paths = getBenchmarkPaths({ repoRoot });
  const serverPath = resolve(fixtureServerPath ?? paths.fixtureServerPath);
  const serverCwd = resolve(cwd ?? paths.repoRoot);
  const serverExtra = { ...inlineExtra, ...extra };
  return Object.fromEntries(
    Object.entries(benchmarkServerDefinitions()).map(([server, definition]) => [
      server,
      {
        ...definition,
        ...serverExtra,
        command: process.execPath,
        args: [serverPath, "--server", server],
        cwd: serverCwd,
      },
    ]),
  );
}

export async function stageBenchmarkMcpSupportFiles({
  rootDir,
  repoRoot = REPO_ROOT,
  supportDir = rootDir ? join(resolve(rootDir), "support") : undefined,
} = {}) {
  if (!supportDir) {
    throw new TypeError("stageBenchmarkMcpSupportFiles requires rootDir or supportDir.");
  }
  const paths = getBenchmarkPaths({ repoRoot });
  const absoluteSupportDir = resolve(supportDir);
  const fixtureServerPath = join(absoluteSupportDir, "mcp-server.mjs");

  await mkdir(absoluteSupportDir, { recursive: true });
  await copyFile(paths.fixtureServerPath, fixtureServerPath);

  return {
    supportDir: absoluteSupportDir,
    fixtureServerPath,
  };
}

export async function createBenchmarkCapletsConfig({
  rootDir,
  repoRoot = REPO_ROOT,
  capletsCliPath,
  requireBuild = false,
} = {}) {
  const baseDir = rootDir
    ? resolve(rootDir)
    : await mkdtemp(join(tmpdir(), "caplets-benchmark-config-"));
  const createdTempDir = !rootDir;
  const paths = getBenchmarkPaths({ repoRoot });
  const cliPath = resolve(capletsCliPath ?? paths.capletsCliPath);

  if (requireBuild) {
    await assertBuiltCapletsCli(cliPath);
  }

  await mkdir(baseDir, { recursive: true });
  const support = await stageBenchmarkMcpSupportFiles({
    rootDir: baseDir,
    repoRoot: paths.repoRoot,
  });
  const configPath = join(baseDir, "caplets.config.json");
  const config = {
    mcpServers: createBenchmarkFixtureMcpServers({
      repoRoot: paths.repoRoot,
      fixtureServerPath: support.fixtureServerPath,
      cwd: support.supportDir,
    }),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const env = { CAPLETS_CONFIG: configPath };
  const command = process.execPath;
  const args = [cliPath];
  const cwd = support.supportDir;

  return {
    configPath,
    config,
    repoRoot: paths.repoRoot,
    supportDir: support.supportDir,
    fixtureServerPath: support.fixtureServerPath,
    cleanupPath: baseDir,
    cleanup: async () => {
      if (createdTempDir) {
        await rm(baseDir, { recursive: true, force: true });
      }
    },
    caplets: {
      command,
      args,
      cwd,
      env,
      mcpServer: { command, args, cwd, env },
    },
  };
}

async function assertBuiltCapletsCli(capletsCliPath = CAPLETS_CLI_PATH) {
  try {
    await access(capletsCliPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Caplets benchmark live mode requires the built CLI at ${capletsCliPath}. Run \`pnpm build\` before live Caplets benchmark runs.`,
      );
    }
    throw error;
  }
}
