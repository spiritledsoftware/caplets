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
      averageEstimatedOutputTokens: average(rows.map(estimatedOutputTokens)),
      averageRequestPlusOutputEstimatedTokens: average(rows.map(requestPlusOutputTokens)),
      averageNonSurfaceEstimatedTokens: average(
        rows.map((row) => row.metrics?.nonSurfaceEstimatedTokens),
      ),
      averageProviderTokens: average(rows.map((row) => row.metrics?.providerUsage?.totalTokens)),
      averageToolSurfaceEstimatedTokens: average(
        rows.map((row) => row.metrics?.toolSurfaceEstimatedTokens),
      ),
      averageRepeatedSetupCodeEstimatedTokens: average(
        rows.map((row) => row.metrics?.repeatedWorkflow?.repeatedSetupCodeEstimatedTokens),
      ),
      averageSetupCodeReuseRate: averageRaw(
        rows.map((row) => row.metrics?.repeatedWorkflow?.setupCodeReuseRate),
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
      passedOnly: passed > 0 ? passedOnlySummary(rows.filter((row) => row.score?.success)) : null,
    };
  });
  return { byMode, comparisons: comparisons(byMode) };
}

export function renderPiEvalMarkdownReport(report: any): string {
  const rows = report.summary.byMode.map(
    (row: any) =>
      `| ${row.mode} | ${row.product ?? "n/a"} | ${row.adapterExposure ?? "n/a"} | ${row.passed}/${row.total} | ${formatMs(row.averageDurationMs)} | ${formatNumber(row.averageProviderRequestCount)} | ${formatNumber(row.averageRequestEstimatedTokens)} | ${formatNumber(row.averageEstimatedOutputTokens)} | ${formatNumber(row.averageRequestPlusOutputEstimatedTokens)} | ${formatNumber(row.passedOnly?.averageRequestPlusOutputEstimatedTokens)} | ${formatNumber(row.averageNonSurfaceEstimatedTokens)} | ${formatNumber(row.averageProviderTokens)} | ${formatNumber(row.passedOnly?.averageProviderTokens)} | ${formatNumber(row.averageToolSurfaceEstimatedTokens)} | ${formatNumber(row.averageToolCalls)} |`,
  );
  const repeatedRows = report.summary.byMode.map(
    (row: any) =>
      `| ${row.mode} | ${formatNumber(row.averageRepeatedSetupCodeEstimatedTokens)} | ${formatPercent(row.averageSetupCodeReuseRate)} | ${formatNumber(row.averageProviderRequestCount)} | ${formatNumber(row.averageToolCalls)} | ${row.passed}/${row.total} |`,
  );
  const comparisonRows = report.summary.comparisons.map(
    (comparison: any) =>
      `- ${comparison.label}: duration ${formatPercent(comparison.durationReduction)}, LLM round trips ${formatPercent(comparison.providerRequestReduction)}, estimated request tokens ${formatPercent(comparison.requestTokenReduction)}, request+output tokens ${formatPercent(comparison.requestPlusOutputTokenReduction)}, setup-code tokens ${formatPercent(comparison.repeatedSetupTokenReduction)}, provider tokens ${formatPercent(comparison.providerTokenReduction)}`,
  );
  const publishabilityRows = report.summary.comparisons.map(
    (comparison: any) =>
      `| ${comparison.label} | ${comparison.passRateComparable ? "pass" : "fail"} | ${formatPercent(comparison.passRateDelta)} | ${formatPercent(comparison.requestPlusOutputTokenReduction)} | ${formatPercent(comparison.providerTokenReduction)} | ${comparison.publishableTokenEfficiencyClaim ? "yes" : "no"} |`,
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
    "| Mode | Product | Adapter exposure | Passed | Avg total duration | Avg LLM round trips | Avg tokenizer-estimated request tokens | Avg estimated output tokens | Avg request+output estimated tokens | Passed-only request+output estimated tokens | Avg non-surface estimated tokens | Avg provider tokens | Passed-only provider tokens | Avg tool surface estimated tokens | Avg tool calls |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Repeated Workflow Reuse",
    "",
    "Average repeated setup-code tokens are measured from Code Mode run inputs when present. Lower setup-code volume with unchanged task success is evidence of session reuse reducing repeated workflow overhead; live win rates remain model-dependent.",
    "",
    "| Mode | Avg repeated setup-code tokens | Avg setup-code reuse rate | Avg LLM round trips | Avg tool calls | Passed |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...repeatedRows,
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
    "## Publishability Gates",
    "",
    "Pass-rate gate requires the candidate mode to have a pass rate at least as high as the comparison baseline before making a token-efficiency claim.",
    "",
    "| Comparison | Pass-rate gate | Pass-rate delta | Request+output token reduction | Provider token reduction | Publishable token-efficiency claim |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...(publishabilityRows.length ? publishabilityRows : ["| n/a | n/a | n/a | n/a | n/a | no |"]),
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
    ["caplets-progressive", "vanilla-mcp", "caplets-progressive vs vanilla-mcp"],
    ["caplets-progressive", "executor-mcp", "caplets-progressive vs executor-mcp"],
    ["caplets-code-mode", "caplets-progressive", "caplets-code-mode vs caplets-progressive"],
    ["caplets-code-mode", "vanilla-mcp", "caplets-code-mode vs vanilla-mcp"],
    ["caplets-code-mode", "executor-mcp", "caplets-code-mode vs executor-mcp"],
    ["caplets-direct-code-mode", "caplets-direct", "caplets-direct-code-mode vs caplets-direct"],
    [
      "caplets-direct-code-mode",
      "caplets-code-mode",
      "caplets-direct-code-mode vs caplets-code-mode",
    ],
    [
      "caplets-code-mode",
      "caplets-direct-code-mode",
      "caplets-code-mode vs caplets-direct-code-mode",
    ],
    ["caplets-direct-code-mode", "vanilla-mcp", "caplets-direct-code-mode vs vanilla-mcp"],
    ["caplets-direct-code-mode", "executor-mcp", "caplets-direct-code-mode vs executor-mcp"],
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
    ["executor-mcp", "caplets-direct-code-mode", "executor-mcp vs caplets-direct-code-mode"],
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
  const passRateDelta =
    typeof a.passRate === "number" && typeof b.passRate === "number"
      ? a.passRate - b.passRate
      : null;
  const passRateComparable = typeof passRateDelta === "number" && passRateDelta >= 0;
  const requestPlusOutputTokenReduction = reduction(
    b.averageRequestPlusOutputEstimatedTokens,
    a.averageRequestPlusOutputEstimatedTokens,
  );
  const repeatedSetupTokenReduction = reduction(
    b.averageRepeatedSetupCodeEstimatedTokens,
    a.averageRepeatedSetupCodeEstimatedTokens,
  );
  const providerTokenReduction = reduction(b.averageProviderTokens, a.averageProviderTokens);
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
    requestPlusOutputTokenReduction,
    repeatedSetupTokenReduction,
    providerTokenReduction,
    passRateDelta,
    passRateComparable,
    publishableTokenEfficiencyClaim:
      passRateComparable &&
      typeof requestPlusOutputTokenReduction === "number" &&
      requestPlusOutputTokenReduction > 0,
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

function passedOnlySummary(rows: any[]) {
  return {
    total: rows.length,
    averageRequestEstimatedTokens: average(
      rows.map((row) => row.metrics?.requestPayloadEstimatedTokens),
    ),
    averageEstimatedOutputTokens: average(rows.map(estimatedOutputTokens)),
    averageRequestPlusOutputEstimatedTokens: average(rows.map(requestPlusOutputTokens)),
    averageProviderTokens: average(rows.map((row) => row.metrics?.providerUsage?.totalTokens)),
    averageToolCalls: average(
      rows.map((row) => row.metrics?.toolCallCount ?? row.score?.metrics?.toolCallCount),
    ),
    averageProviderRequestCount: average(rows.map((row) => row.metrics?.providerRequestCount)),
  };
}

function estimatedOutputTokens(row: any) {
  const value = row?.metrics?.providerUsage?.outputTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requestPlusOutputTokens(row: any) {
  const requestTokens = row?.metrics?.requestPayloadEstimatedTokens;
  if (typeof requestTokens !== "number" || !Number.isFinite(requestTokens)) return null;
  return requestTokens + estimatedOutputTokens(row);
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

function averageRaw(values: any[]): number | null {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
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
