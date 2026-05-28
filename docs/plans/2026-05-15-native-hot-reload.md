# Native Hot Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hot-reload support to native Caplets integrations so native tool execution uses the latest config, Pi can refresh its per-tool surface at runtime, and OpenCode gets the strongest behavior its current plugin API supports.

**Architecture:** Extract the existing MCP runtime reload/watch/backend-invalidation machinery into a shared core engine that owns config state, filesystem watchers, backend managers, reload serialization, and last-known-good behavior. Rebuild the MCP `CapletsRuntime` and native `DefaultNativeCapletsService` on top of that engine; Pi subscribes to native tool-change events and syncs registered/active tools, while OpenCode keeps static tool inventory but reads live service state for execution and system guidance.

**Tech Stack:** TypeScript, Node.js `fs.watch`, Vitest, `@modelcontextprotocol/sdk` `RegisteredTool`, OpenCode `@opencode-ai/plugin`, Pi extension APIs `registerTool`, `getActiveTools`, and `setActiveTools`.

---

## Architecture Decisions From Grill Session

- OpenCode strategy: support hot-reload for existing registered tools only, with room to expand if OpenCode adds a runtime plugin-tool registry later.
- Pi removal strategy: deactivate stale Caplets with `setActiveTools()` when hard `unregisterTool()` is unavailable.
- Core strategy: do not duplicate `CapletsRuntime` reload logic in native service; extract a shared engine and reuse it.
- Compatibility strategy: keep the current `NativeCapletsService` methods and add new methods, rather than changing adapter call sites to a completely different object.

## Current State

- `packages/core/src/runtime.ts` already supports config and Caplet file watching, debounced reloads, pending reload coalescing, last-known-good config on validation failure, selective backend invalidation, MCP tool add/update/remove, and watcher refresh.
- `packages/core/src/native/service.ts` loads config once in the constructor and never reloads.
- `packages/opencode/src/index.ts` calls `service.listTools()` once while constructing the plugin `Hooks.tool` map.
- `packages/pi/src/index.ts` calls `service.listTools()` once and calls `pi.registerTool()` once per Caplet.
- Pi docs say `pi.registerTool()` works after startup and new tools refresh immediately in-session. Pi docs also expose `getActiveTools()` and `setActiveTools(names)` for dynamic activation.
- OpenCode plugin types expose `Hooks.tool` as a static object and do not expose `registerTool`, `unregisterTool`, `updateToolDefinition`, or `refreshTools`. Upstream OpenCode issue `anomalyco/opencode#25531` requests this capability.

## File Structure

- Create `packages/core/src/engine.ts`: shared reloadable Caplets engine; owns config paths, registry, managers, watchers, reload lifecycle, listeners, and execution.
- Modify `packages/core/src/runtime.ts`: remove duplicated reload/watch/backend-manager ownership and delegate to `CapletsEngine`; keep MCP-specific tool registration/reconciliation here.
- Modify `packages/core/src/native/service.ts`: wrap `CapletsEngine`, expose `reload()`, `onToolsChanged()`, and live `listTools()`.
- Modify `packages/core/src/native.ts`: export new native listener/event types if they are public.
- Create `packages/core/test/engine.test.ts`: shared engine reload behavior tests moved from runtime-native overlap.
- Modify `packages/core/test/runtime.test.ts`: keep MCP tool reconciliation tests; remove direct private `reloadOnce` spy and rely on engine tests for reload coalescing.
- Modify `packages/core/test/native.test.ts`: add native service reload, watcher, invalid config, and tool-change listener tests.
- Modify `packages/pi/src/index.ts`: register initial tools, subscribe to service tool changes, register new/updated tools, and preserve non-Caplets active tools while deactivating stale Caplet tools.
- Modify `packages/pi/test/pi.test.ts`: add dynamic registration and active-tool preservation tests.
- Modify `packages/opencode/src/index.ts`: keep static `Hooks.tool` inventory, but compute system guidance from `service.listTools()` each transform call so existing-tool metadata stays fresh.
- Modify `packages/opencode/test/opencode.test.ts`: assert system guidance reflects current service state after list changes.
- Modify `README.md`, `packages/pi/README.md`, and `packages/opencode/README.md`: document host-specific hot-reload behavior.
- Modify `.changeset/native-agent-integrations.md`: extend the existing unreleased native integrations changeset to mention native hot-reload.

---

### Task 1: Extract Shared Reloadable Engine

**Files:**

- Create: `packages/core/src/engine.ts`
- Test: `packages/core/test/engine.test.ts`
- Modify later: `packages/core/src/runtime.ts`

- [ ] **Step 1: Write failing shared engine tests**

Create `packages/core/test/engine.test.ts` with these tests. This intentionally mirrors the proven behavior currently covered indirectly through `CapletsRuntime`, but targets the shared engine directly.

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";

describe("CapletsEngine", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
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

    await engine.close();
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
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    const listener = vi.fn();
    engine.onReload(listener);

    writeFileSync(configPath, "{ invalid json");

    await expect(engine.reload()).resolves.toBe(false);
    expect(engine.enabledServers().map((caplet) => caplet.server)).toEqual(["alpha"]);
    expect(listener).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Caplets config reload failed");

    await engine.close();
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
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
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

    await engine.close();
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
    const engine = new CapletsEngine({ configPath, projectConfigPath, watchDebounceMs: 10 });
    let reloads = 0;
    (engine as unknown as { reload: () => Promise<boolean> }).reload = vi.fn(async () => {
      reloads += 1;
      return true;
    });

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
    await engine.close();
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
```

- [ ] **Step 2: Run engine test to verify it fails**

Run: `pnpm --filter @caplets/core test -- test/engine.test.ts`

Expected: FAIL because `../src/engine.js` does not exist.

- [ ] **Step 3: Create the shared engine**

Create `packages/core/src/engine.ts`. Move the reload, watcher, config path, backend manager, and helper logic from `packages/core/src/runtime.ts` into this file. The public surface must match this shape:

```ts
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, parse } from "node:path";
import { CliToolsManager } from "./cli-tools";
import {
  type CapletConfig,
  type CapletsConfig,
  loadConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "./config";
import { DownstreamManager } from "./downstream";
import { errorResult, toSafeError } from "./errors";
import { GraphQLManager } from "./graphql";
import { HttpActionManager } from "./http-actions";
import { OpenApiManager } from "./openapi";
import { ServerRegistry } from "./registry";
import { handleServerTool } from "./tools";

export type CapletsEngineOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
};

export type CapletsEngineReloadEvent = {
  previous: CapletsConfig;
  next: CapletsConfig;
  invalidated: boolean;
};

type RuntimePaths = {
  configPath: string;
  projectConfigPath: string;
};

type WatchedPath = {
  path: string;
  reason: "config" | "caplets";
};

export class CapletsEngine {
  private registry: ServerRegistry;
  private readonly downstream: DownstreamManager;
  private readonly openapi: OpenApiManager;
  private readonly graphql: GraphQLManager;
  private readonly http: HttpActionManager;
  private readonly cli: CliToolsManager;
  private readonly paths: RuntimePaths;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private readonly writeErr: (value: string) => void;
  private readonly reloadListeners = new Set<(event: CapletsEngineReloadEvent) => void>();
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private watcherRefreshTimer: NodeJS.Timeout | undefined;
  private reloading: Promise<boolean> | undefined;
  private pendingReload = false;
  private closed = false;

  constructor(options: CapletsEngineOptions = {}) {
    this.paths = {
      configPath: resolveConfigPath(options.configPath),
      projectConfigPath: options.projectConfigPath ?? resolveProjectConfigPath(),
    };
    const config = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
    this.registry = new ServerRegistry(config);
    this.downstream = new DownstreamManager(this.registry, selectAuthOptions(options.authDir));
    this.openapi = new OpenApiManager(this.registry, selectAuthOptions(options.authDir));
    this.graphql = new GraphQLManager(this.registry, selectAuthOptions(options.authDir));
    this.http = new HttpActionManager(this.registry, selectAuthOptions(options.authDir));
    this.cli = new CliToolsManager(this.registry);
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
    this.watchEnabled = options.watch ?? true;
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
    if (this.watchEnabled) {
      this.resetWatchers();
    }
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  enabledServers(): CapletConfig[] {
    return nextEnabledServers(this.registry.config);
  }

  watchedPaths(): string[] {
    return [...new Set(watchedPaths(this.paths).map((entry) => entry.path))].sort();
  }

  onReload(listener: (event: CapletsEngineReloadEvent) => void): () => void {
    this.reloadListeners.add(listener);
    return () => {
      this.reloadListeners.delete(listener);
    };
  }

  scheduleReload(): void {
    if (this.closed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, this.watchDebounceMs);
  }

  async reload(): Promise<boolean> {
    if (this.closed) return false;
    if (this.reloading) {
      this.pendingReload = true;
      return await this.reloading;
    }
    this.reloading = this.reloadUntilSettled().finally(() => {
      this.reloading = undefined;
    });
    return await this.reloading;
  }

  async execute(serverId: string, request: unknown): Promise<unknown> {
    try {
      const caplet = this.registry.require(serverId);
      return await handleServerTool(
        caplet,
        request,
        this.registry,
        this.downstream,
        this.openapi,
        this.graphql,
        this.http,
        this.cli,
      );
    } catch (error) {
      return errorResult(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = undefined;
      }
      if (this.watcherRefreshTimer) {
        clearTimeout(this.watcherRefreshTimer);
        this.watcherRefreshTimer = undefined;
      }
      if (this.reloading) {
        await this.reloading;
      }
    } finally {
      this.closeWatchers();
      await this.downstream.close();
      this.reloadListeners.clear();
    }
  }

  private async reloadOnce(): Promise<boolean> {
    if (this.closed) return false;
    let nextConfig: CapletsConfig;
    try {
      nextConfig = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
    } catch (error) {
      this.writeErr(`Caplets config reload failed; keeping last known-good config.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "CONFIG_INVALID"), null, 2)}\n`);
      return false;
    }

    if (this.closed) return false;
    const previousConfig = this.registry.config;
    const nextRegistry = new ServerRegistry(nextConfig);
    this.registry = nextRegistry;
    this.downstream.updateRegistry(nextRegistry);
    this.openapi.updateRegistry(nextRegistry);
    this.graphql.updateRegistry(nextRegistry);
    this.http.updateRegistry(nextRegistry);
    this.cli.updateRegistry(nextRegistry);

    let invalidated = true;
    try {
      await this.invalidateChangedBackends(previousConfig, nextConfig);
    } catch (error) {
      invalidated = false;
      this.writeErr(`Caplets backend invalidation failed; continuing reload.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "INTERNAL_ERROR"), null, 2)}\n`);
    }
    if (this.closed) return false;
    if (this.watchEnabled) {
      this.resetWatchers();
    }
    this.emitReload({ previous: previousConfig, next: nextConfig, invalidated });
    return invalidated;
  }

  private async reloadUntilSettled(): Promise<boolean> {
    let succeeded = true;
    do {
      this.pendingReload = false;
      try {
        succeeded = (await this.reloadOnce()) && succeeded;
      } catch (err) {
        this.writeErr(`Caplets reload failed.\n`);
        this.writeErr(`${JSON.stringify(toSafeError(err, "INTERNAL_ERROR"), null, 2)}\n`);
        succeeded = false;
      }
    } while (this.pendingReload && !this.closed);
    return succeeded && !this.closed;
  }

  private emitReload(event: CapletsEngineReloadEvent): void {
    for (const listener of this.reloadListeners) {
      listener(event);
    }
  }

  private async invalidateChangedBackends(
    previous: CapletsConfig,
    next: CapletsConfig,
  ): Promise<void> {
    const previousCaplets = new Map(allCaplets(previous).map((server) => [server.server, server]));
    const nextCaplets = new Map(allCaplets(next).map((server) => [server.server, server]));
    const changedIds = new Set([...previousCaplets.keys(), ...nextCaplets.keys()]);

    for (const serverId of changedIds) {
      const before = previousCaplets.get(serverId);
      const after = nextCaplets.get(serverId);
      const changed = serializeCaplet(before) !== serializeCaplet(after);
      if (!changed) continue;
      if (before?.backend === "mcp") await this.downstream.closeServer(serverId);
      if (before?.backend === "openapi" || after?.backend === "openapi" || !after)
        this.openapi.invalidate(serverId);
      if (before?.backend === "graphql" || after?.backend === "graphql" || !after)
        this.graphql.invalidate(serverId);
      if (before?.backend === "http" || after?.backend === "http" || !after)
        this.http.invalidate(serverId);
      if (before?.backend === "cli" || after?.backend === "cli" || !after)
        this.cli.invalidate(serverId);
    }
  }

  private resetWatchers(): void {
    this.closeWatchers();
    const watched = new Set<string>();
    for (const entry of watchedPaths(this.paths)) {
      const watchPath = existsSync(entry.path) ? entry.path : nearestExistingParent(entry.path);
      const watchKey = `${entry.reason}:${watchPath}`;
      if (!watchPath || watched.has(watchKey)) continue;
      watched.add(watchKey);
      try {
        this.watchers.push(...this.watchEntry(entry, watchPath));
      } catch (error) {
        this.writeErr(`Caplets could not watch ${entry.reason} path ${entry.path}.\n`);
        this.writeErr(`${JSON.stringify(toSafeError(error, "SERVER_UNAVAILABLE"), null, 2)}\n`);
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private watchEntry(entry: WatchedPath, watchPath: string): FSWatcher[] {
    if (entry.reason === "caplets" && existsSync(entry.path) && isDirectory(watchPath)) {
      return this.watchDirectoryTree(watchPath);
    }
    return [
      watch(watchPath, { persistent: true }, (eventType) => {
        this.scheduleReload();
        if (eventType === "rename" && entry.reason === "caplets" && existsSync(entry.path)) {
          this.scheduleWatcherRefresh();
        }
      }),
    ];
  }

  private watchDirectoryTree(root: string): FSWatcher[] {
    const watchers: FSWatcher[] = [];
    const directories = discoverDirectories(root);
    for (const directory of directories) {
      try {
        watchers.push(
          watch(directory, { persistent: true }, (eventType) => {
            this.scheduleReload();
            if (eventType === "rename") this.scheduleWatcherRefresh();
          }),
        );
      } catch (error) {
        for (const watcher of watchers) watcher.close();
        throw error;
      }
    }
    return watchers;
  }

  private scheduleWatcherRefresh(): void {
    if (this.closed) return;
    if (this.watcherRefreshTimer) clearTimeout(this.watcherRefreshTimer);
    this.watcherRefreshTimer = setTimeout(() => {
      this.watcherRefreshTimer = undefined;
      if (!this.closed) this.resetWatchers();
    }, this.watchDebounceMs);
  }
}

function selectAuthOptions(authDir: string | undefined): { authDir?: string } {
  return authDir ? { authDir } : {};
}

function watchedPaths(paths: RuntimePaths): WatchedPath[] {
  return uniqueWatchedPaths([
    { path: dirname(paths.configPath), reason: "config" },
    { path: dirname(paths.projectConfigPath), reason: "config" },
    { path: resolveCapletsRoot(paths.configPath), reason: "caplets" },
    { path: dirname(paths.projectConfigPath), reason: "caplets" },
  ]);
}

function uniqueWatchedPaths(entries: WatchedPath[]): WatchedPath[] {
  const seen = new Set<string>();
  const unique: WatchedPath[] = [];
  for (const entry of entries) {
    const key = `${entry.reason}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
  ];
}

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return allCaplets(config).filter((server) => !server.disabled);
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}

function nearestExistingParent(path: string): string | undefined {
  let candidate = dirname(path);
  const root = parse(candidate).root;
  while (candidate && candidate !== root) {
    if (existsSync(candidate)) return candidate;
    candidate = dirname(candidate);
  }
  return existsSync(root) ? root : undefined;
}

function discoverDirectories(root: string): string[] {
  if (!isDirectory(root)) return [];
  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(...discoverDirectories(`${root}/${entry.name}`));
  }
  return directories;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run engine tests**

Run: `pnpm --filter @caplets/core test -- test/engine.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/core/src/engine.ts packages/core/test/engine.test.ts
git commit -m "refactor(core): extract reloadable Caplets engine"
```

---

### Task 2: Rebuild MCP Runtime On The Shared Engine

**Files:**

- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/test/runtime.test.ts`

- [ ] **Step 1: Update runtime tests for the engine split**

Keep the MCP-specific tests in `packages/core/test/runtime.test.ts`: initial tool registration, raw MCP names with prefixed native names, add/update/remove reconciliation, invalid config retaining old MCP tools, backend invalidation failure behavior, watched path exposure, and watcher scheduling.

Delete or move the test named `runs a follow-up reload when another reload is requested mid-flight`; that behavior is now covered in `packages/core/test/engine.test.ts`.

Run: `pnpm --filter @caplets/core test -- test/runtime.test.ts`

Expected: FAIL while `CapletsRuntime` still owns duplicated logic and/or the private `reloadOnce` test no longer applies.

- [ ] **Step 2: Replace runtime state ownership with `CapletsEngine`**

In `packages/core/src/runtime.ts`, remove imports that are now engine-owned: `existsSync`, `readdirSync`, `statSync`, `watch`, `dirname`, `parse`, `loadConfig`, `resolveCapletsRoot`, `resolveConfigPath`, `resolveProjectConfigPath`, `CliToolsManager`, `DownstreamManager`, `errorResult`, `toSafeError`, `GraphQLManager`, `HttpActionManager`, `OpenApiManager`, `ServerRegistry`, and `handleServerTool`.

Add these imports:

```ts
import type { CapletConfig, CapletsConfig } from "./config";
import { CapletsEngine } from "./engine";
```

Change the class fields to this shape:

```ts
export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribeReload: () => void;
  private closed = false;
```

Change the constructor to instantiate the engine and reconcile initial tools:

```ts
  constructor(options: CapletsRuntimeOptions = {}) {
    this.engine = new CapletsEngine(options);
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.reconcileTools(undefined, this.engine.currentConfig());
    this.unsubscribeReload = this.engine.onReload(({ previous, next }) => {
      this.reconcileTools(previous, next);
    });
  }
```

Replace reload/watch/current-config methods with delegates:

```ts
  scheduleReload(): void {
    this.engine.scheduleReload();
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeReload();
    try {
      await this.engine.close();
    } finally {
      await this.server.close();
    }
  }

  currentConfig(): CapletsConfig {
    return this.engine.currentConfig();
  }

  watchedPaths(): string[] {
    return this.engine.watchedPaths();
  }
```

Replace `handleTool` with a delegate:

```ts
  private async handleTool(serverId: string, request: unknown): Promise<any> {
    return await this.engine.execute(serverId, request);
  }
```

Keep `reconcileTools`, `registerCapletTool`, `nextEnabledServers`, `capletById`, and `serializeCaplet` in `runtime.ts` because they are MCP tool-registration concerns.

- [ ] **Step 3: Remove duplicated runtime helper code**

Delete these from `packages/core/src/runtime.ts` after the engine delegate is in place:

```ts
type RuntimePaths = { configPath: string; projectConfigPath: string };
type WatchedPath = { path: string; reason: "config" | "caplets" };
selectAuthOptions;
watchedPaths;
uniqueWatchedPaths;
allCaplets;
nearestExistingParent;
discoverDirectories;
isDirectory;
```

Keep `nextEnabledServers`, `capletById`, and `serializeCaplet` if they are still used by MCP reconciliation.

- [ ] **Step 4: Run runtime tests**

Run: `pnpm --filter @caplets/core test -- test/runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Run focused core tests**

Run: `pnpm --filter @caplets/core test -- test/engine.test.ts test/runtime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/core/src/runtime.ts packages/core/test/runtime.test.ts
git commit -m "refactor(core): reuse engine in MCP runtime"
```

---

### Task 3: Make Native Service Reloadable

**Files:**

- Modify: `packages/core/src/native/service.ts`
- Modify: `packages/core/src/native.ts`
- Test: `packages/core/test/native.test.ts`

- [ ] **Step 1: Write failing native reload tests**

Append these tests to `packages/core/test/native.test.ts` before the `tempConfig` helper:

```ts
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

it("notifies native tool listeners on successful reload only", async () => {
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
  const unsubscribe = service.onToolsChanged((tools) => {
    events.push(tools.map((tool) => tool.caplet));
  });

  try {
    writeFileSync(configPath, "{ invalid json");
    await expect(service.reload()).resolves.toBe(false);
    expect(events).toEqual([]);

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
```

Update the import from `node:fs` at the top of `native.test.ts` to keep `writeFileSync` available; it already is available today.

- [ ] **Step 2: Run native tests to verify they fail**

Run: `pnpm --filter @caplets/core test -- test/native.test.ts`

Expected: FAIL because `watch`, `reload`, and `onToolsChanged` are not in `NativeCapletsServiceOptions` / `NativeCapletsService` yet.

- [ ] **Step 3: Extend native service types**

In `packages/core/src/native/service.ts`, replace the type block with:

```ts
export type NativeCapletsServiceOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
};

export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
};

export type NativeCapletsToolsChangedListener = (tools: NativeCapletTool[]) => void;

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  reload(): Promise<boolean>;
  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void;
  close(): Promise<void>;
};
```

- [ ] **Step 4: Replace native service internals with `CapletsEngine`**

In `packages/core/src/native/service.ts`, remove direct manager/config imports and add:

```ts
import { CapletsEngine } from "../engine";
```

Replace `DefaultNativeCapletsService` with:

```ts
class DefaultNativeCapletsService implements NativeCapletsService {
  private readonly engine: CapletsEngine;

  constructor(options: NativeCapletsServiceOptions) {
    this.engine = new CapletsEngine(options);
  }

  listTools(): NativeCapletTool[] {
    return this.engine.enabledServers().map((caplet) => {
      const toolName = nativeCapletToolName(caplet.server);
      return {
        caplet: caplet.server,
        toolName,
        title: caplet.name,
        description: nativeCapletToolDescription(toolName, caplet),
        promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
      };
    });
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    return await this.engine.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    return this.engine.onReload(() => listener(this.listTools()));
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}
```

- [ ] **Step 5: Export listener type**

In `packages/core/src/native.ts`, update the export block:

```ts
export {
  createNativeCapletsService,
  type NativeCapletTool,
  type NativeCapletsService,
  type NativeCapletsServiceOptions,
  type NativeCapletsToolsChangedListener,
} from "./native/service";
```

- [ ] **Step 6: Run native tests**

Run: `pnpm --filter @caplets/core test -- test/native.test.ts`

Expected: PASS.

- [ ] **Step 7: Run core focused tests**

Run: `pnpm --filter @caplets/core test -- test/engine.test.ts test/runtime.test.ts test/native.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add packages/core/src/native.ts packages/core/src/native/service.ts packages/core/test/native.test.ts
git commit -m "feat(core): hot reload native Caplets service"
```

---

### Task 4: Sync Pi Native Tools At Runtime

**Files:**

- Modify: `packages/pi/src/index.ts`
- Test: `packages/pi/test/pi.test.ts`

- [ ] **Step 1: Extend Pi test API types**

In `packages/pi/test/pi.test.ts`, add this helper type near `RegisteredTool`:

```ts
type MockPiApi = {
  registerTool: Mock<(definition: unknown) => void>;
  getActiveTools: Mock<() => Array<{ name: string }>>;
  setActiveTools: Mock<(names: string[]) => void>;
};
```

Add this helper near `mockService`:

```ts
function mockPiApi(activeTools: string[] = []): { api: MockPiApi; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const api: MockPiApi = {
    registerTool: vi.fn((definition) => registered.push(definition as RegisteredTool)),
    getActiveTools: vi.fn(() => activeTools.map((name) => ({ name }))),
    setActiveTools: vi.fn(),
  };
  return { api, registered };
}
```

Update `mockService` so tests can trigger listeners:

```ts
type MockService = NativeCapletsService & {
  listTools: Mock<() => NativeCapletTool[]>;
  execute: Mock<NativeCapletsService["execute"]>;
  reload: Mock<NativeCapletsService["reload"]>;
  onToolsChanged: Mock<NativeCapletsService["onToolsChanged"]>;
  close: Mock<NativeCapletsService["close"]>;
  setTools(tools: NativeCapletTool[]): void;
  emitToolsChanged(): void;
};

function mockService(tools: NativeCapletTool[]): MockService {
  let currentTools = tools;
  const listeners = new Set<(tools: NativeCapletTool[]) => void>();
  return {
    listTools: vi.fn<() => NativeCapletTool[]>(() => currentTools),
    execute: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(async () => {}),
    setTools(nextTools) {
      currentTools = nextTools;
    },
    emitToolsChanged() {
      for (const listener of listeners) listener(currentTools);
    },
  };
}
```

- [ ] **Step 2: Add failing Pi dynamic sync tests**

Append these tests to `packages/pi/test/pi.test.ts`:

```ts
it("registers newly added tools when the native service changes", () => {
  const service = mockService([
    {
      caplet: "git-hub",
      toolName: "caplets_git_hub",
      title: "GitHub",
      description: "GitHub Caplet",
      promptGuidance: ["Use caplets_git_hub for GitHub."],
    },
  ]);
  const { api, registered } = mockPiApi(["read", "caplets_git_hub"]);

  capletsPiExtension(api, { service });
  service.setTools([
    {
      caplet: "git-hub",
      toolName: "caplets_git_hub",
      title: "GitHub",
      description: "GitHub Caplet",
      promptGuidance: ["Use caplets_git_hub for GitHub."],
    },
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear Caplet",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ]);
  service.emitToolsChanged();

  expect(registered.map((tool) => tool.name)).toEqual(["caplets_git_hub", "caplets_linear"]);
  expect(api.setActiveTools).toHaveBeenLastCalledWith([
    "read",
    "caplets_git_hub",
    "caplets_linear",
  ]);
});

it("deactivates stale Caplets while preserving non-Caplets active tools", () => {
  const service = mockService([
    {
      caplet: "git-hub",
      toolName: "caplets_git_hub",
      title: "GitHub",
      description: "GitHub Caplet",
      promptGuidance: ["Use caplets_git_hub for GitHub."],
    },
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear Caplet",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ]);
  const { api } = mockPiApi(["read", "bash", "caplets_git_hub", "caplets_linear"]);

  capletsPiExtension(api, { service });
  service.setTools([
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear Caplet",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ]);
  service.emitToolsChanged();

  expect(api.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "caplets_linear"]);
});

it("works when Pi active-tool APIs are unavailable", () => {
  const service = mockService([]);
  const registered: RegisteredTool[] = [];

  capletsPiExtension(
    { registerTool: (definition) => registered.push(definition as RegisteredTool) },
    { service },
  );

  service.setTools([
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear Caplet",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ]);
  service.emitToolsChanged();

  expect(registered.map((tool) => tool.name)).toEqual(["caplets_linear"]);
});
```

- [ ] **Step 3: Run Pi tests to verify they fail**

Run: `pnpm --filter @caplets/pi test`

Expected: FAIL because the adapter does not subscribe to `onToolsChanged` and does not call active-tool APIs.

- [ ] **Step 4: Extend Pi adapter API type**

In `packages/pi/src/index.ts`, change `PiExtensionApi` to:

```ts
export type PiExtensionApi = {
  registerTool(definition: unknown): void;
  getActiveTools?(): Array<{ name: string }>;
  setActiveTools?(names: string[]): void;
};
```

- [ ] **Step 5: Add Pi sync helpers**

In `packages/pi/src/index.ts`, replace the loop in `capletsPiExtension` with a `syncTools` helper. Use this exact structure so active non-Caplets tools are preserved:

```ts
export default function capletsPiExtension(pi: PiExtensionApi, options: CapletsPiOptions = {}) {
  const service = options.service ?? createNativeCapletsService();
  if (!options.service) {
    registerNativeCapletsProcessCleanup(service);
  }

  const registeredCapletTools = new Set<string>();
  let knownCapletTools = new Set<string>();

  const syncTools = (caplets = service.listTools()) => {
    const nextCapletTools = new Set(caplets.map((caplet) => caplet.toolName));
    for (const caplet of caplets) {
      if (registeredCapletTools.has(caplet.toolName)) {
        continue;
      }
      registeredCapletTools.add(caplet.toolName);
      pi.registerTool(createPiTool(service, caplet));
    }

    if (pi.getActiveTools && pi.setActiveTools) {
      const activeNonCaplets = pi
        .getActiveTools()
        .map((tool) => tool.name)
        .filter((name) => !knownCapletTools.has(name));
      pi.setActiveTools([...activeNonCaplets, ...nextCapletTools]);
    }

    knownCapletTools = nextCapletTools;
  };

  syncTools();
  service.onToolsChanged(syncTools);
}
```

Add this helper below `capletsPiExtension`:

```ts
function createPiTool(service: NativeCapletsService, caplet: NativeCapletTool): unknown {
  return {
    name: caplet.toolName,
    label: caplet.title,
    description: caplet.description,
    promptSnippet: `Use ${caplet.toolName} for the ${caplet.title} Caplet capability domain.`,
    promptGuidelines: caplet.promptGuidance,
    parameters: capletsPiParameters(),
    async execute(_toolCallId: string, params: unknown) {
      const result = await service.execute(caplet.caplet, params);
      const serialized = serializeResult(result);
      return {
        content: [{ type: "text", text: serialized.text }],
        details: serialized.serializationError
          ? { result, serializationError: serialized.serializationError }
          : { result },
      };
    },
  };
}
```

Update the import from `@caplets/core/native` to include `type NativeCapletTool`.

- [ ] **Step 6: Run Pi tests**

Run: `pnpm --filter @caplets/pi test`

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/pi/src/index.ts packages/pi/test/pi.test.ts
git commit -m "feat(pi): sync native Caplet tools on reload"
```

---

### Task 5: Refresh OpenCode Guidance For Existing Tools

**Files:**

- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Add failing OpenCode guidance test**

Append this test to `packages/opencode/test/opencode.test.ts`:

```ts
it("refreshes system guidance from the current native tool list", async () => {
  const { createCapletsOpenCodeHooks } = await import("../src/index");
  let tools = [
    {
      caplet: "git-hub",
      toolName: "caplets_git_hub",
      title: "GitHub",
      description: "GitHub\n\nUse this Caplet.",
      promptGuidance: ["Use caplets_git_hub for GitHub."],
    },
  ];
  const service = {
    listTools: () => tools,
    execute: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };

  const hooks = await createCapletsOpenCodeHooks(service);
  tools = [
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear\n\nUse this Caplet.",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ];

  const output = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]?.({} as never, output);

  expect(output.system.join("\n")).toContain("caplets_linear");
  expect(output.system.join("\n")).not.toContain("caplets_git_hub");
});
```

- [ ] **Step 2: Run OpenCode tests to verify failure**

Run: `pnpm --filter @caplets/opencode test`

Expected: FAIL because `toolNames` are snapshotted before the hook is returned.

- [ ] **Step 3: Compute guidance at transform time**

In `packages/opencode/src/index.ts`, keep `capletTools` for static `Hooks.tool`, but remove the top-level `toolNames` constant. Change the transform hook to:

```ts
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        nativeCapletsSystemGuidance(service.listTools().map((caplet) => caplet.toolName)),
      );
    },
```

Do not dynamically add/remove OpenCode plugin tools in this task; the current OpenCode API does not support runtime plugin-tool inventory mutation.

- [ ] **Step 4: Run OpenCode tests**

Run: `pnpm --filter @caplets/opencode test`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/opencode/src/index.ts packages/opencode/test/opencode.test.ts
git commit -m "feat(opencode): refresh native guidance from live service"
```

---

### Task 6: Document Host-Specific Hot Reload Behavior

**Files:**

- Modify: `README.md`
- Modify: `packages/pi/README.md`
- Modify: `packages/opencode/README.md`
- Modify: `.changeset/native-agent-integrations.md`

- [ ] **Step 1: Update root README native section**

In `README.md`, replace lines 718-719 text with:

```md
Native integrations hot reload config and Caplet file edits through the same runtime used by
`caplets serve`. Existing native tools execute against the latest valid config without host
restart. Pi also refreshes newly added Caplet tools at runtime and deactivates removed Caplet
tools when Pi's active-tool APIs are available. OpenCode's current plugin API snapshots the
tool inventory at plugin load, so adding, removing, or renaming OpenCode native tools still
requires restarting OpenCode; already-registered tools and injected guidance use live Caplets
state.
```

- [ ] **Step 2: Update Pi README**

In `packages/pi/README.md`, replace the final paragraph with:

```md
The extension hot reloads Caplets config and Caplet file edits. Existing tools execute against
the latest valid backend config. Newly added Caplets are registered in the current Pi session;
removed or disabled Caplets are deactivated with Pi's active-tool APIs when available. If Pi is
running without `getActiveTools()` / `setActiveTools()`, stale tools may remain registered until
Pi reloads extensions or restarts, but calls to removed Caplets return Caplets' normal structured
"server not found" error.
```

- [ ] **Step 3: Update OpenCode README**

In `packages/opencode/README.md`, replace the final paragraph with:

```md
The plugin hot reloads Caplets config and Caplet file edits for already-registered tools, so
existing native tools execute against the latest valid backend config and prompt guidance is
rebuilt from current Caplets state. OpenCode's current plugin API snapshots `Hooks.tool` at
plugin load, so adding, removing, or renaming native tools still requires restarting OpenCode.
```

- [ ] **Step 4: Update existing changeset**

Append this sentence to `.changeset/native-agent-integrations.md`:

```md
Native integrations now share the hot-reload runtime so existing native tools execute against
the latest valid Caplets config; Pi can register newly added Caplet tools and deactivate stale
ones at runtime when its active-tool APIs are available.
```

- [ ] **Step 5: Run docs formatting check**

Run: `pnpm format:check`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add README.md packages/pi/README.md packages/opencode/README.md .changeset/native-agent-integrations.md
git commit -m "docs: describe native hot reload behavior"
```

---

### Task 7: Full Verification And Cleanup

**Files:**

- Verify all changed files.

- [ ] **Step 1: Run package-focused tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/engine.test.ts test/runtime.test.ts test/native.test.ts
pnpm --filter @caplets/pi test
pnpm --filter @caplets/opencode test
```

Expected: all commands PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run lint and format checks**

Run:

```sh
pnpm format:check
pnpm lint
```

Expected: both PASS.

- [ ] **Step 4: Run full verification gate**

Run: `pnpm verify`

Expected: PASS, including `format:check`, `lint`, `typecheck`, `schema:check`, `test`, `benchmark:check`, and `build`.

- [ ] **Step 5: Inspect final diff**

Run:

```sh
git status --short
git diff --stat HEAD
git diff HEAD -- packages/core/src/engine.ts packages/core/src/runtime.ts packages/core/src/native/service.ts packages/pi/src/index.ts packages/opencode/src/index.ts
```

Expected: only planned files changed; no generated schema or benchmark docs changed unless `pnpm verify` explicitly updated them.

- [ ] **Step 6: Final commit if previous task commits were skipped**

If implementing as one commit instead of per-task commits, run:

```sh
git add packages/core/src/engine.ts packages/core/src/runtime.ts packages/core/src/native.ts packages/core/src/native/service.ts packages/core/test/engine.test.ts packages/core/test/runtime.test.ts packages/core/test/native.test.ts packages/pi/src/index.ts packages/pi/test/pi.test.ts packages/opencode/src/index.ts packages/opencode/test/opencode.test.ts README.md packages/pi/README.md packages/opencode/README.md .changeset/native-agent-integrations.md
git commit -m "feat: hot reload native Caplets integrations"
```

Expected: commit succeeds without pre-commit failures.

---

## Residual Risks

- Pi `setActiveTools()` replaces the entire active tool list. The plan preserves all currently active non-Caplets tools and swaps only the Caplets-owned subset, but it cannot reactivate a non-Caplets tool that another extension intentionally deactivated before Caplets observes the active set.
- Pi may treat duplicate `registerTool()` calls as collisions rather than updates. The plan avoids re-registering known tool names. If metadata changes for an existing Pi tool and Pi has no update API, the execution backend still updates, but the displayed label/description may remain as originally registered until Pi reloads extensions.
- OpenCode cannot add/remove plugin tools at runtime with the current API. This plan documents that limitation and keeps the implementation ready to expand if OpenCode adds a runtime plugin-tool registry.
- `fs.watch` behavior varies by platform. This plan preserves the existing `caplets serve` watcher strategy rather than changing watcher primitives.

## Completion Criteria

- `CapletsEngine` owns one copy of reload/watch/backend lifecycle behavior.
- `CapletsRuntime` still passes all existing MCP hot-reload tests through the shared engine.
- `createNativeCapletsService()` supports `reload()` and `onToolsChanged()` and hot reloads config state.
- Pi registers newly added Caplets after native reload and deactivates stale Caplet tools without disabling active non-Caplets tools.
- OpenCode existing native tools execute against live service state and system guidance is rebuilt from current service tools.
- README/package docs explain exact host-specific behavior.
- `pnpm verify` passes.
