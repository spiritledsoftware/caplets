#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS } from "./lib/live-agent.mjs";
import { opencodeRunner } from "./lib/opencode-runner.mjs";
import { piRunner } from "./lib/pi-runner.mjs";
import { createTempWorkspaceFromFixture, scoreTaskRun } from "./lib/scoring.mjs";

export const LIVE_AGENT_MODES = Object.freeze({
  pi: ["direct-flat", "pi-proxy", "caplets"],
  opencode: ["direct-flat", "caplets"],
});

export const DEFAULT_LIVE_AGENT = "pi";
export const DEFAULT_RUNS = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultFixtureRoot = resolve(repoRoot, "benchmarks", "fixtures");
const defaultFixtureWorkspaceRoot = resolve(defaultFixtureRoot, "coding-agent-workspace");
const defaultTasksPath = resolve(defaultFixtureRoot, "tasks.json");
const defaultOutputDir = resolve(repoRoot, "benchmark-results", "live");

const runnerByAgent = Object.freeze({
  pi: piRunner,
  opencode: opencodeRunner,
});

export function parseLiveArgs(argv = process.argv.slice(2)) {
  const options = {
    agent: DEFAULT_LIVE_AGENT,
    modes: undefined,
    model: undefined,
    tasks: undefined,
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputDir: defaultOutputDir,
    preserveArtifacts: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const readValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (name === "--preserve-artifacts") {
      options.preserveArtifacts = true;
      continue;
    }
    if (name === "--agent") {
      options.agent = readValue();
      continue;
    }
    if (name === "--mode") {
      options.modes = splitCsv(readValue());
      continue;
    }
    if (name === "--model") {
      options.model = readValue();
      continue;
    }
    if (name === "--tasks") {
      options.tasks = splitCsv(readValue());
      continue;
    }
    if (name === "--runs") {
      options.runs = parsePositiveInteger(readValue(), "--runs");
      continue;
    }
    if (name === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(), "--timeout-ms");
      continue;
    }
    if (name === "--output-dir") {
      options.outputDir = resolve(readValue());
      continue;
    }

    throw new Error(`Unknown argument: ${name}`);
  }

  return validateLiveOptions(options);
}

export async function runLiveBenchmark({
  options,
  env = process.env,
  runners = runnerByAgent,
  fixtureRoot = defaultFixtureRoot,
  fixtureWorkspaceRoot = defaultFixtureWorkspaceRoot,
  tasksPath = defaultTasksPath,
  now = () => new Date(),
  onProgress,
} = {}) {
  const liveOptions = validateLiveOptions(options ?? {});
  if (env.CAPLETS_BENCH_LIVE !== "1") {
    throw new Error("Refusing to run live benchmarks unless CAPLETS_BENCH_LIVE=1.");
  }

  const tasks = selectTasks(await loadTasks(tasksPath), liveOptions.tasks);
  const matrix = buildLiveMatrix(liveOptions);
  const startedAt = now();
  const timestamp = formatTimestamp(startedAt);
  const results = [];
  const totalRuns = matrix.length * tasks.length * liveOptions.runs;
  let completedRuns = 0;

  onProgress?.(
    `Starting ${totalRuns} live benchmark run${totalRuns === 1 ? "" : "s"} with ${liveOptions.timeoutMs}ms timeout each.`,
  );

  for (const entry of matrix) {
    const runner = runners[entry.agent];
    if (!runner?.run) {
      throw new Error(`No runner is registered for agent ${entry.agent}.`);
    }

    for (const task of tasks) {
      for (let runIndex = 1; runIndex <= liveOptions.runs; runIndex += 1) {
        const candidateWorkspace = await createTempWorkspaceFromFixture(fixtureWorkspaceRoot);
        const label = `${entry.agent}/${entry.mode} ${task.id} run ${runIndex}/${liveOptions.runs}`;
        onProgress?.(`Running ${label} (${completedRuns + 1}/${totalRuns})...`);
        try {
          let agentResult;
          try {
            agentResult = await runner.run({
              task: sanitizeTaskForAgent(task),
              candidateWorkspace,
              mode: entry.mode,
              model: liveOptions.model,
              timeoutMs: liveOptions.timeoutMs,
              preserveArtifacts: liveOptions.preserveArtifacts,
              env: {
                ...env,
                CAPLETS_BENCH_LIVE: "1",
                ...(liveOptions.preserveArtifacts ? { CAPLETS_BENCH_PRESERVE_ARTIFACTS: "1" } : {}),
              },
            });
          } catch (error) {
            if (isHarnessOrConfigError(error)) {
              throw error;
            }
            agentResult = runnerErrorResult({
              agent: entry.agent,
              mode: entry.mode,
              model: liveOptions.model,
              error,
            });
          }

          const score = await scoreTaskRun({
            task,
            candidateWorkspace,
            fixtureRoot,
            agentResult,
            validationTimeoutMs: Math.min(liveOptions.timeoutMs, 60_000),
          });

          results.push({
            agent: entry.agent,
            mode: entry.mode,
            model: liveOptions.model ?? null,
            taskId: task.id,
            run: runIndex,
            candidateWorkspace: liveOptions.preserveArtifacts ? candidateWorkspace : null,
            artifactsPreserved: liveOptions.preserveArtifacts,
            agentResult,
            score,
          });
          completedRuns += 1;
          onProgress?.(
            `Finished ${label}: ${score.success ? "passed" : "failed"}${agentResult.timedOut ? " (timed out)" : ""}.`,
          );
        } finally {
          if (!liveOptions.preserveArtifacts) {
            await rm(candidateWorkspace, { recursive: true, force: true });
          }
        }
      }
    }
  }

  const completedAt = now();
  const report = {
    schemaVersion: 1,
    benchmark: "coding-agent-live",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    options: serializableOptions(liveOptions),
    matrix,
    tasks: tasks.map(publicTaskMetadata),
    summary: summarizeResults(results),
    results,
  };

  const jsonPath = resolve(liveOptions.outputDir, `${timestamp}.json`);
  const markdownPath = resolve(liveOptions.outputDir, `${timestamp}.md`);
  await mkdir(liveOptions.outputDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderLiveMarkdownReport(report), "utf8");

  return { report, jsonPath, markdownPath };
}

export async function loadTasks(tasksPath = defaultTasksPath) {
  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  if (!Array.isArray(tasks)) {
    throw new Error(`${tasksPath} must contain an array of tasks.`);
  }
  for (const task of tasks) {
    if (!task?.id || !task.prompt) {
      throw new Error("Every benchmark task must include id and prompt.");
    }
  }
  return tasks;
}

export function buildLiveMatrix(options) {
  const liveOptions = validateLiveOptions(options ?? {});
  const agents = liveOptions.agent === "all" ? Object.keys(LIVE_AGENT_MODES) : [liveOptions.agent];
  const matrix = [];

  for (const agent of agents) {
    const supportedModes = LIVE_AGENT_MODES[agent];
    const requestedModes = liveOptions.modes ?? supportedModes;
    for (const mode of requestedModes) {
      if (!supportedModes.includes(mode)) {
        throw new Error(`${agent} does not support benchmark mode ${mode}.`);
      }
      matrix.push({ agent, mode });
    }
  }

  return matrix;
}

export function renderLiveMarkdownReport(report) {
  const rows = report.summary.byAgentMode.map((row) => {
    const rate = formatPercent(row.passRate);
    const duration =
      row.averageDurationMs == null ? "n/a" : `${Math.round(row.averageDurationMs)}ms`;
    return `| ${row.agent} | ${row.mode} | ${row.passed}/${row.total} | ${rate} | ${row.finalStateValid}/${row.total} | ${duration} | ${row.skipped} | ${row.timedOut} |`;
  });

  const failures = report.results
    .filter((result) => !result.score.success)
    .map(
      (result) =>
        `- ${result.agent}/${result.mode} ${result.taskId} run ${result.run}: ${failureReason(result)}`,
    );

  return `${[
    "# Live Coding-Agent Benchmark",
    "",
    `Generated: ${report.completedAt}`,
    "",
    `Agent: ${report.options.agent}`,
    `Model: ${report.options.model ?? "default"}`,
    `Runs per task/mode: ${report.options.runs}`,
    `Timeout: ${report.options.timeoutMs}ms`,
    "",
    "## Summary",
    "",
    "| Agent | Mode | Passed | Pass rate | Final state valid | Avg duration | Skipped | Timed out |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Failures",
    "",
    ...(failures.length > 0 ? failures : ["- None"]),
    "",
  ].join("\n")}`;
}

function validateLiveOptions(options) {
  const agent = options.agent ?? DEFAULT_LIVE_AGENT;
  if (![...Object.keys(LIVE_AGENT_MODES), "all"].includes(agent)) {
    throw new Error(`Unknown agent ${agent}. Expected pi, opencode, or all.`);
  }
  const modes = options.modes?.length ? options.modes : undefined;
  if (modes) {
    const knownModes = new Set(Object.values(LIVE_AGENT_MODES).flat());
    for (const mode of modes) {
      if (!knownModes.has(mode)) {
        throw new Error(`Unknown benchmark mode ${mode}.`);
      }
    }
  }
  return {
    agent,
    modes,
    model: options.model,
    tasks: options.tasks?.length ? options.tasks : undefined,
    runs: options.runs ?? DEFAULT_RUNS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputDir: resolve(options.outputDir ?? defaultOutputDir),
    preserveArtifacts: Boolean(options.preserveArtifacts),
  };
}

function splitCsv(value) {
  const parts = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Expected at least one comma-separated value.");
  }
  return parts;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function selectTasks(tasks, ids) {
  if (!ids?.length) {
    return tasks;
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = ids.map((id) => byId.get(id));
  const missing = ids.filter((id, index) => !selected[index]);
  if (missing.length > 0) {
    throw new Error(`Unknown benchmark task(s): ${missing.join(", ")}`);
  }
  return selected;
}

function sanitizeTaskForAgent(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    validationCommand: task.validationCommand,
    expectedFiles: task.expectedFiles,
  };
}

function publicTaskMetadata(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    validationCommand: task.validationCommand,
    expectedFiles: task.expectedFiles ?? [],
  };
}

function runnerErrorResult({ agent, mode, model, error }) {
  const message = error?.message ?? String(error);
  return {
    agent,
    mode,
    model: model ?? null,
    command: agent,
    args: [],
    envKeys: [],
    stdout: "",
    stderr: message,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(message, "utf8"),
    stdoutTruncated: false,
    stderrTruncated: false,
    outputMaxBytes: 0,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    jsonEvents: [],
    benchmarkHarnessCapturedError: true,
    errorName: error?.name ?? "Error",
  };
}

function isHarnessOrConfigError(error) {
  const message = error?.message ?? String(error);
  return (
    message.includes("requires the built CLI") ||
    message.includes("Unknown Pi benchmark mode") ||
    message.includes("Unknown OpenCode benchmark mode") ||
    message.includes("requires CAPLETS_BENCH_LIVE=1")
  );
}

function summarizeResults(results) {
  const byKey = new Map();
  for (const result of results) {
    const key = `${result.agent}\0${result.mode}`;
    const current = byKey.get(key) ?? {
      agent: result.agent,
      mode: result.mode,
      total: 0,
      passed: 0,
      finalStateValid: 0,
      skipped: 0,
      timedOut: 0,
      totalDurationMs: 0,
      durationCount: 0,
    };
    current.total += 1;
    if (result.score.success) {
      current.passed += 1;
    }
    if (result.score.finalStateValid) {
      current.finalStateValid += 1;
    }
    if (result.agentResult?.skipped) {
      current.skipped += 1;
    }
    if (result.score.process?.timedOut) {
      current.timedOut += 1;
    }
    if (typeof result.score.process?.durationMs === "number") {
      current.totalDurationMs += result.score.process.durationMs;
      current.durationCount += 1;
    }
    byKey.set(key, current);
  }

  const byAgentMode = [...byKey.values()].map((row) => ({
    agent: row.agent,
    mode: row.mode,
    total: row.total,
    passed: row.passed,
    finalStateValid: row.finalStateValid,
    failed: row.total - row.passed,
    passRate: row.total === 0 ? 0 : row.passed / row.total,
    skipped: row.skipped,
    timedOut: row.timedOut,
    averageDurationMs:
      row.durationCount === 0 ? null : Math.round(row.totalDurationMs / row.durationCount),
  }));

  const total = results.length;
  const passed = results.filter((result) => result.score.success).length;
  const finalStateValid = results.filter((result) => result.score.finalStateValid).length;
  return {
    total,
    passed,
    finalStateValid,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    byAgentMode,
  };
}

function serializableOptions(options) {
  return {
    agent: options.agent,
    modes: options.modes ?? null,
    model: options.model ?? null,
    tasks: options.tasks ?? null,
    runs: options.runs,
    timeoutMs: options.timeoutMs,
    outputDir: options.outputDir,
    preserveArtifacts: options.preserveArtifacts,
  };
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function failureReason(result) {
  if (result.agentResult?.unavailable) {
    return result.agentResult.reason ?? "agent unavailable";
  }
  if (result.agentResult?.benchmarkHarnessCapturedError) {
    return result.agentResult.stderr;
  }
  if (!result.score.validation.success) {
    return `validation failed with exit code ${result.score.validation.exitCode}`;
  }
  if (!result.score.hiddenValidation.success) {
    return `hidden validation failed with exit code ${result.score.hiddenValidation.exitCode}`;
  }
  return "benchmark score failed";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runLiveBenchmark({
      options: parseLiveArgs(),
      onProgress: (message) => console.error(message),
    });
    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(1);
  }
}
