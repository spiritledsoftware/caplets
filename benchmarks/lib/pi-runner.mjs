import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createBenchmarkCapletsConfig,
  createBenchmarkFixtureMcpServers,
  stageBenchmarkMcpSupportFiles,
} from "./config.mjs";
import { createLiveAgentRunner, runProcess as defaultRunProcess } from "./live-agent.mjs";

export const PI_CONFIG_MODES = ["direct-flat", "pi-proxy", "caplets"];
export const DEFAULT_PI_COMMAND = "pi";
export const DEFAULT_PI_CONFIG_FILENAME = "mcp.json";

const SECRET_ARG_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const REDACTED = "[REDACTED]";

export const piRunner = createLiveAgentRunner({
  name: "pi",
  detect: detectPiCli,
  run: runPi,
});

export async function detectPiCli({
  command = DEFAULT_PI_COMMAND,
  runProcess = defaultRunProcess,
} = {}) {
  try {
    const result = await runProcess({ command, args: ["--version"], timeoutMs: 10_000 });
    if (result.exitCode === 0) {
      return {
        available: true,
        command,
        version: firstLine(result.stdout || result.stderr) || "unknown",
      };
    }
    return {
      available: false,
      command,
      reason: `${command} --version exited with code ${result.exitCode}.`,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { available: false, command, reason: `${command} CLI was not found in PATH.` };
    }
    return { available: false, command, reason: error?.message ?? String(error) };
  }
}

export async function runPi({
  task,
  candidateWorkspace,
  mode = "direct-flat",
  model,
  env = process.env,
  command = env.PI_BENCH_COMMAND || DEFAULT_PI_COMMAND,
  extraArgs = splitArgs(env.PI_BENCH_ARGS),
  timeoutMs,
  outputMaxBytes,
  runProcess = defaultRunProcess,
  preserveArtifacts = env.CAPLETS_BENCH_PRESERVE_ARTIFACTS === "1",
} = {}) {
  if (env.CAPLETS_BENCH_LIVE !== "1") {
    throw new Error("Pi live benchmark runs require CAPLETS_BENCH_LIVE=1.");
  }
  if (!task?.prompt) {
    throw new TypeError("runPi requires a task with a prompt.");
  }
  if (!candidateWorkspace) {
    throw new TypeError("runPi requires a candidateWorkspace.");
  }
  if (!PI_CONFIG_MODES.includes(mode)) {
    throw new Error(
      `Unknown Pi benchmark mode ${mode}. Expected one of: ${PI_CONFIG_MODES.join(", ")}`,
    );
  }

  const piCodingAgentDir = await mkdtemp(join(tmpdir(), "caplets-pi-agent-"));
  let result;
  let cleanedUp = false;
  try {
    const configResult = await createPiMcpConfigs({
      rootDir: piCodingAgentDir,
      requireCapletsBuild: mode === "caplets",
    });
    const config = configResult.configs[mode];
    const version = await detectPiCli({ command, runProcess });
    if (!version.available) {
      result = unavailableResult({
        command,
        mode,
        model,
        reason: version.reason,
        configResult,
        activeConfigPath: config.path,
        piCodingAgentDir,
      });
      return result;
    }
    const piCommand = buildPiCommand({
      command,
      prompt: task.prompt,
      model,
      mcpConfigPath: config.path,
      extraArgs,
    });
    const redactedArgs = redactArgs(piCommand.args);

    const processResult = await runProcess({
      command: piCommand.command,
      args: piCommand.args,
      cwd: candidateWorkspace,
      env: {
        ...env,
        PI_CODING_AGENT_DIR: piCodingAgentDir,
        PI_MCP_CONFIG: config.path,
      },
      timeoutMs,
      outputMaxBytes,
    });

    result = {
      ...processResult,
      agent: "pi",
      args: redactedArgs,
      mode,
      model: model ?? null,
      piVersion: version.version ?? null,
      commandLine: [piCommand.command, ...redactedArgs].map(shellQuote).join(" "),
      configPaths: configResult.configPaths,
      activeConfigPath: config.path,
      piCodingAgentDir,
    };
    return result;
  } finally {
    if (!preserveArtifacts) {
      await rm(piCodingAgentDir, { recursive: true, force: true });
      cleanedUp = true;
    }
    if (result) {
      result.cleanedUp = cleanedUp;
      result.artifactsPreserved = !cleanedUp;
    }
  }
}

export function buildPiCommand({
  command = DEFAULT_PI_COMMAND,
  prompt,
  model,
  mcpConfigPath,
  extraArgs = [],
} = {}) {
  if (!prompt) {
    throw new TypeError("buildPiCommand requires a prompt.");
  }
  const args = ["-p", prompt, "--mode", "json"];
  if (model) {
    args.push("--model", model);
  }
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }
  args.push(...extraArgs);
  return { command, args };
}

export async function createPiMcpConfigs({ rootDir, requireCapletsBuild = false } = {}) {
  const baseDir = rootDir ? resolve(rootDir) : await mkdtemp(join(tmpdir(), "caplets-pi-config-"));
  const configRoot = join(baseDir, "pi", "mcp");
  await mkdir(configRoot, { recursive: true });
  const support = await stageBenchmarkMcpSupportFiles({ rootDir: configRoot });

  const configs = {
    "direct-flat": directFlatConfig(configRoot, support),
    "pi-proxy": piProxyConfig(configRoot, support),
    caplets: await capletsConfig(configRoot, { requireBuild: requireCapletsBuild }),
  };

  for (const config of Object.values(configs)) {
    await mkdir(config.dir, { recursive: true });
    await writeFile(config.path, `${JSON.stringify(configFileContents(config), null, 2)}\n`);
    for (const [filePath, contents] of Object.entries(config.supportFiles ?? {})) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`);
    }
  }

  return {
    rootDir: baseDir,
    configPaths: Object.fromEntries(
      Object.entries(configs).map(([mode, config]) => [mode, config.path]),
    ),
    configs,
  };
}

function directFlatConfig(configRoot, support) {
  const dir = join(configRoot, "direct-flat");
  return {
    mode: "direct-flat",
    dir,
    path: join(dir, DEFAULT_PI_CONFIG_FILENAME),
    settings: { directTools: true },
    mcpServers: createBenchmarkFixtureMcpServers({
      fixtureServerPath: support.fixtureServerPath,
      cwd: support.supportDir,
      extra: { directTools: true },
    }),
  };
}

function piProxyConfig(configRoot, support) {
  const dir = join(configRoot, "pi-proxy");
  const mcpServers = createBenchmarkFixtureMcpServers({
    fixtureServerPath: support.fixtureServerPath,
    cwd: support.supportDir,
    extra: { directTools: false },
  });
  return {
    mode: "pi-proxy",
    dir,
    path: join(dir, DEFAULT_PI_CONFIG_FILENAME),
    settings: { directTools: false },
    // Pi's MCP adapter uses proxy-only exposure when directTools is false. We write both
    // the Pi-specific config and a project-local .mcp.json shape documented by pi-mcp-adapter.
    supportFiles: {
      [join(dir, ".mcp.json")]: {
        settings: { directTools: false },
        mcpServers,
      },
    },
    mcpServers,
  };
}

async function capletsConfig(configRoot, { requireBuild = false } = {}) {
  const dir = join(configRoot, "caplets");
  const caplets = await createBenchmarkCapletsConfig({ rootDir: dir, requireBuild });
  return {
    mode: "caplets",
    dir,
    path: join(dir, DEFAULT_PI_CONFIG_FILENAME),
    // Best-effort assumption: Pi reads MCP config entries in the common mcpServers shape.
    // The Caplets CLI then performs progressive disclosure against the generated config.
    settings: { directTools: true },
    supportFiles: { [caplets.configPath]: caplets.config },
    mcpServers: {
      caplets: {
        ...caplets.caplets.mcpServer,
        directTools: true,
      },
    },
  };
}

function configFileContents(config) {
  return {
    ...(config.settings ? { settings: config.settings } : {}),
    mcpServers: config.mcpServers,
  };
}

function unavailableResult({
  command,
  mode,
  model,
  reason,
  configResult,
  activeConfigPath,
  piCodingAgentDir,
}) {
  return {
    agent: "pi",
    mode,
    model: model ?? null,
    skipped: true,
    unavailable: true,
    reason,
    command,
    args: [],
    envKeys: [],
    stdout: "",
    stderr: reason ?? "",
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(reason ?? "", "utf8"),
    stdoutTruncated: false,
    stderrTruncated: false,
    outputMaxBytes: 0,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    jsonEvents: [],
    commandLine: command,
    configPaths: configResult.configPaths,
    activeConfigPath,
    piCodingAgentDir,
  };
}

function redactArgs(args) {
  const redacted = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext && !String(arg).startsWith("-")) {
      redacted.push(REDACTED);
      redactNext = false;
      continue;
    }

    const text = String(arg);
    const equalsIndex = text.indexOf("=");
    const key = equalsIndex === -1 ? text : text.slice(0, equalsIndex);
    if (SECRET_ARG_PATTERN.test(key)) {
      redacted.push(equalsIndex === -1 ? text : `${key}=${REDACTED}`);
      redactNext = equalsIndex === -1;
      continue;
    }

    redacted.push(text);
    redactNext = false;
  }
  return redacted;
}

function splitArgs(value) {
  return value ? value.trim().split(/\s+/).filter(Boolean) : [];
}

function firstLine(value) {
  return String(value).trim().split(/\r?\n/u)[0]?.trim() ?? "";
}

function shellQuote(value) {
  const text = String(value);
  if (text === REDACTED) {
    return text;
  }
  return /^[A-Za-z0-9_./:=@\]-]+$/u.test(text) ? text : JSON.stringify(text);
}
