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
  "vanilla-mcp",
  "executor-mcp",
] as const;

export type PiEvalMode = (typeof PI_EVAL_MODES)[number];
export type PiEvalProduct = "caplets" | "mcp" | "executor";

export const DEFAULT_PI_EVAL_TASKS = ["checkout-incident-retry-hardening"];
export const DEFAULT_PI_EVAL_RUNS = 1;
export const VANILLA_MCP_PI_EVAL_MODE = "vanilla-mcp" as const;
export const EXECUTOR_PI_EVAL_MODE = "executor-mcp" as const;
export const PI_MCP_ADAPTER_EXTENSION_SOURCE = "npm:pi-mcp-adapter";
export const VANILLA_MCP_DIRECT_TOOLS_ENV = "issues,ci,docs,api,code-map";
export const EXECUTOR_MCP_DIRECT_TOOLS_ENV = "executor";
export const PI_MCP_ADAPTER_DIRECT_TOOLS_EXPOSURE = "direct-tools";
export const VANILLA_MCP_PI_EVAL_ADAPTER_EXPOSURE = PI_MCP_ADAPTER_DIRECT_TOOLS_EXPOSURE;
export const EXECUTOR_PI_EVAL_ADAPTER_EXPOSURE = PI_MCP_ADAPTER_DIRECT_TOOLS_EXPOSURE;

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
const PI_EVAL_FIXTURE_SERVERS = ["issues", "ci", "docs", "api", "code-map"] as const;

const exposureByMode = {
  "caplets-direct": "direct",
  "caplets-progressive": "progressive",
  "caplets-code-mode": "code_mode",
  "caplets-progressive-code-mode": "progressive_and_code_mode",
} as const;

export function validatePiEvalMode(mode: string): asserts mode is PiEvalMode {
  if (!(PI_EVAL_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unknown Pi eval mode ${mode}. Expected one of: ${PI_EVAL_MODES.join(", ")}`);
  }
}

export function piEvalModeProduct(mode: string): PiEvalProduct {
  validatePiEvalMode(mode);
  if (mode === VANILLA_MCP_PI_EVAL_MODE) return "mcp";
  return mode === EXECUTOR_PI_EVAL_MODE ? "executor" : "caplets";
}

export function isVanillaMcpPiEvalMode(mode: string): mode is typeof VANILLA_MCP_PI_EVAL_MODE {
  validatePiEvalMode(mode);
  return mode === VANILLA_MCP_PI_EVAL_MODE;
}

export function isExecutorPiEvalMode(mode: string): mode is typeof EXECUTOR_PI_EVAL_MODE {
  validatePiEvalMode(mode);
  return mode === EXECUTOR_PI_EVAL_MODE;
}

export function isPiMcpAdapterPiEvalMode(
  mode: string,
): mode is typeof VANILLA_MCP_PI_EVAL_MODE | typeof EXECUTOR_PI_EVAL_MODE {
  validatePiEvalMode(mode);
  return mode === VANILLA_MCP_PI_EVAL_MODE || mode === EXECUTOR_PI_EVAL_MODE;
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
    "vanilla-mcp":
      "The fixture MCP servers are exposed through pi-mcp-adapter as plain direct MCP tools, without Caplets or Executor. Use the issues_..., ci_..., docs_..., api_..., and code_map_... tools to inspect current issue, CI, docs, API facts, and code-map hints before editing.",
    "executor-mcp":
      "Executor is available through direct Pi tools registered by the MCP adapter. Use the executor_... tools to inspect current issue, CI, docs, API facts, and code-map hints before editing.",
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

export function buildPiEvalPrewarmPrompt() {
  return [
    "Prewarm the MCP adapter direct-tool cache for this benchmark.",
    "Do not inspect or edit repository files.",
    "If the mcp proxy tool is available, call it to connect to the configured server(s) and search for available tools, then stop.",
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

export async function createPiEvalRunConfig(input: any = {}): Promise<any> {
  validatePiEvalMode(input.mode);
  if (input.mode === VANILLA_MCP_PI_EVAL_MODE) {
    return await createVanillaMcpPiEvalRunConfig(input);
  }
  if (input.mode === EXECUTOR_PI_EVAL_MODE) {
    return await createExecutorPiEvalRunConfig(input);
  }
  return await createCapletsPiEvalRunConfig(input);
}

export async function createCapletsPiEvalRunConfig({
  rootDir,
  mode,
  requireBuild = false,
  piExtensionPath = defaultPiExtensionPath,
  repoRoot: inputRepoRoot = packageRoot,
  piAgentSourceDir = defaultPiAgentSourceDir,
  fixtureServerSourcePath,
  fixtureServers = [...PI_EVAL_FIXTURE_SERVERS],
}: any = {}): Promise<any> {
  validatePiEvalMode(mode);
  if (isPiMcpAdapterPiEvalMode(mode)) {
    throw new Error("createCapletsPiEvalRunConfig cannot build pi-mcp-adapter modes.");
  }
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
  await copyFile(fixtureServerSourcePath ?? paths.fixtureServerPath, fixtureServerPath);
  await copyFile(instrumentationSourcePath, instrumentationPath);
  await copyFile(instrumentationMetricsSourcePath, instrumentationMetricsPath);
  const copiedPiAuthFiles = await copyPiAuthFiles({
    sourceDir: piAgentSourceDir,
    targetDir: agentDir,
  });

  const config = {
    options: { exposure: exposureByMode[mode as keyof typeof exposureByMode] },
    mcpServers: createBenchmarkFixtureMcpServers({
      repoRoot: inputRepoRoot,
      fixtureServerPath,
      cwd: supportDir,
      servers: fixtureServers,
    }),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(xdgCapletsConfigPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    runRoot,
    mode,
    product: "caplets" as const,
    adapterExposure: null,
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
    extraArgs: [],
    env: {
      CAPLETS_CONFIG: configPath,
      CAPLETS_PI_EVAL_METRICS: metricsPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      CAPLETS_MODE: "local",
      PATH: benchmarkPath(),
    },
  };
}

export async function createVanillaMcpPiEvalRunConfig({
  rootDir,
  mode = VANILLA_MCP_PI_EVAL_MODE,
  repoRoot: inputRepoRoot = packageRoot,
  piAgentSourceDir = defaultPiAgentSourceDir,
  fixtureServerSourcePath,
  fixtureServers = [...PI_EVAL_FIXTURE_SERVERS],
  directToolsEnv = VANILLA_MCP_DIRECT_TOOLS_ENV,
}: any = {}): Promise<any> {
  validatePiEvalMode(mode);
  if (mode !== VANILLA_MCP_PI_EVAL_MODE) {
    throw new Error("createVanillaMcpPiEvalRunConfig only supports vanilla-mcp mode.");
  }

  const runRoot = rootDir ? resolve(rootDir) : await mkdtemp(join(tmpdir(), "caplets-pi-eval-"));
  const paths = getBenchmarkPaths({ repoRoot: inputRepoRoot });
  const supportDir = join(runRoot, "support");
  const fixtureServerPath = join(supportDir, "mcp-server.ts");
  const sessionsDir = join(runRoot, "sessions");
  const prewarmSessionsDir = join(runRoot, "prewarm-sessions");
  const agentDir = join(runRoot, "agent");
  const xdgConfigHome = join(runRoot, "xdg-config", mode);
  const extensionDir = join(runRoot, "extensions");
  const instrumentationPath = join(extensionDir, "instrumentation-extension.ts");
  const instrumentationMetricsPath = join(extensionDir, "metrics.ts");
  const metricsPath = join(runRoot, "metrics.jsonl");
  const prewarmMetricsPath = join(runRoot, "prewarm-metrics.jsonl");
  const adapterConfigPath = join(runRoot, "vanilla-mcp.json");
  const envPath = benchmarkPath();

  await mkdir(supportDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(prewarmSessionsDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(xdgConfigHome, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await copyFile(fixtureServerSourcePath ?? paths.fixtureServerPath, fixtureServerPath);
  await copyFile(instrumentationSourcePath, instrumentationPath);
  await copyFile(instrumentationMetricsSourcePath, instrumentationMetricsPath);
  const copiedPiAuthFiles = await copyPiAuthFiles({
    sourceDir: piAgentSourceDir,
    targetDir: agentDir,
  });

  const adapterConfig = createVanillaMcpAdapterConfig({
    repoRoot: inputRepoRoot,
    fixtureServerPath,
    supportDir,
    path: envPath,
    servers: fixtureServers,
  });
  await writeFile(adapterConfigPath, `${JSON.stringify(adapterConfig, null, 2)}\n`);

  return {
    runRoot,
    mode,
    product: "mcp" as const,
    adapterExposure: VANILLA_MCP_PI_EVAL_ADAPTER_EXPOSURE,
    config: adapterConfig,
    adapterConfig,
    adapterConfigPath,
    configPath: null,
    xdgConfigHome,
    xdgCapletsConfigPath: null,
    supportDir,
    fixtureServerPath,
    metricsPath,
    prewarmMetricsPath,
    agentDir,
    piAgentSourceDir,
    copiedPiAuthFiles,
    sessionsDir,
    prewarmSessionsDir,
    instrumentationPath,
    extensionPaths: [instrumentationPath, PI_MCP_ADAPTER_EXTENSION_SOURCE],
    extraArgs: ["--mcp-config", adapterConfigPath],
    env: {
      CAPLETS_PI_EVAL_METRICS: metricsPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      MCP_DIRECT_TOOLS: directToolsEnv,
      PATH: envPath,
    },
  };
}

export async function createExecutorPiEvalRunConfig({
  rootDir,
  mode = EXECUTOR_PI_EVAL_MODE,
  repoRoot: inputRepoRoot = packageRoot,
  piAgentSourceDir = defaultPiAgentSourceDir,
  executorCommand = "executor",
  fixtureServerSourcePath,
}: any = {}): Promise<any> {
  validatePiEvalMode(mode);
  if (mode !== EXECUTOR_PI_EVAL_MODE) {
    throw new Error("createExecutorPiEvalRunConfig only supports executor-mcp mode.");
  }

  const runRoot = rootDir ? resolve(rootDir) : await mkdtemp(join(tmpdir(), "caplets-pi-eval-"));
  const paths = getBenchmarkPaths({ repoRoot: inputRepoRoot });
  const supportDir = join(runRoot, "support");
  const fixtureServerPath = join(supportDir, "mcp-server.ts");
  const sessionsDir = join(runRoot, "sessions");
  const prewarmSessionsDir = join(runRoot, "prewarm-sessions");
  const agentDir = join(runRoot, "pi-agent");
  const adapterHomeDir = join(runRoot, "home");
  const xdgConfigHome = join(runRoot, "xdg-config", mode);
  const extensionDir = join(runRoot, "extensions");
  const instrumentationPath = join(extensionDir, "instrumentation-extension.ts");
  const instrumentationMetricsPath = join(extensionDir, "metrics.ts");
  const metricsPath = join(runRoot, "metrics.jsonl");
  const prewarmMetricsPath = join(runRoot, "prewarm-metrics.jsonl");
  const adapterConfigPath = join(runRoot, "executor-mcp.json");
  const executorDataDir = join(runRoot, "executor-data");
  const executorScopeDir = join(runRoot, "executor-scope");
  const envPath = benchmarkPath();

  await mkdir(supportDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(prewarmSessionsDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(adapterHomeDir, { recursive: true });
  await mkdir(xdgConfigHome, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await mkdir(executorDataDir, { recursive: true });
  await mkdir(executorScopeDir, { recursive: true });
  await copyFile(fixtureServerSourcePath ?? paths.fixtureServerPath, fixtureServerPath);
  await copyFile(instrumentationSourcePath, instrumentationPath);
  await copyFile(instrumentationMetricsSourcePath, instrumentationMetricsPath);
  const copiedPiAuthFiles = await copyPiAuthFiles({
    sourceDir: piAgentSourceDir,
    targetDir: agentDir,
  });

  const adapterConfig = createExecutorMcpAdapterConfig({
    executorCommand,
    executorDataDir,
    executorScopeDir,
    supportDir,
    path: envPath,
  });
  await writeFile(adapterConfigPath, `${JSON.stringify(adapterConfig, null, 2)}\n`);

  return {
    runRoot,
    mode,
    product: "executor" as const,
    adapterExposure: EXECUTOR_PI_EVAL_ADAPTER_EXPOSURE,
    config: adapterConfig,
    adapterConfig,
    adapterConfigPath,
    configPath: null,
    xdgConfigHome,
    xdgCapletsConfigPath: null,
    supportDir,
    fixtureServerPath,
    metricsPath,
    prewarmMetricsPath,
    agentDir,
    adapterHomeDir,
    adapterAgentDir: agentDir,
    piAgentSourceDir,
    copiedPiAuthFiles,
    sessionsDir,
    prewarmSessionsDir,
    instrumentationPath,
    executorCommand,
    executorDataDir,
    executorScopeDir,
    extensionPaths: [instrumentationPath, PI_MCP_ADAPTER_EXTENSION_SOURCE],
    extraArgs: ["--mcp-config", adapterConfigPath],
    env: {
      CAPLETS_PI_EVAL_METRICS: metricsPath,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      HOME: adapterHomeDir,
      MCP_DIRECT_TOOLS: EXECUTOR_MCP_DIRECT_TOOLS_ENV,
      EXECUTOR_DATA_DIR: executorDataDir,
      EXECUTOR_SCOPE_DIR: executorScopeDir,
      PATH: envPath,
    },
  };
}

export function createExecutorMcpAdapterConfig({
  executorCommand = "executor",
  executorDataDir,
  executorScopeDir,
  supportDir,
  path = benchmarkPath(),
}: any = {}) {
  return {
    settings: {
      toolPrefix: "server",
      directTools: true,
      disableProxyTool: true,
      sampling: false,
      elicitation: false,
      idleTimeout: 0,
    },
    mcpServers: {
      executor: {
        command: executorCommand,
        args: ["mcp"],
        env: {
          EXECUTOR_DATA_DIR: executorDataDir,
          EXECUTOR_SCOPE_DIR: executorScopeDir,
          PATH: path,
        },
        cwd: supportDir,
        lifecycle: "eager",
        idleTimeout: 0,
        exposeResources: true,
        directTools: true,
        debug: false,
      },
    },
  };
}

export function createVanillaMcpAdapterConfig({
  repoRoot = packageRoot,
  fixtureServerPath,
  supportDir,
  path = benchmarkPath(),
  servers = [...PI_EVAL_FIXTURE_SERVERS],
}: any = {}) {
  return {
    settings: {
      toolPrefix: "server",
      directTools: true,
      disableProxyTool: true,
      sampling: false,
      elicitation: false,
      idleTimeout: 0,
    },
    mcpServers: createBenchmarkFixtureMcpServers({
      repoRoot,
      fixtureServerPath,
      cwd: supportDir,
      servers,
      extra: {
        env: { PATH: path },
        lifecycle: "eager",
        idleTimeout: 0,
        exposeResources: true,
        directTools: true,
        debug: false,
      },
    }),
  };
}

function benchmarkPath() {
  return `${defaultNodeModulesBin}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
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
