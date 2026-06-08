import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { CapletsMcpSession } from "../src/serve/session";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CapletsMcpSession", () => {
  it("registers enabled Caplets from a shared engine", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: { name: "Alpha", description: "Search alpha.", command: "node" },
        beta: { name: "Beta", description: "Search beta.", command: "node", disabled: true },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });

    expect(session.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registerTool).toHaveBeenCalledTimes(2);
    expect(server.registered.get("run")).toBeDefined();
    expect(server.registerTool).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        inputSchema: expect.objectContaining({ fields: expect.anything() }),
      }),
      expect.any(Function),
    );

    await session.close();
    await engine.close();
  });

  it("reconciles tools when the shared engine reloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: { name: "Alpha", description: "Search alpha.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    const alpha = server.registered.get("alpha")!;
    const run = server.registered.get("run")!;

    writeConfig(configPath, {
      httpApis: {
        gamma: {
          name: "Gamma HTTP",
          description: "Call gamma over HTTP.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { search: { method: "GET", path: "/search" } },
        },
      },
    });
    await engine.reload();

    expect(alpha.remove).toHaveBeenCalledTimes(1);
    expect(run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('gamma:CapletHandle<"gamma">'),
      }),
    );
    expect(run.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        description: expect.stringContaining('alpha:CapletHandle<"alpha">'),
      }),
    );
    expect(session.registeredToolIds()).toEqual(["gamma"]);
    expect(server.registered.get("gamma")).toBeDefined();

    await session.close();
    await engine.close();
  });
});

function tempConfig(config: unknown): {
  dir: string;
  configPath: string;
  projectConfigPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "caplets-session-"));
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeConfig(configPath, config);
  return { dir, configPath, projectConfigPath };
}

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config));
}

function mockServer() {
  const registered = new Map<string, RegisteredTool>();
  return {
    registered,
    registerTool: vi.fn((name: string) => {
      const tool = {
        update: vi.fn(),
        remove: vi.fn(() => registered.delete(name)),
        enable: vi.fn(),
        disable: vi.fn(),
        enabled: true,
        handler: vi.fn(),
      } as unknown as RegisteredTool;
      registered.set(name, tool);
      return tool;
    }),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
