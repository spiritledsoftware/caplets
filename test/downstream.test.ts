import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.js";
import { DownstreamManager } from "../src/downstream.js";
import { ServerRegistry } from "../src/registry.js";
import { CapletsError } from "../src/errors.js";
import { writeTokenBundle } from "../src/auth.js";

describe("downstream stdio lifecycle", () => {
  it("lazily starts stdio servers, caches metadata, forwards results, and refuses absent tools", async () => {
    const fixture = join(process.cwd(), "test", "fixtures", "stdio-server.mjs");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: [fixture],
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

  it("closes one managed stdio server so the next operation reconnects", async () => {
    const fixture = join(process.cwd(), "test", "fixtures", "stdio-server.mjs");
    const config = parseConfig({
      mcpServers: {
        fixture: {
          name: "Fixture",
          description: "A useful fixture server.",
          command: process.execPath,
          args: [fixture],
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
