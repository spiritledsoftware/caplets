# MCP Tool-Use Pi Eval Suite

## Status

Approved design direction from brainstorming. Implementation plan not yet written.

## Goal

Extend the existing live Pi eval harness with a deterministic MCP tool-use suite that measures whether Caplets improves total-token efficiency for realistic multi-tool backend workflows while preserving successful runs.

The suite should exercise the kind of work Caplets is meant to improve:

- discovering the right backend capability without flattening every downstream tool into the prompt
- making dependent MCP tool calls across one or more servers
- reading noisy tool results without carrying unnecessary detail forward
- producing a concise final answer backed by tool evidence

## User Intent

The current coding-agent Pi eval is useful for comparing coding workflow surfaces, but it is too workspace-editing-specific to prove that Caplets creates durable token-efficiency gains for MCP backend use. The new suite should focus directly on MCP server usage and the Caplets progressive-disclosure advantage.

This must not become benchmark-specific prompt tuning. The fixture servers and tasks should be generic enough that an agent could encounter the same shapes in a real user config: API catalogs, incident systems, customer records, deployment status, quality checks, and policy documents.

## Non-Goals

- Do not replace the existing coding-agent Pi eval suite.
- Do not import MCP-Bench as an external validation benchmark.
- Do not depend on live external services, API keys, cloud accounts, or mutable remote datasets.
- Do not modify Caplets runtime behavior as part of this design-only step.
- Do not add task-specific special cases to Caplets, the Pi integration, or benchmark scoring.
- Do not optimize for request-token reduction alone. The primary efficiency metric is total provider tokens: request plus response.
- Do not require workspace edits for this suite.

## MCP-Bench Shape, Not Dependency

MCP-Bench is useful as a reference shape because its tasks model realistic MCP use through task descriptions, fuzzy descriptions, dependency analysis, multi-server workflows, and judge-backed validation.

This suite should borrow those structural ideas, not the benchmark itself. MCP-Bench relies on external servers, API keys, live services, configured model providers, and judge-model stability checks. Those dependencies make it a poor fit for this local Caplets comparison, where we need repeatable fixture behavior and direct attribution of token deltas to MCP surface design.

Reference shape:

- task record fields inspired by `task_description`, `fuzzy_description`, and `dependency_analysis`
- single-server, two-server, and three-server workflows
- tasks that require dependent tool calls rather than one independent lookup
- validation against final answer facts and tool evidence

## Command Surface

Extend the existing command rather than adding a parallel benchmark:

From the `caplets-mono` root:

```bash
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval -- \
  --task-suite mcp-tool-use \
  --model openai-codex/gpt-5.5 \
  --runs 4 \
  --concurrency 8
```

The default remains the current coding-agent behavior:

From the `caplets-mono` root:

```bash
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval
```

Before authoritative runs, build Core first:

From the `caplets-mono` root:

```bash
pnpm --dir ./core run build &&
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval -- \
  --task-suite mcp-tool-use \
  --model openai-codex/gpt-5.5 \
  --runs 4 \
  --concurrency 8
```

Routine iteration should not pass `--preserve-artifacts`; preserved artifacts are reserved for debugging specific failures.

## Suite Registry

Add a Pi eval suite registry, likely in `packages/benchmarks/lib/pi-eval/suites.ts`.

Initial suites:

- `coding`: current default behavior
- `mcp-tool-use`: deterministic local MCP tool-use tasks

Each suite defines:

```ts
type PiEvalSuite = {
  id: "coding" | "mcp-tool-use";
  label: string;
  fixtureRoot: string;
  tasksPath: string;
  workspaceRoot: string | null;
  buildPrompt: (task: PiEvalTask) => string;
  scoreRun: (input: PiEvalScoreInput) => PiEvalScore;
  coverage: PiEvalCoverageSpec;
};
```

The registry keeps shared mode execution intact:

- `caplets-direct`
- `caplets-progressive`
- `caplets-code-mode`
- `caplets-progressive-code-mode`
- `vanilla-mcp`
- `executor-mcp`

Mode setup, concurrency, token accounting, report output, Executor detection, and Pi invocation should stay shared.

## Fixture Layout

Add the new suite under a dedicated fixture root:

```text
packages/benchmarks/fixtures/mcp-tool-use/
  tasks.json
  mcp-server.ts
  validators/
    api-pagination-audit-validator.ts
    incident-customer-impact-join-validator.ts
    release-readiness-risk-report-validator.ts
```

The suite does not need a candidate workspace. If shared runner plumbing requires a workspace path, use an empty deterministic temp workspace and keep scoring independent from file mutations.

## Task Record Shape

`tasks.json` should support fields that are useful to humans, prompts, and validators:

```json
{
  "id": "incident-customer-impact-join",
  "title": "Incident customer impact join",
  "task_description": "Find the active incident, join affected accounts to customer details, and return the customer impact summary.",
  "fuzzy_description": "The agent must discover which incident and customer tools matter, ignore unrelated records, and combine results across servers.",
  "dependency_analysis": {
    "servers": ["incidents", "customers"],
    "requires": [
      "find active incident",
      "read affected account IDs",
      "join account tiers, regions, and escalation contacts"
    ]
  },
  "expectedEvidence": {
    "servers": ["incidents", "customers"],
    "tools": ["incidents.search_incidents", "incidents.get_incident", "customers.get_accounts"]
  },
  "validator": "incident-customer-impact-join"
}
```

Task prompts should ask for a JSON final answer with a known schema. The prompt should not reveal expected tool names, exact IDs, or scoring facts beyond the user-facing task.

## Final Answer Contract

For `mcp-tool-use`, the final assistant answer should contain extractable JSON:

```json
{
  "taskId": "incident-customer-impact-join",
  "decision": "summary_or_go_no_go_value",
  "facts": [
    {
      "key": "activeIncidentId",
      "value": "INC-2026-0610-2",
      "evidence": ["incidents.get_incident"]
    }
  ],
  "summary": "Concise user-facing answer."
}
```

Validators may accept surrounding prose if the JSON block can be extracted. The scoring contract should prefer strict, stable keys over free-form natural-language matching.

## Initial Tasks

### `api-pagination-audit`

Single-server deep discovery.

Server: `api_catalog`

The agent compares search/list endpoints across three product APIs and identifies which operations are paginated, how pagination works, and the required parameter names.

Fixture properties:

- noisy catalog list with unrelated endpoints
- detailed endpoint descriptions behind per-operation lookups
- at least one fallback list endpoint that looks relevant but lacks required pagination behavior
- nested input schema for endpoint detail lookup

Validator checks:

- required operation IDs are present
- pagination styles are correct
- required parameter names are correct
- fallback/non-paginated endpoint is not misclassified
- final facts cite tool-backed evidence

### `incident-customer-impact-join`

Two-server dependent workflow.

Servers: `incidents`, `customers`

The agent finds the active incident, fetches affected account IDs, joins customer details, and reports the impact summary by tier and region with escalation targets.

Fixture properties:

- multiple incidents with similar names and statuses
- affected account IDs are available only after fetching incident details
- customer records are fetched in batches
- distractor accounts and stale incidents exist

Validator checks:

- active incident ID is correct
- affected account count is correct
- tier and region breakdowns are correct
- escalation contacts are correct
- stale incident and unrelated customer facts are excluded

### `release-readiness-risk-report`

Three-server bulky evidence join.

Servers: `deployments`, `quality`, `policies`

The agent decides whether a release can proceed by combining deployment state, failing quality checks, policy exceptions, and risk thresholds.

Fixture properties:

- deployment records with similar versions and environments
- quality checks with pass, fail, warning, and skipped states
- policy thresholds requiring interpretation rather than direct copy
- exception records where some are expired or scoped to another service

Validator checks:

- final go/no-go decision is correct
- blocking checks are identified
- policy threshold interpretation is correct
- valid exceptions are applied and invalid ones ignored
- cited evidence spans all three servers

## Fixture Server Design

The local MCP fixture should expose realistic tool-use shapes:

- compact obvious discovery tools
- schema-requiring detail tools with nested arguments
- noisy list/search responses with distractor records
- deterministic stable IDs
- batch tools where appropriate
- result sizes large enough to make progressive discovery meaningful

Example server groups:

```text
api_catalog
  search_apis
  list_operations
  get_operation
  compare_operations

incidents
  search_incidents
  get_incident
  list_affected_accounts

customers
  get_accounts
  summarize_accounts

deployments
  list_releases
  get_release

quality
  list_checks
  get_check_details

policies
  get_release_policy
  list_exceptions
```

Tool descriptions and schemas should be realistic, but they must not contain benchmark-specific hints such as "this is the correct tool for the eval."

## Scoring

Success requires:

- Pi process exits successfully and does not time out
- final answer JSON can be extracted
- required facts match deterministic expected values
- required server/tool evidence appears in captured events or final citations
- distractor trap facts are not selected

Primary efficiency metric:

- total provider tokens, request plus response

Secondary metrics:

- provider request tokens
- provider response tokens
- provider request count
- MCP tool call count
- tool-result message tokens
- pass rate
- suite-specific coverage score

The existing total-token gap penalty should remain the main comparison signal. A mode that uses fewer request tokens but causes larger response output should not be counted as an efficiency win.

## Reporting

The existing markdown report should include suite identity and preserve current coding-suite output by default.

For `mcp-tool-use`, add task-level rows for:

- mode
- task
- run index
- success/failure
- total provider tokens
- request tokens
- response tokens
- request count
- tool calls
- coverage score
- validator summary

Aggregate comparison should still answer the same product question: whether `caplets-progressive`, `caplets-code-mode`, and `caplets-progressive-code-mode` consistently beat `vanilla-mcp` and `executor-mcp` on total-token efficiency while maintaining successful runs.

## Implementation Boundaries

### `packages/benchmarks/run-pi-eval.ts`

- Add `--task-suite <suite>` with default `coding`.
- Select suite config before loading tasks.
- Use suite-specific prompt builder and scorer.
- Use workspace setup only when the suite has a workspace root.
- Keep shared run matrix, concurrency, reports, and token accounting.

### `packages/benchmarks/lib/pi-eval/config.ts`

- Make fixture server path configurable per suite.
- Keep Caplets, vanilla MCP, and Executor config generation shared.
- Preserve current mode semantics.

### `packages/benchmarks/lib/pi-eval/metrics.ts`

- Generalize hardcoded coding domain coverage into suite-specific coverage specs.
- Preserve current coding coverage behavior exactly for `task-suite=coding`.

### `packages/benchmarks/lib/pi-eval/report.ts`

- Include suite label in report metadata.
- Render validator summaries for non-coding suites.
- Preserve current report shape where possible so historical coding reports remain comparable.

## Tests

Add focused tests for:

- `--task-suite` parsing and validation
- default `coding` suite preserving existing behavior
- unknown suite error message
- suite registry task path and fixture path resolution
- MCP tool-use prompt generation
- successful final JSON extraction
- validator failure for missing facts
- validator failure for distractor facts
- suite-specific coverage calculation
- config generation using the MCP tool-use fixture server
- report rendering with suite metadata

Run the local gate relevant to the implementation:

From the `caplets-mono` root:

```bash
pnpm --dir ./core run build
pnpm --dir ./core --filter @caplets/benchmarks test
```

Before treating live results as authoritative:

From the `caplets-mono` root:

```bash
pnpm --dir ./core run build &&
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval -- \
  --task-suite mcp-tool-use \
  --model openai-codex/gpt-5.5 \
  --runs 4 \
  --concurrency 8
```

## Rollout

1. Land suite-selection plumbing with `coding` as the default and no behavior change.
2. Add deterministic MCP tool-use fixtures and validators.
3. Add `mcp-tool-use` reporting and coverage fields.
4. Run local tests and a small live smoke with one task and one run.
5. Run the full live suite with build-first command and no preserved artifacts.
6. Compare modes on total provider tokens and pass rate.

## Risks

- **Prompt overfitting:** avoid naming exact expected tools or facts in prompts.
- **Validator brittleness:** validate structured final JSON and captured tool evidence instead of relying only on natural-language matching.
- **Fixture unreality:** keep tool schemas and records generic business/backend shapes, not benchmark puzzles.
- **Metric drift:** keep total provider tokens as the primary metric and report request/response split for diagnosis.
- **Regression risk:** default suite must remain `coding`, with existing coding scoring and coverage unchanged.

## Review Gate

After this spec is reviewed, write a separate implementation plan before code changes. The implementation plan should break the work into suite plumbing, fixture server, validators, reporting, tests, and live-eval verification.
