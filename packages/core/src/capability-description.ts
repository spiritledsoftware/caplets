import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  return [
    `${server.name} Caplet.`,
    server.description,
    server.useWhen ? `Use when: ${server.useWhen}` : undefined,
    server.avoidWhen ? `Avoid when: ${server.avoidWhen}` : undefined,
    server.backend === "mcp"
      ? "Use inspect for details when needed; use tools/search_tools for downstream names and arg hints. Call call_tool directly when requiredArgs/acceptedArgs are sufficient; use describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly; do not guess tool names or schemas. For triage, list recent/open items once before targeted searches. Resources/prompts/completions may exist for MCP backends."
      : "Use inspect for details when needed; use tools/search_tools for downstream names and arg hints. Call call_tool directly when requiredArgs/acceptedArgs are sufficient; use describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly; do not guess tool names or schemas. For triage, list recent/open items once before targeted searches.",
  ]
    .filter(Boolean)
    .join(" ");
}
