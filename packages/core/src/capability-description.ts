import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  return [
    `${server.name} Caplet.`,
    server.description,
    "Use get_caplet for details when needed; use search_tools or list_tools to discover downstream operations.",
  ]
    .filter(Boolean)
    .join(" ");
}
