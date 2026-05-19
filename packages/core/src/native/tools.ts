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
    "Caplets tools are native wrappers around configured Caplet backends. Each tool is named `caplets_<id>` and represents one capability domain.",
    "",
    "Available Caplets native tools:",
    tools,
    "",
    "Recommended flow:",
    "1. Use `get_caplet` when choosing a Caplet for an unfamiliar task or when its capability is unclear.",
    "2. Call `check_backend` only when availability is uncertain.",
    "3. Use `search_tools` or `list_tools` to discover the selected Caplet's downstream operations and exact tool names.",
    "4. Schema hashes from `list_tools` can identify matching schemas across Caplets when you already understand that exact hash.",
    "5. Use `get_tool` before `call_tool` when a downstream tool is unfamiliar or its argument or output schema is unclear.",
    "6. For `call_tool`, put downstream inputs only inside the top-level `arguments` object.",
    "7. Do not invent downstream tool names; execute only exact names returned by `list_tools`, `search_tools`, or `get_tool`.",
  ].join("\n");
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  return [
    `Use ${toolName} for the ${caplet.name} Caplet capability domain.`,
    "For unfamiliar tasks, discover safely with get_caplet, then search_tools or list_tools, then get_tool when schemas are unclear.",
    "Use schema hashes from list_tools as reuse hints only when you already understand the exact hash.",
    "Call check_backend only when backend availability is uncertain.",
    "Call call_tool only with exact downstream tool names and keep downstream inputs inside arguments.",
  ];
}

export function nativeCapletToolDescription(toolName: string, caplet: CapletConfig): string {
  return [
    capabilityDescription(caplet),
    "",
    `Native tool name: ${toolName}`,
    `Original Caplet ID: ${caplet.server}`,
  ].join("\n");
}
