import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreTaskRun } from "../scoring";
import { buildPiEvalPrompt } from "./config";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultFixtureRoot = resolve(packageRoot, "fixtures");
const codingFixtureRoot = defaultFixtureRoot;
const mcpToolUseFixtureRoot = resolve(defaultFixtureRoot, "mcp-tool-use");
const mcpRealisticNoAuthFixtureRoot = resolve(defaultFixtureRoot, "mcp-realistic-noauth");
const mcpRealWorldLargeFixtureRoot = resolve(defaultFixtureRoot, "mcp-real-world-large");
const mcpRealWorldLargeWorkspaceRoot = resolve(
  defaultFixtureRoot,
  "mcp-real-world-large-workspace",
);

export const PI_EVAL_SUITE_IDS = [
  "coding",
  "mcp-tool-use",
  "mcp-realistic-noauth",
  "mcp-real-world-large",
] as const;
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
  realMcpServers?: string[];
  requiredEnv?: string[];
  disablePiBuiltinTools?: boolean;
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
  if (value === "mcp-realistic-noauth") return mcpRealisticNoAuthSuite;
  if (value === "mcp-real-world-large") return mcpRealWorldLargeSuite;
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
  scoreRun: async (input: any) => {
    const { scoreMcpToolUseRun } = await import("./mcp-tool-use-score");
    return await scoreMcpToolUseRun(input);
  },
  publicTaskMetadata: publicMcpToolUseTaskMetadata,
};

const realisticNoAuthServers = [
  "repo",
  "filesystem",
  "sqlite",
  "docs",
  "browser",
  "memory",
  "time",
  "slack",
  "jira",
  "github",
  "observability",
  "deployments",
  "feature_flags",
  "customers",
  "incidents",
];

const realWorldLargeServers = [
  "github",
  "context7",
  "deepwiki",
  "git",
  "filesystem",
  "playwright",
  "ast_grep",
  "language_server",
  "duckduckgo",
];

const mcpRealisticNoAuthSuite: PiEvalSuite = {
  id: "mcp-realistic-noauth",
  label: "Realistic no-auth MCP workflows",
  defaultTasks: [
    "production-incident-briefing",
    "release-risk-triage",
    "enterprise-renewal-readiness",
    "oncall-handoff-synthesis",
  ],
  fixtureRoot: mcpRealisticNoAuthFixtureRoot,
  tasksPath: resolve(mcpRealisticNoAuthFixtureRoot, "tasks.json"),
  workspaceRoot: null,
  workspaceRequired: false,
  fixtureServerSourcePath: resolve(mcpRealisticNoAuthFixtureRoot, "mcp-server.ts"),
  fixtureServers: realisticNoAuthServers,
  directToolsEnv: realisticNoAuthServers.join(","),
  buildPrompt: buildMcpToolUsePrompt,
  scoreRun: async (input: any) => {
    const { scoreMcpToolUseRun } = await import("./mcp-tool-use-score");
    return await scoreMcpToolUseRun(input);
  },
  publicTaskMetadata: publicMcpToolUseTaskMetadata,
};

const mcpRealWorldLargeSuite: PiEvalSuite = {
  id: "mcp-real-world-large",
  label: "Real-world large MCP stack workflows",
  defaultTasks: [
    "real-release-risk-brief",
    "dependency-docs-migration-check",
    "code-navigation-impact-brief",
    "browser-runbook-verification",
    "public-repo-architecture-scout",
  ],
  fixtureRoot: mcpRealWorldLargeFixtureRoot,
  tasksPath: resolve(mcpRealWorldLargeFixtureRoot, "tasks.json"),
  workspaceRoot: mcpRealWorldLargeWorkspaceRoot,
  workspaceRequired: true,
  fixtureServerSourcePath: "",
  fixtureServers: [],
  realMcpServers: realWorldLargeServers,
  requiredEnv: ["GH_TOKEN", "CONTEXT7_API_KEY"],
  disablePiBuiltinTools: true,
  directToolsEnv: realWorldLargeServers.join(","),
  buildPrompt: buildMcpToolUsePrompt,
  scoreRun: async (input: any) => {
    const { scoreMcpToolUseRun } = await import("./mcp-tool-use-score");
    return await scoreMcpToolUseRun(input);
  },
  publicTaskMetadata: publicMcpToolUseTaskMetadata,
};

function buildMcpToolUsePrompt(task: any, mode: string): string {
  return [
    "You are running a benchmark. Complete the backend tool-use task using the configured MCP tools.",
    "Do not inspect benchmark harness files. Do not edit task files.",
    "Use tool evidence for every material fact. Do not guess.",
    "Return a concise final answer containing one JSON object with keys: taskId, decision, facts, summary.",
    "Each facts entry must include key, value, and evidence.",
    mcpToolUseModeHint(mode),
    "",
    `Task ID: ${task.id}`,
    task.task_description ?? task.prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function mcpToolUseModeHint(mode: string) {
  const hints: Record<string, string> = {
    "caplets-direct": "Direct Caplets tools are exposed as caplets__<server>__<tool>.",
    "caplets-progressive":
      "Caplets capability tools expose inspect/list/search/describe/call operations; use tools/search_tools callTemplate and arg hints for simple direct calls, and reserve describe_tool for complex or uncertain schemas.",
    "caplets-code-mode":
      "Use caplets_code_mode for compact Caplets discovery and retrieval; return only the facts needed for the final JSON.",
    "caplets-direct-code-mode":
      "Direct Caplets tools and caplets_code_mode are available; choose the shortest reliable path.",
    "caplets-progressive-code-mode":
      "Both Caplets capability tools and caplets_code_mode are available; choose the shortest reliable path.",
    "vanilla-mcp":
      "The MCP servers are exposed as plain direct MCP tools, without Caplets or Executor.",
    "executor-mcp": "Executor is available through direct Pi tools registered by the MCP adapter.",
  };
  return hints[mode] ?? "";
}
