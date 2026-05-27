import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { DownstreamManager } from "../src/downstream";
import { CapletsError } from "../src/errors";
import type { GraphQLManager, GraphqlEndpointConfig } from "../src/graphql";
import type { HttpActionManager } from "../src/http-actions";
import type { OpenApiManager } from "../src/openapi";
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
    expect(() => validateOperationRequest({ operation: "list_tools", tool: "x" }, 50)).toThrow(
      CapletsError,
    );
    expect(() =>
      validateOperationRequest({ operation: "get_tool", query: "x", tool: "x" }, 50),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest({ operation: "call_tool", tool: "x", arguments: [] }, 50),
    ).toThrow(CapletsError);
  });

  it("validates search limit and required exact tool fields", () => {
    expect(validateOperationRequest({ operation: "search_tools", query: "read" }, 50)).toEqual({
      operation: "search_tools",
      query: "read",
    });
    expect(() =>
      validateOperationRequest({ operation: "search_tools", query: "read", limit: 51 }, 50),
    ).toThrow(CapletsError);
    expect(() => validateOperationRequest({ operation: "call_tool", arguments: {} }, 50)).toThrow(
      CapletsError,
    );
  });

  it("validates list_tools limit", () => {
    expect(validateOperationRequest({ operation: "list_tools", limit: 2 }, 50)).toEqual({
      operation: "list_tools",
      limit: 2,
    });
    expect(() => validateOperationRequest({ operation: "list_tools", limit: 51 }, 50)).toThrow(
      CapletsError,
    );
  });

  it("accepts top-level field selection only for call_tool", () => {
    expect(
      validateOperationRequest(
        { operation: "call_tool", tool: "read", arguments: {}, fields: ["body.name"] },
        50,
      ),
    ).toEqual({
      operation: "call_tool",
      tool: "read",
      arguments: {},
      fields: ["body.name"],
    });
    expect(() =>
      validateOperationRequest({ operation: "get_tool", tool: "read", fields: ["body.name"] }, 50),
    ).toThrow(CapletsError);
  });

  it("rejects invalid top-level field selections", () => {
    expect(() =>
      validateOperationRequest(
        { operation: "call_tool", tool: "read", arguments: {}, fields: [] },
        50,
      ),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest(
        { operation: "call_tool", tool: "read", arguments: {}, fields: [""] },
        50,
      ),
    ).toThrow(CapletsError);
    expect(() =>
      validateOperationRequest(
        { operation: "call_tool", tool: "read", arguments: {}, fields: [1] },
        50,
      ),
    ).toThrow(CapletsError);
  });

  it("treats arguments.fields as downstream input", () => {
    expect(
      validateOperationRequest(
        { operation: "call_tool", tool: "read", arguments: { fields: [] } },
        50,
      ),
    ).toEqual({
      operation: "call_tool",
      tool: "read",
      arguments: { fields: [] },
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
      "get_caplet",
      "check_backend",
      "list_tools",
      "search_tools",
      "get_tool",
      "call_tool",
    ]);
  });

  it("returns concise wrapper content while preserving structured result", () => {
    const result = jsonResult({ id: "alpha", tools: [{ tool: "read" }, { tool: "write" }] });

    expect(result.structuredContent).toEqual({
      result: { id: "alpha", tools: [{ tool: "read" }, { tool: "write" }] },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          { id: "alpha", tools: [{ tool: "read" }, { tool: "write" }] },
          null,
          2,
        ),
      },
    ]);
  });

  it("describes the nested call_tool argument shape to agents", () => {
    const schema = z.toJSONSchema(generatedToolInputSchema, { io: "input" }) as {
      properties: Record<string, { description?: string }>;
    };

    const operationDescription = schema.properties.operation?.description;
    const toolDescription = schema.properties.tool?.description;
    const argumentsDescription = schema.properties.arguments?.description;
    const fieldsDescription = schema.properties.fields?.description;

    expect(operationDescription).toContain("call_tool");
    expect(toolDescription).toContain("Exact downstream tool name");
    expect(argumentsDescription).toContain("arguments");
    expect(argumentsDescription).toContain("downstream inputs");
    expect(fieldsDescription).toBe(
      "Optional call_tool structured output paths when outputSchema allows it.",
    );
  });
});

describe("generated tool handlers", () => {
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
  const tools: Tool[] = [
    {
      name: "read",
      description: "Read files",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    {
      name: "write",
      description: "Write files",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true },
    },
  ];

  it("returns get_caplet without starting downstream", async () => {
    const downstream = { checkServer: vi.fn(), listTools: vi.fn() } as unknown as DownstreamManager;
    const result = (await handleServerTool(
      server,
      { operation: "get_caplet" },
      registry,
      downstream,
    )) as any;
    expect(result.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "get_caplet",
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

  it("returns OpenAPI get_caplet without requiring an OpenAPI manager", async () => {
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
      { operation: "get_caplet" },
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

  it("returns HTTP get_caplet without requiring an HTTP manager", async () => {
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
      { operation: "get_caplet" },
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
      { operation: "check_backend" },
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
      compact: (_capletServer: typeof server, tool: Tool) => ({ tool: tool.name }),
    } as unknown as DownstreamManager;

    const browser = (await handleServerTool(
      browserConfig.mcpServers.browser!,
      { operation: "list_tools" },
      browserRegistry,
      downstream,
    )) as any;
    const stealth = (await handleServerTool(
      browserConfig.mcpServers.stealth!,
      { operation: "list_tools" },
      browserRegistry,
      downstream,
    )) as any;

    expect(browser.content[0]?.text).toContain("browser_click");
    expect(stealth.content[0]?.text).toContain("browser_click");
    expect(browser.content[0]?.text).toContain("Browser");
    expect(stealth.content[0]?.text).toContain("Stealth Browser");
    expect(browser.structuredContent?.result.tools).toEqual([{ tool: "browser_click" }]);
    expect(stealth.structuredContent?.result.tools).toEqual([{ tool: "browser_click" }]);
  });

  it("lists compact metadata and preserves full get_tool metadata", async () => {
    expect(new DownstreamManager(registry).compact(server, tools[0]!)).toMatchObject({
      hasOutputSchema: true,
    });

    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (capletServer: typeof server, tool: Tool) => ({
        id: capletServer.server,
        tool: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        hasInputSchema: Boolean(tool.inputSchema),
        hasOutputSchema: Boolean(tool.outputSchema),
      }),
      getTool: vi.fn().mockResolvedValue(tools[1]),
    } as unknown as DownstreamManager;

    const list = (await handleServerTool(
      server,
      { operation: "list_tools" },
      registry,
      downstream,
    )) as any;
    expect(list.content[0]?.text).toContain("read");
    expect(list.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "list_tools",
      status: "ok",
      elapsedMs: expect.any(Number),
    });
    expect(list.structuredContent?.result).toEqual({
      id: "alpha",
      name: "Alpha",
      tools: [
        {
          id: "alpha",
          tool: "read",
          description: "Read files",
          annotations: undefined,
          hasInputSchema: true,
          hasOutputSchema: true,
        },
        {
          id: "alpha",
          tool: "write",
          description: "Write files",
          annotations: { destructiveHint: true },
          hasInputSchema: true,
          hasOutputSchema: false,
        },
      ],
    });

    const full = (await handleServerTool(
      server,
      { operation: "get_tool", tool: "write" },
      registry,
      downstream,
    )) as any;
    expect(full.structuredContent?.caplets).toEqual({
      id: "alpha",
      name: "Alpha",
      backend: "mcp",
      operation: "get_tool",
      tool: "write",
      status: "ok",
      elapsedMs: expect.any(Number),
    });
    expect(full.structuredContent?.result).toEqual({ id: "alpha", tool: tools[1] });
  });

  it("limits listed tools", async () => {
    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (_capletServer: typeof server, tool: Tool) => ({ tool: tool.name }),
    } as unknown as DownstreamManager;

    const list = (await handleServerTool(
      server,
      { operation: "list_tools", limit: 1 },
      registry,
      downstream,
    )) as any;

    expect(list.structuredContent?.result.tools).toEqual([{ tool: "read" }]);
  });

  it("searches tools by any query token", async () => {
    const browserTools: Tool[] = [
      {
        name: "browser_navigate",
        description: "Navigate to a URL",
        inputSchema: { type: "object" },
      },
      {
        name: "browser_take_screenshot",
        description: "Take a screenshot",
        inputSchema: { type: "object" },
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
      .map((tool) => tool.tool);
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
      { operation: "call_tool", tool: "read", arguments: { path: "x" } },
      registry,
      downstream,
    );
    expect(result).not.toBe(downstreamResult);
    expect(downstreamResult).toEqual(originalDownstreamResult);
    expect(result).toEqual({
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
      { operation: "call_tool", tool: "write", arguments: {} },
      registry,
      downstream,
    );
    expect(result).toEqual({
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
      { operation: "call_tool", tool: "read", arguments: { path: "x" } },
      registry,
      downstream,
    );
    expect(result).toEqual({
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
      { operation: "call_tool", tool: "read", arguments: {} },
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
        name: "read",
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
      { operation: "call_tool", tool: "read", arguments: { path: "x" }, fields: ["message"] },
      registry,
      downstream,
    );

    expect(result).toEqual({
      ...downstreamResult,
      content: [{ type: "text", text: "structured keys: message" }],
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
      { operation: "call_tool", tool: "getUser", arguments: { id: "42" }, fields: ["body.name"] },
      openApiRegistry,
      downstream,
      openapi,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: 'body {"name":"Ada"}' }],
      structuredContent: { body: { name: "Ada" } },
    });
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
        name: "check",
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
      { operation: "call_tool", tool: "check", arguments: { id: "42" }, fields: ["ok"] },
      httpRegistry,
      downstream,
      undefined,
      undefined,
      http,
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "structured keys: ok" }],
      structuredContent: { ok: true },
    });
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
        name: "read",
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
      { operation: "call_tool", tool: "read", arguments: { path: "x" }, fields: ["message"] },
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
        name: "read",
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
        { operation: "call_tool", tool: "read", arguments: { path: "x" }, fields: ["message"] },
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
        { operation: "call_tool", tool: "write", arguments: {}, fields: ["secret"] },
        registry,
        downstream,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" } satisfies Partial<CapletsError>);
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("rejects invalid field paths before calling tools with output schemas", async () => {
    const downstream = {
      getTool: vi.fn().mockResolvedValue({
        name: "read",
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
        { operation: "call_tool", tool: "read", arguments: {}, fields: ["secret"] },
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
      { operation: "call_tool", tool: "query_user", arguments: { id: "42" } },
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
    expect(result).toEqual({
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
        { operation: "call_tool", tool: "query_user", arguments: { id: "42" }, fields: ["user"] },
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
      { operation: "call_tool", tool: "check", arguments: { id: "42" } },
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
    expect(result).toEqual({
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
