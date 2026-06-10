# Executor Pi Eval Competitor Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Executor (`https://executor.sh`, npm package/binary `executor`) as a first-class competitor in the opt-in `@caplets/benchmarks` Pi live tool-surface eval, so we can compare Caplets modes against Executor using the same Pi agent, same benchmark task, same fixture tools, same scoring, and comparable token/tool-call metrics.

**Primary comparison:** `executor-mcp` vs Caplets' strongest current modes, especially `caplets-code-mode` and `caplets-progressive-code-mode`.

**Recommendation:** Implement the first version as an **Executor MCP gateway mode inside the existing Pi eval harness**, not as a separate benchmark runner. Executor itself is exposed to Pi through MCP (`executor mcp`), and Executor can ingest our existing benchmark fixture MCP servers. Because Pi does not natively support MCP, the Executor mode should load the `npm:pi-mcp-adapter` Pi extension as the MCP bridge and use the adapter's `directTools` exposure. This gives the fairest direct-tool product comparison: Pi + Caplets native extension versus Pi + `pi-mcp-adapter` direct Executor tools backed by the Executor MCP endpoint.

**Tech Stack:** TypeScript, Commander, Vitest, Pi live eval harness, existing benchmark MCP fixture server, Executor CLI/MCP, `pnpm` checks.

---

## Current Harness Findings

The existing Pi eval harness lives under:

- `packages/benchmarks/run-pi-eval.ts`
- `packages/benchmarks/lib/pi-eval/config.ts`
- `packages/benchmarks/lib/pi-eval/metrics.ts`
- `packages/benchmarks/lib/pi-eval/report.ts`
- tests in `packages/benchmarks/test/benchmark.test.ts`

Current modes are:

```ts
export const PI_EVAL_MODES = [
  "caplets-direct",
  "caplets-progressive",
  "caplets-code-mode",
  "caplets-progressive-code-mode",
] as const;
```

Current run setup:

1. Creates isolated run dirs.
2. Copies benchmark fixture MCP server into `support/mcp-server.ts`.
3. Writes a Caplets config exposing `issues`, `ci`, `docs`, `api`, and `code-map` fixture servers.
4. Runs Pi in JSON mode with:
   - instrumentation extension
   - Caplets Pi extension
   - isolated `PI_CODING_AGENT_DIR`
   - isolated session dir
   - `CAPLETS_CONFIG`
5. Scores the edited candidate workspace with visible and hidden validation.
6. Requires external evidence coverage for `checkout-incident-retry-hardening`: issues, ci, docs, api.
7. Summarizes token estimates, tool surface estimates, round trips, tool calls, domain coverage, hybrid choice, pass rate, and failures.

The harness already measures the exact outcomes we want for a competitor comparison, but the type/config model currently assumes every mode is a Caplets exposure mode.

---

## Executor Findings

Executor public docs and repository state show:

- Install: `npm install -g executor`.
- Local runtime/UI: `executor web`, default UI/API at `http://127.0.0.1:4788` / `http://localhost:4788`.
- MCP endpoint for agents: `executor mcp`.
- CLI can call tools and auto-start a daemon for some commands: `executor call`, `executor tools search`, `executor tools describe`.
- Executor stores data under `EXECUTOR_DATA_DIR` or `~/.executor`.
- Executor supports a scoped workspace via `EXECUTOR_SCOPE_DIR`; scope defaults are cwd-sensitive in CLI code.
- Executor supports MCP sources. SDK docs show a source can be added with:

```ts
await executor.mcp.addSource({
  scope,
  transport: "stdio",
  name: "My Server",
  command: "npx",
  args: ["-y", "@my/mcp-server"],
});
```

- README shows CLI-based source add pattern, e.g.:

```bash
executor call executor openapi addSource '{...}'
```

The exact current CLI path/payload for adding MCP stdio sources needs a local smoke check against the installed Executor version, but the integration plan should isolate that variability behind a small setup helper.

---

## Benchmark Semantics

### What We Should Compare

Compare agent-facing integration strategies, not raw MCP servers:

| Mode                            | Agent sees                                                                       | Setup owner                           | Intended measurement                          |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| `caplets-direct`                | flattened native Caplets tools                                                   | Caplets Pi extension                  | direct tool-surface baseline                  |
| `caplets-progressive`           | Caplets progressive native tools                                                 | Caplets Pi extension                  | capability-card discovery/tool-call overhead  |
| `caplets-code-mode`             | `caplets_code_mode` native tool                                                  | Caplets Pi extension                  | one-call typed discovery/retrieval efficiency |
| `caplets-progressive-code-mode` | progressive + Code Mode                                                          | Caplets Pi extension                  | best hybrid Caplets UX                        |
| `executor-mcp`                  | Executor MCP tools exposed as direct Pi tools via `pi-mcp-adapter` `directTools` | Executor CLI/runtime + Pi MCP adapter | competitor direct-tool gateway behavior       |

### What We Should Not Compare In V1

Do not compare Caplets Code Mode against Executor's private SDK/runtime directly from a custom benchmark harness in V1. That would be a useful future benchmark, but it would not reflect Executor's documented agent entrypoint (`executor mcp`) as clearly.

Do not mutate the user's real Executor data directory. Every live run should use an isolated `EXECUTOR_DATA_DIR` and `EXECUTOR_SCOPE_DIR` under the run root.

Do not make Executor a dependency of deterministic benchmark checks. This remains opt-in live benchmark functionality only.

---

## Architecture

### 1. Split Pi eval modes into products

Extend mode metadata from string-only mode handling to a typed product/mode descriptor.

Suggested shape:

```ts
export const PI_EVAL_MODES = [
  "caplets-direct",
  "caplets-progressive",
  "caplets-code-mode",
  "caplets-progressive-code-mode",
  "executor-mcp",
] as const;

export type PiEvalMode = (typeof PI_EVAL_MODES)[number];
export type PiEvalProduct = "caplets" | "executor";

export function piEvalModeProduct(mode: PiEvalMode): PiEvalProduct {
  return mode === "executor-mcp" ? "executor" : "caplets";
}
```

Keep `PI_EVAL_MODES` complete by default so the standard live run compares all supported modes, but add CLI filtering patterns so users can run:

```bash
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi-eval -- --mode executor-mcp,caplets-code-mode
```

### 2. Add product-specific run config builders

Replace the single `createPiEvalRunConfig({ mode })` path with a dispatcher:

```ts
export async function createPiEvalRunConfig(input) {
  validatePiEvalMode(input.mode);
  if (input.mode === "executor-mcp") return createExecutorPiEvalRunConfig(input);
  return createCapletsPiEvalRunConfig(input);
}
```

Keep Caplets behavior unchanged by moving the current body into `createCapletsPiEvalRunConfig`.

Add a new `createExecutorPiEvalRunConfig` that:

- creates the same `runRoot`, `supportDir`, `sessionsDir`, `agentDir`, and instrumentation paths;
- copies the same Pi auth files (`auth.json`, `models.json`) into the isolated Pi agent dir;
- copies the fixture server into `support/mcp-server.ts`;
- creates isolated Executor paths:
  - `executorDataDir = join(runRoot, "executor-data")`
  - `executorScopeDir = join(runRoot, "executor-scope")`
- registers the benchmark fixture servers as Executor MCP sources;
- starts/uses Executor MCP for Pi;
- returns a common public run config shape with product metadata.

### 3. Configure Executor with the same fixture sources

Executor must ingest the same five fixture MCP servers used by Caplets:

- `issues`
- `ci`
- `docs`
- `api`
- `code-map`

Each source should launch the fixture server as stdio:

```json
{
  "transport": "stdio",
  "name": "issues",
  "command": "tsx",
  "args": ["/path/to/support/mcp-server.ts", "--server", "issues"]
}
```

There are two practical implementation choices. Prefer A if the installed Executor CLI supports it reliably; otherwise use B.

#### Option A: Configure via Executor CLI

Use the documented CLI pattern:

```bash
executor call executor mcp addSource '{...}'
```

or the actual discovered path if current Executor exposes it differently. Encapsulate this in `addExecutorMcpSource()` so CLI path changes are localized.

Pros:

- Tests the product like a user would configure it.
- No direct dependency on Executor SDK internals.

Cons:

- Requires smoke-discovering exact CLI tool path and payload.
- CLI output and daemon autostart behavior may change.

#### Option B: Configure by a generated setup script using Executor SDK/runtime

Generate a small temporary setup script under the run root and execute it with the installed `executor` package's API or CLI runtime.

Pros:

- More deterministic setup if CLI add paths are unstable.

Cons:

- More coupled to Executor internals.
- Less representative of documented user setup.

### 4. Expose Executor to Pi through `pi-mcp-adapter`

Pi does not natively support MCP. The Executor mode should therefore load the `npm:pi-mcp-adapter` Pi extension and configure that adapter to connect to Executor's MCP server.

Concrete adapter contract from `pi-mcp-adapter@2.9.0`:

- Pi extension install/load source: `npm:pi-mcp-adapter`; package manifest declares `pi.extensions: ["./index.ts"]`.
- Runtime config override flag: `--mcp-config <path>`; the extension registers `mcp-config` and calls `loadMcpConfig(pi.getFlag("mcp-config"), ctx.cwd)`.
- Default Pi-owned global config path without the flag: `$PI_CODING_AGENT_DIR/mcp.json`, falling back to `~/.pi/agent/mcp.json`.
- Config lookup/merge order when using an override path is: `~/.config/mcp/mcp.json`, override/pi-global config, cwd `.mcp.json`, cwd `.pi/mcp.json`. Later sources override earlier servers/settings.
- Config schema root: `{ "settings"?: {...}, "mcpServers": { [name]: ServerEntry }, "imports"?: [...] }`.
- Stdio server fields: `command`, `args`, `env`, `cwd`, `lifecycle`, `idleTimeout`, `directTools`, `excludeTools`, `debug`, `exposeResources`.
- HTTP server fields also exist (`url`, `headers`, `auth`, bearer/OAuth fields), but Executor should use stdio for the benchmark: `command: "executor", args: ["mcp"]`.
- Tool exposure defaults to a single proxy tool named `mcp`; direct tools are registered when `settings.directTools`, per-server `directTools`, or `MCP_DIRECT_TOOLS` requests them.
- `MCP_DIRECT_TOOLS=executor` requests all direct tools from the `executor` server.
- Direct tools are resolved from the adapter metadata cache (`mcp-cache.json`) during extension module load. If the cache is missing or invalid, the adapter can bootstrap metadata during `session_start`, but those tools are not registered until a subsequent Pi process.
- `disableProxyTool: true` removes the `mcp` proxy only when direct specs exist and no configured direct-tool server is missing from cache. This is why the measured benchmark run needs prewarmed metadata.

Use the least invasive path:

1. Create an isolated Pi agent dir (`PI_CODING_AGENT_DIR`) as the harness already does.
2. Keep the instrumentation extension enabled for metrics.
3. Add `npm:pi-mcp-adapter` to `extensionPaths` for `executor-mcp` runs.
4. Do **not** load the Caplets Pi extension for `executor-mcp`.
5. Write only the minimal adapter config required by `pi-mcp-adapter` under the isolated run root / agent dir. The adapter should receive one MCP server entry for Executor:

```json
{
  "settings": {
    "toolPrefix": "server",
    "directTools": true,
    "disableProxyTool": true,
    "sampling": false,
    "elicitation": false,
    "idleTimeout": 0
  },
  "mcpServers": {
    "executor": {
      "command": "executor",
      "args": ["mcp"],
      "env": {
        "EXECUTOR_DATA_DIR": "/tmp/.../executor-data",
        "EXECUTOR_SCOPE_DIR": "/tmp/.../executor-scope"
      },
      "cwd": "/tmp/.../support",
      "lifecycle": "eager",
      "idleTimeout": 0,
      "exposeResources": true,
      "directTools": true,
      "debug": false
    }
  }
}
```

6. Pass the adapter config path with Pi's extension flag registered by the adapter: `--mcp-config <runRoot>/executor-mcp.json`. `pi-mcp-adapter` reads this via `pi.getFlag("mcp-config")` at session start and treats it as the Pi global MCP config path.
7. Set `HOME=<runRoot>/home` and `PI_CODING_AGENT_DIR=<runRoot>/pi-agent` for the Pi process. This is required because the adapter still reads `~/.config/mcp/mcp.json` before the override path; `--mcp-config` alone is not enough to avoid user-global config leakage.
8. Add `MCP_DIRECT_TOOLS=executor` to the run env and configure direct tools in the adapter config.
9. Run an unmeasured prewarm Pi process with the same adapter config, same isolated `HOME`, and same isolated `PI_CODING_AGENT_DIR` before the measured candidate run. The prewarm process exists only to let `pi-mcp-adapter` connect to `executor mcp` and write `mcp-cache.json`; direct tools are then registered at module load in the measured process.
10. Keep the prewarm run out of benchmark metrics and reports, except for a diagnostic field such as `adapterDirectToolsPrewarmed: true`.

The important constraint is no leakage from the user's real Pi or Executor config. `executor-mcp` should load only:

- benchmark instrumentation extension;
- `npm:pi-mcp-adapter`;
- `--mcp-config <runRoot>/executor-mcp.json`;
- isolated `HOME` and `PI_CODING_AGENT_DIR`;
- isolated adapter config pointing at isolated Executor state;
- `MCP_DIRECT_TOOLS=executor` for direct Executor tool exposure.

### 5. Add Executor detection

Add `lib/pi-eval/executor.ts` or `lib/executor-runner.ts` with:

```ts
export async function detectExecutorCli({ env = process.env } = {}) {
  // Run `executor --version` or equivalent with runProcess.
}
```

Behavior:

- Only required when `executor-mcp` is in the selected matrix.
- Error clearly if unavailable:

```text
Executor CLI is required for executor-mcp mode. Install with `npm install -g executor` or pass --executor-command <path>.
```

Add CLI options:

```bash
--executor-command <command>     # default: executor
--skip-missing-competitors       # optional; skip executor-mcp if unavailable instead of failing
```

Default should probably fail when explicitly requested and skip only if user asks.

### 6. Prompt hints

Add an Executor-specific prompt hint in `buildPiEvalPrompt`:

```ts
"executor-mcp":
  "Executor is available through direct Pi tools registered by the MCP adapter. Use the `executor_...` tools to inspect current issue, CI, docs, API facts, and code-map hints before editing. Do not use Caplets tools."
```

Do not tell the model Caplets exists in the Executor mode. Keep benchmark prompts product-neutral except for tool-use guidance.

### 7. Metrics and classification

Extend `classifyHybridChoice()` to classify Executor usage:

- If `mode === "executor-mcp"` and tool names include direct adapter tools with the `executor_` prefix, return `executor-only`.
- If `mode === "executor-mcp"` and tool names include the adapter proxy tool `mcp`, flag the run as a direct-tools prewarm/cache failure unless it occurred only in the unmeasured prewarm run.
- If tool names include `executor` or Executor MCP-emitted tool paths, return `executor-only`.
- If mixed with Caplets somehow, classify `mixed-executor-caplets` and fail/flag the run because `executor-mcp` should not have Caplets extension loaded.

Extend domain coverage patterns if Executor tool names/result wrappers obscure fixture server names. Keep existing content-based evidence checks, because result content includes benchmark IDs like `BENCH-451`, `CI-9182`, `/checkout/authorize`, and runbook text. Record an `adapterExposure: "direct-tools"` field so report consumers know Executor was evaluated through first-class direct adapter tools, not the proxy-only `mcp` tool.

Add report columns/summary fields:

- `product`: `caplets` or `executor`
- `averageExecutorToolCalls` is not necessary if `averageToolCalls` works.
- Keep existing token/round-trip metrics.

Add explicit comparisons:

- `executor-mcp vs caplets-direct`
- `executor-mcp vs caplets-progressive`
- `executor-mcp vs caplets-code-mode`
- `executor-mcp vs caplets-progressive-code-mode`

### 8. Report language

Rename the report title from a Caplets-only framing to a competitor-neutral one:

```md
# Pi Live Tool Gateway Eval
```

Keep benchmark schema ID stable or bump schema version:

```ts
schemaVersion: 2,
benchmark: "pi-live-tool-gateway-eval"
```

Add a compatibility note in the JSON/Markdown report:

- live, local/model-dependent;
- not deterministic product claims;
- Executor version recorded;
- Caplets package commit/version recorded where available.

---

## Implementation Tasks

## Task 1: Add mode metadata and failing tests

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Add `"executor-mcp"` to `PI_EVAL_MODES`.
- [ ] Add `piEvalModeProduct(mode)` returning `"executor"` for `executor-mcp`, `"caplets"` otherwise.
- [ ] Update mode validation tests to include `executor-mcp` in the default matrix.
- [ ] Add prompt test asserting `buildPiEvalPrompt(task, "executor-mcp")` mentions Executor and does not mention Caplets-specific tool names.
- [ ] Run focused tests and confirm expected failures before implementation updates:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts
```

## Task 2: Preserve Caplets config path via a renamed builder

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Rename current `createPiEvalRunConfig` internals to `createCapletsPiEvalRunConfig`.
- [ ] Add dispatcher `createPiEvalRunConfig` that routes by mode.
- [ ] Keep all existing Caplets tests passing unchanged.
- [ ] Ensure `caplets-direct` still writes the same config and extension paths as before.

## Task 3: Add Executor CLI detection

**Files:**

- Create: `packages/benchmarks/lib/pi-eval/executor.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Implement `detectExecutorCli({ command, env, processRunner })`.
- [ ] Add `--executor-command <command>` CLI option, default `executor`.
- [ ] Add detection only when the selected matrix contains `executor-mcp`.
- [ ] Record Executor command/version in each `executor-mcp` result.
- [ ] Add tests that:
  - explicit `executor-mcp` fails with a clear message if Executor is unavailable;
  - Caplets-only mode selections do not require Executor.

## Task 4: Build isolated Executor run config

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
- Create or modify: `packages/benchmarks/lib/pi-eval/executor.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Add `createExecutorPiEvalRunConfig`.
- [ ] Create isolated dirs:
  - `support/`
  - `agent/`
  - `sessions/`
  - `extensions/`
  - `executor-data/`
  - `executor-scope/`
- [ ] Copy fixture server and instrumentation extension.
- [ ] Copy only Pi auth-bearing files (`auth.json`, `models.json`) into the isolated agent dir.
- [ ] Return common fields:
  - `runRoot`
  - `mode`
  - `product: "executor"`
  - `metricsPath`
  - `agentDir`
  - `sessionsDir`
  - `extensionPaths: [instrumentationPath, "npm:pi-mcp-adapter"]`
  - `adapterConfigPath` or equivalent pointing at the generated `pi-mcp-adapter` MCP server config
  - `adapterHomeDir` and `adapterAgentDir` for adapter/global config isolation
  - `env` with isolated `HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `MCP_DIRECT_TOOLS=executor`, `EXECUTOR_DATA_DIR`, `EXECUTOR_SCOPE_DIR`, isolated PATH, adapter config env, and live benchmark flags.
- [ ] Add tests asserting Executor config includes `npm:pi-mcp-adapter`, does not include the Caplets Pi extension, and does not write `CAPLETS_CONFIG` unless needed by some setup helper.

## Task 5: Register benchmark fixture MCP sources in Executor

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/executor.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Add tests in: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Implement `setupExecutorFixtureSources({ executorCommand, fixtureServerPath, supportDir, env, processRunner })`.
- [ ] Use the same selected server list as the Caplets checkout eval: `issues`, `ci`, `docs`, `api`, `code-map`.
- [ ] For each server, configure a stdio MCP source launching:

```bash
tsx <fixtureServerPath> --server <server>
```

- [ ] Prefer CLI setup using Executor's `executor call ... addSource` path.
- [ ] If CLI path is not stable, add a fallback setup script but keep it isolated and documented.
- [ ] Add unit tests using an injected process runner to assert the exact source payloads and env isolation.
- [ ] Add an opt-in local smoke command in docs/comments:

```bash
EXECUTOR_DATA_DIR=$(mktemp -d) EXECUTOR_SCOPE_DIR=$(mktemp -d) executor tools sources
```

## Task 6: Load `pi-mcp-adapter` direct tools for Executor MCP without user config leakage

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
- Modify: `packages/benchmarks/lib/pi-eval/executor.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Add tests in: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Write the adapter MCP config under `runRoot`, e.g. `join(runRoot, "executor-mcp.json")`.
- [ ] Add `"npm:pi-mcp-adapter"` to `executor-mcp` `extensionPaths` after the instrumentation extension.
- [ ] Pass adapter config to Pi with extra args: `--mcp-config <adapterConfigPath>`.
- [ ] Configure the adapter config as:

```json
{
  "settings": {
    "toolPrefix": "server",
    "directTools": true,
    "disableProxyTool": true,
    "sampling": false,
    "elicitation": false
  },
  "mcpServers": {
    "executor": {
      "command": "executor",
      "args": ["mcp"],
      "env": {
        "EXECUTOR_DATA_DIR": "/tmp/.../executor-data",
        "EXECUTOR_SCOPE_DIR": "/tmp/.../executor-scope"
      },
      "cwd": "/tmp/.../support",
      "lifecycle": "eager",
      "idleTimeout": 0,
      "exposeResources": true,
      "directTools": true,
      "debug": false
    }
  }
}
```

- [ ] Add `MCP_DIRECT_TOOLS=executor` to the `executor-mcp` env to guarantee direct Executor tool exposure.
- [ ] Set `HOME=<runRoot>/home` and `PI_CODING_AGENT_DIR=<runRoot>/pi-agent` to prevent adapter reads from real `~/.config/mcp/mcp.json` and real Pi agent config and to keep `mcp-cache.json` isolated.
- [ ] Add an unmeasured direct-tools prewarm step that runs Pi once with the same adapter config/env/agent dir so `pi-mcp-adapter` writes a valid `mcp-cache.json` before the measured run starts.
- [ ] Ensure the measured run starts only after cache prewarm succeeds and direct tool schemas are expected to be registered during extension module load.
- [ ] Keep `--no-context-files`, `--no-skills`, `--no-prompt-templates`, and `--no-themes`; adapter config is supplied by `--mcp-config`, not project context files.
- [ ] Add a test that `executor-mcp` command includes instrumentation, `npm:pi-mcp-adapter`, and `--mcp-config`, but not the Caplets Pi extension.
- [ ] Add a test that `executor-mcp` command/env isolates `HOME`, `PI_CODING_AGENT_DIR`, `MCP_DIRECT_TOOLS=executor`, `EXECUTOR_DATA_DIR`, and `EXECUTOR_SCOPE_DIR`.
- [ ] Add a test that the direct-tools prewarm command uses the same adapter config and isolated agent dir but writes to separate/unreported metrics/session artifacts.

## Task 7: Extend metrics classification and reports

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/metrics.ts`
- Modify: `packages/benchmarks/lib/pi-eval/report.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`

- [ ] Classify Executor tool usage as `executor-only`.
- [ ] Detect and flag mixed Caplets/Executor usage.
- [ ] Add `product` to result rows and summary rows.
- [ ] Add Executor comparison rows.
- [ ] Rename Markdown title to `Pi Live Tool Gateway Eval`.
- [ ] Bump JSON schema version to `2` if consumers might rely on title/shape.
- [ ] Add tests for summary/report including `executor-mcp` and comparisons versus Caplets modes.

## Task 8: Update docs and scripts

**Files:**

- Modify: `packages/benchmarks/package.json`
- Modify: `package.json`
- Modify: `docs/benchmarks/coding-agent.md` if generated/static live docs mention Pi eval
- Possibly modify: `packages/benchmarks/lib/surface.ts` if it documents live commands

- [ ] Add a convenience script if useful:

```json
"benchmark:live:pi-eval:competitors": "tsx run-pi-eval.ts --mode caplets-code-mode,caplets-progressive-code-mode,executor-mcp"
```

or keep the existing script and document the `--mode` invocation.

- [ ] Document prerequisites:

```bash
npm install -g executor
pnpm build
CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi-eval -- --mode caplets-code-mode,caplets-progressive-code-mode,executor-mcp
```

- [ ] Document that all Executor state is isolated with `EXECUTOR_DATA_DIR` and `EXECUTOR_SCOPE_DIR`.
- [ ] Document that live results are local/model-dependent and not deterministic product claims.

## Task 9: Verification

- [ ] Run focused tests:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts
```

- [ ] Run package typecheck:

```bash
pnpm --filter @caplets/benchmarks typecheck
```

- [ ] Run benchmark deterministic check if docs generated output changed:

```bash
pnpm --filter @caplets/benchmarks benchmark:check
```

- [ ] Run a live smoke test with one task/mode after `pnpm build` and Executor install:

```bash
CAPLETS_BENCH_LIVE=1 pnpm --filter @caplets/benchmarks benchmark:live:pi-eval -- --mode executor-mcp --tasks checkout-incident-retry-hardening --runs 1 --timeout-ms 600000 --preserve-artifacts
```

- [ ] Run the comparative smoke:

```bash
CAPLETS_BENCH_LIVE=1 pnpm --filter @caplets/benchmarks benchmark:live:pi-eval -- --mode caplets-code-mode,caplets-progressive-code-mode,executor-mcp --tasks checkout-incident-retry-hardening --runs 1 --timeout-ms 600000
```

- [ ] Confirm report includes:
  - `executor-mcp` row;
  - Executor version/command;
  - same scoring/hidden validation as Caplets modes;
  - required evidence coverage;
  - token/round-trip/tool-call comparisons versus Caplets modes.

---

## Risks and Mitigations

### Risk: Executor CLI source registration path is unstable

Mitigation: Hide it behind `setupExecutorFixtureSources` and write tests against our adapter. Add a local smoke check for current Executor before relying on it.

### Risk: `pi-mcp-adapter` configuration conflicts with benchmark isolation

Mitigation: Configure `pi-mcp-adapter` through an isolated run-root config and `--mcp-config`, and also set isolated `HOME` plus `PI_CODING_AGENT_DIR`. This matters because `pi-mcp-adapter@2.9.0` reads `~/.config/mcp/mcp.json` before the override path. The isolated `HOME`, `PI_CODING_AGENT_DIR`, `EXECUTOR_DATA_DIR`, and `EXECUTOR_SCOPE_DIR` prevent leakage. Direct tools make the isolated agent dir even more important because `mcp-cache.json` controls which direct tool schemas are registered at startup.

### Risk: Executor daemon/process cleanup

Mitigation: Use `EXECUTOR_DATA_DIR`/`EXECUTOR_SCOPE_DIR` under `runRoot`. Prefer foreground `executor mcp` spawned by Pi so process lifetime is owned by the MCP client. If setup starts a daemon, stop it explicitly in `finally` and remove `runRoot` unless artifacts are preserved.

### Risk: Product unfairness from source setup differences

Mitigation: Use exactly the same fixture server implementations and same five domains. Caplets config and Executor source setup should both point at copied `support/mcp-server.ts` with the same server names.

### Risk: Tool-name/domain coverage misses Executor-wrapped output

Mitigation: Existing content regexes should catch benchmark-specific IDs and text. Add Executor-specific patterns only where necessary, and keep scoring based on actual external facts observed rather than tool names alone.

### Risk: Competitor version drift

Mitigation: Capture `executor --version` in report results. Live reports are local artifacts, not committed deterministic benchmark claims.

---

## Acceptance Criteria

- `executor-mcp` is selectable with `--mode executor-mcp`.
- Default matrix includes Executor or docs clearly state the competitor matrix command if we choose not to include it by default.
- Caplets-only runs behave exactly as before.
- Executor runs use isolated Executor, Pi, and adapter-global state directories, including isolated `HOME` and `PI_CODING_AGENT_DIR`; adapter direct-tool cache prewarm happens only inside that isolated agent dir.
- Executor runs load `npm:pi-mcp-adapter`, pass `--mcp-config`, set `MCP_DIRECT_TOOLS=executor`, expose Executor through first-class direct adapter tools, and do not load the Caplets Pi extension.
- Executor gets the same benchmark fixture domains as Caplets.
- Measured Executor runs fail/flag if they only expose or call the adapter proxy `mcp` tool; `mcp` is acceptable only in the unmeasured prewarm step.
- Reports compare Executor to Caplets modes on pass rate, duration, LLM round trips, estimated request tokens, non-surface tokens, tool surface tokens, and tool calls.
- Tests cover mode parsing, run config isolation, command construction, metrics classification, and report comparisons.
- Focused benchmark tests and typecheck pass.
