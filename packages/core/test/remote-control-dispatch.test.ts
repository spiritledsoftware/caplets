import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockMcpAuth = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth.js")>()),
  auth: mockMcpAuth,
}));

import { writeTokenBundle } from "../src/auth";
import { RemoteAuthFlowStore } from "../src/remote-control/auth-flow";
import { dispatchRemoteCliRequest } from "../src/remote-control/dispatch";

const dirs: string[] = [];

afterEach(() => {
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

  it("executes get_caplet through the server engine", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      {
        command: "get_caplet",
        arguments: { caplet: "server_status", request: { operation: "get_caplet" } },
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
          tools: [expect.objectContaining({ tool: "check" })],
        },
      },
    });
  });

  it("rejects engine commands with a missing nested operation", async () => {
    const context = testContext();

    const response = await dispatchRemoteCliRequest(
      { command: "get_tool", arguments: { caplet: "server_status", request: { tool: "check" } } },
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
          request: { operation: "get_tool", tool: "check", arguments: {} },
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
        command: "password=hunter2" as never,
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
      ),
    ).resolves.toMatchObject({ ok: true, result: { remote: true } });
  });

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

    expect(authFlowStore.get(flow.id)).toBe(flow);

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
          auth: { type: "oauth2", clientId: "client" },
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
