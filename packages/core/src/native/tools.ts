import type { CapletConfig } from "../config";
import { capabilityDescription } from "../registry";

export const nativeCodeModeToolId = "code_mode";
export const nativeCodeModeToolName = "caplets_code_mode";

export function nativeCapletToolName(capletId: string): string {
  return `caplets_${capletId.replace(/_/g, "__").replace(/-/g, "_")}`;
}

export function nativeCapletsSystemGuidance(toolNames: string[]): string {
  const tools = toolNames.length > 0 ? toolNames.map((tool) => `- ${tool}`).join("\n") : "- none";
  return [
    "## Caplets Native Tools",
    "",
    "Caplets tools expose configured capability domains through progressive discovery.",
    "",
    "Available Caplets native tools:",
    tools,
    "",
    `${nativeCodeModeToolName} executes Caplets Code Mode: TypeScript with generated caplets.<id> handles for multi-step discovery, tool calls, filtering, and compact synthesis in one native call.`,
    "Flow: inspect when the domain is unfamiliar; use tools/search_tools for downstream names; use describe_tool before call_tool when args matter; pass call_tool.args with exact inputSchema property names.",
    "Do not guess downstream tool names, resource URIs, prompt names, input args, output fields, or schemas. Do not infer input/output schemas from memory.",
    "Prefer list/read/search operations for triage and avoid broad provider searches that can return huge payloads or hit rate limits.",
    "When output shaping matters, inspect one tool with describe_tool and follow its fieldSelection hint.",
  ].join("\n");
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  const descriptorFirst =
    "Use describe_tool before call_tool when args matter; call_tool.args must match inputSchema exactly. Do not guess tool names or schemas.";
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
    "Use tools/search_tools to find downstream names. Use describe_tool before call_tool when args matter; call_tool.args must match inputSchema exactly. Do not guess tool names or schemas. Prefer read/search/list tools for triage.",
    "",
    `Native tool name: ${toolName}`,
    `Original Caplet ID: ${caplet.server}`,
  ].join("\n");
}
