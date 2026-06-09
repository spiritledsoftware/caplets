import { access, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkFixtureMcpServers, getBenchmarkPaths } from "../config";

export const PI_EVAL_MODES = [
  "caplets-direct",
  "caplets-progressive",
  "caplets-code-mode",
  "caplets-progressive-code-mode",
] as const;

export const DEFAULT_PI_EVAL_TASKS = ["checkout-incident-retry-hardening"];
export const DEFAULT_PI_EVAL_RUNS = 1;

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const coreRoot = resolve(packageRoot, "../..");
const defaultPiExtensionPath = resolve(coreRoot, "packages", "pi", "dist", "index.js");
const defaultNodeModulesBin = resolve(coreRoot, "node_modules", ".bin");
const instrumentationSourcePath = resolve(
  packageRoot,
  "lib",
  "pi-eval",
  "instrumentation-extension.ts",
);
const instrumentationMetricsSourcePath = resolve(packageRoot, "lib", "pi-eval", "metrics.ts");
const defaultPiAgentSourceDir = resolve(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
);
const PI_AUTH_FILES_TO_COPY = ["auth.json", "models.json"] as const;

const exposureByMode = {
  "caplets-direct": "direct",
  "caplets-progressive": "progressive",
  "caplets-code-mode": "code_mode",
  "caplets-progressive-code-mode": "progressive_and_code_mode",
} as const;

export function validatePiEvalMode(mode: string): asserts mode is (typeof PI_EVAL_MODES)[number] {
  if (!(PI_EVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unknown Pi eval mode ${mode}. Expected one of: ${PI_EVAL_MODES.join(", ")}`);
  }
}

export function buildPiEvalPrompt(task: any, mode: string): string {
  validatePiEvalMode(mode);
  const hints = {
    "caplets-direct": "Direct Caplets tools are exposed as caplets__<server>__<tool>.",
    "caplets-progressive":
      "Caplets capability tools expose inspect/list/search/describe/call operations; use describe before call when args matter.",
    "caplets-code-mode":
      "Use caplets_code_mode for Caplets discovery and compact retrieval in one external call; return only the facts needed for the edit.",
    "caplets-progressive-code-mode":
      "Both Caplets capability tools and caplets_code_mode are available; choose the shortest reliable path.",
  } as const;
  return [
    "You are running a benchmark. Complete the task in this workspace.",
    "Use the available external context tools to inspect current issue, CI, docs, and API facts before editing files.",
    "Do not hard-code test-only behavior.",
    "After editing, run the visible validation command if practical.",
    hints[mode],
    "",
    task.prompt,
  ].join("\n");
}

export function buildPiEvalCommand({
  command = "pi",
  prompt,
  model,
  extensionPaths = [],
  extraArgs = [],
}: any = {}) {
  if (!prompt) throw new TypeError("buildPiEvalCommand requires a prompt.");
  const args = [
    "--mode",
    "json",
    "-p",
    prompt,
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
  ];
  if (model) args.push("--model", model);
  for (const extensionPath of extensionPaths) args.push("-e", extensionPath);
  args.push(...extraArgs);
  return { command, args };
}

export async function createPiEvalRunConfig({
  rootDir,
  mode,
  requireBuild = false,
  piExtensionPath = defaultPiExtensionPath,
  repoRoot: inputRepoRoot = packageRoot,
  piAgentSourceDir = defaultPiAgentSourceDir,
}: any = {}) {
  validatePiEvalMode(mode);
  const runRoot = rootDir ? resolve(rootDir) : await mkdtemp(join(tmpdir(), "caplets-pi-eval-"));
  const paths = getBenchmarkPaths({ repoRoot: inputRepoRoot });
  const supportDir = join(runRoot, "support");
  const fixtureServerPath = join(supportDir, "mcp-server.ts");
  const modeDir = join(runRoot, mode);
  const configPath = join(modeDir, "caplets.config.json");
  const xdgConfigHome = join(runRoot, "xdg-config", mode);
  const xdgCapletsConfigPath = join(xdgConfigHome, "caplets", "config.json");
  const sessionsDir = join(runRoot, "sessions");
  const agentDir = join(runRoot, "agent");
  const extensionDir = join(runRoot, "extensions");
  const instrumentationPath = join(extensionDir, "instrumentation-extension.ts");
  const instrumentationMetricsPath = join(extensionDir, "metrics.ts");
  const metricsPath = join(runRoot, "metrics.jsonl");

  if (requireBuild) await assertBuiltPiExtension(piExtensionPath);
  await mkdir(supportDir, { recursive: true });
  await mkdir(modeDir, { recursive: true });
  await mkdir(dirname(xdgCapletsConfigPath), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await copyFile(paths.fixtureServerPath, fixtureServerPath);
  await copyFile(instrumentationSourcePath, instrumentationPath);
  await copyFile(instrumentationMetricsSourcePath, instrumentationMetricsPath);
  const copiedPiAuthFiles = await copyPiAuthFiles({
    sourceDir: piAgentSourceDir,
    targetDir: agentDir,
  });

  const config = {
    options: { exposure: exposureByMode[mode] },
    mcpServers: createBenchmarkFixtureMcpServers({
      repoRoot: inputRepoRoot,
      fixtureServerPath,
      cwd: supportDir,
      servers: ["issues", "ci", "docs", "api", "code-map"],
    }),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(xdgCapletsConfigPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    runRoot,
    mode,
    config,
    configPath,
    xdgConfigHome,
    xdgCapletsConfigPath,
    supportDir,
    fixtureServerPath,
    metricsPath,
    agentDir,
    piAgentSourceDir,
    copiedPiAuthFiles,
    sessionsDir,
    instrumentationPath,
    extensionPaths: [instrumentationPath, resolve(piExtensionPath)],
    env: {
      CAPLETS_CONFIG: configPath,
      CAPLETS_PI_EVAL_METRICS: metricsPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      CAPLETS_MODE: "local",
      PATH: `${defaultNodeModulesBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    },
  };
}

async function copyPiAuthFiles({ sourceDir, targetDir }: { sourceDir: string; targetDir: string }) {
  const copied = [];
  for (const filename of PI_AUTH_FILES_TO_COPY) {
    const sourcePath = resolve(sourceDir, filename);
    try {
      await access(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    await copyFile(sourcePath, resolve(targetDir, filename));
    copied.push(filename);
  }
  return copied;
}

async function assertBuiltPiExtension(piExtensionPath: string) {
  try {
    await access(piExtensionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `Pi eval requires the built @caplets/pi extension at ${piExtensionPath}. Run \`pnpm build\` before live Pi eval runs.`,
      );
    }
    throw error;
  }
}
