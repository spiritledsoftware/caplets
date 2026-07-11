import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp";
import { completable } from "@modelcontextprotocol/sdk/server/completable";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";

const completionsEnabled = !process.argv.includes("--no-completions");
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
    ...(completionsEnabled
      ? {
          complete: {
            path: (value: string) =>
              ["README.md", "src/index.ts"].filter((path) => path.startsWith(value)),
          },
        }
      : {}),
  }),
  { description: "Read a repository file", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: `content:${uri.href}`, mimeType: "text/plain" }],
  }),
);

server.registerResource(
  "Repository package",
  new ResourceTemplate("repo://{owner}/{name}{?region}", {
    list: undefined,
    ...(completionsEnabled
      ? {
          complete: {
            owner: (value: string) =>
              ["caplets", "other"].filter((owner) => owner.startsWith(value)),
            name: (value: string, context?: { arguments?: Record<string, string> }) =>
              (["caplets", "caplets inc"].includes(context?.arguments?.owner ?? "") &&
              context?.arguments?.region === "eu"
                ? ["core", "cli"]
                : ["unknown"]
              ).filter((name) => name.startsWith(value)),
            region: (value: string) => ["eu", "us"].filter((region) => region.startsWith(value)),
          },
        }
      : {}),
  }),
  { description: "Read a repository package", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: `package:${uri.href}`, mimeType: "text/plain" }],
  }),
);

server.registerResource(
  "Repository query",
  new ResourceTemplate("repo://{tenant}/items{?owner,region}", {
    list: undefined,
    ...(completionsEnabled
      ? {
          complete: {
            tenant: (value: string) =>
              ["acme", "other"].filter((tenant) => tenant.startsWith(value)),
            owner: (value: string) =>
              ["caplets", "other"].filter((owner) => owner.startsWith(value)),
            region: (value: string, context?: { arguments?: Record<string, string> }) =>
              (context?.arguments?.tenant === "acme" ? ["eu", "us"] : ["unknown"]).filter(
                (region) => region.startsWith(value),
              ),
          },
        }
      : {}),
  }),
  { description: "Read repository query results", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: `query:${uri.href}`, mimeType: "text/plain" }],
  }),
);

server.registerPrompt(
  "review_issue",
  {
    description: "Review an issue before implementation.",
    argsSchema: {
      owner: z.string().optional(),
      issueId: completionsEnabled
        ? completable(z.string().describe("Issue ID"), (value, context) =>
            (context?.arguments?.owner === "caplets" ? ["CAP-123"] : ["123", "124"]).filter(
              (issueId) => issueId.startsWith(value),
            ),
          )
        : z.string().describe("Issue ID"),
    },
  },
  ({ issueId }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review ${issueId}` } }],
  }),
);

await server.connect(new StdioServerTransport());
