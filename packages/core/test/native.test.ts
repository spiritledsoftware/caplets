import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNativeCapletsService,
  nativeCapletPromptGuidance,
  nativeCapletToolName,
  nativeCapletsSystemGuidance,
} from "../src/native";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

describe("native Caplets service", () => {
  const dirs: string[] = [];
  const originalMode = process.env.CAPLETS_MODE;

  beforeEach(() => {
    process.env.CAPLETS_MODE = "local";
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.CAPLETS_MODE;
    } else {
      process.env.CAPLETS_MODE = originalMode;
    }
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
      expect(service.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caplet: "git-hub",
            toolName: "caplets__git-hub",
            title: "GitHub",
          }),
          expect.objectContaining({
            caplet: "code_mode",
            toolName: "caplets__code_mode",
            title: "Code Mode",
          }),
        ]),
      );
      const githubTool = service.listTools().find((tool) => tool.caplet === "git-hub");
      expect(githubTool?.description).toContain("Native tool name: caplets__git-hub");
      expect(githubTool?.inputSchema).toMatchObject({
        properties: expect.objectContaining({ fields: expect.anything() }),
      });
    } finally {
      await service.close();
    }
  });

  it("executes inspect through the shared operation handler", async () => {
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
      const result = await service.execute("alpha", { operation: "inspect" });

      expect(JSON.stringify(result)).toContain("Alpha");
      expect(JSON.stringify(result)).not.toContain("super-secret");
    } finally {
      await service.close();
    }
  });

  it("lists direct native operation tools with the caplets double-underscore prefix", async () => {
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
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      expect(service.listTools()).toEqual([
        expect.objectContaining({
          caplet: "status__ping",
          toolName: "caplets__status__ping",
          title: "ping",
          description: "Ping the service.",
          inputSchema: {
            type: "object",
            properties: { verbose: { type: "boolean" } },
          },
        }),
      ]);
    } finally {
      await service.close();
    }
  });

  it("discovers direct MCP tools for native integrations during reload", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        fixture: {
          name: "Fixture MCP",
          description: "Expose fixture MCP directly.",
          exposure: "direct",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });

    try {
      await expect(service.reload()).resolves.toBe(true);
      expect(service.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caplet: "fixture__echo",
            toolName: "caplets__fixture__echo",
            title: "echo",
            description: "Echo a message.",
            inputSchema: expect.objectContaining({ type: "object" }),
            outputSchema: expect.objectContaining({ type: "object" }),
          }),
          expect.objectContaining({
            caplet: "fixture__list_resources",
            toolName: "caplets__fixture__list_resources",
          }),
          expect.objectContaining({
            caplet: "fixture__get_prompt",
            toolName: "caplets__fixture__get_prompt",
          }),
        ]),
      );

      await expect(service.execute("fixture__echo", { message: "hello" })).resolves.toMatchObject({
        structuredContent: { message: "hello" },
        _meta: {
          caplets: expect.objectContaining({
            capletId: "fixture",
            operation: "echo",
            exposure: "direct",
          }),
        },
      });
    } finally {
      await service.close();
    }
  });

  it("discovers direct MCP tools for native integrations on cold start", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        fixture: {
          name: "Fixture MCP",
          description: "Expose fixture MCP directly.",
          exposure: "direct",
          command: process.execPath,
          args: ["--import", tsxImport, fixture],
          toolCacheTtlMs: 30_000,
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });

    try {
      await expect
        .poll(() => configuredCapletIds(service.listTools()), { timeout: 5_000 })
        .toEqual(
          expect.arrayContaining([
            "fixture__echo",
            "fixture__list_resources",
            "fixture__get_prompt",
          ]),
        );

      await expect(service.execute("fixture__echo", { message: "cold" })).resolves.toMatchObject({
        structuredContent: { message: "cold" },
        _meta: {
          caplets: expect.objectContaining({
            capletId: "fixture",
            operation: "echo",
            exposure: "direct",
          }),
        },
      });
    } finally {
      await service.close();
    }
  });

  it("lists Code Mode only when exposure includes Code Mode", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Call status over HTTP.",
          exposure: "code_mode",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      expect(service.listTools().map((tool) => tool.toolName)).toEqual(["caplets__code_mode"]);
    } finally {
      await service.close();
    }
  });

  it("provides code-only Caplets as handles inside Code Mode", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Call status over HTTP.",
          exposure: "code_mode",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      const result = await service.execute("code_mode", {
        code: `
          const card = await caplets.status.inspect();
          return { id: caplets.status.id, hasStatus: JSON.stringify(card).includes("Status HTTP") };
        `,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { id: "status", hasStatus: true },
      });
    } finally {
      await service.close();
    }
  });

  it("returns structured errors for invalid Code Mode payloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Call status over HTTP.",
          exposure: "code_mode",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath });

    try {
      await expect(service.execute("code_mode", { timeoutMs: 1_000 })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "REQUEST_INVALID",
          message: "Code Mode run input is invalid.",
        },
        diagnostics: [],
      });
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
      const result = await service.execute("missing", { operation: "inspect" });

      expect(JSON.stringify(result)).toContain("server not found: missing");
    } finally {
      await service.close();
    }
  });

  it("builds shared native system guidance", () => {
    expect(nativeCapletToolName("linear-api_v2")).toBe("caplets__linear-api_v2");
    const guidance = nativeCapletsSystemGuidance(["caplets__linear-api_v2"]);

    expect(guidance).toContain("caplets__linear-api_v2");
    expect(guidance).toContain("Flow: inspect when the domain is unfamiliar");
    expect(guidance).toContain("callTemplate");
    expect(guidance).toContain("reserve describe_tool");
    expect(guidance).toContain("Do not guess downstream tool names");
    expect(guidance).toContain("Do not infer input/output schemas");
    expect(guidance).toContain("avoid broad provider searches");
    expect(guidance).toContain("follow its fieldSelection hint");
  });

  it("builds concise per-Caplet prompt guidance with safe discovery", () => {
    const guidance = nativeCapletPromptGuidance("caplets__browser", {
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

    expect(guidance).toContain("Use caplets__browser for the Browser Caplet capability domain.");
    expect(guidance).toContain("Use tools/search_tools callTemplate/arg hints for simple calls");
    expect(guidance).toContain("call_tool.args must match inputSchema exactly");
    expect(guidance).toContain("Do not guess tool names or schemas");
    expect(guidance).not.toContain("For unfamiliar tasks, discover safely");
    expect(guidance).not.toContain("Call caplets__browser with operation inspect before");
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
      expect(configuredCapletIds(service.listTools())).toEqual(["alpha"]);
      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              beta: {
                name: "Beta",
                description: "Search beta project documents.",
                command: process.execPath,
              },
            },
          }),
        ),
      );

      await expect(service.reload()).resolves.toBe(true);
      expect(configuredCapletIds(service.listTools())).toEqual(["beta"]);
    } finally {
      await service.close();
    }
  });

  it("defaults native exposure to Code Mode without progressive wrappers", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig(
      {
        mcpServers: {
          alpha: {
            name: "Alpha",
            description: "Search alpha project documents.",
            command: process.execPath,
          },
        },
      },
      { preserveExposureDefault: true },
    );
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });

    try {
      expect(service.listTools().map((tool) => tool.caplet)).toEqual(["code_mode"]);
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
      events.push(configuredCapletIds(tools));
    });

    try {
      writeFileSync(configPath, "{ invalid json");
      await expect(service.reload()).resolves.toBe(false);
      expect(events).toEqual([]);
      expect(errors.join("")).toContain("Caplets config reload failed");

      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              gamma: {
                name: "Gamma",
                description: "Search gamma project documents.",
                command: process.execPath,
              },
            },
          }),
        ),
      );
      await expect(service.reload()).resolves.toBe(true);
      expect(events).toEqual([["gamma"]]);

      unsubscribe();
      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              delta: {
                name: "Delta",
                description: "Search delta project documents.",
                command: process.execPath,
              },
            },
          }),
        ),
      );
      await expect(service.reload()).resolves.toBe(true);
      expect(events).toEqual([["gamma"]]);
    } finally {
      await service.close();
    }
  });

  it("notifies native tool listeners after refreshing direct MCP exposure", async () => {
    const fixture = join(fixturesDir, "stdio-server.ts");
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
    const events: string[][] = [];
    service.onToolsChanged((tools) => {
      events.push(configuredCapletIds(tools));
    });

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            fixture: {
              name: "Fixture MCP",
              description: "Expose fixture MCP directly.",
              exposure: "direct",
              command: process.execPath,
              args: ["--import", tsxImport, fixture],
              toolCacheTtlMs: 30_000,
            },
          },
        }),
      );

      await expect(service.reload()).resolves.toBe(true);
      expect(events).toEqual([
        expect.arrayContaining(["fixture__echo", "fixture__list_resources", "fixture__get_prompt"]),
      ]);
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
      events.push(configuredCapletIds(tools));
    });

    try {
      await watcherReady();
      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              beta: {
                name: "Beta",
                description: "Search beta project documents.",
                command: process.execPath,
              },
            },
          }),
        ),
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
      events.push(configuredCapletIds(tools));
    });

    try {
      await watcherReady();
      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              beta: {
                name: "Beta",
                description: "Search beta project documents.",
                command: process.execPath,
              },
            },
          }),
        ),
      );

      await expect.poll(() => events.at(-1)).toEqual(["beta"]);
    } finally {
      await service.close();
    }
  });

  function tempConfig(
    config: unknown,
    options: { preserveExposureDefault?: boolean } = {},
  ): {
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
    writeFileSync(
      configPath,
      JSON.stringify(options.preserveExposureDefault ? config : progressiveTestConfig(config)),
    );
    return { dir, configPath, projectConfigPath };
  }
});

function progressiveTestConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (record.options) return config;
  return { options: { exposure: "progressive_and_code_mode" }, ...record };
}

async function watcherReady(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function configuredCapletIds(tools: Array<{ caplet: string }>): string[] {
  return tools.map((tool) => tool.caplet).filter((caplet) => caplet !== "code_mode");
}
