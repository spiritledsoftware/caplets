import type { CapletConfig } from "../config";
import { capabilityDescription } from "../registry";

export const nativeCodeModeToolId = "code_mode";
export const nativeCodeModeToolName = "caplets__code_mode";

export function nativeCapletToolName(capletId: string): string {
  return `caplets__${capletId}`;
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
    ...nativeCodeModePromptGuidance(),
    "Flow: inspect when the domain is unfamiliar; use tools/search_tools for downstream names, arg hints, and callTemplate; call_tool directly from callTemplate/argsTemplate for simple calls; reserve describe_tool for complex schemas, nested args, fields, or uncertainty.",
    "Do not guess downstream tool names, resource URIs, prompt names, input args, output fields, or schemas. Do not infer input/output schemas from memory.",
    "Prefer list/read/search operations for triage and avoid broad provider searches that can return huge payloads or hit rate limits.",
    "When output shaping matters, inspect one tool with describe_tool and follow its fieldSelection hint.",
  ].join("\n");
}

export function nativeCodeModePromptGuidance(): string[] {
  return [
    `Use ${nativeCodeModeToolName} to run Caplets Code Mode TypeScript with generated caplets.<id> handles.`,
    "Prefer Code Mode for multi-step Caplet discovery, tool calls, filtering, joins, and compact synthesis.",
    "For REPL reuse, omit sessionId to start fresh, then pass the returned meta.sessionId on later calls that should reuse live state.",
    "Reused sessions preserve successful top-level var bindings, function declarations, and runtime state only while the live session remains available and compatible.",
    "Unknown or unavailable sessionId values fail before code execution; use meta.recoveryRef with caplets.debug.readRecovery({ recoveryRef }) for audit and manual reconstruction, not automatic replay.",
    "Return decision-ready JSON from Code Mode rather than raw bulky provider payloads.",
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
