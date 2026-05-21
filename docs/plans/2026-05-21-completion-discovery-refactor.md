# Completion Discovery Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated CLI completion command lists with shared metadata and add cache-backed live downstream completions for qualified tools, prompts, resources, and resource templates.

**Architecture:** A shared command metadata module feeds both Commander registration and completion resolution. A focused completion discovery layer loads config, consults a platform-native persistent cache, performs bounded live discovery through existing managers, and returns best-effort candidates while preserving remote/server state ownership. Completion cache entries store only secret-free candidate metadata keyed by backend/config fingerprints.

**Tech Stack:** TypeScript, Commander, Zod config schema, Vitest, Node filesystem/path APIs, existing Caplets managers (`DownstreamManager`, `OpenApiManager`, `GraphQLManager`, `HttpActionManager`, `CliToolsManager`, `CapletSetManager`).

---

## File structure

- Create `packages/core/src/cli/commands.ts`
  - Shared source of truth for top-level command names, hidden command names, subcommands, completion shells, option enum values, and command categories (`capletIdCommands`, `qualifiedToolCommands`, etc.).
- Modify `packages/core/src/cli.ts`
  - Use command metadata constants when registering Commander commands.
  - Pass async completion options to `completeCliWords`.
- Modify `packages/core/src/cli/completion.ts`
  - Consume shared command metadata.
  - Support async cache-backed discovery for qualified targets and option-context completions.
- Create `packages/core/src/cli/completion-cache.ts`
  - Platform-cache-backed JSON cache helpers, cache keying, TTL checks, negative-cache entries, pruning, and atomic writes.
- Create `packages/core/src/cli/completion-discovery.ts`
  - Discovery orchestration, config-defined candidates, live manager-backed discovery, timeout/budget handling, fallback behavior, and candidate formatting.
- Modify `packages/core/src/config/paths.ts`
  - Add platform-native cache base and completion cache directory helpers.
- Modify `packages/core/src/config.ts`
  - Add `CompletionConfig`, defaults, parsing, merge support, and schema descriptions.
- Modify `packages/core/src/engine.ts`
  - Add an engine method for server-owned completion discovery used by remote control.
- Modify `packages/core/src/remote-control/dispatch.ts`
  - Route `complete_cli` through the engine discovery path instead of the purely static resolver.
- Modify `packages/core/test/cli-completion.test.ts`
  - Expand static metadata sync, qualified target, cache, timeout, and config-defined completion coverage.
- Modify `packages/core/test/config.test.ts` and/or `packages/core/test/config-paths.test.ts`
  - Cover completion config defaults and platform cache paths.
- Modify `packages/core/test/remote-control-dispatch.test.ts`
  - Cover server-owned remote completion discovery and secret-free responses.
- Modify `README.md`, `packages/cli/README.md`, `.changeset/cli-completions.md`, and `schemas/caplets-config.schema.json`.

---

## Task 1: Move CLI command completion metadata into a shared module

**Files:**

- Create: `packages/core/src/cli/commands.ts`
- Modify: `packages/core/src/cli/completion.ts`
- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/cli-completion.test.ts`

- [ ] **Step 1: Write the failing metadata sync test**

Add this test to `packages/core/test/cli-completion.test.ts` if it is not already present:

```ts
it("keeps top-level command suggestions in sync with registered CLI commands", () => {
  const registeredCommands = createProgram()
    .commands.filter((command) => command.name() !== "__complete")
    .map((command) => command.name())
    .sort();

  expect(completeCliWords([""]).toSorted()).toEqual(registeredCommands);
});
```

- [ ] **Step 2: Run the test before refactor**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: PASS today, but still backed by a duplicated list. The refactor must keep this green while removing the duplicate source.

- [ ] **Step 3: Add shared command metadata**

Create `packages/core/src/cli/commands.ts`:

```ts
export const completionShells = ["bash", "zsh", "fish", "powershell", "cmd"] as const;
export type CompletionShell = (typeof completionShells)[number];

export const cliCommands = {
  completion: "completion",
  completeHidden: "__complete",
  serve: "serve",
  init: "init",
  list: "list",
  install: "install",
  add: "add",
  getCaplet: "get-caplet",
  checkBackend: "check-backend",
  listTools: "list-tools",
  searchTools: "search-tools",
  getTool: "get-tool",
  callTool: "call-tool",
  listResources: "list-resources",
  searchResources: "search-resources",
  listResourceTemplates: "list-resource-templates",
  readResource: "read-resource",
  listPrompts: "list-prompts",
  searchPrompts: "search-prompts",
  getPrompt: "get-prompt",
  complete: "complete",
  config: "config",
  auth: "auth",
} as const;

export const topLevelCommandNames = [
  cliCommands.serve,
  cliCommands.init,
  cliCommands.list,
  cliCommands.install,
  cliCommands.add,
  cliCommands.getCaplet,
  cliCommands.checkBackend,
  cliCommands.listTools,
  cliCommands.searchTools,
  cliCommands.getTool,
  cliCommands.callTool,
  cliCommands.listResources,
  cliCommands.searchResources,
  cliCommands.listResourceTemplates,
  cliCommands.readResource,
  cliCommands.listPrompts,
  cliCommands.searchPrompts,
  cliCommands.getPrompt,
  cliCommands.complete,
  cliCommands.config,
  cliCommands.auth,
  cliCommands.completion,
] as const;

export const cliSubcommands = {
  [cliCommands.add]: ["cli", "mcp", "openapi", "graphql", "http"],
  [cliCommands.auth]: ["login", "logout", "list"],
  [cliCommands.completion]: [...completionShells],
  [cliCommands.config]: ["path", "paths"],
} as const satisfies Record<string, readonly string[]>;

export const capletIdCommands = new Set<string>([
  cliCommands.getCaplet,
  cliCommands.checkBackend,
  cliCommands.listTools,
  cliCommands.searchTools,
  cliCommands.listResources,
  cliCommands.searchResources,
  cliCommands.listResourceTemplates,
  cliCommands.readResource,
  cliCommands.listPrompts,
  cliCommands.searchPrompts,
  cliCommands.complete,
]);

export const qualifiedToolCommands = new Set<string>([cliCommands.getTool, cliCommands.callTool]);

export const qualifiedPromptCommands = new Set<string>([cliCommands.getPrompt]);
```

- [ ] **Step 4: Update completion resolver imports**

In `packages/core/src/cli/completion.ts`, remove the local `completionShells`, `CompletionShell`, `topLevelCommands`, `subcommands`, `capletIdCommands`, and `qualifiedTargetCommands` definitions. Import the shared metadata:

```ts
import {
  capletIdCommands,
  cliCommands,
  cliSubcommands,
  completionShells,
  qualifiedPromptCommands,
  qualifiedToolCommands,
  topLevelCommandNames,
  type CompletionShell,
} from "./commands";

export { completionShells, type CompletionShell } from "./commands";
```

Update resolver references:

```ts
if (normalized.length === 1) return prefixFilter(topLevelCommandNames, current);

if (normalized.length === 2 && cliSubcommands[command]) {
  return prefixFilter(cliSubcommands[command], current);
}

if (
  normalized.length === 2 &&
  (qualifiedToolCommands.has(command) || qualifiedPromptCommands.has(command))
) {
  return prefixFilter(
    configuredCapletIds(options).map((id) => `${id}.`),
    current,
  );
}

if (
  command === cliCommands.auth &&
  ["login", "logout"].includes(subcommand) &&
  normalized.length === 3
) {
  return prefixFilter(configuredCapletIds(options), current);
}
```

- [ ] **Step 5: Update Commander registration to use metadata constants**

In `packages/core/src/cli.ts`, import:

```ts
import { cliCommands } from "./cli/commands";
```

Replace each top-level `.command("...")` string with its metadata constant, for example:

```ts
program.command(cliCommands.completion);
program.command(cliCommands.completeHidden, { hidden: true });
program.command(cliCommands.serve);
program.command(cliCommands.callTool);
```

For grouped commands:

```ts
const add = program.command(cliCommands.add).description("Add generated Caplet files.");
const config = program.command(cliCommands.config).description("Inspect Caplets config locations.");
const auth = program
  .command(cliCommands.auth)
  .description("Manage OAuth credentials for remote servers.");
```

- [ ] **Step 6: Verify metadata refactor**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit metadata refactor**

```sh
git add packages/core/src/cli/commands.ts packages/core/src/cli/completion.ts packages/core/src/cli.ts packages/core/test/cli-completion.test.ts
git commit -m "refactor(cli): share completion command metadata"
```

---

## Task 2: Add completion config defaults and platform cache paths

**Files:**

- Modify: `packages/core/src/config/paths.ts`
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`
- Test: `packages/core/test/config-paths.test.ts` if present, otherwise add path tests to `packages/core/test/config.test.ts`
- Generated: `schemas/caplets-config.schema.json`

- [ ] **Step 1: Write failing config tests**

Add assertions that parsing an otherwise minimal config includes completion defaults:

```ts
expect(config.options.completion).toEqual({
  discoveryTimeoutMs: 750,
  overallTimeoutMs: 1500,
  cacheTtlMs: 300_000,
  negativeCacheTtlMs: 30_000,
});
```

Add an override test:

```ts
const config = parseConfig({
  version: 1,
  completion: {
    discoveryTimeoutMs: 250,
    overallTimeoutMs: 1000,
    cacheTtlMs: 60_000,
    negativeCacheTtlMs: 10_000,
  },
  mcpServers: {},
});
expect(config.options.completion.discoveryTimeoutMs).toBe(250);
```

Add path tests:

```ts
expect(defaultCacheBaseDir({ XDG_CACHE_HOME: "/tmp/cache" }, "/home/alice", "linux")).toBe(
  "/tmp/cache",
);
expect(defaultCacheBaseDir({}, "/Users/alice", "darwin")).toBe("/Users/alice/Library/Caches");
expect(
  defaultCacheBaseDir(
    { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
    "C:\\Users\\Alice",
    "win32",
  ),
).toBe("C:\\Users\\Alice\\AppData\\Local");
```

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/config.test.ts
```

Expected: FAIL because `completion` config and cache path helpers do not exist yet.

- [ ] **Step 3: Add path helpers**

In `packages/core/src/config/paths.ts`, add:

```ts
export function defaultCacheBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32.join(home, "AppData", "Local");
  }

  if (platform === "darwin") {
    return posix.join(home, "Library", "Caches");
  }

  return env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : posix.join(home, ".cache");
}

export function defaultCompletionCacheDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "completions");
}

export const DEFAULT_COMPLETION_CACHE_DIR = defaultCompletionCacheDir();
```

Export `DEFAULT_COMPLETION_CACHE_DIR`, `defaultCacheBaseDir`, and `defaultCompletionCacheDir` from `packages/core/src/config.ts`.

- [ ] **Step 4: Add completion config schema**

In `packages/core/src/config.ts`, add:

```ts
export type CompletionConfig = {
  discoveryTimeoutMs: number;
  overallTimeoutMs: number;
  cacheTtlMs: number;
  negativeCacheTtlMs: number;
};
```

Change `CapletsOptions`:

```ts
export type CapletsOptions = {
  defaultSearchLimit: number;
  maxSearchLimit: number;
  completion: CompletionConfig;
};
```

Add schema:

```ts
const completionConfigSchema = z
  .object({
    discoveryTimeoutMs: z.number().int().positive().default(750),
    overallTimeoutMs: z.number().int().positive().default(1500),
    cacheTtlMs: z.number().int().nonnegative().default(300_000),
    negativeCacheTtlMs: z.number().int().nonnegative().default(30_000),
  })
  .strict()
  .default({});
```

Add `completion: completionConfigSchema` to the top-level config object and return it in `parseConfig`:

```ts
options: {
  defaultSearchLimit: parsed.data.defaultSearchLimit,
  maxSearchLimit: parsed.data.maxSearchLimit,
  completion: parsed.data.completion,
},
```

- [ ] **Step 5: Generate config schema**

Run:

```sh
pnpm schema:generate
```

Expected: `schemas/caplets-config.schema.json` changes to include `completion`.

- [ ] **Step 6: Verify config changes**

```sh
pnpm --filter @caplets/core test -- test/config.test.ts
pnpm schema:check
```

Expected: PASS.

- [ ] **Step 7: Commit config changes**

```sh
git add packages/core/src/config.ts packages/core/src/config/paths.ts packages/core/test/config.test.ts schemas/caplets-config.schema.json
git commit -m "feat(cli): configure completion discovery cache"
```

---

## Task 3: Implement secret-free persistent completion cache

**Files:**

- Create: `packages/core/src/cli/completion-cache.ts`
- Test: `packages/core/test/cli-completion-cache.test.ts`

- [ ] **Step 1: Write cache tests**

Create `packages/core/test/cli-completion-cache.test.ts` with tests for fresh, stale, negative, and secret-free behavior:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completionCacheKey,
  readCompletionCacheEntry,
  writeCompletionCacheEntry,
} from "../src/cli/completion-cache";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("completion cache", () => {
  it("round-trips fresh positive entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "repo",
      backend: "cli",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "positive",
      fetchedAt: 1000,
      expiresAt: 2000,
      candidates: [{ value: "repo.status" }],
    });
    expect(readCompletionCacheEntry(dir, key, 1500)).toEqual(
      expect.objectContaining({ status: "positive", fresh: true }),
    );
  });

  it("marks expired entries as stale instead of deleting usable candidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "repo",
      backend: "cli",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "positive",
      fetchedAt: 1000,
      expiresAt: 2000,
      candidates: [{ value: "repo.status" }],
    });
    expect(readCompletionCacheEntry(dir, key, 2500)).toEqual(
      expect.objectContaining({ status: "positive", fresh: false }),
    );
  });

  it("stores negative entries without candidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "github",
      backend: "mcp",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "negative",
      fetchedAt: 1000,
      expiresAt: 2000,
      reason: "auth_required",
    });
    expect(readCompletionCacheEntry(dir, key, 1500)).toEqual(
      expect.objectContaining({ status: "negative", fresh: true, reason: "auth_required" }),
    );
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/cli-completion-cache.test.ts
```

Expected: FAIL because cache module is missing.

- [ ] **Step 3: Implement cache module**

Create `packages/core/src/cli/completion-cache.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompletionDiscoveryKind = "tools" | "prompts" | "resources" | "resourceTemplates";

export type CompletionCandidate = {
  value: string;
  label?: string | undefined;
  description?: string | undefined;
};

export type CompletionCacheKeyInput = {
  server: string;
  backend: string;
  kind: CompletionDiscoveryKind;
  fingerprint: string;
};

export type CompletionCacheEntry =
  | {
      status: "positive";
      fetchedAt: number;
      expiresAt: number;
      candidates: CompletionCandidate[];
    }
  | {
      status: "negative";
      fetchedAt: number;
      expiresAt: number;
      reason: "auth_required" | "timeout" | "unavailable" | "unsupported" | "error";
    };

export type ReadCompletionCacheEntry = CompletionCacheEntry & { fresh: boolean };

export function completionCacheKey(input: CompletionCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readCompletionCacheEntry(
  cacheDir: string,
  key: string,
  now = Date.now(),
): ReadCompletionCacheEntry | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(cachePath(cacheDir, key), "utf8"),
    ) as CompletionCacheEntry;
    if (parsed.status === "positive" && Array.isArray(parsed.candidates)) {
      return { ...parsed, fresh: now <= parsed.expiresAt };
    }
    if (parsed.status === "negative" && typeof parsed.reason === "string") {
      return { ...parsed, fresh: now <= parsed.expiresAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function writeCompletionCacheEntry(
  cacheDir: string,
  key: string,
  entry: CompletionCacheEntry,
): void {
  mkdirSync(cacheDir, { recursive: true });
  const path = cachePath(cacheDir, key);
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tempPath, path);
}

function cachePath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}
```

- [ ] **Step 4: Verify cache tests**

```sh
pnpm --filter @caplets/core test -- test/cli-completion-cache.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit cache module**

```sh
git add packages/core/src/cli/completion-cache.ts packages/core/test/cli-completion-cache.test.ts
git commit -m "feat(cli): add persistent completion cache"
```

---

## Task 4: Add cache-backed completion discovery orchestration

**Files:**

- Create: `packages/core/src/cli/completion-discovery.ts`
- Modify: `packages/core/src/cli/completion.ts`
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/test/cli-completion.test.ts`

- [ ] **Step 1: Write failing qualified target tests**

In `packages/core/test/cli-completion.test.ts`, add tests for config-defined qualified targets:

```ts
it("suggests config-defined tool names for qualified CLI and HTTP targets", async () => {
  const { dir, configPath } = writeCompletionConfig({
    cliTools: {
      repo: {
        name: "Repo",
        description: "Run repository maintenance commands.",
        actions: {
          status: {
            description: "Print repository status.",
            command: process.execPath,
            args: ["--version"],
          },
          build: {
            description: "Build the repository.",
            command: process.execPath,
            args: ["--version"],
          },
        },
      },
    },
    httpApis: {
      status_api: {
        name: "Status API",
        description: "Check service status through HTTP actions.",
        baseUrl: "https://api.example.com",
        auth: { type: "none" },
        actions: { check: { method: "GET", path: "/status" } },
      },
    },
  });
  dirs.push(dir);

  await expect(completeCliWords(["call-tool", "repo."], { configPath })).resolves.toEqual([
    "repo.status",
    "repo.build",
  ]);
  await expect(completeCliWords(["get-tool", "status_api."], { configPath })).resolves.toEqual([
    "status_api.check",
  ]);
});
```

Update existing synchronous `completeCliWords(...)` tests to `await completeCliWords(...)` if the resolver becomes async.

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: FAIL because `completeCliWords` does not yet return qualified tool names.

- [ ] **Step 3: Implement discovery function signatures**

Create `packages/core/src/cli/completion-discovery.ts` with public entry points:

```ts
import type { CapletConfig, CapletsConfig, CompletionConfig } from "../config";
import type { CompletionDiscoveryKind, CompletionCandidate } from "./completion-cache";

export type CompletionDiscoveryManagers = {
  listTools?: (server: CapletConfig) => Promise<Array<{ name: string; description?: string }>>;
  listPrompts?: (server: CapletConfig) => Promise<Array<{ name: string; description?: string }>>;
  listResources?: (
    server: CapletConfig,
  ) => Promise<Array<{ uri: string; name?: string; description?: string }>>;
  listResourceTemplates?: (
    server: CapletConfig,
  ) => Promise<Array<{ uriTemplate: string; name?: string; description?: string }>>;
};

export type CompletionDiscoveryOptions = {
  config: CapletsConfig;
  cacheDir?: string | undefined;
  managers?: CompletionDiscoveryManagers | undefined;
  now?: number | undefined;
};

export async function discoverCompletionCandidates(
  serverId: string,
  kind: CompletionDiscoveryKind,
  options: CompletionDiscoveryOptions,
): Promise<CompletionCandidate[]> {
  // Implement in later steps.
  return configDefinedCandidates(serverId, kind, options.config);
}
```

- [ ] **Step 4: Add config-defined candidates**

Implement `configDefinedCandidates`:

```ts
function configDefinedCandidates(
  serverId: string,
  kind: CompletionDiscoveryKind,
  config: CapletsConfig,
): CompletionCandidate[] {
  if (kind !== "tools") return [];
  const cli = config.cliTools[serverId];
  if (cli && !cli.disabled) {
    return Object.keys(cli.actions).map((name) => ({ value: `${serverId}.${name}` }));
  }
  const http = config.httpApis[serverId];
  if (http && !http.disabled) {
    return Object.keys(http.actions).map((name) => ({ value: `${serverId}.${name}` }));
  }
  const graphql = config.graphqlEndpoints[serverId];
  if (graphql && !graphql.disabled && graphql.operations) {
    return Object.keys(graphql.operations).map((name) => ({ value: `${serverId}.${name}` }));
  }
  return [];
}
```

- [ ] **Step 5: Wire async resolver for qualified tool/prompt contexts**

In `packages/core/src/cli/completion.ts`, change:

```ts
export async function completeCliWords(words: string[], options: CompletionOptions = {}): Promise<string[]> {
```

When context is `call-tool` or `get-tool` and the current token contains a dot, split the server prefix and call `discoverCompletionCandidates(serverId, "tools", ...)`. Filter returned values by full prefix.

When context is `get-prompt` and the current token contains a dot, call `discoverCompletionCandidates(serverId, "prompts", ...)`.

For existing top-level/static cases, return immediately as before. Update CLI call sites to `await completeCliWords(...)`.

- [ ] **Step 6: Add engine-owned discovery manager wiring**

In `packages/core/src/engine.ts`, add:

```ts
async completeCliWords(words: string[]): Promise<string[]> {
  const { completeCliWords } = await import("./cli/completion");
  return await completeCliWords(words, {
    config: this.registry.config,
    managers: {
      listTools: async (server) => {
        const result = await handleServerTool(
          server,
          { operation: "list_tools" },
          this.registry,
          this.downstream,
          this.openapi,
          this.graphql,
          this.http,
          this.cli,
          this.capletSets,
        );
        return result?.structuredContent?.result?.tools?.map((tool: { tool: string; description?: string }) => ({
          name: tool.tool,
          description: tool.description,
        })) ?? [];
      },
      listPrompts: async (server) => {
        if (server.backend !== "mcp") return [];
        return (await this.downstream.listPrompts(server)).map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
        }));
      },
      listResources: async (server) => {
        if (server.backend !== "mcp") return [];
        return (await this.downstream.listResources(server)).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
        }));
      },
      listResourceTemplates: async (server) => {
        if (server.backend !== "mcp") return [];
        return (await this.downstream.listResourceTemplates(server)).map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
          description: template.description,
        }));
      },
    },
  });
}
```

During implementation, prefer direct manager calls over parsing `handleServerTool` results where practical; the snippet above documents the shape and fallback behavior.

- [ ] **Step 7: Verify qualified config-defined completion**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit discovery orchestration base**

```sh
git add packages/core/src/cli/completion.ts packages/core/src/cli/completion-discovery.ts packages/core/src/engine.ts packages/core/test/cli-completion.test.ts packages/core/test/cli.test.ts
git commit -m "feat(cli): complete qualified configured targets"
```

---

## Task 5: Add live discovery, persistent cache, and timeout behavior

**Files:**

- Modify: `packages/core/src/cli/completion-discovery.ts`
- Modify: `packages/core/src/cli/completion.ts`
- Test: `packages/core/test/cli-completion.test.ts`
- Test: `packages/core/test/cli-completion-cache.test.ts`

- [ ] **Step 1: Write tests for cache-first and timeout fallback**

Add tests that pass fake managers:

```ts
it("uses cached discovered tool names when live discovery times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
  dirs.push(dir);
  const { configPath } = writeMcpConfig(dir, "github");

  await completeCliWords(["call-tool", "github."], {
    configPath,
    cacheDir: dir,
    managers: {
      listTools: async () => [{ name: "search" }],
    },
  });

  await expect(
    completeCliWords(["call-tool", "github."], {
      configPath,
      cacheDir: dir,
      managers: {
        listTools: async () => await new Promise(() => {}),
      },
      completion: {
        discoveryTimeoutMs: 10,
        overallTimeoutMs: 20,
        cacheTtlMs: 0,
        negativeCacheTtlMs: 30_000,
      },
    }),
  ).resolves.toEqual(["github.search"]);
});
```

Add a negative-cache test that verifies a failing manager is not called again until TTL expiry.

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts test/cli-completion-cache.test.ts
```

Expected: FAIL until discovery cache is wired.

- [ ] **Step 3: Implement fingerprints**

In `completion-discovery.ts`, implement a secret-free fingerprint function:

```ts
function completionFingerprint(
  server: CapletConfig,
  kind: CompletionDiscoveryKind,
  completion: CompletionConfig,
): string {
  return JSON.stringify({
    kind,
    completion: {
      discoveryTimeoutMs: completion.discoveryTimeoutMs,
      cacheTtlMs: completion.cacheTtlMs,
      negativeCacheTtlMs: completion.negativeCacheTtlMs,
    },
    server: secretFreeServerShape(server),
  });
}
```

`secretFreeServerShape` must include only the fields listed in the spec and must not include env values, auth token/header values, or response data.

- [ ] **Step 4: Implement timeout helper**

Add:

```ts
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("completion discovery timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

- [ ] **Step 5: Implement cache-backed discovery flow**

In `discoverCompletionCandidates`:

1. Find enabled server by ID.
2. Build cache key from server/backend/kind/fingerprint.
3. Read cache entry.
4. Return fresh positive cache immediately.
5. Return static/config candidates immediately if fresh negative cache exists.
6. Attempt live discovery with `Math.min(discoveryTimeoutMs, remainingOverallBudget)`.
7. On success, write positive cache and return discovered candidates plus config-defined candidates, deduped.
8. On failure/timeout, write negative cache and return stale positive candidates if available, otherwise config-defined candidates.

- [ ] **Step 6: Implement live manager selection**

Add:

```ts
async function liveCandidates(
  server: CapletConfig,
  kind: CompletionDiscoveryKind,
  managers: CompletionDiscoveryManagers | undefined,
): Promise<CompletionCandidate[]> {
  if (kind === "tools" && managers?.listTools) {
    return (await managers.listTools(server)).map((tool) => ({
      value: `${server.server}.${tool.name}`,
      description: tool.description,
    }));
  }
  if (server.backend !== "mcp") return [];
  if (kind === "prompts" && managers?.listPrompts) {
    return (await managers.listPrompts(server)).map((prompt) => ({
      value: `${server.server}.${prompt.name}`,
      description: prompt.description,
    }));
  }
  if (kind === "resources" && managers?.listResources) {
    return (await managers.listResources(server)).map((resource) => ({
      value: resource.uri,
      label: resource.name,
      description: resource.description,
    }));
  }
  if (kind === "resourceTemplates" && managers?.listResourceTemplates) {
    return (await managers.listResourceTemplates(server)).map((template) => ({
      value: template.uriTemplate,
      label: template.name,
      description: template.description,
    }));
  }
  return [];
}
```

- [ ] **Step 7: Verify cache/live behavior**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts test/cli-completion-cache.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit cache-backed live discovery**

```sh
git add packages/core/src/cli/completion-discovery.ts packages/core/src/cli/completion.ts packages/core/test/cli-completion.test.ts packages/core/test/cli-completion-cache.test.ts
git commit -m "feat(cli): cache live completion discovery"
```

---

## Task 6: Complete resources, templates, and `complete` option contexts

**Files:**

- Modify: `packages/core/src/cli/completion.ts`
- Modify: `packages/core/src/cli/completion-discovery.ts`
- Test: `packages/core/test/cli-completion.test.ts`

- [ ] **Step 1: Write tests for MCP resource/prompt contexts**

Add tests:

```ts
it("suggests resource URIs for read-resource after a selected backend", async () => {
  const { dir, configPath } = writeMcpConfigWithDir("docs");
  dirs.push(dir);
  await expect(
    completeCliWords(["read-resource", "docs", "file://"], {
      configPath,
      managers: { listResources: async () => [{ uri: "file:///repo/README.md" }] },
    }),
  ).resolves.toEqual(["file:///repo/README.md"]);
});

it("suggests prompt and resource-template option values for complete", async () => {
  const { dir, configPath } = writeMcpConfigWithDir("docs");
  dirs.push(dir);
  await expect(
    completeCliWords(["complete", "docs", "--prompt", ""], {
      configPath,
      managers: { listPrompts: async () => [{ name: "summarize" }] },
    }),
  ).resolves.toEqual(["summarize"]);
  await expect(
    completeCliWords(["complete", "docs", "--resource-template", "file://"], {
      configPath,
      managers: { listResourceTemplates: async () => [{ uriTemplate: "file:///repo/{path}" }] },
    }),
  ).resolves.toEqual(["file:///repo/{path}"]);
});
```

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: FAIL until option context support is implemented.

- [ ] **Step 3: Implement read-resource positional completion**

In `completeCliWords`:

```ts
if (command === cliCommands.readResource && normalized.length === 3) {
  return prefixFilter(
    (await discoverCompletionCandidates(subcommand, "resources", discoveryOptions(options))).map(
      (candidate) => candidate.value,
    ),
    current,
  );
}
```

- [ ] **Step 4: Implement complete option context discovery**

When `previous === "--prompt"` and `command === "complete"`, discover `prompts` for `normalized[1]`. When `previous === "--resource-template"`, discover `resourceTemplates` for `normalized[1]`.

```ts
if (command === cliCommands.complete && previous === "--prompt" && subcommand) {
  return prefixFilter(
    (await discoverCompletionCandidates(subcommand, "prompts", discoveryOptions(options))).map(
      (candidate) => candidate.value.replace(`${subcommand}.`, ""),
    ),
    current,
  );
}
```

Resource-template values should be returned as raw URI templates, not `server.template` qualified names, because the CLI option accepts the URI template only.

- [ ] **Step 5: Verify broader contexts**

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit resource/template completion**

```sh
git add packages/core/src/cli/completion.ts packages/core/src/cli/completion-discovery.ts packages/core/test/cli-completion.test.ts
git commit -m "feat(cli): complete MCP resources and prompts"
```

---

## Task 7: Route remote completions through server-owned discovery

**Files:**

- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/remote-control/dispatch.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts`
- Test: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Write failing remote discovery test**

In `packages/core/test/remote-control-dispatch.test.ts`, add a context with CLI/HTTP config actions and assert `complete_cli` returns qualified tool names:

```ts
it("routes complete_cli through server-owned discovery", async () => {
  const context = testContext();
  const response = await dispatchRemoteCliRequest(
    {
      command: "complete_cli",
      arguments: { shell: "bash", words: ["call-tool", "server_status."] },
    },
    context,
  );
  expect(response).toMatchObject({ ok: true });
  expect(response.ok && response.result).toEqual(["server_status.check"]);
});
```

- [ ] **Step 2: Run tests and verify failure**

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/cli-remote.test.ts
```

Expected: FAIL until `complete_cli` uses `CapletsEngine.completeCliWords`.

- [ ] **Step 3: Update remote dispatch**

In `packages/core/src/remote-control/dispatch.ts`, change the `complete_cli` branch:

```ts
if (request.command === "complete_cli") {
  const shell = optionalString(request.arguments, "shell") ?? "bash";
  if (!completionShells.includes(shell as CompletionShell)) return [];
  const engine = new CapletsEngine(context);
  try {
    return await engine.completeCliWords(optionalStringArray(request.arguments, "words") ?? [""]);
  } finally {
    await engine.close();
  }
}
```

- [ ] **Step 4: Ensure remote client failures remain quiet**

Keep the `try/catch` around `remote.request("complete_cli", ...)` in `cli.ts`. Confirm `packages/core/test/cli-remote.test.ts` still has the quiet-failure test.

- [ ] **Step 5: Verify remote completion**

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/cli-remote.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit remote discovery routing**

```sh
git add packages/core/src/engine.ts packages/core/src/remote-control/dispatch.ts packages/core/test/remote-control-dispatch.test.ts packages/core/test/cli-remote.test.ts
git commit -m "feat(cli): discover completions on remote server"
```

---

## Task 8: Update docs and changeset

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `.changeset/cli-completions.md`

- [ ] **Step 1: Update README completion behavior notes**

Add a paragraph after the existing shell completion install snippets:

```md
Completions include command names, options, common enum values, configured Caplet IDs, and cache-backed downstream names for qualified targets such as `caplets call-tool repo.<TAB>`. Downstream discovery is bounded by the `completion` config timeouts and a platform-native cache directory. Generated shell scripts suppress completion stderr; run the underlying CLI command directly when debugging completion behavior.
```

Add config example:

```json
{
  "completion": {
    "discoveryTimeoutMs": 750,
    "overallTimeoutMs": 1500,
    "cacheTtlMs": 300000,
    "negativeCacheTtlMs": 30000
  }
}
```

Mention auth:

```md
Backends that require OAuth or token auth may need `caplets auth login <server>` before live downstream completions can return richer results. Completion never starts interactive login flows.
```

- [ ] **Step 2: Mirror package README**

Apply the same README changes to `packages/cli/README.md` if it is committed independently.

- [ ] **Step 3: Update changeset**

Change `.changeset/cli-completions.md` body to:

```md
Add Bash, Zsh, Fish, PowerShell, and cmd shell completion generation plus config-aware and cache-backed downstream completion suggestions for the Caplets CLI.
```

- [ ] **Step 4: Verify docs formatting**

```sh
pnpm format:check
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

```sh
git add README.md packages/cli/README.md .changeset/cli-completions.md
git commit -m "docs(cli): describe cache-backed completions"
```

---

## Task 9: Final verification and push

**Files:**

- All changed implementation, tests, docs, schema, and changeset files.

- [ ] **Step 1: Run full verification**

```sh
pnpm verify
```

Expected:

- format check passes
- lint passes
- typecheck passes
- schema check passes
- all Vitest tests pass
- benchmark check passes
- build passes

- [ ] **Step 2: Inspect working tree**

```sh
git status --short
git diff --stat
```

Expected: no unstaged implementation/doc changes. `.brv` may be modified by ByteRover; stage only if the existing hook/workflow requires it.

- [ ] **Step 3: Push branch**

```sh
git push
```

Expected: `feat/cli-completions` is updated on PR #71.

- [ ] **Step 4: Check PR status**

```sh
gh pr view 71 --json url,headRefOid,statusCheckRollup
```

Expected: PR points at the final pushed commit and CI has started or passed.

---

## Self-review checklist

- Spec coverage: shared metadata, platform cache path, config defaults, persistent cache, stale/negative cache behavior, qualified tool/prompt/resource/template completions, remote server ownership, docs, schema, and verification are all mapped to tasks.
- Placeholder scan: no implementation step depends on `TODO` or unspecified behavior; every task has concrete files, commands, and expected results.
- Type consistency: `CompletionShell`, `CompletionDiscoveryKind`, `CompletionCandidate`, `CompletionConfig`, `completeCliWords`, and `discoverCompletionCandidates` names are consistent across tasks.
