import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config";
import { DownstreamManager } from "../src/downstream";
import { ServerRegistry } from "../src/registry";
import type { CapletsError } from "../src/errors";
import { writeTokenBundle } from "../src/auth";
import { handleServerTool } from "../src/tools";
import type { Tool } from "@modelcontextprotocol/sdk/types";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

describe("compact schema fingerprints", () => {
  it("returns compact schema presence flags", () => {
    const config = parseConfig({
      mcpServers: { alpha: { name: "Alpha", description: "Alpha server", command: "node" } },
    });
    const server = config.mcpServers.alpha!;
    const manager = new DownstreamManager(new ServerRegistry(config));
    const schema = {
      type: "object",
      properties: { value: { type: "string" }, count: { type: "number" } },
      required: ["value"],
    };

    const first = manager.compact(server, { name: "first", inputSchema: schema } as Tool);
    const second = manager.compact(server, {
      name: "second",
      inputSchema: schema,
      outputSchema: schema,
    } as Tool);

    expect(first).toMatchObject({
      hasInputSchema: true,
      hasOutputSchema: false,
      requiredArgs: ["value"],
      acceptedArgs: ["count", "value"],
      argsTemplate: { value: "" },
      callTemplate: { operation: "call_tool", name: "first", args: { value: "" } },
    });
    expect(second).toMatchObject({ hasInputSchema: true, hasOutputSchema: true });
    expect(first).not.toHaveProperty("inputSchemaHash");
    expect(second).not.toHaveProperty("outputSchemaHash");
  });

  it("includes compact optional argument templates without schema hashes", () => {
    const config = parseConfig({
      mcpServers: { alpha: { name: "Alpha", description: "Alpha server", command: "node" } },
    });
    const server = config.mcpServers.alpha!;
    const manager = new DownstreamManager(new ServerRegistry(config));

    const compact = manager.compact(server, {
      name: "first",
      inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    } as Tool);

    expect(compact).toMatchObject({ hasInputSchema: true, hasOutputSchema: false });
    expect(compact).toMatchObject({ acceptedArgs: ["a", "b"] });
    expect(compact).toMatchObject({
      argsTemplate: { a: "", b: 0 },
      callTemplate: { operation: "call_tool", name: "first", args: { a: "", b: 0 } },
    });
    expect(compact).not.toHaveProperty("inputSchemaHash");
    expect(compact).not.toHaveProperty("outputSchemaHash");
  });

  it("omits optional argument templates when they would be too large", () => {
    const config = parseConfig({
      mcpServers: { alpha: { name: "Alpha", description: "Alpha server", command: "node" } },
    });
    const server = config.mcpServers.alpha!;
    const manager = new DownstreamManager(new ServerRegistry(config));

    const compact = manager.compact(server, {
      name: "first",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
          c: { type: "boolean" },
          d: { type: "array" },
        },
      },
    } as Tool);

    expect(compact).toMatchObject({ acceptedArgs: ["a", "b", "c", "d"] });
    expect(compact).not.toHaveProperty("argsTemplate");
    expect(compact).toMatchObject({
      callTemplate: { operation: "call_tool", name: "first", args: {} },
    });
  });
});

describe("downstream stdio lifecycle", () => {
  it("lazily starts stdio servers, caches metadata, forwards results, and refuses absent tools", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const registry = new ServerRegistry(config);
    const manager = new DownstreamManager(registry);
    const server = config.mcpServers.fixture!;

    try {
      expect(registry.getStatus("fixture")).toBe("not_started");
      const listed = await manager.listTools(server);
      expect(registry.getStatus("fixture")).toBe("available");
      expect(listed.map((tool) => tool.name).sort()).toEqual(["duplicate", "echo"]);

      const result = await manager.callTool(server, "echo", { message: "hello" });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "echo:hello" }],
        structuredContent: { message: "hello" },
      });

      await expect(manager.callTool(server, "missing", {})).rejects.toMatchObject({
        code: "TOOL_NOT_FOUND",
      } satisfies Partial<CapletsError>);
    } finally {
      await manager.close();
    }
  });

  it("projects MCP structured output when fields are requested", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const registry = new ServerRegistry(config);
    const manager = new DownstreamManager(registry);

    try {
      const result = (await handleServerTool(
        config.mcpServers.fixture!,
        {
          operation: "call_tool",
          name: "echo",
          args: { message: "hello" },
          fields: ["message"],
        },
        registry,
        manager,
      )) as any;

      expect(result).toMatchObject({
        structuredContent: { message: "hello" },
      });
      expect(result.content[0].text).toContain("# Fixture call_tool echo");
      expect(result.content[0].text).toContain("## Result");
      expect(result.content[0].text).toContain('"message": "hello"');
    } finally {
      await manager.close();
    }
  });

  it("omits non-serializable prompt arguments before forwarding to MCP", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const manager = new DownstreamManager(new ServerRegistry(config));

    try {
      const result = await manager.getPrompt(config.mcpServers.fixture!, "review_issue", {
        issueId: "ABC-123",
        ignored: () => "ignored",
        nested: { id: 123 },
      });

      expect(result).toMatchObject({
        messages: [{ role: "user", content: { type: "text", text: "Review ABC-123" } }],
      });
    } finally {
      await manager.close();
    }
  });

  it("closes one managed stdio server so the next operation reconnects", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const registry = new ServerRegistry(config);
    const manager = new DownstreamManager(registry);
    const server = config.mcpServers.fixture!;

    try {
      const first = await manager.listTools(server);
      expect(first.map((tool) => tool.name).sort()).toEqual(["duplicate", "echo"]);

      await manager.closeServer("fixture");

      const second = await manager.listTools(server);
      expect(second.map((tool) => tool.name).sort()).toEqual(["duplicate", "echo"]);
      expect(registry.getStatus("fixture")).toBe("available");
    } finally {
      await manager.close();
    }
  });

  it("refuses stale server configs after the registry changes", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const initialConfig = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const nextConfig = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture Reloaded",
          description: "A reloaded fixture server.",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const registry = new ServerRegistry(initialConfig);
    const manager = new DownstreamManager(registry);
    const staleServer = initialConfig.mcpServers.fixture!;

    try {
      manager.updateRegistry(new ServerRegistry(nextConfig));

      await expect(manager.listTools(staleServer)).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      } satisfies Partial<CapletsError>);

      const listed = await manager.listTools(nextConfig.mcpServers.fixture!);
      expect(listed.map((tool) => tool.name).sort()).toEqual(["duplicate", "echo"]);
    } finally {
      await manager.close();
    }
  });

  it("closes an in-flight remote connection before it can be cached", async () => {
    const firstInitialize = deferred<void>();
    const releaseFirstInitialize = deferred<void>();
    let initializeCount = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          if (!body) {
            response.statusCode = 202;
            response.end();
            return;
          }
          const message = JSON.parse(body) as { id?: number; method?: string };
          response.setHeader("content-type", "application/json");
          if (message.method === "initialize") {
            initializeCount += 1;
            if (initializeCount === 1) {
              firstInitialize.resolve();
              await releaseFirstInitialize.promise;
            }
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture-remote", version: "1.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "tools/list") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] },
              }),
            );
            return;
          }
          response.statusCode = 202;
          response.end();
        })().catch((error) => {
          response.statusCode = 500;
          response.end(String(error));
        });
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote server.",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry);
      const firstList = manager.listTools(config.mcpServers.remote!);

      await firstInitialize.promise;
      await manager.closeServer("remote");
      releaseFirstInitialize.resolve();

      await expect(firstList).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      } satisfies Partial<CapletsError>);

      await manager.close();
    } finally {
      releaseFirstInitialize.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("shares one in-flight remote connection across concurrent operations", async () => {
    const releaseInitialize = deferred<void>();
    let initializeCount = 0;
    let toolsListCount = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          if (!body) {
            response.statusCode = 202;
            response.end();
            return;
          }
          const message = JSON.parse(body) as { id?: number; method?: string };
          response.setHeader("content-type", "application/json");
          if (message.method === "initialize") {
            initializeCount += 1;
            await releaseInitialize.promise;
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture-remote", version: "1.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "tools/list") {
            toolsListCount += 1;
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] },
              }),
            );
            return;
          }
          response.statusCode = 202;
          response.end();
        })().catch((error) => {
          response.statusCode = 500;
          response.end(String(error));
        });
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote server.",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry);
      const check = manager.checkServer(config.mcpServers.remote!);
      const list = manager.listTools(config.mcpServers.remote!);

      await waitUntil(() => initializeCount === 1);
      releaseInitialize.resolve();

      const [checkResult, tools] = await Promise.all([check, list]);

      expect(checkResult).toMatchObject({ id: "remote", status: "available", toolCount: 1 });
      expect(tools.map((tool) => tool.name)).toEqual(["remote_echo"]);
      expect(initializeCount).toBe(1);
      expect(toolsListCount).toBeGreaterThanOrEqual(1);
      expect(registry.getStatus("remote")).toBe("available");

      await manager.close();
    } finally {
      releaseInitialize.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps health checks available when resource templates are not implemented", async () => {
    let resourceTemplatesListCount = 0;
    let resourceTemplatesSupported = true;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          if (!body) {
            response.statusCode = 202;
            response.end();
            return;
          }
          const message = JSON.parse(body) as { id?: number; method?: string };
          response.setHeader("content-type", "application/json");
          if (message.method === "initialize") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {}, resources: {} },
                  serverInfo: { name: "fixture-remote", version: "1.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "tools/list") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { tools: [{ name: "remote_echo", inputSchema: { type: "object" } }] },
              }),
            );
            return;
          }
          if (message.method === "resources/list") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { resources: [] },
              }),
            );
            return;
          }
          if (message.method === "resources/templates/list") {
            resourceTemplatesListCount += 1;
            if (resourceTemplatesSupported) {
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    resourceTemplates: [
                      { name: "Repository file", uriTemplate: "file:///repo/{path}" },
                    ],
                  },
                }),
              );
              return;
            }
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
            return;
          }
          response.statusCode = 202;
          response.end();
        })().catch((error) => {
          response.statusCode = 500;
          response.end(String(error));
        });
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote server.",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry);
      const serverConfig = config.mcpServers.remote!;

      await expect(manager.listResourceTemplates(serverConfig)).resolves.toEqual([
        expect.objectContaining({ uriTemplate: "file:///repo/{path}" }),
      ]);
      expect(resourceTemplatesListCount).toBe(1);

      resourceTemplatesSupported = false;

      const checkResult = await manager.checkServer(serverConfig);

      expect(checkResult).toMatchObject({
        id: "remote",
        status: "available",
        capabilities: expect.objectContaining({ resourceTemplates: false }),
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
      });
      expect(resourceTemplatesListCount).toBe(2);
      expect(registry.getStatus("remote")).toBe("available");
      await expect(manager.listResourceTemplates(serverConfig)).resolves.toEqual([]);
      expect(resourceTemplatesListCount).toBe(2);

      await manager.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("wraps shared pending connection failures for concurrent callers", async () => {
    const releaseInitialize = deferred<void>();
    let initializeCount = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          if (!body) {
            response.statusCode = 202;
            response.end();
            return;
          }
          const message = JSON.parse(body) as { method?: string };
          if (message.method === "initialize") {
            initializeCount += 1;
            await releaseInitialize.promise;
            response.statusCode = 500;
            response.end("initialize failed");
            return;
          }
          response.statusCode = 202;
          response.end();
        })().catch((error) => {
          response.statusCode = 500;
          response.end(String(error));
        });
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A failing remote server.",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry);
      const first = manager.listTools(config.mcpServers.remote!);

      await waitUntil(() => initializeCount === 1);
      const second = manager.listTools(config.mcpServers.remote!);
      releaseInitialize.resolve();

      const results = await Promise.allSettled([first, second]);
      expect(results).toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SERVER_UNAVAILABLE" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "SERVER_UNAVAILABLE" }),
        }),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(Error);
          expect(result.reason).toMatchObject({
            code: "SERVER_UNAVAILABLE",
            message: "Could not start remote",
          } satisfies Partial<CapletsError>);
        }
      }
      expect(registry.getStatus("remote")).toBe("unavailable");

      await manager.close();
    } finally {
      releaseInitialize.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("downstream remote OAuth lifecycle", () => {
  it("surfaces missing OAuth credentials as AUTH_REQUIRED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote OAuth server.",
            transport: "http",
            url: "http://127.0.0.1:9/mcp",
            auth: { type: "oauth2" },
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry, { authDir: join(dir, "auth") });

      await expect(manager.listTools(config.mcpServers.remote!)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        details: expect.objectContaining({
          nextAction: "run_caplets_auth_login",
        }),
      } satisfies Partial<CapletsError>);
      expect(registry.getStatus("remote")).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies OAuth 403 responses as AUTH_FAILED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (!body) {
          response.statusCode = 202;
          response.end();
          return;
        }
        const message = JSON.parse(body) as { id?: number; method?: string };
        response.setHeader("content-type", "application/json");
        if (message.method === "initialize") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture-remote", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (message.method === "tools/list") {
          response.statusCode = 403;
          response.statusMessage = "Forbidden";
          response.end();
          return;
        }
        response.statusCode = 202;
        response.end();
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "secret-oauth-token",
          refreshToken: "secret-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        authDir,
      );
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote OAuth server.",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
            auth: { type: "oauth2" },
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry, { authDir });

      try {
        await expect(manager.listTools(config.mcpServers.remote!)).rejects.toMatchObject({
          code: "AUTH_FAILED",
          details: expect.objectContaining({
            nextAction: "run_caplets_auth_login",
            status: 403,
          }),
        } satisfies Partial<CapletsError>);
        expect(registry.getStatus("remote")).toBe("unavailable");
      } finally {
        await manager.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the MCP SDK auth provider for stored OAuth tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const authorizationHeaders: Array<string | undefined> = [];
    let baseUrl = "";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.method === "GET") {
        authorizationHeaders.push(request.headers.authorization);
        response.statusCode = 405;
        response.end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        authorizationHeaders.push(request.headers.authorization);
        const message = JSON.parse(body) as { id?: number; method?: string };
        response.setHeader("content-type", "application/json");
        if (message.method === "initialize") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture-remote", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (message.method === "tools/list") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [] },
            }),
          );
          return;
        }
        response.statusCode = 202;
        response.end();
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not bind fixture server");
      }
      baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "secret-oauth-token",
          refreshToken: "secret-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        authDir,
      );
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote OAuth server.",
            transport: "http",
            url: baseUrl,
            auth: { type: "oauth2" },
          },
        },
      });
      const registry = new ServerRegistry(config);
      const manager = new DownstreamManager(registry, { authDir });

      try {
        await manager.listTools(config.mcpServers.remote!);
      } finally {
        await manager.close();
      }

      expect(authorizationHeaders).toContain("Bearer secret-oauth-token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
