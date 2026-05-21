import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  return [
    `${server.name} Caplet.`,
    server.description,
    server.backend === "mcp"
      ? "Use get_caplet for details when needed; use tools for actions, resources for readable context, prompts for reusable workflows, and complete for prompt/resource-template arguments."
      : "Use get_caplet for details when needed; use search_tools or list_tools to discover downstream operations.",
  ]
    .filter(Boolean)
    .join(" ");
}
