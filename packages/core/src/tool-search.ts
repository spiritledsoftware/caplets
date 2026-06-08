import type { Tool } from "@modelcontextprotocol/sdk/types";

export function searchToolList<T>(
  tools: Tool[],
  query: string,
  limit: number,
  compact: (tool: Tool) => T,
): T[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const preferReadFirst = !hasMutatingIntent(tokens);

  return tools
    .filter((tool) => {
      const haystack = `${tool.name}\n${tool.description ?? ""}`.toLocaleLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })
    .sort((left, right) => {
      const safety = safetyRank(left, preferReadFirst) - safetyRank(right, preferReadFirst);
      return safety === 0 ? left.name.localeCompare(right.name) : safety;
    })
    .slice(0, limit)
    .map(compact);
}

const MUTATING_QUERY_TOKENS = new Set([
  "add",
  "create",
  "delete",
  "destroy",
  "edit",
  "insert",
  "mutate",
  "mutation",
  "patch",
  "post",
  "publish",
  "put",
  "remove",
  "set",
  "update",
  "write",
]);

function hasMutatingIntent(tokens: string[]): boolean {
  return tokens.some((token) => MUTATING_QUERY_TOKENS.has(token));
}

function safetyRank(tool: Tool, preferReadFirst: boolean): number {
  if (!preferReadFirst) return 0;
  if (tool.annotations?.readOnlyHint === true) return 0;
  if (tool.annotations?.destructiveHint === true) return 2;
  return 1;
}
