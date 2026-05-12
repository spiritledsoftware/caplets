import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { DownstreamManager } from "../src/downstream.js";
import { ServerRegistry } from "../src/registry.js";
import { CapletsError } from "../src/errors.js";

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
