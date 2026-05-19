import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCapletsService,
  nativeCapletPromptGuidance,
  nativeCapletToolName,
  nativeCapletsSystemGuidance,
} from "../src/native";

describe("native Caplets service", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists enabled Caplets with prefixed native tool names", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        "git-hub": {
          name: "GitHub",
          description: "Inspect GitHub repository work.",
          command: process.execPath,
        },
        disabled: {
          name: "Disabled",
          description: "Disabled repository workflows.",
          command: process.execPath,
          disabled: true,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      expect(service.listTools()).toEqual([
        expect.objectContaining({
          caplet: "git-hub",
          toolName: "caplets_git_hub",
          title: "GitHub",
        }),
      ]);
      expect(service.listTools()[0]?.description).toContain("Native tool name: caplets_git_hub");
    } finally {
      await service.close();
    }
  });

  it("executes get_caplet through the shared operation handler", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
          env: { SECRET_TOKEN: "super-secret" },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      const result = await service.execute("alpha", { operation: "get_caplet" });

      expect(JSON.stringify(result)).toContain("Alpha");
      expect(JSON.stringify(result)).not.toContain("super-secret");
    } finally {
      await service.close();
    }
  });

  it("returns structured errors for unknown Caplets", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      const result = await service.execute("missing", { operation: "get_caplet" });

      expect(JSON.stringify(result)).toContain("server not found: missing");
    } finally {
      await service.close();
    }
  });

  it("builds shared native system guidance", () => {
    expect(nativeCapletToolName("linear-api_v2")).toBe("caplets_linear_api__v2");
    const guidance = nativeCapletsSystemGuidance(["caplets_linear_api__v2"]);

    expect(guidance).toContain("caplets_linear_api__v2");
    expect(guidance).toContain(
      "Use `get_caplet` when choosing a Caplet for an unfamiliar task or when its capability is unclear.",
    );
    expect(guidance).toContain(
      "Use `get_tool` before `call_tool` when a downstream tool is unfamiliar or its argument or output schema is unclear.",
    );
    expect(guidance).toContain(
      "Schema hashes from `list_tools` can identify matching schemas across Caplets when you already understand that exact hash.",
    );
    expect(guidance).toContain(
      "For `call_tool`, put downstream inputs only inside the top-level `arguments` object.",
    );
    expect(guidance).toContain(
      "Do not invent downstream tool names; execute only exact names returned by `list_tools`, `search_tools`, or `get_tool`.",
    );
  });

  it("builds concise per-Caplet prompt guidance with safe discovery", () => {
    const guidance = nativeCapletPromptGuidance("caplets_browser", {
      name: "Browser",
      description: "Drive a browser.",
      server: "browser",
      backend: "mcp",
      transport: "stdio",
      command: process.execPath,
      startupTimeoutMs: 1_000,
      callTimeoutMs: 1_000,
      toolCacheTtlMs: 1_000,
      disabled: false,
    }).join("\n");

    expect(guidance).toContain("Use caplets_browser for the Browser Caplet capability domain.");
    expect(guidance).toContain(
      "For unfamiliar tasks, discover safely with get_caplet, then search_tools or list_tools, then get_tool when schemas are unclear.",
    );
    expect(guidance).toContain(
      "Call call_tool only with exact downstream tool names and keep downstream inputs inside arguments.",
    );
    expect(guidance).not.toContain("Call caplets_browser with operation get_caplet before");
  });

  it("reloads native tool metadata after config changes", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });

    try {
      expect(service.listTools().map((tool) => tool.caplet)).toEqual(["alpha"]);
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            beta: {
              name: "Beta",
              description: "Search beta project documents.",
              command: process.execPath,
            },
          },
        }),
      );

      await expect(service.reload()).resolves.toBe(true);
      expect(service.listTools()).toEqual([
        expect.objectContaining({ caplet: "beta", toolName: "caplets_beta", title: "Beta" }),
      ]);
    } finally {
      await service.close();
    }
  });

  it("notifies native tool listeners only when config parses successfully", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const errors: string[] = [];
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    const events: string[][] = [];
    const unsubscribe = service.onToolsChanged((tools) => {
      events.push(tools.map((tool) => tool.caplet));
    });

    try {
      writeFileSync(configPath, "{ invalid json");
      await expect(service.reload()).resolves.toBe(false);
      expect(events).toEqual([]);
      expect(errors.join("")).toContain("Caplets config reload failed");

      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            gamma: {
              name: "Gamma",
              description: "Search gamma project documents.",
              command: process.execPath,
            },
          },
        }),
      );
      await expect(service.reload()).resolves.toBe(true);
      expect(events).toEqual([["gamma"]]);

      unsubscribe();
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            delta: {
              name: "Delta",
              description: "Search delta project documents.",
              command: process.execPath,
            },
          },
        }),
      );
      await expect(service.reload()).resolves.toBe(true);
      expect(events).toEqual([["gamma"]]);
    } finally {
      await service.close();
    }
  });

  it("notifies native tool listeners when backend invalidation fails", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const errors: string[] = [];
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    const engine = (service as unknown as { engine: unknown }).engine;
    (engine as { invalidateChangedBackends: () => Promise<void> }).invalidateChangedBackends =
      async () => {
        throw new Error("close failed");
      };
    const events: string[][] = [];
    service.onToolsChanged((tools) => {
      events.push(tools.map((tool) => tool.caplet));
    });

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            beta: {
              name: "Beta",
              description: "Search beta project documents.",
              command: process.execPath,
            },
          },
        }),
      );

      await expect(service.reload()).resolves.toBe(false);
      expect(events).toEqual([["beta"]]);
      expect(errors.join("")).toContain("backend invalidation failed");
    } finally {
      await service.close();
    }
  });

  it("notifies native tool listeners when watched config changes", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      watchDebounceMs: 10,
    });
    const events: string[][] = [];
    service.onToolsChanged((tools) => {
      events.push(tools.map((tool) => tool.caplet));
    });

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            beta: {
              name: "Beta",
              description: "Search beta project documents.",
              command: process.execPath,
            },
          },
        }),
      );

      await expect.poll(() => events).toEqual([["beta"]]);
    } finally {
      await service.close();
    }
  });

  function tempConfig(config: unknown): {
    dir: string;
    configPath: string;
    projectConfigPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-"));
    const userRoot = join(dir, "user");
    const projectRoot = join(dir, "project", ".caplets");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const configPath = join(userRoot, "config.json");
    const projectConfigPath = join(projectRoot, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    return { dir, configPath, projectConfigPath };
  }
});
