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
  DEFAULT_PI_EVAL_TASKS,
  PI_EVAL_MODES,
  buildPiEvalCommand,
  buildPiEvalPrompt,
  createPiEvalRunConfig,
  validatePiEvalMode,
} from "./lib/pi-eval/config";
import {
  readMetricsJsonl,
  requiredEvidenceScore,
  summarizePiEvalMetrics,
} from "./lib/pi-eval/metrics";
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
    .description(
      "Run live Pi evals comparing direct Caplets, progressive disclosure, and Code Mode.",
    )
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--mode <modes>", "comma-separated eval modes", splitCsv)
    .option("--model <model>", "Pi model identifier")
    .option("--tasks <ids>", "comma-separated benchmark task ids", splitCsv, DEFAULT_PI_EVAL_TASKS)
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
      "--output-dir <dir>",
      "directory for reports",
      (value) => resolve(value),
      defaultOutputDir,
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
  const modes = options.modes?.length ? options.modes : undefined;
  if (modes) {
    for (const mode of modes) validatePiEvalMode(mode);
  }
  return {
    modes,
    model: options.model,
    tasks: options.tasks?.length ? options.tasks : DEFAULT_PI_EVAL_TASKS,
    runs:
      options.runs === undefined
        ? DEFAULT_PI_EVAL_RUNS
        : parsePositiveInteger(options.runs, "runs"),
    timeoutMs:
      options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : parsePositiveInteger(options.timeoutMs, "timeoutMs"),
    outputDir: resolve(options.outputDir ?? defaultOutputDir),
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
  processRunner = runProcess,
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
  const matrix = buildPiEvalMatrix(evalOptions);
  const startedAt = now();
  const timestamp = formatTimestamp(startedAt);
  const results = [];
  const totalRuns = matrix.length * tasks.length * evalOptions.runs;
  let completedRuns = 0;

  onProgress?.(
    `Starting ${totalRuns} Pi eval run${totalRuns === 1 ? "" : "s"} with ${evalOptions.timeoutMs}ms timeout each.`,
  );

  for (const entry of matrix) {
    for (const task of tasks) {
      for (let runIndex = 1; runIndex <= evalOptions.runs; runIndex += 1) {
        const candidateWorkspace = await createTempWorkspaceFromFixture(fixtureWorkspaceRoot);
        const label = `${entry.mode} ${task.id} run ${runIndex}/${evalOptions.runs}`;
        onProgress?.(`Running ${label} (${completedRuns + 1}/${totalRuns})...`);
        let runConfig: any;

        try {
          runConfig = await createPiEvalRunConfig({ mode: entry.mode, requireBuild: true });
          const prompt = buildPiEvalPrompt(task, entry.mode);
          const command = buildPiEvalCommand({
            command: pi.command ?? "pi",
            prompt,
            model: evalOptions.model,
            extensionPaths: runConfig.extensionPaths,
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
          const metrics = summarizePiEvalMetrics(metricsEvents, agentResult.jsonEvents);
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

          results.push({
            mode: entry.mode,
            model: evalOptions.model ?? null,
            taskId: task.id,
            run: runIndex,
            candidateWorkspace: evalOptions.preserveArtifacts ? candidateWorkspace : null,
            runRoot: evalOptions.preserveArtifacts ? runConfig.runRoot : null,
            artifactsPreserved: evalOptions.preserveArtifacts,
            pi: { command: pi.command ?? "pi", version: pi.version ?? null },
            command,
            runConfig: publicRunConfig(runConfig),
            agentResult,
            metrics,
            evidenceScore,
            score,
          });
          completedRuns += 1;
          onProgress?.(
            `Finished ${label}: ${score.success ? "passed" : "failed"}${agentResult.timedOut ? " (timed out)" : ""}.`,
          );
        } finally {
          if (!evalOptions.preserveArtifacts) {
            await rm(candidateWorkspace, { recursive: true, force: true });
            if (runConfig) {
              await rm(runConfig.runRoot, { recursive: true, force: true });
            }
          }
        }
      }
    }
  }

  const completedAt = now();
  const report = {
    schemaVersion: 1,
    benchmark: "pi-live-tool-surface-eval",
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
  return requestedModes.map((mode: string) => ({ mode }));
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
    configPath: runConfig.configPath,
    xdgConfigHome: runConfig.xdgConfigHome,
    xdgCapletsConfigPath: runConfig.xdgCapletsConfigPath,
    supportDir: runConfig.supportDir,
    fixtureServerPath: runConfig.fixtureServerPath,
    metricsPath: runConfig.metricsPath,
    sessionsDir: runConfig.sessionsDir,
    agentDir: runConfig.agentDir,
    copiedPiAuthFiles: runConfig.copiedPiAuthFiles,
    extensionPaths: runConfig.extensionPaths,
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
    outputDir: options.outputDir,
    preserveArtifacts: options.preserveArtifacts,
  };
}

function formatTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
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
