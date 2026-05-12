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
});

describe("downstream remote OAuth lifecycle", () => {
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
