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
    '1. Call the relevant `caplets_<id>` tool with `operation: "get_caplet"` to read the full Caplet card.',
    "2. Call `check_backend` only when availability is uncertain.",
    "3. Use `search_tools` or `list_tools` to discover the selected Caplet's downstream operations.",
    "4. Use `get_tool` before `call_tool` when argument or output schema is unclear.",
    "5. For `call_tool`, put downstream inputs only inside the top-level `arguments` object.",
    "6. Do not invent downstream tool names; execute only exact names returned by `list_tools`, `search_tools`, or `get_tool`.",
  ].join("\n");
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  return [
    `Use ${toolName} for the ${caplet.name} Caplet capability domain.`,
    `Call ${toolName} with operation get_caplet before using unfamiliar downstream tools.`,
    `Call ${toolName} with operation check_backend only when backend availability is uncertain.`,
    `Call ${toolName} with operation search_tools or list_tools to discover exact downstream tool names.`,
    `Call ${toolName} with operation call_tool only with exact downstream tool names and put downstream inputs in arguments.`,
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
