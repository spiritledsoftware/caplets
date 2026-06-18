#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  computeSurfaceBenchmark,
  renderMarkdownReport,
  validateSurfaceBenchmark,
} from "./lib/surface";
import {
  computeCodeModeBenchmark,
  computeCodeModeComplexWorkflowEval,
  computeCodeModeLiveRegressionEval,
  computeCodeModeRepeatedWorkflowEval,
  renderCodeModeMarkdownReport,
  validateCodeModeBenchmark,
  validateCodeModeComplexWorkflowEval,
  validateCodeModeLiveRegressionEval,
  validateCodeModeRepeatedWorkflowEval,
} from "./lib/code-mode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(__dirname, "../../docs/benchmarks/coding-agent.md");

const checkMode = process.argv.includes("--check");

const result = await computeSurfaceBenchmark();
const codeModeResult = computeCodeModeBenchmark();
const complexWorkflowResult = computeCodeModeComplexWorkflowEval();
const liveRegressionResult = computeCodeModeLiveRegressionEval();
const repeatedWorkflowResult = computeCodeModeRepeatedWorkflowEval();
const failures = [
  ...validateSurfaceBenchmark(result),
  ...validateCodeModeBenchmark(codeModeResult),
  ...validateCodeModeComplexWorkflowEval(complexWorkflowResult),
  ...validateCodeModeLiveRegressionEval(liveRegressionResult),
  ...validateCodeModeRepeatedWorkflowEval(repeatedWorkflowResult),
];
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

const markdown = formatMarkdown(renderMarkdownReport(result, renderCodeModeMarkdownReport()));

if (checkMode) {
  let current;
  try {
    current = readFileSync(reportPath, "utf8");
  } catch {
    console.error(`${reportPath} does not exist. Run pnpm --filter @caplets/benchmarks benchmark.`);
    process.exit(1);
  }

  if (current !== markdown) {
    console.error(`${reportPath} is stale. Run pnpm --filter @caplets/benchmarks benchmark.`);
    process.exit(1);
  }
  console.log(`${reportPath} is up to date.`);
} else {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown, "utf8");
  console.log(`Wrote ${reportPath}`);
}

function formatMarkdown(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-benchmark-docs-"));
  const path = join(dir, "coding-agent.md");
  try {
    writeFileSync(path, value);
    execFileSync("pnpm", ["exec", "oxfmt", path], { stdio: "inherit" });
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
