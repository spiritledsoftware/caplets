import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types";
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
  });

  it("exposes the Caplet-first operation enum", () => {
    const schema = z.toJSONSchema(generatedToolInputSchema, { io: "input" }) as {
      properties: Record<string, { enum?: string[] }>;
    };

    expect(schema.properties.operation?.enum).toEqual([
      "get_caplet",
      "check_backend",
      "check_mcp_server",
      "list_tools",
      "search_tools",
      "get_tool",
      "call_tool",
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
    expect(argumentsDescription).toContain(
      '"operation":"call_tool","tool":"web_search_exa","arguments":{"query":"latest MCP docs","numResults":3}}',
    );
    expect(argumentsDescription).toContain("top-level query");
    expect(fieldsDescription).toBe(
      'Optional for call_tool after get_tool shows outputSchema on a non-GraphQL tool. Example: fields: ["path.to.field"].',
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
    expect(result.structuredContent?.result).toEqual({
      caplet: "alpha",
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
      mcpServer: {
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
      caplet: "users",
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
      caplet: "status",
      backend: {
        type: "http",
        configuredActions: 1,
      },
    });
  });

  it("checks the MCP server backend", async () => {
    const status = { server: "alpha", status: "available", toolCount: 2, elapsedMs: 5 };
    const downstream = {
      checkServer: vi.fn().mockResolvedValue(status),
      listTools: vi.fn(),
      callTool: vi.fn(),
    } as unknown as DownstreamManager;
    const result = (await handleServerTool(
      server,
      { operation: "check_mcp_server" },
      registry,
      downstream,
    )) as any;

    expect(result.structuredContent?.result).toEqual(status);
    expect(downstream.checkServer).toHaveBeenCalledWith(server);
    expect(downstream.listTools).not.toHaveBeenCalled();
    expect(downstream.callTool).not.toHaveBeenCalled();
  });

  it("lists compact metadata and preserves full get_tool metadata", async () => {
    expect(new DownstreamManager(registry).compact(server, tools[0]!)).toMatchObject({
      hasOutputSchema: true,
    });

    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (capletServer: typeof server, tool: Tool) => ({
        server: capletServer.server,
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
    expect(list.structuredContent?.result).toEqual({
      server: "alpha",
      tools: [
        {
          server: "alpha",
          tool: "read",
          description: "Read files",
          annotations: undefined,
          hasInputSchema: true,
          hasOutputSchema: true,
        },
        {
          server: "alpha",
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
    expect(full.structuredContent?.result).toEqual({ server: "alpha", tool: tools[1] });
  });

  it("forwards call_tool result without transformation", async () => {
    const downstreamResult = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
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
    expect(result).toBe(downstreamResult);
  });

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
      content: [{ type: "text", text: '{\n  "message": "ok"\n}' }],
      structuredContent: { message: "ok" },
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
      content: [{ type: "text", text: '{\n  "body": {\n    "name": "Ada"\n  }\n}' }],
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
      content: [{ type: "text", text: '{\n  "ok": true\n}' }],
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

    expect(result).toBe(downstreamResult);
    expect(result).toEqual(downstreamResult);
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

    expect(result).toBe(graphqlResult);
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

    expect(result).toBe(httpResult);
    expect(http.callTool).toHaveBeenCalledWith(httpCaplet, "check", { id: "42" });
    expect(downstream.callTool).not.toHaveBeenCalled();
  });
});
