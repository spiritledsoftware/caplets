import type { CapletConfig } from "../config";
import { capabilityDescription } from "../registry";

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
    "Flow: get_caplet when the domain is unfamiliar; search_tools or list_tools to find exact downstream names; get_tool only when schemas are unclear; call_tool with downstream inputs inside arguments.",
    "Use fields on call_tool when a non-GraphQL downstream outputSchema allows selecting only needed structured paths.",
  ].join("\n");
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  return [`Use ${toolName} for the ${caplet.name} Caplet capability domain.`];
}

export function nativeCapletToolDescription(toolName: string, caplet: CapletConfig): string {
  return [
    capabilityDescription(caplet),
    "",
    `Native tool name: ${toolName}`,
    `Original Caplet ID: ${caplet.server}`,
  ].join("\n");
}
