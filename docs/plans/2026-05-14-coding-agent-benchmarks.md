# Coding Agent Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reproducible deterministic and opt-in live coding-agent benchmarks comparing Caplets against non-Caplets MCP exposure so README claims have measurable evidence.

**Architecture:** Build a benchmark fixture suite with synthetic coding-agent tasks, mock MCP servers, deterministic context-surface analysis, and live agent runners. Pi is the primary live runner, with OpenCode supported through the same adapter interface when available.

**Tech Stack:** Node 22+, Vitest, MCP SDK, existing Caplets CLI/runtime, Pi CLI, OpenCode CLI, JSON/Markdown reports.

---

## Architectural Decisions

- Benchmark both **direct/flat MCP** and **Pi proxy baseline** against **Caplets progressive disclosure**.
- Keep deterministic benchmarks in normal CI because they are fast, stable, and credential-free.
- Keep live LLM agent benchmarks opt-in via `pnpm benchmark:live` because they require installed agents, credentials, and model-dependent behavior.
- Use local mock MCP servers so benchmark tasks are reproducible and do not depend on GitHub, Linear, docs sites, or network APIs.
- Score live runs by observable task success, not subjective transcript quality.
- Produce machine-readable JSON reports plus Markdown summaries consumed by README.
- Design runner adapters for `pi` and `opencode`; make Pi the default live target.

---

## Proposed Files

- Create `benchmarks/fixtures/coding-agent-workspace/`: small repo fixture copied into temp dirs for each run.
- Create `benchmarks/fixtures/mcp-server.mjs`: deterministic mock MCP server exposing many realistic coding tools.
- Create `benchmarks/fixtures/tasks.json`: benchmark tasks, expected file changes, validation commands, and required MCP facts.
- Create `benchmarks/lib/surface.mjs`: direct vs Caplets tool payload metrics.
- Create `benchmarks/lib/live-agent.mjs`: shared live runner types and process helpers.
- Create `benchmarks/lib/pi-runner.mjs`: Pi live runner.
- Create `benchmarks/lib/opencode-runner.mjs`: OpenCode live runner.
- Create `benchmarks/lib/scoring.mjs`: validation, transcript, and metric scoring.
- Create `benchmarks/run-deterministic.mjs`: deterministic report generator/checker.
- Create `benchmarks/run-live.mjs`: opt-in live benchmark matrix runner.
- Create `docs/benchmarks/coding-agent.md`: committed benchmark report.
- Modify `README.md`: add benchmark/value section.
- Modify `package.json`: add benchmark scripts.
- Modify `.gitignore`: ignore local live benchmark output.
- Modify or replace `test/benchmark.test.ts`: assert deterministic benchmark invariants and report freshness.

---

## Benchmark Matrix

| Mode          | Agent    | MCP Exposure           | Purpose                        |
| ------------- | -------- | ---------------------- | ------------------------------ |
| deterministic | none     | direct flat vs Caplets | CI-safe context/value proof    |
| live          | Pi       | direct flat            | Classic tool-flooding baseline |
| live          | Pi       | Pi MCP adapter proxy   | Harder competitor baseline     |
| live          | Pi       | Caplets                | Primary Caplets result         |
| live          | OpenCode | direct flat            | Optional second agent baseline |
| live          | OpenCode | Caplets                | Optional second agent result   |

---

## Metrics

Deterministic metrics:

- Initial tool count.
- Initial serialized MCP `tools/list` byte size.
- Approximate token count using `Math.ceil(bytes / 4)`.
- Duplicate tool-name collisions in direct flat mode.
- Candidate tools visible before task-specific discovery.
- Expected discovery path length.

Live metrics:

- Task pass rate.
- Validation command result.
- Wall-clock duration.
- Agent process exit code.
- Tool-call count where available from JSON logs.
- Transcript byte size.
- Approximate input/output token proxy where native usage is unavailable.
- Whether the agent selected the correct MCP capability/tool.
- Number of failed/irrelevant MCP calls.

---

## Task 1: Benchmark Fixture Design

**Files:**

- Create `benchmarks/fixtures/tasks.json`
- Create `benchmarks/fixtures/coding-agent-workspace/package.json`
- Create `benchmarks/fixtures/coding-agent-workspace/src/discount.js`
- Create `benchmarks/fixtures/coding-agent-workspace/test/discount.test.js`
- Create `benchmarks/fixtures/coding-agent-workspace/src/retry.js`
- Create `benchmarks/fixtures/coding-agent-workspace/test/retry.test.js`

- [ ] Add a small fixture repo with failing tests.
- [ ] Add tasks that require facts available only through MCP tools.
- [ ] Ensure each task has a deterministic validation command.
- [ ] Keep fixture code JavaScript to avoid adding build dependencies.

Example task shape:

```json
[
  {
    "id": "discount-policy",
    "prompt": "Fix the discount calculation. Use the available MCP tools to inspect the current product policy before editing files. Do not hard-code test-only behavior.",
    "validationCommand": "node --test test/discount.test.js",
    "expectedFiles": ["src/discount.js"],
    "requiredFact": "Premium customers receive 15% off only when the cart total is at least 100."
  },
  {
    "id": "retry-policy",
    "prompt": "Fix retry scheduling. Use the available MCP tools to inspect the retry policy before editing files.",
    "validationCommand": "node --test test/retry.test.js",
    "expectedFiles": ["src/retry.js"],
    "requiredFact": "Retry delays are 100ms, 250ms, and 500ms for attempts 1 through 3."
  }
]
```

---

## Task 2: Mock MCP Server

**Files:**

- Create `benchmarks/fixtures/mcp-server.mjs`

- [ ] Implement one configurable mock MCP server.
- [ ] Expose realistic tool domains like `policy_search`, `policy_get`, `ticket_get`, `api_schema_get`, plus many irrelevant tools.
- [ ] Support `--server policy`, `--server tickets`, and `--server api` modes.
- [ ] Return deterministic structured content.
- [ ] Include duplicate downstream tool names across servers to demonstrate collision avoidance.

Representative tools:

- `search`
- `get`
- `list_recent_changes`
- `read_policy`
- `lookup_schema`
- `get_ticket`
- `search_tickets`
- 30 to 50 distractor tools across domains.

---

## Task 3: Deterministic Surface Benchmark

**Files:**

- Create `benchmarks/lib/surface.mjs`
- Create `benchmarks/run-deterministic.mjs`
- Modify `test/benchmark.test.ts`

- [ ] Build direct flat tool payload from mock server metadata.
- [ ] Build Caplets top-level payload using existing `ServerRegistry` and `capabilityDescription`.
- [ ] Compute byte and approximate token reductions.
- [ ] Count duplicate direct tool names.
- [ ] Assert Caplets reduces initial surface by at least the current PRD threshold: `>= 70%`.
- [ ] Assert Caplets has zero flattened downstream tool-name collisions at top level.
- [ ] Generate `docs/benchmarks/coding-agent.md`.

Expected script:

```json
{
  "scripts": {
    "benchmark": "node benchmarks/run-deterministic.mjs",
    "benchmark:check": "node benchmarks/run-deterministic.mjs --check"
  }
}
```

---

## Task 4: Live Runner Abstraction

**Files:**

- Create `benchmarks/lib/live-agent.mjs`
- Create `benchmarks/lib/scoring.mjs`

- [ ] Define a shared runner contract.
- [ ] Add process execution helper using `child_process.spawn`.
- [ ] Capture stdout, stderr, exit code, duration, and JSON events when available.
- [ ] Add timeout handling that kills only the child process group.
- [ ] Add validation scoring by running each task's validation command in the temp workspace.
- [ ] Never include live benchmark execution in `pnpm verify`.

---

## Task 5: Pi Runner

**Files:**

- Create `benchmarks/lib/pi-runner.mjs`
- Create `benchmarks/live-config/pi/`

- [ ] Detect `pi` CLI availability.
- [ ] Run Pi in print/JSON mode.
- [ ] Use isolated `PI_CODING_AGENT_DIR` per benchmark run.
- [ ] Generate project-local MCP config for each mode: direct flat MCP, Pi MCP adapter proxy, and Caplets.
- [ ] Require explicit env var for live runs, e.g. `CAPLETS_BENCH_LIVE=1`.
- [ ] Record Pi version, model, and command line.

Expected invocation pattern:

```sh
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live -- --agent pi --model provider/model
```

---

## Task 6: OpenCode Runner

**Files:**

- Create `benchmarks/lib/opencode-runner.mjs`

- [ ] Detect `opencode` CLI availability.
- [ ] Run `opencode run --format json --model <model> --dir <workspace> <prompt>`.
- [ ] Use isolated config/env paths where OpenCode supports them.
- [ ] Generate MCP config for direct and Caplets modes.
- [ ] Record OpenCode version, model, and command line.
- [ ] Treat OpenCode as optional in the first live report if Pi is the selected primary agent.

Expected invocation pattern:

```sh
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live -- --agent opencode --model openai/gpt-5.5
```

---

## Task 7: Caplets Benchmark Mode Config

**Files:**

- Create `benchmarks/lib/config.mjs`
- Use existing built `dist/index.js` or package command after `pnpm build`

- [ ] Generate a temp Caplets config pointing at benchmark MCP fixture servers.
- [ ] Start Caplets through MCP stdio from the agent config.
- [ ] Ensure Caplets receives mock servers as downstream `mcpServers`.
- [ ] Keep Caplets config isolated from the user's real config via `CAPLETS_CONFIG`.
- [ ] Add cleanup for temp dirs and spawned processes.

---

## Task 8: Live Benchmark Orchestrator

**Files:**

- Create `benchmarks/run-live.mjs`
- Modify `package.json`

- [ ] Parse CLI args: `--agent`, `--mode`, `--model`, `--tasks`, `--runs`, `--timeout-ms`.
- [ ] Refuse to run unless `CAPLETS_BENCH_LIVE=1`.
- [ ] Copy fixture workspace to a fresh temp dir per task/run/mode.
- [ ] Run matrix: `direct-flat`, `pi-proxy` for Pi only, and `caplets`.
- [ ] Score each run.
- [ ] Write JSON to `benchmark-results/live/<timestamp>.json`.
- [ ] Write Markdown summary to `benchmark-results/live/<timestamp>.md`.

Expected scripts:

```json
{
  "scripts": {
    "benchmark:live": "node benchmarks/run-live.mjs",
    "benchmark:live:pi": "node benchmarks/run-live.mjs --agent pi",
    "benchmark:live:opencode": "node benchmarks/run-live.mjs --agent opencode"
  }
}
```

---

## Task 9: Reports And README

**Files:**

- Create `docs/benchmarks/coding-agent.md`
- Modify `README.md`

- [ ] Add a README section after the product/value description.
- [ ] Include deterministic benchmark headline numbers.
- [ ] Link to full benchmark report.
- [ ] Explain live benchmarks are opt-in and model-dependent.
- [ ] Document exact commands to reproduce.

README section should be factual, not hype:

```md
## Benchmarks

Caplets includes reproducible coding-agent benchmarks that compare direct MCP exposure with Caplets progressive disclosure.

In the deterministic benchmark fixture, Caplets reduces the initial MCP tool surface by at least 70% versus direct flat aggregation while preserving access to every downstream tool through scoped discovery and `call_tool`.

See [`docs/benchmarks/coding-agent.md`](docs/benchmarks/coding-agent.md) for methodology, fixture details, and live Pi/OpenCode benchmark instructions.
```

---

## Task 10: CI And Freshness Checks

**Files:**

- Modify `package.json`
- Modify `.github/workflows/ci.yml` only if adding a separate benchmark check is preferable
- Modify `test/benchmark.test.ts`

- [ ] Add `pnpm benchmark:check`.
- [ ] Include deterministic benchmark freshness either in `pnpm test` or `pnpm verify`.
- [ ] Do not include `benchmark:live` in CI.
- [ ] Ensure `pnpm verify` remains credential-free and deterministic.

Recommended package script change:

```json
{
  "scripts": {
    "benchmark": "node benchmarks/run-deterministic.mjs",
    "benchmark:check": "node benchmarks/run-deterministic.mjs --check",
    "benchmark:live": "node benchmarks/run-live.mjs",
    "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema:check && pnpm test && pnpm benchmark:check && pnpm build"
  }
}
```

---

## Task 11: Validation

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm benchmark`.
- [ ] Run `pnpm benchmark:check`.
- [ ] Run `pnpm verify`.

Optional live validation:

```sh
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi -- --model <provider/model> --runs 1
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:opencode -- --model openai/gpt-5.5 --runs 1
```

Expected:

- Deterministic benchmark passes in CI.
- Live benchmark writes local reports under `benchmark-results/live/`.
- README links to committed deterministic report.
- Live benchmark failures are reported as benchmark results, not test-suite failures.

---

## Risks

- Pi CLI behavior may change; isolate Pi-specific behavior behind `pi-runner.mjs`.
- OpenCode MCP config isolation may need follow-up once exact config paths are verified.
- Live LLM results will vary by model and date; reports must include full run metadata.
- Comparing against `pi-mcp-adapter` is useful but could blur the value claim because it already solves some context-pressure problems. Keeping direct-flat and proxy baselines separate avoids that.
- Tool-call counts may not be available uniformly; scoring must tolerate missing telemetry and still validate task success.
