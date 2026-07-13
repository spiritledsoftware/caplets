import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNativeCapletsService,
  nativeCapletPromptGuidance,
  nativeCapletToolName,
  nativeCapletsSystemGuidance,
  type NativeCapletsService,
} from "../src/native";
import { CapletsEngine, type ResolvedExposureProjection } from "../src/engine";
import { recordTelemetryNoticeShown } from "../src/telemetry";
import { FileVaultStore } from "../src/vault";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

describe("native Caplets service", () => {
  const dirs: string[] = [];
  const originalMode = process.env.CAPLETS_MODE;
  const originalStateHome = process.env.XDG_STATE_HOME;

  beforeEach(() => {
    process.env.CAPLETS_MODE = "local";
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.CAPLETS_MODE;
    } else {
      process.env.CAPLETS_MODE = originalMode;
    }
    if (originalStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHome;
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
    expect(service.listTools()).toEqual([]);
    await waitForInitialProjection(service);

    try {
      const tools = service.listTools();
      expect(tools).toEqual(
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
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                sessionId: expect.objectContaining({ type: "string" }),
              }),
            }),
          }),
        ]),
      );
      const codeModeTool = tools.find((tool) => tool.caplet === "code_mode");
      expect(codeModeTool?.description).toContain("`meta.sessionId`");
      expect(codeModeTool?.description).toContain("fails before executing your code");
      expect(codeModeTool?.promptGuidance).toEqual(
        expect.arrayContaining([
          expect.stringContaining("omit sessionId to start fresh"),
          expect.stringContaining("returned meta.sessionId"),
          expect.stringContaining("meta.recoveryRef"),
        ]),
      );
      expect(
        (
          codeModeTool?.inputSchema as {
            properties?: { sessionId?: { description?: string } };
          }
        )?.properties?.sessionId?.description,
      ).toContain("Omit to create a fresh reusable session");
      expect(nativeCapletsSystemGuidance(["caplets__code_mode"])).toContain(
        "omit sessionId to start fresh",
      );
      const githubTool = tools.find((tool) => tool.caplet === "git-hub");
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
    await waitForInitialProjection(service);

    try {
      const result = await service.execute("alpha", { operation: "inspect" });

      expect(JSON.stringify(result)).toContain("Alpha");
      expect(JSON.stringify(result)).not.toContain("super-secret");
    } finally {
      await service.close();
    }
  });

  it("executes accepted projection routes without rebuilding native tools", async () => {
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
    await waitForInitialProjection(service);

    try {
      const listTools = vi.spyOn(service, "listTools");
      await expect(service.execute("alpha", { operation: "inspect" })).resolves.toBeDefined();
      await expect(service.execute("alpha", { operation: "inspect" })).resolves.toBeDefined();

      expect(listTools).not.toHaveBeenCalled();

      await service.reload();
      listTools.mockClear();
      await expect(service.execute("alpha", { operation: "inspect" })).resolves.toBeDefined();

      expect(listTools).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("uses daemon mode as a credential-free loopback remote client", async () => {
    const remoteOptions: unknown[] = [];
    const service = createNativeCapletsService({
      mode: "daemon",
      daemon: { url: "http://127.0.0.1:5387/caplets" },
      remoteClientFactory: (options) => {
        remoteOptions.push(options);
        return {
          listTools: async () => [],
          callTool: async () => ({ ok: true }),
          onToolsChanged: () => () => {},
          close: async () => {},
        };
      },
    });

    try {
      await expect(service.reload()).resolves.toBe(true);
      expect(remoteOptions[0]).toMatchObject({
        url: new URL("http://127.0.0.1:5387/caplets/v1/attach"),
        auth: { enabled: false, user: "caplets" },
      });
    } finally {
      await service.close();
    }
  });

  it("suppresses native-first telemetry until a visible notice has been recorded", async () => {
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
    const capture = vi.fn();
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      telemetryStateDir: join(dir, "state"),
      telemetryEnv: {},
      telemetryDispatcher: { capture, shutdown: vi.fn() },
    });
    await waitForInitialProjection(service);

    try {
      await service.execute("alpha", { operation: "inspect" });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("captures native tool telemetry after prior visible notice", async () => {
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
    const stateDir = join(dir, "state");
    recordTelemetryNoticeShown({ stateDir, surface: "cli" });
    const capture = vi.fn();
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      telemetryStateDir: stateDir,
      telemetryEnv: {},
      telemetryDispatcher: { capture, shutdown: vi.fn() },
    });
    await waitForInitialProjection(service);

    try {
      await service.execute("alpha", { operation: "inspect" });
      await expect.poll(() => capture.mock.calls.length).toBe(1);
      expect(capture.mock.calls[0]?.[1]).toMatchObject({
        provider: "posthog",
        name: "caplets_tool_activation",
        properties: expect.objectContaining({
          surface: "native",
          command_family: "native",
          operation_family: "inspect",
          outcome: "success",
          integration: "native",
        }),
      });
    } finally {
      await service.close();
    }
  });

  it("quarantines Vault-backed Caplets until the configured access grant exists", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: {
          name: "GitHub",
          description: "Inspect GitHub repository work.",
          command: process.execPath,
          env: { GH_TOKEN: "$vault:GH_TOKEN" },
        },
      },
    });
    dirs.push(dir);
    process.env.XDG_STATE_HOME = join(dir, "state");

    const ungranted = createNativeCapletsService({ configPath, projectConfigPath });
    await waitForInitialProjection(ungranted);
    try {
      expect(ungranted.listTools().map((tool) => tool.caplet)).not.toContain("github");
      expect(ungranted.listTools().map((tool) => tool.caplet)).not.toContain("code_mode");
    } finally {
      await ungranted.close();
    }

    const store = new FileVaultStore();
    store.set("GH_TOKEN", "resolved_vault_secret");
    store.grantAccess({
      storedKey: "GH_TOKEN",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin: { kind: "global-config", path: configPath },
    });

    const granted = createNativeCapletsService({ configPath, projectConfigPath });
    await waitForInitialProjection(granted);
    try {
      expect(granted.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caplet: "github",
            toolName: "caplets__github",
          }),
          expect.objectContaining({ caplet: "code_mode" }),
        ]),
      );
    } finally {
      await granted.close();
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
          useWhen: "Use when the service health is needed.",
          avoidWhen: "Avoid for mutation requests.",
          shadowing: "namespace",
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
    await waitForInitialProjection(service);

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
          useWhen: "Use when the service health is needed.",
          avoidWhen: "Avoid for mutation requests.",
          shadowing: "namespace",
        }),
      ]);
    } finally {
      await service.close();
    }
  });

  it("omits native completion when direct MCP does not advertise that capability", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        docs: {
          name: "Docs",
          description: "MCP prompts and resources without completion.",
          exposure: "direct",
          command: process.execPath,
          args: ["--import", tsxImport, join(fixturesDir, "stdio-server.ts"), "--no-completions"],
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });
    await waitForInitialProjection(service);

    try {
      expect(service.listTools().map((tool) => tool.caplet)).toEqual(
        expect.arrayContaining(["docs__list_prompts", "docs__get_prompt"]),
      );
      expect(service.listTools().map((tool) => tool.caplet)).not.toContain("docs__complete");
    } finally {
      await service.close();
    }
  });

  it("returns local HTTP artifacts with an absolute managed path in the native service", async () => {
    const http = await startPdfServer();
    let artifactCallDir: string | undefined;
    try {
      const { dir, configPath, projectConfigPath } = tempConfig({
        httpApis: {
          status: {
            name: "Status HTTP",
            description: "Download a local report.",
            exposure: "direct",
            baseUrl: http.baseUrl,
            auth: { type: "none" },
            actions: { download: { method: "GET", path: "/report" } },
          },
        },
      });
      dirs.push(dir);
      const service = createNativeCapletsService({ configPath, projectConfigPath });
      await waitForInitialProjection(service);

      try {
        expect(service.listTools()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              caplet: "status__download",
              toolName: "caplets__status__download",
            }),
          ]),
        );
        const result = await service.execute("status__download", {});
        const path = localArtifactPath(result);
        artifactCallDir = dirname(path);

        expect(isAbsolute(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("%PDF-1.7 native");
        expect(result).toMatchObject({
          structuredContent: {
            kind: "local-artifact",
            path,
            mimeType: "application/pdf",
            byteLength: 15,
          },
        });
      } finally {
        await service.close();
      }
    } finally {
      if (artifactCallDir) {
        rmSync(artifactCallDir, { recursive: true, force: true });
      }
      await http.close();
    }
  });

  it("lists and executes local project-bound CLI tools when native project context is supplied", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      cliTools: {
        workspace: {
          name: "Workspace",
          description: "Inspect the bound workspace.",
          projectBinding: { required: true },
          actions: {
            cwd: {
              command: process.execPath,
              args: ["-e", "console.log(JSON.stringify({ cwd: process.cwd() }))"],
              output: { type: "json" },
            },
          },
        },
      },
    });
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
      projectRoot,
    });
    await waitForInitialProjection(service);

    try {
      expect(service.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caplet: "workspace",
            toolName: "caplets__workspace",
          }),
        ]),
      );
      await expect(
        service.execute("workspace", { operation: "call_tool", name: "cwd", args: {} }),
      ).resolves.toMatchObject({
        structuredContent: { json: { cwd: projectRoot } },
      });
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
            "fixture__complete",
          ]),
        );
      expect(
        service.listTools().find((tool) => tool.caplet === "fixture__complete")?.inputSchema,
      ).toMatchObject({
        properties: {
          context: {
            properties: {
              arguments: { additionalProperties: { type: "string" } },
            },
          },
        },
      });

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
      await expect(
        service.execute("fixture__complete", {
          ref: { type: "resourceTemplate", uri: "repo://{owner}/{name}{?region}" },
          argument: { name: "name", value: "co" },
          context: { arguments: { owner: "caplets", region: "eu" } },
        }),
      ).resolves.toMatchObject({
        completion: { values: ["core"] },
      });
    } finally {
      await service.close();
    }
  });

  it("discovers direct Google Discovery tools for native integrations", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          exposure: "direct",
          discoveryPath: join(fixturesDir, "google-discovery/drive.discovery.json"),
          baseUrl: "http://127.0.0.1:1/drive/v3/",
          auth: { type: "none" },
          includeOperations: ["drive.files.list"],
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });

    try {
      await expect(service.reload()).resolves.toBe(true);
      expect(service.listTools()).toEqual([
        expect.objectContaining({
          caplet: "drive__drive.files.list",
          toolName: "caplets__drive__drive.files.list",
          title: "drive.files.list",
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({ query: expect.any(Object) }),
          }),
          annotations: { readOnlyHint: true, destructiveHint: false },
        }),
      ]);
      await expect(
        service.execute("drive__drive.files.list", { query: { pageSize: 1 } }),
      ).resolves.toMatchObject({
        isError: true,
      });
    } finally {
      await service.close();
    }
  });

  it("notifies native tool listeners after cold-start direct Google Discovery refresh", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files.",
          exposure: "direct",
          discoveryPath: join(fixturesDir, "google-discovery/drive.discovery.json"),
          baseUrl: "http://127.0.0.1:1/drive/v3/",
          auth: { type: "none" },
          includeOperations: ["drive.files.list"],
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
      await expect
        .poll(() => events.at(-1), { timeout: 5_000 })
        .toEqual(["drive__drive.files.list"]);
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
    await waitForInitialProjection(service);

    try {
      expect(service.listTools().map((tool) => tool.toolName)).toEqual(["caplets__code_mode"]);
    } finally {
      await service.close();
    }
  });

  it("removes Code Mode identities after refreshed discovery fails", async () => {
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
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });
    await waitForInitialProjection(service);
    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["code_mode"]);
    const events: string[][] = [];
    service.onToolsChanged((tools) => events.push(tools.map((tool) => tool.caplet)));

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              broken: {
                name: "Broken MCP",
                description: "Unavailable MCP.",
                exposure: "direct_and_code_mode",
                command: join(dir, "missing-command"),
              },
            },
          }),
        ),
      );
      await expect(service.reload()).resolves.toBe(true);

      expect(service.listTools()).toEqual([]);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.every((tools) => tools.length === 0)).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("fails native execution closed until the current projection resolves and after refreshed discovery fails", async () => {
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
    const initialProjection = Promise.withResolvers<ResolvedExposureProjection>();
    const originalExposureProjection = CapletsEngine.prototype.exposureProjection;
    let projectionCalls = 0;
    const exposureProjection = vi
      .spyOn(CapletsEngine.prototype, "exposureProjection")
      .mockImplementation(async (): Promise<ResolvedExposureProjection> => {
        if (projectionCalls++ === 0) return await initialProjection.promise;
        throw new Error("refreshed discovery failed");
      });
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });
    const createdEngine = exposureProjection.mock.instances[0] as CapletsEngine | undefined;
    if (!createdEngine) throw new Error("expected native service to begin projection discovery");
    const execute = vi.spyOn(createdEngine, "execute");

    try {
      await expect(service.execute("alpha", { operation: "inspect" })).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
      await expect(
        service.execute("code_mode", { code: "return await caplets.alpha.inspect();" }),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      expect(execute).not.toHaveBeenCalled();

      const initialReady = waitForInitialProjection(service);
      initialProjection.resolve(
        await originalExposureProjection.call(createdEngine, {
          discoverNonDirectMcpSurfaces: false,
        }),
      );
      await initialReady;
      expect(configuredCapletIds(service.listTools())).toEqual(["alpha"]);

      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              alpha: {
                name: "Alpha",
                description: "Search alpha project documents after reload.",
                command: process.execPath,
              },
            },
          }),
        ),
      );

      await expect(service.reload()).resolves.toBe(true);
      expect(service.listTools()).toEqual([]);
      await expect(service.execute("alpha", { operation: "inspect" })).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
      await expect(
        service.execute("code_mode", { code: "return await caplets.alpha.inspect();" }),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await service.close();
      exposureProjection.mockRestore();
    }
  });

  it("keeps native projections latest-wins across overlapping refreshes", async () => {
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
    const initialProjection = Promise.withResolvers<ResolvedExposureProjection>();
    const olderProjection = Promise.withResolvers<ResolvedExposureProjection>();
    const newerProjection = Promise.withResolvers<ResolvedExposureProjection>();
    const originalExposureProjection = CapletsEngine.prototype.exposureProjection;
    let projectionCalls = 0;
    const exposureProjection = vi
      .spyOn(CapletsEngine.prototype, "exposureProjection")
      .mockImplementation(async (): Promise<ResolvedExposureProjection> => {
        switch (projectionCalls++) {
          case 0:
            return await initialProjection.promise;
          case 1:
            return await olderProjection.promise;
          case 2:
            return await newerProjection.promise;
          default:
            throw new Error("unexpected projection refresh");
        }
      });
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });
    const createdEngine = exposureProjection.mock.instances[0] as CapletsEngine | undefined;
    if (!createdEngine) throw new Error("expected native service to begin projection discovery");

    try {
      const initialReady = waitForInitialProjection(service);
      initialProjection.resolve(
        await originalExposureProjection.call(createdEngine, {
          discoverNonDirectMcpSurfaces: false,
        }),
      );
      await initialReady;
      const events: string[][] = [];
      service.onToolsChanged((tools) => events.push(configuredCapletIds(tools)));

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
      const olderReload = service.reload();
      await expect.poll(() => projectionCalls).toBe(2);
      const olderResolved = await originalExposureProjection.call(createdEngine, {
        discoverNonDirectMcpSurfaces: false,
      });

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
      const newerReload = service.reload();
      await expect.poll(() => projectionCalls).toBe(3);
      newerProjection.resolve(
        await originalExposureProjection.call(createdEngine, {
          discoverNonDirectMcpSurfaces: false,
        }),
      );
      await expect(newerReload).resolves.toBe(true);

      olderProjection.resolve({
        ...olderResolved,
        generation: createdEngine.currentExposureGeneration(),
      });
      await expect(olderReload).resolves.toBe(true);

      expect(configuredCapletIds(service.listTools())).toEqual(["gamma"]);
      expect(events).toEqual([["gamma"]]);
      const execute = vi.spyOn(createdEngine, "execute").mockResolvedValue({ ok: true });
      await expect(service.execute("gamma", { operation: "inspect" })).resolves.toEqual({
        ok: true,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith("gamma", { operation: "inspect" });
    } finally {
      await service.close();
      exposureProjection.mockRestore();
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
    await waitForInitialProjection(service);

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
        meta: {
          sessionId: expect.any(String),
          sessionStatus: "created",
          recoveryRef: expect.stringMatching(/^[a-f0-9]{48}$/u),
        },
      });
      await expect(
        service.execute("code_mode", {
          code: "return { ok: true };",
          sessionId: "session-123",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "session-123",
          sessionStatus: null,
          recoveryRef: null,
        },
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
    await waitForInitialProjection(service);

    try {
      await expect(service.execute("code_mode", { timeoutMs: 1_000 })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "REQUEST_INVALID",
          message: "Code Mode run input is invalid.",
        },
        diagnostics: [],
      });
      const result = (await service.execute("code_mode", { timeoutMs: 1_000 })) as {
        meta: Record<string, unknown>;
      };
      expect(result.meta).toMatchObject({
        sessionId: null,
        sessionStatus: null,
        recoveryRef: null,
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
    await waitForInitialProjection(service);

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
    await waitForInitialProjection(service);

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
    await waitForInitialProjection(service);

    try {
      expect(service.listTools().map((tool) => tool.caplet)).toEqual(["code_mode"]);
    } finally {
      await service.close();
    }
  });

  it("does not notify native tools when only a Caplet README changes", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const capletDir = join(dir, "user", "status");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, nativeReadmeCaplet("Initial operator notes."));
    const service = createNativeCapletsService({ configPath, projectConfigPath, watch: false });
    await waitForInitialProjection(service);
    const before = service.listTools();
    const events: string[][] = [];
    service.onToolsChanged((tools) => events.push(configuredCapletIds(tools)));

    try {
      writeFileSync(capletPath, nativeReadmeCaplet("Updated troubleshooting notes."));

      await expect(service.reload()).resolves.toBe(true);
      expect(service.listTools()).toEqual(before);
      expect(events).toEqual([]);
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
    await waitForInitialProjection(service);
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
    await waitForInitialProjection(service);
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
    await waitForInitialProjection(service);
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
    await waitForInitialProjection(service);
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

function nativeReadmeCaplet(readme: string): string {
  return [
    "---",
    "name: Status",
    "description: Read service status.",
    "httpApi:",
    "  baseUrl: http://127.0.0.1:1",
    "  auth: { type: none }",
    "  actions:",
    "    check: { method: GET, path: /check }",
    "---",
    readme,
    "",
  ].join("\n");
}

async function waitForInitialProjection(service: NativeCapletsService): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = service.onToolsChanged(() => {
      unsubscribe();
      resolve();
    });
  });
}

async function startPdfServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/pdf");
    response.end(Buffer.from("%PDF-1.7 native"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("native HTTP test server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function localArtifactPath(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "structuredContent" in result &&
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    "kind" in result.structuredContent &&
    result.structuredContent.kind === "local-artifact" &&
    "path" in result.structuredContent &&
    typeof result.structuredContent.path === "string"
  ) {
    return result.structuredContent.path;
  }
  throw new Error("expected a local artifact result");
}

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
