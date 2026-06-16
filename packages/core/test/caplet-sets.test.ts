import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletSetManager } from "../src/caplet-sets";
import { parseConfig } from "../src/config";
import { ServerRegistry } from "../src/registry";

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
      id: "nested",
      status: "available",
      toolCount: 1,
    });
    const tools = await manager.listTools(caplet);
    expect(tools.map((tool) => tool.name)).toEqual(["echoes"]);
    expect(manager.search(caplet, tools, "echo", 5)).toMatchObject([{ name: "echoes" }]);
    await expect(manager.getTool(caplet, "echoes")).resolves.toMatchObject({
      name: "echoes",
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({ operation: expect.any(Object) }),
      }),
    });

    const listed = await manager.callTool(caplet, "echoes", { operation: "tools" });
    expect(listed.structuredContent).toMatchObject({
      result: {
        id: "echoes",
        items: [{ name: "echo_json" }],
      },
    });

    const called = await manager.callTool(caplet, "echoes", {
      operation: "call_tool",
      name: "echo_json",
      args: { message: "hello" },
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

  it("routes child Google Discovery Caplets through nested tool calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-set-google-discovery-"));
    dirs.push(dir);
    const configPath = join(dir, "child.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        googleDiscoveryApis: {
          drive: {
            name: "Google Drive",
            description: "Access Google Drive files.",
            discoveryPath: join(__dirname, "fixtures/google-discovery/drive.discovery.json"),
            baseUrl: "https://www.googleapis.com/drive/v3/",
            auth: { type: "none" },
            includeOperations: ["drive.files.list"],
          },
        },
      }),
    );
    const config = parseConfig({
      capletSets: {
        nested: {
          name: "Nested Caplets",
          description: "Expose child Caplets through a nested collection.",
          configPath,
        },
      },
    });
    const caplet = config.capletSets.nested!;
    const manager = new CapletSetManager(new ServerRegistry(config));

    const result = await manager.callTool(caplet, "drive", { operation: "tools" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      result: {
        id: "drive",
        items: [{ name: "drive.files.list" }],
      },
    });
  });

  it("serializes concurrent refreshes for one parent Caplet set", async () => {
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
    const manager = new CapletSetManager(new ServerRegistry(config));
    await manager.listTools(caplet);

    let closeCalls = 0;
    const target = manager as unknown as { closeChild: (serverId: string) => Promise<void> };
    const originalCloseChild = target.closeChild.bind(manager);
    target.closeChild = async (serverId: string) => {
      closeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      await originalCloseChild(serverId);
    };

    await Promise.all([manager.listTools(caplet), manager.listTools(caplet)]);

    expect(closeCalls).toBe(1);
  });

  it("waits for in-flight refreshes before closing child runtimes", async () => {
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
    const manager = new CapletSetManager(new ServerRegistry(config));

    const target = manager as unknown as {
      loadChildRuntime: (nextConfig: typeof caplet, force: boolean) => Promise<unknown>;
      closeChild: (serverId: string) => Promise<void>;
    };
    const originalLoadChildRuntime = target.loadChildRuntime.bind(manager);
    target.loadChildRuntime = async (nextConfig, force) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return await originalLoadChildRuntime(nextConfig, force);
    };

    let closeCalls = 0;
    const originalCloseChild = target.closeChild.bind(manager);
    target.closeChild = async (serverId: string) => {
      closeCalls += 1;
      await originalCloseChild(serverId);
    };

    const refresh = manager.listTools(caplet);
    await manager.close();
    await refresh;

    expect(closeCalls).toBe(1);
  });

  it("does not let in-flight refreshes repopulate invalidated child runtimes", async () => {
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
    const manager = new CapletSetManager(new ServerRegistry(config));

    const target = manager as unknown as {
      loadChildRuntime: (nextConfig: typeof caplet, force: boolean) => Promise<unknown>;
      children: Map<string, unknown>;
    };
    const originalLoadChildRuntime = target.loadChildRuntime.bind(manager);
    target.loadChildRuntime = async (nextConfig, force) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return await originalLoadChildRuntime(nextConfig, force);
    };

    const refresh = manager.listTools(caplet);
    manager.invalidate(caplet.server);
    await refresh;
    await Promise.resolve();

    expect(target.children.has(caplet.server)).toBe(false);
  });

  it("keeps serving the last known-good child runtime when reload config is invalid", async () => {
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
    const manager = new CapletSetManager(new ServerRegistry(config));
    await expect(manager.listTools(caplet)).resolves.toMatchObject([{ name: "echoes" }]);

    writeFileSync(childConfigPath, "{");

    await expect(manager.listTools(caplet)).resolves.toMatchObject([{ name: "echoes" }]);
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

    const result = await manager.callTool(caplet, "self", { operation: "check" });

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
