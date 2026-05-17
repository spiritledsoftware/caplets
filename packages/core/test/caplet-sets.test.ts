import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletSetManager } from "../src/caplet-sets.js";
import { parseConfig } from "../src/config.js";
import { ServerRegistry } from "../src/registry.js";

describe("CapletSetManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists, searches, reads, and calls child Caplets as nested tools", async () => {
    const { dir, childConfigPath } = childCliConfig();
    dirs.push(dir);
    const config = parseConfig({
      capletSets: {
        nested: {
          name: "Nested Caplets",
          description: "Expose child Caplets through a nested collection.",
          configPath: childConfigPath,
          toolCacheTtlMs: 0,
        },
      },
    });
    const caplet = config.capletSets.nested!;
    const registry = new ServerRegistry(config);
    const manager = new CapletSetManager(registry);

    await expect(manager.checkSet(caplet)).resolves.toMatchObject({
      server: "nested",
      status: "available",
      toolCount: 1,
    });
    const tools = await manager.listTools(caplet);
    expect(tools.map((tool) => tool.name)).toEqual(["echoes"]);
    expect(manager.search(caplet, tools, "echo", 5)).toMatchObject([{ tool: "echoes" }]);
    await expect(manager.getTool(caplet, "echoes")).resolves.toMatchObject({
      name: "echoes",
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({ operation: expect.any(Object) }),
      }),
    });

    const listed = await manager.callTool(caplet, "echoes", { operation: "list_tools" });
    expect(listed.structuredContent).toMatchObject({
      result: {
        server: "echoes",
        tools: [{ tool: "echo_json" }],
      },
    });

    const called = await manager.callTool(caplet, "echoes", {
      operation: "call_tool",
      tool: "echo_json",
      arguments: { message: "hello" },
    });
    expect(called.isError).toBe(false);
    expect(called.structuredContent).toMatchObject({
      exitCode: 0,
      json: { message: "hello" },
    });
  });

  it("loads child config and child Caplet files from independently configured sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-set-files-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    const capletsRoot = join(dir, "caplets");
    mkdirSync(capletsRoot, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          configured: {
            name: "Configured",
            description: "Configured child Caplet.",
            command: process.execPath,
          },
        },
      }),
    );
    writeFileSync(
      join(capletsRoot, "file.md"),
      [
        "---",
        "name: File Child",
        "description: Child Caplet loaded from a Markdown file.",
        "mcpServer:",
        `  command: ${JSON.stringify(process.execPath)}`,
        "---",
        "# File Child",
      ].join("\n"),
    );
    const config = parseConfig({
      capletSets: {
        nested: {
          name: "Nested Caplets",
          description: "Expose child Caplets through a nested collection.",
          configPath,
          capletsRoot,
        },
      },
    });
    const caplet = config.capletSets.nested!;
    const manager = new CapletSetManager(new ServerRegistry(config));

    await expect(manager.listTools(caplet)).resolves.toMatchObject([
      { name: "configured" },
      { name: "file" },
    ]);
  });

  it("reports recursive source cycles through nested Caplet sets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-set-cycle-"));
    dirs.push(dir);
    const childConfigPath = join(dir, "child.json");
    writeFileSync(
      childConfigPath,
      JSON.stringify({
        capletSets: {
          self: {
            name: "Self",
            description: "Points back to the same child Caplets source.",
            configPath: childConfigPath,
          },
        },
      }),
    );
    const config = parseConfig({
      capletSets: {
        nested: {
          name: "Nested Caplets",
          description: "Expose child Caplets through a nested collection.",
          configPath: childConfigPath,
          toolCacheTtlMs: 0,
        },
      },
    });
    const caplet = config.capletSets.nested!;
    const manager = new CapletSetManager(new ServerRegistry(config));

    const result = await manager.callTool(caplet, "self", { operation: "check_backend" });

    expect(result.structuredContent).toMatchObject({
      result: {
        status: "unavailable",
        error: {
          code: "CONFIG_INVALID",
          message: "Nested Caplet set cycle detected",
        },
      },
    });
  });

  function childCliConfig(): { dir: string; childConfigPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "caplets-set-"));
    const script = join(dir, "echo.mjs");
    const childConfigPath = join(dir, "child.json");
    writeFileSync(
      script,
      ["const message = process.argv[2];", "console.log(JSON.stringify({ message }));"].join("\n"),
    );
    writeFileSync(
      childConfigPath,
      JSON.stringify({
        cliTools: {
          echoes: {
            name: "Echoes",
            description: "Echo JSON messages from a child Caplet.",
            actions: {
              echo_json: {
                description: "Echo one JSON message.",
                command: process.execPath,
                args: [script, "$input.message"],
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
                output: { type: "json" },
              },
            },
          },
        },
      }),
    );
    return { dir, childConfigPath };
  }
});
