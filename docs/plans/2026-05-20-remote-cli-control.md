# Remote CLI Control Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `caplets` CLI, OpenCode integration, and Pi integration use a unified `CAPLETS_MODE` / `CAPLETS_SERVER_*` interface so CLI commands can operate against a remote `caplets serve --transport http` service through an authenticated structured control endpoint.

**Architecture:** Introduce shared server-mode and base-URL resolution, change HTTP serving so `--path` is the service base path, add a `/control` API beside `/mcp`, then route remote-capable CLI commands through a typed remote control client. The server owns config, Caplet files, installed Caplets, and downstream auth; local clients format output and never receive secrets.

**Tech Stack:** TypeScript, Vitest, Hono, @hono/mcp Streamable HTTP transport, MCP SDK auth helpers, existing CapletsEngine, pnpm.

---

## File structure

- Create `packages/core/src/server/options.ts` for unified `CAPLETS_MODE`, `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, and `CAPLETS_SERVER_PASSWORD` parsing.
- Create `packages/core/src/remote-control/types.ts` for request/response envelopes, command names, and result payload types.
- Create `packages/core/src/remote-control/client.ts` for the local CLI remote control client.
- Create `packages/core/src/remote-control/dispatch.ts` for server-side command dispatch that reuses existing internal functions.
- Create `packages/core/src/remote-control/auth-flow.ts` for remote auth login flow storage and callback completion.
- Modify `packages/core/src/serve/options.ts` so HTTP `--path` is a service base path and `CAPLETS_SERVER_URL` supplies HTTP serve defaults.
- Modify `packages/core/src/serve/http.ts` to mount `{base}/healthz`, `{base}/mcp`, `{base}/control`, and `{base}/control/auth/callback/:flowId`.
- Modify `packages/core/src/serve/index.ts` only if new HTTP app dependencies need wiring.
- Modify `packages/core/src/native/options.ts` so native service resolution uses `CAPLETS_MODE` and `CAPLETS_SERVER_URL` as the target model.
- Modify `packages/opencode/src/index.ts` and `packages/pi/src/index.ts` to expose the unified option naming while preserving explicit host config seams.
- Modify `packages/core/src/cli.ts` to route remote-capable commands through `RemoteControlClient` when mode resolution selects remote.
- Modify `packages/core/src/cli/auth.ts` to expose structured auth helpers used by both local CLI and remote-control dispatch.
- Modify `packages/core/src/cli/inspection.ts` only if exported result types are needed by remote-control response typing.
- Modify `README.md`, `packages/cli/README.md`, `packages/opencode/README.md`, and `packages/pi/README.md` for the unified environment and base-path model.
- Add `packages/core/test/server-options.test.ts`.
- Add `packages/core/test/remote-control-client.test.ts`.
- Add `packages/core/test/remote-control-dispatch.test.ts`.
- Add `packages/core/test/cli-remote.test.ts`.
- Modify `packages/core/test/serve-options.test.ts`.
- Modify `packages/core/test/serve-http.test.ts`.
- Modify `packages/core/test/native-options.test.ts`.
- Modify `packages/opencode/test/opencode.test.ts`.
- Modify `packages/pi/test/pi.test.ts`.
- Add a changeset under `.changeset/` for `@caplets/core`, `caplets`, `@caplets/opencode`, and `@caplets/pi`.

---

## Task 1: Add unified server option resolution

**Files:**

- Create: `packages/core/src/server/options.ts`
- Test: `packages/core/test/server-options.test.ts`

- [ ] **Step 1: Write failing server option tests**

Create `packages/core/test/server-options.test.ts`:

```ts
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { CapletsError } from "../src/errors";
import {
  controlUrlForBase,
  healthUrlForBase,
  mcpUrlForBase,
  resolveCapletsMode,
  resolveCapletsServer,
} from "../src/server/options";

describe("server option resolution", () => {
  it("defaults to local mode without a server URL", () => {
    expect(resolveCapletsMode({}, {})).toEqual({ mode: "local" });
  });

  it("uses remote mode in auto when CAPLETS_SERVER_URL is set", () => {
    expect(resolveCapletsMode({}, { CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets" })).toEqual(
      { mode: "remote" },
    );
  });

  it("lets explicit local mode ignore server settings", () => {
    expect(
      resolveCapletsMode({}, { CAPLETS_MODE: "local", CAPLETS_SERVER_URL: "https://example.com" }),
    ).toEqual({ mode: "local" });
  });

  it("requires CAPLETS_SERVER_URL in forced remote mode", () => {
    expect(() => resolveCapletsMode({}, { CAPLETS_MODE: "remote" })).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects invalid CAPLETS_MODE values", () => {
    expect(() => resolveCapletsMode({}, { CAPLETS_MODE: "cloud" })).toThrow(
      /auto, local, or remote/u,
    );
  });

  it("normalizes a base URL and derives service endpoints", () => {
    const resolved = resolveCapletsServer(
      {},
      {
        CAPLETS_SERVER_URL: "https://example.com/caplets/",
        CAPLETS_SERVER_USER: "admin",
        CAPLETS_SERVER_PASSWORD: ["fixture", "password"].join("-"),
      },
    );

    expect(resolved).toMatchObject({
      baseUrl: new URL("https://example.com/caplets"),
      auth: {
        enabled: true,
        user: "admin",
        password: ["fixture", "password"].join("-"),
      },
    });
    expect(mcpUrlForBase(resolved.baseUrl).toString()).toBe("https://example.com/caplets/mcp");
    expect(controlUrlForBase(resolved.baseUrl).toString()).toBe(
      "https://example.com/caplets/control",
    );
    expect(healthUrlForBase(resolved.baseUrl).toString()).toBe(
      "https://example.com/caplets/healthz",
    );
    expect(resolved.requestInit.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`admin:${["fixture", "password"].join("-")}`).toString("base64")}`,
    });
  });

  it("derives endpoints from a root service base URL", () => {
    const base = new URL("http://127.0.0.1:5387");

    expect(mcpUrlForBase(base).toString()).toBe("http://127.0.0.1:5387/mcp");
    expect(controlUrlForBase(base).toString()).toBe("http://127.0.0.1:5387/control");
    expect(healthUrlForBase(base).toString()).toBe("http://127.0.0.1:5387/healthz");
  });

  it("rejects non-loopback http server URLs", () => {
    expect(() =>
      resolveCapletsServer({}, { CAPLETS_SERVER_URL: "http://caplets.example.com" }),
    ).toThrow(/https/u);
  });

  it("rejects username, password, query, or fragment in server URLs", () => {
    for (const url of [
      "https://user:pass@example.com/caplets",
      "https://example.com/caplets?token=secret",
      "https://example.com/caplets#fragment",
    ]) {
      expect(() => resolveCapletsServer({}, { CAPLETS_SERVER_URL: url })).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
      );
    }
  });

  it("requires a password when user is explicit", () => {
    expect(() =>
      resolveCapletsServer(
        {},
        {
          CAPLETS_SERVER_URL: "https://example.com",
          CAPLETS_SERVER_USER: "caplets",
        },
      ),
    ).toThrow(/requires a password/u);
  });
});
```

- [ ] **Step 2: Run server option tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/server-options.test.ts
```

Expected: FAIL with module-not-found for `../src/server/options`.

- [ ] **Step 3: Implement shared server option resolution**

Create `packages/core/src/server/options.ts`:

```ts
import { Buffer } from "node:buffer";
import { CapletsError } from "../errors";

export type CapletsMode = "auto" | "local" | "remote";

export type CapletsServerEnv = Partial<
  Record<
    "CAPLETS_MODE" | "CAPLETS_SERVER_URL" | "CAPLETS_SERVER_USER" | "CAPLETS_SERVER_PASSWORD",
    string
  >
>;

export type CapletsModeInput = {
  mode?: CapletsMode | undefined;
  serverUrl?: string | undefined;
};

export type CapletsServerInput = {
  url?: string | undefined;
  user?: string | undefined;
  password?: string | undefined;
  fetch?: typeof fetch | undefined;
};

export type CapletsServerAuth =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedCapletsServer = {
  baseUrl: URL;
  auth: CapletsServerAuth;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

const DEFAULT_SERVER_USER = "caplets";

export function resolveCapletsMode(
  input: CapletsModeInput = {},
  env: CapletsServerEnv = process.env,
): { mode: "local" } | { mode: "remote" } {
  const mode = parseMode(input.mode ?? env.CAPLETS_MODE ?? "auto");
  if (mode === "local") return { mode: "local" };

  const rawUrl =
    nonEmpty(input.serverUrl, "serverUrl") ??
    nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL");
  if (mode === "remote" && rawUrl === undefined) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_MODE=remote requires CAPLETS_SERVER_URL.");
  }
  return rawUrl === undefined ? { mode: "local" } : { mode: "remote" };
}

export function resolveCapletsServer(
  input: CapletsServerInput = {},
  env: CapletsServerEnv = process.env,
): ResolvedCapletsServer {
  const rawUrl =
    nonEmpty(input.url, "server.url") ?? nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL");
  if (rawUrl === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_SERVER_URL is required for remote Caplets mode.",
    );
  }

  const baseUrl = parseServerBaseUrl(rawUrl);
  const userWasExplicit = input.user !== undefined || hasEnv(env.CAPLETS_SERVER_USER);
  const user =
    nonEmpty(input.user, "server.user") ??
    nonEmpty(env.CAPLETS_SERVER_USER, "CAPLETS_SERVER_USER") ??
    DEFAULT_SERVER_USER;
  const password =
    nonEmpty(input.password, "server.password") ??
    nonEmpty(env.CAPLETS_SERVER_PASSWORD, "CAPLETS_SERVER_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote Caplets Basic Auth requires a password; set CAPLETS_SERVER_PASSWORD or server.password.",
    );
  }

  const auth: CapletsServerAuth =
    password === undefined ? { enabled: false, user } : { enabled: true, user, password };
  const requestInit: RequestInit = auth.enabled
    ? { headers: { Authorization: basicAuthHeader(auth.user, auth.password) } }
    : {};

  return {
    baseUrl,
    auth,
    requestInit,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function mcpUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "mcp");
}

export function controlUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "control");
}

export function healthUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "healthz");
}

export function appendBasePath(baseUrl: URL, child: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/${child}`;
  return url;
}

export function parseServerBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Invalid CAPLETS_SERVER_URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_SERVER_URL must not include username or password; use CAPLETS_SERVER_USER/CAPLETS_SERVER_PASSWORD instead.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_SERVER_URL must not include query or fragment.",
    );
  }
  if (url.protocol === "https:") {
    return normalizeBaseUrlPath(url);
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return normalizeBaseUrlPath(url);
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    "CAPLETS_SERVER_URL must use https except loopback development URLs.",
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLocaleLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function normalizeBaseUrlPath(url: URL): URL {
  const normalized = new URL(url.toString());
  normalized.pathname =
    normalized.pathname === "/" ? "/" : normalized.pathname.replace(/\/+$/u, "");
  return normalized;
}

function parseMode(value: string): CapletsMode {
  if (value === "auto" || value === "local" || value === "remote") return value;
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_MODE to be auto, local, or remote, got ${value}`,
  );
}

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  return trimmed;
}

function hasEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
```

- [ ] **Step 4: Run server option tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/server-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit server option resolution**

Run:

```sh
git add packages/core/src/server/options.ts packages/core/test/server-options.test.ts
git commit -m "feat(core): add unified Caplets server options"
```

---

## Task 2: Update native integrations to use unified env vars

**Files:**

- Modify: `packages/core/src/native/options.ts`
- Modify: `packages/core/src/native/remote.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/pi/src/index.ts`
- Test: `packages/core/test/native-options.test.ts`
- Test: `packages/core/test/native-remote.test.ts`
- Test: `packages/opencode/test/opencode.test.ts`
- Test: `packages/pi/test/pi.test.ts`

- [ ] **Step 1: Update native option tests for unified vars**

Modify `packages/core/test/native-options.test.ts` so env-driven tests use base URLs and new env names:

```ts
expect(
  resolveNativeCapletsServiceOptions({}, { CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets" }),
).toMatchObject({
  mode: "remote",
  remote: {
    url: new URL("http://127.0.0.1:5387/caplets/mcp"),
    auth: { enabled: false, user: "caplets" },
    pollIntervalMs: 30_000,
  },
});
```

Replace the explicit local-mode test with:

```ts
expect(
  resolveNativeCapletsServiceOptions(
    {},
    {
      CAPLETS_MODE: "local",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
    },
  ),
).toEqual({ mode: "local" });
```

Replace the missing remote URL assertion with:

```ts
expect(() => resolveNativeCapletsServiceOptions({}, { CAPLETS_MODE: "remote" })).toThrow(
  expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
);
```

Replace env override assertions with `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, and `CAPLETS_SERVER_PASSWORD`. Replace embedded credential error text to mention `CAPLETS_SERVER_USER/CAPLETS_SERVER_PASSWORD`.

- [ ] **Step 2: Update remote auth error guidance test**

Modify `packages/core/test/native-remote.test.ts` auth failure expectation:

```ts
await expect(service.execute("alpha", {})).rejects.toMatchObject({
  code: "AUTH_FAILED",
  message: expect.stringContaining("CAPLETS_SERVER_USER"),
} satisfies Partial<CapletsError>);
```

- [ ] **Step 3: Update OpenCode config test to pass base server config**

Modify `packages/opencode/test/opencode.test.ts` config propagation test to pass:

```ts
await plugin(
  {} as never,
  {
    mode: "remote",
    server: {
      url: "https://caplets.example.com/caplets",
      user: "caplets",
    },
    remote: { pollIntervalMs: 5_000 },
  } as never,
);

expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
  mode: "remote",
  server: {
    url: "https://caplets.example.com/caplets",
    user: "caplets",
  },
  remote: { pollIntervalMs: 5_000 },
});
```

- [ ] **Step 4: Update Pi settings tests to parse unified server shape**

In `packages/pi/test/pi.test.ts`, update the settings/args propagation tests so accepted settings include:

```json
{
  "caplets": {
    "mode": "remote",
    "server": {
      "url": "https://caplets.example.com/caplets",
      "user": "caplets"
    },
    "remote": {
      "pollIntervalMs": 5000
    }
  }
}
```

Expected options passed to `createNativeCapletsService`:

```ts
{
  mode: "remote",
  server: { url: "https://caplets.example.com/caplets", user: "caplets" },
  remote: { pollIntervalMs: 5_000 },
}
```

- [ ] **Step 5: Run native and integration tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/native-options.test.ts test/native-remote.test.ts
pnpm --filter @caplets/opencode test -- opencode.test.ts
pnpm --filter @caplets/pi test -- pi.test.ts
```

Expected: FAIL because implementation still reads the legacy remote env names and OpenCode/Pi config types do not expose `server`.

- [ ] **Step 6: Implement native option resolution with shared server options**

Modify `packages/core/src/native/options.ts`:

```ts
import {
  mcpUrlForBase,
  resolveCapletsMode,
  resolveCapletsServer,
  type CapletsMode,
  type CapletsServerEnv,
  type CapletsServerInput,
} from "../server/options";

export type NativeCapletsMode = CapletsMode;

export type NativeRemoteCapletsOptions = {
  pollIntervalMs?: number;
  fetch?: typeof fetch;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  server?: CapletsServerInput;
  remote?: NativeRemoteCapletsOptions;
};

export type NativeCapletsEnv = CapletsServerEnv;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const mode = resolveCapletsMode({ mode: input.mode, serverUrl: input.server?.url }, env);
  if (mode.mode === "local") return { mode: "local" };

  const server = resolveCapletsServer(
    {
      ...input.server,
      fetch: input.remote?.fetch ?? input.server?.fetch,
    },
    env,
  );

  return {
    mode: "remote",
    remote: {
      url: mcpUrlForBase(server.baseUrl),
      auth: server.auth,
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit: server.requestInit,
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}
```

Keep the existing `ResolvedNativeCapletsServiceOptions` type and `parsePollInterval()` helper. Remove URL parsing and Basic Auth helper duplication from this file.

- [ ] **Step 7: Update native remote auth guidance**

Modify `remoteAuthError()` in `packages/core/src/native/remote.ts`:

```ts
return new CapletsError(
  "AUTH_FAILED",
  "Remote Caplets authentication failed; check CAPLETS_SERVER_USER and CAPLETS_SERVER_PASSWORD.",
);
```

- [ ] **Step 8: Update OpenCode option type**

Modify `packages/opencode/src/index.ts`:

```ts
export type CapletsOpenCodeConfig = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;

function normalizeOpenCodeConfig(config: CapletsOpenCodeConfig | undefined): CapletsOpenCodeConfig {
  if (!config) return {};
  return {
    ...(config.mode ? { mode: config.mode } : {}),
    ...(config.server ? { server: config.server } : {}),
    ...(config.remote ? { remote: config.remote } : {}),
  };
}
```

- [ ] **Step 9: Update Pi option parsing**

Modify `packages/pi/src/index.ts`:

```ts
type PiNativeCapletsOptions = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;
```

In `parsePiNativeOptions()`, add parsing for `server`:

```ts
const server = objectProperty(value, "server");
if (server) {
  const parsedServer: NonNullable<PiNativeCapletsOptions["server"]> = {};
  for (const key of ["url", "user", "password"] as const) {
    const field = server[key];
    if (field !== undefined) {
      if (typeof field !== "string") return undefined;
      parsedServer[key] = field;
    }
  }
  result.server = parsedServer;
}
```

Keep `remote.pollIntervalMs` parsing and remove `remote.url`, `remote.user`, and `remote.password` parsing from the target shape.

- [ ] **Step 10: Run native and integration tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/native-options.test.ts test/native-remote.test.ts
pnpm --filter @caplets/opencode test -- opencode.test.ts
pnpm --filter @caplets/pi test -- pi.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit unified native config**

Run:

```sh
git add packages/core/src/native/options.ts packages/core/src/native/remote.ts packages/opencode/src/index.ts packages/pi/src/index.ts packages/core/test/native-options.test.ts packages/core/test/native-remote.test.ts packages/opencode/test/opencode.test.ts packages/pi/test/pi.test.ts
git commit -m "feat(native): use unified Caplets server config"
```

---

## Task 3: Change HTTP serve path to a service base path

**Files:**

- Modify: `packages/core/src/serve/options.ts`
- Modify: `packages/core/src/serve/http.ts`
- Test: `packages/core/test/serve-options.test.ts`
- Test: `packages/core/test/serve-http.test.ts`

- [ ] **Step 1: Update serve option tests for base path semantics**

Modify `packages/core/test/serve-options.test.ts`:

```ts
it("defaults HTTP serving to localhost port 5387 and root base path", () => {
  expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    auth: { enabled: false, user: "caplets" },
  });
});

it("uses CAPLETS_SERVER_URL as HTTP serve defaults", () => {
  expect(
    resolveServeOptions(
      { transport: "http" },
      {
        CAPLETS_SERVER_URL: "http://127.0.0.1:7777/caplets",
        CAPLETS_SERVER_PASSWORD: ["server", "password"].join("-"),
      },
    ),
  ).toMatchObject({
    transport: "http",
    host: "127.0.0.1",
    port: 7777,
    path: "/caplets",
    auth: {
      enabled: true,
      user: "caplets",
      password: ["server", "password"].join("-"),
    },
  });
});

it("lets explicit HTTP flags override CAPLETS_SERVER_URL defaults", () => {
  expect(
    resolveServeOptions(
      { transport: "http", host: "127.0.0.1", port: "9999", path: "/local" },
      { CAPLETS_SERVER_URL: "http://127.0.0.1:7777/caplets" },
    ),
  ).toMatchObject({ host: "127.0.0.1", port: 9999, path: "/local" });
});
```

- [ ] **Step 2: Update HTTP app tests for mounted subroutes**

Modify `packages/core/test/serve-http.test.ts` helper default path to `/`:

```ts
function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    auth: { enabled: false, user: "caplets" },
    warnUnauthenticatedNetwork: false,
    loopback: true,
    ...overrides,
  };
}
```

Add a base-path route test:

```ts
it("mounts health, mcp, and control under a service base path", async () => {
  const { engine } = testEngine();
  const app = createHttpServeApp(httpOptions({ path: "/caplets" }), engine, {
    writeErr: () => {},
  });

  expect((await app.request("http://127.0.0.1:5387/healthz")).status).toBe(404);
  expect((await app.request("http://127.0.0.1:5387/caplets/healthz")).status).toBe(200);
  expect((await app.request("http://127.0.0.1:5387/caplets/mcp/extra")).status).toBe(404);

  await engine.close();
});
```

Update root info assertions to expect `base`, `mcp`, `control`, and `health`:

```ts
await expect(root.json()).resolves.toMatchObject({
  name: "caplets",
  transport: "http",
  base: "/",
  mcp: "/mcp",
  control: "/control",
  health: "/healthz",
  auth: { type: "basic", enabled: false },
});
```

- [ ] **Step 3: Run serve tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-options.test.ts test/serve-http.test.ts
```

Expected: FAIL because current HTTP default path is `/mcp` and route mounting treats `path` as the MCP endpoint.

- [ ] **Step 4: Implement base-path serve option resolution**

Modify `packages/core/src/serve/options.ts`:

```ts
import { parseServerBaseUrl, isLoopbackHost as isServerLoopbackHost } from "../server/options";

export type ServeEnv = Partial<
  Record<"CAPLETS_SERVER_URL" | "CAPLETS_SERVER_USER" | "CAPLETS_SERVER_PASSWORD", string>
>;
```

Inside HTTP resolution:

```ts
const serverUrl = env.CAPLETS_SERVER_URL ? parseServerBaseUrl(env.CAPLETS_SERVER_URL) : undefined;
const host = nonEmpty(raw.host, "--host") ?? serverUrl?.hostname ?? "127.0.0.1";
const port = parsePort(raw.port ?? (serverUrl?.port ? Number(serverUrl.port) : 5387));
const path = normalizeHttpPath(raw.path ?? serverUrl?.pathname ?? "/");
```

Change the previous default from `"/mcp"` to `"/"`. Keep explicit flag validation and auth handling.

- [ ] **Step 5: Implement service-base route helpers**

Modify `packages/core/src/serve/http.ts` with helpers:

```ts
function routePath(basePath: string, child: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/u, "");
  return `${base}/${child}`;
}

function servicePaths(basePath: string): {
  base: string;
  health: string;
  mcp: string;
  control: string;
} {
  return {
    base: basePath,
    health: routePath(basePath, "healthz"),
    mcp: routePath(basePath, "mcp"),
    control: routePath(basePath, "control"),
  };
}
```

Use `const paths = servicePaths(options.path);` in `createHttpServeApp()`. Change routes:

```ts
app.get(paths.base, (c) => c.json({ name: "caplets", transport: "http", base: paths.base, mcp: paths.mcp, control: paths.control, health: paths.health, auth: { type: "basic", enabled: options.auth.enabled } }));
app.get(paths.health, (c) => c.json({ status: "ok", transport: "http", basePath: paths.base, mcpPath: paths.mcp, controlPath: paths.control }));
app.all(paths.mcp, basicAuth(options.auth), async (c) => { ...existing MCP session handling... });
```

Update `serveHttp()` logs:

```ts
const baseUrl = `http://${formatHost(options.host)}:${options.port}${options.path === "/" ? "" : options.path}`;
writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
writeErr(`MCP endpoint: ${baseUrl}/mcp\n`);
writeErr(`Control endpoint: ${baseUrl}/control\n`);
writeErr(`Health check: ${baseUrl}/healthz\n`);
```

- [ ] **Step 6: Run serve tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-options.test.ts test/serve-http.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit service base-path serving**

Run:

```sh
git add packages/core/src/serve/options.ts packages/core/src/serve/http.ts packages/core/test/serve-options.test.ts packages/core/test/serve-http.test.ts
git commit -m "feat(serve): mount HTTP service under a base path"
```

---

## Task 4: Add remote control client and response types

**Files:**

- Create: `packages/core/src/remote-control/types.ts`
- Create: `packages/core/src/remote-control/client.ts`
- Test: `packages/core/test/remote-control-client.test.ts`

- [ ] **Step 1: Write failing remote control client tests**

Create `packages/core/test/remote-control-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CapletsError } from "../src/errors";
import { RemoteControlClient } from "../src/remote-control/client";

describe("RemoteControlClient", () => {
  it("posts structured requests to the derived control endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { rows: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new RemoteControlClient({
      baseUrl: new URL("http://127.0.0.1:5387/caplets"),
      requestInit: { headers: { Authorization: "Basic test" } },
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.request("list", { includeDisabled: true })).resolves.toEqual({ rows: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/caplets/control"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Basic test",
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          command: "list",
          arguments: { includeDisabled: true },
        }),
      }),
    );
  });

  it("maps control errors into CapletsError", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "CONFIG_NOT_FOUND",
              message: "Remote config missing",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new RemoteControlClient({
      baseUrl: new URL("https://caplets.example.com"),
      requestInit: {},
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.request("list", {})).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      message: "Remote config missing",
    } satisfies Partial<CapletsError>);
  });

  it("uses safe auth and availability errors without leaking headers", async () => {
    const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = new RemoteControlClient({
      baseUrl: new URL("https://caplets.example.com/caplets"),
      requestInit: { headers: { Authorization: "Basic secret" } },
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.request("list", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("Remote Caplets control authentication failed"),
    } satisfies Partial<CapletsError>);
    await expect(client.request("list", {})).rejects.not.toThrow(/secret/u);
  });
});
```

- [ ] **Step 2: Run remote control client tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-client.test.ts
```

Expected: FAIL with module-not-found for `../src/remote-control/client`.

- [ ] **Step 3: Add remote control types**

Create `packages/core/src/remote-control/types.ts`:

```ts
export type RemoteCliCommand =
  | "list"
  | "get_caplet"
  | "check_backend"
  | "list_tools"
  | "search_tools"
  | "get_tool"
  | "call_tool"
  | "init"
  | "add"
  | "install"
  | "auth_login_start"
  | "auth_login_complete"
  | "auth_logout"
  | "auth_list";

export type RemoteCliRequest = {
  command: RemoteCliCommand;
  arguments: Record<string, unknown>;
};

export type RemoteCliResponse =
  | { ok: true; result: unknown; warnings?: string[] }
  | {
      ok: false;
      error: { code: string; message: string; nextAction?: string };
      warnings?: string[];
    };
```

- [ ] **Step 4: Add remote control client**

Create `packages/core/src/remote-control/client.ts`:

```ts
import { CapletsError, toSafeError } from "../errors";
import { controlUrlForBase } from "../server/options";
import type { RemoteCliCommand, RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlClientOptions = {
  baseUrl: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export class RemoteControlClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RemoteControlClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request(command: RemoteCliCommand, args: Record<string, unknown>): Promise<unknown> {
    const body: RemoteCliRequest = { command, arguments: args };
    let response: Response;
    try {
      response = await this.fetchImpl(controlUrlForBase(this.options.baseUrl), {
        ...this.options.requestInit,
        method: "POST",
        headers: {
          ...headersObject(this.options.requestInit.headers),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Remote Caplets server unavailable at ${safeBaseUrl(this.options.baseUrl)}.`,
        toSafeError(error),
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Remote Caplets control authentication failed; check CAPLETS_SERVER_USER and CAPLETS_SERVER_PASSWORD.",
      );
    }
    if (!response.ok) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Remote Caplets control request failed with HTTP ${response.status} at ${safeBaseUrl(this.options.baseUrl)}.`,
      );
    }

    const payload = (await response.json()) as RemoteCliResponse;
    if (!payload.ok) {
      throw new CapletsError(payload.error.code, payload.error.message, {
        ...(payload.error.nextAction ? { nextAction: payload.error.nextAction } : {}),
      });
    }
    return payload.result;
  }
}

function headersObject(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

function safeBaseUrl(baseUrl: URL): string {
  const safe = new URL(baseUrl.toString());
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}
```

- [ ] **Step 5: Run remote control client tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit remote control client**

Run:

```sh
git add packages/core/src/remote-control/types.ts packages/core/src/remote-control/client.ts packages/core/test/remote-control-client.test.ts
git commit -m "feat(cli): add remote control client"
```

---

## Task 5: Add control endpoint dispatch for read, execute, and mutation commands

**Files:**

- Create: `packages/core/src/remote-control/dispatch.ts`
- Modify: `packages/core/src/serve/http.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts`
- Test: `packages/core/test/serve-http.test.ts`

- [ ] **Step 1: Write failing dispatch tests**

Create `packages/core/test/remote-control-dispatch.test.ts` with read and mutation coverage:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchRemoteCliRequest } from "../src/remote-control/dispatch";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dispatchRemoteCliRequest", () => {
  it("lists remote server Caplets from server-side config", async () => {
    const fixture = remoteFixture();

    const result = await dispatchRemoteCliRequest(
      { command: "list", arguments: { includeDisabled: false } },
      fixture.context,
    );

    expect(result).toEqual({
      ok: true,
      result: [
        expect.objectContaining({
          server: "status",
          backend: "http",
          source: "global-config",
        }),
      ],
    });
  });

  it("executes direct Caplet operations through server-side engine", async () => {
    const fixture = remoteFixture();

    const result = await dispatchRemoteCliRequest(
      {
        command: "get_caplet",
        arguments: { caplet: "status", request: { operation: "get_caplet" } },
      },
      fixture.context,
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("Status API");
  });

  it("writes added Caplets to the server-side destination root", async () => {
    const fixture = remoteFixture();

    const result = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote-tools",
          options: { url: "https://mcp.example.com/mcp", transport: "http" },
        },
      },
      fixture.context,
    );

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        remote: true,
        label: "MCP",
        path: expect.any(String),
      }),
    });
    expect(existsSync(join(fixture.projectRoot, ".caplets", "remote-tools.md"))).toBe(true);
    expect(
      readFileSync(join(fixture.projectRoot, ".caplets", "remote-tools.md"), "utf8"),
    ).toContain("mcpServer:");
  });
});

function remoteFixture() {
  const dir = mkdtempSync(join(tmpdir(), "caplets-remote-control-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".caplets"), { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, ".caplets", "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status API",
          description: "Check status.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  writeFileSync(projectConfigPath, JSON.stringify({ mcpServers: {} }));
  return {
    projectRoot,
    context: {
      configPath,
      projectConfigPath,
      projectCapletsRoot: join(projectRoot, ".caplets"),
      authDir: join(dir, "state", "auth"),
      writeErr: () => {},
    },
  };
}
```

- [ ] **Step 2: Add HTTP control endpoint test**

Add to `packages/core/test/serve-http.test.ts`:

```ts
it("requires Basic Auth on the control endpoint and dispatches requests", async () => {
  const { engine } = testEngine();
  const password = ["control", "password"].join("-");
  const app = createHttpServeApp(
    httpOptions({ auth: { enabled: true, user: "caplets", password } }),
    engine,
    { writeErr: () => {} },
  );

  expect((await app.request("http://127.0.0.1:5387/control", { method: "POST" })).status).toBe(401);

  const response = await app.request("http://127.0.0.1:5387/control", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`caplets:${password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: "list",
      arguments: { includeDisabled: false },
    }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ok: true });

  await engine.close();
});
```

- [ ] **Step 3: Run dispatch and HTTP tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/serve-http.test.ts
```

Expected: FAIL because `dispatchRemoteCliRequest` and `/control` do not exist.

- [ ] **Step 4: Implement remote control dispatch**

Create `packages/core/src/remote-control/dispatch.ts`:

```ts
import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "../cli/add";
import { initConfig } from "../cli/init";
import { installCaplets } from "../cli/install";
import { listCaplets } from "../cli/inspection";
import { loadConfigWithSources } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { toSafeError } from "../errors";
import type { RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
};

export async function dispatchRemoteCliRequest(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
): Promise<RemoteCliResponse> {
  try {
    const result = await dispatchRemoteCliRequestUnsafe(request, context);
    return { ok: true, result };
  } catch (error) {
    const safe = toSafeError(error, "INTERNAL_ERROR") as {
      code?: string;
      message?: string;
      nextAction?: string;
    };
    return {
      ok: false,
      error: {
        code: safe.code ?? "INTERNAL_ERROR",
        message: safe.message ?? "Remote control command failed.",
        ...(safe.nextAction ? { nextAction: safe.nextAction } : {}),
      },
    };
  }
}

async function dispatchRemoteCliRequestUnsafe(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
): Promise<unknown> {
  switch (request.command) {
    case "list":
      return listCaplets(loadConfigWithSources(context.configPath, context.projectConfigPath), {
        includeDisabled: Boolean(request.arguments.includeDisabled),
      });
    case "get_caplet":
    case "check_backend":
    case "list_tools":
    case "search_tools":
    case "get_tool":
    case "call_tool":
      return await executeRemoteCapletOperation(request, context);
    case "init":
      return {
        remote: true,
        path: initConfig({
          path: context.configPath,
          force: Boolean(request.arguments.force),
        }),
      };
    case "add":
      return dispatchAdd(request.arguments, context.projectCapletsRoot);
    case "install":
      return {
        remote: true,
        ...installCaplets(stringArg(request.arguments.repo, "repo"), {
          capletIds: stringArrayArg(request.arguments.capletIds),
          force: Boolean(request.arguments.force),
          destinationRoot: context.projectCapletsRoot,
        }),
      };
    default:
      throw new Error(`Unsupported remote control command ${request.command}`);
  }
}

async function executeRemoteCapletOperation(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
): Promise<unknown> {
  const engine = new CapletsEngine({ ...context, watch: false });
  try {
    return await engine.execute(
      stringArg(request.arguments.caplet, "caplet"),
      objectArg(request.arguments.request, "request"),
    );
  } finally {
    await engine.close();
  }
}

function dispatchAdd(args: Record<string, unknown>, destinationRoot: string): unknown {
  const kind = stringArg(args.kind, "kind");
  const id = stringArg(args.id, "id");
  const options = objectArg(args.options, "options");
  const common = { ...options, destinationRoot, print: false };
  switch (kind) {
    case "cli":
      return { remote: true, label: "CLI", ...addCliCaplet(id, common) };
    case "mcp":
      return { remote: true, label: "MCP", ...addMcpCaplet(id, common) };
    case "openapi":
      return {
        remote: true,
        label: "OpenAPI",
        ...addOpenApiCaplet(id, common),
      };
    case "graphql":
      return {
        remote: true,
        label: "GraphQL",
        ...addGraphqlCaplet(id, common),
      };
    case "http":
      return { remote: true, label: "HTTP", ...addHttpCaplet(id, common) };
    default:
      throw new Error(`Unsupported add kind ${kind}`);
  }
}

function stringArg(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Expected string argument ${key}`);
  return value;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected string array argument capletIds");
  }
  return value;
}

function objectArg(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object argument ${key}`);
  return value as Record<string, unknown>;
}
```

- [ ] **Step 5: Wire `/control` into HTTP app**

Modify `packages/core/src/serve/http.ts`:

```ts
import { resolveProjectCapletsRoot } from "../config";
import { dispatchRemoteCliRequest } from "../remote-control/dispatch";
import type { RemoteCliRequest } from "../remote-control/types";
```

Add route after MCP route:

```ts
app.post(paths.control, basicAuth(options.auth), async (c) => {
  const request = (await c.req.json()) as RemoteCliRequest;
  const result = await dispatchRemoteCliRequest(request, {
    ...engineOptionsFromEngine(engine),
    projectCapletsRoot: resolveProjectCapletsRoot(),
    writeErr,
  });
  return c.json(result, result.ok ? 200 : 200);
});
```

To avoid reverse-engineering private `CapletsEngine` options, change `createHttpServeApp()` signature to accept an optional dispatch context:

```ts
type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: Omit<RemoteControlDispatchContext, "writeErr">;
};
```

Then pass `io.control ?? { projectCapletsRoot: resolveProjectCapletsRoot() }` to dispatch with `writeErr` merged. In `serveHttp()`, pass the same `engineOptions` values into `control`:

```ts
const app = createHttpServeApp(options, engine, {
  writeErr,
  control: {
    ...engineOptions,
    projectCapletsRoot: resolveProjectCapletsRoot(),
  },
});
```

Update tests that need temp config to pass `control` options when creating the app.

- [ ] **Step 6: Run dispatch and HTTP tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/serve-http.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit control endpoint dispatch**

Run:

```sh
git add packages/core/src/remote-control/dispatch.ts packages/core/src/serve/http.ts packages/core/test/remote-control-dispatch.test.ts packages/core/test/serve-http.test.ts
git commit -m "feat(serve): add remote CLI control endpoint"
```

---

## Task 6: Route read/execute CLI commands through remote control

**Files:**

- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Write failing CLI remote tests for list and direct operations**

Create `packages/core/test/cli-remote.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

describe("remote CLI routing", () => {
  it("routes list through remote control when CAPLETS_MODE selects remote", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                server: "github",
                backend: "mcp",
                name: "GitHub",
                description: "GitHub tools",
                disabled: false,
                status: "not_started",
                source: "global-config",
                path: "/srv/caplets/github.md",
                shadows: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(["list", "--json"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))[0]).toMatchObject({ server: "github" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/caplets/control"),
      expect.objectContaining({
        body: JSON.stringify({
          command: "list",
          arguments: { includeDisabled: false },
        }),
      }),
    );
  });

  it("routes call-tool through remote control and preserves JSON formatting", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { structuredContent: { json: { ok: true } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await runCli(["call-tool", "github.search", "--args", '{"q":"caplets"}', "--format", "json"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toEqual({
      structuredContent: { json: { ok: true } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/control"),
      expect.objectContaining({
        body: JSON.stringify({
          command: "call_tool",
          arguments: {
            caplet: "github",
            request: {
              operation: "call_tool",
              tool: "search",
              arguments: { q: "caplets" },
            },
          },
        }),
      }),
    );
  });

  it("keeps local-only config paths local even when remote is configured", async () => {
    const out: string[] = [];
    const fetchMock = vi.fn();

    await runCli(["config", "path"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as unknown as typeof fetch,
      writeOut: (value) => out.push(value),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join("")).toContain("config.json");
  });
});
```

- [ ] **Step 2: Run CLI remote tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-remote.test.ts
```

Expected: FAIL because `CliIO` has no `env` or `fetch`, and commands do not route remotely.

- [ ] **Step 3: Add CLI IO seams and remote helpers**

Modify `CliIO` in `packages/core/src/cli.ts`:

```ts
type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  authDir?: string;
  version?: string;
  setExitCode?: (code: number) => void;
  serve?: (options: ServeOptions) => Promise<void>;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: typeof fetch;
};
```

Add imports:

```ts
import { RemoteControlClient } from "./remote-control/client";
import type { RemoteCliCommand } from "./remote-control/types";
import { resolveCapletsMode, resolveCapletsServer } from "./server/options";
```

Add helper:

```ts
function remoteClientForCli(io: CliIO): RemoteControlClient | undefined {
  const env = io.env ?? process.env;
  if (resolveCapletsMode({}, env).mode !== "remote") return undefined;
  const server = resolveCapletsServer({ fetch: io.fetch }, env);
  return new RemoteControlClient({
    baseUrl: server.baseUrl,
    requestInit: server.requestInit,
    ...(server.fetch ? { fetch: server.fetch } : {}),
  });
}
```

Use `io.env` in `envConfigPath()` by changing it to accept env:

```ts
function envConfigPath(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.CAPLETS_CONFIG?.trim() || undefined;
}
```

Replace calls to `envConfigPath()` inside `createProgram(io)` with `envConfigPath(io.env ?? process.env)`.

- [ ] **Step 4: Route `list` remotely**

In the `list` action, add:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const rows = await remote.request("list", {
    includeDisabled: Boolean(options.all),
  });
  if (options.json || options.format === "json") {
    writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  writeOut(
    formatCapletList(rows as Parameters<typeof formatCapletList>[0], options.format ?? "plain"),
  );
  return;
}
```

Make the action async.

- [ ] **Step 5: Route direct operation commands remotely**

Modify `executeOperation()` to accept `remote?: RemoteControlClient`:

```ts
type ExecuteOperationIO = Required<Pick<CliIO, "writeOut" | "writeErr" | "setExitCode">> & {
  authDir?: string | undefined;
  format?: CliOutputFormat | undefined;
  remote?: RemoteControlClient | undefined;
};
```

At the start of `executeOperation()`:

```ts
const command = remoteCommandForOperation(request);
if (io.remote && command) {
  const result = await io.remote.request(command, { caplet, request });
  const output = cliOutputForOperation(result, { ...request, caplet }, io.format ?? "markdown");
  io.writeOut(typeof output === "string" ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`);
  if (isPlainObject(result) && result.isError === true) io.setExitCode(1);
  return;
}
```

Add helper:

```ts
function remoteCommandForOperation(request: Record<string, unknown>): RemoteCliCommand | undefined {
  switch (request.operation) {
    case "get_caplet":
    case "check_backend":
    case "list_tools":
    case "search_tools":
    case "get_tool":
    case "call_tool":
      return request.operation;
    default:
      return undefined;
  }
}
```

When each command calls `executeOperation`, pass `remote: remoteClientForCli(io)`.

- [ ] **Step 6: Run CLI remote tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-remote.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit remote read/execute CLI routing**

Run:

```sh
git add packages/core/src/cli.ts packages/core/test/cli-remote.test.ts
git commit -m "feat(cli): route read commands through remote control"
```

---

## Task 7: Route mutating CLI commands through remote control

**Files:**

- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Add failing mutation routing tests**

Append to `packages/core/test/cli-remote.test.ts`:

```ts
it("routes add mcp through remote control and labels the remote path", async () => {
  const out: string[] = [];
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            remote: true,
            label: "MCP",
            path: "/srv/caplets/.caplets/github.md",
            text: "mcpServer:\n",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await runCli(
    ["add", "mcp", "github", "--url", "https://mcp.example.com/mcp", "--transport", "http"],
    {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
      },
      fetch: fetchMock as typeof fetch,
      writeOut: (value) => out.push(value),
    },
  );

  expect(out.join("")).toBe("Wrote remote MCP Caplet to /srv/caplets/.caplets/github.md\n");
  expect(fetchMock).toHaveBeenCalledWith(
    new URL("http://127.0.0.1:5387/control"),
    expect.objectContaining({
      body: JSON.stringify({
        command: "add",
        arguments: {
          kind: "mcp",
          id: "github",
          options: {
            url: "https://mcp.example.com/mcp",
            transport: "http",
            global: undefined,
            print: undefined,
            output: undefined,
            force: undefined,
          },
        },
      }),
    }),
  );
});

it("routes install through remote control", async () => {
  const out: string[] = [];
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            remote: true,
            installed: [
              {
                id: "github",
                destination: "/srv/caplets/.caplets/github",
                source: "repo#caplets/github",
                kind: "directory",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await runCli(["install", "spiritledsoftware/caplets", "github"], {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
    },
    fetch: fetchMock as typeof fetch,
    writeOut: (value) => out.push(value),
  });

  expect(out.join("")).toBe("Installed github to remote /srv/caplets/.caplets/github\n");
});
```

- [ ] **Step 2: Run mutation routing tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-remote.test.ts
```

Expected: FAIL because mutating commands still call local helpers.

- [ ] **Step 3: Add remote add result formatter**

Modify `writeAddResult()` in `packages/core/src/cli.ts`:

```ts
function writeAddResult(
  writeOut: (value: string) => void,
  label: string,
  result: { path?: string; text: string; remote?: boolean },
): void {
  if (result.path) {
    writeOut(`Wrote ${result.remote ? "remote " : ""}${label} Caplet to ${result.path}\n`);
    return;
  }
  writeOut(result.text);
}
```

- [ ] **Step 4: Route add subcommands remotely**

For each `add` subcommand action, compute `const remote = remoteClientForCli(io);` and, when present, call:

```ts
const result = (await remote.request("add", {
  kind: "mcp",
  id,
  options,
})) as { path?: string; text: string; remote?: boolean };
writeAddResult(writeOut, "MCP", result);
return;
```

Use `kind: "cli"`, `"openapi"`, `"graphql"`, and `"http"` for the other add subcommands. Do not pass `destinationRoot`; the server dispatch owns server-side destinations.

- [ ] **Step 5: Route install remotely**

In the `install` action, add remote branch before local `installCaplets()`:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const result = (await remote.request("install", {
    repo,
    capletIds,
    force: Boolean(options.force),
  })) as { installed: Array<{ id: string; destination: string }> };
  for (const caplet of result.installed) {
    writeOut(`Installed ${caplet.id} to remote ${caplet.destination}\n`);
  }
  return;
}
```

- [ ] **Step 6: Route init remotely when remote mode is active**

In the `init` action, add remote branch:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const result = (await remote.request("init", {
    force: Boolean(options.force),
  })) as {
    path: string;
    remote: true;
  };
  writeOut(`Created remote Caplets config at ${result.path}\n`);
  return;
}
```

- [ ] **Step 7: Run mutation routing tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-remote.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit remote mutation routing**

Run:

```sh
git add packages/core/src/cli.ts packages/core/test/cli-remote.test.ts
git commit -m "feat(cli): route mutations through remote control"
```

---

## Task 8: Add remote auth list/logout and remote auth login flow

**Files:**

- Create: `packages/core/src/remote-control/auth-flow.ts`
- Modify: `packages/core/src/remote-control/dispatch.ts`
- Modify: `packages/core/src/serve/http.ts`
- Modify: `packages/core/src/cli/auth.ts`
- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts`
- Test: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Expose structured local auth helpers**

Modify `packages/core/src/cli/auth.ts` to export result-producing helpers in addition to current printing wrappers:

```ts
export type AuthStatusRow = {
  server: string;
  status: "missing" | "expired" | "authenticated";
  expiresAt?: string;
  scope?: string;
};

export function listAuthRows(options: { authDir?: string; configPath?: string }): AuthStatusRow[] {
  const config = loadConfig(options.configPath);
  return authTargets(config)
    .sort((left, right) => left.server.localeCompare(right.server))
    .map((server) => {
      const bundle = readTokenBundle(server.server, options.authDir);
      const status = !bundle
        ? "missing"
        : isTokenBundleExpired(bundle)
          ? "expired"
          : "authenticated";
      return {
        server: server.server,
        status,
        ...(bundle?.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
        ...(bundle?.scope ? { scope: bundle.scope } : {}),
      };
    });
}

export function logoutAuthResult(
  serverId: string,
  options: { authDir?: string; configPath?: string },
): { server: string; deleted: boolean } {
  const target = findAuthTarget(serverId, loadConfig(options.configPath));
  assertLoginTarget(target, serverId);
  return {
    server: serverId,
    deleted: deleteTokenBundle(serverId, options.authDir),
  };
}
```

Change existing `listAuth()` and `logoutAuth()` to use these helpers and preserve exact current output.

- [ ] **Step 2: Add failing remote auth tests**

Append to `packages/core/test/remote-control-dispatch.test.ts`:

```ts
it("lists and logs out server-side auth credentials", async () => {
  const fixture = remoteFixtureWithOAuth();
  writeTokenBundle(
    {
      server: "remote",
      accessToken: "secret-access-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
    fixture.context.authDir,
  );

  const listed = await dispatchRemoteCliRequest(
    { command: "auth_list", arguments: {} },
    fixture.context,
  );
  expect(listed).toEqual({
    ok: true,
    result: [expect.objectContaining({ server: "remote", status: "authenticated" })],
  });

  const loggedOut = await dispatchRemoteCliRequest(
    { command: "auth_logout", arguments: { server: "remote" } },
    fixture.context,
  );
  expect(loggedOut).toEqual({
    ok: true,
    result: { server: "remote", deleted: true },
  });
});
```

Add helper config with an OAuth remote MCP server and import `writeTokenBundle`.

Append to `packages/core/test/cli-remote.test.ts`:

```ts
it("routes auth list and logout through remote control", async () => {
  const out: string[] = [];
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: [{ server: "remote", status: "authenticated" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { server: "remote", deleted: true },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

  const io = {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387",
    },
    fetch: fetchMock as typeof fetch,
    writeOut: (value: string) => out.push(value),
  };

  await runCli(["auth", "list", "--json"], io);
  await runCli(["auth", "logout", "remote"], io);

  expect(JSON.parse(out[0]!)).toEqual([{ server: "remote", status: "authenticated" }]);
  expect(out[1]).toBe("Deleted remote OAuth credentials for `remote`.\n");
});
```

- [ ] **Step 3: Run remote auth tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/cli-remote.test.ts
```

Expected: FAIL because auth dispatch and CLI auth routing do not exist.

- [ ] **Step 4: Implement auth list/logout dispatch**

Modify `packages/core/src/remote-control/dispatch.ts` imports:

```ts
import { listAuthRows, logoutAuthResult } from "../cli/auth";
```

Add cases:

```ts
case "auth_list":
  return listAuthRows({ configPath: context.configPath, authDir: context.authDir });
case "auth_logout":
  return logoutAuthResult(stringArg(request.arguments.server, "server"), {
    configPath: context.configPath,
    authDir: context.authDir,
  });
```

- [ ] **Step 5: Implement CLI auth list/logout routing**

In `packages/core/src/cli.ts`, route `auth list` remotely:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const rows = await remote.request("auth_list", {});
  if (format === "json") {
    writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  writeOut(formatAuthRows(rows as AuthStatusRow[], format));
  return;
}
```

Extract current `listAuth` formatting into an exported helper or keep a small CLI-local formatter matching existing text.

Route `auth logout` remotely:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const result = (await remote.request("auth_logout", {
    server: serverId,
  })) as {
    deleted: boolean;
  };
  writeOut(
    result.deleted
      ? `Deleted remote OAuth credentials for \`${serverId}\`.\n`
      : `No remote OAuth credentials found for \`${serverId}\`.\n`,
  );
  return;
}
```

- [ ] **Step 6: Add remote auth login flow store**

Create `packages/core/src/remote-control/auth-flow.ts`:

```ts
import { randomUUID } from "node:crypto";

export type RemoteAuthFlow = {
  id: string;
  server: string;
  authorizationUrl: string;
  createdAt: number;
  complete(callbackUrl: string): Promise<void>;
};

export class RemoteAuthFlowStore {
  private readonly flows = new Map<string, RemoteAuthFlow>();

  create(flow: Omit<RemoteAuthFlow, "id" | "createdAt">): RemoteAuthFlow {
    const created: RemoteAuthFlow = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...flow,
    };
    this.flows.set(created.id, created);
    return created;
  }

  get(id: string): RemoteAuthFlow | undefined {
    return this.flows.get(id);
  }

  delete(id: string): void {
    this.flows.delete(id);
  }
}
```

- [ ] **Step 7: Refactor OAuth start/complete for remote callbacks**

Modify `packages/core/src/auth.ts` to add start/complete helpers that use an externally supplied redirect URI. Add these exports:

```ts
export type StartedOAuthFlow = {
  authorizationUrl: string;
  complete(callbackUrl: string): Promise<void>;
};

export async function startOAuthFlow(
  server: CapletServerConfig,
  options: {
    redirectUri: string;
    authDir?: string;
    print?: (line: string) => void;
  },
): Promise<StartedOAuthFlow>;

export async function startGenericOAuthFlow(
  target: GenericAuthTarget,
  options: {
    redirectUri: string;
    authDir?: string;
    print?: (line: string) => void;
  },
): Promise<StartedOAuthFlow>;
```

For MCP OAuth, reuse `FileOAuthProvider` with `redirectUri`. Capture `redirectUrl` from `redirectToAuthorization`. Return `complete(callbackUrl)` that extracts `code` and `state`, validates state, calls `auth(provider, { serverUrl: server.url, authorizationCode: code, scope })`, and stores tokens through the existing provider.

For generic OAuth, move the URL construction and token exchange code from `runGenericOAuthFlow()` into the new start helper. Return `complete(callbackUrl)` that extracts `code` and `state`, validates state, exchanges the authorization code against the token endpoint, and writes the token bundle through existing `writeTokenBundle()` logic.

Then rewrite existing `runOAuthFlow()` and `runGenericOAuthFlow()` as wrappers that create the loopback callback, call the new start helper, open/print the returned authorization URL, wait for callback/manual input, call `complete()`, and preserve existing output behavior.

- [ ] **Step 8: Implement auth login dispatch and HTTP callback**

Add `authFlowStore?: RemoteAuthFlowStore` to `HttpServeIo` and create a default store inside `createHttpServeApp()`.

In `dispatchRemoteCliRequestUnsafe()` add:

```ts
case "auth_login_start":
  return await startRemoteAuthLogin(stringArg(request.arguments.server, "server"), context);
case "auth_login_complete":
  return await completeRemoteAuthLogin(
    stringArg(request.arguments.flowId, "flowId"),
    stringArg(request.arguments.callbackUrl, "callbackUrl"),
    context,
  );
```

The start result shape:

```ts
{
  server: string;
  flowId: string;
  authorizationUrl: string;
}
```

Add route in `packages/core/src/serve/http.ts`:

```ts
app.get(routePath(paths.control, "auth/callback/:flowId"), async (c) => {
  const flowId = c.req.param("flowId");
  const callbackUrl = c.req.url;
  const result = await dispatchRemoteCliRequest(
    { command: "auth_login_complete", arguments: { flowId, callbackUrl } },
    controlContext,
  );
  return result.ok
    ? c.text("Caplets authentication complete. You can return to your terminal.")
    : c.text(result.error.message, 400);
});
```

- [ ] **Step 9: Implement CLI remote auth login**

In `auth login` action, remote branch:

```ts
const remote = remoteClientForCli(io);
if (remote) {
  const started = (await remote.request("auth_login_start", {
    server: serverId,
  })) as {
    server: string;
    flowId: string;
    authorizationUrl: string;
  };
  writeOut(`Open this URL to authorize ${serverId}:\n${started.authorizationUrl}\n`);
  if (options.open !== false) {
    await openBrowser(started.authorizationUrl);
  }
  writeOut(`Authenticated \`${serverId}\`.\n`);
  return;
}
```

Reuse the existing browser-opening helper or extract one from `auth.ts`. For v1, the browser callback completes against the server route, so the CLI does not receive tokens.

- [ ] **Step 10: Run auth-focused tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/auth.test.ts test/remote-control-dispatch.test.ts test/cli-remote.test.ts test/serve-http.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit remote auth support**

Run:

```sh
git add packages/core/src/auth.ts packages/core/src/cli/auth.ts packages/core/src/cli.ts packages/core/src/remote-control/auth-flow.ts packages/core/src/remote-control/dispatch.ts packages/core/src/serve/http.ts packages/core/test/remote-control-dispatch.test.ts packages/core/test/cli-remote.test.ts packages/core/test/serve-http.test.ts
git commit -m "feat(cli): store remote auth credentials on server"
```

---

## Task 9: Add end-to-end remote CLI coverage

**Files:**

- Modify: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Add in-process remote server CLI test**

Append an integration-style test to `packages/core/test/cli-remote.test.ts`:

```ts
it("uses a remote in-process control app without mutating local config", async () => {
  const remote = makeRemoteServerFixture();
  const local = makeLocalClientFixture();
  const out: string[] = [];

  await runCli(["add", "mcp", "remote-tools", "--url", "https://mcp.example.com/mcp"], {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
      CAPLETS_CONFIG: local.configPath,
    },
    fetch: remote.app.fetch.bind(remote.app) as typeof fetch,
    writeOut: (value) => out.push(value),
  });

  expect(existsSync(join(remote.projectRoot, ".caplets", "remote-tools.md"))).toBe(true);
  expect(existsSync(join(local.projectRoot, ".caplets", "remote-tools.md"))).toBe(false);
  expect(out.join("")).toContain("remote");

  await remote.engine.close();
});
```

Implement `makeRemoteServerFixture()` and `makeLocalClientFixture()` in the test file using the patterns from `serve-http.test.ts` and `cli.test.ts`.

- [ ] **Step 2: Run end-to-end remote CLI test**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-remote.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit end-to-end coverage**

Run:

```sh
git add packages/core/test/cli-remote.test.ts
git commit -m "test(cli): cover remote control server routing"
```

---

## Task 10: Update documentation and release metadata

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/opencode/README.md`
- Modify: `packages/pi/README.md`
- Create: `.changeset/remote-cli-control.md`

- [ ] **Step 1: Update root and CLI README remote service docs**

In `README.md` and `packages/cli/README.md`, replace old remote env examples with:

```sh
CAPLETS_MODE=remote \
CAPLETS_SERVER_URL=https://caplets.example.com/caplets \
CAPLETS_SERVER_USER=caplets \
CAPLETS_SERVER_PASSWORD=... \
caplets list
```

Document endpoints:

```text
CAPLETS_SERVER_URL=https://caplets.example.com/caplets
MCP endpoint:      https://caplets.example.com/caplets/mcp
Control endpoint:  https://caplets.example.com/caplets/control
Health endpoint:   https://caplets.example.com/caplets/healthz
```

Document serving:

```sh
CAPLETS_SERVER_URL=http://127.0.0.1:5387/caplets \
CAPLETS_SERVER_PASSWORD=... \
caplets serve --transport http
```

State that `--path` is the service base path.

- [ ] **Step 2: Update OpenCode and Pi READMEs**

In `packages/opencode/README.md` and `packages/pi/README.md`, document:

```sh
CAPLETS_MODE=remote
CAPLETS_SERVER_URL=https://caplets.example.com/caplets
CAPLETS_SERVER_USER=caplets
CAPLETS_SERVER_PASSWORD=...
```

Show explicit config shape:

```json
{
  "mode": "remote",
  "server": {
    "url": "https://caplets.example.com/caplets",
    "user": "caplets"
  },
  "remote": {
    "pollIntervalMs": 30000
  }
}
```

- [ ] **Step 3: Add changeset**

Create `.changeset/remote-cli-control.md`:

```md
---
"@caplets/core": minor
"caplets": minor
"@caplets/opencode": minor
"@caplets/pi": minor
---

Add unified Caplets server configuration and remote CLI control support. `caplets serve --transport http` now mounts a service base path with `/mcp`, `/control`, and `/healthz` subroutes, while CLI and native integrations can use `CAPLETS_MODE` plus `CAPLETS_SERVER_*` settings to operate against a remote Caplets service.
```

- [ ] **Step 4: Run docs format check**

Run:

```sh
pnpm exec oxfmt --check README.md packages/cli/README.md packages/opencode/README.md packages/pi/README.md .changeset/remote-cli-control.md
```

Expected: PASS.

- [ ] **Step 5: Commit docs and changeset**

Run:

```sh
git add README.md packages/cli/README.md packages/opencode/README.md packages/pi/README.md .changeset/remote-cli-control.md
git commit -m "docs: document remote CLI control mode"
```

---

## Task 11: Final verification

**Files:**

- No source files changed in this task unless verification finds defects.

- [ ] **Step 1: Run LSP diagnostics**

Run diagnostics before package commands:

```text
lsp_diagnostics packages/core/src
lsp_diagnostics packages/opencode/src
lsp_diagnostics packages/pi/src
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run focused test suites**

Run:

```sh
pnpm --filter @caplets/core test -- test/server-options.test.ts test/serve-options.test.ts test/serve-http.test.ts test/remote-control-client.test.ts test/remote-control-dispatch.test.ts test/cli-remote.test.ts test/native-options.test.ts test/native-remote.test.ts test/auth.test.ts
pnpm --filter @caplets/opencode test -- opencode.test.ts
pnpm --filter @caplets/pi test -- pi.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package checks**

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm schema:check
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Run full verification gate**

Run:

```sh
pnpm verify
```

Expected: PASS.

- [ ] **Step 5: Inspect final git state**

Run:

```sh
git status --short
git log --oneline -12
```

Expected: only intentional tracked changes are present, and commits from this plan appear in history.

---

## Self-review

- Spec coverage: Tasks 1 and 2 cover unified environment and native/CLI mode selection. Task 3 covers base-path HTTP serving. Tasks 4 and 5 cover the structured `/control` API and command-semantic server dispatch. Tasks 6 and 7 cover remote CLI read, execute, and mutation routing. Task 8 covers server-owned downstream auth credentials and remote auth login/list/logout. Task 9 verifies remote server state changes without local mutation. Task 10 covers docs and release metadata. Task 11 covers verification.
- Placeholder scan: The plan contains no placeholders, deferred requirements, or unspecified test commands.
- Type consistency: `CapletsMode`, `CapletsServerInput`, `ResolvedCapletsServer`, `RemoteCliRequest`, `RemoteCliResponse`, `RemoteControlClient`, `RemoteControlDispatchContext`, and `RemoteAuthFlowStore` are introduced before later tasks consume them.
