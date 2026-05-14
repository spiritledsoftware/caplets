#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSurfaceBenchmark,
  renderMarkdownReport,
  validateSurfaceBenchmark,
} from "./lib/surface.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const reportPath = resolve(repoRoot, "docs/benchmarks/coding-agent.md");

const checkMode = process.argv.includes("--check");

const result = await computeSurfaceBenchmark();
const failures = validateSurfaceBenchmark(result);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

const markdown = renderMarkdownReport(result);

if (checkMode) {
  let current;
  try {
    current = readFileSync(reportPath, "utf8");
  } catch {
    console.error(`${reportPath} does not exist. Run node benchmarks/run-deterministic.mjs.`);
    process.exit(1);
  }

  if (current !== markdown) {
    console.error(`${reportPath} is stale. Run node benchmarks/run-deterministic.mjs.`);
    process.exit(1);
  }
  console.log(`${reportPath} is up to date.`);
} else {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown, "utf8");
  console.log(`Wrote ${reportPath}`);
}
