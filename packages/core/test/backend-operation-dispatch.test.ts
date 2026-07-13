import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import { describe, expect, it, vi } from "vitest";
import {
  createBackendOperationRuntime,
  handleServerTool,
  parseConfig,
  ServerRegistry,
  type BackendOperationDispatch,
  type BackendOperationManagers,
  type McpOperationAdapter,
} from "../src/index";
import { loadCapletFilesFromMap } from "../src/caplet-files";
import { DownstreamManager } from "../src/downstream";
import type { CapletConfig } from "../src/config";
import { testBackendOperationRuntime } from "./backend-operation-runtime";

const BACKENDS = [
  ["mcp", "mcp", "checkServer"],
  ["openapi", "openapi", "checkEndpoint"],
  ["googleDiscovery", "googleDiscovery", "checkApi"],
  ["graphql", "graphql", "checkEndpoint"],
  ["http", "http", "checkApi"],
  ["cli", "cli", "checkTools"],
  ["caplets", "caplets", "checkSet"],
] as const;

const TOOL: Tool = {
  name: "echo",
  inputSchema: { type: "object" },
};

describe("backend operation dispatch", () => {
  it.each(BACKENDS)(
    "routes all common %s operations to only the selected adapter",
    async (backend, managerName, checkMethod) => {
      const managers = managerBundle();
      const runtime = createBackendOperationRuntime(
        managers as unknown as BackendOperationManagers,
      );
      const server = { backend, server: `${backend}-server` } as CapletConfig;
      const selected = managers[managerName];

      await expect(runtime.operations.check(server)).resolves.toEqual({ source: managerName });
      await expect(runtime.operations.listTools(server)).resolves.toEqual([TOOL]);
      await expect(runtime.operations.getTool(server, "echo")).resolves.toBe(TOOL);
      await expect(runtime.operations.callTool(server, "echo", { value: 1 })).resolves.toEqual({
        source: managerName,
      });
      expect(runtime.operations.compact(server, TOOL)).toEqual({ name: "echo" });
      expect(runtime.operations.search(server, [TOOL], "ech", 5)).toEqual([{ name: "echo" }]);

      expect(selected[checkMethod]).toHaveBeenCalledOnce();
      expect(selected.listTools).toHaveBeenCalledOnce();
      expect(selected.getTool).toHaveBeenCalledOnce();
      expect(selected.callTool).toHaveBeenCalledOnce();
      expect(selected.compact).toHaveBeenCalledOnce();
      expect(selected.search).toHaveBeenCalledOnce();

      for (const [otherBackend, otherManagerName, otherCheckMethod] of BACKENDS) {
        if (otherBackend === backend) continue;
        const other = managers[otherManagerName];
        expect(other[otherCheckMethod]).not.toHaveBeenCalled();
        expect(other.listTools).not.toHaveBeenCalled();
        expect(other.getTool).not.toHaveBeenCalled();
        expect(other.callTool).not.toHaveBeenCalled();
        expect(other.compact).not.toHaveBeenCalled();
        expect(other.search).not.toHaveBeenCalled();
      }
    },
  );

  it("dispatches body-free Caplet file configurations to backend managers", async () => {
    const loaded = loadCapletFilesFromMap({
      files: [
        {
          path: "operator/CAPLET.md",
          content: `---
name: Operator
description: Exercise backend manager isolation.
mcpServer:
  command: operator-mcp
---
# README_SENTINEL
backend: fake
path: ../../secret
token: sk-secret-looking
`,
        },
      ],
    });
    const config = parseConfig(loaded!.config);
    const server = config.mcpServers.operator!;
    const managers = managerBundle();
    const runtime = createBackendOperationRuntime(managers as unknown as BackendOperationManagers);

    await runtime.operations.check(server);
    await runtime.operations.listTools(server);
    await runtime.operations.callTool(server, "echo", {});

    expect(server).not.toHaveProperty("body");
    expect(managers.mcp.checkServer.mock.calls[0]?.[0]).not.toHaveProperty("body");
    expect(managers.mcp.listTools.mock.calls[0]?.[0]).not.toHaveProperty("body");
    expect(managers.mcp.callTool.mock.calls[0]?.[0]).not.toHaveProperty("body");
  });
  it("retains the exact MCP manager as the separately named MCP capability", () => {
    const managers = managerBundle();
    const runtime = createBackendOperationRuntime(managers as unknown as BackendOperationManagers);

    expect(runtime.mcp).toBe(managers.mcp);
  });

  it("keeps inspect local and non-MCP discovery out of both capabilities", async () => {
    const config = parseConfig({
      httpApis: {
        status: {
          name: "Status",
          description: "Read service status.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { read: { method: "GET", path: "/status" } },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const operations = {
      check: vi.fn(),
      listTools: vi.fn(),
      getTool: vi.fn(),
      callTool: vi.fn(),
      compact: vi.fn(),
      search: vi.fn(),
    } as unknown as BackendOperationDispatch;
    const mcp = {
      listResources: vi.fn(),
    } as unknown as McpOperationAdapter;
    const runtime = { operations, mcp };
    const server = config.httpApis.status!;

    const inspected = await handleServerTool(server, { operation: "inspect" }, registry, runtime);
    await expect(
      handleServerTool(server, { operation: "resources" }, registry, runtime),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });

    expect(inspected.structuredContent).toMatchObject({
      result: { id: "status", backend: { type: "http" } },
    });
    expect(operations.check).not.toHaveBeenCalled();
    expect(operations.listTools).not.toHaveBeenCalled();
    expect(mcp.listResources).not.toHaveBeenCalled();
  });

  it("passes a selected adapter failure through unchanged", async () => {
    const failure = new Error("opaque adapter failure");
    const managers = managerBundle();
    managers.http.callTool.mockRejectedValueOnce(failure);
    const runtime = createBackendOperationRuntime(managers as unknown as BackendOperationManagers);
    const server = { backend: "http", server: "status" } as CapletConfig;

    await expect(runtime.operations.callTool(server, "read", {})).rejects.toBe(failure);
  });

  it("preserves real MCP-only operations through the named runtime capability", async () => {
    const fixture = fileURLToPath(new URL("fixtures/stdio-server.ts", import.meta.url));
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", import.meta.resolve("tsx"), fixture],
        },
      },
    });
    const registry = new ServerRegistry(config);
    const mcp = new DownstreamManager(registry);
    const runtime = testBackendOperationRuntime(registry, { mcp });
    const server = config.mcpServers.fixture!;

    try {
      const resources = await handleServerTool(
        server,
        { operation: "resources" },
        registry,
        runtime,
      );
      const templates = await handleServerTool(
        server,
        { operation: "resource_templates" },
        registry,
        runtime,
      );
      const resource = await handleServerTool(
        server,
        { operation: "read_resource", uri: "file:///repo/README.md" },
        registry,
        runtime,
      );
      const prompts = await handleServerTool(server, { operation: "prompts" }, registry, runtime);
      const prompt = await handleServerTool(
        server,
        { operation: "get_prompt", name: "review_issue", args: { issueId: "CAP-123" } },
        registry,
        runtime,
      );
      const completion = await handleServerTool(
        server,
        {
          operation: "complete",
          ref: { type: "resourceTemplate", uri: "file:///repo/{path}" },
          argument: { name: "path", value: "READ" },
        },
        registry,
        runtime,
      );
      const contextualCompletion = await handleServerTool(
        server,
        {
          operation: "complete",
          ref: {
            type: "resourceTemplate",
            uri: "repo://{owner}/{name}{?region}",
          },
          argument: { name: "name", value: "co" },
          context: { arguments: { owner: "caplets", region: "eu" } },
        } as Parameters<typeof handleServerTool>[1],
        registry,
        runtime,
      );

      expect(resources.structuredContent).toMatchObject({
        result: {
          items: expect.arrayContaining([
            expect.objectContaining({ uri: "file:///repo/README.md" }),
          ]),
        },
      });
      expect(templates.structuredContent).toMatchObject({
        result: {
          items: expect.arrayContaining([
            expect.objectContaining({ uriTemplate: "file:///repo/{path}" }),
          ]),
        },
      });
      expect(resource.contents).toEqual([
        {
          uri: "file:///repo/README.md",
          text: "# Fixture README",
          mimeType: "text/markdown",
        },
      ]);
      expect(prompts.structuredContent).toMatchObject({
        result: { items: [{ prompt: "review_issue" }] },
      });
      expect(prompt.messages).toEqual([
        { role: "user", content: { type: "text", text: "Review CAP-123" } },
      ]);
      expect(completion.completion.values).toEqual(["README.md"]);
      expect(contextualCompletion).toMatchObject({ completion: { values: ["core"] } });
    } finally {
      await mcp.close();
    }
  });
});

function managerBundle() {
  return {
    mcp: manager("mcp", "checkServer"),
    openapi: manager("openapi", "checkEndpoint"),
    googleDiscovery: manager("googleDiscovery", "checkApi"),
    graphql: manager("graphql", "checkEndpoint"),
    http: manager("http", "checkApi"),
    cli: manager("cli", "checkTools"),
    caplets: manager("caplets", "checkSet"),
  };
}

function manager(source: string, checkMethod: string) {
  return {
    [checkMethod]: vi.fn(async () => ({ source })),
    listTools: vi.fn(async () => [TOOL]),
    getTool: vi.fn(async () => TOOL),
    callTool: vi.fn(async () => ({ source })),
    compact: vi.fn(() => ({ name: TOOL.name })),
    search: vi.fn(() => [{ name: TOOL.name }]),
  };
}
