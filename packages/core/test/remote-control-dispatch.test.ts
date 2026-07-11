import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockMcpAuth = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth")>()),
  auth: mockMcpAuth,
}));

import { readTokenBundle, writeTokenBundle } from "../src/auth";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
import { dispatchRemoteCliRequest } from "../src/remote-control/dispatch";
import { createCurrentHostOperations } from "../src/current-host/operations";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { FileVaultStore } from "../src/vault";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mockMcpAuth.mockReset();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dispatchRemoteCliRequest", () => {
  it("lists Caplets from the server-side config", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      { command: "list", arguments: { includeDisabled: true } },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toEqual([
      expect.objectContaining({
        server: "server_status",
        backend: "http",
        source: "global-config",
      }),
    ]);
  });

  it("executes inspect through the server engine", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "inspect",
        arguments: { caplet: "server_status", request: { operation: "inspect" } },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toMatchObject({
      structuredContent: {
        result: { id: "server_status", backend: { type: "http" }, name: "Server Status" },
      },
    });
  });

  it("executes nested search_tools requests through the server engine", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "search_tools",
        arguments: {
          caplet: "server_status",
          request: { operation: "search_tools", query: "check", limit: 1 },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.ok && response.result).toMatchObject({
      structuredContent: {
        result: {
          query: "check",
          items: [expect.objectContaining({ name: "check" })],
        },
      },
    });
  });

  it("rejects engine commands with a missing nested operation", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "describe_tool",
        arguments: { caplet: "server_status", request: { name: "check" } },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "request.operation must be a string",
      },
    });
  });

  it("rejects engine commands with mismatched nested operation", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "call_tool",
        arguments: {
          caplet: "server_status",
          request: { operation: "describe_tool", name: "check", arguments: {} },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "request.operation must match remote command call_tool",
      },
    });
  });

  it("redacts secret-bearing control error messages", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "password=hunter2",
        arguments: {
          authorization: "Authorization: Basic abc123",
          clientSecret: "client_secret=secret-value",
          apiKey: "api_key=key-value",
          json: '{"Authorization":"Bearer json-token","password":"json-password"}',
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toMatch(
      /hunter2|abc123|secret-value|key-value|json-token|json-password/u,
    );
    expect(JSON.stringify(response)).toContain("[REDACTED]");
  });

  it("executes Vault operations against server-side state", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");
    writeFileSync(
      context.configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            name: "GitHub",
            description: "GitHub tools.",
            transport: "http",
            url: "https://api.githubcopilot.com/mcp",
            auth: { type: "bearer", token: "$vault:GH_TOKEN" },
          },
        },
      }),
    );

    const set = await dispatchRemoteCliRequest(
      {
        command: "vault_set",
        arguments: {
          name: "GH_TOKEN_REMOTE",
          value: "remote_dispatch_secret",
          grant: "github",
          referenceName: "GH_TOKEN",
          force: false,
        },
      },
      { ...context, authDir },
      currentHostAdministration({ ...context, authDir }),
    );
    const list = await dispatchRemoteCliRequest(
      { command: "vault_access_list", arguments: {} },
      { ...context, authDir },
      currentHostAdministration({ ...context, authDir }),
    );
    const inspect = await dispatchRemoteCliRequest(
      {
        command: "inspect",
        arguments: { caplet: "github", request: { operation: "inspect" } },
      },
      { ...context, authDir },
    );

    const store = new FileVaultStore({ root: join(authDir, "vault") });
    expect(set).toMatchObject({ ok: true, result: { key: "GH_TOKEN_REMOTE", present: true } });
    expect(JSON.stringify(set)).not.toContain("remote_dispatch_secret");
    expect(store.resolveValue("GH_TOKEN_REMOTE")).toBe("remote_dispatch_secret");
    expect(list).toMatchObject({
      ok: true,
      result: [
        expect.objectContaining({
          storedKey: "GH_TOKEN_REMOTE",
          referenceName: "GH_TOKEN",
          capletId: "github",
        }),
      ],
    });
    expect(JSON.stringify(list)).not.toContain("remote_dispatch_secret");
    expect(inspect).toMatchObject({
      ok: true,
      result: {
        structuredContent: {
          result: { id: "github", backend: { type: "mcp" }, name: "GitHub" },
        },
      },
    });
  });

  it("does not retain a remote Vault value when set-and-grant fails", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");

    const response = await dispatchRemoteCliRequest(
      {
        command: "vault_set",
        arguments: {
          name: "GH_TOKEN",
          value: "remote_orphan_secret",
          grant: "missing_caplet",
          force: false,
        },
      },
      { ...context, authDir },
      currentHostAdministration({ ...context, authDir }),
    );

    const store = new FileVaultStore({ root: join(authDir, "vault") });
    expect(response).toMatchObject({ ok: false });
    expect(store.getStatus("GH_TOKEN")).toEqual({ key: "GH_TOKEN", present: false });
    expect(JSON.stringify(response)).not.toContain("remote_orphan_secret");
  });

  it("restores the previous remote Vault value when force set-and-grant fails", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");
    const store = new FileVaultStore({ root: join(authDir, "vault") });
    store.set("GH_TOKEN", "original_secret");

    const response = await dispatchRemoteCliRequest(
      {
        command: "vault_set",
        arguments: {
          name: "GH_TOKEN",
          value: "replacement_secret",
          grant: "missing_caplet",
          force: true,
        },
      },
      { ...context, authDir },
      currentHostAdministration({ ...context, authDir }),
    );

    expect(response).toMatchObject({ ok: false });
    expect(store.resolveValue("GH_TOKEN")).toBe("original_secret");
    expect(JSON.stringify(response)).not.toContain("replacement_secret");
  });

  it("rejects forged remote Vault raw reveal requests", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");
    new FileVaultStore({ root: join(authDir, "vault") }).set("GH_TOKEN", "remote_secret");

    const response = await dispatchRemoteCliRequest(
      {
        command: "vault_get",
        arguments: { name: "GH_TOKEN", reveal: true, revealContext: "human-cli" },
      },
      { ...context, authDir },
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Self-hosted remote Vault reveal is not supported through remote control.",
      },
    });
    expect(JSON.stringify(response)).not.toContain("remote_secret");
  });

  it("adds MCP Caplets to the server-side project Caplets root", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_fixture",
          options: { command: "node", arg: ["server.js"] },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true, result: { remote: true, label: "MCP" } });
    const capletPath = join(context.projectCapletsRoot, "remote_fixture.md");
    expect(existsSync(capletPath)).toBe(true);
    expect(readFileSync(capletPath, "utf8")).toContain("mcpServer:");
  });

  it("rejects remote add output because the server owns the destination", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_escape",
          options: { command: "node", output: join(context.tempRoot, "outside.md") },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("output is not supported remotely"),
      },
    });
  });

  it("rejects remote add destinationRoot because the server owns the destination", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_destination_root",
          options: { command: "node", destinationRoot: context.tempRoot },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("destinationRoot is not supported remotely"),
      },
    });
  });

  it("rejects remote add print because the server owns write behavior", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_print",
          options: { command: "node", print: true },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: expect.stringContaining("print is not supported remotely"),
      },
    });
  });

  it("rejects invalid remote add option types before calling helpers", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_bad_force",
          options: { command: "node", force: "yes" },
        },
      },
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID", message: expect.stringContaining("force") },
    });
  });

  it("accepts valid remote add nested options", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "add",
        arguments: {
          kind: "mcp",
          id: "remote_valid",
          options: { command: "node", arg: ["server.js"], env: ["A=B"], force: true },
        },
      },
      context,
    );

    expect(response).toMatchObject({ ok: true, result: { remote: true, label: "MCP" } });
    expect(existsSync(join(context.projectCapletsRoot, "remote_valid.md"))).toBe(true);
  });

  it("marks init and install mutation responses as remote", async () => {
    const initContext = testContext({ writeConfig: false });

    await expect(
      dispatchRemoteCliRequest({ command: "init", arguments: {} }, initContext),
    ).resolves.toMatchObject({ ok: true, result: { remote: true, path: initContext.configPath } });

    const installContext = testContext();
    const sourceRepo = join(installContext.tempRoot, "source");
    const sourceCaplets = join(sourceRepo, "caplets");
    mkdirSync(sourceCaplets, { recursive: true });
    writeFileSync(
      join(sourceCaplets, "sample.md"),
      [
        "---",
        "name: Sample",
        "description: Sample Caplet.",
        "httpApi:",
        "  baseUrl: http://127.0.0.1:1",
        "  auth:",
        "    type: none",
        "  actions:",
        "    check:",
        "      method: GET",
        "      path: /check",
        "---",
        "",
        "# Sample",
        "",
      ].join("\n"),
    );

    await expect(
      dispatchRemoteCliRequest(
        { command: "install", arguments: { repo: sourceRepo } },
        installContext,
        currentHostAdministration(installContext),
      ),
    ).resolves.toMatchObject({ ok: true, result: { remote: true } });
  });

  it("installs catalog Caplets into remote global state", async () => {
    const context = testContext();
    const sourceRepo = join(context.tempRoot, "source-global");
    const sourceCaplets = join(sourceRepo, "caplets");
    const globalRoot = join(context.tempRoot, "remote-global");
    const globalLockfilePath = join(context.tempRoot, "remote-state", "caplets.lock.json");
    mkdirSync(sourceCaplets, { recursive: true });
    writeFileSync(
      join(sourceCaplets, "sample.md"),
      [
        "---",
        "name: Sample",
        "description: Sample Caplet.",
        "httpApi:",
        "  baseUrl: http://127.0.0.1:1",
        "  auth:",
        "    type: none",
        "  actions:",
        "    check:",
        "      method: GET",
        "      path: /check",
        "---",
        "",
        "# Sample",
        "",
      ].join("\n"),
    );

    await expect(
      dispatchRemoteCliRequest(
        { command: "install", arguments: { repo: sourceRepo, capletIds: ["sample"] } },
        { ...context, globalCapletsRoot: globalRoot, globalLockfilePath },
        currentHostAdministration({
          ...context,
          globalCapletsRoot: globalRoot,
          globalLockfilePath,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, result: { remote: true } });

    expect(existsSync(join(globalRoot, "sample.md"))).toBe(true);
    expect(existsSync(join(context.projectCapletsRoot, "sample.md"))).toBe(false);
    expect(JSON.parse(readFileSync(globalLockfilePath, "utf8"))).toMatchObject({
      entries: [expect.objectContaining({ id: "sample" })],
    });
  });

  it("honors remote catalog indexing opt-out from the client request", async () => {
    const context = testContext();
    const sourceRepo = join(context.tempRoot, "source-disabled-indexing");
    const sourceCaplets = join(sourceRepo, "caplets");
    mkdirSync(sourceCaplets, { recursive: true });
    writeFileSync(
      join(sourceCaplets, "sample.md"),
      [
        "---",
        "name: Sample",
        "description: Sample Caplet.",
        "httpApi:",
        "  baseUrl: http://127.0.0.1:1",
        "  auth:",
        "    type: none",
        "  actions:",
        "    check:",
        "      method: GET",
        "      path: /check",
        "---",
        "",
        "# Sample",
        "",
      ].join("\n"),
    );

    const response = await dispatchRemoteCliRequest(
      {
        command: "install",
        arguments: {
          repo: sourceRepo,
          capletIds: ["sample"],
          disableCatalogIndexing: true,
        },
      },
      context,
      currentHostAdministration(context),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        installed: [
          expect.objectContaining({
            id: "sample",
            catalogIndexing: {
              status: "ineligible",
              reason: "catalog_indexing_disabled",
            },
          }),
        ],
      },
    });
  });

  it("dispatches complete_cli using server-owned config", async () => {
    const context = testContext();
    writeFileSync(
      context.configPath,
      JSON.stringify({
        mcpServers: {
          github: { name: "GitHub", description: "GitHub project automation.", command: "node" },
        },
        httpApis: {
          users: {
            name: "Users",
            description: "Manage users through the API.",
            baseUrl: "https://api.example.com",
            auth: { type: "none" },
            actions: { list: { method: "GET", path: "/users" } },
          },
        },
      }),
    );

    const response = await dispatchRemoteCliRequest(
      { command: "complete_cli", arguments: { shell: "bash", words: ["inspect", ""] } },
      context,
    );

    expect(response).toEqual({ ok: true, result: ["github", "users"] });
  });

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

  it("lists, refreshes, and logs out server-side auth credentials", async () => {
    const fixture = remoteFixtureWithOAuth();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    writeTokenBundle(
      {
        server: "remote",
        accessToken: "secret-access-token",
        refreshToken: "old-refresh-token",
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

    const refreshed = await dispatchRemoteCliRequest(
      { command: "auth_refresh", arguments: { server: "remote" } },
      fixture.context,
    );
    expect(refreshed).toEqual({
      ok: true,
      result: { server: "remote" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.example.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("refresh_token=old-refresh-token"),
      }),
    );
    expect(readTokenBundle("remote", fixture.context.authDir)).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
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

  it("resolves Google Discovery scopes before starting remote OAuth login", async () => {
    const context = testContext();
    const authFlowStore = new RemoteAuthFlowStore();
    const authDir = join(context.tempRoot, "auth");
    mkdirSync(authDir, { recursive: true });
    const discoveryPath = join(context.tempRoot, "drive.discovery.json");
    writeFileSync(
      discoveryPath,
      JSON.stringify({
        kind: "discovery#restDescription",
        name: "drive",
        version: "v3",
        title: "Drive API",
        rootUrl: "https://www.googleapis.com/",
        servicePath: "drive/v3/",
        baseUrl: "https://www.googleapis.com/drive/v3/",
        resources: {
          files: {
            methods: {
              list: {
                id: "drive.files.list",
                path: "files",
                httpMethod: "GET",
                scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      context.configPath,
      JSON.stringify({
        googleDiscoveryApis: {
          drive: {
            name: "Drive",
            description: "Drive API.",
            discoveryPath,
            auth: {
              type: "oauth2",
              clientId: "client",
              tokenUrl: "https://oauth2.googleapis.com/token",
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            },
          },
        },
      }),
    );

    const response = await dispatchRemoteCliRequest(
      { command: "auth_login_start", arguments: { server: "drive" } },
      {
        ...context,
        authDir,
        controlCallbackBaseUrl: "http://127.0.0.1:5387/control",
        authFlowStore,
      },
    );

    expect(response).toMatchObject({ ok: true });
    const result = response.ok
      ? (response.result as { authorizationUrl: string; flowId: string })
      : undefined;
    expect(result?.flowId).toBeTruthy();
    const authorizationUrl = new URL(result?.authorizationUrl ?? "");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "drive-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: result?.flowId,
          callbackUrl: `http://127.0.0.1/callback?code=code&state=${authorizationUrl.searchParams.get("state")}`,
        },
      },
      {
        ...context,
        authDir,
        authFlowStore,
        controlCallbackBaseUrl: "http://127.0.0.1:5387/control",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("code=code"),
      }),
    );
    expect(readTokenBundle("drive", authDir)).toMatchObject({
      protectedResourceOrigin: "https://www.googleapis.com",
      metadata: {
        protectedResource: "https://www.googleapis.com/drive/v3/",
        requestedScopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
      },
    });
  });

  it("does not create a pending auth flow when MCP auth is already authorized", async () => {
    const fixture = remoteFixtureWithOAuth();
    const authFlowStore = new RemoteAuthFlowStore();
    const create = vi.spyOn(authFlowStore, "create");
    mockMcpAuth.mockResolvedValueOnce("AUTHORIZED");

    const response = await dispatchRemoteCliRequest(
      { command: "auth_login_start", arguments: { server: "remote" } },
      {
        ...fixture.context,
        controlCallbackBaseUrl: "http://127.0.0.1:5387/control",
        authFlowStore,
      },
    );

    expect(response).toEqual({ ok: true, result: { server: "remote", authenticated: true } });
    expect(create).not.toHaveBeenCalled();
  });

  it("expires stale remote auth flows", () => {
    let now = 1_000;
    const authFlowStore = new RemoteAuthFlowStore({ ttlMs: 100, now: () => now });
    const flow = authFlowStore.create({
      server: "remote",
      authorizationUrl: "https://auth.example/authorize",
      complete: async () => {},
    });

    expect(authFlowStore.get(flow.id)).toEqual(flow);
    expect(authFlowStore.get(flow.id)).not.toBe(flow);

    now = 1_101;
    expect(authFlowStore.get(flow.id)).toBeUndefined();
  });

  it("removes remote auth flows before completion to prevent concurrent replay", async () => {
    const authFlowStore = new RemoteAuthFlowStore();
    const flow = authFlowStore.create({
      server: "remote",
      authorizationUrl: "https://auth.example/authorize",
      complete: async () => {
        expect(authFlowStore.get(flow.id)).toBeUndefined();
        throw new Error("callback failed");
      },
    });

    const response = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: flow.id, callbackUrl: "http://127.0.0.1/callback?code=bad" },
      },
      {
        ...testContext(),
        authFlowStore,
        controlCallbackBaseUrl: "http://127.0.0.1:5387/control",
      },
    );

    expect(response).toMatchObject({ ok: false });
    expect(authFlowStore.get(flow.id)).toBeUndefined();
  });
});

function testContext(options: { writeConfig?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-dispatch-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  if (options.writeConfig !== false) {
    writeFileSync(
      configPath,
      JSON.stringify({
        httpApis: {
          server_status: {
            name: "Server Status",
            description: "Server-side status API.",
            baseUrl: "http://127.0.0.1:1",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/check" } },
          },
        },
      }),
    );
  }
  return {
    tempRoot: dir,
    configPath,
    projectConfigPath,
    projectCapletsRoot: projectRoot,
    watch: false,
  };
}

type DispatchAdministrationContext = {
  tempRoot: string;
  configPath: string;
  projectConfigPath: string;
  authDir?: string | undefined;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
};

function currentHostAdministration(context: DispatchAdministrationContext) {
  return {
    operations: createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      control: {
        configPath: context.configPath,
        projectConfigPath: context.projectConfigPath,
        authDir: context.authDir,
        globalCapletsRoot: context.globalCapletsRoot,
        globalLockfilePath: context.globalLockfilePath,
      },
      activityLog: new DashboardActivityLog({ dir: join(context.tempRoot, "activity") }),
      version: "test-version",
    }),
    principal: {
      clientId: "rcli_abcdefghijklmnop",
      hostUrl: "http://127.0.0.1:5387/",
      role: "operator" as const,
    },
  };
}

function remoteFixtureWithOAuth() {
  const dir = mkdtempSync(join(tmpdir(), "caplets-dispatch-auth-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  const authDir = join(dir, "auth");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "Remote OAuth server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: {
            type: "oauth2",
            clientId: "client",
            tokenUrl: "https://auth.example.com/token",
          },
        },
      },
    }),
  );
  return {
    context: {
      tempRoot: dir,
      configPath,
      projectConfigPath,
      projectCapletsRoot: projectRoot,
      authDir,
      watch: false,
    },
  };
}
