import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "fixture-stdio-mixed-content", version: "1.0.0" });

server.registerTool(
  "mixed",
  {
    description: "Return ordered mixed content blocks.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ snapshot: z.object({ title: z.string() }) }).strict(),
  },
  async () => ({
    content: [
      { type: "text" as const, text: "Downstream text" },
      { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
      {
        type: "resource_link" as const,
        uri: "file:///tmp/report.pdf",
        name: "Report",
        mimeType: "application/pdf",
      },
    ],
    structuredContent: { snapshot: { title: "Example" } },
    isError: true,
  }),
);

await server.connect(new StdioServerTransport());
