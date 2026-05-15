#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

await server.connect(new StdioServerTransport());
