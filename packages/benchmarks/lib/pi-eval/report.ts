export function summarizePiEvalResults(results: any[] = []) {
  const byMode = groupBy(results, (result) => result.mode).map(([mode, rows]) => {
    const total = rows.length;
    const passed = rows.filter((row) => row.score?.success).length;
    const first = rows[0] ?? {};
    return {
      mode,
      product: first.product ?? null,
      adapterExposure: first.adapterExposure ?? null,
      total,
      passed,
      failed: total - passed,
      passRate: total === 0 ? 0 : passed / total,
      averageDurationMs: average(
        rows.map((row) => row.agentResult?.durationMs ?? row.score?.process?.durationMs),
      ),
      averageProviderRequestCount: average(rows.map((row) => row.metrics?.providerRequestCount)),
      averageRequestEstimatedTokens: average(
        rows.map((row) => row.metrics?.requestPayloadEstimatedTokens),
      ),
      averageNonSurfaceEstimatedTokens: average(
        rows.map((row) => row.metrics?.nonSurfaceEstimatedTokens),
      ),
      averageProviderTokens: average(rows.map((row) => row.metrics?.providerUsage?.totalTokens)),
      averageToolSurfaceEstimatedTokens: average(
        rows.map((row) => row.metrics?.toolSurfaceEstimatedTokens),
      ),
      averageRequestTokenBuckets: averageRequestTokenBuckets(rows),
      averageToolCalls: average(
        rows.map((row) => row.metrics?.toolCallCount ?? row.score?.metrics?.toolCallCount),
      ),
      averageToolEvents: average(rows.map((row) => row.metrics?.toolEventCount)),
      requiredDomainCoverage: domainCoverageSummary(rows),
      hybridChoice: hybridChoiceSummary(rows),
      timedOut: rows.filter((row) => row.agentResult?.timedOut).length,
      skipped: rows.filter((row) => row.agentResult?.skipped).length,
    };
  });
  return { byMode, comparisons: comparisons(byMode) };
}

export function renderPiEvalMarkdownReport(report: any): string {
  const rows = report.summary.byMode.map(
    (row: any) =>
      `| ${row.mode} | ${row.product ?? "n/a"} | ${row.adapterExposure ?? "n/a"} | ${row.passed}/${row.total} | ${formatMs(row.averageDurationMs)} | ${formatNumber(row.averageProviderRequestCount)} | ${formatNumber(row.averageRequestEstimatedTokens)} | ${formatNumber(row.averageNonSurfaceEstimatedTokens)} | ${formatNumber(row.averageProviderTokens)} | ${formatNumber(row.averageToolSurfaceEstimatedTokens)} | ${formatNumber(row.averageToolCalls)} |`,
  );
  const comparisonRows = report.summary.comparisons.map(
    (comparison: any) =>
      `- ${comparison.label}: duration ${formatPercent(comparison.durationReduction)}, LLM round trips ${formatPercent(comparison.providerRequestReduction)}, estimated request tokens ${formatPercent(comparison.requestTokenReduction)}, provider tokens ${formatPercent(comparison.providerTokenReduction)}`,
  );
  const bucketRows = report.summary.byMode.map((row: any) => {
    const buckets = row.averageRequestTokenBuckets ?? {};
    return `| ${row.mode} | ${formatNumber(buckets.requestPayloadEstimatedTokens)} | ${formatNumber(buckets.toolSurfaceEstimatedTokens)} | ${formatNumber(buckets.nonSurfaceEstimatedTokens)} | ${formatNumber(buckets.instructionEstimatedTokens)} | ${formatNumber(buckets.instructionMessageEstimatedTokens)} | ${formatNumber(buckets.userMessageEstimatedTokens)} | ${formatNumber(buckets.assistantMessageEstimatedTokens)} | ${formatNumber(buckets.toolCallMessageEstimatedTokens)} | ${formatNumber(buckets.toolResultMessageEstimatedTokens)} | ${formatNumber(buckets.otherMessageEstimatedTokens)} | ${formatNumber(buckets.requestOverheadEstimatedTokens)} |`;
  });
  const failures = report.results
    .filter((result: any) => !result.score?.success)
    .map(
      (result: any) =>
        `- ${result.mode} ${result.taskId} run ${result.run}: ${failureReason(result)}`,
    );
  const validatorRows = report.results.map(
    (result: any) =>
      `| ${result.mode} | ${result.taskId} | ${result.run} | ${result.score?.validation?.success ? "pass" : "fail"} | ${validatorNote(result)} |`,
  );
  return `${[
    "# Pi Live Tool Gateway Eval",
    "",
    `Generated: ${report.completedAt}`,
    `Model: ${report.options.model ?? "Pi default"}`,
    `Judge model: ${report.options.judgeModel ?? "none"}`,
    `Suite: ${report.suite?.label ?? "Coding agent workspace"}`,
    `Runs per task/mode: ${report.options.runs}`,
    `Concurrency: ${report.options.concurrency ?? 1}`,
    `Timeout: ${report.options.timeoutMs}ms`,
    "",
    "## Summary",
    "",
    "| Mode | Product | Adapter exposure | Passed | Avg total duration | Avg LLM round trips | Avg tokenizer-estimated tokens | Avg non-surface estimated tokens | Avg provider tokens | Avg tool surface estimated tokens | Avg tool calls |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Token Bucket Breakdown",
    "",
    "Average tokenizer-estimated request tokens per run, split by payload bucket. These buckets explain why total tokens can be close even when tool surfaces differ.",
    "",
    "| Mode | Total | Tool surface | Non-surface | Instructions | System/developer messages | User messages | Assistant messages | Tool-call messages | Tool-result messages | Other messages | Request overhead |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...bucketRows,
    "",
    "## Comparisons",
    "",
    ...(comparisonRows.length ? comparisonRows : ["- Not enough data"]),
    "",
    "## Validator Summary",
    "",
    "| Mode | Task | Run | Validator | Notes |",
    "| --- | --- | ---: | --- | --- |",
    ...validatorRows,
    "",
    "## Failures",
    "",
    ...(failures.length ? failures : ["- None"]),
    "",
  ].join("\n")}`;
}

function comparisons(byMode: any[]) {
  const byName = new Map(byMode.map((row) => [row.mode, row]));
  return [
    ["caplets-progressive", "caplets-direct", "caplets-progressive vs caplets-direct"],
    ["caplets-code-mode", "caplets-progressive", "caplets-code-mode vs caplets-progressive"],
    [
      "caplets-progressive-code-mode",
      "caplets-progressive",
      "caplets-progressive-code-mode vs caplets-progressive",
    ],
    [
      "caplets-progressive-code-mode",
      "caplets-code-mode",
      "caplets-progressive-code-mode vs caplets-code-mode",
    ],
    ["caplets-code-mode", "caplets-direct", "caplets-code-mode vs caplets-direct"],
    ["vanilla-mcp", "caplets-direct", "vanilla-mcp vs caplets-direct"],
    ["vanilla-mcp", "caplets-code-mode", "vanilla-mcp vs caplets-code-mode"],
    ["executor-mcp", "vanilla-mcp", "executor-mcp vs vanilla-mcp"],
    ["executor-mcp", "caplets-direct", "executor-mcp vs caplets-direct"],
    ["executor-mcp", "caplets-progressive", "executor-mcp vs caplets-progressive"],
    ["executor-mcp", "caplets-code-mode", "executor-mcp vs caplets-code-mode"],
    [
      "executor-mcp",
      "caplets-progressive-code-mode",
      "executor-mcp vs caplets-progressive-code-mode",
    ],
  ]
    .map(([a, b, label]) => compareRows(byName.get(a), byName.get(b), label))
    .filter(Boolean);
}

function compareRows(a: any, b: any, label: any) {
  if (!a || !b) return null;
  return {
    label,
    durationReduction: reduction(b.averageDurationMs, a.averageDurationMs),
    providerRequestReduction: reduction(
      b.averageProviderRequestCount,
      a.averageProviderRequestCount,
    ),
    requestTokenReduction: reduction(
      b.averageRequestEstimatedTokens,
      a.averageRequestEstimatedTokens,
    ),
    providerTokenReduction: reduction(b.averageProviderTokens, a.averageProviderTokens),
  };
}

function reduction(before: any, after: any): number | null {
  if (typeof before !== "number" || typeof after !== "number" || before === 0) return null;
  return 1 - after / before;
}

function domainCoverageSummary(rows: any[]) {
  const domains = ["issues", "ci", "docs", "api", "codeMap"];
  return Object.fromEntries(
    domains.map((domain) => [
      domain,
      rows.filter((row) => row.metrics?.domainCoverage?.[domain]).length,
    ]),
  );
}

function hybridChoiceSummary(rows: any[]) {
  const choices: Record<string, number> = {};
  for (const row of rows)
    choices[row.metrics?.hybridChoice ?? "unknown"] =
      (choices[row.metrics?.hybridChoice ?? "unknown"] ?? 0) + 1;
  return choices;
}

function averageRequestTokenBuckets(rows: any[]) {
  const bucketNames = [
    "requestPayloadEstimatedTokens",
    "toolSurfaceEstimatedTokens",
    "nonSurfaceEstimatedTokens",
    "messagePayloadEstimatedTokens",
    "instructionEstimatedTokens",
    "instructionMessageEstimatedTokens",
    "userMessageEstimatedTokens",
    "assistantMessageEstimatedTokens",
    "toolCallMessageEstimatedTokens",
    "toolResultMessageEstimatedTokens",
    "otherMessageEstimatedTokens",
    "attributedNonSurfaceEstimatedTokens",
    "requestOverheadEstimatedTokens",
  ];
  return Object.fromEntries(
    bucketNames.map((bucket) => [
      bucket,
      average(rows.map((row) => row.metrics?.requestTokenBuckets?.totals?.[bucket])),
    ]),
  );
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()];
}

function average(values: any[]): number | null {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function formatMs(value: any) {
  return typeof value === "number" ? `${Math.round(value)}ms` : "n/a";
}
function formatNumber(value: any) {
  return typeof value === "number" ? String(Math.round(value)) : "n/a";
}
function formatPercent(value: any) {
  return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : "n/a";
}

function failureReason(result: any) {
  if (result.evidenceScore?.required && !result.evidenceScore.success)
    return `missing required external evidence: ${result.evidenceScore.missingDomains.join(", ")}`;
  if (!result.score?.processSuccess)
    return result.score?.processFailureReason ?? "agent process failed";
  if (!result.score?.validation?.success)
    return failureWithExcerpt("validation", result.score.validation);
  if (!result.score?.hiddenValidation?.success)
    return failureWithExcerpt("hidden validation", result.score.hiddenValidation);
  return "benchmark score failed";
}

function failureWithExcerpt(label: string, processResult: any) {
  const excerpt = validationFailureExcerpt(processResult?.stdout);
  const base = `${label} failed with exit code ${processResult?.exitCode}`;
  return excerpt ? `${base} — ${excerpt}` : base;
}

function validationFailureExcerpt(stdout: any) {
  const interesting = String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("✖ ") && !line.includes("failing tests")) return true;
      return /AssertionError|must not retry|Expected values|actual:|expected:/i.test(line);
    })
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, 4);
  return interesting.join("; ");
}

function validatorNote(result: any) {
  const note = String(result.score?.validation?.stdout ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return note || "n/a";
}
