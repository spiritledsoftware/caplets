export declare const operations: readonly [
  "get_caplet",
  "check_backend",
  "check_mcp_server",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
];

export declare const generatedToolInputDescriptions: {
  operation: string;
  query: string;
  limit: string;
  tool: string;
  arguments: string;
  fields: string;
};

export declare function generatedToolInputJsonSchema(): Record<string, unknown>;
