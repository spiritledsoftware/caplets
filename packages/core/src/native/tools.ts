import type { CapletConfig } from "../config";
import { capabilityDescription } from "../registry";

export const nativeCodeModeToolId = "code_mode";
export const nativeCodeModeToolName = "caplets__code_mode";

export function nativeCapletToolName(capletId: string): string {
  return `caplets__${capletId}`;
}

export function nativeCapletsSystemGuidance(toolNames: string[]): string {
  const tools = toolNames.length > 0 ? toolNames.map((tool) => `- ${tool}`).join("\n") : "- none";
  const guidance = ["## Caplets Native Tools", "Available:", tools];
  if (toolNames.includes(nativeCodeModeToolName)) {
    guidance.push(
      `${nativeCodeModeToolName}: multi-step TypeScript over caplets.<id>; omit sessionId to start fresh, reuse returned meta.sessionId, and use meta.recoveryRef only for audit.`,
    );
  }
  if (toolNames.some((tool) => tool !== nativeCodeModeToolName)) {
    guidance.push(
      "Flow: inspect when the domain is unfamiliar; tools/search_tools provide names, arg hints, and callTemplate. Use call_tool with callTemplate/argsTemplate; reserve describe_tool for nested or uncertain schemas.",
      "Do not guess downstream tool names, URIs, prompt names, args, fields, or schemas. Do not infer input/output schemas.",
      "Prefer list/read/search for triage; avoid broad provider searches.",
      "For output shaping, describe one tool and follow its fieldSelection hint.",
    );
  }
  return guidance.join("\n");
}

export function nativeCodeModePromptGuidance(): string[] {
  return [
    `Use ${nativeCodeModeToolName} for compact multi-step TypeScript; return decision-ready JSON and keep bulky data inside.`,
    "For REPL reuse, omit sessionId to start fresh; pass the returned meta.sessionId for live state. Top-level declarations and completed mutations persist; unknown IDs fail before execution. meta.recoveryRef via caplets.debug.readRecovery({ recoveryRef }) is audit-only; never auto-replay.",
  ];
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  const descriptorFirst =
    "Use tools/search_tools callTemplate/arg hints for simple calls; reserve describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly. Do not guess tool names or schemas.";
  return caplet.backend === "mcp"
    ? [
        `Use ${toolName} for the ${caplet.name} Caplet capability domain.`,
        "Prefer resources for readable context, prompts for reusable workflows, and tools for actions.",
        descriptorFirst,
      ]
    : [`Use ${toolName} for the ${caplet.name} Caplet capability domain.`, descriptorFirst];
}

export function nativeCapletToolDescription(toolName: string, caplet: CapletConfig): string {
  return [
    capabilityDescription(caplet),
    "Use tools/search_tools to find downstream names, arg hints, and callTemplate. Call call_tool directly from callTemplate/argsTemplate for simple calls; reserve describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly. Do not guess tool names or schemas. Prefer read/search/list tools for triage.",
    "",
    `Native tool name: ${toolName}`,
    `Original Caplet ID: ${caplet.server}`,
  ].join("\n");
}
