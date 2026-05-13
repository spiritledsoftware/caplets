import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseConfig } from "../src/config.js";
import { DownstreamManager } from "../src/downstream.js";
import { CapletsError } from "../src/errors.js";
import type { GraphQLManager, GraphqlEndpointConfig } from "../src/graphql.js";
import type { HttpActionManager } from "../src/http-actions.js";
import { ServerRegistry } from "../src/registry.js";
import {
  generatedToolInputSchema,
  handleServerTool,
  validateOperationRequest,
} from "../src/tools.js";

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

    expect(operationDescription).toContain("call_tool");
    expect(toolDescription).toContain("Exact downstream tool name");
    expect(argumentsDescription).toContain("arguments");
    expect(argumentsDescription).toContain(
      '"operation":"call_tool","tool":"web_search_exa","arguments":{"query":"latest MCP docs","numResults":3}}',
    );
    expect(argumentsDescription).toContain("top-level query");
  });
});

describe("generated tool handlers", () => {
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
    { name: "read", description: "Read files", inputSchema: { type: "object" } },
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
    const downstream = {
      listTools: vi.fn().mockResolvedValue(tools),
      compact: (capletServer: typeof server, tool: Tool) => ({
        server: capletServer.server,
        tool: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        hasInputSchema: Boolean(tool.inputSchema),
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
        },
        {
          server: "alpha",
          tool: "write",
          description: "Write files",
          annotations: { destructiveHint: true },
          hasInputSchema: true,
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
