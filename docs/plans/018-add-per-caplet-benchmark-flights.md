# Plan 018: Add Per-Caplet Benchmark Flights

> Status: TODO
> Planned against: `ac12a174`
> Direction option: #3 — per-Caplet benchmark flights
> Priority: Product bet
> Effort: M
> Fix risk: MEDIUM

## Why this matters

Caplets already has deterministic and opt-in live benchmark infrastructure comparing exposure modes, plus a real-world large MCP suite. Reports aggregate by task/mode, so maintainers cannot answer which specific capability handle improves a workflow, where discovery cost remains high, or whether a change regresses one Caplet while improving the portfolio average.

A benchmark flight is a small, repeatable evaluation unit centered on one primary Caplet, with explicit supporting Caplets, task evidence, baseline modes, and metrics. It is product evidence, not runtime configuration truth.

## Scope

### In scope

- `packages/benchmarks/lib/pi-eval/suites.ts`
- `packages/benchmarks/run-pi-eval.ts`
- Pi eval report/metric rendering under `packages/benchmarks/lib/pi-eval/`
- `packages/benchmarks/fixtures/mcp-real-world-large/tasks.json`
- Benchmark tests
- Generated deterministic benchmark documentation only if its source includes flight summaries

### Out of scope

- Running live model evaluations in CI
- Hard-coding a claim that Caplets always beats vanilla MCP
- Changing runtime Caplet behavior to win a benchmark
- Adding static scenario-ID fixture tests unless IDs are the public selection contract
- Replacing the existing multi-backend suite

## Current state

`packages/benchmarks/lib/pi-eval/suites.ts:177-203` defines one `mcp-real-world-large` suite with five tasks and nine real MCP servers. Every task config exposes the full server list in both Caplets and baseline modes.

`tasks.json` already defines expected facts/evidence for release, docs migration, code navigation, browser verification, and architecture scouting. `run-pi-eval.ts` emits per-run results and mode summaries. Metrics include transcript bytes/token proxy, tool calls, failed/irrelevant calls, semantic correctness, evidence coverage, duration, and success.

Do not duplicate these scoring systems.

## Flight contract

Add optional task metadata:

```ts
type CapletBenchmarkFlight = {
  id: string;
  primaryCapletId: string;
  supportingCapletIds: string[];
  question: string;
  minimumRuns: number;
  baselineModes: PiEvalMode[];
};
```

Semantics:

- `primaryCapletId` is the capability under evaluation.
- Supporting Caplets are necessary context, not hidden extras.
- The configured MCP server set for that task is exactly primary + supporting IDs, in deterministic order.
- Caplets and vanilla/executor baselines receive equivalent backend availability; only exposure/execution mode differs.
- `minimumRuns` defaults to 3 for publishable live evidence. One-run local smoke reports are marked exploratory.
- `question` states the causal hypothesis, for example whether Code Mode reduces model/tool round trips for structural navigation while preserving evidence.

Start by annotating the five existing real-world tasks rather than inventing new facts:

- release-risk brief -> primary GitHub; supporting Git/filesystem;
- dependency-docs migration -> primary Context7; supporting Git/filesystem/DuckDuckGo fallback;
- code-navigation impact -> primary language server or ast-grep (choose one and make the other supporting based on observed expected evidence);
- browser runbook -> primary Playwright; supporting filesystem/Git;
- architecture scout -> primary DeepWiki; supporting GitHub/filesystem.

If a task cannot isolate a credible primary capability, leave it portfolio-only rather than forcing a label.

## Report contract

Add `flightSummary` grouped by flight ID and mode with:

- run count and `exploratory` boolean;
- success/evidence/correctness rates;
- median and range for duration, tool calls, failed/irrelevant calls, transcript bytes, token proxy;
- paired deltas versus each declared baseline when matching task/model/run index exists;
- primary/supporting Caplet IDs and hypothesis question;
- unavailable/config-conflict counts separated from task failure.

Never average unavailable runs into quality metrics. Never label a delta an improvement without direction-aware metric semantics and minimum run count.

## Implementation steps

### 1. Add schema/selection tests

Extend benchmark tests to prove:

- flight metadata validates IDs against suite server inventory;
- primary cannot also appear in supporting IDs;
- configured server set is task-specific and identical across compared products;
- unknown/duplicate Caplet IDs fail before launching an agent;
- tasks without flight metadata retain current full-suite behavior;
- public task metadata includes flight fields but not secrets.

Run:

```sh
pnpm --filter @caplets/benchmarks test
```

Expected before implementation: task-specific server selection/report tests fail.

### 2. Add task-scoped server resolution

Extend `PiEvalSuite` with a function such as:

```ts
realMcpServersForTask(task): string[]
```

Use it inside the per-task run loop before `createPiEvalRunConfig`. Ensure Caplets, `vanilla-mcp`, and competitor modes all receive the same resolved backend set. Required environment checks should only require credentials for selected servers.

Add config-generation tests for GitHub-only/auth and stdio-only flights. Ensure secrets remain in environment/request config and never enter report metadata.

Run benchmark tests. Expected: exit 0.

### 3. Annotate existing real-world tasks

Add flight metadata to tasks where the expected evidence supports a clear primary Caplet. Keep prompts and expected facts unchanged initially so the only variable is backend-surface scoping. Document any portfolio-only task.

Do not add tests that pin the exact five IDs unless flight selection by `--flights` makes that list a user-facing contract.

### 4. Add CLI flight selection

Add:

```sh
--flights <ids>
```

It composes with `--tasks`; selection is their intersection and an empty result is an error. Add validation/help and parser tests. Preserve existing `--tasks` behavior.

Allow an explicit smoke run below `minimumRuns`, but mark it exploratory in output. Do not silently increase a user's requested run count because live cost is material.

### 5. Aggregate and render flight evidence

Add pure summary functions with deterministic unit tests for:

- medians/ranges;
- paired deltas;
- unavailable separation;
- exploratory threshold;
- mixed task/flight reports;
- metrics where lower is better vs higher is better.

Render a concise Markdown section after the existing overall summary. Include raw JSON fields for downstream analysis. Do not claim statistical significance from three runs.

Run:

```sh
pnpm --filter @caplets/benchmarks test
pnpm benchmark:check
```

Expected: exit 0; generated docs remain current if touched.

### 6. Run one pilot flight end to end

Build first, then run one primary flight in at least `caplets-code-mode` and `vanilla-mcp`, three runs each, using the same model and selected servers:

```sh
pnpm build
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi-eval -- \
  --task-suite mcp-real-world-large \
  --flights <pilot-flight> \
  --mode caplets-code-mode,vanilla-mcp \
  --runs 3
```

Expected:

- report contains six completed or explicitly unavailable runs;
- `flightSummary` names the primary/supporting Caplets and paired metrics;
- expected facts/evidence scoring remains active;
- no credential value appears in JSON/Markdown/artifacts.

Do not commit model-dependent result files unless repository benchmark policy explicitly designates a curated report location.

### 7. Finish checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @caplets/benchmarks test
pnpm benchmark:check
```

Expected: exit 0. No package changeset is required for private benchmark tooling unless published package behavior changes.

## Done criteria

- Flight metadata identifies a primary Caplet, explicit support set, hypothesis, baselines, and minimum evidence count.
- Each flight exposes equivalent backend sets across products/modes.
- Reports aggregate correctness, evidence, cost, calls, failures, duration, and paired deltas per flight.
- Exploratory/unavailable results are labeled, not folded into claims.
- Existing portfolio tasks and modes remain compatible.
- One real three-run pilot completes with sanitized artifacts.
- Benchmark tests/check, format, lint, typecheck, and build pass.

## Escape hatches

- If a task requires most of the nine-server stack and no primary capability can be isolated, keep it portfolio-only; do not manufacture causal attribution.
- If live server drift makes expected facts unstable, replace only that task with a fixed authoritative target or local fixture before publishing comparisons.
- If competitor modes cannot receive equivalent backend sets, exclude them from that flight and state why; never compare unequal tool availability.
- If credentials appear in a report, stop, delete the artifact, rotate exposed credentials, and fix sanitization before rerunning.

## Maintenance note

A new Caplet is not benchmarked by adding its ID to a static list. It needs a workflow hypothesis, stable expected evidence, equivalent baselines, repeated runs, and a report slice that separates quality from availability.
