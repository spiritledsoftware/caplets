import type { Tool } from "@modelcontextprotocol/sdk/types";

export function searchToolList<T>(
  tools: Tool[],
  query: string,
  limit: number,
  compact: (tool: Tool) => T,
): T[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const preferReadFirst = !hasMutatingIntent(tokens);
  const matches = tools
    .map((tool) => ({ tool, score: matchScore(tool, tokens) }))
    .filter((candidate) => candidate.score > 0);
  const candidates = matches.length > 0 ? matches : tools.map((tool) => ({ tool, score: 0 }));

  return candidates
    .sort((left, right) => {
      const safety =
        safetyRank(left.tool, preferReadFirst) - safetyRank(right.tool, preferReadFirst);
      if (safety !== 0) return safety;
      const score = right.score - left.score;
      if (score !== 0) return score;
      const utility = operationRank(left.tool.name) - operationRank(right.tool.name);
      return utility === 0 ? left.tool.name.localeCompare(right.tool.name) : utility;
    })
    .slice(0, limit)
    .map((candidate) => compact(candidate.tool));
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

function matchScore(tool: Tool, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const name = tool.name.toLocaleLowerCase();
  const description = tool.description?.toLocaleLowerCase() ?? "";
  return tokens.reduce((score, token) => {
    if (name === token) return score + 4;
    if (name.includes(token)) return score + 3;
    if (description.includes(token)) return score + 1;
    return score;
  }, 0);
}

function safetyRank(tool: Tool, preferReadFirst: boolean): number {
  if (!preferReadFirst) return 0;
  if (tool.annotations?.readOnlyHint === true) return 0;
  if (tool.annotations?.destructiveHint === true) return 2;
  return 1;
}

const COMMON_READ_OPERATION_RANK = new Map(
  [
    "search",
    "list",
    "query",
    "metrics",
    "logs",
    "get",
    "read",
    "summarize",
    "checks",
    "diff",
    "comments",
    "related",
    "inspect",
  ].map((name, index) => [name, index]),
);

function operationRank(name: string): number {
  return COMMON_READ_OPERATION_RANK.get(name.toLocaleLowerCase()) ?? 100;
}
