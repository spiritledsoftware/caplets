import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture-stdio", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a message.",
    inputSchema: z.object({ message: z.string() }).strict(),
    outputSchema: z.object({ message: z.string() }).strict(),
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo:${message}` }],
    structuredContent: { message },
  }),
);

server.registerTool(
  "duplicate",
  {
    description: "Duplicate name fixture.",
    inputSchema: z.object({}).strict(),
  },
  async () => ({ content: [{ type: "text", text: "duplicate-a" }] }),
);

server.registerResource(
  "README",
  "file:///repo/README.md",
  { description: "Project README", mimeType: "text/markdown" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "# Fixture README", mimeType: "text/markdown" }],
  }),
);

server.registerResource(
  "Repository file",
  new ResourceTemplate("file:///repo/{path}", {
    list: async () => ({
      resources: [
        { uri: "file:///repo/src/index.ts", name: "src/index.ts", mimeType: "text/typescript" },
      ],
    }),
    complete: {
      path: (value) => ["README.md", "src/index.ts"].filter((path) => path.startsWith(value)),
    },
  }),
  { description: "Read a repository file", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: `content:${uri.href}`, mimeType: "text/plain" }],
  }),
);

server.registerPrompt(
  "review_issue",
  {
    description: "Review an issue before implementation.",
    argsSchema: { issueId: z.string().describe("Issue ID") },
  },
  ({ issueId }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review ${issueId}` } }],
  }),
);

await server.connect(new StdioServerTransport());
