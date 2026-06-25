import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "fixture-stdio-cwd", version: "1.0.0" });

server.registerTool(
  "cwd",
  {
    description: "Return the server process cwd.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ cwd: z.string() }).strict(),
  },
  async () => ({
    content: [{ type: "text", text: process.cwd() }],
    structuredContent: { cwd: process.cwd() },
  }),
);

await server.connect(new StdioServerTransport());
