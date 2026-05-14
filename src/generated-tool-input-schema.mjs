export const operations = [
  "get_caplet",
  "check_backend",
  "check_mcp_server",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
];

export const generatedToolInputDescriptions = {
  operation: [
    "Caplets wrapper operation to perform for this configured Caplet backend.",
    "Use get_caplet to read the full Caplet card, check_backend to check any backend, check_mcp_server to check an MCP backend, list_tools or search_tools to discover downstream tools, get_tool to read a downstream input schema, and call_tool to run one downstream tool or OpenAPI operation.",
    'For call_tool, pass downstream inputs only inside the top-level "arguments" object.',
  ].join(" "),
  query:
    'Required only for search_tools. Example: {"operation":"search_tools","query":"web search","limit":5}. Do not use query for call_tool; put downstream query values under arguments.query.',
  limit:
    "Optional only for search_tools; defaults to the configured search limit. For downstream result limits, use call_tool.arguments with the downstream schema field name.",
  tool: 'Exact downstream tool name for get_tool or call_tool. Example: {"operation":"get_tool","tool":"web_search_exa"} before calling it.',
  arguments:
    'Required JSON object only for call_tool. Put every downstream tool input inside this object. Example: {"operation":"call_tool","tool":"web_search_exa","arguments":{"query":"latest MCP docs","numResults":3}}. Do not send downstream inputs as top-level query, limit, url, path, or other fields.',
  fields:
    'Optional for call_tool after get_tool shows outputSchema on a non-GraphQL tool. Example: fields: ["path.to.field"].',
};

export function generatedToolInputJsonSchema() {
  return {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: operations,
        description: generatedToolInputDescriptions.operation,
      },
      query: {
        type: "string",
        description: generatedToolInputDescriptions.query,
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: generatedToolInputDescriptions.limit,
      },
      tool: {
        type: "string",
        description: generatedToolInputDescriptions.tool,
      },
      arguments: {
        type: "object",
        description: generatedToolInputDescriptions.arguments,
      },
      fields: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: generatedToolInputDescriptions.fields,
      },
    },
    required: ["operation"],
    additionalProperties: false,
  };
}
