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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();

    expect(session.registeredToolIds()).toEqual(["github"]);
    expect(server.registered.get("github")).toBeDefined();
    expect(server.registered.get("code_mode")).toBeDefined();
    expect(server.registered.get("run")).toBeUndefined();
    const codeModeInputSchema = server.definitions.get("code_mode")?.inputSchema as Record<
      string,
      { description?: string }
    >;
    expect(codeModeInputSchema).toHaveProperty("sessionId");
    expect(codeModeInputSchema.sessionId?.description).toContain(
      "Omit to create a fresh reusable session",
    );
    expect(codeModeInputSchema.sessionId?.description).toContain(
      "Unknown or unavailable session IDs fail before code execution",
    );

    await session.close();
    await engine.close();
  });

  it("exposes only ready Code Mode Caplets and rejects hidden handle references", async () => {
    const ready = {
      name: "Ready",
      description: "Ready HTTP Caplet.",
      exposure: "code_mode",
      baseUrl: "http://127.0.0.1:1",
      auth: { type: "none" },
      actions: { ping: { method: "GET", path: "/ping" } },
    };
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        ready,
        disabled: { ...ready, name: "Disabled", disabled: true },
        setup: {
          ...ready,
          name: "Setup",
          setup: { commands: [{ label: "Install", command: "install-setup" }] },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();
    const callback = server.callbacks.get("code_mode");
    const execute = vi.spyOn(engine, "execute");

    const listed = await callback?.({ code: "return Object.keys(caplets);" });
    const disabled = await callback?.({ code: "return caplets.disabled.inspect();" });
    const setup = await callback?.({ code: "return caplets.setup.inspect();" });

    expect(listed?.structuredContent).toMatchObject({
      ok: true,
      value: ["ready", "debug"],
    });
    expect(disabled?.structuredContent).toMatchObject({ ok: false });
    expect(setup?.structuredContent).toMatchObject({ ok: false });
    expect(execute).not.toHaveBeenCalled();

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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();
    const callback = server.callbacks.get("code_mode");

    const result = await callback?.({ code: "return { ok: true };" });

    expect(result?.structuredContent).toMatchObject({
      ok: true,
      value: { ok: true },
      meta: {
        sessionId: expect.any(String),
        sessionStatus: "created",
        recoveryRef: expect.stringMatching(/^[a-f0-9]{48}$/u),
      },
    });
    expect(result?.content[0]).toMatchObject({ type: "text" });

    await session.close();
    await engine.close();
  });

  it("reuses issued session ids and rejects unknown session ids", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: { name: "GitHub", description: "GitHub repo operations.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();
    const callback = server.callbacks.get("code_mode");

    const first = await callback?.({ code: "var counter = 1;\nreturn counter;" });
    const sessionId = first?.structuredContent?.meta.sessionId as string;
    const reused = await callback?.({
      code: "counter += 1;\nreturn counter;",
      sessionId,
    });
    const missing = await callback?.({ code: "return { ok: true };", sessionId: "session-123" });

    expect(reused?.structuredContent).toMatchObject({
      ok: true,
      value: 2,
      meta: {
        sessionId,
        sessionStatus: "reused",
        recoveryRef: null,
      },
    });
    expect(missing?.structuredContent).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
      meta: { sessionId: "session-123", sessionStatus: null },
    });

    await session.close();
    await engine.close();
  });

  it("returns invalid-request envelopes with session metadata scaffolding", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: { name: "GitHub", description: "GitHub repo operations.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();
    const callback = server.callbacks.get("code_mode");

    const result = await callback?.({ timeoutMs: 1000 });
    const meta = result?.structuredContent?.meta as Record<string, unknown>;

    expect(result?.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Code Mode run input is invalid.",
      },
      meta: {
        sessionId: null,
        sessionStatus: null,
        recoveryRef: null,
      },
    });
    expect(Object.prototype.hasOwnProperty.call(meta, "sessionId")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(meta, "sessionStatus")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(meta, "recoveryRef")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(meta, "recoveryCommand")).toBe(false);
    expect(JSON.parse(result?.content[0].text ?? "{}").meta).toMatchObject({
      sessionId: null,
      sessionStatus: null,
      recoveryRef: null,
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
  const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-mcp-"));
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(configPath, JSON.stringify(progressiveTestConfig(config)));
  return { dir, configPath, projectConfigPath };
}

function progressiveTestConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (record.options) return config;
  return { options: { exposure: "progressive_and_code_mode" }, ...record };
}

function mockServer() {
  const registered = new Map<string, RegisteredTool>();
  const definitions = new Map<string, { description?: string; inputSchema?: unknown }>();
  const callbacks = new Map<string, (request: unknown) => Promise<any>>();
  return {
    registered,
    definitions,
    callbacks,
    registerTool: vi.fn(
      (name: string, definition: { description?: string; inputSchema?: unknown }, callback) => {
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
      },
    ),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}
