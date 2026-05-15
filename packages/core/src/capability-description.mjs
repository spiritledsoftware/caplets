export function capabilityDescription(server) {
  const backendName =
    server.backend === "mcp"
      ? "MCP server"
      : server.backend === "openapi"
        ? "OpenAPI endpoint"
        : server.backend === "graphql"
          ? "GraphQL endpoint"
          : server.backend === "http"
            ? "HTTP API"
            : "CLI tools";
  const checkOperation = server.backend === "mcp" ? "check_mcp_server" : "check_backend";
  const hint = [
    `Use this Caplet to inspect and call tools from its ${backendName} backend.`,
    "",
    "Recommended flow:",
    '- Read the full Caplet card: {"operation":"get_caplet"}',
    `- Check the backend: {"operation":"${checkOperation}"}`,
    '- Discover tools: {"operation":"list_tools"} or {"operation":"search_tools","query":"<what you need>"}',
    '- Read one tool schema: {"operation":"get_tool","tool":"<tool name>"}',
    '- Invoke one downstream tool: {"operation":"call_tool","tool":"<tool name>","arguments":{...}}',
    "",
    'Important: Do not put downstream arguments at the top level; put them inside "arguments".',
    'After get_tool shows outputSchema (non-GraphQL), call_tool may use fields: ["path.to.field"].',
  ].join("\n");
  return `${server.name}\n\n${server.description}\n\n${hint}`;
}
