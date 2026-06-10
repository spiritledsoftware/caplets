import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreTaskRun } from "../scoring";
import { buildPiEvalPrompt } from "./config";

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
  scoreRun: async (input: any) => {
    const { scoreMcpToolUseRun } = await import("./mcp-tool-use-score");
    return await scoreMcpToolUseRun(input);
  },
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
