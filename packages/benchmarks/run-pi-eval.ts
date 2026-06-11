#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_TIMEOUT_MS, runProcess } from "./lib/live-agent";
import { detectPiCli } from "./lib/pi-runner";
import { createTempWorkspaceFromFixture } from "./lib/scoring";
import {
  DEFAULT_PI_EVAL_RUNS,
  EXECUTOR_PI_EVAL_MODE,
  isPiMcpAdapterPiEvalMode,
  buildPiEvalCommand,
  buildPiEvalPrewarmPrompt,
  createPiEvalRunConfig,
  piEvalModeProduct,
  PI_EVAL_MODES,
  validatePiEvalMode,
} from "./lib/pi-eval/config";
import {
  DEFAULT_PI_EVAL_SUITE_ID,
  resolvePiEvalSuite,
  validatePiEvalSuiteId,
} from "./lib/pi-eval/suites";
import { createPiSemanticJudge } from "./lib/pi-eval/semantic-judge";
import {
  readMetricsJsonl,
  requiredEvidenceScore,
  summarizePiEvalMetrics,
} from "./lib/pi-eval/metrics";
import {
  DEFAULT_EXECUTOR_COMMAND,
  detectExecutorCli,
  setupExecutorFixtureSources,
  setupExecutorMcpSources,
} from "./lib/pi-eval/executor";
import { renderPiEvalMarkdownReport, summarizePiEvalResults } from "./lib/pi-eval/report";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultOutputDir = resolve(repoRoot, "benchmark-results", "live", "pi-eval");

export function parsePiEvalArgs(argv = process.argv.slice(2)) {
  const program = new Command();
  program
    .name("caplets-pi-eval-benchmark")
    .description("Run live Pi evals comparing Caplets and competitor tool gateways.")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--task-suite <suite>", "task suite to run", DEFAULT_PI_EVAL_SUITE_ID)
    .option("--mode <modes>", "comma-separated eval modes", splitCsv)
    .option("--model <model>", "Pi model identifier")
    .option("--judge-model <model>", "Pi model identifier for semantic scoring judge")
    .option("--tasks <ids>", "comma-separated benchmark task ids", splitCsv)
    .option(
      "--runs <count>",
      "runs per task/mode",
      parseCommanderPositiveInteger,
      DEFAULT_PI_EVAL_RUNS,
    )
    .option(
      "--timeout-ms <milliseconds>",
      "timeout per Pi run",
      parseCommanderPositiveInteger,
      DEFAULT_TIMEOUT_MS,
    )
    .option(
      "--concurrency <count>",
      "maximum number of mode/task/run jobs to execute at once",
      parseCommanderPositiveInteger,
      1,
    )
    .option(
      "--output-dir <dir>",
      "directory for reports",
      (value) => resolve(value),
      defaultOutputDir,
    )
    .option("--executor-command <command>", "Executor CLI command", DEFAULT_EXECUTOR_COMMAND)
    .option(
      "--skip-missing-competitors",
      "skip competitor modes when the required competitor CLI is unavailable",
      false,
    )
    .option("--preserve-artifacts", "keep candidate workspaces and Pi run artifacts", false);

  try {
    program.parse(
      argv.filter((arg) => arg !== "--"),
      { from: "user" },
    );
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const parsedOptions = program.opts();
  return validatePiEvalOptions({ ...parsedOptions, modes: parsedOptions.mode });
}

export function validatePiEvalOptions(options: any = {}) {
  const taskSuite = options.taskSuite ?? DEFAULT_PI_EVAL_SUITE_ID;
  validatePiEvalSuiteId(taskSuite);
  const suite = resolvePiEvalSuite(taskSuite);
  const modes = options.modes?.length ? options.modes : undefined;
  if (modes) {
    for (const mode of modes) validatePiEvalMode(mode);
  }
  return {
    taskSuite,
    modes,
    model: options.model,
    judgeModel: options.judgeModel ?? options.model,
    tasks: options.tasks?.length ? options.tasks : suite.defaultTasks,
    runs:
      options.runs === undefined
        ? DEFAULT_PI_EVAL_RUNS
        : parsePositiveInteger(options.runs, "runs"),
    timeoutMs:
      options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : parsePositiveInteger(options.timeoutMs, "timeoutMs"),
    concurrency:
      options.concurrency === undefined
        ? 1
        : parsePositiveInteger(options.concurrency, "concurrency"),
    outputDir: resolve(options.outputDir ?? defaultOutputDir),
    executorCommand: options.executorCommand ?? DEFAULT_EXECUTOR_COMMAND,
    skipMissingCompetitors: Boolean(options.skipMissingCompetitors),
    preserveArtifacts: Boolean(options.preserveArtifacts),
  };
}

export async function runPiEvalBenchmark({
  options,
  env = process.env,
  fixtureRoot: inputFixtureRoot,
  fixtureWorkspaceRoot: inputFixtureWorkspaceRoot,
  tasksPath: inputTasksPath,
  now = () => new Date(),
  onProgress,
  piDetector = detectPiCli,
  executorDetector = detectExecutorCli,
  processRunner = runProcess,
  runConfigFactory = createPiEvalRunConfig,
  semanticJudge: inputSemanticJudge,
}: any = {}) {
  const evalOptions = validatePiEvalOptions(options ?? {});
  const suite = resolvePiEvalSuite(evalOptions.taskSuite);
  const fixtureRoot = inputFixtureRoot ?? suite.fixtureRoot;
  const fixtureWorkspaceRoot = inputFixtureWorkspaceRoot ?? suite.workspaceRoot;
  const tasksPath = inputTasksPath ?? suite.tasksPath;
  if (env.CAPLETS_BENCH_LIVE !== "1") {
    throw new Error("Refusing to run live Pi eval unless CAPLETS_BENCH_LIVE=1.");
  }
  validateSuiteRequiredEnv(suite, env);

  const pi = await piDetector({ env });
  if (!pi?.available) {
    throw new Error(pi?.reason ?? "Pi CLI was not available.");
  }
  const semanticJudge =
    inputSemanticJudge ??
    (evalOptions.judgeModel
      ? createPiSemanticJudge({
          piCommand: pi.command ?? "pi",
          model: evalOptions.judgeModel,
          env,
          timeoutMs: Math.min(evalOptions.timeoutMs, 120_000),
          processRunner,
        })
      : undefined);

  await mkdir(evalOptions.outputDir, { recursive: true });

  const tasks = selectTasks(await loadTasks(tasksPath), evalOptions.tasks);
  let matrix = buildPiEvalMatrix(evalOptions);
  let executorInfo = null;
  if (matrix.some((entry: any) => entry.mode === EXECUTOR_PI_EVAL_MODE)) {
    executorInfo = await executorDetector({
      command: evalOptions.executorCommand,
      env,
      runProcess: processRunner,
    });
    if (!executorInfo?.available) {
      if (evalOptions.skipMissingCompetitors) {
        onProgress?.(
          `Skipping executor-mcp because Executor CLI is unavailable: ${executorInfo?.reason ?? "unknown reason"}`,
        );
        matrix = matrix.filter((entry: any) => entry.mode !== EXECUTOR_PI_EVAL_MODE);
      } else {
        throw new Error(
          executorInfo?.reason ??
            "Executor CLI is required for executor-mcp mode. Install with `npm install -g executor` or pass --executor-command <path>.",
        );
      }
    }
  }
  if (matrix.length === 0) {
    throw new Error("No Pi eval modes remain after applying competitor availability filters.");
  }

  const startedAt = now();
  const timestamp = formatTimestamp(startedAt);
  const results = [];
  const totalRuns = matrix.length * tasks.length * evalOptions.runs;
  let completedRuns = 0;
  const jobs = buildPiEvalJobs({ matrix, tasks, runs: evalOptions.runs });

  onProgress?.(
    `Starting ${totalRuns} Pi eval run${totalRuns === 1 ? "" : "s"} with ${evalOptions.timeoutMs}ms timeout each and concurrency ${Math.min(evalOptions.concurrency, totalRuns)}.`,
  );

  const runResults = await runWithConcurrency(jobs, evalOptions.concurrency, async (job: any) => {
    const { entry, task, runIndex, index } = job;
    const candidateWorkspace = await createPiEvalWorkspace({ suite, fixtureWorkspaceRoot });
    const label = `${entry.mode} ${task.id} run ${runIndex}/${evalOptions.runs}`;
    onProgress?.(`Running ${label} (${index + 1}/${totalRuns})...`);
    let runConfig: any;

    try {
      await preparePiEvalWorkspace({
        suite,
        candidateWorkspace,
        processRunner,
        env,
        timeoutMs: Math.min(evalOptions.timeoutMs, 60_000),
      });
      runConfig = await runConfigFactory({
        mode: entry.mode,
        requireBuild: true,
        executorCommand: evalOptions.executorCommand,
        fixtureServerSourcePath: suite.fixtureServerSourcePath,
        fixtureServers: suite.fixtureServers,
        realMcpServers: suite.realMcpServers,
        candidateWorkspace,
        directToolsEnv: suite.directToolsEnv,
        disableBuiltinTools: Boolean(suite.disablePiBuiltinTools),
        env,
      });
      let executorSetup = null;
      let prewarmResult = null;
      if (entry.mode === EXECUTOR_PI_EVAL_MODE) {
        const setupInput = {
          executorCommand: evalOptions.executorCommand,
          supportDir: runConfig.supportDir,
          env: { ...env, ...runConfig.env, CAPLETS_BENCH_LIVE: "1" },
          processRunner,
        };
        executorSetup = runConfig.executorSourceMcpServers
          ? await setupExecutorMcpSources({
              ...setupInput,
              mcpServers: runConfig.executorSourceMcpServers,
            })
          : await setupExecutorFixtureSources({
              ...setupInput,
              fixtureServerPath: runConfig.fixtureServerPath,
              servers: suite.fixtureServers,
            });
      }
      if (isPiMcpAdapterPiEvalMode(entry.mode)) {
        prewarmResult = await prewarmMcpAdapterDirectTools({
          piCommand: pi.command ?? "pi",
          model: evalOptions.model,
          runConfig,
          candidateWorkspace,
          env,
          timeoutMs: Math.min(evalOptions.timeoutMs, 120_000),
          processRunner,
        });
      }

      const prompt = suite.buildPrompt(task, entry.mode);
      const command = buildPiEvalCommand({
        command: pi.command ?? "pi",
        prompt,
        model: evalOptions.model,
        disableBuiltinTools: Boolean(runConfig.disableBuiltinTools),
        extensionPaths: runConfig.extensionPaths,
        extraArgs: runConfig.extraArgs,
      });
      const agentResult = await processRunner({
        command: command.command,
        args: command.args,
        cwd: candidateWorkspace,
        env: {
          ...env,
          ...runConfig.env,
          CAPLETS_BENCH_LIVE: "1",
          ...(evalOptions.preserveArtifacts ? { CAPLETS_BENCH_PRESERVE_ARTIFACTS: "1" } : {}),
        },
        timeoutMs: evalOptions.timeoutMs,
      });
      const metricsEvents = await readMetricsJsonl(runConfig.metricsPath);
      const metrics = summarizePiEvalMetrics(metricsEvents, agentResult.jsonEvents, {
        mode: entry.mode,
        adapterExposure: runConfig.adapterExposure,
      });
      const score = await suite.scoreRun({
        task,
        candidateWorkspace,
        fixtureRoot,
        agentResult,
        semanticJudge,
        validationTimeoutMs: Math.min(evalOptions.timeoutMs, 60_000),
      });
      const evidenceScore = requiredEvidenceScore(metrics, task, score);
      if (evidenceScore.required && !evidenceScore.success) {
        score.success = false;
      }
      if (metrics.directToolsPrewarmFailure) {
        score.success = false;
        score.processSuccess = false;
        score.processFailureReason = `${entry.mode} measured run used the pi-mcp-adapter proxy tool; direct tools cache/prewarm failed`;
      }

      const result = {
        mode: entry.mode,
        product: entry.product,
        adapterExposure: runConfig.adapterExposure,
        model: evalOptions.model ?? null,
        taskId: task.id,
        run: runIndex,
        candidateWorkspace: evalOptions.preserveArtifacts ? candidateWorkspace : null,
        runRoot: evalOptions.preserveArtifacts ? runConfig.runRoot : null,
        artifactsPreserved: evalOptions.preserveArtifacts,
        pi: { command: pi.command ?? "pi", version: pi.version ?? null },
        executor:
          entry.mode === EXECUTOR_PI_EVAL_MODE
            ? {
                command: evalOptions.executorCommand,
                version: executorInfo?.version ?? null,
                setupSources:
                  executorSetup?.payloads?.map((payload: any) => payload.slug ?? payload.name) ??
                  [],
              }
            : null,
        command,
        prewarm:
          prewarmResult == null
            ? null
            : {
                command: prewarmResult.command,
                args: prewarmResult.args,
                exitCode: prewarmResult.exitCode,
                timedOut: prewarmResult.timedOut,
                durationMs: prewarmResult.durationMs,
                success: prewarmResult.prewarmSuccess !== false,
                failureReason: prewarmResult.prewarmFailureReason ?? null,
                metricsPath: runConfig.prewarmMetricsPath,
                sessionDir: runConfig.prewarmSessionsDir,
                unmeasured: true,
              },
        runConfig: publicRunConfig(runConfig),
        agentResult: compactPiEvalAgentResult(agentResult),
        metrics,
        evidenceScore,
        score: compactPiEvalScore(score),
      };
      completedRuns += 1;
      onProgress?.(
        `Finished ${label}: ${score.success ? "passed" : "failed"}${agentResult.timedOut ? " (timed out)" : ""} (${completedRuns}/${totalRuns}).`,
      );
      return result;
    } finally {
      if (!evalOptions.preserveArtifacts) {
        await rm(candidateWorkspace, { recursive: true, force: true });
        if (runConfig) {
          await rm(runConfig.runRoot, { recursive: true, force: true });
        }
      }
    }
  });
  results.push(...runResults);

  const completedAt = now();
  const report = {
    schemaVersion: 2,
    benchmark: "pi-live-tool-gateway-eval",
    suite: {
      id: suite.id,
      label: suite.label,
      workspaceRequired: suite.workspaceRequired,
      fixtureServers: suite.fixtureServers,
      realMcpServers: suite.realMcpServers ?? [],
      requiredEnv: suite.requiredEnv ?? [],
      disablePiBuiltinTools: Boolean(suite.disablePiBuiltinTools),
    },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    options: serializableOptions(evalOptions),
    matrix,
    tasks: tasks.map(suite.publicTaskMetadata),
    summary: summarizePiEvalResults(results),
    results,
  };

  const jsonPath = resolve(evalOptions.outputDir, `${timestamp}.json`);
  const markdownPath = resolve(evalOptions.outputDir, `${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderPiEvalMarkdownReport(report), "utf8");

  return { report, jsonPath, markdownPath };
}

export async function prewarmMcpAdapterDirectTools({
  piCommand = "pi",
  model,
  runConfig,
  candidateWorkspace,
  env = process.env,
  timeoutMs = 120_000,
  processRunner = runProcess,
}: any = {}) {
  if (!runConfig) throw new TypeError("prewarmMcpAdapterDirectTools requires runConfig.");
  if (!candidateWorkspace)
    throw new TypeError("prewarmMcpAdapterDirectTools requires candidateWorkspace.");
  const command = buildPiEvalCommand({
    command: piCommand,
    prompt: buildPiEvalPrewarmPrompt(),
    model,
    disableBuiltinTools: Boolean(runConfig.disableBuiltinTools),
    extensionPaths: runConfig.extensionPaths,
    extraArgs: runConfig.extraArgs,
  });
  const result = await processRunner({
    command: command.command,
    args: command.args,
    cwd: candidateWorkspace,
    env: {
      ...env,
      ...runConfig.env,
      CAPLETS_BENCH_LIVE: "1",
      CAPLETS_PI_EVAL_METRICS: runConfig.prewarmMetricsPath,
      PI_CODING_AGENT_SESSION_DIR: runConfig.prewarmSessionsDir,
    },
    timeoutMs,
  });
  if (result.timedOut || result.signal || (result.exitCode != null && result.exitCode !== 0)) {
    return {
      ...result,
      command: command.command,
      args: command.args,
      prewarmSuccess: false,
      prewarmFailureReason: `MCP adapter direct-tools prewarm failed${result.timedOut ? " (timed out)" : ""}${result.exitCode != null ? ` with exit code ${result.exitCode}` : ""}.`,
    };
  }
  return { ...result, command: command.command, args: command.args, prewarmSuccess: true };
}

export const prewarmExecutorDirectTools = prewarmMcpAdapterDirectTools;

async function createPiEvalWorkspace({ suite, fixtureWorkspaceRoot }: any) {
  if (suite.workspaceRequired) {
    return await createTempWorkspaceFromFixture(fixtureWorkspaceRoot);
  }
  return await mkdtemp(join(tmpdir(), "caplets-pi-eval-workspace-"));
}

async function preparePiEvalWorkspace({
  suite,
  candidateWorkspace,
  processRunner,
  env,
  timeoutMs,
}: any) {
  if (suite.id !== "mcp-real-world-large") return;
  const commands = [
    ["git", ["init"]],
    ["git", ["config", "user.email", "benchmark@example.invalid"]],
    ["git", ["config", "user.name", "Caplets Benchmark"]],
    ["git", ["config", "commit.gpgsign", "false"]],
    ["git", ["add", "."]],
    ["git", ["commit", "--no-gpg-sign", "-m", "seed benchmark workspace"]],
  ];
  for (const [command, args] of commands) {
    const result = await processRunner({
      command,
      args,
      cwd: candidateWorkspace,
      env,
      timeoutMs,
    });
    if (result.timedOut || result.signal || (result.exitCode != null && result.exitCode !== 0)) {
      throw new Error(
        `Failed to prepare ${suite.id} workspace with ${command} ${(args as string[]).join(" ")}.`,
      );
    }
  }
}

export async function loadTasks(tasksPath = resolvePiEvalSuite().tasksPath) {
  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  if (!Array.isArray(tasks)) throw new Error(`${tasksPath} must contain an array of tasks.`);
  const ids = new Set();
  for (const task of tasks) {
    if (!task?.id || !task.prompt)
      throw new Error("Every benchmark task must include id and prompt.");
    if (ids.has(task.id)) throw new Error(`Duplicate benchmark task id: ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}

export function buildPiEvalMatrix(options: any = {}) {
  const evalOptions = validatePiEvalOptions(options ?? {});
  const requestedModes = evalOptions.modes ?? [...PI_EVAL_MODES];
  return requestedModes.map((mode: string) => ({ mode, product: piEvalModeProduct(mode) }));
}

function splitCsv(value: string) {
  const parts = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("Expected at least one comma-separated value.");
  return parts;
}

function parseCommanderPositiveInteger(value: string): number {
  try {
    return parsePositiveInteger(value, "value");
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parsePositiveInteger(value: unknown, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function selectTasks(tasks: any[], ids?: string[]) {
  if (!ids?.length) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = ids.map((id) => byId.get(id));
  const missing = ids.filter((id, index) => !selected[index]);
  if (missing.length > 0) throw new Error(`Unknown benchmark task(s): ${missing.join(", ")}`);
  return selected;
}

function validateSuiteRequiredEnv(suite: any, env: Record<string, string | undefined>) {
  const missing = (suite.requiredEnv ?? []).filter((name: string) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Pi eval suite ${suite.id} requires environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
}

function publicRunConfig(runConfig: any) {
  return {
    mode: runConfig.mode,
    product: runConfig.product,
    disableBuiltinTools: Boolean(runConfig.disableBuiltinTools),
    adapterExposure: runConfig.adapterExposure,
    configPath: runConfig.configPath,
    adapterConfigPath: runConfig.adapterConfigPath,
    xdgConfigHome: runConfig.xdgConfigHome,
    xdgCapletsConfigPath: runConfig.xdgCapletsConfigPath,
    supportDir: runConfig.supportDir,
    fixtureServerPath: runConfig.fixtureServerPath,
    metricsPath: runConfig.metricsPath,
    prewarmMetricsPath: runConfig.prewarmMetricsPath,
    sessionsDir: runConfig.sessionsDir,
    prewarmSessionsDir: runConfig.prewarmSessionsDir,
    agentDir: runConfig.agentDir,
    adapterHomeDir: runConfig.adapterHomeDir,
    executorDataDir: runConfig.executorDataDir,
    executorScopeDir: runConfig.executorScopeDir,
    copiedPiAuthFiles: runConfig.copiedPiAuthFiles,
    extensionPaths: runConfig.extensionPaths,
    extraArgs: runConfig.extraArgs,
    envKeys: Object.keys(runConfig.env ?? {}).sort(),
  };
}

function serializableOptions(options: any) {
  return {
    taskSuite: options.taskSuite,
    modes: options.modes ?? null,
    model: options.model ?? null,
    judgeModel: options.judgeModel ?? null,
    tasks: options.tasks ?? null,
    runs: options.runs,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    outputDir: options.outputDir,
    executorCommand: options.executorCommand,
    skipMissingCompetitors: options.skipMissingCompetitors,
    preserveArtifacts: options.preserveArtifacts,
  };
}

export function compactPiEvalAgentResult(agentResult: any = {}) {
  const jsonEvents = Array.isArray(agentResult.jsonEvents) ? agentResult.jsonEvents : [];
  return {
    ...agentResult,
    args: compactCommandArgs(agentResult.args),
    stdout: truncateText(agentResult.stdout, 16_384),
    stderr: truncateText(agentResult.stderr, 8_192),
    stdoutTruncated:
      Boolean(agentResult.stdoutTruncated) ||
      Buffer.byteLength(String(agentResult.stdout ?? ""), "utf8") > 16_384,
    stderrTruncated:
      Boolean(agentResult.stderrTruncated) ||
      Buffer.byteLength(String(agentResult.stderr ?? ""), "utf8") > 8_192,
    jsonEvents: jsonEvents.slice(-25).map(compactJsonEvent),
    jsonEventsTotalCount: jsonEvents.length,
    jsonEventsTruncated: jsonEvents.length > 25,
  };
}

export function compactPiEvalScore(score: any = {}) {
  const parsedFinalAnswer = truncateDeep(score.parsedFinalAnswer, 4);
  return {
    ...score,
    validation: compactProcessLikeResult(score.validation),
    hiddenValidation: compactProcessLikeResult(score.hiddenValidation),
    semanticJudge: score.semanticJudge ? compactSemanticJudgeResult(score.semanticJudge) : null,
    parsedFinalAnswer,
    parsedFinalAnswerTruncated: wouldTruncateDeep(score.parsedFinalAnswer, 4),
  };
}

function compactProcessLikeResult(result: any) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    stdout: truncateText(result.stdout, 16_384),
    stderr: truncateText(result.stderr, 8_192),
    stdoutTruncated:
      Boolean(result.stdoutTruncated) ||
      Buffer.byteLength(String(result.stdout ?? ""), "utf8") > 16_384,
    stderrTruncated:
      Boolean(result.stderrTruncated) ||
      Buffer.byteLength(String(result.stderr ?? ""), "utf8") > 8_192,
    semanticJudge: result.semanticJudge
      ? compactSemanticJudgeResult(result.semanticJudge)
      : result.semanticJudge,
  };
}

function compactSemanticJudgeResult(result: any) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    args: compactCommandArgs(result.args),
    reason: truncateText(result.reason, 4_096),
    missing: Array.isArray(result.missing)
      ? result.missing.slice(0, 20).map((entry: any) => truncateText(entry, 2_048))
      : result.missing,
    incorrect: Array.isArray(result.incorrect)
      ? result.incorrect.slice(0, 20).map((entry: any) => truncateText(entry, 2_048))
      : result.incorrect,
  };
}

function compactCommandArgs(args: any) {
  if (!Array.isArray(args)) return args;
  return args.map((arg) => truncateText(arg, 8_192));
}

function compactJsonEvent(event: any) {
  return {
    type: event?.type ?? event?.event ?? "event",
    event: event?.event,
    toolName:
      event?.toolName ??
      event?.tool_name ??
      event?.name ??
      event?.tool?.name ??
      event?.params?.name,
    role: event?.message?.role ?? event?.role,
    usage: event?.message?.usage ?? event?.usage,
    exitCode: event?.exitCode,
    timedOut: event?.timedOut,
    durationMs: event?.durationMs,
    text: firstStringExcerpt([
      event?.text,
      event?.resultPreview,
      event?.output,
      event?.message?.content,
      event?.content,
    ]),
  };
}

function firstStringExcerpt(values: any[]) {
  for (const value of values) {
    const text = extractString(value);
    if (text) return truncateText(text, 1_024);
  }
  return undefined;
}

function extractString(value: any): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractString(entry?.text ?? entry);
      if (text) return text;
    }
  }
  return null;
}

function truncateDeep(value: any, depth: number): any {
  if (typeof value === "string") return truncateText(value, 4_096);
  if (typeof value !== "object" || value == null) return value;
  if (depth <= 0) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => truncateDeep(entry, depth - 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, entry]) => [key, truncateDeep(entry, depth - 1)]),
  );
}

function wouldTruncateDeep(value: any, depth: number): boolean {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") > 4_096;
  if (typeof value !== "object" || value == null) return false;
  if (depth <= 0) return true;
  if (Array.isArray(value)) {
    return value.length > 20 || value.some((entry) => wouldTruncateDeep(entry, depth - 1));
  }
  const entries = Object.entries(value);
  return entries.length > 40 || entries.some(([, entry]) => wouldTruncateDeep(entry, depth - 1));
}

function truncateText(value: any, maxBytes: number) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return text.slice(0, maxBytes);
}

function formatTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function buildPiEvalJobs({ matrix, tasks, runs }: any) {
  const jobs = [];
  for (const entry of matrix) {
    for (const task of tasks) {
      for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
        jobs.push({ index: jobs.length, entry, task, runIndex });
      }
    }
  }
  return jobs;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(parsePositiveInteger(concurrency, "concurrency"), items.length);
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  let firstError: unknown;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (!firstError && nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await worker(items[index]);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );

  if (firstError) throw firstError;
  return results;
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    const result = await runPiEvalBenchmark({
      options: parsePiEvalArgs(),
      onProgress: (message: string) => console.error(message),
    });
    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
