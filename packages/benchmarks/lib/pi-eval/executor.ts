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
  const results = [];
  for (const payload of payloads) {
    const args = ["call", "executor", "mcp", "addSource", JSON.stringify(payload)];
    const result = await processRunner({
      command: executorCommand,
      args,
      cwd: supportDir,
      env,
      timeoutMs: 60_000,
    });
    assertProcessSucceeded({ payload, command: executorCommand, args, result });

    const paused = parsePausedExecution(result);
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

    const setupOutput = parseExecutorJson(finalResult.stdout || finalResult.stderr);
    validateAddSourceOutput({ payload, output: setupOutput });
    results.push({ payload, command: executorCommand, args, result, resume, output: setupOutput });
  }
  return { payloads, results };
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
    `Executor fixture source setup failed for ${payload.name}: ${command} ${args.join(" ")} ${reason}${stderr ? `: ${stderr}` : ""}`,
  );
}

function parsePausedExecution(result: any) {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/Execution paused:|executionId:/u.test(text)) return null;
  const executionId =
    text.match(/executionId:\s*(\S+)/u)?.[1] ?? text.match(/--execution-id\s+(\S+)/u)?.[1];
  const resumeUrl = text.match(/https?:\/\/[^\s]+\/resume\/[^\s]+/u)?.[0];
  let baseUrl = resumeUrl ? new URL(resumeUrl).origin : undefined;
  baseUrl ??= text.match(/--base-url\s+(https?:\/\/\S+)/u)?.[1];
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

function validateAddSourceOutput({ payload, output }: any) {
  if (!output) {
    throw new Error(`Executor fixture source setup for ${payload.name} produced no JSON result.`);
  }
  if (output.ok === false) {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name}: ${output.error?.message ?? "Executor returned ok:false"}`,
    );
  }
  const data = output.ok === true ? output.data : output;
  if (data?.discovery?.status && data.discovery.status !== "ok") {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name}: discovery ${data.discovery.status}${data.discovery.message ? `: ${data.discovery.message}` : ""}`,
    );
  }
  if (!(Number(data?.toolCount) > 0)) {
    throw new Error(
      `Executor fixture source setup failed for ${payload.name}: expected registered tools but got toolCount=${String(data?.toolCount)}.`,
    );
  }
}

function firstLine(value: string) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}
