import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import { nativeCapletToolName } from "../src/native.js";
import { CapletsRuntime } from "../src/runtime.js";

describe("CapletsRuntime", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers initial enabled Caplets only", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: "node",
          disabled: true,
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server });

    expect(runtime.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registerTool).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it("keeps MCP tool names raw while native names are prefixed", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        "git-hub": {
          name: "GitHub",
          description: "Inspect GitHub repository work.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server });

    try {
      expect(runtime.registeredToolIds()).toEqual(["git-hub"]);
      expect(nativeCapletToolName("git-hub")).toBe("caplets_git_hub");
    } finally {
      await runtime.close();
    }
  });

  it("registers HTTP API Caplets", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Check internal service status through HTTP.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server });

    expect(runtime.registeredToolIds()).toEqual(["status"]);
    expect(server.registerTool).toHaveBeenCalledWith(
      "status",
      expect.objectContaining({ title: "Status HTTP" }),
      expect.any(Function),
    );

    await runtime.close();
  });

  it("registers CLI tools Caplets", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      cliTools: {
        repo: {
          name: "Repo CLI",
          description: "Run curated repository CLI workflows.",
          actions: {
            status: {
              command: process.execPath,
              args: ["--version"],
            },
          },
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server });

    expect(runtime.registeredToolIds()).toEqual(["repo"]);
    expect(server.registerTool).toHaveBeenCalledWith(
      "repo",
      expect.objectContaining({ title: "Repo CLI" }),
      expect.any(Function),
    );

    await runtime.close();
  });

  it("adds, updates, and removes tools across successful reloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server });
    const alpha = server.registered.get("alpha")!;

    writeConfig(configPath, {
      mcpServers: {
        alpha: {
          name: "Alpha Updated",
          description: "Search updated alpha project documents.",
          command: "node",
        },
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: "node",
        },
      },
    });
    await runtime.reload();

    expect(runtime.registeredToolIds()).toEqual(["alpha", "gamma"]);
    expect(alpha.update).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Alpha Updated",
        description: expect.stringContaining("Search updated alpha project documents."),
      }),
    );
    expect(server.registered.get("gamma")).toBeDefined();

    writeConfig(configPath, {
      httpApis: {
        gamma: {
          name: "Gamma HTTP",
          description: "Search gamma project documents over HTTP.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { search: { method: "GET", path: "/search" } },
        },
      },
    });
    await runtime.reload();

    expect(alpha.remove).toHaveBeenCalledTimes(1);
    expect(runtime.registeredToolIds()).toEqual(["gamma"]);

    await runtime.close();
  });

  it("keeps the last known-good tools when reload validation fails", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const errors: string[] = [];
    const runtime = new CapletsRuntime({
      configPath,
      projectConfigPath,
      server,
      writeErr: (value) => errors.push(value),
    });

    writeFileSync(configPath, "{not json");
    const reloaded = await runtime.reload();

    expect(runtime.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registered.get("alpha")?.remove).not.toHaveBeenCalled();
    expect(reloaded).toBe(false);
    expect(errors.join("")).toContain("keeping last known-good config");

    await runtime.close();
  });

  it("reconciles tools when backend invalidation fails", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const server = mockServer();
    const errors: string[] = [];
    const runtime = new CapletsRuntime({
      configPath,
      projectConfigPath,
      server,
      writeErr: (value) => errors.push(value),
    });
    const alpha = server.registered.get("alpha")!;
    (
      runtime as unknown as {
        invalidateChangedBackends: () => Promise<void>;
      }
    ).invalidateChangedBackends = vi.fn(async () => {
      throw new Error("close failed");
    });

    writeConfig(configPath, {
      mcpServers: {
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: "node",
        },
      },
    });
    const reloaded = await runtime.reload();

    expect(reloaded).toBe(false);
    expect(alpha.remove).toHaveBeenCalledTimes(1);
    expect(runtime.registeredToolIds()).toEqual(["gamma"]);
    expect(server.registered.get("gamma")).toBeDefined();
    expect(errors.join("")).toContain("backend invalidation failed");

    await runtime.close();
  });

  it("watches nested Caplet files when the config dir is also the Caplets root", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const nestedFile = join(dir, "user", "nested", "notes.md");
    mkdirSync(join(dir, "user", "nested"), { recursive: true });
    writeFileSync(nestedFile, "before");
    const runtime = new CapletsRuntime({
      configPath,
      projectConfigPath,
      server: mockServer(),
      watchDebounceMs: 10,
    });
    let reloads = 0;
    (runtime as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    writeFileSync(nestedFile, "after");
    await eventually(() => expect(reloads).toBeGreaterThan(0));

    await runtime.close();
  });

  it("watches project Caplet files without explicit trust", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const projectFile = join(dir, "project", ".caplets", "notes.txt");
    writeFileSync(projectFile, "before");
    const runtime = new CapletsRuntime({
      configPath,
      projectConfigPath,
      server: mockServer(),
      watchDebounceMs: 10,
    });
    try {
      let reloads = 0;
      (runtime as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
        reloads += 1;
        return true;
      });

      writeFileSync(projectFile, "after");
      await eventually(() => expect(reloads).toBeGreaterThan(0));
    } finally {
      await runtime.close();
    }
  });

  it("runs a follow-up reload when another reload is requested mid-flight", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const runtime = new CapletsRuntime({ configPath, projectConfigPath, server: mockServer() });
    let calls = 0;

    (runtime as unknown as { reloadOnce: () => Promise<void> }).reloadOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        void runtime.reload();
      }
    });

    await runtime.reload();

    expect(calls).toBe(2);

    await runtime.close();
  });

  function tempConfig(config: unknown): {
    dir: string;
    configPath: string;
    projectConfigPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "caplets-runtime-"));
    const userRoot = join(dir, "user");
    const projectRoot = join(dir, "project", ".caplets");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const configPath = join(userRoot, "config.json");
    const projectConfigPath = join(projectRoot, "config.json");
    writeConfig(configPath, config);
    return { dir, configPath, projectConfigPath };
  }
});

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

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    assertion();
  } catch {
    throw lastError;
  }
}
