import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export function searchToolList<T>(
  tools: Tool[],
  query: string,
  limit: number,
  compact: (tool: Tool) => T,
): T[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

  return tools
    .filter((tool) => {
      const haystack = `${tool.name}\n${tool.description ?? ""}`.toLocaleLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(compact);
}
