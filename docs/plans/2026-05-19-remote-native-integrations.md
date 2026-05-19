# Remote Native Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let OpenCode, Pi, Codex, and Claude Code connect to a remote `caplets serve --transport http` service while preserving existing local defaults.

**Architecture:** Add remote-aware native service option resolution in `@caplets/core/native`, then implement a `RemoteNativeCapletsService` backed by MCP SDK `Client` + `StreamableHTTPClientTransport`. OpenCode and Pi continue using `createNativeCapletsService()` but pass host-specific config into it; Codex/Claude remain MCP-backed and get documented remote HTTP config examples.

**Tech Stack:** TypeScript, Vitest, MCP SDK Streamable HTTP client, existing Caplets native service interfaces, OpenCode plugin API, Pi extension API, pnpm.

---

## File structure

- Create `packages/core/src/native/options.ts` for env/config resolution, mode selection, remote URL validation, and Basic Auth header creation.
- Create `packages/core/src/native/remote.ts` for remote MCP client wrapper and `RemoteNativeCapletsService`.
- Modify `packages/core/src/native/service.ts` to delegate to local or remote implementation.
- Modify `packages/core/src/native/tools.ts` only if remote tool guidance needs a helper; otherwise keep existing local helpers unchanged.
- Modify `packages/core/src/native.ts` to export new option types needed by integrations.
- Add `packages/core/test/native-options.test.ts`.
- Add `packages/core/test/native-remote.test.ts`.
- Modify `packages/core/test/process-cleanup.test.ts` only if `NativeCapletsService` type changes.
- Modify `packages/opencode/src/index.ts` to accept second-argument config and pass it into `createNativeCapletsService()`.
- Add `packages/opencode/src/config.ts` for OpenCode config normalization if the logic is more than one small helper.
- Modify `packages/opencode/test/opencode.test.ts` to verify second-argument config propagation.
- Modify `packages/opencode/README.md` with env and plugin-config remote examples.
- Modify `packages/pi/src/index.ts` to accept args/native options while preserving the `{ service }` test seam.
- Modify `packages/pi/test/pi.test.ts` to verify Pi args propagation.
- Modify `packages/pi/README.md` with `~/.pi/agent/settings.json` package args examples and note to use the active Pi settings path if different.
- Modify `README.md` and `plugins/caplets/skills/caplets/SKILL.md` with remote service guidance for Codex/Claude.
- Modify `packages/core/test/agent-plugins.test.ts` if docs/plugin artifact assertions need remote examples.
- Add a changeset for `@caplets/core`, `@caplets/opencode`, `@caplets/pi`, and `caplets`.

---

### Task 1: Add native service option resolution

**Files:**

- Create: `packages/core/src/native/options.ts`
- Modify: `packages/core/src/native.ts`
- Test: `packages/core/test/native-options.test.ts`

- [ ] **Step 1: Write failing option-resolution tests**

Create `packages/core/test/native-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CapletsError } from "../src/errors";
import { resolveNativeCapletsServiceOptions } from "../src/native/options";

describe("resolveNativeCapletsServiceOptions", () => {
  it("defaults to local mode without remote configuration", () => {
    expect(resolveNativeCapletsServiceOptions({}, {})).toEqual({
      mode: "local",
    });
  });

  it("uses remote mode in auto when a remote URL is configured", () => {
    expect(
      resolveNativeCapletsServiceOptions({}, { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387/mcp" }),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("http://127.0.0.1:5387/mcp"),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 30_000,
      },
    });
  });

  it("lets explicit local mode ignore remote env vars", () => {
    expect(
      resolveNativeCapletsServiceOptions(
        { mode: "local" },
        { CAPLETS_REMOTE_URL: "http://127.0.0.1:5387/mcp" },
      ),
    ).toEqual({ mode: "local" });
  });

  it("requires a URL in explicit remote mode", () => {
    expect(() => resolveNativeCapletsServiceOptions({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects non-loopback http URLs", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions({ remote: { url: "http://caplets.example.com/mcp" } }, {}),
    ).toThrow(/https/u);
  });

  it("lets config override env vars", () => {
    const configPassword = ["config", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        {
          remote: {
            url: "https://configured.example.com/mcp",
            user: "configured",
            password: configPassword,
          },
        },
        {
          CAPLETS_REMOTE_URL: "https://env.example.com/mcp",
          CAPLETS_REMOTE_USER: "env-user",
          CAPLETS_REMOTE_PASSWORD: ["env", "password"].join("-"),
        },
      ),
    ).toMatchObject({
      mode: "remote",
      remote: {
        url: new URL("https://configured.example.com/mcp"),
        auth: { enabled: true, user: "configured", password: configPassword },
      },
    });
  });

  it("defaults Basic Auth user when password exists", () => {
    const password = ["remote", "password"].join("-");
    expect(
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", password } },
        {},
      ),
    ).toMatchObject({
      remote: { auth: { enabled: true, user: "caplets", password } },
    });
  });

  it("rejects user without password", () => {
    expect(() =>
      resolveNativeCapletsServiceOptions(
        { remote: { url: "https://caplets.example.com/mcp", user: "caplets" } },
        {},
      ),
    ).toThrow(/requires a password/u);
  });

  it("builds request headers without logging credentials", () => {
    const password = ["remote", "password"].join("-");
    const resolved = resolveNativeCapletsServiceOptions(
      {
        remote: {
          url: "https://caplets.example.com/mcp",
          user: "caplets",
          password,
        },
      },
      {},
    );
    expect(resolved.mode).toBe("remote");
    expect(resolved.mode === "remote" ? resolved.remote.requestInit.headers : undefined).toEqual({
      Authorization: `Basic ${Buffer.from(`caplets:${password}`).toString("base64")}`,
    });
  });
});
```

- [ ] **Step 2: Run option tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-options.test.ts
```

Expected: FAIL with module-not-found for `../src/native/options`.

- [ ] **Step 3: Implement native option resolution**

Create `packages/core/src/native/options.ts`:

```ts
import { CapletsError } from "../errors";

export type NativeCapletsMode = "auto" | "local" | "remote";

export type NativeRemoteCapletsOptions = {
  url?: string;
  user?: string;
  password?: string;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  remote?: NativeRemoteCapletsOptions;
};

export type NativeCapletsEnv = Partial<
  Record<
    | "CAPLETS_NATIVE_MODE"
    | "CAPLETS_REMOTE_URL"
    | "CAPLETS_REMOTE_USER"
    | "CAPLETS_REMOTE_PASSWORD",
    string
  >
>;

export type NativeRemoteAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | {
      mode: "remote";
      remote: {
        url: URL;
        auth: NativeRemoteAuthOptions;
        pollIntervalMs: number;
        requestInit: RequestInit;
        fetch?: typeof fetch;
      };
    };

const DEFAULT_REMOTE_USER = "caplets";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const mode = parseMode(input.mode ?? env.CAPLETS_NATIVE_MODE ?? "auto");
  if (mode === "local") {
    return { mode: "local" };
  }

  const rawUrl =
    nonEmpty(input.remote?.url, "remote.url") ??
    nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");
  if (mode === "remote" && rawUrl === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_NATIVE_MODE=remote requires CAPLETS_REMOTE_URL or remote.url.",
    );
  }
  if (rawUrl === undefined) {
    return { mode: "local" };
  }

  const url = parseRemoteUrl(rawUrl);
  const userWasExplicit = input.remote?.user !== undefined || hasEnv(env.CAPLETS_REMOTE_USER);
  const user =
    nonEmpty(input.remote?.user, "remote.user") ??
    nonEmpty(env.CAPLETS_REMOTE_USER, "CAPLETS_REMOTE_USER") ??
    DEFAULT_REMOTE_USER;
  const password =
    nonEmpty(input.remote?.password, "remote.password") ??
    nonEmpty(env.CAPLETS_REMOTE_PASSWORD, "CAPLETS_REMOTE_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote Caplets Basic Auth requires a password; set CAPLETS_REMOTE_PASSWORD or remote.password.",
    );
  }

  const auth: NativeRemoteAuthOptions =
    password === undefined ? { enabled: false, user } : { enabled: true, user, password };
  const requestInit: RequestInit = auth.enabled
    ? { headers: { Authorization: basicAuthHeader(auth.user, auth.password) } }
    : {};

  return {
    mode: "remote",
    remote: {
      url,
      auth,
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit,
      ...(input.remote?.fetch ? { fetch: input.remote.fetch } : {}),
    },
  };
}

function parseMode(value: string): NativeCapletsMode {
  if (value === "auto" || value === "local" || value === "remote") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_NATIVE_MODE to be auto, local, or remote, got ${value}`,
  );
}

function parseRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapletsError("REQUEST_INVALID", `Invalid remote Caplets URL: ${value}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    "Remote Caplets URL must use https except loopback development URLs.",
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function parsePollInterval(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (!Number.isInteger(value) || value < 1_000) {
    throw new CapletsError("REQUEST_INVALID", "remote.pollIntervalMs must be an integer >= 1000.");
  }
  return value;
}

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
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

- [ ] **Step 4: Export option types from native entrypoint**

Modify `packages/core/src/native.ts` to add:

```ts
export {
  resolveNativeCapletsServiceOptions,
  type NativeCapletsMode,
  type NativeRemoteCapletsOptions,
  type ResolvedNativeCapletsServiceOptions,
} from "./native/options";
```

- [ ] **Step 5: Run option tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-options.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit native option resolution**

Run:

```bash
git add packages/core/src/native/options.ts packages/core/src/native.ts packages/core/test/native-options.test.ts
git commit -m "feat(core): resolve remote native service options"
```

---

### Task 2: Add remote native service implementation

**Files:**

- Create: `packages/core/src/native/remote.ts`
- Modify: `packages/core/src/native/service.ts`
- Test: `packages/core/test/native-remote.test.ts`

- [ ] **Step 1: Write failing remote-service tests**

Create `packages/core/test/native-remote.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CapletsError } from "../src/errors";
import { RemoteNativeCapletsService, type RemoteCapletsClient } from "../src/native/remote";
import { createNativeCapletsService } from "../src/native/service";

describe("RemoteNativeCapletsService", () => {
  it("maps remote MCP tools to native Caplets tools", async () => {
    const client = fakeRemoteClient({
      tools: [
        {
          name: "git-hub",
          title: "GitHub",
          description: "GitHub progressive tools.",
          inputSchema: { type: "object" },
        },
      ],
    });
    const service = new RemoteNativeCapletsService({
      clientFactory: async () => client,
      pollIntervalMs: 10_000,
    });

    await service.reload();

    expect(service.listTools()).toEqual([
      expect.objectContaining({
        caplet: "git-hub",
        toolName: "caplets_git_hub",
        title: "GitHub",
      }),
    ]);
    expect(service.listTools()[0]?.description).toContain("GitHub progressive tools.");
    expect(service.listTools()[0]?.promptGuidance[0]).toContain("remote Caplets service");

    await service.close();
  });

  it("calls remote tools by Caplet ID", async () => {
    const client = fakeRemoteClient({
      tools: [{ name: "linear", inputSchema: { type: "object" } }],
    });
    const service = new RemoteNativeCapletsService({
      clientFactory: async () => client,
      pollIntervalMs: 10_000,
    });

    const result = await service.execute("linear", { operation: "get_caplet" });

    expect(client.callTool).toHaveBeenCalledWith("linear", {
      operation: "get_caplet",
    });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

    await service.close();
  });

  it("notifies listeners on tool-list-change notifications", async () => {
    const client = fakeRemoteClient({
      tools: [{ name: "alpha", inputSchema: { type: "object" } }],
    });
    const service = new RemoteNativeCapletsService({
      clientFactory: async () => client,
      pollIntervalMs: 10_000,
    });
    const changes: string[][] = [];
    service.onToolsChanged((tools) => changes.push(tools.map((tool) => tool.caplet)));

    await service.reload();
    client.setTools([{ name: "beta", title: "Beta", inputSchema: { type: "object" } }]);
    await client.emitToolsChanged();

    expect(changes).toEqual([["alpha"], ["beta"]]);
    await service.close();
  });

  it("keeps last known-good tools when refresh fails", async () => {
    const errors: string[] = [];
    const client = fakeRemoteClient({
      tools: [{ name: "alpha", inputSchema: { type: "object" } }],
    });
    const service = new RemoteNativeCapletsService({
      clientFactory: async () => client,
      pollIntervalMs: 10_000,
      writeErr: (value) => errors.push(value),
    });

    await service.reload();
    client.failListTools = true;
    const reloaded = await service.reload();

    expect(reloaded).toBe(false);
    expect(service.listTools().map((tool) => tool.caplet)).toEqual(["alpha"]);
    expect(errors.join("")).toContain("keeping last known-good remote tools");
    await service.close();
  });

  it("closes the client and stops future notifications", async () => {
    const client = fakeRemoteClient({
      tools: [{ name: "alpha", inputSchema: { type: "object" } }],
    });
    const service = new RemoteNativeCapletsService({
      clientFactory: async () => client,
      pollIntervalMs: 10_000,
    });
    const listener = vi.fn();
    service.onToolsChanged(listener);

    await service.reload();
    await service.close();
    client.setTools([{ name: "beta", inputSchema: { type: "object" } }]);
    await client.emitToolsChanged();

    expect(client.close).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createNativeCapletsService remote mode", () => {
  it("returns a remote service when remote mode resolves", async () => {
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387/mcp" },
      remoteClientFactory: async () => fakeRemoteClient({ tools: [] }),
    });

    await expect(service.reload()).resolves.toBe(true);
    await service.close();
  });

  it("fails fast for invalid remote configuration", () => {
    expect(() => createNativeCapletsService({ mode: "remote" })).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });
});

type FakeRemoteTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: "object" };
};

function fakeRemoteClient(initial: { tools: FakeRemoteTool[] }): RemoteCapletsClient & {
  failListTools: boolean;
  setTools(tools: FakeRemoteTool[]): void;
  emitToolsChanged(): Promise<void>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  let tools = initial.tools;
  return {
    failListTools: false,
    setTools(next) {
      tools = next;
    },
    async emitToolsChanged() {
      events.emit("toolsChanged");
      await Promise.resolve();
    },
    async listTools() {
      if (this.failListTools) {
        throw new Error("list failed");
      }
      return tools;
    },
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    onToolsChanged(listener) {
      events.on("toolsChanged", listener);
      return () => events.off("toolsChanged", listener);
    },
    close: vi.fn(async () => {}),
  };
}
```

- [ ] **Step 2: Run remote tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-remote.test.ts
```

Expected: FAIL because `../src/native/remote` does not exist and `remoteClientFactory` is not accepted.

- [ ] **Step 3: Implement remote service**

Create `packages/core/src/native/remote.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { version as packageJsonVersion } from "../../package.json";
import { CapletsError } from "../errors";
import type {
  NativeCapletTool,
  NativeCapletsService,
  NativeCapletsToolsChangedListener,
} from "./service";
import { nativeCapletToolName } from "./tools";

type RemoteTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: "object" };
};

export type RemoteCapletsClient = {
  listTools(): Promise<RemoteTool[]>;
  callTool(name: string, arguments_: unknown): Promise<unknown>;
  onToolsChanged(listener: () => void | Promise<void>): () => void;
  close(): Promise<void>;
};

export type RemoteCapletsClientFactory = () => Promise<RemoteCapletsClient>;

export type RemoteNativeCapletsServiceOptions = {
  clientFactory: RemoteCapletsClientFactory;
  pollIntervalMs: number;
  writeErr?: (value: string) => void;
};

export class RemoteNativeCapletsService implements NativeCapletsService {
  private client: RemoteCapletsClient | undefined;
  private tools: NativeCapletTool[] = [];
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private unsubscribeToolsChanged: (() => void) | undefined;
  private poll: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: RemoteNativeCapletsServiceOptions) {}

  listTools(): NativeCapletTool[] {
    return this.tools;
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    const client = await this.ensureClient();
    try {
      return await client.callTool(capletId, request);
    } catch (error) {
      throw classifyRemoteError(error, `Remote Caplets tool ${capletId} failed`);
    }
  }

  async reload(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      const next = mapRemoteTools(await client.listTools());
      const changed = toolSignature(next) !== toolSignature(this.tools);
      this.tools = next;
      if (changed) {
        this.emitToolsChanged();
      }
      return true;
    } catch (error) {
      this.writeErr(
        `Remote Caplets refresh failed; keeping last known-good remote tools: ${safeMessage(error)}\n`,
      );
      return false;
    }
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    this.unsubscribeToolsChanged?.();
    this.unsubscribeToolsChanged = undefined;
    await this.client?.close();
    this.client = undefined;
    this.listeners.clear();
  }

  private async ensureClient(): Promise<RemoteCapletsClient> {
    if (this.closed) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Remote Caplets service is closed.");
    }
    if (this.client) {
      return this.client;
    }
    const client = await this.options.clientFactory();
    this.client = client;
    this.unsubscribeToolsChanged = client.onToolsChanged(() => void this.reload());
    this.startPolling();
    return client;
  }

  private startPolling(): void {
    if (this.poll) {
      return;
    }
    this.poll = setInterval(() => void this.reload(), this.options.pollIntervalMs);
    this.poll.unref?.();
  }

  private emitToolsChanged(): void {
    const snapshot = this.listTools();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private writeErr(value: string): void {
    (this.options.writeErr ?? process.stderr.write.bind(process.stderr))(value);
  }
}

export function createSdkRemoteCapletsClient(options: {
  url: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
}): RemoteCapletsClientFactory {
  return async () => {
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: options.requestInit,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const client = new Client(
      { name: "caplets-native", version: packageJsonVersion },
      {
        capabilities: {},
      },
    );
    await client.connect(transport);
    return {
      async listTools() {
        const result = await client.listTools();
        return result.tools;
      },
      async callTool(name, arguments_) {
        return await client.callTool({
          name,
          arguments: arguments_ as Record<string, unknown>,
        });
      },
      onToolsChanged(listener) {
        client.setNotificationHandler(
          { method: "notifications/tools/list_changed" } as never,
          () => {
            void listener();
          },
        );
        return () =>
          client.removeNotificationHandler({
            method: "notifications/tools/list_changed",
          } as never);
      },
      async close() {
        await transport.terminateSession().catch(() => undefined);
        await client.close();
      },
    };
  };
}

function mapRemoteTools(tools: RemoteTool[]): NativeCapletTool[] {
  return tools
    .map((tool) => {
      const toolName = nativeCapletToolName(tool.name);
      const title = tool.title ?? tool.name;
      return {
        caplet: tool.name,
        toolName,
        title,
        description: [
          tool.description ?? `Remote Caplets capability domain ${title}.`,
          "",
          `Native tool name: ${toolName}`,
          `Remote Caplet ID: ${tool.name}`,
        ].join("\n"),
        promptGuidance: [
          `Use ${toolName} for the ${title} remote Caplets service capability domain.`,
        ],
      };
    })
    .sort((left, right) => left.caplet.localeCompare(right.caplet));
}

function toolSignature(tools: NativeCapletTool[]): string {
  return JSON.stringify(tools);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyRemoteError(error: unknown, fallbackMessage: string): Error {
  const message = safeMessage(error);
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return new CapletsError(
      "AUTH_FAILED",
      "Remote Caplets authentication failed. Check CAPLETS_REMOTE_USER and CAPLETS_REMOTE_PASSWORD.",
    );
  }
  return error instanceof Error ? error : new CapletsError("SERVER_UNAVAILABLE", fallbackMessage);
}
```

If TypeScript rejects `setNotificationHandler` object literals, use the SDK's exported notification schema type for tool-list changes or fall back to client options `listChanged.tools.onChanged` during `new Client(...)`. Keep the public `RemoteCapletsClient` interface unchanged so tests stay stable.

- [ ] **Step 4: Wire service factory**

Modify `packages/core/src/native/service.ts`:

- Add imports:

```ts
import {
  resolveNativeCapletsServiceOptions,
  type NativeCapletsServiceResolutionInput,
} from "./options";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClientFactory,
} from "./remote";
```

- Extend `NativeCapletsServiceOptions`:

```ts
export type NativeCapletsServiceOptions = NativeCapletsServiceResolutionInput & {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  remoteClientFactory?: RemoteCapletsClientFactory;
};
```

- Replace `createNativeCapletsService` with:

```ts
export function createNativeCapletsService(
  options: NativeCapletsServiceOptions = {},
): NativeCapletsService {
  const resolved = resolveNativeCapletsServiceOptions(options);
  if (resolved.mode === "remote") {
    return new RemoteNativeCapletsService({
      clientFactory:
        options.remoteClientFactory ??
        createSdkRemoteCapletsClient({
          url: resolved.remote.url,
          requestInit: resolved.remote.requestInit,
          ...(resolved.remote.fetch ? { fetch: resolved.remote.fetch } : {}),
        }),
      pollIntervalMs: resolved.remote.pollIntervalMs,
      ...(options.writeErr ? { writeErr: options.writeErr } : {}),
    });
  }
  return new DefaultNativeCapletsService(localEngineOptions(options));
}
```

- Add helper:

```ts
function localEngineOptions(
  options: NativeCapletsServiceOptions,
): ConstructorParameters<typeof CapletsEngine>[0] {
  const engineOptions: ConstructorParameters<typeof CapletsEngine>[0] = {};
  if (options.configPath !== undefined) engineOptions.configPath = options.configPath;
  if (options.projectConfigPath !== undefined)
    engineOptions.projectConfigPath = options.projectConfigPath;
  if (options.authDir !== undefined) engineOptions.authDir = options.authDir;
  if (options.watchDebounceMs !== undefined)
    engineOptions.watchDebounceMs = options.watchDebounceMs;
  if (options.watch !== undefined) engineOptions.watch = options.watch;
  if (options.writeErr !== undefined) engineOptions.writeErr = options.writeErr;
  return engineOptions;
}
```

- [ ] **Step 5: Export remote types from native entrypoint**

Modify `packages/core/src/native.ts` to add:

```ts
export {
  RemoteNativeCapletsService,
  createSdkRemoteCapletsClient,
  type RemoteCapletsClient,
  type RemoteCapletsClientFactory,
} from "./native/remote";
```

- [ ] **Step 6: Run remote tests and typecheck**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-remote.test.ts test/native-options.test.ts test/process-cleanup.test.ts
pnpm --filter @caplets/core typecheck
```

Expected: PASS. If SDK notification typing requires a different handler shape, fix `createSdkRemoteCapletsClient` without changing tests.

- [ ] **Step 7: Commit remote native service**

Run:

```bash
git add packages/core/src/native/remote.ts packages/core/src/native/service.ts packages/core/src/native.ts packages/core/test/native-remote.test.ts
git commit -m "feat(core): add remote native Caplets service"
```

---

### Task 3: Add OpenCode second-argument config

**Files:**

- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/opencode.test.ts`
- Docs: `packages/opencode/README.md`

- [ ] **Step 1: Write failing OpenCode config propagation test**

Append this test to `packages/opencode/test/opencode.test.ts`:

```ts
it("passes second-argument config into the native service", async () => {
  vi.resetModules();
  const nativeMocks = vi.hoisted(() => ({
    createNativeCapletsService: vi.fn(() => ({
      listTools: () => [],
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    })),
    registerNativeCapletsProcessCleanup: vi.fn(),
  }));
  vi.doMock("@caplets/core/native", () => nativeMocks);
  const plugin = (await import("../src/index.js")).default;

  await plugin(
    {} as never,
    {
      mode: "remote",
      remote: {
        url: "https://caplets.example.com/mcp",
        user: "caplets",
        pollIntervalMs: 5_000,
      },
    } as never,
  );

  expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
    mode: "remote",
    remote: {
      url: "https://caplets.example.com/mcp",
      user: "caplets",
      pollIntervalMs: 5_000,
    },
  });
});
```

If this conflicts with the existing top-level `vi.mock("@caplets/core/native")`, instead add a new isolated test file `packages/opencode/test/opencode-config.test.ts` that mocks before importing `../src/index.js`.

- [ ] **Step 2: Run OpenCode test to verify red**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: FAIL because plugin ignores the second argument.

- [ ] **Step 3: Update OpenCode plugin signature**

Modify `packages/opencode/src/index.ts`:

```ts
import { type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";
import { createCapletsOpenCodeHooks } from "./hooks";

export type CapletsOpenCodeConfig = Pick<NativeCapletsServiceOptions, "mode" | "remote">;

const plugin: Plugin = async (_ctx: PluginInput, config?: CapletsOpenCodeConfig) => {
  const service = createNativeCapletsService(normalizeOpenCodeConfig(config));
  registerNativeCapletsProcessCleanup(service);
  return createCapletsOpenCodeHooks(service);
};

function normalizeOpenCodeConfig(config: CapletsOpenCodeConfig | undefined): CapletsOpenCodeConfig {
  if (!config) {
    return {};
  }
  return {
    ...(config.mode ? { mode: config.mode } : {}),
    ...(config.remote ? { remote: config.remote } : {}),
  };
}

export default plugin;
```

If `Plugin` type does not allow the second argument, define the implementation separately and cast at export:

```ts
const plugin = (async (_ctx: PluginInput, config?: CapletsOpenCodeConfig) => { ... }) as Plugin;
```

- [ ] **Step 4: Document OpenCode remote config**

Append to `packages/opencode/README.md`:

````md
## Remote Caplets service

By default the plugin reads local Caplets config. To use a remote `caplets serve --transport http` service, set environment variables:

```sh
CAPLETS_REMOTE_URL=http://127.0.0.1:5387/mcp opencode
```
````

For authenticated remote services, keep the password in the environment:

```sh
CAPLETS_REMOTE_URL=https://caplets.example.com/mcp \
CAPLETS_REMOTE_USER=caplets \
CAPLETS_REMOTE_PASSWORD=... \
opencode
```

OpenCode plugin config can also pass non-secret settings as the plugin factory's second argument:

```ts
export default {
  plugin: [
    [
      "@caplets/opencode",
      {
        mode: "remote",
        remote: {
          url: "https://caplets.example.com/mcp",
          user: "caplets",
        },
      },
    ],
  ],
};
```

Plugin config overrides environment variables. Prefer `CAPLETS_REMOTE_PASSWORD` for the Basic Auth password unless your OpenCode setup provides secure secret storage.

````

- [ ] **Step 5: Run OpenCode tests**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
pnpm --filter @caplets/opencode typecheck
````

Expected: PASS.

- [ ] **Step 6: Commit OpenCode config support**

Run:

```bash
git add packages/opencode/src/index.ts packages/opencode/test/opencode.test.ts packages/opencode/README.md
git commit -m "feat(opencode): accept remote Caplets config"
```

---

### Task 4: Add Pi args/native option support

**Files:**

- Modify: `packages/pi/src/index.ts`
- Test: `packages/pi/test/pi.test.ts`
- Docs: `packages/pi/README.md`

- [ ] **Step 1: Write failing Pi args propagation test**

Add this test near the existing service-creation tests in `packages/pi/test/pi.test.ts`:

```ts
it("passes Pi args into the native service", () => {
  const service = mockService([]);
  nativeMocks.createNativeCapletsService.mockReturnValueOnce(service);
  const pi = mockPiApi();

  capletsPiExtension(pi, {
    args: {
      mode: "remote",
      remote: {
        url: "https://caplets.example.com/mcp",
        user: "caplets",
        pollIntervalMs: 5_000,
      },
    },
  });

  expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
    mode: "remote",
    remote: {
      url: "https://caplets.example.com/mcp",
      user: "caplets",
      pollIntervalMs: 5_000,
    },
  });
});
```

If the existing `CapletsPiOptions` type rejects `args`, the test should fail at typecheck until implementation.

- [ ] **Step 2: Run Pi test to verify red**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
```

Expected: FAIL because `args` is not part of `CapletsPiOptions` and service creation ignores it.

- [ ] **Step 3: Update Pi option types and service creation**

Modify `packages/pi/src/index.ts` imports:

```ts
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletTool,
  type NativeCapletsService,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";
```

Replace `CapletsPiOptions` with:

```ts
export type CapletsPiOptions = {
  service?: NativeCapletsService;
  native?: Pick<NativeCapletsServiceOptions, "mode" | "remote">;
  args?: Pick<NativeCapletsServiceOptions, "mode" | "remote">;
};
```

Replace service creation with:

```ts
const ownsService = !options.service;
const serviceOptions = options.native ?? options.args ?? {};
const service = options.service ?? createNativeCapletsService(serviceOptions);
```

Do not change behavior when `service` is injected; tests and advanced users rely on that seam.

- [ ] **Step 4: Document Pi settings args**

Append to `packages/pi/README.md`:

````md
## Remote Caplets service

By default the extension reads local Caplets config. To use a remote `caplets serve --transport http` service, set environment variables:

```sh
CAPLETS_REMOTE_URL=http://127.0.0.1:5387/mcp pi
```
````

For authenticated remote services, keep the password in the environment:

```sh
CAPLETS_REMOTE_URL=https://caplets.example.com/mcp \
CAPLETS_REMOTE_USER=caplets \
CAPLETS_REMOTE_PASSWORD=... \
pi
```

You can also pass non-secret remote settings through Pi package args in your Pi user settings file. Current Pi docs use `~/.pi/agent/settings.json`; use your runtime's active settings path if it differs:

```json
{
  "packages": [
    {
      "source": "npm:@caplets/pi",
      "args": {
        "mode": "remote",
        "remote": {
          "url": "https://caplets.example.com/mcp",
          "user": "caplets"
        }
      }
    }
  ]
}
```

Package args override environment variables. Prefer `CAPLETS_REMOTE_PASSWORD` for the Basic Auth password unless your Pi setup provides secure secret storage.

````

- [ ] **Step 5: Run Pi tests**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/pi typecheck
````

Expected: PASS.

- [ ] **Step 6: Commit Pi args support**

Run:

```bash
git add packages/pi/src/index.ts packages/pi/test/pi.test.ts packages/pi/README.md
git commit -m "feat(pi): accept remote Caplets args"
```

---

### Task 5: Document Codex and Claude remote MCP configuration

**Files:**

- Modify: `README.md`
- Modify: `plugins/caplets/skills/caplets/SKILL.md`
- Modify: `packages/core/test/agent-plugins.test.ts` if needed

- [ ] **Step 1: Add failing docs assertion if appropriate**

If `packages/core/test/agent-plugins.test.ts` already checks README/plugin guidance, add a test asserting the root README includes `CAPLETS_REMOTE_URL` and `caplets serve --transport http`. Use this pattern:

```ts
it("documents remote Caplets service configuration for MCP-backed plugins", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  expect(readme).toContain("CAPLETS_REMOTE_URL");
  expect(readme).toContain("caplets serve --transport http");
  expect(readme).toContain("https://caplets.example.com/mcp");
});
```

If that test file is not a good fit, skip this test and rely on docs review plus `pnpm test`.

- [ ] **Step 2: Update root README Agent Plugins section**

In `README.md`, after the existing paragraph ending with “install the Caplets CLI globally first,” add:

````md
### Remote Caplets service

OpenCode and Pi can use native `caplets_<id>` tools backed by a remote Caplets HTTP service. Codex, Claude Code, and any MCP client can connect to the same remote MCP endpoint directly.

Start the remote service:

```sh
caplets serve --transport http --host 127.0.0.1 --port 5387 --path /mcp
```
````

For authenticated network use, configure Basic Auth on the server and keep credentials out of plugin manifests:

```sh
CAPLETS_SERVER_PASSWORD=... caplets serve --transport http --host 0.0.0.0
```

Native integrations read remote client settings from environment variables:

```sh
CAPLETS_REMOTE_URL=https://caplets.example.com/mcp \
CAPLETS_REMOTE_USER=caplets \
CAPLETS_REMOTE_PASSWORD=... \
opencode
```

For MCP-backed Codex or Claude Code configs, point the agent's MCP server entry at the remote URL using that agent's supported HTTP MCP configuration. If Basic Auth is needed, use the agent's secure secret or environment interpolation mechanism rather than hardcoding credentials.

````

- [ ] **Step 3: Update Caplets skill guidance**

In `plugins/caplets/skills/caplets/SKILL.md`, add one bullet under “Guidance”:

```md
- When Caplets is configured as a remote MCP HTTP service, treat connection/auth failures as remote-service issues and ask the user to verify `CAPLETS_REMOTE_URL`, Basic Auth credentials, and that `caplets serve --transport http` is running.
````

- [ ] **Step 4: Run docs/plugin tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/agent-plugins.test.ts
pnpm format:check
```

Expected: PASS.

- [ ] **Step 5: Commit remote MCP documentation**

Run:

```bash
git add README.md plugins/caplets/skills/caplets/SKILL.md packages/core/test/agent-plugins.test.ts
git commit -m "docs: document remote Caplets service connections"
```

If `agent-plugins.test.ts` was not modified, omit it from `git add`.

---

### Task 6: Add changeset

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Create changeset file**

Create a changeset such as `.changeset/remote-native-caplets.md`:

```md
---
"@caplets/core": minor
"@caplets/opencode": minor
"@caplets/pi": minor
"caplets": patch
---

Add remote Caplets service support for native integrations, including remote-backed OpenCode and Pi native tools plus documentation for MCP-backed Codex and Claude Code remote connections.
```

- [ ] **Step 2: Check changeset status**

Run:

```bash
pnpm changeset status --since=origin/main
```

Expected: output includes minor bumps for `@caplets/core`, `@caplets/opencode`, and `@caplets/pi`. `caplets` may appear as patch or as an internal dependent bump depending on Changesets dependency analysis.

- [ ] **Step 3: Commit changeset**

Run:

```bash
git add .changeset/remote-native-caplets.md
git commit -m "chore: add changeset for remote native integrations"
```

---

### Task 7: Full verification

**Files:**

- No source files unless verification reveals issues.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-options.test.ts test/native-remote.test.ts test/process-cleanup.test.ts test/agent-plugins.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
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

- [ ] **Step 5: Commit verification fixes if any**

If verification required source changes, review the working tree and stage only the files changed by those fixes:

```bash
git status --short
git add packages/core/src/native/options.ts packages/core/src/native/remote.ts packages/core/src/native/service.ts packages/core/src/native.ts packages/opencode/src/index.ts packages/pi/src/index.ts README.md packages/opencode/README.md packages/pi/README.md plugins/caplets/skills/caplets/SKILL.md
git commit -m "fix: polish remote native integration support"
```

If some listed files were not changed, `git add` will still succeed for tracked files. If verification fixes touched tests or a changeset, add those concrete changed paths too after checking `git status --short`. If no fixes were needed, do not create an empty commit.

---

## Self-review notes

- Spec coverage: Tasks 1 and 2 cover core remote option resolution, Basic Auth, URL validation, remote MCP client use, refresh notifications, polling fallback, last known-good behavior, and cleanup. Tasks 3 and 4 cover OpenCode second-argument config and Pi settings/package args. Task 5 covers Codex/Claude MCP-backed remote guidance. Task 6 covers release metadata. Task 7 covers verification.
- Red-flag scan: no incomplete implementation steps are intentionally left. Conditional notes are limited to concrete SDK/host typing compatibility paths with stable public interfaces preserved.
- Type consistency: `NativeCapletsServiceOptions`, `NativeRemoteCapletsOptions`, `RemoteCapletsClient`, `RemoteCapletsClientFactory`, and `RemoteNativeCapletsService` names are introduced before later tasks consume them.
