import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDeclaredInputReader } from "../src/caplet-source";
import { parseConfig } from "../src/config-runtime";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "../src/control-plane/snapshot";
import { CapletsEngine, createInternalCapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { FileVaultStore } from "../src/vault";

describe("CapletsEngine", () => {
  const dirs: string[] = [];
  const engines: CapletsEngine[] = [];
  const originalStateHome = process.env.XDG_STATE_HOME;

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.close()));
    if (originalStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalStateHome;
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the Vault-aware runtime loader by default", () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: {
          name: "GitHub",
          description: "GitHub access.",
          command: process.execPath,
          env: { GH_TOKEN: "$vault:GH_TOKEN" },
        },
      },
    });
    dirs.push(dir);
    process.env.XDG_STATE_HOME = join(dir, "state");
    const store = new FileVaultStore();
    store.set("GH_TOKEN", "resolved_vault_secret");
    store.grantAccess({
      storedKey: "GH_TOKEN",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin: { kind: "global-config", path: configPath },
    });

    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);

    expect(engine.currentConfig().mcpServers.github?.env).toEqual({
      GH_TOKEN: "resolved_vault_secret",
    });
  });

  it("prints recoverable Vault quarantine warnings during startup", () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: {
          name: "GitHub",
          description: "GitHub access.",
          command: process.execPath,
          env: { GH_TOKEN: "$vault:GH_TOKEN" },
        },
      },
    });
    dirs.push(dir);
    process.env.XDG_STATE_HOME = join(dir, "state");
    const errors: string[] = [];

    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);

    expect(engine.currentConfig().mcpServers.github).toBeUndefined();
    expect(errors.join("")).toContain("Caplet github references");
    expect(errors.join("")).toContain("caplets vault access grant GH_TOKEN github");
    expect(errors.join("")).not.toContain("resolved_vault_secret");
  });

  it("reauthorizes live SQL diagnostics and never returns a cached result after loss", async () => {
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
    const seed = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(seed);
    const snapshot = {
      config: seed.currentConfig(),
      caplets: {},
      authorityGeneration: 1,
      effectiveGeneration: 0,
      securityEpoch: 1,
    } as unknown as ControlPlaneRuntimeSnapshot;
    const loader = {
      initialize: vi.fn(async () => snapshot),
    } as unknown as ControlPlaneRuntimeSnapshotLoader;
    const expected = {
      backend: "postgres" as const,
      store: {
        logicalHostId: "logical-host-u10",
        storeId: "store-u10",
        operationNamespace: "namespace-u10",
      },
      fingerprint: {
        generation: 1,
        currentFingerprint: "a".repeat(64),
      },
      keyCompatibility: {
        status: "compatible" as const,
        activeVersion: 1,
        providerCommitmentPresent: true,
        canaryCommitmentPresent: true,
      },
      readyNodes: 2,
      overdueNodes: 0,
    };
    let diagnosticsAvailable = true;
    const detailedDiagnostics = vi.fn(async (reauthorize: () => Promise<boolean>) => {
      expect(await reauthorize()).toBe(true);
      expect(await reauthorize()).toBe(true);
      if (!diagnosticsAvailable) {
        throw new CapletsError("SERVER_UNAVAILABLE", "Live diagnostics were revoked.");
      }
      return expected;
    });
    const requireLive = vi.fn(async () => undefined);
    const engine = await createInternalCapletsEngine(
      { configPath, projectConfigPath, watch: false },
      loader,
      snapshot,
      undefined,
      undefined,
      undefined,
      requireLive,
      undefined,
      undefined,
      undefined,
      undefined,
      detailedDiagnostics,
    );
    engines.push(engine);
    const reauthorize = vi.fn(async () => true);

    await expect(engine.controlPlaneDetailedDiagnostics(reauthorize)).resolves.toEqual(expected);
    diagnosticsAvailable = false;
    await expect(engine.controlPlaneDetailedDiagnostics(reauthorize)).rejects.toThrow(
      "Live diagnostics were revoked.",
    );

    expect(requireLive).toHaveBeenCalledTimes(2);
    expect(requireLive).toHaveBeenNthCalledWith(1, "admin");
    expect(detailedDiagnostics).toHaveBeenCalledTimes(2);
    expect(reauthorize).toHaveBeenCalledTimes(4);
  });

  it("fails startup when no config sources exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-engine-missing-"));
    dirs.push(dir);

    expect(() =>
      CapletsEngine.unactivatedForTests({
        configPath: join(dir, "missing-user.json"),
        projectConfigPath: join(dir, "project", ".caplets", "config.json"),
        watch: false,
      }),
    ).toThrow("Caplets config not found");
  });

  it("fails startup when config sources define no Caplets", () => {
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);

    expect(() =>
      CapletsEngine.unactivatedForTests({ configPath, projectConfigPath, watch: false }),
    ).toThrow("Caplets config must define at least one");
  });

  it("adds, updates, and removes enabled Caplets across successful reloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
          disabled: true,
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const events: Array<{ previous: string[]; next: string[]; invalidated: boolean }> = [];
    engine.onReload(({ previous, next, invalidated }) => {
      events.push({
        previous: Object.keys(previous.mcpServers).sort(),
        next: Object.keys(next.mcpServers).sort(),
        invalidated,
      });
    });

    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);

    writeConfig(configPath, {
      mcpServers: {
        alpha: {
          name: "Alpha Reloaded",
          description: "Search alpha project documents after reload.",
          command: process.execPath,
        },
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(
      engine
        .enabledServers()
        .map((caplet) => caplet.server)
        .sort(),
    ).toEqual(["alpha", "gamma"]);
    expect(engine.enabledServers().find((caplet) => caplet.server === "alpha")?.name).toBe(
      "Alpha Reloaded",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      previous: ["alpha", "beta"],
      next: ["alpha", "gamma"],
      invalidated: true,
    });

    writeConfig(configPath, {
      mcpServers: {
        gamma: {
          name: "Gamma",
          description: "Search gamma project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["gamma"]);
  });

  it("fails direct tool execution closed before dispatch when live authority is unavailable", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        server_status: {
          name: "Server Status",
          description: "Inspect server status.",
          baseUrl: "https://status.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/status" } },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const internal = engine as unknown as {
      requireActivatedLive: (operation: string) => Promise<unknown>;
      backendRuntime: { operations: { callTool: (...args: unknown[]) => Promise<unknown> } };
    };
    internal.requireActivatedLive = vi.fn(async () => {
      throw new CapletsError("SERVER_UNAVAILABLE", "SQL authority is unavailable.");
    });
    const callTool = vi.spyOn(internal.backendRuntime.operations, "callTool");

    const result = await engine.executeDirectTool("server_status", "check", {});

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "SERVER_UNAVAILABLE" } },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("routes activated reloads through the convergent refresh authority", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        server_status: {
          name: "Server Status",
          description: "Inspect server status.",
          baseUrl: "https://status.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/status" } },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const directReload = vi.fn(async () => {
      throw new Error("direct loader reload should not run");
    });
    const refresh = vi.fn(async () => engine.currentControlPlaneRuntimeSnapshot()!);
    const internal = engine as unknown as {
      runtimeSnapshotLoader: { reload: typeof directReload };
      refreshActivatedControlPlane: typeof refresh;
    };
    internal.runtimeSnapshotLoader = { reload: directReload };
    internal.refreshActivatedControlPlane = refresh;

    await expect(engine.reload()).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledOnce();
    expect(directReload).not.toHaveBeenCalled();
  });

  it("does not expose an unpublished registry to backend managers when invalidation fails", async () => {
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
    const initialConfig = parseConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
        },
      },
    });
    const nextConfig = parseConfig({
      mcpServers: {
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
        },
      },
    });
    const initialSnapshot = {
      config: initialConfig,
      caplets: {},
    } as unknown as ControlPlaneRuntimeSnapshot;
    const nextSnapshot = {
      ...initialSnapshot,
      config: nextConfig,
    } as unknown as ControlPlaneRuntimeSnapshot;
    const loader = {
      initialize: async () => initialSnapshot,
    } as unknown as ControlPlaneRuntimeSnapshotLoader;
    const engine = await createInternalCapletsEngine(
      { configPath, projectConfigPath, watch: false },
      loader,
      initialSnapshot,
    );
    engines.push(engine);
    const internal = engine as unknown as {
      downstream: {
        closeServer: (serverId: string) => Promise<void>;
        updateRegistry: (registry: unknown) => void;
      };
      openapi: { updateRegistry: (registry: unknown) => void };
      googleDiscovery: { updateRegistry: (registry: unknown) => void };
      graphql: { updateRegistry: (registry: unknown) => void };
      http: { updateRegistry: (registry: unknown) => void };
      cli: { updateRegistry: (registry: unknown) => void };
      capletSets: { updateRegistry: (registry: unknown) => void };
    };
    vi.spyOn(internal.downstream, "closeServer").mockRejectedValue(new Error("close failed"));
    const registryUpdates = [
      vi.spyOn(internal.downstream, "updateRegistry"),
      vi.spyOn(internal.openapi, "updateRegistry"),
      vi.spyOn(internal.googleDiscovery, "updateRegistry"),
      vi.spyOn(internal.graphql, "updateRegistry"),
      vi.spyOn(internal.http, "updateRegistry"),
      vi.spyOn(internal.cli, "updateRegistry"),
      vi.spyOn(internal.capletSets, "updateRegistry"),
    ];

    await expect(engine.publishActivatedSnapshot(nextSnapshot)).resolves.toBe(false);

    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);
    for (const update of registryUpdates) expect(update).not.toHaveBeenCalled();
  });

  it("treats a manual README-only reload as a successful lifecycle no-op", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const capletDir = join(dir, "user", "alpha");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, capletMarkdown("Initial operator notes."));
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const internal = engine as unknown as {
      registry: unknown;
      downstream: { updateRegistry: (registry: unknown) => void };
      openapi: { updateRegistry: (registry: unknown) => void };
      googleDiscovery: { updateRegistry: (registry: unknown) => void };
      graphql: { updateRegistry: (registry: unknown) => void };
      http: { updateRegistry: (registry: unknown) => void };
      cli: { updateRegistry: (registry: unknown) => void };
      capletSets: { updateRegistry: (registry: unknown) => void };
    };
    const initialRegistry = internal.registry;
    const initialGeneration = engine.currentExposureGeneration();
    const listener = vi.fn();
    engine.onReload(listener);
    const registryUpdates = [
      vi.spyOn(internal.downstream, "updateRegistry"),
      vi.spyOn(internal.openapi, "updateRegistry"),
      vi.spyOn(internal.googleDiscovery, "updateRegistry"),
      vi.spyOn(internal.graphql, "updateRegistry"),
      vi.spyOn(internal.http, "updateRegistry"),
      vi.spyOn(internal.cli, "updateRegistry"),
      vi.spyOn(internal.capletSets, "updateRegistry"),
    ];

    writeFileSync(capletPath, capletMarkdown("Updated troubleshooting notes."));

    await expect(engine.reload()).resolves.toBe(true);
    expect(internal.registry).toBe(initialRegistry);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration);
    expect(registryUpdates.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    writeFileSync(
      capletPath,
      capletMarkdown("Updated troubleshooting notes.", "Search alpha repositories."),
    );
    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 1);
    expect(registryUpdates.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    writeConfig(configPath, { options: { exposure: "direct" } });
    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 2);
    expect(registryUpdates.every((spy) => spy.mock.calls.length === 2)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("settles a watched README-only edit without emitting a runtime reload", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const capletDir = join(dir, "user", "alpha");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, capletMarkdown("Initial operator notes."));
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watchDebounceMs: 1,
    });
    engines.push(engine);
    const initialGeneration = engine.currentExposureGeneration();
    const listener = vi.fn();
    engine.onReload(listener);
    const scheduled = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<boolean>();
    const originalScheduleReload = engine.scheduleReload.bind(engine);
    vi.spyOn(engine, "scheduleReload").mockImplementation(() => {
      originalScheduleReload();
      scheduled.resolve();
    });
    const internal = engine as unknown as {
      reloadOnce: () => Promise<boolean>;
      resetWatchers: () => void;
    };
    const resetWatchers = vi.spyOn(internal, "resetWatchers");
    const originalReloadOnce = internal.reloadOnce.bind(engine);
    vi.spyOn(internal, "reloadOnce").mockImplementation(async () => {
      const result = await originalReloadOnce();
      settled.resolve(result);
      return result;
    });

    writeFileSync(capletPath, capletMarkdown("Watched troubleshooting notes."));

    await scheduled.promise;
    await expect(settled.promise).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration);
    expect(listener).not.toHaveBeenCalled();
    expect(resetWatchers).not.toHaveBeenCalled();
  });

  it("fans out for declared runtime input changes, deletion, and restoration", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const capletDir = join(dir, "user", "weather");
    const capletPath = join(capletDir, "CAPLET.md");
    const specPath = join(capletDir, "openapi.yaml");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, openapiCapletMarkdown());
    writeFileSync(specPath, "openapi: 3.0.3\ninfo: { title: Weather, version: one }\npaths: {}\n");
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const listener = vi.fn();
    engine.onReload(listener);
    const initialGeneration = engine.currentExposureGeneration();

    writeFileSync(specPath, "openapi: 3.0.3\ninfo: { title: Weather, version: two }\npaths: {}\n");
    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    rmSync(specPath);
    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 2);
    expect(listener).toHaveBeenCalledTimes(2);

    writeFileSync(
      specPath,
      "openapi: 3.0.3\ninfo: { title: Weather, version: three }\npaths: {}\n",
    );
    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 3);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("fans out when a resolved environment value changes under a stable template", async () => {
    const variable = "CAPLETS_U3_RELOAD_TOKEN";
    const original = process.env[variable];
    process.env[variable] = "first-secret";
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
          env: { TOKEN: `$env:${variable}` },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const listener = vi.fn();
    engine.onReload(listener);
    const initialGeneration = engine.currentExposureGeneration();

    try {
      process.env[variable] = "second-secret";

      await expect(engine.reload()).resolves.toBe(true);
      expect(engine.currentConfig().mcpServers.alpha?.env).toEqual({ TOKEN: "second-secret" });
      expect(engine.currentExposureGeneration()).toBe(initialGeneration + 1);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      if (original === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = original;
      }
    }
  });

  it("fans out when a resolved Vault value changes under a stable template", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        github: {
          name: "GitHub",
          description: "GitHub access.",
          command: process.execPath,
          env: { GH_TOKEN: "$vault:GH_TOKEN" },
        },
      },
    });
    dirs.push(dir);
    process.env.XDG_STATE_HOME = join(dir, "state");
    const store = new FileVaultStore();
    store.set("GH_TOKEN", "first-vault-secret");
    store.grantAccess({
      storedKey: "GH_TOKEN",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin: { kind: "global-config", path: configPath },
    });
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    const listener = vi.fn();
    engine.onReload(listener);
    const initialGeneration = engine.currentExposureGeneration();

    store.set("GH_TOKEN", "second-vault-secret", { force: true });

    await expect(engine.reload()).resolves.toBe(true);
    expect(engine.currentConfig().mcpServers.github?.env).toEqual({
      GH_TOKEN: "second-vault-secret",
    });
    expect(engine.currentExposureGeneration()).toBe(initialGeneration + 1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("includes enabled Google Discovery API Caplets", () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Google Drive",
          description: "Access Google Drive files and permissions.",
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          auth: { type: "none" },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);

    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["drive"]);
  });

  it("fails project-bound calls before backend dispatch when session context is missing", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        workspace: {
          name: "Workspace",
          description: "Project workspace action.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          projectBinding: { required: true },
          actions: {
            run: { method: "GET", path: "/run" },
          },
        },
      },
    });
    dirs.push(dir);
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);

    const result = (await engine.execute("workspace", {
      operation: "call_tool",
      name: "run",
      args: {},
    })) as { structuredContent?: { error?: unknown } };

    expect(result.structuredContent?.error).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      details: {
        projectBinding: expect.objectContaining({ reason: "missing_context" }),
      },
    });
  });

  it("requires custom loaders to provide readable declared inputs", () => {
    const config = parseConfig({
      openapiEndpoints: {
        weather: {
          name: "Weather",
          description: "Query weather forecasts.",
          specPath: "weather/openapi.yaml",
          auth: { type: "none" },
        },
      },
    });

    expect(() =>
      CapletsEngine.unactivatedForTests({ watch: false, configLoader: () => config }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));

    const engine = CapletsEngine.unactivatedForTests({
      watch: false,
      configLoader: () => config,
      declaredInputReader: createMemoryDeclaredInputReader({
        "weather/openapi.yaml": "openapi: 3.1.0\ninfo: { title: Weather, version: 1 }\npaths: {}\n",
      }),
    });
    engines.push(engine);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["weather"]);
  });

  it("keeps last known-good config when reload validation fails", async () => {
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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);
    const listener = vi.fn();
    engine.onReload(listener);
    const internal = engine as unknown as {
      registry: unknown;
      stableHostConfigurationFingerprint: string;
      resolvedExecutionFingerprint: string;
    };
    const initialRegistry = internal.registry;
    const initialStableFingerprint = internal.stableHostConfigurationFingerprint;
    const initialResolvedFingerprint = internal.resolvedExecutionFingerprint;

    writeFileSync(configPath, "{ invalid json");

    await expect(engine.reload()).resolves.toBe(false);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);
    expect(listener).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Caplets config reload failed");
    expect(internal.registry).toBe(initialRegistry);
    expect(internal.stableHostConfigurationFingerprint).toBe(initialStableFingerprint);
    expect(internal.resolvedExecutionFingerprint).toBe(initialResolvedFingerprint);
  });

  it("keeps last known-good config when config sources disappear", async () => {
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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);

    rmSync(configPath);

    await expect(engine.reload()).resolves.toBe(false);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);
    expect(errors.join("")).toContain("Caplets config reload failed");
    expect(errors.join("")).toContain("Caplets config not found");
  });

  it("continues notifying reload listeners when one listener throws", async () => {
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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    engines.push(engine);
    const secondListener = vi.fn();
    engine.onReload(() => {
      throw new Error("listener boom");
    });
    engine.onReload(secondListener);

    writeConfig(configPath, {
      mcpServers: {
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
        },
      },
    });

    await expect(engine.reload()).resolves.toBe(true);
    expect(secondListener).toHaveBeenCalledOnce();
    expect(errors.join("")).toContain("Caplets reload listener failed");
    expect(errors.join("")).toContain("listener boom");
  });

  it("runs a follow-up reload when another reload is requested mid-flight", async () => {
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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watch: false,
    });
    engines.push(engine);
    let calls = 0;

    (engine as unknown as { reloadOnce: () => Promise<boolean> }).reloadOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        void engine.reload();
      }
      return true;
    });

    await engine.reload();
    expect(calls).toBe(2);
  });

  it("watches config and Caplet paths when watch is enabled", async () => {
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
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watchDebounceMs: 10,
    });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeConfig(configPath, {
      mcpServers: {
        beta: {
          name: "Beta",
          description: "Search beta project documents.",
          command: process.execPath,
        },
      },
    });

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  it("watches nested Caplet files when the config dir is also the Caplets root", async () => {
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
    const nestedFile = join(dir, "user", "nested", "notes.md");
    mkdirSync(join(dir, "user", "nested"), { recursive: true });
    writeFileSync(nestedFile, "before");
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watchDebounceMs: 10,
    });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeFileSync(nestedFile, "after");

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  it("watches project Caplet files without explicit trust", async () => {
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
    const projectFile = join(dir, "project", ".caplets", "notes.txt");
    writeFileSync(projectFile, "before");
    const engine = CapletsEngine.unactivatedForTests({
      configPath,
      projectConfigPath,
      watchDebounceMs: 10,
    });
    engines.push(engine);
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

    await watcherReady();
    writeFileSync(projectFile, "after");

    await eventually(() => expect(reloads).toBeGreaterThan(0));
  });

  function tempConfig(config: unknown): {
    dir: string;
    configPath: string;
    projectConfigPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "caplets-engine-"));
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

function capletMarkdown(readme: string, description = "Search alpha project documents."): string {
  return [
    "---",
    "name: Alpha",
    `description: ${description}`,
    "mcpServer:",
    `  command: ${JSON.stringify(process.execPath)}`,
    "---",
    readme,
    "",
  ].join("\n");
}

function openapiCapletMarkdown(): string {
  return [
    "---",
    "name: Weather",
    "description: Inspect weather forecasts.",
    "openapiEndpoint:",
    "  specPath: ./openapi.yaml",
    "  auth: { type: none }",
    "---",
    "Operator notes.",
    "",
  ].join("\n");
}

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config));
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

async function watcherReady(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
