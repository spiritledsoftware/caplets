import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createBenchmarkCapletsConfig,
  createBenchmarkFixtureMcpServers,
  stageBenchmarkMcpSupportFiles,
} from "./config.mjs";
import { createLiveAgentRunner, runProcess as defaultRunProcess } from "./live-agent.mjs";

export const OPENCODE_CONFIG_MODES = ["direct-flat", "caplets"];
export const DEFAULT_OPENCODE_COMMAND = "opencode";
export const DEFAULT_OPENCODE_CONFIG_FILENAME = "opencode.json";

const SECRET_ARG_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const REDACTED = "[REDACTED]";

export const opencodeRunner = createLiveAgentRunner({
  name: "opencode",
  detect: detectOpenCodeCli,
  run: runOpenCode,
});

export async function detectOpenCodeCli({
  command = DEFAULT_OPENCODE_COMMAND,
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

export async function runOpenCode({
  task,
  candidateWorkspace,
  mode = "direct-flat",
  model,
  env = process.env,
  command = env.OPENCODE_BENCH_COMMAND || DEFAULT_OPENCODE_COMMAND,
  extraArgs = splitArgs(env.OPENCODE_BENCH_ARGS),
  timeoutMs,
  outputMaxBytes,
  runProcess = defaultRunProcess,
  preserveArtifacts = env.CAPLETS_BENCH_PRESERVE_ARTIFACTS === "1",
} = {}) {
  if (env.CAPLETS_BENCH_LIVE !== "1") {
    throw new Error("OpenCode live benchmark runs require CAPLETS_BENCH_LIVE=1.");
  }
  if (!task?.prompt) {
    throw new TypeError("runOpenCode requires a task with a prompt.");
  }
  if (!candidateWorkspace) {
    throw new TypeError("runOpenCode requires a candidateWorkspace.");
  }
  if (!OPENCODE_CONFIG_MODES.includes(mode)) {
    throw new Error(
      `Unknown OpenCode benchmark mode ${mode}. Expected one of: ${OPENCODE_CONFIG_MODES.join(", ")}`,
    );
  }

  const activeProjectConfigPath = join(
    resolve(candidateWorkspace),
    DEFAULT_OPENCODE_CONFIG_FILENAME,
  );
  const openCodeStateDir = await mkdtemp(join(tmpdir(), "caplets-opencode-agent-"));
  let result;
  let cleanedUp = false;
  let generatedProjectConfig = false;
  let generatedProjectConfigRemoved = false;
  try {
    const version = await detectOpenCodeCli({ command, runProcess });
    if (!version.available) {
      result = unavailableResult({
        command,
        mode,
        model,
        reason: version.reason,
        activeProjectConfigPath,
        openCodeStateDir,
      });
      return result;
    }

    const configResult = await createOpenCodeMcpConfigs({
      rootDir: openCodeStateDir,
      workspaceDir: candidateWorkspace,
      requireCapletsBuild: mode === "caplets",
    });
    const config = configResult.configs[mode];
    if (await pathExists(activeProjectConfigPath)) {
      result = configConflictResult({
        command,
        mode,
        model,
        version: version.version,
        reason: `Refusing to overwrite existing OpenCode project config at ${activeProjectConfigPath}.`,
        configResult,
        activeConfigPath: config.path,
        activeProjectConfigPath,
        openCodeStateDir,
      });
      return result;
    }
    await writeFile(
      activeProjectConfigPath,
      `${JSON.stringify(configFileContents(config), null, 2)}\n`,
      { flag: "wx" },
    );
    generatedProjectConfig = true;

    const openCodeCommand = buildOpenCodeCommand({
      command,
      prompt: task.prompt,
      model,
      workspace: candidateWorkspace,
      extraArgs,
    });
    const redactedArgs = redactArgs(openCodeCommand.args);
    const processResult = await runProcess({
      command: openCodeCommand.command,
      args: openCodeCommand.args,
      cwd: candidateWorkspace,
      env: isolatedOpenCodeEnv(env, openCodeStateDir),
      timeoutMs,
      outputMaxBytes,
    });

    result = {
      ...processResult,
      agent: "opencode",
      args: redactedArgs,
      mode,
      model: model ?? null,
      openCodeVersion: version.version ?? null,
      commandLine: [openCodeCommand.command, ...redactedArgs].map(shellQuote).join(" "),
      configPaths: configResult.configPaths,
      activeConfigPath: config.path,
      activeProjectConfigPath,
      openCodeStateDir,
      configAssumptions: configResult.assumptions,
    };
    return result;
  } finally {
    if (!preserveArtifacts) {
      if (generatedProjectConfig) {
        await rm(activeProjectConfigPath, { force: true });
        generatedProjectConfigRemoved = true;
      }
      await rm(openCodeStateDir, { recursive: true, force: true });
      cleanedUp = true;
    }
    if (result) {
      result.cleanedUp = cleanedUp;
      result.artifactsPreserved = !cleanedUp;
      result.generatedProjectConfigRemoved = generatedProjectConfigRemoved;
    }
  }
}

export function buildOpenCodeCommand({
  command = DEFAULT_OPENCODE_COMMAND,
  prompt,
  model,
  workspace,
  extraArgs = [],
} = {}) {
  if (!prompt) {
    throw new TypeError("buildOpenCodeCommand requires a prompt.");
  }
  if (!workspace) {
    throw new TypeError("buildOpenCodeCommand requires a workspace.");
  }
  const args = ["run", "--format", "json"];
  if (model) {
    args.push("--model", model);
  }
  args.push("--dir", workspace, prompt, ...extraArgs);
  return { command, args };
}

export async function createOpenCodeMcpConfigs({
  rootDir,
  workspaceDir,
  requireCapletsBuild = false,
} = {}) {
  const baseDir = rootDir
    ? resolve(rootDir)
    : await mkdtemp(join(tmpdir(), "caplets-opencode-config-"));
  const configRoot = join(baseDir, "opencode", "mcp");
  await mkdir(configRoot, { recursive: true });
  const support = await stageBenchmarkMcpSupportFiles({ rootDir: configRoot });

  const configs = {
    "direct-flat": directFlatConfig(configRoot, support),
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
    workspaceConfigPath: workspaceDir
      ? join(resolve(workspaceDir), DEFAULT_OPENCODE_CONFIG_FILENAME)
      : null,
    assumptions: openCodeConfigAssumptions(),
  };
}

function openCodeConfigAssumptions() {
  return [
    "OpenCode is expected to read project-local opencode.json from the --dir workspace.",
    "XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, and XDG_CACHE_HOME are redirected to the benchmark temp directory for best-effort isolation.",
  ];
}

function directFlatConfig(configRoot, support) {
  const dir = join(configRoot, "direct-flat");
  return {
    mode: "direct-flat",
    dir,
    path: join(dir, DEFAULT_OPENCODE_CONFIG_FILENAME),
    mcp: openCodeMcpServers(support),
  };
}

async function capletsConfig(configRoot, { requireBuild = false } = {}) {
  const dir = join(configRoot, "caplets");
  const caplets = await createBenchmarkCapletsConfig({ rootDir: dir, requireBuild });
  const capletsCommand = [caplets.caplets.command, ...caplets.caplets.args];
  return {
    mode: "caplets",
    dir,
    path: join(dir, DEFAULT_OPENCODE_CONFIG_FILENAME),
    supportFiles: { [caplets.configPath]: caplets.config },
    mcp: {
      caplets: {
        type: "local",
        enabled: true,
        command: capletsCommand,
        cwd: caplets.caplets.cwd,
        env: caplets.caplets.env,
      },
    },
  };
}

function openCodeMcpServers(support) {
  return Object.fromEntries(
    Object.entries(
      createBenchmarkFixtureMcpServers({
        fixtureServerPath: support.fixtureServerPath,
        cwd: support.supportDir,
      }),
    ).map(([server, definition]) => [
      server,
      {
        type: "local",
        enabled: true,
        command: [definition.command, ...definition.args],
        cwd: definition.cwd,
      },
    ]),
  );
}

function configFileContents(config) {
  return { mcp: config.mcp };
}

function isolatedOpenCodeEnv(env, openCodeStateDir) {
  return {
    ...env,
    HOME: openCodeStateDir,
    XDG_CONFIG_HOME: join(openCodeStateDir, "config"),
    XDG_DATA_HOME: join(openCodeStateDir, "data"),
    XDG_STATE_HOME: join(openCodeStateDir, "state"),
    XDG_CACHE_HOME: join(openCodeStateDir, "cache"),
  };
}

function unavailableResult({
  command,
  mode,
  model,
  reason,
  activeProjectConfigPath,
  openCodeStateDir,
}) {
  return {
    agent: "opencode",
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
    configPaths: {},
    activeConfigPath: null,
    activeProjectConfigPath,
    openCodeStateDir,
    configAssumptions: openCodeConfigAssumptions(),
  };
}

function configConflictResult({
  command,
  mode,
  model,
  version,
  reason,
  configResult,
  activeConfigPath,
  activeProjectConfigPath,
  openCodeStateDir,
}) {
  return {
    agent: "opencode",
    mode,
    model: model ?? null,
    skipped: true,
    configConflict: true,
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
    openCodeVersion: version ?? null,
    commandLine: command,
    configPaths: configResult.configPaths,
    activeConfigPath,
    activeProjectConfigPath,
    openCodeStateDir,
    configAssumptions: configResult.assumptions,
  };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
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
