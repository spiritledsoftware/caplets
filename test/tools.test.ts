import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseConfig } from "../src/config.js";
import { DownstreamManager } from "../src/downstream.js";
import { CapletsError } from "../src/errors.js";
import { ServerRegistry } from "../src/registry.js";
import { handleServerTool, validateOperationRequest } from "../src/tools.js";

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

  it("returns get_server without starting downstream", async () => {
    const downstream = { checkServer: vi.fn(), listTools: vi.fn() } as unknown as DownstreamManager;
    const result = (await handleServerTool(
      server,
      { operation: "get_server" },
      registry,
      downstream,
    )) as any;
    expect(result.structuredContent?.result).toEqual({
      server: "alpha",
      name: "Alpha",
      description: "Search alpha project documents.",
    });
    expect(downstream.listTools).not.toHaveBeenCalled();
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
});
