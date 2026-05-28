# HTTP MCP Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Hono-based Streamable HTTP MCP serving to `caplets serve` with optional Basic Auth, while making no-arg `caplets` show help.

**Architecture:** Refactor MCP tool registration/reload reconciliation into a reusable `CapletsMcpSession` that shares one `CapletsEngine` across stdio and HTTP sessions. Stdio creates one session and connects it to `StdioServerTransport`; HTTP creates a Hono app, routes each `Mcp-Session-Id` to a per-session `@hono/mcp` `StreamableHTTPTransport`, and keeps all sessions backed by the same engine.

**Tech Stack:** TypeScript, Commander, Vitest, MCP SDK, Hono, `@hono/node-server`, `@hono/mcp`, pnpm.

---

## File structure

- Modify `packages/core/package.json` to add direct Hono dependencies.
- Create `packages/core/src/serve/session.ts` for reusable MCP server/session registration and reload reconciliation.
- Modify `packages/core/src/runtime.ts` so `CapletsRuntime` delegates to `CapletsMcpSession` and preserves its public API.
- Create `packages/core/src/serve/options.ts` for serve option normalization, validation, auth resolution, path normalization, and loopback detection.
- Create `packages/core/src/serve/stdio.ts` for stdio serve orchestration.
- Create `packages/core/src/serve/http.ts` for Hono routes, Basic Auth middleware, MCP session map, DNS rebinding transport options, startup logs, and shutdown cleanup.
- Create `packages/core/src/serve/index.ts` to expose `serveCaplets`, `serveStdio`, `serveHttp`, and option types.
- Modify `packages/core/src/cli.ts` to add `serve`, no-arg help, and a test-injectable serve runner.
- Modify `packages/cli/src/index.ts` to always delegate to `runCli`.
- Add `packages/core/test/serve-options.test.ts` for option validation and auth resolution.
- Add `packages/core/test/serve-session.test.ts` for shared session tool reconciliation.
- Add `packages/core/test/serve-http.test.ts` for Hono route/auth/session behavior.
- Modify `packages/core/test/cli.test.ts` for no-arg help and `serve` command parsing through injected runner.
- Keep `packages/core/test/runtime.test.ts` passing as compatibility coverage.

---

### Task 1: Add Hono dependencies

**Files:**

- Modify: `packages/core/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add dependencies with pnpm**

Run:

```bash
pnpm --filter @caplets/core add @hono/mcp@^0.3.0 @hono/node-server@^1.19.9 hono@^4.11.5
```

Expected: `packages/core/package.json` contains the three new dependencies and `pnpm-lock.yaml` is updated.

- [ ] **Step 2: Verify package manifest**

Check `packages/core/package.json` contains this dependency block shape:

```json
{
  "dependencies": {
    "@apidevtools/swagger-parser": "^12.1.0",
    "@hono/mcp": "^0.3.0",
    "@hono/node-server": "^1.19.9",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "commander": "^14.0.3",
    "graphql": "^16.14.0",
    "hono": "^4.11.5",
    "vfile": "^6.0.3",
    "vfile-matter": "^5.0.1",
    "zod": "^4.4.3"
  }
}
```

The exact order may be adjusted by the package manager, but all three Hono dependencies must be direct dependencies.

- [ ] **Step 3: Commit dependency change**

Run:

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add Hono MCP dependencies"
```

---

### Task 2: Extract reusable MCP session wrapper

**Files:**

- Create: `packages/core/src/serve/session.ts`
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/test/serve-session.test.ts`
- Existing test: `packages/core/test/runtime.test.ts`

- [ ] **Step 1: Write failing session tests**

Create `packages/core/test/serve-session.test.ts`:

```ts
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
    expect(server.registerTool).toHaveBeenCalledTimes(1);

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
    expect(session.registeredToolIds()).toEqual(["gamma"]);
    expect(server.registered.get("gamma")).toBeDefined();

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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-session.test.ts
```

Expected: FAIL because `../src/serve/session` does not exist.

- [ ] **Step 3: Implement `CapletsMcpSession`**

Create `packages/core/src/serve/session.ts`:

```ts
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { version as packageJsonVersion } from "../../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import { CapletsEngine } from "../engine";
import { capabilityDescription } from "../registry";
import { generatedToolInputSchema } from "../tools";

export type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

export type CapletsMcpSessionOptions = {
  server?: ToolServer;
};

export class CapletsMcpSession {
  readonly server: ToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribeReload: () => void;
  private closed = false;

  constructor(
    private readonly engine: CapletsEngine,
    options: CapletsMcpSessionOptions = {},
  ) {
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.unsubscribeReload = this.engine.onReload(({ previous, next }) =>
      this.reconcileTools(previous, next),
    );
    this.reconcileTools(undefined, this.engine.currentConfig());
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeReload();
    this.tools.clear();
    await this.server.close();
  }

  private reconcileTools(previous: CapletsConfig | undefined, next: CapletsConfig): void {
    const enabled = new Map(nextEnabledServers(next).map((server) => [server.server, server]));

    for (const [serverId, tool] of this.tools) {
      const caplet = enabled.get(serverId);
      if (!caplet) {
        tool.remove();
        this.tools.delete(serverId);
        continue;
      }

      const previousCaplet = previous ? capletById(previous, serverId) : undefined;
      if (!previousCaplet || serializeCaplet(previousCaplet) !== serializeCaplet(caplet)) {
        tool.update({
          title: caplet.name,
          description: capabilityDescription(caplet),
          callback: async (request) => this.handleTool(serverId, request),
          enabled: true,
        });
      }
    }

    for (const caplet of enabled.values()) {
      if (this.tools.has(caplet.server)) {
        continue;
      }
      this.tools.set(caplet.server, this.registerCapletTool(caplet));
    }
  }

  private registerCapletTool(caplet: CapletConfig): RegisteredTool {
    return this.server.registerTool(
      caplet.server,
      {
        title: caplet.name,
        description: capabilityDescription(caplet),
        inputSchema: generatedToolInputSchema,
      },
      async (request) => this.handleTool(caplet.server, request),
    );
  }

  private async handleTool(serverId: string, request: unknown): Promise<any> {
    return await this.engine.execute(serverId, request);
  }
}

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ].filter((server) => !server.disabled);
}

function capletById(config: CapletsConfig, serverId: string): CapletConfig | undefined {
  return (
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.graphqlEndpoints[serverId] ??
    config.httpApis[serverId] ??
    config.cliTools[serverId] ??
    config.capletSets[serverId]
  );
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}
```

- [ ] **Step 4: Refactor `CapletsRuntime` to delegate to the session wrapper**

Replace `packages/core/src/runtime.ts` with:

```ts
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { type CapletsConfig } from "./config";
import { CapletsEngine, type CapletsEngineOptions } from "./engine";
import { CapletsMcpSession, type ToolServer } from "./serve/session";

type CapletsRuntimeOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  server?: ToolServer;
  writeErr?: (value: string) => void;
};

export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly session: CapletsMcpSession;

  constructor(options: CapletsRuntimeOptions = {}) {
    this.engine = new CapletsEngine(engineOptions(options));
    this.session = new CapletsMcpSession(this.engine, selectSessionOptions(options));
    this.server = this.session.server;
  }

  async connect(transport: Transport): Promise<void> {
    await this.session.connect(transport);
  }

  scheduleReload(): void {
    this.engine.scheduleReload();
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  async close(): Promise<void> {
    try {
      await this.session.close();
    } finally {
      await this.engine.close();
    }
  }

  currentConfig(): CapletsConfig {
    return this.engine.currentConfig();
  }

  registeredToolIds(): string[] {
    return this.session.registeredToolIds();
  }

  watchedPaths(): string[] {
    return this.engine.watchedPaths();
  }
}

function selectSessionOptions(options: CapletsRuntimeOptions): { server?: ToolServer } {
  return options.server === undefined ? {} : { server: options.server };
}

function engineOptions(options: CapletsRuntimeOptions): CapletsEngineOptions {
  const engineOptions: CapletsEngineOptions = {};
  if (options.configPath !== undefined) {
    engineOptions.configPath = options.configPath;
  }
  if (options.projectConfigPath !== undefined) {
    engineOptions.projectConfigPath = options.projectConfigPath;
  }
  if (options.authDir !== undefined) {
    engineOptions.authDir = options.authDir;
  }
  if (options.watchDebounceMs !== undefined) {
    engineOptions.watchDebounceMs = options.watchDebounceMs;
  }
  if (options.writeErr !== undefined) {
    engineOptions.writeErr = options.writeErr;
  }
  return engineOptions;
}
```

- [ ] **Step 5: Run session and runtime tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-session.test.ts test/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit session refactor**

Run:

```bash
git add packages/core/src/serve/session.ts packages/core/src/runtime.ts packages/core/test/serve-session.test.ts
git commit -m "refactor(core): share MCP session registration"
```

---

### Task 3: Add serve option normalization

**Files:**

- Create: `packages/core/src/serve/options.ts`
- Test: `packages/core/test/serve-options.test.ts`

- [ ] **Step 1: Write failing option tests**

Create `packages/core/test/serve-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveServeOptions } from "../src/serve/options";

describe("resolveServeOptions", () => {
  it("defaults serve to stdio", () => {
    expect(resolveServeOptions({}, {})).toEqual({ transport: "stdio" });
  });

  it("defaults HTTP serving to localhost port 5387 and /mcp", () => {
    expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/mcp",
      auth: { enabled: false, user: "caplets" },
    });
  });

  it("normalizes trailing slashes in HTTP path", () => {
    expect(resolveServeOptions({ transport: "http", path: "/custom/" }, {})).toMatchObject({
      transport: "http",
      path: "/custom",
    });
  });

  it("resolves Basic Auth from password with default user", () => {
    const testPassword = ["test", "password"].join("-");

    expect(resolveServeOptions({ transport: "http", password: testPassword }, {})).toMatchObject({
      transport: "http",
      auth: { enabled: true, user: "caplets", password: testPassword },
    });
  });

  it("resolves Basic Auth from env and lets flags win", () => {
    const envPassword = ["test", "env", "password"].join("-");

    expect(
      resolveServeOptions(
        { transport: "http", user: "cli-user" },
        { CAPLETS_SERVER_USER: "env-user", CAPLETS_SERVER_PASSWORD: envPassword },
      ),
    ).toMatchObject({
      transport: "http",
      auth: { enabled: true, user: "cli-user", password: envPassword },
    });
  });

  it("rejects explicit user without password", () => {
    expect(() => resolveServeOptions({ transport: "http", user: "alice" }, {})).toThrow(
      /requires a password/u,
    );
  });

  it("rejects HTTP-only options for stdio", () => {
    expect(() => resolveServeOptions({ transport: "stdio", host: "127.0.0.1" }, {})).toThrow(
      /only valid with --transport http/u,
    );
  });

  it("rejects invalid port and path", () => {
    expect(() => resolveServeOptions({ transport: "http", port: "0" }, {})).toThrow(
      /valid TCP port/u,
    );
    expect(() => resolveServeOptions({ transport: "http", path: "mcp" }, {})).toThrow(
      /must start with/u,
    );
    expect(() => resolveServeOptions({ transport: "http", path: "/mcp?x=1" }, {})).toThrow(
      /query string/u,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-options.test.ts
```

Expected: FAIL because `../src/serve/options` does not exist.

- [ ] **Step 3: Implement `serve/options.ts`**

Create `packages/core/src/serve/options.ts`:

```ts
import { CapletsError } from "../errors";

export type ServeTransport = "stdio" | "http";

export type RawServeOptions = {
  transport?: string;
  host?: string;
  port?: string | number;
  path?: string;
  user?: string;
  password?: string;
};

export type StdioServeOptions = {
  transport: "stdio";
};

export type HttpServeOptions = {
  transport: "http";
  host: string;
  port: number;
  path: string;
  auth: HttpBasicAuthOptions;
  warnUnauthenticatedNetwork: boolean;
  loopback: boolean;
};

export type HttpBasicAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ServeOptions = StdioServeOptions | HttpServeOptions;

export type ServeEnv = Partial<Record<"CAPLETS_SERVER_USER" | "CAPLETS_SERVER_PASSWORD", string>>;

const HTTP_ONLY_OPTIONS = ["host", "port", "path", "user", "password"] as const;

export function resolveServeOptions(
  raw: RawServeOptions,
  env: ServeEnv = process.env,
): ServeOptions {
  const transport = parseTransport(raw.transport ?? "stdio");
  if (transport === "stdio") {
    const invalid = HTTP_ONLY_OPTIONS.filter((key) => raw[key] !== undefined);
    if (invalid.length > 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `${invalid.map((key) => `--${key}`).join(", ")} ${invalid.length === 1 ? "is" : "are"} only valid with --transport http`,
      );
    }
    return { transport };
  }

  const host = nonEmpty(raw.host, "--host") ?? "127.0.0.1";
  const port = parsePort(raw.port ?? 5387);
  const path = normalizeHttpPath(raw.path ?? "/mcp");
  const userWasExplicit = raw.user !== undefined || hasEnv(env.CAPLETS_SERVER_USER);
  const user =
    nonEmpty(raw.user, "--user") ??
    nonEmpty(env.CAPLETS_SERVER_USER, "CAPLETS_SERVER_USER") ??
    "caplets";
  const password =
    nonEmpty(raw.password, "--password") ??
    nonEmpty(env.CAPLETS_SERVER_PASSWORD, "CAPLETS_SERVER_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "HTTP Basic Auth requires a password; pass --password or set CAPLETS_SERVER_PASSWORD.",
    );
  }

  const loopback = isLoopbackHost(host);
  return {
    transport,
    host,
    port,
    path,
    auth: password === undefined ? { enabled: false, user } : { enabled: true, user, password },
    warnUnauthenticatedNetwork: !loopback && password === undefined,
    loopback,
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLocaleLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseTransport(value: string): ServeTransport {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected --transport to be stdio or http, got ${value}`,
  );
}

function parsePort(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Expected --port to be a valid TCP port, got ${value}`,
    );
  }
  return parsed;
}

function normalizeHttpPath(value: string): string {
  if (!value.startsWith("/")) {
    throw new CapletsError("REQUEST_INVALID", "HTTP --path must start with /");
  }
  if (value.includes("?") || value.includes("#")) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "HTTP --path must not include a query string or fragment",
    );
  }
  return value === "/" ? value : value.replace(/\/+$/u, "");
}

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  }
  return trimmed;
}

function hasEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
```

- [ ] **Step 4: Run option tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit option normalization**

Run:

```bash
git add packages/core/src/serve/options.ts packages/core/test/serve-options.test.ts
git commit -m "feat(core): validate serve transport options"
```

---

### Task 4: Add stdio serve helper

**Files:**

- Create: `packages/core/src/serve/stdio.ts`
- Create: `packages/core/src/serve/index.ts`
- Test indirectly through later CLI tests

- [ ] **Step 1: Implement stdio helper**

Create `packages/core/src/serve/stdio.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsMcpSession } from "./session";

export type ServeStdioOptions = CapletsEngineOptions & {
  signalHandling?: boolean;
};

export async function serveStdio(options: ServeStdioOptions = {}): Promise<void> {
  const engine = new CapletsEngine(options);
  const session = new CapletsMcpSession(engine);
  let closing = false;

  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await session.close();
    } finally {
      await engine.close();
    }
  };

  if (options.signalHandling !== false) {
    process.once("SIGINT", () => void close().finally(() => process.exit(130)));
    process.once("SIGTERM", () => void close().finally(() => process.exit(143)));
  }

  await session.connect(new StdioServerTransport());
}
```

Create `packages/core/src/serve/index.ts`:

```ts
import type { CapletsEngineOptions } from "../engine";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "./options";
import { serveHttp } from "./http";
import { serveStdio } from "./stdio";

export { resolveServeOptions } from "./options";
export type { HttpServeOptions, RawServeOptions, ServeOptions, StdioServeOptions } from "./options";
export { serveHttp } from "./http";
export { serveStdio } from "./stdio";

export type ServeCapletsOptions = {
  raw: RawServeOptions;
  engine?: CapletsEngineOptions;
  env?: NodeJS.ProcessEnv;
  writeErr?: (value: string) => void;
};

export async function serveCaplets(options: ServeCapletsOptions): Promise<void> {
  const resolved = resolveServeOptions(options.raw, options.env ?? process.env);
  await serveResolvedCaplets(resolved, options.engine, options.writeErr);
}

export async function serveResolvedCaplets(
  resolved: ServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr?: (value: string) => void,
): Promise<void> {
  if (resolved.transport === "stdio") {
    await serveStdio({ ...engineOptions, ...(writeErr ? { writeErr } : {}) });
    return;
  }
  await serveHttp(resolved, { ...engineOptions, ...(writeErr ? { writeErr } : {}) }, writeErr);
}
```

This references `serveHttp` before it exists. The repository will not compile until Task 5 creates `packages/core/src/serve/http.ts`.

- [ ] **Step 2: Do not commit yet**

Do not commit this task independently because `serve/index.ts` imports `serveHttp`, which is created in the next task. Commit Task 4 and Task 5 together after tests pass.

---

### Task 5: Add Hono HTTP serving

**Files:**

- Create: `packages/core/src/serve/http.ts`
- Complete: `packages/core/src/serve/index.ts`
- Test: `packages/core/test/serve-http.test.ts`

- [ ] **Step 1: Write failing HTTP route/auth tests**

Create `packages/core/test/serve-http.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsEngine } from "../src/engine";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createHttpServeApp", () => {
  it("serves root info and health without auth", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const root = await app.request("http://127.0.0.1:5387/");
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({
      name: "caplets",
      transport: "http",
      mcp: "/mcp",
      health: "/healthz",
      auth: { type: "basic", enabled: false },
    });

    const health = await app.request("http://127.0.0.1:5387/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      transport: "http",
      mcpPath: "/mcp",
    });

    await engine.close();
  });

  it("requires Basic Auth on MCP path when password is configured", async () => {
    const { engine } = testEngine();
    const testPassword = ["test", "password"].join("-");
    const app = createHttpServeApp(
      httpOptions({ auth: { enabled: true, user: "caplets", password: testPassword } }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Basic");

    const wrong = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`caplets:not-the-${testPassword}`).toString("base64")}`,
      },
    });
    expect(wrong.status).toBe(401);

    await engine.close();
  });

  it("returns 404 for nested MCP paths", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/mcp/extra");
    expect(response.status).toBe(404);

    await engine.close();
  });
});

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/mcp",
    auth: { enabled: false, user: "caplets" },
    warnUnauthenticatedNetwork: false,
    loopback: true,
    ...overrides,
  };
}

function testEngine(): { engine: CapletsEngine } {
  const dir = mkdtempSync(join(tmpdir(), "caplets-http-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status",
          description: "Status API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  return { engine: new CapletsEngine({ configPath, projectConfigPath, watch: false }) };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected: FAIL because `../src/serve/http` does not exist.

- [ ] **Step 3: Implement Hono HTTP serving**

Create `packages/core/src/serve/http.ts`:

```ts
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { CapletsEngineOptions } from "../engine";
import { CapletsEngine } from "../engine";
import type { HttpBasicAuthOptions, HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";

type HttpServeIo = {
  writeErr?: (value: string) => void;
};

type HttpSession = {
  server: CapletsMcpSession;
  transport: StreamableHTTPTransport;
};

export function createHttpServeApp(
  options: HttpServeOptions,
  engine: CapletsEngine,
  io: HttpServeIo = {},
): Hono {
  const app = new Hono();
  const sessions = new Map<string, HttpSession>();

  app.get("/", (c) =>
    c.json({
      name: "caplets",
      transport: "http",
      mcp: options.path,
      health: "/healthz",
      auth: { type: "basic", enabled: options.auth.enabled },
    }),
  );

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      transport: "http",
      mcpPath: options.path,
    }),
  );

  app.all(options.path, basicAuth(options.auth), async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          404,
        );
      }
      return existing.transport.handleRequest(c);
    }

    if (c.req.method !== "POST") {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
          id: null,
        },
        400,
      );
    }

    const nextSessionId = randomUUID();
    const session = await createHttpSession(
      engine,
      nextSessionId,
      options,
      async (closedSessionId) => {
        const closed = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        if (closed) {
          await closed.server.close();
        }
      },
    );
    sessions.set(nextSessionId, session);
    return session.transport.handleRequest(c);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  Object.defineProperty(app, "__capletsClose", {
    value: async () => {
      await Promise.allSettled(
        [...sessions.values()].map(async (session) => {
          await session.server.close();
        }),
      );
      sessions.clear();
    },
  });

  if (options.warnUnauthenticatedNetwork) {
    (io.writeErr ?? process.stderr.write.bind(process.stderr))(
      `Warning: Caplets MCP HTTP server is listening on ${options.host} without authentication.\n`,
    );
  }

  return app;
}

export async function serveHttp(
  options: HttpServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  const engine = new CapletsEngine(engineOptions);
  const app = createHttpServeApp(options, engine, { writeErr });
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () => {
    writeErr(
      `Caplets MCP HTTP server listening on http://${formatHost(options.host)}:${options.port}${options.path}\n`,
    );
    writeErr(`Health check: http://${formatHost(options.host)}:${options.port}/healthz\n`);
    writeErr(
      `Basic Auth: ${options.auth.enabled ? `enabled (user: ${options.auth.user})` : "disabled"}\n`,
    );
  });

  installHttpSignalHandlers(server, app, engine, writeErr);
}

async function createHttpSession(
  engine: CapletsEngine,
  sessionId: string,
  options: HttpServeOptions,
  onClose: (sessionId: string) => Promise<void>,
): Promise<HttpSession> {
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: onClose,
    ...(options.loopback ? dnsRebindingOptions(options) : {}),
  });
  const server = new CapletsMcpSession(engine);
  await server.connect(transport);
  return { server, transport };
}

function basicAuth(auth: HttpBasicAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!auth.enabled) {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    const credentials = parseBasicAuth(header);
    if (
      !credentials ||
      !safeEqual(credentials.user, auth.user) ||
      !safeEqual(credentials.password, auth.password)
    ) {
      c.header("www-authenticate", 'Basic realm="caplets"');
      return c.text("Unauthorized", 401);
    }
    await next();
  };
}

function parseBasicAuth(header: string): { user: string; password: string } | undefined {
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLocaleLowerCase() !== "basic" || !encoded) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function dnsRebindingOptions(options: HttpServeOptions): {
  enableDnsRebindingProtection: true;
  allowedHosts: string[];
  allowedOrigins: string[];
} {
  const hostForHeader = options.host === "::1" ? "[::1]" : options.host;
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [
      options.host,
      hostForHeader,
      `${hostForHeader}:${options.port}`,
      `localhost:${options.port}`,
    ],
    allowedOrigins: [`http://${hostForHeader}:${options.port}`, `http://localhost:${options.port}`],
  };
}

function installHttpSignalHandlers(
  server: ServerType,
  app: Hono,
  engine: CapletsEngine,
  writeErr: (value: string) => void,
): void {
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (app as unknown as { __capletsClose?: () => Promise<void> }).__capletsClose?.();
    await engine.close();
  };
  process.once(
    "SIGINT",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(130)),
  );
  process.once(
    "SIGTERM",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(143)),
  );
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
```

- [ ] **Step 4: Fix import/type issues from actual Hono versions**

Run:

```bash
pnpm --filter @caplets/core typecheck
```

Expected first run may FAIL on exact exported type names from `@hono/node-server` or `@hono/mcp`. If it fails:

- If `ServerType` is type-only-exported from `@hono/node-server/dist/types`, replace `import type { ServerType } from "@hono/node-server";` with `import type { ServerType } from "@hono/node-server/dist/types";` only if the package export permits it.
- If `StreamableHTTPTransport` option type rejects `allowedOrigins`, keep only `enableDnsRebindingProtection` and `allowedHosts`.
- If `Hono` generic typing rejects the synthetic `__capletsClose` property, replace the property attachment with a helper return type in this file:

```ts
type CapletsHttpApp = Hono & { closeCapletsSessions: () => Promise<void> };
```

Then return that from `createHttpServeApp` and call `app.closeCapletsSessions()` in `serveHttp`.

- [ ] **Step 5: Run HTTP tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit stdio/http serve helpers**

Run:

```bash
git add packages/core/src/serve/index.ts packages/core/src/serve/stdio.ts packages/core/src/serve/http.ts packages/core/test/serve-http.test.ts
git commit -m "feat(core): serve MCP over Hono HTTP"
```

---

### Task 6: Wire `serve` into the core CLI

**Files:**

- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/cli.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Append tests near the existing CLI help/version tests in `packages/core/test/cli.test.ts`:

```ts
it("prints top-level help for no arguments", async () => {
  const out: string[] = [];

  await runCli([], {
    writeOut: (value) => out.push(value),
    writeErr: (value) => out.push(value),
  });

  expect(out.join("")).toContain("Usage: caplets");
  expect(out.join("")).toContain("Commands:");
  expect(out.join("")).toContain("serve");
});

it("resolves serve defaults to stdio", async () => {
  const served: unknown[] = [];

  await runCli(["serve"], {
    writeOut: () => {},
    serve: async (options) => {
      served.push(options);
    },
  });

  expect(served).toEqual([{ transport: "stdio" }]);
});

it("resolves HTTP serve defaults", async () => {
  const served: unknown[] = [];

  await runCli(["serve", "--transport", "http"], {
    writeOut: () => {},
    serve: async (options) => {
      served.push(options);
    },
  });

  expect(served).toEqual([
    expect.objectContaining({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/mcp",
      auth: { enabled: false, user: "caplets" },
    }),
  ]);
});

it("rejects HTTP-only serve options with stdio", async () => {
  await expect(
    runCli(["serve", "--transport", "stdio", "--port", "5387"], { writeErr: () => {} }),
  ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
});
```

Also update the local `CliIO` TypeScript expectations by importing the real type only if needed. The test uses `serve` before the type exists, so it should fail initially.

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts --runInBand
```

Expected: FAIL because `CliIO` does not accept `serve`, no-arg behavior is not implemented, and the `serve` command does not exist in Commander.

- [ ] **Step 3: Modify CLI imports and `CliIO`**

In `packages/core/src/cli.ts`, add imports:

```ts
import { resolveServeOptions, type ServeOptions } from "./serve";
import { serveResolvedCaplets } from "./serve";
```

Update `CliIO`:

```ts
type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  authDir?: string;
  version?: string;
  setExitCode?: (code: number) => void;
  serve?: (options: ServeOptions) => Promise<void>;
};
```

- [ ] **Step 4: Add no-arg help behavior**

In `runCli`, before `program.parseAsync`, add:

```ts
if (args.length === 0) {
  program.outputHelp();
  return;
}
```

The resulting function body should start like:

```ts
export async function runCli(args: string[], io: CliIO = {}): Promise<void> {
  const program = createProgram(io);
  try {
    if (args.length === 0) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(["node", "caplets", ...args]);
  } catch (error) {
    // existing error handling stays unchanged
  }
}
```

- [ ] **Step 5: Add `serve` command to `createProgram`**

After the main `program` setup and before `init`, add:

```ts
program
  .command("serve")
  .description("Serve configured Caplets as an MCP server.")
  .option("--transport <transport>", "server transport: stdio or http")
  .option("--host <host>", "HTTP bind host")
  .option("--port <port>", "HTTP bind port")
  .option("--path <path>", "HTTP MCP endpoint path")
  .option("--user <user>", "HTTP Basic Auth username")
  .option("--password <password>", "HTTP Basic Auth password")
  .action(
    async (options: {
      transport?: string;
      host?: string;
      port?: string;
      path?: string;
      user?: string;
      password?: string;
    }) => {
      const resolved = resolveServeOptions(options);
      const runner =
        io.serve ??
        ((serveOptions: ServeOptions) =>
          serveResolvedCaplets(
            serveOptions,
            {
              ...(envConfigPath() ? { configPath: envConfigPath() } : {}),
              ...(io.authDir ? { authDir: io.authDir } : {}),
            },
            writeErr,
          ));
      await runner(resolved);
    },
  );
```

- [ ] **Step 6: Export serve helpers from core index**

In `packages/core/src/index.ts`, add:

```ts
export { serveCaplets, serveHttp, serveResolvedCaplets, serveStdio } from "./serve";
export type { HttpServeOptions, RawServeOptions, ServeOptions, StdioServeOptions } from "./serve";
```

- [ ] **Step 7: Run focused CLI tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit CLI wiring**

Run:

```bash
git add packages/core/src/cli.ts packages/core/src/index.ts packages/core/test/cli.test.ts
git commit -m "feat(core): add serve command options"
```

---

### Task 7: Simplify CLI binary entrypoint

**Files:**

- Modify: `packages/cli/src/index.ts`
- Test: covered by package build/typecheck

- [ ] **Step 1: Replace special-case entrypoint**

Replace `packages/cli/src/index.ts` with:

```ts
import { runCli } from "@caplets/core";
import { version as packageVersion } from "../package.json";

async function main() {
  await runCli(process.argv.slice(2), { version: packageVersion });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run CLI package typecheck/build**

Run:

```bash
pnpm --filter caplets typecheck
pnpm --filter caplets build
```

Expected: PASS.

- [ ] **Step 3: Commit entrypoint simplification**

Run:

```bash
git add packages/cli/src/index.ts
git commit -m "refactor(cli): delegate serve command to core"
```

---

### Task 8: Add MCP HTTP integration coverage

**Files:**

- Modify: `packages/core/test/serve-http.test.ts`

- [ ] **Step 1: Add initialize/list-tools integration test**

Append this test to `packages/core/test/serve-http.test.ts`:

```ts
it("initializes an MCP HTTP session and lists Caplet tools", async () => {
  const { engine } = testEngine();
  const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

  const init = await app.request("http://127.0.0.1:5387/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });

  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  await app.request("http://127.0.0.1:5387/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const tools = await app.request("http://127.0.0.1:5387/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });

  expect(tools.status).toBe(200);
  const body = await tools.text();
  expect(body).toContain("status");

  const deleted = await app.request("http://127.0.0.1:5387/mcp", {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId! },
  });
  expect(deleted.status).toBe(200);

  await engine.close();
});
```

If `@hono/mcp` returns SSE frames for `tools/list`, asserting `body` contains `status` is sufficient. If it returns pure JSON, the same assertion still passes.

- [ ] **Step 2: Run HTTP tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected: PASS. If the DELETE request requires `mcp-protocol-version`, add header:

```ts
"mcp-protocol-version": "2025-03-26"
```

and rerun.

- [ ] **Step 3: Commit HTTP integration test**

Run:

```bash
git add packages/core/test/serve-http.test.ts
git commit -m "test(core): cover HTTP MCP sessions"
```

---

### Task 9: Run focused and full verification

**Files:**

- No source files unless verification reveals issues.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/serve-options.test.ts test/serve-session.test.ts test/serve-http.test.ts test/runtime.test.ts test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run full gate**

Run:

```bash
pnpm verify
```

Expected: PASS through format, lint, typecheck, schema check, tests, benchmark check, and build.

- [ ] **Step 5: Commit any verification fixes**

If verification required fixes, commit them:

```bash
git add <fixed-files>
git commit -m "fix(core): polish HTTP serve implementation"
```

If no fixes were needed, do not create an empty commit.

---

## Self-review notes

- Spec coverage: CLI behavior is covered by Tasks 3, 6, and 7. Hono HTTP behavior, Basic Auth, root/health endpoints, DNS rebinding options, session routing, startup logs, and shutdown are covered by Tasks 5 and 8. Runtime architecture is covered by Task 2. Verification is covered by Task 9.
- Red-flag scan: no incomplete sections are intentionally left. The only conditional instructions are concrete version/type compatibility branches for real package typings.
- Type consistency: `ServeOptions`, `HttpServeOptions`, `CapletsMcpSession`, and `ToolServer` are introduced before later tasks consume them.
