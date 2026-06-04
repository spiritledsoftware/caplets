# Remote Attach And Agent Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `caplets serve` local-only, make `caplets attach` the remote-backed MCP server for self-hosted and Cloud upstreams, keep OpenCode/Pi on the shared resolver, and remove Codex/Claude native plugin artifacts.

**Architecture:** Consolidate remote selection in Core around `CAPLETS_MODE` and `CAPLETS_REMOTE_*`, then reuse that resolver from the attach command and native integrations. `serve` keeps the existing local `CapletsEngine` path, while `attach` creates a remote-plus-local-overlay MCP surface and starts Project Binding automatically for Cloud selections.

**Tech Stack:** TypeScript, Commander, Vitest, MCP SDK stdio and Streamable HTTP transports, Hono HTTP server, existing Cloud Auth store/client, existing Project Binding session manager, OpenCode and Pi native integration packages, pnpm.

---

## Source Spec

- Root design spec: `/Users/ianpascoe/src/caplets-mono/docs/superpowers/specs/2026-06-04-remote-attach-and-agent-integration-design.md`
- Core plan location follows `core/AGENTS.md`: `/Users/ianpascoe/src/caplets-mono/core/docs/plans/`

## File Structure

- Modify `packages/core/src/remote/options.ts`: expand mode parsing to `auto | local | remote | cloud`, add Cloud URL detection, and keep self-hosted auth resolution separate from Cloud Auth.
- Add `packages/core/src/remote/selection.ts`: resolve a full upstream selection for commands and integrations, including self-hosted remote options, Cloud credentials, refresh, selected workspace, and Project Binding metadata.
- Modify `packages/core/src/project-binding/attach.ts`: consume the shared selection helper for one-shot Project Binding probes and long-running sessions; stop treating saved Cloud Auth as an implicit remote when no remote URL or Cloud mode is selected.
- Add `packages/core/src/attach/options.ts`: resolve `caplets attach` server options, including `--transport stdio|http`, HTTP bind/auth options, and the remote selection.
- Add `packages/core/src/attach/server.ts`: start the remote-backed MCP server for stdio and HTTP transports and own the attach server lifecycle.
- Add `packages/core/src/serve/native-session.ts`: register MCP tools from a `NativeCapletsService` so `attach` can expose the remote-plus-local-overlay surface without inventing a second merge path.
- Modify `packages/core/src/serve/http.ts`: extract the session creation seam so HTTP serving can use either local `CapletsMcpSession` or native-service-backed sessions.
- Modify `packages/core/src/serve/index.ts`: export reusable serve helpers used by attach.
- Modify `packages/core/src/cli.ts`: change `caplets attach` from binding-only default to MCP server default; keep `--once` as the Project Binding smoke path.
- Modify `packages/core/src/native/options.ts`: use the shared resolver and expose `local | remote | cloud` semantics to OpenCode/Pi.
- Modify `packages/core/src/native/service.ts`: start Cloud Project Binding from saved Cloud Auth in Cloud mode and preserve local overlay precedence.
- Modify `packages/core/src/native/remote.ts`: adjust auth failure guidance for self-hosted vs Cloud modes.
- Modify `packages/core/src/native.ts`: export new resolver and option types.
- Modify `packages/core/test/remote-options.test.ts`: cover `CAPLETS_MODE=cloud`, auto Cloud detection, invalid mode/URL combinations, and self-hosted auth.
- Add `packages/core/test/remote-selection.test.ts`: cover saved Cloud Auth loading, refresh, workspace matching, token precedence, and no-implicit-cloud behavior.
- Modify `packages/core/test/attach-cli.test.ts`: cover attach server option parsing, `--once` Project Binding smoke behavior, local-mode rejection, and Cloud mode errors.
- Add `packages/core/test/attach-server.test.ts`: cover stdio/http attach server delegation using a fake native service and fake serve transports.
- Modify `packages/core/test/cloud-auth-refresh-attach.test.ts`: assert refresh occurs only through explicit Cloud selection.
- Modify `packages/core/test/native-options.test.ts`: cover Cloud mode and auto Cloud detection for native integrations.
- Modify `packages/core/test/native-remote.test.ts`: cover Cloud Project Binding startup and fallback semantics.
- Modify `packages/core/test/agent-plugins.test.ts`: invert plugin assertions so Codex/Claude plugin artifacts are absent and manual MCP docs are present.
- Delete `plugins/caplets/.codex-plugin/plugin.json`.
- Delete `plugins/caplets/.claude-plugin/plugin.json`.
- Delete `plugins/caplets/mcp.json`.
- Delete `plugins/caplets/skills/caplets/SKILL.md`.
- Delete `plugins/caplets/assets/icon.png` only if no package README or landing asset still references it; otherwise move the asset to a non-plugin docs asset path in the same task.
- Delete `plugins/caplets/` after required children are removed.
- Delete `.agents/plugins/marketplace.json`.
- Delete `.claude-plugin/marketplace.json`.
- Delete `scripts/sync-plugin-versions.ts`.
- Modify `package.json`: remove `scripts/sync-plugin-versions.ts` from `version-packages`.
- Modify `README.md`: replace Codex/Claude plugin install docs with manual MCP config for `serve` and `attach`.
- Modify `packages/cli/README.md` if it contains plugin install guidance.
- Modify `docs/native-integrations.md`: document OpenCode/Pi `CAPLETS_MODE` and `CAPLETS_REMOTE_*` behavior.
- Modify `packages/opencode/README.md`: document local, self-hosted, and Cloud env flows.
- Modify `packages/pi/README.md`: document local, self-hosted, and Cloud env/settings flows.
- Add a Changesets entry for `@caplets/core`, `caplets`, `@caplets/opencode`, and `@caplets/pi`.

---

## Task 1: Shared Remote Mode Semantics

**Files:**

- Modify: `packages/core/src/remote/options.ts`
- Modify: `packages/core/test/remote-options.test.ts`

- [ ] **Step 1: Add failing resolver tests**

Append these cases to `packages/core/test/remote-options.test.ts`:

```ts
it("supports explicit cloud mode with a Caplets Cloud URL", () => {
  expect(
    resolveRemoteMode(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
      },
    ),
  ).toEqual({ mode: "cloud" });
});

it("detects cloud mode in auto from CAPLETS_REMOTE_URL", () => {
  expect(resolveRemoteMode({}, { CAPLETS_REMOTE_URL: "https://cloud.caplets.dev" })).toEqual({
    mode: "cloud",
  });
});

it("keeps non-Cloud CAPLETS_REMOTE_URL in self-hosted remote mode", () => {
  expect(
    resolveRemoteMode({}, { CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets" }),
  ).toEqual({
    mode: "remote",
  });
});

it("rejects explicit cloud mode with a non-Cloud URL", () => {
  expect(() =>
    resolveRemoteMode(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
      },
    ),
  ).toThrow(/CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL to point at Caplets Cloud/u);
});

it("rejects explicit cloud mode without CAPLETS_REMOTE_URL", () => {
  expect(() => resolveRemoteMode({}, { CAPLETS_MODE: "cloud" })).toThrow(
    /CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL/u,
  );
});

it("parses cloud as a valid CAPLETS_MODE value", () => {
  expect(() => resolveRemoteMode({}, { CAPLETS_MODE: "sidecar" })).toThrow(
    /Expected CAPLETS_MODE to be auto, local, remote, or cloud/u,
  );
});
```

- [ ] **Step 2: Run resolver tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/remote-options.test.ts
```

Expected: FAIL because `cloud` is not accepted and auto always maps any remote URL to `remote`.

- [ ] **Step 3: Implement mode expansion**

In `packages/core/src/remote/options.ts`, change the mode type and parser:

```ts
export type CapletsRemoteMode = "local" | "remote" | "cloud";

export function resolveRemoteMode(
  input: CapletsRemoteModeInput = {},
  env: CapletsRemoteEnv = process.env,
): { mode: CapletsRemoteMode } {
  const mode = parseCapletsMode(input.mode ?? env.CAPLETS_MODE ?? "auto");
  if (mode === "local") return { mode: "local" };

  const rawUrl =
    nonEmpty(input.remoteUrl, "remoteUrl") ??
    nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");

  if (mode === "remote") {
    if (rawUrl === undefined) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_MODE=remote requires CAPLETS_REMOTE_URL or remoteUrl.",
      );
    }
    return { mode: "remote" };
  }

  if (mode === "cloud") {
    if (rawUrl === undefined) {
      throw new CapletsError("REQUEST_INVALID", "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL.");
    }
    if (!isCapletsCloudUrl(rawUrl)) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL to point at Caplets Cloud.",
      );
    }
    return { mode: "cloud" };
  }

  if (rawUrl === undefined) return { mode: "local" };
  return isCapletsCloudUrl(rawUrl) ? { mode: "cloud" } : { mode: "remote" };
}

export function isCapletsCloudUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "cloud.caplets.dev" || host.endsWith(".preview.caplets.dev");
}

function parseCapletsMode(value: string): "auto" | CapletsRemoteMode {
  if (value === "auto" || value === "local" || value === "remote" || value === "cloud") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_MODE to be auto, local, remote, or cloud, got ${value}`,
  );
}
```

- [ ] **Step 4: Run resolver tests to verify green**

Run:

```bash
pnpm --filter @caplets/core test -- test/remote-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/remote/options.ts packages/core/test/remote-options.test.ts
git commit -m "feat(core): resolve cloud remote mode"
```

---

## Task 2: Full Upstream Selection With Cloud Auth

**Files:**

- Add: `packages/core/src/remote/selection.ts`
- Modify: `packages/core/src/project-binding/attach.ts`
- Add: `packages/core/test/remote-selection.test.ts`
- Modify: `packages/core/test/cloud-auth-refresh-attach.test.ts`

- [ ] **Step 1: Add failing selection tests**

Create `packages/core/test/remote-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { resolveRemoteSelection } from "../src/remote/selection";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("resolveRemoteSelection", () => {
  it("rejects attach selection in local mode", async () => {
    await expect(resolveRemoteSelection({}, { CAPLETS_MODE: "local" })).rejects.toThrow(
      /caplets attach requires a remote upstream; use caplets serve for local-only MCP/u,
    );
  });

  it("rejects auto mode without a remote URL for attach", async () => {
    await expect(resolveRemoteSelection({}, {})).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
  });

  it("resolves self-hosted remote auth from CAPLETS_REMOTE variables", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
          CAPLETS_REMOTE_TOKEN: "remote-token",
        },
      ),
    ).resolves.toMatchObject({
      kind: "self_hosted_remote",
      remote: {
        baseUrl: new URL("https://caplets.example.com/caplets"),
        auth: { type: "bearer", token: "remote-token" },
      },
    });
  });

  it("uses saved Cloud Auth in cloud mode and ignores self-hosted token vars", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(hostedCredentials({ accessToken: "cloud-access" }));

    const resolved = await resolveRemoteSelection(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_REMOTE_TOKEN: "self-hosted-token",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "personal",
      remote: {
        baseUrl: new URL("https://cloud.caplets.dev"),
        auth: { type: "bearer", token: "cloud-access" },
      },
    });
  });

  it("refreshes expired Cloud credentials before returning the upstream", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
      }),
    );

    const resolved = await resolveRemoteSelection(
      {
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://cloud.caplets.dev/api/cloud-client/refresh");
          expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
          return Response.json({
            status: "authenticated",
            cloudUrl: "https://cloud.caplets.dev",
            workspaceId: "workspace_personal",
            workspaceSlug: "personal",
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z",
            scope: ["project_binding:read", "project_binding:write"],
            tokenType: "Bearer",
            credentialFamilyId: "family_123",
          });
        },
      },
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved.remote.auth).toEqual({ type: "bearer", token: "new-access" });
  });

  it("requires Cloud Auth when cloud mode is selected", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "cloud_auth_required",
    });
  });
});
```

- [ ] **Step 2: Run selection tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/remote-selection.test.ts
```

Expected: FAIL because `remote/selection.ts` does not exist.

- [ ] **Step 3: Implement `resolveRemoteSelection`**

Create `packages/core/src/remote/selection.ts` with these exports and behavior:

```ts
import { CloudAuthClient } from "../cloud-auth/client";
import { CloudAuthStore, type CloudAuthCredentials } from "../cloud-auth/store";
import { projectBindingError } from "../project-binding/errors";
import { resolveCapletsRemote, resolveRemoteMode, type ResolvedCapletsRemote } from "./options";

export type RemoteSelectionInput = {
  remoteUrl?: string;
  user?: string;
  password?: string;
  token?: string;
  workspace?: string;
  fetch?: typeof fetch;
  requireUpstream?: boolean;
};

export type ResolvedRemoteSelection =
  | {
      kind: "self_hosted_remote";
      remote: ResolvedCapletsRemote;
    }
  | {
      kind: "hosted_cloud";
      remote: ResolvedCapletsRemote;
      selectedWorkspace: string;
      credentials: CloudAuthCredentials;
      cloudPresence: {
        url: URL;
        accessToken: string;
        workspaceId: string;
      };
    };

export async function resolveRemoteSelection(
  input: RemoteSelectionInput = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedRemoteSelection> {
  const mode = resolveRemoteMode({ mode: env.CAPLETS_MODE, remoteUrl: input.remoteUrl }, env);
  if (mode.mode === "local") {
    throw new Error(
      "caplets attach requires a remote upstream; use caplets serve for local-only MCP.",
    );
  }

  if (mode.mode === "remote") {
    return {
      kind: "self_hosted_remote",
      remote: resolveCapletsRemote(
        {
          url: input.remoteUrl,
          user: input.user,
          password: input.password,
          token: input.token,
          workspace: input.workspace,
          fetch: input.fetch,
        },
        env,
      ),
    };
  }

  const store = new CloudAuthStore({ env });
  let credentials = await store.load();
  if (!credentials?.accessToken) throw projectBindingError("cloud_auth_required");

  if (credentialsNeedRefresh(credentials)) {
    if (!credentials.refreshToken) throw projectBindingError("cloud_auth_required");
    const refreshed = await new CloudAuthClient({
      cloudUrl: credentials.cloudUrl,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }).refresh({ refreshToken: credentials.refreshToken });
    credentials = {
      ...credentials,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
      createdAt: credentials.createdAt,
      lastRefreshAt: new Date().toISOString(),
    };
    await store.save(credentials);
  }

  const selectedWorkspace = credentials.workspaceSlug ?? credentials.workspaceId;
  if (
    input.workspace &&
    input.workspace !== credentials.workspaceId &&
    input.workspace !== credentials.workspaceSlug
  ) {
    throw projectBindingError(
      "workspace_switch_required",
      `Requested workspace ${input.workspace} differs from saved Selected Workspace ${selectedWorkspace}.`,
    );
  }

  const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL ?? credentials.cloudUrl;
  const remote = resolveCapletsRemote(
    {
      url: remoteUrl,
      token: credentials.accessToken,
      workspace: selectedWorkspace,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    },
    {},
  );

  return {
    kind: "hosted_cloud",
    remote,
    selectedWorkspace,
    credentials,
    cloudPresence: {
      url: new URL(remoteUrl),
      accessToken: credentials.accessToken,
      workspaceId: credentials.workspaceId,
    },
  };
}

function credentialsNeedRefresh(credentials: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}
```

During implementation, replace the plain `Error` local-mode failure with `CapletsError("REQUEST_INVALID", ...)` so JSON CLI handling remains structured.

- [ ] **Step 4: Update Project Binding attach to use selection**

In `packages/core/src/project-binding/attach.ts`:

- Replace direct `resolveCapletsRemote(...)` calls with `await resolveRemoteSelection(...)`.
- Remove `hasExplicitRemote(...)`; saved Cloud Auth must not implicitly select Cloud without `CAPLETS_MODE=cloud` or `CAPLETS_MODE=auto` plus a Cloud `CAPLETS_REMOTE_URL`.
- Keep `authMode` values as `"self_hosted_remote"` and `"hosted_cloud"` from `selection.kind`.
- Keep `selectedWorkspace` only for Cloud selections.

The resolved return should be shaped like:

```ts
const selection = await resolveRemoteSelection(remoteInput, env);
return {
  projectRoot: raw.projectRoot ?? process.cwd(),
  json: raw.json === true,
  verbose: raw.verbose === true,
  once: raw.once === true,
  remote: selection.remote,
  authMode: selection.kind,
  ...(selection.kind === "hosted_cloud"
    ? { selectedWorkspace: selection.selectedWorkspace }
    : remoteInput.workspace
      ? { selectedWorkspace: remoteInput.workspace }
      : {}),
};
```

- [ ] **Step 5: Update Cloud refresh attach tests**

In `packages/core/test/cloud-auth-refresh-attach.test.ts`, update every attach call that expects Cloud Auth to pass:

```ts
{
  CAPLETS_MODE: "cloud",
  CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
  CAPLETS_CLOUD_AUTH_PATH: path,
}
```

Add one regression test:

```ts
it("does not implicitly use saved Cloud Auth without cloud mode or a Cloud remote URL", async () => {
  const path = tempCloudAuthPath();
  await new CloudAuthStore({ path }).save(hostedCredentials());

  await expect(
    attachProjectOnce({ projectRoot: "/repo" }, { CAPLETS_CLOUD_AUTH_PATH: path }),
  ).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
});
```

- [ ] **Step 6: Run selection and attach tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/remote-selection.test.ts test/cloud-auth-refresh-attach.test.ts test/attach-cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/remote/selection.ts packages/core/src/project-binding/attach.ts packages/core/test/remote-selection.test.ts packages/core/test/cloud-auth-refresh-attach.test.ts packages/core/test/attach-cli.test.ts
git commit -m "feat(core): select remote upstreams for attach"
```

---

## Task 3: Native-Service-Backed MCP Sessions

**Files:**

- Add: `packages/core/src/serve/native-session.ts`
- Modify: `packages/core/src/serve/index.ts`
- Add: `packages/core/test/attach-server.test.ts`

- [ ] **Step 1: Add failing session tests**

Create `packages/core/test/attach-server.test.ts` with a fake MCP server:

```ts
import { describe, expect, it, vi } from "vitest";
import { NativeCapletsMcpSession } from "../src/serve/native-session";

describe("NativeCapletsMcpSession", () => {
  it("registers tools from a native Caplets service", async () => {
    const registered = new Map<string, unknown>();
    const server = {
      registerTool: vi.fn((name: string, definition: unknown, callback: unknown) => {
        registered.set(name, { definition, callback });
        return { remove: vi.fn(), update: vi.fn() };
      }),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = {
      listTools: () => [
        {
          caplet: "remote-alpha",
          toolName: "caplets_remote_alpha",
          title: "Remote Alpha",
          description: "Remote alpha tool",
          promptGuidance: [],
          inputSchema: {
            type: "object",
            properties: { operation: { type: "string", enum: ["inspect"] } },
          },
          operationNames: ["inspect"],
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };

    const session = new NativeCapletsMcpSession(service, { server });

    expect([...registered.keys()]).toEqual(["remote-alpha"]);
    const tool = registered.get("remote-alpha") as {
      callback: (request: unknown) => Promise<unknown>;
    };
    await expect(tool.callback({ operation: "inspect" })).resolves.toEqual({ ok: true });
    expect(service.execute).toHaveBeenCalledWith("remote-alpha", { operation: "inspect" });
    await session.close();
    expect(service.close).toHaveBeenCalledOnce();
  });

  it("updates registered tools when the native service changes", () => {
    let listener: ((tools: unknown[]) => void) | undefined;
    const removed = vi.fn();
    const updates: unknown[] = [];
    const server = {
      registerTool: vi.fn((_name: string, _definition: unknown, _callback: unknown) => ({
        remove: removed,
        update: (definition: unknown) => updates.push(definition),
      })),
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = {
      listTools: () => [
        { caplet: "alpha", title: "Alpha", description: "Alpha", promptGuidance: [] },
      ],
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn((nextListener: (tools: unknown[]) => void) => {
        listener = nextListener;
        return () => undefined;
      }),
      close: vi.fn(async () => undefined),
    };

    new NativeCapletsMcpSession(service as never, { server });
    listener?.([{ caplet: "beta", title: "Beta", description: "Beta", promptGuidance: [] }]);

    expect(removed).toHaveBeenCalledOnce();
    expect(server.registerTool).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ title: "Beta" }),
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run session tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-server.test.ts
```

Expected: FAIL because `serve/native-session.ts` does not exist.

- [ ] **Step 3: Implement native MCP session**

Create `packages/core/src/serve/native-session.ts`:

```ts
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { version as packageJsonVersion } from "../../package.json";
import type { NativeCapletsService, NativeCapletTool } from "../native/service";

export type NativeToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

export type NativeCapletsMcpSessionOptions = {
  server?: NativeToolServer;
};

export class NativeCapletsMcpSession {
  readonly server: NativeToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly service: NativeCapletsService,
    options: NativeCapletsMcpSessionOptions = {},
  ) {
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.unsubscribe = service.onToolsChanged((tools) => this.reconcileTools(tools));
    this.reconcileTools(service.listTools());
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.tools.clear();
    await this.server.close();
    await this.service.close();
  }

  private reconcileTools(next: NativeCapletTool[]): void {
    const enabled = new Map(next.map((tool) => [tool.caplet, tool]));
    for (const [id, registered] of this.tools) {
      const tool = enabled.get(id);
      if (!tool) {
        registered.remove();
        this.tools.delete(id);
        continue;
      }
      registered.update(this.definition(tool));
    }
    for (const tool of enabled.values()) {
      if (!this.tools.has(tool.caplet)) {
        this.tools.set(
          tool.caplet,
          this.server.registerTool(tool.caplet, this.definition(tool), async (request) =>
            this.service.execute(tool.caplet, request),
          ),
        );
      }
    }
  }

  private definition(tool: NativeCapletTool) {
    return {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }
}
```

During implementation, verify the installed MCP SDK overload. If `registerTool` requires Zod `paramsSchema` instead of raw JSON Schema, convert missing or raw schemas through the existing generated Caplets schema for remote tools and document the lossless raw schema follow-up in the commit body.

- [ ] **Step 4: Export the session**

In `packages/core/src/serve/index.ts`, export:

```ts
export { NativeCapletsMcpSession } from "./native-session";
export type { NativeCapletsMcpSessionOptions, NativeToolServer } from "./native-session";
```

- [ ] **Step 5: Run session tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/serve/native-session.ts packages/core/src/serve/index.ts packages/core/test/attach-server.test.ts
git commit -m "feat(core): expose native caplets over mcp"
```

---

## Task 4: `caplets attach` MCP Server

**Files:**

- Add: `packages/core/src/attach/options.ts`
- Add: `packages/core/src/attach/server.ts`
- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/test/attach-cli.test.ts`
- Modify: `packages/core/test/attach-server.test.ts`

- [ ] **Step 1: Add failing CLI contract tests**

In `packages/core/test/attach-cli.test.ts`, update help expectations:

```ts
expect(out.join("")).toContain("Start a remote-backed Caplets MCP server.");
expect(out.join("")).toContain("--transport <transport>");
expect(out.join("")).toContain("--once");
```

Add tests:

```ts
it("runs attach as a stdio MCP server by default", async () => {
  const served: unknown[] = [];
  await runCli(["attach"], {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
    },
    attachServe: async (options) => {
      served.push(options);
    },
  } as never);

  expect(served).toHaveLength(1);
  expect(served[0]).toMatchObject({
    transport: "stdio",
    selection: { kind: "self_hosted_remote" },
  });
});

it("rejects attach server in local mode", async () => {
  await expect(
    runCli(["attach"], {
      env: { CAPLETS_MODE: "local" },
      attachServe: async () => undefined,
    } as never),
  ).rejects.toThrow(/use caplets serve for local-only MCP/u);
});

it("keeps attach --once as the finite Project Binding smoke path", async () => {
  const out: string[] = [];
  await runCli(["attach", "--once", "--remote-url", "https://caplets.example.com/caplets"], {
    fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
    writeOut: (value) => out.push(value),
  });
  expect(out.join("")).toContain("Project Binding available at");
});
```

The `attachServe` seam is intentionally test-only and mirrors the existing `serve` seam.

- [ ] **Step 2: Run attach CLI tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-cli.test.ts
```

Expected: FAIL because `attach` does not accept `--transport` and defaults to Project Binding session behavior.

- [ ] **Step 3: Implement attach option resolution**

Create `packages/core/src/attach/options.ts`:

```ts
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "../serve/options";
import {
  resolveRemoteSelection,
  type RemoteSelectionInput,
  type ResolvedRemoteSelection,
} from "../remote/selection";

export type RawAttachServeOptions = RemoteSelectionInput &
  RawServeOptions & {
    projectRoot?: string;
  };

export type AttachServeOptions = ServeOptions & {
  projectRoot: string;
  selection: ResolvedRemoteSelection;
};

export async function resolveAttachServeOptions(
  raw: RawAttachServeOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<AttachServeOptions> {
  const selection = await resolveRemoteSelection(raw, env);
  const serve = resolveServeOptions(raw, env);
  return {
    ...serve,
    projectRoot: raw.projectRoot ?? process.cwd(),
    selection,
  };
}
```

- [ ] **Step 4: Implement attach server lifecycle**

Create `packages/core/src/attach/server.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { createNativeCapletsService } from "../native/service";
import { NativeCapletsMcpSession } from "../serve/native-session";
import { serveHttpWithSessionFactory } from "../serve/http";
import type { AttachServeOptions } from "./options";

export type AttachServeIo = {
  writeErr?: (value: string) => void;
};

export async function attachResolvedCaplets(
  options: AttachServeOptions,
  io: AttachServeIo = {},
): Promise<void> {
  const service = createNativeCapletsService({
    mode: options.selection.kind === "hosted_cloud" ? "cloud" : "remote",
    server: {
      url: options.selection.remote.baseUrl.toString(),
      fetch: options.selection.remote.fetch,
    },
    remote: {
      fetch: options.selection.remote.fetch,
      cloud:
        options.selection.kind === "hosted_cloud"
          ? {
              url: options.selection.cloudPresence.url.toString(),
              accessToken: options.selection.cloudPresence.accessToken,
              workspaceId: options.selection.cloudPresence.workspaceId,
              projectRoot: options.projectRoot,
            }
          : undefined,
    },
    ...(io.writeErr ? { writeErr: io.writeErr } : {}),
  });
  await service.reload();

  if (options.transport === "stdio") {
    const session = new NativeCapletsMcpSession(service);
    await session.connect(new StdioServerTransport());
    return;
  }

  await serveHttpWithSessionFactory(
    options,
    () => new NativeCapletsMcpSession(service),
    io.writeErr,
  );
}
```

During implementation, copy credentials and request headers from `selection.remote.requestInit` into the native remote client options. The snippet above shows the lifecycle shape; the final code must preserve Bearer and Basic Auth headers.

- [ ] **Step 5: Extract HTTP session factory**

In `packages/core/src/serve/http.ts`, extract the existing `createHttpSession(...)` path behind a function that can accept either:

```ts
type HttpMcpSessionFactory = () => {
  connect(transport: StreamableHTTPTransport): Promise<void>;
  close(): Promise<void>;
};
```

Export:

```ts
export async function serveHttpWithSessionFactory(
  options: HttpServeOptions,
  createSession: HttpMcpSessionFactory,
  writeErr?: (value: string) => void,
): Promise<void>;
```

Keep `serveHttp(...)` behavior unchanged by calling the new helper with a factory that creates the existing local `CapletsMcpSession`.

- [ ] **Step 6: Wire CLI default attach behavior**

In `packages/core/src/cli.ts`:

- Add `attachServe?: (options: AttachServeOptions) => Promise<void>` to `CliIO`.
- Add attach options `--transport`, `--host`, `--port`, `--path`, `--user`, `--password`, `--token`, `--allow-unauthenticated-http`, and `--trust-proxy`.
- Keep `--once` on the existing `attachProjectOnce(...)` path.
- For non-`--once`, call `resolveAttachServeOptions(...)`, then `io.attachServe ?? attachResolvedCaplets`.
- Change description to `Start a remote-backed Caplets MCP server.`

- [ ] **Step 7: Run attach tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-cli.test.ts test/attach-server.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/attach/options.ts packages/core/src/attach/server.ts packages/core/src/serve/http.ts packages/core/src/cli.ts packages/core/test/attach-cli.test.ts packages/core/test/attach-server.test.ts
git commit -m "feat(core): serve remote mcp with attach"
```

---

## Task 5: Native Integration Cloud Mode

**Files:**

- Modify: `packages/core/src/native/options.ts`
- Modify: `packages/core/src/native/service.ts`
- Modify: `packages/core/src/native/remote.ts`
- Modify: `packages/core/src/native.ts`
- Modify: `packages/core/test/native-options.test.ts`
- Modify: `packages/core/test/native-remote.test.ts`

- [ ] **Step 1: Add failing native option tests**

Append to `packages/core/test/native-options.test.ts`:

```ts
it("uses cloud mode in auto when CAPLETS_REMOTE_URL points at Caplets Cloud", () => {
  expect(
    resolveNativeCapletsServiceOptions(
      {},
      {
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
      },
    ),
  ).toMatchObject({
    mode: "cloud",
    remote: {
      url: new URL("https://cloud.caplets.dev/mcp"),
    },
  });
});

it("uses cloud mode when CAPLETS_MODE=cloud is explicit", () => {
  expect(
    resolveNativeCapletsServiceOptions(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
      },
    ),
  ).toMatchObject({ mode: "cloud" });
});

it("rejects CAPLETS_MODE=cloud with a self-hosted remote URL", () => {
  expect(() =>
    resolveNativeCapletsServiceOptions(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
      },
    ),
  ).toThrow(/Caplets Cloud/u);
});
```

- [ ] **Step 2: Add failing native Cloud service tests**

Append to `packages/core/test/native-remote.test.ts`:

```ts
it("starts Cloud Project Binding when native service runs in cloud mode", async () => {
  const path = tempCloudAuthPath();
  await new CloudAuthStore({ path }).save(hostedCredentials({ accessToken: "cloud-access" }));
  const factory = vi.fn(() => client([{ name: "remote", description: "Remote" }]).api);

  const service = createNativeCapletsService({
    mode: "cloud",
    server: { url: "https://cloud.caplets.dev" },
    remoteClientFactory: factory,
    projectConfigPath: tempProjectConfigWithTool("local"),
  } as never);

  await service.reload();
  expect(service.listTools().map((tool) => tool.caplet)).toContain("remote");
  await service.close();
});
```

Use existing test helpers in this file for local overlay config, or add a small helper that writes `.caplets/config.json` into a temp directory and returns the path.

- [ ] **Step 3: Run native tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-options.test.ts test/native-remote.test.ts
```

Expected: FAIL because native mode only supports `local | remote`.

- [ ] **Step 4: Update native option types**

In `packages/core/src/native/options.ts`:

- Change `type CapletsMode = "auto" | "local" | "remote";` to include `"cloud"`.
- Let `ResolvedNativeCapletsServiceOptions` use `mode: "remote" | "cloud"` for remote-backed services.
- Call `resolveRemoteMode(...)` from Task 1.
- For Cloud mode, return the MCP URL and request headers needed for Cloud Auth resolution but do not require `CAPLETS_CLOUD_TOKEN` env vars.

The final union should be:

```ts
export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | {
      mode: "remote" | "cloud";
      remote: {
        url: URL;
        auth: NativeRemoteAuthOptions;
        pollIntervalMs: number;
        requestInit: RequestInit;
        cloud?: ResolvedNativeCloudPresenceOptions;
        fetch?: typeof fetch;
      };
    };
```

- [ ] **Step 5: Load saved Cloud Auth for native Cloud mode**

In `packages/core/src/native/service.ts`, update `createNativeCapletsService(...)`:

- Treat `resolved.mode === "cloud"` the same as remote-backed for composition.
- Before creating the SDK remote client, use the shared selection helper or a native equivalent to load saved Cloud Auth credentials.
- Populate `resolved.remote.requestInit` with `Authorization: Bearer <cloud access token>`.
- Populate `resolved.remote.cloud` with Cloud Project Binding presence options.
- Preserve existing behavior where explicit self-hosted remote mode fails hard, while auto Cloud fallback can warn and return local only when the remote setup cannot initialize.

Keep local overlay precedence unchanged:

```ts
const localIds = new Set(localTools.map((tool) => tool.caplet));
return [...remoteTools.filter((tool) => !localIds.has(tool.caplet)), ...localTools];
```

- [ ] **Step 6: Update remote auth error copy**

In `packages/core/src/native/remote.ts`, make `remoteAuthError(...)` accept an auth kind:

```ts
function remoteAuthError(kind: "self_hosted_remote" | "hosted_cloud"): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    kind === "hosted_cloud"
      ? "Caplets Cloud authentication failed; run caplets cloud auth login."
      : "Remote Caplets authentication failed; check CAPLETS_REMOTE_TOKEN or CAPLETS_REMOTE_USER and CAPLETS_REMOTE_PASSWORD.",
  );
}
```

Thread the kind from native service creation into `RemoteNativeCapletsService`.

- [ ] **Step 7: Run native tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/native-options.test.ts test/native-remote.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/native/options.ts packages/core/src/native/service.ts packages/core/src/native/remote.ts packages/core/src/native.ts packages/core/test/native-options.test.ts packages/core/test/native-remote.test.ts
git commit -m "feat(core): drive native integrations from cloud mode"
```

---

## Task 6: OpenCode And Pi Docs/Config Validation

**Files:**

- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/test/opencode.test.ts`
- Modify: `packages/opencode/README.md`
- Modify: `packages/pi/src/index.ts`
- Modify: `packages/pi/test/pi.test.ts`
- Modify: `packages/pi/README.md`
- Modify: `docs/native-integrations.md`

- [ ] **Step 1: Add integration config tests**

In `packages/opencode/test/opencode.test.ts`, add:

```ts
it("passes cloud mode config into the native service", async () => {
  vi.resetModules();
  const nativeMocks = {
    createNativeCapletsService: vi.fn(() => ({
      listTools: () => [],
      execute: vi.fn(async () => ({})),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    })),
    registerNativeCapletsProcessCleanup: vi.fn(),
  };
  vi.doMock("@caplets/core/native", () => nativeMocks);
  const plugin = (await import("../src/index")).default;

  await plugin(
    {} as never,
    { mode: "cloud", server: { url: "https://cloud.caplets.dev" } } as never,
  );

  expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith({
    mode: "cloud",
    server: { url: "https://cloud.caplets.dev" },
  });
});
```

In `packages/pi/test/pi.test.ts`, add a settings extraction case:

```ts
it("loads cloud mode from Pi settings", async () => {
  fsMocks.readFile.mockImplementation(async (path: string) =>
    path.includes(".pi/agent/settings.json")
      ? JSON.stringify({ caplets: { mode: "cloud", server: { url: "https://cloud.caplets.dev" } } })
      : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
  );

  await capletsPiExtension(mockPiApi());

  expect(nativeMocks.createNativeCapletsService).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "cloud",
      server: { url: "https://cloud.caplets.dev" },
    }),
  );
});
```

- [ ] **Step 2: Run package tests to verify red or confirm no code change needed**

Run:

```bash
pnpm --filter @caplets/opencode test
pnpm --filter @caplets/pi test
```

Expected: PASS if existing config plumbing already accepts `"cloud"` after Task 5 type changes; otherwise FAIL on narrow type validation and fix in Step 3.

- [ ] **Step 3: Confirm config types accept cloud mode**

In `packages/opencode/src/index.ts` and `packages/pi/src/index.ts`, keep the current config shape but ensure the imported `NativeCapletsServiceOptions` type includes `mode: "cloud"` after Task 5:

```ts
export type CapletsOpenCodeConfig = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;
type PiNativeCapletsOptions = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;
```

No runtime special case should be added for Cloud.

- [ ] **Step 4: Update native integration docs**

In `docs/native-integrations.md`, add this contract:

```md
## Remote Selection

OpenCode and Pi use the same resolver as `caplets attach`.

- `CAPLETS_MODE=local` exposes local/user/project Caplets only.
- `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and connects to a self-hosted Caplets service.
- `CAPLETS_MODE=cloud` requires `CAPLETS_REMOTE_URL` pointing at Caplets Cloud and uses saved `caplets cloud auth login` credentials.
- `CAPLETS_MODE=auto` treats Cloud URLs as Cloud, non-Cloud remote URLs as self-hosted, and no remote URL as local.

Cloud mode starts Project Binding automatically for the current project and overlays local/project Caplets over the remote workspace.
```

In both integration READMEs, include the three copyable env examples:

```bash
CAPLETS_MODE=local opencode
CAPLETS_MODE=remote CAPLETS_REMOTE_URL=https://caplets.example.com/caplets opencode
CAPLETS_MODE=cloud CAPLETS_REMOTE_URL=https://cloud.caplets.dev opencode
```

Use `pi` in the Pi README examples.

- [ ] **Step 5: Run package tests**

Run:

```bash
pnpm --filter @caplets/opencode test
pnpm --filter @caplets/pi test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/index.ts packages/opencode/test/opencode.test.ts packages/opencode/README.md packages/pi/src/index.ts packages/pi/test/pi.test.ts packages/pi/README.md docs/native-integrations.md
git commit -m "docs(core): document native cloud mode"
```

---

## Task 7: Remove Codex And Claude Plugin Artifacts

**Files:**

- Delete: `plugins/caplets/.codex-plugin/plugin.json`
- Delete: `plugins/caplets/.claude-plugin/plugin.json`
- Delete: `plugins/caplets/mcp.json`
- Delete: `plugins/caplets/skills/caplets/SKILL.md`
- Delete: `plugins/caplets/assets/icon.png` or move it to a non-plugin asset path if still referenced
- Delete: `.agents/plugins/marketplace.json`
- Delete: `.claude-plugin/marketplace.json`
- Delete: `scripts/sync-plugin-versions.ts`
- Modify: `package.json`
- Modify: `packages/core/test/agent-plugins.test.ts`

- [ ] **Step 1: Invert plugin artifact tests**

Replace `packages/core/test/agent-plugins.test.ts` with contract tests that assert absence:

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Codex and Claude manual MCP setup", () => {
  it("does not ship native Codex or Claude plugin artifacts", () => {
    for (const removedPath of [
      "plugins/caplets",
      ".agents/plugins/marketplace.json",
      ".claude-plugin/marketplace.json",
      "scripts/sync-plugin-versions.ts",
    ]) {
      expect(existsSync(path.join(repoRoot, removedPath)), removedPath).toBe(false);
    }
  });

  it("documents manual MCP config for Codex and Claude users", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain('"command": "caplets"');
    expect(readme).toContain('"args": ["serve"]');
    expect(readme).toContain('"args": ["attach"]');
    expect(readme).not.toMatch(/plugin marketplace add|plugin install caplets@caplets/u);
  });

  it("does not keep version-package plugin sync wiring", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["version-packages"] ?? "").not.toContain("sync-plugin-versions");
  });
});
```

- [ ] **Step 2: Run plugin tests to verify red**

Run:

```bash
pnpm --filter @caplets/core test -- test/agent-plugins.test.ts
```

Expected: FAIL because plugin artifacts still exist and README still references plugin install flows.

- [ ] **Step 3: Delete plugin artifacts**

Delete these paths:

```bash
git rm -r plugins/caplets .agents/plugins/marketplace.json .claude-plugin/marketplace.json scripts/sync-plugin-versions.ts
```

If `git rm -r plugins/caplets` fails because the icon is referenced by `README.md`, move the image first:

```bash
mkdir -p docs/assets
git mv plugins/caplets/assets/icon.png docs/assets/caplets-icon.png
git rm -r plugins/caplets .agents/plugins/marketplace.json .claude-plugin/marketplace.json scripts/sync-plugin-versions.ts
```

Then update the README image path from `plugins/caplets/assets/icon.png` to `docs/assets/caplets-icon.png`.

- [ ] **Step 4: Remove version sync wiring**

In `package.json`, remove `scripts/sync-plugin-versions.ts` from the `version-packages` script. The final script must still run Changesets and formatting for remaining generated files:

```json
"version-packages": "changeset version && oxlint --fix --quiet && oxfmt --write ."
```

If the current script has additional non-plugin commands, preserve them and remove only the plugin sync command.

- [ ] **Step 5: Run plugin tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/agent-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/core/test/agent-plugins.test.ts README.md docs/assets/caplets-icon.png
git add -u plugins .agents .claude-plugin scripts
git commit -m "refactor(core): remove codex and claude plugins"
```

---

## Task 8: Manual MCP Documentation

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/core/test/agent-plugins.test.ts`

- [ ] **Step 1: Add docs contract assertions**

Extend `packages/core/test/agent-plugins.test.ts`:

```ts
it("documents serve for local MCP and attach for remote MCP", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  expect(readme).toContain("caplets serve");
  expect(readme).toContain("caplets attach");
  expect(readme).toContain("CAPLETS_MODE=cloud");
  expect(readme).toContain("CAPLETS_REMOTE_URL=https://cloud.caplets.dev");
  expect(readme).toContain("CAPLETS_MODE=remote");
});
```

- [ ] **Step 2: Update top-level Core README integration table**

In `README.md`, replace the existing agent integration table rows for Claude and Codex with:

```md
| Codex | Add `caplets serve` or `caplets attach` manually in MCP config | Local or remote/Cloud progressive-disclosure gateway |
| Claude Code | Add `caplets serve` or `caplets attach` manually in MCP config | Local or remote/Cloud progressive-disclosure gateway |
```

Add the manual MCP examples exactly:

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["serve"]
    }
  }
}
```

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["attach"]
    }
  }
}
```

Add Cloud env setup:

```bash
caplets cloud auth login
export CAPLETS_MODE=cloud
export CAPLETS_REMOTE_URL=https://cloud.caplets.dev
```

Add self-hosted env setup:

```bash
export CAPLETS_MODE=remote
export CAPLETS_REMOTE_URL=https://caplets.example.com/caplets
export CAPLETS_REMOTE_TOKEN=...
```

- [ ] **Step 3: Update CLI README**

If `packages/cli/README.md` exists and references plugin installs, replace those paragraphs with the same manual MCP examples from Step 2. If it does not contain plugin guidance, add a short `Manual MCP setup` section with the two JSON examples.

- [ ] **Step 4: Run docs contract tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/agent-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/cli/README.md packages/core/test/agent-plugins.test.ts
git commit -m "docs(core): prefer manual mcp setup"
```

---

## Task 9: CLI Error Handling And Regression Matrix

**Files:**

- Modify: `packages/core/test/attach-cli.test.ts`
- Modify: `packages/core/test/remote-options.test.ts`
- Modify: `packages/core/test/native-options.test.ts`
- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/src/remote/selection.ts`

- [ ] **Step 1: Add explicit error tests**

Add these cases across the listed test files:

```ts
it("prints JSON error for attach --once when cloud auth is missing", async () => {
  const out: string[] = [];
  let exitCode = 0;
  await runCli(["attach", "--once", "--json"], {
    env: {
      CAPLETS_MODE: "cloud",
      CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
    },
    writeOut: (value) => out.push(value),
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(out.join(""))).toMatchObject({
    error: {
      code: "cloud_auth_required",
      recoveryCommand: "caplets cloud auth login",
    },
  });
});

it("references CAPLETS_REMOTE_TOKEN or Basic Auth vars for self-hosted auth failures", async () => {
  await expect(
    resolveCapletsRemote(
      { user: "caplets" },
      { CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets" },
    ),
  ).toThrow(/CAPLETS_REMOTE_PASSWORD/u);
});
```

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-cli.test.ts test/remote-options.test.ts test/native-options.test.ts
```

Expected: FAIL for any missing structured error handling.

- [ ] **Step 3: Normalize errors**

In `packages/core/src/remote/selection.ts`, throw `CapletsError` or `ProjectBindingError` for every user-facing failure:

- local mode for attach: `REQUEST_INVALID`
- missing remote URL for attach: `REQUEST_INVALID`
- missing Cloud Auth: existing `projectBindingError("cloud_auth_required")`
- workspace mismatch: existing `projectBindingError("workspace_switch_required")`
- Cloud URL mismatch: `REQUEST_INVALID`

In `packages/core/src/cli.ts`, ensure the `--once --json` handler serializes these errors consistently with the existing Project Binding JSON branch.

- [ ] **Step 4: Run regression tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/attach-cli.test.ts test/remote-options.test.ts test/native-options.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli.ts packages/core/src/remote/selection.ts packages/core/test/attach-cli.test.ts packages/core/test/remote-options.test.ts packages/core/test/native-options.test.ts
git commit -m "fix(core): clarify attach remote errors"
```

---

## Task 10: Changeset And Full Verification

**Files:**

- Add: `.changeset/<generated-name>.md`
- Modify: any generated schema or docs files changed by package scripts

- [ ] **Step 1: Add Changesets entry**

Create a changeset:

```bash
pnpm changeset
```

Use this content:

```md
---
"@caplets/core": minor
"caplets": minor
"@caplets/opencode": minor
"@caplets/pi": minor
---

Make `caplets attach` the remote-backed MCP server command, add Cloud-aware `CAPLETS_MODE` resolution, keep OpenCode and Pi on the shared resolver, and remove Codex/Claude plugin artifacts in favor of manual MCP configuration.
```

- [ ] **Step 2: Run formatting**

Run:

```bash
pnpm format:check
```

Expected: PASS. If it fails only on changed files, run `pnpm format` and re-run `pnpm format:check`.

- [ ] **Step 3: Run Core focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/remote-options.test.ts test/remote-selection.test.ts test/attach-cli.test.ts test/attach-server.test.ts test/cloud-auth-refresh-attach.test.ts test/native-options.test.ts test/native-remote.test.ts test/agent-plugins.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run integration package tests**

Run:

```bash
pnpm --filter @caplets/opencode test
pnpm --filter @caplets/pi test
```

Expected: PASS.

- [ ] **Step 5: Run Core verification**

Run:

```bash
pnpm core:verify
```

Expected: PASS.

- [ ] **Step 6: Run root coordination verification**

Run:

```bash
pnpm verify
```

Expected: PASS.

- [ ] **Step 7: Manual smoke commands**

Build first:

```bash
pnpm core:build
```

Smoke local serve help:

```bash
node core/packages/cli/dist/index.js serve --help
```

Expected output includes `Serve configured Caplets as an MCP server.` and does not mention Cloud Auth.

Smoke attach help:

```bash
node core/packages/cli/dist/index.js attach --help
```

Expected output includes `Start a remote-backed Caplets MCP server.`, `--transport <transport>`, `--once`, and `--remote-url <url>`.

Smoke local-mode attach rejection:

```bash
CAPLETS_MODE=local node core/packages/cli/dist/index.js attach --transport stdio
```

Expected: exits non-zero with `use caplets serve for local-only MCP`.

- [ ] **Step 8: Final commit**

```bash
git add .
git commit -m "chore(core): verify remote attach integration"
```

If every previous task already committed all files and the working tree is clean, skip the final commit and record the verification commands in the final response.

---

## Self-Review Checklist

- [ ] `caplets serve` remains local-only for stdio and HTTP and does not consult Cloud Auth.
- [ ] `caplets attach` starts an MCP server by default and supports stdio and HTTP transports.
- [ ] `caplets attach --once` remains a finite Project Binding smoke path.
- [ ] `CAPLETS_MODE=local` rejects attach and points users to `caplets serve`.
- [ ] `CAPLETS_MODE=remote` requires `CAPLETS_REMOTE_URL` and uses self-hosted token or Basic Auth.
- [ ] `CAPLETS_MODE=cloud` requires a Cloud URL and saved `caplets cloud auth login` credentials.
- [ ] `CAPLETS_MODE=auto` detects Cloud from `CAPLETS_REMOTE_URL`, detects self-hosted remotes from non-Cloud URLs, and falls back to local only for native integrations with no remote URL.
- [ ] Cloud mode ignores self-hosted `CAPLETS_REMOTE_TOKEN` and uses saved Cloud Auth.
- [ ] Cloud mode refreshes expired saved credentials before attach/native remote use.
- [ ] Cloud mode starts Project Binding automatically and preserves local/project overlay precedence.
- [ ] OpenCode and Pi remain installed native integrations and require no Cloud-specific plugin manifest.
- [ ] Codex and Claude plugin marketplace metadata, bundled MCP config, and shared plugin skill are removed.
- [ ] Codex and Claude docs show manual MCP config for both `serve` and `attach`.
- [ ] Focused tests, package tests, `pnpm core:verify`, and root `pnpm verify` pass.
