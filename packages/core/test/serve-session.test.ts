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
    expect(server.registered.get("code_mode")).toBeDefined();
    expect(server.registered.get("run")).toBeUndefined();
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

  it("registers project-bound Caplets when the engine has session context", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha.",
          command: "node",
          projectBinding: { required: true },
        },
      },
    });
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      watch: false,
      projectBindingContext: {
        sessionId: "session_1",
        bindingId: "binding_1",
        projectRoot,
        projectFingerprint: "sha256:project",
      },
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });

    expect(session.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registered.get("alpha")).toBeDefined();

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
    const codeMode = server.registered.get("code_mode")!;

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
    expect(codeMode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('gamma:CapletHandle<"gamma">'),
      }),
    );
    expect(codeMode.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        description: expect.stringContaining('alpha:CapletHandle<"alpha">'),
      }),
    );
    expect(session.registeredToolIds()).toEqual(["gamma"]);
    expect(server.registered.get("gamma")).toBeDefined();

    await session.close();
    await engine.close();
  });

  it("registers direct operation tools without progressive wrapper or Code Mode", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Call status over HTTP.",
          exposure: "direct",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: {
            ping: {
              method: "GET",
              path: "/ping",
              description: "Ping the service.",
              inputSchema: {
                type: "object",
                properties: { verbose: { type: "boolean" } },
              },
            },
          },
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });

    await session.refreshExposure();

    expect(session.registeredToolIds()).toEqual(["status__ping"]);
    expect(server.registered.get("status")).toBeUndefined();
    expect(server.registered.get("code_mode")).toBeUndefined();
    expect(server.definitions.get("status__ping")).toMatchObject({
      description: "Ping the service.",
      inputSchema: {
        type: "object",
        properties: { verbose: { type: "boolean" } },
      },
    });

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
  writeFileSync(path, JSON.stringify(progressiveTestConfig(config)));
}

function progressiveTestConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (record.options) return config;
  return { options: { exposure: "progressive_and_code_mode" }, ...record };
}

function mockServer() {
  const registered = new Map<string, RegisteredTool>();
  const definitions = new Map<string, Record<string, unknown>>();
  return {
    registered,
    definitions,
    registerTool: vi.fn((name: string, definition: Record<string, unknown>) => {
      const tool = {
        update: vi.fn(),
        remove: vi.fn(() => registered.delete(name)),
        enable: vi.fn(),
        disable: vi.fn(),
        enabled: true,
        handler: vi.fn(),
      } as unknown as RegisteredTool;
      registered.set(name, tool);
      definitions.set(name, definition);
      return tool;
    }),
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
