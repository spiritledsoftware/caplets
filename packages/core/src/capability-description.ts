import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  const flow =
    "Use tools/search_tools for downstream names, arg hints, and callTemplate. Prefer direct call_tool from callTemplate/argsTemplate for simple calls; reserve describe_tool for complex schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly; do not guess tool names or schemas. For triage, list recent/open items once before targeted searches.";
  return [
    `${server.name} Caplet.`,
    server.description,
    server.backend === "mcp"
      ? `${flow} Resources/prompts/completions may exist for MCP backends.`
      : flow,
  ]
    .filter(Boolean)
    .join(" ");
}
