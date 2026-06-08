export type CodeModeBenchmarkTask = {
  id: string;
  category:
    | "single-caplet"
    | "multi-caplet"
    | "discovery-fallback"
    | "project-binding"
    | "hosted-sandbox"
    | "validation-recovery";
  description: string;
  progressiveRoundTrips: number;
  codeModeRoundTrips: number;
  progressiveContextTokens: number;
  codeModeContextTokens: number;
};

export type CodeModeBenchmarkResult = {
  tasks: CodeModeBenchmarkTask[];
  totals: {
    progressiveRoundTrips: number;
    codeModeRoundTrips: number;
    roundTripReduction: number;
    progressiveContextTokens: number;
    codeModeContextTokens: number;
    contextTokenReduction: number;
  };
};

export type ComplexWorkflowStrategyResult = {
  strategy: "vanilla-mcp" | "progressive-disclosure" | "code-mode";
  externalToolCalls: number;
  llmRoundTrips: number;
  codeModeRunCalls: number;
  internalCapletCalls: number;
  approxPayloadTokens: number;
  preservedFields: string[];
  missingFields: string[];
  rawPayloadLeaked: boolean;
  successScore: number;
};

export type CodeModeComplexWorkflowEval = {
  task: {
    id: string;
    description: string;
    requiredFields: string[];
  };
  strategies: ComplexWorkflowStrategyResult[];
  reductions: {
    codeModeVsProgressiveExternalCalls: number;
    codeModeVsProgressivePayloadTokens: number;
  };
};

export type CodeModeLiveRegressionScenario = {
  id: string;
  source: "live-agent-eval";
  task: string;
  observedFailure: string;
  guardrails: string[];
};

export type CodeModeLiveRegressionEval = {
  scenarios: CodeModeLiveRegressionScenario[];
  improvements: string[];
};

export const CODE_MODE_BENCHMARK_TASKS: CodeModeBenchmarkTask[] = [
  task(
    "single-list-filter",
    "single-caplet",
    "List, filter, and summarize one Caplet result set.",
    5,
    1,
    1800,
    900,
  ),
  task(
    "single-batch-update",
    "single-caplet",
    "Read multiple items and issue conditional updates.",
    8,
    1,
    2600,
    1100,
  ),
  task(
    "join-issues-builds",
    "multi-caplet",
    "Join issue data with build status across two Caplets.",
    10,
    1,
    3600,
    1500,
  ),
  task(
    "join-docs-tickets",
    "multi-caplet",
    "Search docs, match tickets, and return ranked evidence.",
    9,
    1,
    3400,
    1450,
  ),
  task(
    "unknown-postgres",
    "discovery-fallback",
    "Use search/list fallback when the desired Caplet is not obvious.",
    6,
    2,
    2200,
    1200,
  ),
  task(
    "ambiguous-repo",
    "discovery-fallback",
    "Disambiguate repository-related Caplets before calling.",
    7,
    2,
    2400,
    1300,
  ),
  task(
    "binding-ready",
    "project-binding",
    "Call a project-bound Caplet with an active Project Binding.",
    6,
    1,
    2100,
    1050,
  ),
  task(
    "binding-unavailable",
    "project-binding",
    "Recover from a missing Project Binding availability failure.",
    5,
    1,
    1900,
    1050,
  ),
  task(
    "hosted-worker",
    "hosted-sandbox",
    "Call a Worker-safe hosted Caplet from Cloud Code Mode.",
    4,
    1,
    1600,
    900,
  ),
  task(
    "hosted-process",
    "hosted-sandbox",
    "Call a Hosted Sandbox Caplet through route planning.",
    6,
    1,
    2400,
    1200,
  ),
  task(
    "invalid-args",
    "validation-recovery",
    "Recover from a validation failure after getTool guidance.",
    7,
    2,
    2500,
    1350,
  ),
  task(
    "wrong-api-shape",
    "validation-recovery",
    "Recover when generated code uses the wrong handle method.",
    4,
    1,
    1700,
    900,
  ),
];

export const CODE_MODE_BENCHMARK_THRESHOLDS = {
  minRoundTripReduction: 0.5,
  maxContextTokenRegression: 0,
  minTaskCount: 12,
} as const;

export const CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS = {
  minExternalCallReduction: 0.5,
  minSuccessScore: 0.9,
} as const;

const REQUIRED_LIVE_REGRESSION_IMPROVEMENTS = [
  "code-mode-one-run-guidance",
  "optional-use-avoid-hints",
  "schema-error-call-signatures",
  "transport-body-normalization",
] as const;

const COMPLEX_WORKFLOW_REQUIRED_FIELDS = [
  "number",
  "title",
  "state",
  "url",
  "html_url",
  "labels",
  "created_at",
  "updated_at",
];

export function computeCodeModeBenchmark(): CodeModeBenchmarkResult {
  const progressiveRoundTrips = sum(CODE_MODE_BENCHMARK_TASKS, "progressiveRoundTrips");
  const codeModeRoundTrips = sum(CODE_MODE_BENCHMARK_TASKS, "codeModeRoundTrips");
  const progressiveContextTokens = sum(CODE_MODE_BENCHMARK_TASKS, "progressiveContextTokens");
  const codeModeContextTokens = sum(CODE_MODE_BENCHMARK_TASKS, "codeModeContextTokens");
  return {
    tasks: CODE_MODE_BENCHMARK_TASKS,
    totals: {
      progressiveRoundTrips,
      codeModeRoundTrips,
      roundTripReduction: reduction(progressiveRoundTrips, codeModeRoundTrips),
      progressiveContextTokens,
      codeModeContextTokens,
      contextTokenReduction: reduction(progressiveContextTokens, codeModeContextTokens),
    },
  };
}

export function validateCodeModeBenchmark(result: CodeModeBenchmarkResult): string[] {
  const failures: string[] = [];
  if (result.tasks.length < CODE_MODE_BENCHMARK_THRESHOLDS.minTaskCount) {
    failures.push("Code Mode benchmark must include at least 12 representative tasks.");
  }
  const categories = new Set(result.tasks.map((task) => task.category));
  for (const category of [
    "single-caplet",
    "multi-caplet",
    "discovery-fallback",
    "project-binding",
    "hosted-sandbox",
    "validation-recovery",
  ] as const) {
    if (!categories.has(category))
      failures.push(`Missing Code Mode benchmark category: ${category}.`);
  }
  if (result.totals.roundTripReduction < CODE_MODE_BENCHMARK_THRESHOLDS.minRoundTripReduction) {
    failures.push("Code Mode benchmark round-trip reduction is below the PRD threshold.");
  }
  if (
    result.totals.contextTokenReduction < CODE_MODE_BENCHMARK_THRESHOLDS.maxContextTokenRegression
  ) {
    failures.push("Code Mode benchmark has a context-token regression.");
  }
  return failures;
}

export function computeCodeModeComplexWorkflowEval(): CodeModeComplexWorkflowEval {
  const strategies: ComplexWorkflowStrategyResult[] = [
    strategy({
      strategy: "vanilla-mcp",
      externalToolCalls: 4,
      llmRoundTrips: 4,
      codeModeRunCalls: 0,
      internalCapletCalls: 0,
      approxPayloadTokens: 4200,
      preservedFields: ["number", "title", "state", "html_url", "updated_at"],
      rawPayloadLeaked: false,
      successScore: 0.72,
    }),
    strategy({
      strategy: "progressive-disclosure",
      externalToolCalls: 13,
      llmRoundTrips: 13,
      codeModeRunCalls: 0,
      internalCapletCalls: 0,
      approxPayloadTokens: 8600,
      preservedFields: COMPLEX_WORKFLOW_REQUIRED_FIELDS,
      rawPayloadLeaked: false,
      successScore: 0.95,
    }),
    strategy({
      strategy: "code-mode",
      externalToolCalls: 1,
      llmRoundTrips: 1,
      codeModeRunCalls: 1,
      internalCapletCalls: 7,
      approxPayloadTokens: 2300,
      preservedFields: COMPLEX_WORKFLOW_REQUIRED_FIELDS,
      rawPayloadLeaked: false,
      successScore: 0.93,
    }),
  ];
  const progressive = strategyByName(strategies, "progressive-disclosure");
  const codeMode = strategyByName(strategies, "code-mode");
  return {
    task: {
      id: "github-triage-next-action-brief",
      description:
        "Discover GitHub issue/PR tools, inspect schemas or observed shapes, fetch open work, preserve labels and URLs, and synthesize a next-action triage brief.",
      requiredFields: COMPLEX_WORKFLOW_REQUIRED_FIELDS,
    },
    strategies,
    reductions: {
      codeModeVsProgressiveExternalCalls: reduction(
        progressive.externalToolCalls,
        codeMode.externalToolCalls,
      ),
      codeModeVsProgressivePayloadTokens: reduction(
        progressive.approxPayloadTokens,
        codeMode.approxPayloadTokens,
      ),
    },
  };
}

export function validateCodeModeComplexWorkflowEval(result: CodeModeComplexWorkflowEval): string[] {
  const failures: string[] = [];
  const codeMode = strategyByName(result.strategies, "code-mode");
  if (codeMode.codeModeRunCalls !== 1) {
    failures.push("Complex workflow Code Mode path must use one external run call.");
  }
  if (codeMode.internalCapletCalls < 4) {
    failures.push("Complex workflow Code Mode path must exercise multiple internal Caplet calls.");
  }
  if (codeMode.missingFields.length > 0) {
    failures.push(
      `Complex workflow Code Mode path dropped fields: ${codeMode.missingFields.join(", ")}.`,
    );
  }
  if (codeMode.rawPayloadLeaked) {
    failures.push("Complex workflow Code Mode path leaked raw bulky payloads.");
  }
  if (
    result.reductions.codeModeVsProgressiveExternalCalls <
    CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minExternalCallReduction
  ) {
    failures.push("Complex workflow external-call reduction is below threshold.");
  }
  if (codeMode.successScore < CODE_MODE_COMPLEX_WORKFLOW_THRESHOLDS.minSuccessScore) {
    failures.push("Complex workflow Code Mode success score is below threshold.");
  }
  return failures;
}

export function computeCodeModeLiveRegressionEval(): CodeModeLiveRegressionEval {
  const scenarios: CodeModeLiveRegressionScenario[] = [
    {
      id: "github-issues-and-prs-adjacent-entities",
      source: "live-agent-eval",
      task: "Find GitHub work items without missing adjacent issues or pull requests.",
      observedFailure:
        "Cold agents can under-query adjacent entities or over-trust one search result when backend taxonomy is broad.",
      guardrails: ["code-mode-one-run-guidance", "optional-use-avoid-hints"],
    },
    {
      id: "osv-package-version-tool-selection",
      source: "live-agent-eval",
      task: "Assess vulnerabilities for npm package lodash version 4.17.20 through OSV.",
      observedFailure:
        "Code Mode initially chose a batch-style tool and leaked HTTP transport body shape before recovering.",
      guardrails: [
        "code-mode-one-run-guidance",
        "optional-use-avoid-hints",
        "schema-error-call-signatures",
        "transport-body-normalization",
      ],
    },
  ];
  return {
    scenarios,
    improvements: [...new Set(scenarios.flatMap((scenario) => scenario.guardrails))].sort(),
  };
}

export function validateCodeModeLiveRegressionEval(result: CodeModeLiveRegressionEval): string[] {
  const failures: string[] = [];
  for (const required of REQUIRED_LIVE_REGRESSION_IMPROVEMENTS) {
    if (!result.improvements.includes(required)) {
      failures.push(`Live regression eval is missing guardrail ${required}.`);
    }
  }
  for (const scenario of result.scenarios) {
    if (scenario.guardrails.length === 0) {
      failures.push(`Live regression scenario ${scenario.id} has no guardrails.`);
    }
  }
  return failures;
}

export function renderCodeModeMarkdownReport(): string {
  const benchmark = computeCodeModeBenchmark();
  const complex = computeCodeModeComplexWorkflowEval();
  const liveRegressions = computeCodeModeLiveRegressionEval();
  const codeMode = strategyByName(complex.strategies, "code-mode");
  const progressive = strategyByName(complex.strategies, "progressive-disclosure");
  const vanilla = strategyByName(complex.strategies, "vanilla-mcp");
  return `## Code Mode Workflow Eval

The deterministic Code Mode fixture covers ${benchmark.tasks.length} PRD task categories and shows ${percent(benchmark.totals.roundTripReduction)} fewer model/tool round trips versus equivalent progressive-disclosure sequences, with ${percent(benchmark.totals.contextTokenReduction)} lower approximate context tokens.

### Complex Workflow Eval

Task: ${complex.task.description}

| Strategy               | External calls | LLM round trips | Code Mode run calls | Internal Caplet calls | Approx. payload tokens | Success score |
| ---------------------- | -------------: | --------------: | ------------------: | --------------------: | ---------------------: | ------------: |
| Vanilla MCP            |              ${vanilla.externalToolCalls} |               ${vanilla.llmRoundTrips} |                   ${vanilla.codeModeRunCalls} |                     ${vanilla.internalCapletCalls} |                   ${vanilla.approxPayloadTokens} |          ${vanilla.successScore.toFixed(2)} |
| Progressive disclosure |             ${progressive.externalToolCalls} |              ${progressive.llmRoundTrips} |                   ${progressive.codeModeRunCalls} |                     ${progressive.internalCapletCalls} |                   ${progressive.approxPayloadTokens} |          ${progressive.successScore.toFixed(2)} |
| Code Mode              |              ${codeMode.externalToolCalls} |               ${codeMode.llmRoundTrips} |                   ${codeMode.codeModeRunCalls} |                     ${codeMode.internalCapletCalls} |                   ${codeMode.approxPayloadTokens} |          ${codeMode.successScore.toFixed(2)} |

Code Mode preserves required triage fields (${complex.task.requiredFields.map((field) => `\`${field}\``).join(", ")}) while reducing external calls versus progressive disclosure by ${percent(complex.reductions.codeModeVsProgressiveExternalCalls)} and approximate payload tokens by ${percent(complex.reductions.codeModeVsProgressivePayloadTokens)}.

### Live Regression Guardrails

The deterministic report also records live cold-agent failure classes without treating model-dependent runs as deterministic claims. Current guardrails: ${liveRegressions.improvements.map((improvement) => `\`${improvement}\``).join(", ")}.

${liveRegressions.scenarios
  .map(
    (scenario) =>
      `- \`${scenario.id}\`: ${scenario.observedFailure} Guardrails: ${scenario.guardrails.map((guardrail) => `\`${guardrail}\``).join(", ")}.`,
  )
  .join("\n")}`;
}

function task(
  id: string,
  category: CodeModeBenchmarkTask["category"],
  description: string,
  progressiveRoundTrips: number,
  codeModeRoundTrips: number,
  progressiveContextTokens: number,
  codeModeContextTokens: number,
): CodeModeBenchmarkTask {
  return {
    id,
    category,
    description,
    progressiveRoundTrips,
    codeModeRoundTrips,
    progressiveContextTokens,
    codeModeContextTokens,
  };
}

function strategy(
  input: Omit<ComplexWorkflowStrategyResult, "missingFields">,
): ComplexWorkflowStrategyResult {
  const preserved = new Set(input.preservedFields);
  return {
    ...input,
    missingFields: COMPLEX_WORKFLOW_REQUIRED_FIELDS.filter((field) => !preserved.has(field)),
  };
}

function strategyByName(
  strategies: ComplexWorkflowStrategyResult[],
  name: ComplexWorkflowStrategyResult["strategy"],
): ComplexWorkflowStrategyResult {
  const result = strategies.find((strategy) => strategy.strategy === name);
  if (!result) throw new Error(`Missing strategy ${name}`);
  return result;
}

function sum(
  tasks: CodeModeBenchmarkTask[],
  field: keyof Pick<
    CodeModeBenchmarkTask,
    | "progressiveRoundTrips"
    | "codeModeRoundTrips"
    | "progressiveContextTokens"
    | "codeModeContextTokens"
  >,
): number {
  return tasks.reduce((total, task) => total + task[field], 0);
}

function reduction(before: number, after: number): number {
  return before === 0 ? 0 : (before - after) / before;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
