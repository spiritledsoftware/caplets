export const operations = [
  "get_caplet",
  "check_backend",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
] as const;

export const generatedToolInputDescriptions = {
  operation:
    "Wrapper operation: get_caplet, check_backend, list_tools, search_tools, get_tool, or call_tool.",
  query: "Required for search_tools only.",
  limit: "Optional search_tools result limit.",
  tool: "Exact downstream tool name for get_tool or call_tool.",
  arguments: "Required JSON object for call_tool arguments/downstream inputs.",
  fields: "Optional call_tool structured output paths when outputSchema allows it.",
} as const;

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
  } as const;
}
