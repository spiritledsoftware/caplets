import { runProcess as defaultRunProcess } from "../live-agent";

export const DEFAULT_EXECUTOR_COMMAND = "executor";
export const EXECUTOR_FIXTURE_SERVERS = ["issues", "ci", "docs", "api", "code-map"] as const;

export async function detectExecutorCli({
  command = DEFAULT_EXECUTOR_COMMAND,
  env = process.env,
  runProcess = defaultRunProcess,
}: any = {}) {
  try {
    const result = await runProcess({
      command,
      args: ["--version"],
      env,
      timeoutMs: 10_000,
    });
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
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        available: false,
        command,
        reason: `${command} CLI was not found in PATH. Install Executor with \`npm install -g executor\` or pass --executor-command <path>.`,
      };
    }
    return { available: false, command, reason: (error as Error)?.message ?? String(error) };
  }
}

export function createExecutorFixtureSourcePayloads({
  fixtureServerPath,
  supportDir,
  sourceCommand = "tsx",
  servers = EXECUTOR_FIXTURE_SERVERS,
}: any = {}) {
  if (!fixtureServerPath) {
    throw new TypeError("createExecutorFixtureSourcePayloads requires fixtureServerPath.");
  }
  if (!supportDir) {
    throw new TypeError("createExecutorFixtureSourcePayloads requires supportDir.");
  }
  return servers.map((server: string) => ({
    transport: "stdio",
    name: server,
    command: sourceCommand,
    args: [fixtureServerPath, "--server", server],
    cwd: supportDir,
  }));
}

export function createExecutorAddServerPayloads({
  mcpServers,
}: {
  mcpServers?: Record<string, any>;
} = {}) {
  if (!mcpServers) {
    throw new TypeError("createExecutorAddServerPayloads requires mcpServers.");
  }
  return Object.entries(mcpServers).map(([slug, config]) => executorAddServerPayload(slug, config));
}

export function createExecutorMcpSourcePayloads({
  mcpServers,
}: {
  mcpServers?: Record<string, any>;
} = {}) {
  return createExecutorAddServerPayloads({ mcpServers });
}

export async function setupExecutorFixtureSources({
  executorCommand = DEFAULT_EXECUTOR_COMMAND,
  fixtureServerPath,
  supportDir,
  env = process.env,
  processRunner = defaultRunProcess,
  sourceCommand = "tsx",
  servers = EXECUTOR_FIXTURE_SERVERS,
}: any = {}) {
  const payloads = createExecutorFixtureSourcePayloads({
    fixtureServerPath,
    supportDir,
    sourceCommand,
    servers,
  });
  return await setupExecutorMcpSources({
    executorCommand,
    supportDir,
    env,
    processRunner,
    payloads,
  });
}

export async function setupExecutorMcpSources({
  executorCommand = DEFAULT_EXECUTOR_COMMAND,
  supportDir,
  env = process.env,
  processRunner = defaultRunProcess,
  payloads,
  mcpServers,
}: any = {}) {
  const sourcePayloads = payloads ?? createExecutorMcpSourcePayloads({ mcpServers });
  if (!supportDir) {
    throw new TypeError("setupExecutorMcpSources requires supportDir.");
  }
  const daemon = await ensureExecutorDaemon({
    executorCommand,
    supportDir,
    env,
    processRunner,
  });
  const daemonBaseUrl = parseDaemonBaseUrl(daemon);
  const results = [];
  for (const payload of sourcePayloads) {
    const addArgs = ["call", "executor", "mcp", "addServer", JSON.stringify(payload)];
    const result = await processRunner({
      command: executorCommand,
      args: addArgs,
      cwd: supportDir,
      env,
      timeoutMs: 60_000,
    });
    assertProcessSucceeded({ payload, command: executorCommand, args: addArgs, result });

    const paused = parsePausedExecution(result, daemonBaseUrl);
    let finalResult = result;
    let resume = null;
    if (paused) {
      const resumeArgs = [
        "resume",
        "--execution-id",
        paused.executionId,
        "--base-url",
        paused.baseUrl,
        "--action",
        "accept",
        "--content",
        "{}",
      ];
      resume = await processRunner({
        command: executorCommand,
        args: resumeArgs,
        cwd: supportDir,
        env,
        timeoutMs: 60_000,
      });
      assertProcessSucceeded({
        payload,
        command: executorCommand,
        args: resumeArgs,
        result: resume,
      });
      finalResult = resume;
    }

    const addOutput = parseExecutorJson(finalResult.stdout || finalResult.stderr);
    const slug = validateAddServerOutput({ payload, output: addOutput });
    const connectionArgs = [
      "call",
      "executor",
      "coreTools",
      "connections",
      "create",
      JSON.stringify({
        owner: "user",
        name: slug,
        integration: slug,
        template: "none",
        from: { provider: "file", id: "empty" },
      }),
    ];
    const connection = await processRunner({
      command: executorCommand,
      args: connectionArgs,
      cwd: supportDir,
      env,
      timeoutMs: 60_000,
    });
    assertProcessSucceeded({
      payload,
      command: executorCommand,
      args: connectionArgs,
      result: connection,
    });
    const connectionOutput = parseExecutorJson(connection.stdout || connection.stderr);
    const connectionData = validateExecutorOk({
      payload,
      output: connectionOutput,
      stage: "connection create",
    });
    const connectionName = connectionData?.name ?? slug;

    const refreshArgs = [
      "call",
      "executor",
      "coreTools",
      "connections",
      "refresh",
      JSON.stringify({ owner: "user", name: connectionName, integration: slug }),
    ];
    const refresh = await processRunner({
      command: executorCommand,
      args: refreshArgs,
      cwd: supportDir,
      env,
      timeoutMs: 60_000,
    });
    assertProcessSucceeded({
      payload,
      command: executorCommand,
      args: refreshArgs,
      result: refresh,
    });
    const refreshOutput = parseExecutorJson(refresh.stdout || refresh.stderr);
    validateRefreshOutput({ payload, output: refreshOutput });
    results.push({
      payload,
      command: executorCommand,
      args: addArgs,
      result,
      resume,
      output: addOutput,
      connection,
      refresh,
      connectionOutput,
      refreshOutput,
      connectionName,
    });
  }
  const daemonStop = await stopExecutorDaemon({
    executorCommand,
    supportDir,
    env,
    processRunner,
    baseUrl: daemonBaseUrl,
  });
  return { payloads: sourcePayloads, results, daemon, daemonStop };
}

function executorAddServerPayload(slug: string, config: any) {
  if (config.command) {
    return {
      transport: "stdio",
      name: config.name ?? slug,
      slug,
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    };
  }
  const headers = { ...config.headers };
  if (config.auth?.type === "bearer" && config.auth.token) {
    headers.Authorization = `Bearer ${config.auth.token}`;
  }
  return {
    transport: "remote",
    name: config.name ?? slug,
    slug,
    endpoint: config.url,
    remoteTransport: config.transport === "sse" ? "sse" : "streamable-http",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    auth: { kind: "none" },
  };
}

async function ensureExecutorDaemon({ executorCommand, supportDir, env, processRunner }: any) {
  const args = ["daemon", "run"];
  const result = await processRunner({
    command: executorCommand,
    args,
    cwd: supportDir,
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode === 0 && !result.timedOut && !result.signal) return result;
  const reason = result.timedOut
    ? "timed out"
    : result.signal
      ? `exited with signal ${result.signal}`
      : `exited with code ${result.exitCode}`;
  const stderr = String(result.stderr ?? "").trim();
  throw new Error(
    `Executor daemon setup failed: ${executorCommand} ${args.join(" ")} ${reason}${stderr ? `: ${redactSecrets(stderr)}` : ""}`,
  );
}

function parseDaemonBaseUrl(result: any) {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return text.match(/https?:\/\/localhost:\d+/u)?.[0];
}

async function stopExecutorDaemon({
  executorCommand,
  supportDir,
  env,
  processRunner,
  baseUrl,
}: any) {
  const args = baseUrl ? ["daemon", "stop", "--base-url", baseUrl] : ["daemon", "stop"];
  const result = await processRunner({
    command: executorCommand,
    args,
    cwd: supportDir,
    env,
    timeoutMs: 60_000,
  });
  if (result.exitCode === 0 && !result.timedOut && !result.signal) return result;
  const reason = result.timedOut
    ? "timed out"
    : result.signal
      ? `exited with signal ${result.signal}`
      : `exited with code ${result.exitCode}`;
  const stderr = String(result.stderr ?? "").trim();
  throw new Error(
    `Executor daemon teardown failed: ${executorCommand} ${args.join(" ")} ${reason}${stderr ? `: ${redactSecrets(stderr)}` : ""}`,
  );
}

function assertProcessSucceeded({ payload, command, args, result }: any) {
  if (result.exitCode === 0 && !result.timedOut && !result.signal) return;
  const reason = result.timedOut
    ? "timed out"
    : result.signal
      ? `exited with signal ${result.signal}`
      : `exited with code ${result.exitCode}`;
  const stderr = String(result.stderr ?? "").trim();
  throw new Error(
    `Executor fixture source setup failed for ${payload.name}: ${command} ${redactedArgs(args).join(" ")} ${reason}${stderr ? `: ${redactSecrets(stderr)}` : ""}`,
  );
}

function redactedArgs(args: string[]) {
  return args.map((arg) => redactedJson(arg));
}

function redactedJson(value: string) {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(value)));
  } catch {
    return redactSecrets(value);
  }
}

function redactSecrets(value: any): any {
  if (typeof value === "string") {
    return value
      .replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "<redacted>")
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gu, "Bearer <redacted>");
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|secret|password|authorization|api[_-]?key/iu.test(key)
        ? "<redacted>"
        : redactSecrets(entry),
    ]),
  );
}

function parsePausedExecution(result: any, fallbackBaseUrl?: string) {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/Execution paused:|executionId:/u.test(text)) return null;
  const executionId =
    text.match(/executionId:\s*(\S+)/u)?.[1] ?? text.match(/--execution-id\s+(\S+)/u)?.[1];
  const resumeUrl = text.match(/https?:\/\/[^\s]+\/resume\/[^\s]+/u)?.[0];
  let baseUrl = resumeUrl ? new URL(resumeUrl).origin : undefined;
  baseUrl ??= text.match(/--base-url\s+(https?:\/\/\S+)/u)?.[1];
  baseUrl ??= fallbackBaseUrl;
  if (!executionId || !baseUrl) {
    throw new Error(
      `Executor fixture source setup paused but did not expose a resumable execution id and base URL.`,
    );
  }
  return { executionId, baseUrl };
}

function parseExecutorJson(text: string) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}\s*$/u);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function validateAddServerOutput({ payload, output }: any) {
  if (!output) {
    throw new Error(`Executor fixture source setup for ${payload.name} produced no JSON result.`);
  }
  const data = validateExecutorOk({ payload, output, stage: "server add" });
  if (!data?.slug) {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name}: missing server slug.`,
    );
  }
  return data.slug;
}

function validateExecutorOk({ payload, output, stage }: any) {
  if (!output) {
    throw new Error(`Executor fixture source setup for ${payload.name} produced no JSON result.`);
  }
  if (output.ok === false) {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name} during ${stage}: ${output.error?.message ?? "Executor returned ok:false"}`,
    );
  }
  return output.ok === true ? output.data : output;
}

function validateRefreshOutput({ payload, output }: any) {
  const data = validateExecutorOk({ payload, output, stage: "connection refresh" });
  if (!Array.isArray(data?.tools) || data.tools.length === 0) {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name}: expected registered tools but got toolCount=${String(data?.tools?.length ?? 0)}.`,
    );
  }
}

function firstLine(value: string) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}
