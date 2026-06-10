# MCP Tool-Use Pi Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `benchmark:live:pi-eval` with a deterministic `mcp-tool-use` task suite that compares Caplets, vanilla MCP, and Executor on total provider tokens for realistic backend tool workflows.

**Architecture:** Add suite metadata beside the Pi eval harness, so task loading, prompt construction, fixture server selection, and scoring are suite-owned while mode execution stays shared. Keep `coding` as the default suite and add `mcp-tool-use` as an opt-in suite with local MCP fixture servers and structured final-answer validation.

**Tech Stack:** TypeScript, Node 24, pnpm, Vitest, Commander, local MCP fixture servers, Pi JSON-mode event capture.

---

## File Structure

- Create: `packages/benchmarks/lib/pi-eval/suites.ts`
  - Owns suite IDs, suite resolution, suite-specific prompt builders, task metadata publication, and default task IDs.
- Create: `packages/benchmarks/lib/pi-eval/mcp-tool-use-score.ts`
  - Owns final JSON extraction, MCP tool-use fact validation, evidence validation, distractor rejection, and process scoring for the new suite.
- Create: `packages/benchmarks/fixtures/mcp-tool-use/tasks.json`
  - Defines the three deterministic MCP tool-use tasks and expected structured answers.
- Create: `packages/benchmarks/fixtures/mcp-tool-use/mcp-server.ts`
  - Exposes deterministic local MCP servers for `api_catalog`, `incidents`, `customers`, `deployments`, `quality`, and `policies`.
- Modify: `packages/benchmarks/run-pi-eval.ts`
  - Parses `--task-suite`, resolves suite metadata, uses optional workspaces, calls suite prompt/scoring hooks, passes suite fixture options into run config setup, and includes suite metadata in the report.
- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
  - Accepts suite fixture server source path, fixture server IDs, server definitions, and direct-tools env values without changing current defaults.
- Modify: `packages/benchmarks/lib/pi-eval/executor.ts`
  - Allows Executor fixture source setup to use suite-specific server IDs.
- Modify: `packages/benchmarks/lib/pi-eval/metrics.ts`
  - Adds generic evidence coverage helpers while preserving existing coding domain coverage behavior.
- Modify: `packages/benchmarks/lib/pi-eval/report.ts`
  - Renders suite identity, total provider token comparisons, validator summaries, and existing coding-suite rows.
- Modify: `packages/benchmarks/test/benchmark.test.ts`
  - Adds focused tests for suite parsing, config routing, scoring, optional workspace behavior, coverage, and report rendering.

## Task 1: Add Suite Registry And CLI Parsing

**Files:**

- Create: `packages/benchmarks/lib/pi-eval/suites.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing tests for suite parsing and default behavior**

Add these imports to `packages/benchmarks/test/benchmark.test.ts`:

```ts
import {
  DEFAULT_PI_EVAL_SUITE_ID,
  resolvePiEvalSuite,
  validatePiEvalSuiteId,
} from "../lib/pi-eval/suites";
```

Add this test in `describe("Pi live tool surface eval harness", () => { ... })` near the existing arg parsing test:

```ts
it("parses Pi eval task suites without changing the coding default", () => {
  expect(DEFAULT_PI_EVAL_SUITE_ID).toBe("coding");
  expect(parsePiEvalArgs([])).toMatchObject({
    taskSuite: "coding",
    tasks: ["checkout-incident-retry-hardening"],
  });
  expect(parsePiEvalArgs(["--task-suite", "mcp-tool-use"])).toMatchObject({
    taskSuite: "mcp-tool-use",
    tasks: [
      "api-pagination-audit",
      "incident-customer-impact-join",
      "release-readiness-risk-report",
    ],
  });
  expect(() => parsePiEvalArgs(["--task-suite", "missing-suite"])).toThrow(
    /Unknown Pi eval task suite missing-suite/u,
  );
  expect(() => validatePiEvalSuiteId("missing-suite")).toThrow(
    /Unknown Pi eval task suite missing-suite/u,
  );
  expect(resolvePiEvalSuite("coding")).toMatchObject({
    id: "coding",
    label: "Coding agent workspace",
    workspaceRequired: true,
  });
  expect(resolvePiEvalSuite("mcp-tool-use")).toMatchObject({
    id: "mcp-tool-use",
    label: "MCP tool-use workflows",
    workspaceRequired: false,
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "parses Pi eval task suites"
```

Expected: fails because `../lib/pi-eval/suites` does not exist and `parsePiEvalArgs` does not return `taskSuite`.

- [ ] **Step 3: Create the suite registry**

Create `packages/benchmarks/lib/pi-eval/suites.ts`:

```ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiEvalPrompt } from "./config";
import { scoreMcpToolUseRun } from "./mcp-tool-use-score";
import { scoreTaskRun } from "../scoring";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultFixtureRoot = resolve(packageRoot, "fixtures");
const codingFixtureRoot = defaultFixtureRoot;
const mcpToolUseFixtureRoot = resolve(defaultFixtureRoot, "mcp-tool-use");

export const PI_EVAL_SUITE_IDS = ["coding", "mcp-tool-use"] as const;
export type PiEvalSuiteId = (typeof PI_EVAL_SUITE_IDS)[number];
export const DEFAULT_PI_EVAL_SUITE_ID: PiEvalSuiteId = "coding";

export type PiEvalSuite = {
  id: PiEvalSuiteId;
  label: string;
  defaultTasks: string[];
  fixtureRoot: string;
  tasksPath: string;
  workspaceRoot: string | null;
  workspaceRequired: boolean;
  fixtureServerSourcePath: string;
  fixtureServers: string[];
  directToolsEnv: string;
  buildPrompt: (task: any, mode: string) => string;
  scoreRun: (input: any) => Promise<any>;
  publicTaskMetadata: (task: any) => Record<string, unknown>;
};

export function validatePiEvalSuiteId(value: string): asserts value is PiEvalSuiteId {
  if (!(PI_EVAL_SUITE_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown Pi eval task suite ${value}. Expected one of: ${PI_EVAL_SUITE_IDS.join(", ")}`,
    );
  }
}

export function resolvePiEvalSuite(value = DEFAULT_PI_EVAL_SUITE_ID): PiEvalSuite {
  validatePiEvalSuiteId(value);
  if (value === "mcp-tool-use") return mcpToolUseSuite;
  return codingSuite;
}

function publicCodingTaskMetadata(task: any) {
  return {
    id: task.id,
    prompt: task.prompt,
    validationCommand: task.validationCommand,
    expectedFiles: task.expectedFiles ?? [],
    requiredFact: task.requiredFact ?? null,
  };
}

function publicMcpToolUseTaskMetadata(task: any) {
  return {
    id: task.id,
    title: task.title ?? null,
    task_description: task.task_description ?? null,
    fuzzy_description: task.fuzzy_description ?? null,
    dependency_analysis: task.dependency_analysis ?? null,
    expectedEvidence: task.expectedEvidence ?? null,
    validator: task.validator ?? null,
  };
}

const codingSuite: PiEvalSuite = {
  id: "coding",
  label: "Coding agent workspace",
  defaultTasks: ["checkout-incident-retry-hardening"],
  fixtureRoot: codingFixtureRoot,
  tasksPath: resolve(codingFixtureRoot, "tasks.json"),
  workspaceRoot: resolve(codingFixtureRoot, "coding-agent-workspace"),
  workspaceRequired: true,
  fixtureServerSourcePath: resolve(codingFixtureRoot, "mcp-server.ts"),
  fixtureServers: ["issues", "ci", "docs", "api", "code-map"],
  directToolsEnv: "issues,ci,docs,api,code-map",
  buildPrompt: buildPiEvalPrompt,
  scoreRun: scoreTaskRun,
  publicTaskMetadata: publicCodingTaskMetadata,
};

const mcpToolUseSuite: PiEvalSuite = {
  id: "mcp-tool-use",
  label: "MCP tool-use workflows",
  defaultTasks: [
    "api-pagination-audit",
    "incident-customer-impact-join",
    "release-readiness-risk-report",
  ],
  fixtureRoot: mcpToolUseFixtureRoot,
  tasksPath: resolve(mcpToolUseFixtureRoot, "tasks.json"),
  workspaceRoot: null,
  workspaceRequired: false,
  fixtureServerSourcePath: resolve(mcpToolUseFixtureRoot, "mcp-server.ts"),
  fixtureServers: ["api_catalog", "incidents", "customers", "deployments", "quality", "policies"],
  directToolsEnv: "api_catalog,incidents,customers,deployments,quality,policies",
  buildPrompt: buildMcpToolUsePrompt,
  scoreRun: scoreMcpToolUseRun,
  publicTaskMetadata: publicMcpToolUseTaskMetadata,
};

function buildMcpToolUsePrompt(task: any, mode: string): string {
  const modeHint = buildPiEvalPrompt({ prompt: "" }, mode)
    .split("\n")
    .filter((line) => line && !line.includes("Complete the task in this workspace"))
    .filter((line) => !line.includes("After editing"))
    .join("\n");
  return [
    "You are running a benchmark. Complete the backend tool-use task using the configured MCP tools.",
    "Do not inspect or edit repository files.",
    "Use tool evidence for every material fact. Do not guess.",
    "Return a concise final answer containing one JSON object with keys: taskId, decision, facts, summary.",
    "Each facts entry must include key, value, and evidence.",
    modeHint,
    "",
    `Task ID: ${task.id}`,
    task.task_description ?? task.prompt,
    task.fuzzy_description ? `Context: ${task.fuzzy_description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: Add `--task-suite` option and default tasks**

In `packages/benchmarks/run-pi-eval.ts`, import the suite helpers:

```ts
import {
  DEFAULT_PI_EVAL_SUITE_ID,
  resolvePiEvalSuite,
  validatePiEvalSuiteId,
} from "./lib/pi-eval/suites";
```

Update `parsePiEvalArgs` to add:

```ts
.option("--task-suite <suite>", "task suite to run", DEFAULT_PI_EVAL_SUITE_ID)
```

Update `validatePiEvalOptions` to resolve the suite before tasks:

```ts
const taskSuite = options.taskSuite ?? DEFAULT_PI_EVAL_SUITE_ID;
validatePiEvalSuiteId(taskSuite);
const suite = resolvePiEvalSuite(taskSuite);
```

Return these fields from `validatePiEvalOptions`:

```ts
taskSuite,
tasks: options.tasks?.length ? options.tasks : suite.defaultTasks,
```

- [ ] **Step 5: Run the focused test and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "parses Pi eval task suites"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/lib/pi-eval/suites.ts packages/benchmarks/run-pi-eval.ts packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: add Pi eval suite selection"
```

## Task 2: Parameterize Fixture Config By Suite

**Files:**

- Modify: `packages/benchmarks/lib/config.ts`
- Modify: `packages/benchmarks/lib/pi-eval/config.ts`
- Modify: `packages/benchmarks/lib/pi-eval/executor.ts`
- Modify: `packages/benchmarks/run-pi-eval.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing tests for suite fixture routing**

Add this test near the existing Pi eval config tests:

```ts
it("creates Pi eval configs from suite-specific fixture servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-suite-config-test-"));
  const fixtureServerSourcePath = join(root, "suite-server.ts");
  const sourceAgentDir = join(root, "source-agent");
  try {
    await mkdir(sourceAgentDir, { recursive: true });
    await writeFile(fixtureServerSourcePath, "console.log('suite server')\n");
    await writeFile(join(sourceAgentDir, "auth.json"), '{"token":"secret"}\n');

    const capletsConfig = await createPiEvalRunConfig({
      rootDir: join(root, "caplets"),
      mode: "caplets-progressive",
      piAgentSourceDir: sourceAgentDir,
      fixtureServerSourcePath,
      fixtureServers: ["api_catalog", "incidents"],
      directToolsEnv: "api_catalog,incidents",
    });
    expect(Object.keys(capletsConfig.config.mcpServers).sort()).toEqual([
      "api_catalog",
      "incidents",
    ]);
    expect(await readFile(capletsConfig.fixtureServerPath, "utf8")).toContain("suite server");

    const vanillaConfig = await createPiEvalRunConfig({
      rootDir: join(root, "vanilla"),
      mode: "vanilla-mcp",
      piAgentSourceDir: sourceAgentDir,
      fixtureServerSourcePath,
      fixtureServers: ["api_catalog", "incidents"],
      directToolsEnv: "api_catalog,incidents",
    });
    expect(Object.keys(vanillaConfig.adapterConfig.mcpServers).sort()).toEqual([
      "api_catalog",
      "incidents",
    ]);
    expect(vanillaConfig.env.MCP_DIRECT_TOOLS).toBe("api_catalog,incidents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Add this test for Executor payloads:

```ts
it("creates Executor fixture source payloads for suite-specific servers", () => {
  expect(
    createExecutorFixtureSourcePayloads({
      fixtureServerPath: "/tmp/server.ts",
      supportDir: "/tmp/support",
      servers: ["api_catalog", "incidents"],
    }).map((payload) => payload.name),
  ).toEqual(["api_catalog", "incidents"]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "suite-specific fixture"
```

Expected: config test fails because `fixtureServerSourcePath`, `fixtureServers`, and `directToolsEnv` are not honored.

- [ ] **Step 3: Allow arbitrary benchmark fixture server definitions**

In `packages/benchmarks/lib/config.ts`, add:

```ts
export function createNamedFixtureMcpServers({
  fixtureServerPath,
  cwd,
  servers,
  command = "tsx",
  extra = {},
}: any = {}) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new TypeError("createNamedFixtureMcpServers requires at least one server.");
  }
  const serverPath = resolve(fixtureServerPath);
  const serverCwd = resolve(cwd);
  return Object.fromEntries(
    servers.map((server: string) => [
      server,
      {
        name: server.replaceAll("_", " "),
        description: `Deterministic ${server.replaceAll("_", " ")} fixture server.`,
        ...extra,
        command,
        args: [serverPath, "--server", server],
        cwd: serverCwd,
      },
    ]),
  );
}
```

Update `createBenchmarkFixtureMcpServers` to call `createNamedFixtureMcpServers` after selecting existing server IDs:

```ts
export function createBenchmarkFixtureMcpServers({
  repoRoot = REPO_ROOT,
  fixtureServerPath,
  cwd,
  extra = {},
  servers,
  command = "tsx",
  ...inlineExtra
}: any = {}) {
  const paths = getBenchmarkPaths({ repoRoot });
  const selectedServers = servers ?? DEFAULT_BENCHMARK_SERVERS;
  const definitions = benchmarkServerDefinitions();
  const unknown = selectedServers.filter((server: string) => !definitions[server]);
  if (unknown.length > 0) {
    return createNamedFixtureMcpServers({
      fixtureServerPath: fixtureServerPath ?? paths.fixtureServerPath,
      cwd: cwd ?? paths.repoRoot,
      servers: selectedServers,
      command,
      extra: { ...inlineExtra, ...extra },
    });
  }
  return Object.fromEntries(
    Object.entries(definitions)
      .filter(([server]) => selectedServers.includes(server))
      .map(([server, definition]) => [
        server,
        {
          ...definition,
          ...inlineExtra,
          ...extra,
          command,
          args: [resolve(fixtureServerPath ?? paths.fixtureServerPath), "--server", server],
          cwd: resolve(cwd ?? paths.repoRoot),
        },
      ]),
  );
}
```

- [ ] **Step 4: Parameterize Pi eval run config**

In `packages/benchmarks/lib/pi-eval/config.ts`, thread these input fields through `createPiEvalRunConfig`, `createCapletsPiEvalRunConfig`, and `createVanillaMcpPiEvalRunConfig`:

```ts
fixtureServerSourcePath,
fixtureServers = [...PI_EVAL_FIXTURE_SERVERS],
directToolsEnv = VANILLA_MCP_DIRECT_TOOLS_ENV,
```

Use `fixtureServerSourcePath ?? paths.fixtureServerPath` in the `copyFile` calls.

Use `fixtureServers` in `createBenchmarkFixtureMcpServers`.

Use `directToolsEnv` for vanilla MCP:

```ts
env: {
  CAPLETS_PI_EVAL_METRICS: metricsPath,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: sessionsDir,
  XDG_CONFIG_HOME: xdgConfigHome,
  MCP_DIRECT_TOOLS: directToolsEnv,
  PATH: envPath,
},
```

- [ ] **Step 5: Pass suite fixture config from the runner**

In `packages/benchmarks/run-pi-eval.ts`, resolve the suite in `runPiEvalBenchmark` and pass these fields into `runConfigFactory`:

```ts
runConfig = await runConfigFactory({
  mode: entry.mode,
  requireBuild: true,
  executorCommand: evalOptions.executorCommand,
  fixtureServerSourcePath: suite.fixtureServerSourcePath,
  fixtureServers: suite.fixtureServers,
  directToolsEnv: suite.directToolsEnv,
});
```

When calling `setupExecutorFixtureSources`, pass:

```ts
servers: suite.fixtureServers,
```

- [ ] **Step 6: Run focused tests and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "suite-specific fixture|Executor fixture source payloads"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/lib/config.ts packages/benchmarks/lib/pi-eval/config.ts packages/benchmarks/lib/pi-eval/executor.ts packages/benchmarks/run-pi-eval.ts packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: route Pi eval fixtures by suite"
```

## Task 3: Add MCP Tool-Use Fixture Server And Tasks

**Files:**

- Create: `packages/benchmarks/fixtures/mcp-tool-use/tasks.json`
- Create: `packages/benchmarks/fixtures/mcp-tool-use/mcp-server.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing tests for task loading and server metadata**

Add this test:

```ts
it("loads MCP tool-use suite tasks with expected dependency metadata", async () => {
  const suite = resolvePiEvalSuite("mcp-tool-use");
  const tasks = await loadTasks(suite.tasksPath);
  expect(tasks.map((task: any) => task.id)).toEqual([
    "api-pagination-audit",
    "incident-customer-impact-join",
    "release-readiness-risk-report",
  ]);
  expect(tasks[0]).toMatchObject({
    dependency_analysis: { servers: ["api_catalog"] },
    expectedEvidence: { servers: ["api_catalog"] },
  });
  expect(tasks[1].dependency_analysis.servers).toEqual(["incidents", "customers"]);
  expect(tasks[2].dependency_analysis.servers).toEqual(["deployments", "quality", "policies"]);
});
```

Add a fixture smoke test:

```ts
it("exposes MCP tool-use fixture server metadata", async () => {
  const suite = resolvePiEvalSuite("mcp-tool-use");
  const config = createNamedFixtureMcpServers({
    fixtureServerPath: suite.fixtureServerSourcePath,
    cwd: suite.fixtureRoot,
    servers: suite.fixtureServers,
  });
  expect(Object.keys(config).sort()).toEqual([
    "api_catalog",
    "customers",
    "deployments",
    "incidents",
    "policies",
    "quality",
  ]);
  expect(config.api_catalog.args).toEqual([
    suite.fixtureServerSourcePath,
    "--server",
    "api_catalog",
  ]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "MCP tool-use suite tasks|MCP tool-use fixture server"
```

Expected: fails because the fixture files do not exist.

- [ ] **Step 3: Create `tasks.json`**

Create `packages/benchmarks/fixtures/mcp-tool-use/tasks.json` with exact task IDs and expected answers:

```json
[
  {
    "id": "api-pagination-audit",
    "title": "API pagination audit",
    "prompt": "Audit the API catalog for pagination behavior across product, customer, and audit APIs. Return only the requested JSON final answer.",
    "task_description": "Compare search/list endpoints across three product APIs and identify which operations are paginated, how pagination works, and the required parameter names.",
    "fuzzy_description": "The agent must inspect operation details, distinguish paginated endpoints from lookalikes, and ignore a fallback list endpoint that is not paginated.",
    "dependency_analysis": {
      "servers": ["api_catalog"],
      "requires": ["search catalog", "inspect operation details", "compare pagination parameters"]
    },
    "expectedEvidence": {
      "servers": ["api_catalog"],
      "tools": [
        "api_catalog.search_apis",
        "api_catalog.list_operations",
        "api_catalog.get_operation"
      ]
    },
    "expectedFacts": {
      "paginatedOperations": ["products.search", "customers.list", "audit.events"],
      "paginationStyles": {
        "products.search": "cursor",
        "customers.list": "offset",
        "audit.events": "time_window"
      },
      "requiredParameters": {
        "products.search": ["query", "page_size", "cursor"],
        "customers.list": ["limit", "offset"],
        "audit.events": ["start_time", "end_time", "next_token"]
      },
      "notPaginated": ["products.list_legacy"]
    },
    "distractorFacts": ["products.list_legacy is paginated", "orders.export is required"],
    "validator": "api-pagination-audit"
  },
  {
    "id": "incident-customer-impact-join",
    "title": "Incident customer impact join",
    "prompt": "Find the active incident and join affected account IDs to customer records. Return only the requested JSON final answer.",
    "task_description": "Find the active incident, fetch affected account IDs, join customer details, and return the customer impact summary.",
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
    "expectedFacts": {
      "activeIncidentId": "INC-2026-0610-2",
      "affectedAccountCount": 4,
      "tierBreakdown": { "enterprise": 2, "growth": 1, "startup": 1 },
      "regionBreakdown": { "na": 2, "eu": 1, "apac": 1 },
      "escalationTargets": ["atlas-oncall", "beacon-csm", "crane-support"]
    },
    "distractorFacts": ["INC-2026-0610-1", "acme-retail"],
    "validator": "incident-customer-impact-join"
  },
  {
    "id": "release-readiness-risk-report",
    "title": "Release readiness risk report",
    "prompt": "Decide whether the release can proceed by combining deployment, quality, and policy evidence. Return only the requested JSON final answer.",
    "task_description": "Decide whether a release can proceed from deploy status, failing checks, policy exceptions, and risk thresholds.",
    "fuzzy_description": "The agent must inspect the current release, failing quality checks, policy thresholds, and exception scope before deciding go or no-go.",
    "dependency_analysis": {
      "servers": ["deployments", "quality", "policies"],
      "requires": [
        "find current release",
        "inspect quality checks",
        "apply policy thresholds",
        "validate exceptions"
      ]
    },
    "expectedEvidence": {
      "servers": ["deployments", "quality", "policies"],
      "tools": [
        "deployments.get_release",
        "quality.list_checks",
        "policies.get_release_policy",
        "policies.list_exceptions"
      ]
    },
    "expectedFacts": {
      "releaseId": "REL-2026-06-10-payments",
      "decision": "no-go",
      "blockers": ["contract-tests", "rollback-plan"],
      "validExceptions": ["EXC-442"],
      "invalidExceptions": ["EXC-410", "EXC-499"]
    },
    "distractorFacts": ["go", "REL-2026-06-10-search", "EXC-410 is valid"],
    "validator": "release-readiness-risk-report"
  }
]
```

- [ ] **Step 4: Create the MCP fixture server**

Create `packages/benchmarks/fixtures/mcp-tool-use/mcp-server.ts` by reusing the server pattern from `packages/benchmarks/fixtures/mcp-server.ts`:

```ts
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAMES = [
  "api_catalog",
  "incidents",
  "customers",
  "deployments",
  "quality",
  "policies",
];

const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const querySchema = {
  type: "object",
  properties: { query: { type: "string" } },
  additionalProperties: false,
};
const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};
const idsSchema = {
  type: "object",
  properties: { ids: { type: "array", items: { type: "string" } } },
  required: ["ids"],
  additionalProperties: false,
};

const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true };

const asResult = (summary: string, data: unknown) => ({
  content: [{ type: "text", text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});
```

Add records and tools for each server using these exact values from `tasks.json`: `INC-2026-0610-2`, `REL-2026-06-10-payments`, `EXC-442`, `EXC-410`, and `EXC-499`.

Export:

```ts
export function listToolMetadata(serverName: string) {
  return toolsForServer(serverName).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: readOnlyAnnotations,
    server: serverName,
  }));
}
```

Keep the stdio MCP bootstrap consistent with the existing fixture server: parse `--server`, validate against `SERVER_NAMES`, register tools, call handlers, and return `structuredContent`.

- [ ] **Step 5: Run tests and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "MCP tool-use suite tasks|MCP tool-use fixture server"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/fixtures/mcp-tool-use packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: add MCP tool-use Pi eval fixtures"
```

## Task 4: Add MCP Tool-Use Scoring

**Files:**

- Create: `packages/benchmarks/lib/pi-eval/mcp-tool-use-score.ts`
- Modify: `packages/benchmarks/lib/pi-eval/metrics.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing tests for final JSON extraction and scoring**

Add imports:

```ts
import { extractMcpToolUseFinalJson, scoreMcpToolUseRun } from "../lib/pi-eval/mcp-tool-use-score";
```

Add tests:

````ts
it("extracts MCP tool-use final JSON from assistant text", () => {
  const parsed = extractMcpToolUseFinalJson([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: 'Done\n```json\n{"taskId":"x","decision":"ok","facts":[],"summary":"ok"}\n```',
          },
        ],
      },
    },
  ]);
  expect(parsed).toEqual({ taskId: "x", decision: "ok", facts: [], summary: "ok" });
});

it("scores MCP tool-use runs from expected facts and tool evidence", async () => {
  const task = {
    id: "incident-customer-impact-join",
    expectedEvidence: {
      servers: ["incidents", "customers"],
      tools: ["incidents.get_incident", "customers.get_accounts"],
    },
    expectedFacts: {
      activeIncidentId: "INC-2026-0610-2",
      affectedAccountCount: 4,
      tierBreakdown: { enterprise: 2, growth: 1, startup: 1 },
    },
    distractorFacts: ["INC-2026-0610-1"],
  };
  const agentResult = emptyProcessResult({
    command: "pi-test",
    args: [],
    stdout: JSON.stringify({
      taskId: "incident-customer-impact-join",
      decision: "summary",
      facts: [
        { key: "activeIncidentId", value: "INC-2026-0610-2", evidence: ["incidents.get_incident"] },
        { key: "affectedAccountCount", value: 4, evidence: ["customers.get_accounts"] },
        {
          key: "tierBreakdown",
          value: { enterprise: 2, growth: 1, startup: 1 },
          evidence: ["customers.get_accounts"],
        },
      ],
      summary: "Four accounts affected.",
    }),
    jsonEvents: [
      { type: "tool_execution_start", toolName: "incidents.get_incident" },
      { type: "tool_execution_start", toolName: "customers.get_accounts" },
    ],
  });
  await expect(scoreMcpToolUseRun({ task, agentResult })).resolves.toMatchObject({
    success: true,
    processSuccess: true,
    validation: { success: true },
  });
});

it("fails MCP tool-use scoring when distractor facts appear", async () => {
  const task = {
    id: "incident-customer-impact-join",
    expectedEvidence: { tools: ["incidents.get_incident"] },
    expectedFacts: { activeIncidentId: "INC-2026-0610-2" },
    distractorFacts: ["INC-2026-0610-1"],
  };
  const agentResult = emptyProcessResult({
    command: "pi-test",
    args: [],
    stdout:
      '{"taskId":"incident-customer-impact-join","decision":"summary","facts":[{"key":"activeIncidentId","value":"INC-2026-0610-1","evidence":["incidents.get_incident"]}],"summary":"wrong incident"}',
    jsonEvents: [{ type: "tool_execution_start", toolName: "incidents.get_incident" }],
  });
  const score = await scoreMcpToolUseRun({ task, agentResult });
  expect(score.success).toBe(false);
  expect(score.validation.stdout).toContain("distractor fact appeared: INC-2026-0610-1");
});
````

- [ ] **Step 2: Run tests and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "MCP tool-use"
```

Expected: fails because scoring module does not exist.

- [ ] **Step 3: Implement MCP tool-use scoring**

Create `packages/benchmarks/lib/pi-eval/mcp-tool-use-score.ts`:

````ts
import { toolNameFromEvent } from "./metrics";

export function extractMcpToolUseFinalJson(events: any[] = [], stdout = "") {
  const candidates = [stdout, ...assistantTexts(events)].filter(Boolean);
  for (const candidate of candidates.reverse()) {
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export async function scoreMcpToolUseRun({ task, agentResult }: any = {}) {
  if (!task) throw new TypeError("scoreMcpToolUseRun requires a task.");
  const processFailureReason = agentProcessFailureReason(agentResult);
  const processSuccess = !processFailureReason;
  const parsed = extractMcpToolUseFinalJson(
    agentResult?.jsonEvents ?? [],
    agentResult?.stdout ?? "",
  );
  const validation = validateMcpToolUseAnswer({
    task,
    parsed,
    events: agentResult?.jsonEvents ?? [],
  });
  return {
    taskId: task.id,
    success: processSuccess && validation.success,
    finalStateValid: validation.success,
    processSuccess,
    processFailureReason,
    validation,
    hiddenValidation: { success: true, skipped: true, command: undefined },
    process: agentResult
      ? {
          exitCode: agentResult.exitCode,
          signal: agentResult.signal,
          timedOut: agentResult.timedOut,
          durationMs: agentResult.durationMs,
          command: agentResult.command,
          args: agentResult.args,
          envKeys: agentResult.envKeys,
          skipped: agentResult.skipped,
          unavailable: agentResult.unavailable,
          configConflict: agentResult.configConflict,
        }
      : undefined,
    parsedFinalAnswer: parsed,
  };
}

function validateMcpToolUseAnswer({ task, parsed, events }: any) {
  const failures: string[] = [];
  if (!parsed || typeof parsed !== "object") {
    failures.push("final JSON object was not found");
  } else {
    if (parsed.taskId !== task.id) failures.push(`taskId mismatch: ${String(parsed.taskId)}`);
    const answerText = JSON.stringify(parsed);
    for (const [key, expected] of Object.entries(task.expectedFacts ?? {})) {
      if (!answerContainsExpectedFact(parsed, key, expected)) {
        failures.push(`missing expected fact: ${key}`);
      }
    }
    for (const distractor of task.distractorFacts ?? []) {
      if (answerText.includes(String(distractor))) {
        failures.push(`distractor fact appeared: ${distractor}`);
      }
    }
  }

  const observedTools = new Set(events.map(toolNameFromEvent).filter(Boolean));
  for (const expectedTool of task.expectedEvidence?.tools ?? []) {
    if (!observedTools.has(expectedTool) && !toolEvidenceText(parsed).includes(expectedTool)) {
      failures.push(`missing expected tool evidence: ${expectedTool}`);
    }
  }

  return {
    success: failures.length === 0,
    command: "mcp-tool-use-final-answer-validator",
    args: [task.id],
    exitCode: failures.length === 0 ? 0 : 1,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: failures.join("\n"),
    stderr: "",
    stdoutBytes: Buffer.byteLength(failures.join("\n"), "utf8"),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function answerContainsExpectedFact(parsed: any, key: string, expected: unknown) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts.some((fact: any) => fact?.key === key && deepEqual(fact.value, expected));
}

function toolEvidenceText(parsed: any) {
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return JSON.stringify(facts.flatMap((fact: any) => fact?.evidence ?? []));
}

function assistantTexts(events: any[]) {
  return events.flatMap((event) => {
    const message = event?.message;
    if (message?.role !== "assistant") return [];
    const content = message.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.map((part: any) => part?.text ?? "").filter(Boolean);
  });
}

function parseJsonObject(text: string) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u)?.[1];
  for (const candidate of [fenced, trimmed, trimmed.match(/\{[\s\S]*\}/u)?.[0]].filter(Boolean)) {
    try {
      const parsed = JSON.parse(candidate as string);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function deepEqual(a: unknown, b: unknown) {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function agentProcessFailureReason(agentResult: any) {
  if (!agentResult) return "agent result missing";
  if (agentResult.timedOut) return "agent timed out";
  if (agentResult.signal) return `agent exited with signal ${agentResult.signal}`;
  if (agentResult.exitCode != null && agentResult.exitCode !== 0) {
    return `agent exited with code ${agentResult.exitCode}`;
  }
  return undefined;
}
````

- [ ] **Step 4: Run tests and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "MCP tool-use"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/lib/pi-eval/mcp-tool-use-score.ts packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: score MCP tool-use Pi eval answers"
```

## Task 5: Integrate Suites Into The Runner

**Files:**

- Modify: `packages/benchmarks/run-pi-eval.ts`
- Modify: `packages/benchmarks/lib/pi-eval/metrics.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing runner integration tests**

Add a no-workspace suite run test:

```ts
it("runs MCP tool-use suite jobs without copying a coding workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-pi-eval-mcp-suite-run-test-"));
  const outputDir = join(root, "reports");
  const runRoots: string[] = [];
  try {
    const result = await runPiEvalBenchmark({
      options: {
        outputDir,
        taskSuite: "mcp-tool-use",
        modes: ["caplets-code-mode"],
        tasks: ["incident-customer-impact-join"],
        runs: 1,
        timeoutMs: 10_000,
      },
      env: { CAPLETS_BENCH_LIVE: "1" },
      piDetector: async () => ({ available: true, command: "pi-test", version: "pi-test 1" }),
      runConfigFactory: async ({ mode, fixtureServers }: any) => {
        const runRoot = await mkdtemp(join(root, "run-"));
        runRoots.push(runRoot);
        expect(fixtureServers).toEqual([
          "api_catalog",
          "incidents",
          "customers",
          "deployments",
          "quality",
          "policies",
        ]);
        return {
          runRoot,
          mode,
          product: "caplets",
          adapterExposure: null,
          configPath: null,
          adapterConfigPath: null,
          xdgConfigHome: null,
          xdgCapletsConfigPath: null,
          supportDir: runRoot,
          fixtureServerPath: null,
          metricsPath: join(runRoot, "metrics.jsonl"),
          prewarmMetricsPath: null,
          sessionsDir: join(runRoot, "sessions"),
          prewarmSessionsDir: null,
          agentDir: join(runRoot, "agent"),
          copiedPiAuthFiles: [],
          extensionPaths: [],
          extraArgs: [],
          env: { PI_CODING_AGENT_DIR: join(runRoot, "agent") },
        };
      },
      processRunner: async (call: any) =>
        emptyProcessResult({
          command: call.command,
          args: call.args,
          stdout: JSON.stringify({
            taskId: "incident-customer-impact-join",
            decision: "summary",
            facts: [
              {
                key: "activeIncidentId",
                value: "INC-2026-0610-2",
                evidence: ["incidents.get_incident"],
              },
              { key: "affectedAccountCount", value: 4, evidence: ["customers.get_accounts"] },
              {
                key: "tierBreakdown",
                value: { enterprise: 2, growth: 1, startup: 1 },
                evidence: ["customers.get_accounts"],
              },
              {
                key: "regionBreakdown",
                value: { na: 2, eu: 1, apac: 1 },
                evidence: ["customers.get_accounts"],
              },
              {
                key: "escalationTargets",
                value: ["atlas-oncall", "beacon-csm", "crane-support"],
                evidence: ["customers.get_accounts"],
              },
            ],
            summary: "Four accounts affected.",
          }),
          jsonEvents: [
            { type: "tool_execution_start", toolName: "incidents.search_incidents" },
            { type: "tool_execution_start", toolName: "incidents.get_incident" },
            { type: "tool_execution_start", toolName: "customers.get_accounts" },
          ],
        }),
    });

    expect(result.report.suite).toMatchObject({
      id: "mcp-tool-use",
      label: "MCP tool-use workflows",
    });
    expect(result.report.results[0].score.success).toBe(true);
    expect(result.report.results[0].candidateWorkspace).toBeNull();
    expect(await readFile(result.markdownPath, "utf8")).toContain("Suite: MCP tool-use workflows");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "runs MCP tool-use suite"
```

Expected: fails because runner still always copies a workspace and uses coding scorer.

- [ ] **Step 3: Integrate suite in `runPiEvalBenchmark`**

In `packages/benchmarks/run-pi-eval.ts`:

- Resolve `const suite = resolvePiEvalSuite(evalOptions.taskSuite);`.
- Default `fixtureRoot`, `fixtureWorkspaceRoot`, and `tasksPath` from `suite` when caller does not inject values.
- Use `suite.buildPrompt(task, entry.mode)` instead of `buildPiEvalPrompt(task, entry.mode)`.
- Create an empty temp workspace for suites without a workspace root:

```ts
async function createPiEvalWorkspace(suite: any, fixtureWorkspaceRoot?: string | null) {
  if (suite.workspaceRequired) {
    return await createTempWorkspaceFromFixture(fixtureWorkspaceRoot);
  }
  return await mkdtemp(join(tmpdir(), "caplets-pi-eval-workspace-"));
}
```

- Score with:

```ts
const score = await suite.scoreRun({
  task,
  candidateWorkspace,
  fixtureRoot,
  agentResult,
});
```

- Add suite metadata to report:

```ts
suite: {
  id: suite.id,
  label: suite.label,
  workspaceRequired: suite.workspaceRequired,
  fixtureServers: suite.fixtureServers,
},
```

- Use `suite.publicTaskMetadata` for `report.tasks`.

- [ ] **Step 4: Keep evidence scoring compatible**

In `packages/benchmarks/lib/pi-eval/metrics.ts`, keep `requiredEvidenceScore` returning the current coding coverage for `checkout-incident-retry-hardening`.

For `mcp-tool-use`, return required tool evidence from metrics:

```ts
if (task?.expectedEvidence?.tools?.length) {
  const observedTools = new Set(metrics?.toolNames ?? []);
  const missingTools = task.expectedEvidence.tools.filter(
    (tool: string) => !observedTools.has(tool),
  );
  return {
    required: true,
    success: missingTools.length === 0,
    missingDomains: missingTools,
    coverage: {
      tools: Object.fromEntries(
        task.expectedEvidence.tools.map((tool: string) => [tool, observedTools.has(tool)]),
      ),
    },
  };
}
```

- [ ] **Step 5: Run focused tests and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "runs MCP tool-use suite|scores required checkout evidence"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/run-pi-eval.ts packages/benchmarks/lib/pi-eval/metrics.ts packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: run Pi eval suites through shared harness"
```

## Task 6: Report Suite-Level Token And Validator Results

**Files:**

- Modify: `packages/benchmarks/lib/pi-eval/report.ts`
- Test: `packages/benchmarks/test/benchmark.test.ts`

- [ ] **Step 1: Write failing report tests**

Extend the existing report test with suite metadata and provider-token comparison text:

```ts
const markdown = renderPiEvalMarkdownReport({
  suite: { id: "mcp-tool-use", label: "MCP tool-use workflows" },
  completedAt: "2026-06-09T00:00:00.000Z",
  options: { model: "test-model", runs: 1, timeoutMs: 1000, concurrency: 2 },
  summary,
  results: [result, executorResult],
});

expect(markdown).toContain("Suite: MCP tool-use workflows");
expect(markdown).toContain("Avg provider tokens");
expect(markdown).toContain("Validator Summary");
```

- [ ] **Step 2: Run test and verify failure**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "summarizes Pi eval reports"
```

Expected: fails on suite and validator summary text.

- [ ] **Step 3: Update report rendering**

In `renderPiEvalMarkdownReport`, add after model:

```ts
`Suite: ${report.suite?.label ?? "Coding agent workspace"}`,
```

Change comparison rows to include total provider tokens:

```ts
`- ${comparison.label}: duration ${formatPercent(comparison.durationReduction)}, LLM round trips ${formatPercent(comparison.providerRequestReduction)}, estimated request tokens ${formatPercent(comparison.requestTokenReduction)}, provider tokens ${formatPercent(comparison.providerTokenReduction)}`,
```

In `compareRows`, add:

```ts
providerTokenReduction: reduction(b.averageProviderTokens, a.averageProviderTokens),
```

Add validator summaries:

```ts
const validatorRows = report.results.map(
  (result: any) =>
    `| ${result.mode} | ${result.taskId} | ${result.run} | ${result.score?.validation?.success ? "pass" : "fail"} | ${
      String(result.score?.validation?.stdout ?? "")
        .replace(/\s+/gu, " ")
        .slice(0, 160) || "n/a"
    } |`,
);
```

Render:

```ts
"## Validator Summary",
"",
"| Mode | Task | Run | Validator | Notes |",
"| --- | --- | ---: | --- | --- |",
...validatorRows,
"",
```

- [ ] **Step 4: Run report tests and commit**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts -t "summarizes Pi eval reports"
```

Expected: pass.

Commit:

```bash
git add packages/benchmarks/lib/pi-eval/report.ts packages/benchmarks/test/benchmark.test.ts
git commit -m "feat: report Pi eval suite validator results"
```

## Task 7: Run Full Benchmark Package Tests And Build

**Files:**

- Validate current implementation files only.

- [ ] **Step 1: Run benchmark package tests**

Run from `core/`:

```bash
pnpm --filter @caplets/benchmarks test
```

Expected: all benchmark package tests pass.

- [ ] **Step 2: Run Core build**

Run from `caplets-mono` root:

```bash
pnpm --dir ./core run build
```

Expected: build passes and writes fresh `dist` artifacts consumed by live Pi eval.

- [ ] **Step 3: Commit any test/build fixes**

If the previous steps required fixes, commit them:

```bash
git add packages/benchmarks
git commit -m "test: cover MCP tool-use Pi eval suite"
```

If there were no fixes after the last feature commit, do not create an empty commit.

## Task 8: Run Live Smoke And Full Eval

**Files:**

- Local output only under `packages/benchmark-results/live/pi-eval/`.

- [ ] **Step 1: Run a small live smoke**

Run from `caplets-mono` root:

```bash
pnpm --dir ./core run build &&
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval -- \
  --task-suite mcp-tool-use \
  --mode caplets-code-mode,vanilla-mcp \
  --tasks incident-customer-impact-join \
  --model openai-codex/gpt-5.5 \
  --runs 1 \
  --concurrency 2
```

Expected:

- one report JSON and one markdown report are written
- both modes complete without timeout
- both runs pass validator scoring
- no `--preserve-artifacts` disk growth

- [ ] **Step 2: Inspect the report for total-token comparison**

Open the generated markdown path printed by the command and check:

- `Suite: MCP tool-use workflows`
- `Avg provider tokens` is present
- validator summary has no failures
- total provider tokens are visible for both modes

- [ ] **Step 3: Run the full live eval**

Run from `caplets-mono` root:

```bash
pnpm --dir ./core run build &&
CAPLETS_BENCH_LIVE=1 pnpm --dir ./core run benchmark:live:pi-eval -- \
  --task-suite mcp-tool-use \
  --model openai-codex/gpt-5.5 \
  --runs 4 \
  --concurrency 8
```

Expected:

- all selected modes run across all three MCP tool-use tasks
- no preserved temp roots are left by routine execution
- `caplets-progressive`, `caplets-code-mode`, and `caplets-progressive-code-mode` have successful runs
- comparisons use total provider tokens, not request tokens alone

- [ ] **Step 4: Summarize results**

Record in the final implementation handoff:

- report JSON path
- report markdown path
- pass counts by mode
- average provider tokens by mode
- whether Caplets progressive/code-mode variants beat `vanilla-mcp` and `executor-mcp`
- any environment failures separated from product failures

## Self-Review Checklist

- The plan keeps `coding` as the default suite and does not change current benchmark behavior unless `--task-suite mcp-tool-use` is passed.
- The plan uses local deterministic MCP fixtures and does not depend on MCP-Bench runtime services, external API keys, or judge models.
- The plan validates final answer facts, evidence, and distractor rejection for the new suite.
- The plan keeps total provider tokens as the primary efficiency signal and adds provider-token comparison output.
- The plan runs `pnpm --dir ./core run build` before live eval measurement.
- The plan avoids `--preserve-artifacts` for routine live eval iteration.
- The plan commits after each independently testable implementation stage.
