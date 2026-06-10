#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_TIMEOUT_MS, runProcess } from "./lib/live-agent";
import { detectPiCli } from "./lib/pi-runner";
import { createTempWorkspaceFromFixture, scoreTaskRun } from "./lib/scoring";
import {
  DEFAULT_PI_EVAL_RUNS,
  EXECUTOR_PI_EVAL_MODE,
  isPiMcpAdapterPiEvalMode,
  buildPiEvalCommand,
  buildPiEvalPrewarmPrompt,
  buildPiEvalPrompt,
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
import {
  readMetricsJsonl,
  requiredEvidenceScore,
  summarizePiEvalMetrics,
} from "./lib/pi-eval/metrics";
import {
  DEFAULT_EXECUTOR_COMMAND,
  detectExecutorCli,
  setupExecutorFixtureSources,
} from "./lib/pi-eval/executor";
import { renderPiEvalMarkdownReport, summarizePiEvalResults } from "./lib/pi-eval/report";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultFixtureRoot = resolve(repoRoot, "benchmarks", "fixtures");
const defaultFixtureWorkspaceRoot = resolve(defaultFixtureRoot, "coding-agent-workspace");
const defaultTasksPath = resolve(defaultFixtureRoot, "tasks.json");
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
  fixtureRoot = defaultFixtureRoot,
  fixtureWorkspaceRoot = defaultFixtureWorkspaceRoot,
  tasksPath = defaultTasksPath,
  now = () => new Date(),
  onProgress,
  piDetector = detectPiCli,
  executorDetector = detectExecutorCli,
  processRunner = runProcess,
  runConfigFactory = createPiEvalRunConfig,
}: any = {}) {
  const evalOptions = validatePiEvalOptions(options ?? {});
  if (env.CAPLETS_BENCH_LIVE !== "1") {
    throw new Error("Refusing to run live Pi eval unless CAPLETS_BENCH_LIVE=1.");
  }

  const pi = await piDetector({ env });
  if (!pi?.available) {
    throw new Error(pi?.reason ?? "Pi CLI was not available.");
  }

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
    const candidateWorkspace = await createTempWorkspaceFromFixture(fixtureWorkspaceRoot);
    const label = `${entry.mode} ${task.id} run ${runIndex}/${evalOptions.runs}`;
    onProgress?.(`Running ${label} (${index + 1}/${totalRuns})...`);
    let runConfig: any;

    try {
      runConfig = await runConfigFactory({
        mode: entry.mode,
        requireBuild: true,
        executorCommand: evalOptions.executorCommand,
      });
      let executorSetup = null;
      let prewarmResult = null;
      if (entry.mode === EXECUTOR_PI_EVAL_MODE) {
        executorSetup = await setupExecutorFixtureSources({
          executorCommand: evalOptions.executorCommand,
          fixtureServerPath: runConfig.fixtureServerPath,
          supportDir: runConfig.supportDir,
          env: { ...env, ...runConfig.env, CAPLETS_BENCH_LIVE: "1" },
          processRunner,
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

      const prompt = buildPiEvalPrompt(task, entry.mode);
      const command = buildPiEvalCommand({
        command: pi.command ?? "pi",
        prompt,
        model: evalOptions.model,
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
      const score = await scoreTaskRun({
        task,
        candidateWorkspace,
        fixtureRoot,
        agentResult,
        validationTimeoutMs: Math.min(evalOptions.timeoutMs, 60_000),
      });
      const evidenceScore = requiredEvidenceScore(metrics, task);
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
                setupSources: executorSetup?.payloads?.map((payload: any) => payload.name) ?? [],
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
                metricsPath: runConfig.prewarmMetricsPath,
                sessionDir: runConfig.prewarmSessionsDir,
                unmeasured: true,
              },
        runConfig: publicRunConfig(runConfig),
        agentResult,
        metrics,
        evidenceScore,
        score,
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
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    options: serializableOptions(evalOptions),
    matrix,
    tasks: tasks.map(publicTaskMetadata),
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
    throw new Error(
      `MCP adapter direct-tools prewarm failed${result.timedOut ? " (timed out)" : ""}${result.exitCode != null ? ` with exit code ${result.exitCode}` : ""}.`,
    );
  }
  return { ...result, command: command.command, args: command.args };
}

export const prewarmExecutorDirectTools = prewarmMcpAdapterDirectTools;

export async function loadTasks(tasksPath = defaultTasksPath) {
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

function publicTaskMetadata(task: any) {
  return {
    id: task.id,
    prompt: task.prompt,
    validationCommand: task.validationCommand,
    expectedFiles: task.expectedFiles ?? [],
    requiredFact: task.requiredFact ?? null,
  };
}

function publicRunConfig(runConfig: any) {
  return {
    mode: runConfig.mode,
    product: runConfig.product,
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
    modes: options.modes ?? null,
    model: options.model ?? null,
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
