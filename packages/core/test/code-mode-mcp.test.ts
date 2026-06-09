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

describe("Code Mode MCP tool", () => {
  it("registers code_mode alongside existing Caplet tools", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: { name: "GitHub", description: "GitHub repo operations.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });

    expect(session.registeredToolIds()).toEqual(["github"]);
    expect(server.registered.get("github")).toBeDefined();
    expect(server.registered.get("code_mode")).toBeDefined();
    expect(server.registered.get("run")).toBeUndefined();
    expect(server.definitions.get("code_mode")?.description).toContain("caplets.<id>");
    expect(server.definitions.get("code_mode")?.description).toContain(
      "Prefer a compact one-pass script for most tasks",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "Do not return full tool lists",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "keep bulky intermediate data inside the script",
    );
    expect(server.definitions.get("code_mode")?.description).toContain("Execute with exact args");
    expect(server.definitions.get("code_mode")?.description).toContain(
      "return only decision-ready JSON",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "derive final recommendations from all relevant records",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "summaries, key ids/names/titles/statuses/urls, derived fields, recommendation",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "If records disagree or have ranges/statuses, compute the strictest applicable conclusion",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "Never invent tool names, resource URIs, prompt names",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "when args matter, use describeTool",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "exact callSignature/inputSchema/inputTypeScript",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "list broad candidate records",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      'const h=caplets["caplet-id"]',
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      "remove unused descriptors/schemas/raw content",
    );
    expect(server.definitions.get("code_mode")?.description).not.toContain(
      "Do not split discovery and execution",
    );
    expect(server.definitions.get("code_mode")?.description).not.toContain(
      "inside the same script before returning",
    );
    expect(server.definitions.get("code_mode")?.description).not.toContain(
      "Use multiple `run` calls only after",
    );
    expect(server.definitions.get("code_mode")?.description).not.toContain("OSV");
    expect(server.definitions.get("code_mode")?.description).not.toContain("vulnerability");
    expect(server.definitions.get("code_mode")?.description).not.toContain("release");
    expect(server.definitions.get("code_mode")?.description).toContain(
      "Generated declaration hints:",
    );
    expect(server.definitions.get("code_mode")?.description).toContain(
      'github:CapletHandle<"github">',
    );

    await session.close();
    await engine.close();
  });

  it("returns a structured run envelope from the code_mode tool", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: { name: "GitHub", description: "GitHub repo operations.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    const callback = server.callbacks.get("code_mode");

    const result = await callback?.({ code: "return { ok: true };" });

    expect(result?.structuredContent).toMatchObject({
      ok: true,
      value: { ok: true },
    });
    expect(result?.content[0]).toMatchObject({ type: "text" });

    await session.close();
    await engine.close();
  });
});

function tempConfig(config: unknown): {
  dir: string;
  configPath: string;
  projectConfigPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-mcp-"));
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath, projectConfigPath };
}

function mockServer() {
  const registered = new Map<string, RegisteredTool>();
  const definitions = new Map<string, { description?: string }>();
  const callbacks = new Map<string, (request: unknown) => Promise<any>>();
  return {
    registered,
    definitions,
    callbacks,
    registerTool: vi.fn((name: string, definition: { description?: string }, callback) => {
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
      callbacks.set(name, callback);
      return tool;
    }),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
