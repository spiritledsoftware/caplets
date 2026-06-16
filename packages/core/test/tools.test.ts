import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { DownstreamManager } from "../src/downstream";
import { CapletsError } from "../src/errors";
import type { GraphQLManager, GraphqlEndpointConfig } from "../src/graphql";
import type { HttpActionManager } from "../src/http-actions";
import type { OpenApiManager } from "../src/openapi";
import type {
  ObservedOutputShape,
  ObservedOutputShapeKey,
  ObservedOutputShapeStore,
} from "../src/observed-output-shapes";
import { ServerRegistry } from "../src/registry";
import {
  generatedToolInputSchema,
  handleServerTool,
  jsonResult,
  projectCallToolResult,
  validateOperationRequest,
} from "../src/tools";

describe("generated tool request validation", () => {
  it("rejects operation-specific extra fields", () => {
    expect(() => validateOperationRequest({ operation: "tools", tool: "x" }, 50)).toThrow(
      CapletsError,
    );
    expect(() =>
      validateOperationRequest({ operation: "describe_tool", query: "x", tool: "x" }, 50),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest({ operation: "call_tool", name: "x", args: [] }, 50),
    ).toThrow(CapletsError);
  });

  it("validates search limit and required exact tool fields", () => {
    expect(validateOperationRequest({ operation: "search_tools", query: "read" }, 50)).toEqual({
      operation: "search_tools",
      query: "read",
    });
    expect(
      validateOperationRequest({ operation: "search_tools", query: "read", limit: 51 }, 50),
    ).toEqual({ operation: "search_tools", query: "read", limit: 51 });
    expect(() => validateOperationRequest({ operation: "call_tool", args: {} }, 50)).toThrow(
      CapletsError,
    );
  });

  it("accepts tools pagination input without hard limit failures", () => {
    expect(validateOperationRequest({ operation: "tools", limit: 2 }, 50)).toEqual({
      operation: "tools",
      limit: 2,
    });
    expect(validateOperationRequest({ operation: "tools", limit: 51, cursor: "10" }, 50)).toEqual({
      operation: "tools",
      limit: 51,
      cursor: "10",
    });
  });

  it("accepts top-level field selection only for call_tool", () => {
    expect(
      validateOperationRequest(
        { operation: "call_tool", name: "read", args: {}, fields: ["body.name"] },
        50,
      ),
    ).toEqual({
      operation: "call_tool",
      name: "read",
      args: {},
      fields: ["body.name"],
    });
    expect(() =>
      validateOperationRequest(
        { operation: "describe_tool", name: "read", fields: ["body.name"] },
        50,
      ),
    ).toThrow(CapletsError);
  });

  it("rejects invalid top-level field selections", () => {
    expect(() =>
      validateOperationRequest({ operation: "call_tool", name: "read", args: {}, fields: [] }, 50),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest(
        { operation: "call_tool", name: "read", args: {}, fields: [""] },
        50,
      ),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest({ operation: "call_tool", name: "read", args: {}, fields: [1] }, 50),
    ).toThrow(CapletsError);
  });

  it("treats arguments.fields as downstream input", () => {
    expect(
      validateOperationRequest({ operation: "call_tool", name: "read", args: { fields: [] } }, 50),
    ).toEqual({
      operation: "call_tool",
      name: "read",
      args: { fields: [] },
    });
  });

  it("returns UNKNOWN_OPERATION for unknown operations", () => {
    expect(() => validateOperationRequest({ operation: "explode" }, 50)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_OPERATION" }),
    );
    expect(() => validateOperationRequest({ operation: "get_server" }, 50)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_OPERATION" }),
    );
    expect(() => validateOperationRequest({ operation: "check_server" }, 50)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_OPERATION" }),
    );
    expect(() => validateOperationRequest({ operation: "check_mcp_server" }, 50)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_OPERATION" }),
    );
  });

  it("exposes the Caplet-first operation enum", () => {
    const schema = z.toJSONSchema(generatedToolInputSchema, { io: "input" }) as {
      properties: Record<string, { enum?: string[] }>;
    };

    expect(schema.properties.operation?.enum).toEqual([
      "inspect",
      "check",
      "tools",
      "search_tools",
      "describe_tool",
      "call_tool",
    ]);
  });

  it("returns Markdown wrapper content while preserving structured result", () => {
    const result = jsonResult({ id: "alpha", items: [{ name: "read" }, { name: "write" }] });

    expect(result.structuredContent).toEqual({
      result: { id: "alpha", items: [{ name: "read" }, { name: "write" }] },
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("# Result");
    expect(text).toContain("## Full Result");
    expect(text).toContain('"name": "read"');
    expect(text).toContain('"name": "write"');
  });

  it("describes the nested call_tool argument shape to agents", () => {
    const schema = z.toJSONSchema(generatedToolInputSchema, { io: "input" }) as {
      properties: Record<string, { description?: string }>;
    };

    const operationDescription = schema.properties.operation?.description;
    const toolDescription = schema.properties.name?.description;
    const argumentsDescription = schema.properties.args?.description;
    const fieldsDescription = schema.properties.fields?.description;

    expect(operationDescription).toContain("call_tool");
    expect(toolDescription).toContain("Exact downstream tool or prompt name");
    expect(argumentsDescription).toContain("call_tool");
    expect(argumentsDescription).toContain("get_prompt");
    expect(fieldsDescription).toBe(
      "Optional call_tool structured output paths. Use only after describe_tool returns fieldSelection.supported true.",
    );
  });
});

describe("generated tool handlers", () => {
  type HintTool = Tool & { useWhen?: string; avoidWhen?: string };

  const graphqlFieldsUnsupportedMessage =
    "call_tool.fields is not supported for GraphQL-backed Caplets; select fields in the GraphQL operation document instead";
  const config = parseConfig({
    mcpServers: {
      alpha: {
        name: "Alpha",
        description: "Search alpha project documents.",
        command: "node",
      },
      beta: {
        name: "Beta",
        description: "Search beta project documents.",
        command: "node",
      },
    },
  });
  const registry = new ServerRegistry(config);
  const server = config.mcpServers.alpha!;
  const tools: HintTool[] = [
    {
      name: "read",
      description: "Read files",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
      useWhen: "Use for reading file contents.",
      avoidWhen: "Avoid for writes.",
    },
    {
      name: "write",
      description: "Write files",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true },
      useWhen: "Use for updating file contents.",
    },
  ];

  class MemoryObservedOutputShapeStore implements ObservedOutputShapeStore {
    readonly entries = new Map<string, ObservedOutputShape>();

    async read(key: ObservedOutputShapeKey): Promise<ObservedOutputShape | undefined> {
      return this.entries.get(JSON.stringify(key));
    }

    async write(key: ObservedOutputShapeKey, shape: ObservedOutputShape): Promise<void> {
      this.entries.set(JSON.stringify(key), shape);
    }
  }

  it("returns inspect without starting downstream", async () => {
    const downstream = { checkServer: vi.fn(), listTools: vi.fn() } as unknown as DownstreamManager;
    const result = (await handleServerTool(
      server,
      { operation: "inspect" },
      registry,
      downstream,
    )) as any;
    expect(result.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "inspect",
      status: "ok",
      elapsedMs: expect.any(Number),
    });
    expect(result.structuredContent?.result).toEqual({
      id: "alpha",
      name: "Alpha",
      description: "Search alpha project documents.",
      backend: {
        type: "mcp",
        transport: "stdio",
        disabled: false,
        startupTimeoutMs: 10000,
        callTimeoutMs: 60000,
        toolCacheTtlMs: 30000,
      },
    });
    expect(downstream.listTools).not.toHaveBeenCalled();
  });

  it("returns OpenAPI inspect without requiring an OpenAPI manager", async () => {
    const openApiConfig = parseConfig({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/openapi.json",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
        },
      },
    });
    const openApiRegistry = new ServerRegistry(openApiConfig);
    const downstream = {} as unknown as DownstreamManager;

    const result = (await handleServerTool(
      openApiConfig.openapiEndpoints.users!,
      { operation: "inspect" },
      openApiRegistry,
      downstream,
    )) as any;

    expect(result.structuredContent?.result).toMatchObject({
      id: "users",
      backend: {
        type: "openapi",
        source: "specPath",
      },
    });
  });

  it("fails explicitly for Google Discovery tools until the manager is configured", async () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files and permissions.",
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          auth: { type: "none" },
        },
      },
    });
    const googleRegistry = new ServerRegistry(config);
    const downstream = {} as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        config.googleDiscoveryApis.drive!,
        { operation: "tools" },
        googleRegistry,
        downstream,
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Google Discovery manager is not configured",
    });
  });

  it("returns HTTP inspect without requiring an HTTP manager", async () => {
    const httpConfig = parseConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Check internal service status through HTTP.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    });
    const httpRegistry = new ServerRegistry(httpConfig);
    const downstream = {} as unknown as DownstreamManager;

    const result = (await handleServerTool(
      httpConfig.httpApis.status!,
      { operation: "inspect" },
      httpRegistry,
      downstream,
    )) as any;

    expect(result.structuredContent?.result).toMatchObject({
      id: "status",
      backend: {
        type: "http",
        configuredActions: 1,
      },
    });
  });

  it("checks the MCP server backend", async () => {
    const status = { id: "alpha", status: "available", toolCount: 2, elapsedMs: 5 };
    const downstream = {
      checkServer: vi.fn().mockResolvedValue(status),
      listTools: vi.fn(),
      callTool: vi.fn(),
    } as unknown as DownstreamManager;
    const result = (await handleServerTool(
      server,
      { operation: "check" },
      registry,
      downstream,
    )) as any;

    expect(result.structuredContent?.result).toEqual(status);
    expect(downstream.checkServer).toHaveBeenCalledWith(server);
    expect(downstream.listTools).not.toHaveBeenCalled();
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("uses Caplet names in discovery text to disambiguate identical downstream tools", async () => {
    const browserConfig = parseConfig({
      mcpServers: {
        browser: { name: "Browser", description: "Browser automation", command: "node" },
        stealth: { name: "Stealth Browser", description: "Stealth automation", command: "node" },
      },
    });
    const browserRegistry = new ServerRegistry(browserConfig);
    const downstream = {
      listTools: vi.fn().mockResolvedValue([{ name: "browser_click", inputSchema: {} }]),
      compact: (_capletServer: typeof server, tool: Tool) => ({ name: tool.name }),
    } as unknown as DownstreamManager;

    const browser = (await handleServerTool(
      browserConfig.mcpServers.browser!,
      { operation: "tools" },
      browserRegistry,
      downstream,
    )) as any;
    const stealth = (await handleServerTool(
      browserConfig.mcpServers.stealth!,
      { operation: "tools" },
      browserRegistry,
      downstream,
    )) as any;

    expect(browser.content[0]?.text).toContain("browser_click");
    expect(stealth.content[0]?.text).toContain("browser_click");
    expect(browser.content[0]?.text).toContain("Browser");
    expect(stealth.content[0]?.text).toContain("Stealth Browser");
    expect(browser.structuredContent?.result.items).toEqual([{ name: "browser_click" }]);
    expect(stealth.structuredContent?.result.items).toEqual([{ name: "browser_click" }]);
  });

  it("hoists repeated discovery description suffixes once", async () => {
    const commonDescription =
      "No API key is required. The records follow the same compact operational data model used across this workspace.";
    const compactTools = [
      { name: "search", description: `Search records by query. ${commonDescription}` },
      { name: "list", description: `List recent records. ${commonDescription}` },
      { name: "get", description: `Get one record by id. ${commonDescription}` },
    ];
    const downstream = {
      listTools: vi.fn().mockResolvedValue(compactTools),
      compact: (_capletServer: typeof server, tool: Tool) => tool,
    } as unknown as DownstreamManager;

    const list = (await handleServerTool(
      server,
      { operation: "tools" },
      registry,
      downstream,
    )) as any;
    const text = list.content[0]?.text ?? "";

    expect(text).toContain("1. `search` — Search records by query.");
    expect(text).toContain("2. `list` — List recent records.");
    expect(text).toContain("3. `get` — Get one record by id.");
    expect(text).toContain(`Common description: ${commonDescription}`);
    expect(text.match(/No API key is required/gu)).toHaveLength(1);
  });

  it("lists compact metadata and preserves full describe_tool metadata", async () => {
    expect(new DownstreamManager(registry).compact(server, tools[0]!)).toMatchObject({
      name: "read",
      hasOutputSchema: true,
      supportsFields: true,
      readOnlyHint: true,
      destructiveHint: false,
      useWhen: "Use for reading file contents.",
      avoidWhen: "Avoid for writes.",
    });

    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (_capletServer: typeof server, tool: HintTool) => ({
        name: tool.name,
        description: tool.description,
        hasInputSchema: Boolean(tool.inputSchema),
        hasOutputSchema: Boolean(tool.outputSchema),
        supportsFields: Boolean(tool.outputSchema),
        ...(tool.name === "read" ? { argsTemplate: { path: "" } } : {}),
        ...(tool.useWhen ? { useWhen: tool.useWhen } : {}),
        ...(tool.avoidWhen ? { avoidWhen: tool.avoidWhen } : {}),
        ...(typeof tool.annotations?.readOnlyHint === "boolean"
          ? { readOnlyHint: tool.annotations.readOnlyHint }
          : {}),
        ...(typeof tool.annotations?.destructiveHint === "boolean"
          ? { destructiveHint: tool.annotations.destructiveHint }
          : {}),
      }),
      getTool: vi.fn().mockResolvedValue(tools[1]),
    } as unknown as DownstreamManager;

    const list = (await handleServerTool(
      server,
      { operation: "tools" },
      registry,
      downstream,
    )) as any;
    expect(list.content[0]?.text).toContain("read");
    expect(list.content[0]?.text).toContain("supports fields");
    expect(list.content[0]?.text).toContain('args template: {"path":""}');
    expect(list.content[0]?.text).toContain("read-only");
    expect(list.content[0]?.text).toContain("structuredContent.result");
    expect(list.content[0]?.text).not.toContain("## Full Result");
    expect(list.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "tools",
      status: "ok",
      elapsedMs: expect.any(Number),
    });
    expect(list.structuredContent?.result).toEqual({
      id: "alpha",
      name: "Alpha",
      items: [
        {
          name: "read",
          description: "Read files",
          hasInputSchema: true,
          hasOutputSchema: true,
          supportsFields: true,
          argsTemplate: { path: "" },
          useWhen: "Use for reading file contents.",
          avoidWhen: "Avoid for writes.",
          readOnlyHint: true,
          destructiveHint: false,
        },
        {
          name: "write",
          description: "Write files",
          hasInputSchema: true,
          hasOutputSchema: false,
          supportsFields: false,
          useWhen: "Use for updating file contents.",
          destructiveHint: true,
        },
      ],
    });

    const full = (await handleServerTool(
      server,
      { operation: "describe_tool", name: "write" },
      registry,
      downstream,
    )) as any;
    expect(full.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "describe_tool",
      tool: "write",
      status: "ok",
      elapsedMs: expect.any(Number),
    });
    expect(full.structuredContent?.result).toEqual({
      id: "alpha",
      tool: tools[1],
      fieldSelection: { supported: false, reason: "output_schema_unavailable" },
    });
  });

  it("limits listed tools", async () => {
    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (_capletServer: typeof server, tool: Tool) => ({ name: tool.name }),
    } as unknown as DownstreamManager;

    const list = (await handleServerTool(
      server,
      { operation: "tools", limit: 1 },
      registry,
      downstream,
    )) as any;

    expect(list.structuredContent?.result.items).toEqual([{ name: "read" }]);
  });

  it("searches tools by any query token", async () => {
    const browserTools: Tool[] = [
      {
        name: "browser_navigate",
        description: "Navigate to a URL",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "browser_take_screenshot",
        description: "Take a screenshot",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "browser_click",
        description: "Perform click on a page",
        inputSchema: { type: "object" },
      },
      {
        name: "browser_snapshot",
        description: "Capture accessibility snapshot",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      {
        name: "browser_console_messages",
        description: "Returns console messages",
        inputSchema: { type: "object" },
      },
    ];
    const downstream = new DownstreamManager(registry);

    const results = downstream
      .search(server, browserTools, "navigate screenshot click snapshot type", 10)
      .map((tool) => tool.name);
    expect(results).toHaveLength(4);
    expect(results).toEqual(
      expect.arrayContaining([
        "browser_click",
        "browser_navigate",
        "browser_snapshot",
        "browser_take_screenshot",
      ]),
    );
  });

  it("ranks read-only tool search matches first unless the query asks to mutate", async () => {
    const issueTools: Tool[] = [
      {
        name: "create_issue",
        description: "Create issue",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: false },
      },
      {
        name: "delete_issue",
        description: "Delete issue",
        inputSchema: { type: "object" },
        annotations: { destructiveHint: true },
      },
      {
        name: "search_issues",
        description: "Search issues",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ];
    const downstream = new DownstreamManager(registry);

    expect(downstream.search(server, issueTools, "issue", 10).map((tool) => tool.name)).toEqual([
      "search_issues",
      "create_issue",
      "delete_issue",
    ]);
    expect(
      downstream.search(server, issueTools, "create issue", 10).map((tool) => tool.name),
    ).toEqual(["create_issue", "delete_issue", "search_issues"]);
  });

  it("warms observed output shape cache from schema-less call_tool results", async () => {
    const store = new MemoryObservedOutputShapeStore();
    const downstream = {
      getTool: vi.fn(async (_server, name: string) => tools.find((tool) => tool.name === name)!),
      callTool: vi.fn(async () => ({
        structuredContent: {
          issues: [
            { number: 2, title: "PRD", body: "caplets code-mode" },
            { number: 1, title: "Binding", body: "remote runtime" },
          ],
        },
        content: [{ type: "text", text: "ok" }],
      })),
    } as unknown as DownstreamManager;

    await handleServerTool(
      server,
      { operation: "call_tool", name: "write", args: {} },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { observedOutputShapeStore: store, projectFingerprint: "project-a" },
    );
    const described = (await handleServerTool(
      server,
      { operation: "describe_tool", name: "write" },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { observedOutputShapeStore: store, projectFingerprint: "project-a" },
    )) as any;

    expect(described.structuredContent.result.observedOutputShape).toMatchObject({
      source: "observed",
      sampleCount: 1,
    });
    expect(described.structuredContent.result.observedOutputShape.typeScript).toContain("issues?:");
    expect(JSON.stringify(described.structuredContent.result.observedOutputShape)).not.toContain(
      "caplets code-mode",
    );
  });

  it("omits observed output shape when describe_tool has a useful output schema", async () => {
    const store = new MemoryObservedOutputShapeStore();
    const downstream = {
      getTool: vi.fn(async (_server, name: string) => ({
        ...tools.find((tool) => tool.name === name)!,
        outputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      })),
      callTool: vi.fn(async () => ({
        structuredContent: { message: "ok" },
        content: [{ type: "text", text: "ok" }],
      })),
    } as unknown as DownstreamManager;

    await handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: {} },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { observedOutputShapeStore: store },
    );
    const described = (await handleServerTool(
      server,
      { operation: "describe_tool", name: "read" },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { observedOutputShapeStore: store },
    )) as any;

    expect(described.structuredContent.result.fieldSelection).toEqual({ supported: true });
    expect(described.structuredContent.result.observedOutputShape).toBeUndefined();
  });

  it("does not fail call_tool when observed output shape storage fails", async () => {
    const store: ObservedOutputShapeStore = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        throw new Error("cache unavailable");
      }),
    };
    const downstream = {
      callTool: vi.fn(async () => ({
        structuredContent: { items: [{ id: 1 }] },
        content: [{ type: "text", text: "ok" }],
      })),
    } as unknown as DownstreamManager;

    const result = (await handleServerTool(
      server,
      { operation: "call_tool", name: "write", args: {} },
      registry,
      downstream,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { observedOutputShapeStore: store },
    )) as any;

    expect(result.structuredContent).toEqual({ items: [{ id: 1 }] });
    expect(result._meta.caplets.status).toBe("ok");
  });

  it("returns descriptor-driven guidance for wrong call_tool argument names", async () => {
    const downstream = {
      getTool: vi.fn(async () => ({
        name: "search_issues",
        description: "Search issues",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            perPage: { type: "number" },
          },
          required: ["query"],
        },
      })),
      callTool: vi.fn(),
    } as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        server,
        { operation: "call_tool", name: "search_issues", args: { q: "repo:o/r", per_page: 10 } },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("missing required argument(s): query"),
      details: {
        tool: "search_issues",
        requiredArgs: ["query"],
        acceptedArgs: ["perPage", "query"],
        unexpectedArgs: ["per_page", "q"],
        callSignature:
          'callTool(name: "search_issues", args: SearchIssuesInput): Promise<CapletsResult<SearchIssuesOutput>>',
        inputTypeScript: "type SearchIssuesInput = { perPage?: number; query: string; };",
        retry: expect.stringContaining("describe_tool"),
      },
    });
    expect(vi.mocked(downstream.callTool)).not.toHaveBeenCalled();
  });

  it("returns schema validation repair hints for invalid call_tool argument shapes", async () => {
    const downstream = {
      getTool: vi.fn(async () => ({
        name: "search_issues",
        description: "Search issues",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
            state: { enum: ["open", "closed"] },
            labels: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["query", "labels"],
          additionalProperties: false,
        },
      })),
      callTool: vi.fn(),
    } as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        server,
        {
          operation: "call_tool",
          name: "search_issues",
          args: {
            query: 123,
            limit: "10",
            state: "merged",
            labels: "bug",
          },
        },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining("call_tool args for search_issues are invalid"),
      details: {
        tool: "search_issues",
        requiredArgs: ["labels", "query"],
        acceptedArgs: ["labels", "limit", "query", "state"],
        minimalArgsTemplate: { labels: [], query: "" },
        schemaErrors: expect.arrayContaining([
          { path: "/labels", rule: "type", expected: "array" },
          { path: "/limit", rule: "type", expected: "integer" },
          { path: "/query", rule: "type", expected: "string" },
          { path: "/state", rule: "enum", allowed: ["open", "closed"] },
        ]),
        callSignature:
          'callTool(name: "search_issues", args: SearchIssuesInput): Promise<CapletsResult<SearchIssuesOutput>>',
        inputTypeScript:
          'type SearchIssuesInput = { labels: string[]; limit?: number; query: string; state?: "open" | "closed"; };',
        retry: expect.stringContaining("matching inputSchema/inputTypeScript exactly"),
      },
    });
    expect(vi.mocked(downstream.callTool)).not.toHaveBeenCalled();
  });

  it("annotates call_tool result metadata without changing downstream shape", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    };
    const originalDownstreamResult = structuredClone(downstreamResult);
    const downstream = {
      callTool: vi.fn().mockResolvedValue(downstreamResult),
    } as unknown as DownstreamManager;
    const result = await handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: { path: "x" } },
      registry,
      downstream,
    );
    expect(result).not.toBe(downstreamResult);
    expect(downstreamResult).toEqual(originalDownstreamResult);
    expect(result.content[0]?.text).toContain("ok");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).not.toContain("## Structured Content");
    expect({ ...result, content: originalDownstreamResult.content }).toEqual({
      ...originalDownstreamResult,
      _meta: {
        caplets: {
          id: "alpha",
          name: "Alpha",
          backend: "mcp",
          operation: "call_tool",
          tool: "read",
          status: "ok",
          elapsedMs: expect.any(Number),
        },
      },
    });
  });

  it("preserves downstream _meta values and overwrites downstream caplets metadata", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { ok: true },
      _meta: { requestId: "req-1", nested: { ok: true }, caplets: { downstream: true } },
    };
    const downstream = {
      callTool: vi.fn().mockResolvedValue(downstreamResult),
    } as unknown as DownstreamManager;
    const result = await handleServerTool(
      server,
      { operation: "call_tool", name: "write", args: {} },
      registry,
      downstream,
    );
    expect(result.content[0]?.text).toContain("ok");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).not.toContain("## Structured Content");
    expect({ ...result, content: downstreamResult.content }).toEqual({
      ...downstreamResult,
      _meta: {
        requestId: "req-1",
        nested: { ok: true },
        caplets: {
          id: "alpha",
          name: "Alpha",
          backend: "mcp",
          operation: "call_tool",
          tool: "write",
          status: "ok",
          elapsedMs: expect.any(Number),
        },
      },
    });
  });

  it("annotates downstream error call_tool results without changing content", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "failed" }],
      structuredContent: { error: "nope" },
      isError: true,
      _meta: { requestId: "req-2" },
    };
    const downstream = {
      callTool: vi.fn().mockResolvedValue(downstreamResult),
    } as unknown as DownstreamManager;
    const result = await handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: { path: "x" } },
      registry,
      downstream,
    );
    expect(result.content[0]?.text).toContain("failed");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).not.toContain("## Structured Content");
    expect({ ...result, content: downstreamResult.content }).toEqual({
      ...downstreamResult,
      _meta: {
        requestId: "req-2",
        caplets: {
          id: "alpha",
          name: "Alpha",
          backend: "mcp",
          operation: "call_tool",
          tool: "read",
          status: "error",
          elapsedMs: expect.any(Number),
        },
      },
    });
  });

  it("extracts screenshot artifact links from call_tool text", async () => {
    const result = await callToolWithText("Saved [Screenshot of viewport](./file.png)");

    expect(result._meta.caplets.artifacts).toEqual([
      {
        kind: "screenshot",
        displayPath: "./file.png",
        pathResolution: "relative-to-mcp-server",
      },
    ]);
  });

  it("extracts snapshot artifact links from call_tool text", async () => {
    const result = await callToolWithText("Saved [ARIA snapshot](./snapshot.yaml)");

    expect(result._meta.caplets.artifacts).toEqual([
      {
        kind: "snapshot",
        displayPath: "./snapshot.yaml",
        pathResolution: "relative-to-mcp-server",
      },
    ]);
  });

  it("extracts console-log artifact links from call_tool text", async () => {
    const result = await callToolWithText("Console output: [log](./browser-console.txt)");

    expect(result._meta.caplets.artifacts).toEqual([
      {
        kind: "console-log",
        displayPath: "./browser-console.txt",
        pathResolution: "relative-to-mcp-server",
      },
    ]);
  });

  it("extracts multiple artifact links and absolute local paths", async () => {
    const result = await callToolWithText(
      "Saved [Screenshot](./screen.png), [Network log](/tmp/network.har), and [Download](files/report.pdf)",
    );

    expect(result._meta.caplets.artifacts).toEqual([
      {
        kind: "screenshot",
        displayPath: "./screen.png",
        pathResolution: "relative-to-mcp-server",
      },
      {
        kind: "network-log",
        displayPath: "/tmp/network.har",
        pathResolution: "absolute",
      },
      {
        kind: "file",
        displayPath: "files/report.pdf",
        pathResolution: "relative-to-mcp-server",
      },
    ]);
  });

  it("extracts artifact links with spaces, title attributes, and parentheses", async () => {
    const result = await callToolWithText(
      'Saved artifact [Screenshot](./screenshots/final view.png), file [Trace](./trace.zip "trace"), and artifact [Archive](./run(1).zip)',
    );

    expect(result._meta.caplets.artifacts).toEqual([
      {
        kind: "screenshot",
        displayPath: "./screenshots/final view.png",
        pathResolution: "relative-to-mcp-server",
      },
      {
        kind: "file",
        displayPath: "./trace.zip",
        pathResolution: "relative-to-mcp-server",
      },
      {
        kind: "file",
        displayPath: "./run(1).zip",
        pathResolution: "relative-to-mcp-server",
      },
    ]);
  });

  it("ignores ordinary local documentation links and unsupported schemes", async () => {
    const result = await callToolWithText(
      "Read [README](README.md), see [details](docs/result.md), [data](data:text/plain,hi), and [js](javascript:alert(1))",
    );

    expect(result._meta.caplets).not.toHaveProperty("artifacts");
  });

  it("omits artifacts metadata when call_tool text has no artifact links", async () => {
    const result = await callToolWithText("No files were saved.");

    expect(result._meta.caplets).not.toHaveProperty("artifacts");
  });

  it("ignores external and fragment-only markdown links", async () => {
    const result = await callToolWithText(
      "Ignored [site](https://example.com/a.png), [mail](mailto:a@example.com), [section](#details), [http](http://example.com/a.png)",
    );

    expect(result._meta.caplets).not.toHaveProperty("artifacts");
  });

  async function callToolWithText(text: string): Promise<any> {
    const downstream = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text }],
        structuredContent: { ok: true },
      }),
    } as unknown as DownstreamManager;
    return handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: {} },
      registry,
      downstream,
    );
  }

  it("projects call_tool results from structured content when fields are requested", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "full output" }],
      structuredContent: { message: "ok", extra: "hidden" },
      isError: false,
      _meta: { requestId: "req-1" },
    };
    const downstream = {
      getTool: vi.fn().mockResolvedValue({
        tool: "read",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
            extra: { type: "string" },
          },
        },
      }),
      callTool: vi.fn().mockResolvedValue(downstreamResult),
    } as unknown as DownstreamManager;

    const result = await handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: { path: "x" }, fields: ["message"] },
      registry,
      downstream,
    );

    expect(result.content[0]?.text).toContain("# Alpha call_tool read");
    expect(result.content[0]?.text).toContain("## Result");
    expect(result.content[0]?.text).toContain('"message": "ok"');
    expect(result).toEqual({
      ...downstreamResult,
      content: result.content,
      structuredContent: { message: "ok" },
      _meta: {
        requestId: "req-1",
        caplets: {
          id: "alpha",
          name: "Alpha",
          backend: "mcp",
          operation: "call_tool",
          tool: "read",
          status: "ok",
          elapsedMs: expect.any(Number),
        },
      },
    });
    expect(downstream.getTool).toHaveBeenCalledWith(server, "read");
    expect(downstream.callTool).toHaveBeenCalledWith(server, "read", { path: "x" });
  });

  it("projects OpenAPI call_tool results through the shared wrapper", async () => {
    const openApiConfig = parseConfig({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/openapi.json",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
        },
      },
    });
    const openApiRegistry = new ServerRegistry(openApiConfig);
    const openApiServer = openApiConfig.openapiEndpoints.users!;
    const downstream = { callTool: vi.fn() } as unknown as DownstreamManager;
    const openapi = {
      getTool: vi.fn().mockResolvedValue({
        name: "getUser",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "full output" }],
        structuredContent: { body: { name: "Ada", email: "ada@example.com" } },
        isError: false,
      }),
    } as unknown as OpenApiManager;

    const result = await handleServerTool(
      openApiServer,
      { operation: "call_tool", name: "getUser", args: { id: "42" }, fields: ["body.name"] },
      openApiRegistry,
      downstream,
      openapi,
    );

    expect(result).toMatchObject({
      structuredContent: { body: { name: "Ada" } },
    });
    expect(result.content[0]?.text).toContain("# Users API call_tool getUser");
    expect(result.content[0]?.text).toContain("## Body");
    expect(result.content[0]?.text).toContain('"name": "Ada"');
    expect(openapi.getTool).toHaveBeenCalledWith(openApiServer, "getUser");
    expect(openapi.callTool).toHaveBeenCalledWith(openApiServer, "getUser", { id: "42" });
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("projects HTTP call_tool results through the shared wrapper", async () => {
    const httpConfig = parseConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Check internal service status through HTTP.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    });
    const httpRegistry = new ServerRegistry(httpConfig);
    const httpServer = httpConfig.httpApis.status!;
    const downstream = { callTool: vi.fn() } as unknown as DownstreamManager;
    const http = {
      getTool: vi.fn().mockResolvedValue({
        tool: "check",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            internal: { type: "string" },
          },
        },
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "full output" }],
        structuredContent: { ok: true, internal: "hidden" },
        isError: false,
      }),
    } as unknown as HttpActionManager;

    const result = await handleServerTool(
      httpServer,
      { operation: "call_tool", name: "check", args: { id: "42" }, fields: ["ok"] },
      httpRegistry,
      downstream,
      undefined,
      undefined,
      http,
    );

    expect(result).toMatchObject({
      structuredContent: { ok: true },
    });
    expect(result.content[0]?.text).toContain("# Status HTTP call_tool check");
    expect(result.content[0]?.text).toContain("## Result");
    expect(result.content[0]?.text).toContain('"ok": true');
    expect(http.getTool).toHaveBeenCalledWith(httpServer, "check");
    expect(http.callTool).toHaveBeenCalledWith(httpServer, "check", { id: "42" });
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("projects object values without sharing mutable references to the original result", () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "full output" }],
      structuredContent: { body: { name: "Ada", email: "ada@example.com" } },
      isError: false,
    };

    const result = projectCallToolResult(
      downstreamResult,
      {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
      ["body"],
    );

    (result.structuredContent.body as { name: string }).name = "Grace";

    expect(downstreamResult.structuredContent).toEqual({
      body: { name: "Ada", email: "ada@example.com" },
    });
  });

  it("preserves downstream isError results when fields are requested", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "downstream failed with details" }],
      isError: true,
      _meta: { requestId: "req-err" },
    };
    const downstream = {
      getTool: vi.fn().mockResolvedValue({
        tool: "read",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
      }),
      callTool: vi.fn().mockResolvedValue(downstreamResult),
    } as unknown as DownstreamManager;

    const result = await handleServerTool(
      server,
      { operation: "call_tool", name: "read", args: { path: "x" }, fields: ["message"] },
      registry,
      downstream,
    );

    expect(result).not.toBe(downstreamResult);
    expect(downstreamResult).toEqual({
      content: [{ type: "text", text: "downstream failed with details" }],
      isError: true,
      _meta: { requestId: "req-err" },
    });
    expect(result).toEqual({
      ...downstreamResult,
      _meta: {
        requestId: "req-err",
        caplets: {
          id: "alpha",
          name: "Alpha",
          backend: "mcp",
          operation: "call_tool",
          tool: "read",
          status: "error",
          elapsedMs: expect.any(Number),
        },
      },
    });
  });

  it("reports downstream protocol errors when field selection lacks structured output", async () => {
    const downstream = {
      getTool: vi.fn().mockResolvedValue({
        tool: "read",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { message: { type: "string" } } },
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "message only" }],
      }),
    } as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        server,
        { operation: "call_tool", name: "read", args: { path: "x" }, fields: ["message"] },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" } satisfies Partial<CapletsError>);
  });

  it("rejects fields before calling tools that do not expose an output schema", async () => {
    const downstream = {
      getTool: vi.fn().mockResolvedValue(tools[1]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "secret full output" }],
        structuredContent: { secret: true },
      }),
    } as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        server,
        { operation: "call_tool", name: "write", args: {}, fields: ["secret"] },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" } satisfies Partial<CapletsError>);
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid field paths before calling tools with output schemas", async () => {
    const downstream = {
      getTool: vi.fn().mockResolvedValue({
        tool: "read",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            public: { type: "string" },
          },
        },
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: "side effect already happened" }],
        structuredContent: { public: "ok", secret: "hidden" },
      }),
    } as unknown as DownstreamManager;

    await expect(
      handleServerTool(
        server,
        { operation: "call_tool", name: "read", args: {}, fields: ["secret"] },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" } satisfies Partial<CapletsError>);
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("routes GraphQL-backed Caplets to the GraphQL manager", async () => {
    const graphqlCaplet: GraphqlEndpointConfig = {
      server: "graph",
      backend: "graphql",
      name: "Graph",
      description: "Search graph project records.",
      endpointUrl: "http://127.0.0.1/graphql",
      schemaPath: "/tmp/schema.graphql",
      auth: { type: "none" },
      requestTimeoutMs: 60000,
      operationCacheTtlMs: 30000,
      selectionDepth: 2,
      disabled: false,
    };
    const graphRegistry = {
      config: { options: { maxSearchLimit: 50, defaultSearchLimit: 20 } },
      detail: vi.fn(),
    } as unknown as ServerRegistry;
    const downstream = { callTool: vi.fn() } as unknown as DownstreamManager;
    const graphqlResult = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    };
    const graphql = {
      callTool: vi.fn().mockResolvedValue(graphqlResult),
    } as unknown as GraphQLManager;

    const result = await handleServerTool(
      graphqlCaplet as never,
      { operation: "call_tool", name: "query_user", args: { id: "42" } },
      graphRegistry,
      downstream,
      undefined,
      graphql,
    );

    expect(result).not.toBe(graphqlResult);
    expect(graphqlResult).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    });
    expect(result.content[0]?.text).toContain("# Graph call_tool query_user");
    expect(result.content[0]?.text).toContain("## Result");
    expect(result.content[0]?.text).toContain('"ok": true');
    expect({ ...result, content: graphqlResult.content }).toEqual({
      ...graphqlResult,
      _meta: {
        caplets: {
          id: "graph",
          name: "Graph",
          backend: "graphql",
          operation: "call_tool",
          tool: "query_user",
          status: "ok",
          elapsedMs: expect.any(Number),
        },
      },
    });
    expect(graphql.callTool).toHaveBeenCalledWith(graphqlCaplet, "query_user", { id: "42" });
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("rejects GraphQL field projection", async () => {
    const graphqlCaplet: GraphqlEndpointConfig = {
      server: "graph",
      backend: "graphql",
      name: "Graph",
      description: "Search graph project records.",
      endpointUrl: "http://127.0.0.1/graphql",
      schemaPath: "/tmp/schema.graphql",
      auth: { type: "none" },
      requestTimeoutMs: 60000,
      operationCacheTtlMs: 30000,
      selectionDepth: 2,
      disabled: false,
    };
    const graphRegistry = {
      config: { options: { maxSearchLimit: 50, defaultSearchLimit: 20 } },
      detail: vi.fn(),
    } as unknown as ServerRegistry;
    const downstream = { callTool: vi.fn() } as unknown as DownstreamManager;
    const graphql = { callTool: vi.fn() } as unknown as GraphQLManager;

    await expect(
      handleServerTool(
        graphqlCaplet as never,
        { operation: "call_tool", name: "query_user", args: { id: "42" }, fields: ["user"] },
        graphRegistry,
        downstream,
        undefined,
        graphql,
      ),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: graphqlFieldsUnsupportedMessage,
    } satisfies Partial<CapletsError>);
    expect(graphql.callTool).not.toHaveBeenCalled();
  });

  it("routes HTTP-backed Caplets to the HTTP action manager", async () => {
    const httpCaplet = parseConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Check internal service status through HTTP.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }).httpApis.status!;
    const httpRegistry = {
      config: { options: { maxSearchLimit: 50, defaultSearchLimit: 20 } },
      detail: vi.fn(),
    } as unknown as ServerRegistry;
    const downstream = { callTool: vi.fn() } as unknown as DownstreamManager;
    const httpResult = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    };
    const http = {
      callTool: vi.fn().mockResolvedValue(httpResult),
    } as unknown as HttpActionManager;

    const result = await handleServerTool(
      httpCaplet,
      { operation: "call_tool", name: "check", args: { id: "42" } },
      httpRegistry,
      downstream,
      undefined,
      undefined,
      http,
    );

    expect(result).not.toBe(httpResult);
    expect(httpResult).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    });
    expect(result.content[0]?.text).toContain("# Status HTTP call_tool check");
    expect(result.content[0]?.text).toContain("## Result");
    expect(result.content[0]?.text).toContain('"ok": true');
    expect({ ...result, content: httpResult.content }).toEqual({
      ...httpResult,
      _meta: {
        caplets: {
          id: "status",
          name: "Status HTTP",
          backend: "http",
          operation: "call_tool",
          tool: "check",
          status: "ok",
          elapsedMs: expect.any(Number),
        },
      },
    });
    expect(http.callTool).toHaveBeenCalledWith(httpCaplet, "check", { id: "42" });
    expect(downstream.callTool).not.toHaveBeenCalled();
  });
});
