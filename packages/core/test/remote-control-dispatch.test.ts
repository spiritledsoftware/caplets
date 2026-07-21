import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidRequestError,
  TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors";

const mockMcpAuth = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth")>()),
  auth: mockMcpAuth,
}));

import { FileOAuthProvider } from "../src/auth";
import { CapletsEngine } from "../src/engine";

import {
  dispatchRemoteCliRequest as dispatchRemoteCliRequestImplementation,
  LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES,
  maximumBase64EncodedBytes,
  remoteBundleSerializedMetadataBytes,
} from "../src/remote-control/dispatch";
import { DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS } from "../src/remote-control/auth-flow";
import { REMOTE_CLI_COMMANDS, REMOTE_CLI_COMMAND_DESTINATIONS } from "../src/remote-control/types";
import { REMOTE_CLI_COMMAND_DESTINATION_FIXTURE } from "./fixtures/remote-cli-command-destinations";
import {
  createCurrentHostOperations,
  type CurrentHostOperations,
  type CurrentHostOperationsDependencies,
} from "../src/current-host/operations";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { createHostStorage, type HostStorage } from "../src/storage";
import { MAX_BUNDLE_FILES, MAX_BUNDLE_TOTAL_BYTES } from "../src/storage/caplet-records";

const dirs: string[] = [];
const storages: HostStorage[] = [];
const currentHostAdministrationByContext = new WeakMap<
  object,
  NonNullable<Parameters<typeof dispatchRemoteCliRequestImplementation>[2]>
>();

async function dispatchRemoteCliRequest(
  ...args: Parameters<typeof dispatchRemoteCliRequestImplementation>
) {
  const [request, context, administration] = args;
  return await dispatchRemoteCliRequestImplementation(
    request,
    context,
    administration ?? currentHostAdministrationByContext.get(context),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  mockMcpAuth.mockReset();
  await Promise.allSettled(storages.splice(0).map(async (storage) => await storage.close()));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dispatchRemoteCliRequest", () => {
  it("classifies every frozen command into exactly one migration destination", () => {
    const classified = Object.entries(REMOTE_CLI_COMMAND_DESTINATION_FIXTURE).flatMap(
      ([destination, commands]) => commands.map((command) => [command, destination] as const),
    );

    expect(classified.map(([command]) => command)).toHaveLength(
      new Set(classified.map(([command]) => command)).size,
    );
    expect(new Set(classified.map(([command]) => command))).toEqual(new Set(REMOTE_CLI_COMMANDS));
    expect(
      Object.fromEntries(classified.map(([command, destination]) => [command, destination])),
    ).toEqual(REMOTE_CLI_COMMAND_DESTINATIONS);
    expect(REMOTE_CLI_COMMAND_DESTINATIONS.call_tool).toBe("attach");
    expect(REMOTE_CLI_COMMAND_DESTINATIONS.auth_login_complete).toBe("public_auth_self_service");
  });

  it("derives padded payload and escaped metadata sizes without materializing a maximum bundle", () => {
    expect(maximumBase64EncodedBytes(4, 4)).toBe(16);
    expect(maximumBase64EncodedBytes(4, 1)).toBe(8);
    expect(maximumBase64EncodedBytes(MAX_BUNDLE_TOTAL_BYTES, MAX_BUNDLE_FILES + 1)).toBeGreaterThan(
      Math.ceil(MAX_BUNDLE_TOTAL_BYTES / 3) * 4,
    );
    const args = { id: "padding", files: [] };
    const plain = [{ path: "x", executable: false }];
    const escaped = [{ path: '"', executable: false }];
    expect(remoteBundleSerializedMetadataBytes("storage_records_import", args, escaped)).toBe(
      remoteBundleSerializedMetadataBytes("storage_records_import", args, plain) + 1,
    );
  });

  it("accepts the serialized bundle metadata boundary and rejects one excess byte", async () => {
    const context = testContext();
    const execute = vi.fn(async () => ({
      kind: "stored_caplet_bundle_import" as const,
      record: { id: "metadata-boundary" },
    }));
    const administration = {
      ...currentHostAdministration(context),
      operations: { execute } as unknown as CurrentHostOperations,
    };
    const command = "storage_records_import";
    const id = "metadata-boundary";
    const fixedFiles = [
      { path: "CAPLET.md", contentBase64: "", executable: false },
      { path: "x", contentBase64: "", executable: false },
    ];
    const fixedArguments = { id, files: fixedFiles };
    const fixedBytes = remoteBundleSerializedMetadataBytes(command, fixedArguments, fixedFiles);
    const boundaryPath = "x".repeat(LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES - fixedBytes + 1);
    const boundaryFiles = [
      fixedFiles[0]!,
      { path: boundaryPath, contentBase64: "", executable: false },
    ];
    const boundaryArguments = { id, files: boundaryFiles };
    expect(remoteBundleSerializedMetadataBytes(command, boundaryArguments, boundaryFiles)).toBe(
      LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES,
    );

    await expect(
      dispatchRemoteCliRequest(
        {
          command,
          arguments: boundaryArguments,
        },
        context,
        administration,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      dispatchRemoteCliRequest(
        {
          command,
          arguments: {
            id,
            files: [
              fixedFiles[0]!,
              { path: `${boundaryPath}x`, contentBase64: "", executable: false },
            ],
          },
        },
        context,
        administration,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Remote Caplet bundle metadata exceeds the byte limit.",
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("accepts the frozen bundle file-count boundary and rejects one excess entry", async () => {
    const context = testContext();
    const execute = vi.fn(async () => ({
      kind: "stored_caplet_bundle_import" as const,
      record: { id: "file-count-boundary" },
    }));
    const administration = {
      ...currentHostAdministration(context),
      operations: { execute } as unknown as CurrentHostOperations,
    };
    const file = { path: "CAPLET.md", contentBase64: "", executable: false };

    for (const count of [502, MAX_BUNDLE_FILES + 1]) {
      execute.mockClear();
      await expect(
        dispatchRemoteCliRequest(
          {
            command: "storage_records_import",
            arguments: {
              id: "file-count-boundary",
              files: Array.from({ length: count }, () => file),
            },
          },
          context,
          administration,
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    }

    execute.mockClear();
    await expect(
      dispatchRemoteCliRequest(
        {
          command: "storage_records_import",
          arguments: {
            id: "file-count-excess",
            files: Array.from({ length: MAX_BUNDLE_FILES + 2 }, () => file),
          },
        },
        context,
        administration,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

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
        backend: "attach",
        source: "remote-attach",
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

  it("rejects runtime access to a Caplet hidden from Attach", async () => {
    const context = testContext();
    const config = JSON.parse(readFileSync(context.configPath, "utf8")) as {
      httpApis: Record<string, Record<string, unknown>>;
    };
    config.httpApis.server_status!.disabled = true;
    writeFileSync(context.configPath, JSON.stringify(config));

    await expect(
      dispatchRemoteCliRequest(
        {
          command: "inspect",
          arguments: { caplet: "server_status", request: { operation: "inspect" } },
        },
        context,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "ATTACH_EXPORT_NOT_FOUND",
        message: "The requested Attach Caplet is not exported.",
      },
    });
    await expect(
      dispatchRemoteCliRequest({ command: "list", arguments: { includeDisabled: true } }, context),
    ).resolves.toEqual({ ok: true, result: [] });
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
        options: { exposure: "progressive" },
        httpApis: {
          github: {
            name: "GitHub",
            description: "GitHub tools.",
            baseUrl: "https://api.github.test",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/check" } },
          },
        },
      }),
    );
    const storage = await configuredTestStorage({ ...context, authDir });
    const dispatchContext = { ...context, authDir, hostStorage: storage };
    const currentHostEngine = await CapletsEngine.create(dispatchContext);
    const administration = currentHostAdministration({
      ...context,
      authDir,
      storage,
      engine: currentHostEngine,
    });

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
      dispatchContext,
      administration,
    );
    const list = await dispatchRemoteCliRequest(
      { command: "vault_access_list", arguments: {} },
      dispatchContext,
      administration,
    );
    const inspect = await dispatchRemoteCliRequest(
      {
        command: "inspect",
        arguments: { caplet: "github", request: { operation: "inspect" } },
      },
      dispatchContext,
    );

    expect(set).toMatchObject({ ok: true, result: { key: "GH_TOKEN_REMOTE", present: true } });
    expect(JSON.stringify(set)).not.toContain("remote_dispatch_secret");
    await expect(storage.vaultValues.resolveValue("GH_TOKEN_REMOTE")).resolves.toBe(
      "remote_dispatch_secret",
    );
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
          result: { id: "github", backend: { type: "http" }, name: "GitHub" },
        },
      },
    });
    await currentHostEngine.close();
  });

  it("does not retain a remote Vault value when set-and-grant fails", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");
    const storage = await configuredTestStorage({ ...context, authDir });
    const dispatchContext = { ...context, authDir, hostStorage: storage };
    const administration = currentHostAdministration({ ...context, authDir, storage });

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
      dispatchContext,
      administration,
    );

    expect(response).toMatchObject({ ok: false });
    await expect(storage.vaultValues.getStatus("GH_TOKEN")).resolves.toEqual({
      key: "GH_TOKEN",
      present: false,
    });
    expect(JSON.stringify(response)).not.toContain("remote_orphan_secret");
  });

  it("restores the previous remote Vault value when force set-and-grant fails", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");
    const storage = await configuredTestStorage({ ...context, authDir });
    await storage.vaultValues.set("GH_TOKEN", "original_secret");
    const dispatchContext = { ...context, authDir, hostStorage: storage };
    const administration = currentHostAdministration({ ...context, authDir, storage });

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
      dispatchContext,
      administration,
    );

    expect(response).toMatchObject({ ok: false });
    await expect(storage.vaultValues.resolveValue("GH_TOKEN")).resolves.toBe("original_secret");
    expect(JSON.stringify(response)).not.toContain("replacement_secret");
  });

  it("rejects forged remote Vault raw reveal requests", async () => {
    const context = testContext();
    const authDir = join(context.tempRoot, "auth");

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

  it("rejects init and every add variant without changing local files", async () => {
    const context = testContext({ writeConfig: false });
    const requests = [
      { command: "init", arguments: {} },
      ...["cli", "mcp", "openapi", "google-discovery", "googleDiscovery", "graphql", "http"].map(
        (kind) => ({
          command: "add",
          arguments: { kind, id: `remote-${kind}` },
        }),
      ),
    ];

    for (const request of requests) {
      await expect(dispatchRemoteCliRequest(request, context)).resolves.toEqual({
        ok: false,
        error: {
          code: "REQUEST_INVALID",
          message: `Remote ${request.command} is local-only. Run caplets ${request.command} on the machine whose files should change.`,
        },
      });
    }

    expect(existsSync(context.configPath)).toBe(false);
    expect(readdirSync(context.projectCapletsRoot)).toEqual([]);
  });

  it("keeps retained install response parity", async () => {
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
    expect(
      JSON.parse(readFileSync(join(context.tempRoot, "remote-state", "caplets.lock.json"), "utf8")),
    ).toMatchObject({
      entries: [expect.objectContaining({ id: "sample" })],
    });
  });

  it("dispatches complete_cli using server-owned config", async () => {
    const context = testContext();
    writeFileSync(
      context.configPath,
      JSON.stringify({
        options: { exposure: "progressive" },
        storage: { type: "sqlite", path: join(context.tempRoot, "host-state.sqlite3") },
        httpApis: {
          github: {
            name: "GitHub",
            description: "GitHub project automation.",
            baseUrl: "https://api.github.test",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/check" } },
          },
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
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = fixture.context;
    const administration = currentHostAdministration({ ...fixture.context, storage });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    await storage.backendAuth.writeTokenBundle({
      server: "remote",
      accessToken: "secret-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const listed = await dispatchRemoteCliRequest(
      { command: "auth_list", arguments: {} },
      dispatchContext,
      administration,
    );
    expect(listed).toEqual({
      ok: true,
      result: [expect.objectContaining({ server: "remote", status: "authenticated" })],
    });

    const refreshed = await dispatchRemoteCliRequest(
      { command: "auth_refresh", arguments: { server: "remote" } },
      dispatchContext,
      administration,
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
    await expect(storage.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
      bundle: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      },
    });

    const loggedOut = await dispatchRemoteCliRequest(
      { command: "auth_logout", arguments: { server: "remote" } },
      dispatchContext,
      administration,
    );
    expect(loggedOut).toEqual({
      ok: true,
      result: { server: "remote", deleted: true },
    });
    await expect(storage.backendAuth.readTokenBundle("remote")).resolves.toBeUndefined();
  });

  it("persists generic OAuth state before returning the authorization URL", async () => {
    const context = testContext();
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
    const storage = await configuredTestStorage({ ...context, authDir });
    const dispatchContext = remoteOAuthDispatchContext({ ...context, authDir }, storage);

    const response = await dispatchRemoteCliRequest(
      { command: "auth_login_start", arguments: { server: "drive" } },
      dispatchContext,
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
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:5387/control/auth/callback/${result?.flowId}`,
    );
    await expect(storage.backendAuthFlows.get(result?.flowId ?? "")).resolves.toMatchObject({
      server: "drive",
      status: "pending",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "drive-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    const completed = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: result?.flowId,
          callbackUrl: oauthCallbackUrl(authorizationUrl),
        },
      },
      dispatchContext,
    );

    expect(completed).toEqual({
      ok: true,
      result: { server: "drive", authenticated: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("code=code"),
      }),
    );
    await expect(storage.backendAuthFlows.get(result?.flowId ?? "")).resolves.toMatchObject({
      status: "completed",
    });
    await expect(storage.backendAuth.readTokenBundle("drive")).resolves.toMatchObject({
      bundle: {
        protectedResourceOrigin: "https://www.googleapis.com",
        metadata: {
          protectedResource: "https://www.googleapis.com/drive/v3/",
          requestedScopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
        },
      },
    });
  });

  it("does not persist a pending auth flow when MCP auth is already authorized", async () => {
    const fixture = remoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const create = vi.spyOn(storage.backendAuthFlows, "create");
    mockMcpAuth.mockResolvedValueOnce("AUTHORIZED");

    const response = await dispatchRemoteCliRequest(
      { command: "auth_login_start", arguments: { server: "remote" } },
      dispatchContext,
    );

    expect(response).toEqual({ ok: true, result: { server: "remote", authenticated: true } });
    expect(create).not.toHaveBeenCalled();
  });

  it("completes once across nodes sharing Host Storage and rejects replay", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const firstStorage = await configuredTestStorage(fixture.context);
    const secondStorage = await configuredTestStorage(fixture.context);
    const startContext = remoteOAuthDispatchContext(fixture.context, firstStorage);
    const callbackContext = remoteOAuthDispatchContext(fixture.context, secondStorage);
    const started = await startRemoteOAuth(startContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(oauthTokenResponse());

    const completed = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      callbackContext,
    );

    expect(completed).toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(firstStorage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(secondStorage.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
      bundle: { accessToken: "remote-access-token" },
    });

    const replay = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      startContext,
    );
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("already been completed") },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows only one flow started against empty credentials to complete", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const firstStorage = await configuredTestStorage(fixture.context);
    const secondStorage = await configuredTestStorage(fixture.context);
    const firstContext = remoteOAuthDispatchContext(fixture.context, firstStorage);
    const secondContext = remoteOAuthDispatchContext(fixture.context, secondStorage);
    const first = await startRemoteOAuth(firstContext);
    const second = await startRemoteOAuth(secondContext);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => oauthTokenResponse());

    const completions = await Promise.all([
      dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: {
            flowId: first.flowId,
            callbackUrl: oauthCallbackUrl(new URL(first.authorizationUrl)),
          },
        },
        firstContext,
      ),
      dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: {
            flowId: second.flowId,
            callbackUrl: oauthCallbackUrl(new URL(second.authorizationUrl)),
          },
        },
        secondContext,
      ),
    ]);

    expect(completions.filter((result) => result.ok)).toHaveLength(1);
    expect(completions.filter((result) => !result.ok)).toHaveLength(1);
    await expect(firstStorage.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
      generation: 1,
    });
    const flows = await Promise.all([
      firstStorage.backendAuthFlows.get(first.flowId),
      secondStorage.backendAuthFlows.get(second.flowId),
    ]);
    expect(flows.filter((flow) => flow?.status === "completed")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a concurrent callback as in progress without exchanging twice", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    let finishExchange!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishExchange = resolve;
      }),
    );
    const first = dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      dispatchContext,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const concurrent = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      dispatchContext,
    );
    expect(concurrent).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("already being completed") },
    });

    finishExchange(oauthTokenResponse());
    await expect(first).resolves.toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes durable OAuth heartbeats and settles them before completion", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const baseTime = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      let finishExchange!: (response: Response) => void;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishExchange = resolve;
        }),
      );
      const heartbeatAttempts: Array<{
        resolve(value: boolean): void;
        reject(error: Error): void;
      }> = [];
      const heartbeat = vi.spyOn(storage.backendAuthFlows, "heartbeat").mockImplementation(
        async () =>
          await new Promise<boolean>((resolve, reject) => {
            heartbeatAttempts.push({ resolve, reject });
          }),
      );
      const completeClaim = vi.spyOn(storage.backendAuthFlows, "completeClaim");
      const completion = dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: {
            flowId: started.flowId,
            callbackUrl: oauthCallbackUrl(authorizationUrl),
          },
        },
        dispatchContext,
      );
      let completionSettled = false;
      void completion.finally(() => {
        completionSettled = true;
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS * 3);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      heartbeatAttempts.shift()?.reject(new Error("transient heartbeat failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      const firstHeartbeatAt = heartbeat.mock.calls[0]?.[0].now;
      const secondHeartbeatAt = heartbeat.mock.calls[1]?.[0].now;
      if (!firstHeartbeatAt || !secondHeartbeatAt) {
        throw new Error("Expected timestamped heartbeat attempts.");
      }
      expect(secondHeartbeatAt.getTime() - firstHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
        DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS * 3,
      );
      expect(secondHeartbeatAt).toEqual(new Date());

      finishExchange(oauthTokenResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(completionSettled).toBe(false);
      expect(completeClaim).not.toHaveBeenCalled();

      heartbeatAttempts.shift()?.resolve(true);
      await expect(completion).resolves.toEqual({
        ok: true,
        result: { server: "remote", authenticated: true },
      });
      expect(completeClaim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS * 2);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an active heartbeat before releasing a retryable OAuth claim", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    vi.useFakeTimers();
    try {
      let finishExchange!: (response: Response) => void;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finishExchange = resolve;
        }),
      );
      let finishHeartbeat!: (value: boolean) => void;
      const heartbeat = vi.spyOn(storage.backendAuthFlows, "heartbeat").mockImplementationOnce(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishHeartbeat = resolve;
          }),
      );
      const release = vi.spyOn(storage.backendAuthFlows, "release");
      const completion = dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: {
            flowId: started.flowId,
            callbackUrl: oauthCallbackUrl(authorizationUrl),
          },
        },
        dispatchContext,
      );
      let completionSettled = false;
      void completion.finally(() => {
        completionSettled = true;
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      finishExchange(Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(completionSettled).toBe(false);
      expect(release).not.toHaveBeenCalled();

      finishHeartbeat(true);
      await expect(completion).resolves.toMatchObject({
        ok: false,
        error: { code: "AUTH_FAILED" },
      });
      expect(release).toHaveBeenCalledTimes(1);
      await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
        status: "pending",
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS * 2);
      expect(heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a matching claim after an explicitly retryable pre-commit failure", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: "temporarily_unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(oauthTokenResponse());

    const transientFailure = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      dispatchContext,
    );
    expect(transientFailure).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "pending",
    });

    await expect(
      dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
        },
        dispatchContext,
      ),
    ).resolves.toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["temporarily_unavailable", "server_error"])(
    "releases a generic OAuth claim after HTTP 400 %s",
    async (errorCode) => {
      const fixture = genericRemoteFixtureWithOAuth();
      const storage = await configuredTestStorage(fixture.context);
      const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
      const started = await startRemoteOAuth(dispatchContext);
      const authorizationUrl = new URL(started.authorizationUrl);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json(
            {
              error: errorCode,
              error_description: "provider echoed access_token=secret-access-token",
              refresh_token: "secret-refresh-token",
            },
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(oauthTokenResponse());
      const completionRequest = {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      } as const;

      const transientFailure = await dispatchRemoteCliRequest(completionRequest, dispatchContext);

      expect(transientFailure).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
      expect(JSON.stringify(transientFailure)).not.toMatch(
        /secret-access-token|secret-refresh-token/u,
      );
      await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
        status: "pending",
      });
      await expect(dispatchRemoteCliRequest(completionRequest, dispatchContext)).resolves.toEqual({
        ok: true,
        result: { server: "remote", authenticated: true },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("terminalizes a generic OAuth claim after HTTP 400 invalid_grant", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "provider echoed access_token=secret-access-token",
        },
        { status: 400 },
      ),
    );
    const completionRequest = {
      command: "auth_login_complete",
      arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
    } as const;

    const terminalFailure = await dispatchRemoteCliRequest(completionRequest, dispatchContext);

    expect(terminalFailure).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
    expect(JSON.stringify(terminalFailure)).not.toContain("secret-access-token");
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      dispatchRemoteCliRequest(completionRequest, dispatchContext),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("cannot be retried") },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])(
    "releases an MCP claim after a %i token response even when the OAuth error is terminal",
    async (status) => {
      const fixture = remoteFixtureWithOAuth();
      const storage = await configuredTestStorage(fixture.context);
      const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
      mockMcpAuth
        .mockImplementationOnce(async (provider: FileOAuthProvider) => {
          provider.saveCodeVerifier("persisted-pkce-verifier");
          provider.saveDiscoveryState({
            authorizationServerUrl: "https://auth.example.com",
            authorizationServerMetadata: {
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
            },
          });
          provider.redirectToAuthorization(
            new URL(`https://auth.example.com/authorize?state=${provider.state()}`),
          );
          return "REDIRECT";
        })
        .mockImplementationOnce(async (_provider, options) => {
          const response = await options.fetchFn("https://auth.example.com/token", {
            method: "POST",
          });
          expect(response.status).toBe(status);
          throw new InvalidRequestError("provider echoed access_token=secret-token");
        })
        .mockImplementationOnce(async (provider: FileOAuthProvider) => {
          await provider.saveTokens({
            access_token: "completed-access-token",
            token_type: "Bearer",
          });
          return "AUTHORIZED";
        });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          Response.json({ error: "invalid_request", access_token: "secret-token" }, { status }),
        );
      const started = await startRemoteOAuth(dispatchContext);
      const authorizationUrl = new URL(started.authorizationUrl);
      const completionRequest = {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      } as const;

      const transientFailure = await dispatchRemoteCliRequest(completionRequest, dispatchContext);

      expect(transientFailure).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
      expect(JSON.stringify(transientFailure)).not.toContain("secret-token");
      await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
        status: "pending",
      });
      await expect(dispatchRemoteCliRequest(completionRequest, dispatchContext)).resolves.toEqual({
        ok: true,
        result: { server: "remote", authenticated: true },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("terminalizes an MCP claim after a terminal 400 token response", async () => {
    const fixture = remoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    mockMcpAuth
      .mockImplementationOnce(async (provider: FileOAuthProvider) => {
        provider.saveCodeVerifier("persisted-pkce-verifier");
        provider.saveDiscoveryState({
          authorizationServerUrl: "https://auth.example.com",
          authorizationServerMetadata: {
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            response_types_supported: ["code"],
          },
        });
        provider.redirectToAuthorization(
          new URL(`https://auth.example.com/authorize?state=${provider.state()}`),
        );
        return "REDIRECT";
      })
      .mockImplementationOnce(async (_provider, options) => {
        const response = await options.fetchFn("https://auth.example.com/token", {
          method: "POST",
        });
        expect(response.status).toBe(400);
        throw new InvalidRequestError("provider echoed refresh_token=secret-refresh-token");
      });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: "invalid_request", refresh_token: "secret-refresh-token" },
          { status: 400 },
        ),
      );
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const completionRequest = {
      command: "auth_login_complete",
      arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
    } as const;

    const terminalFailure = await dispatchRemoteCliRequest(completionRequest, dispatchContext);

    expect(terminalFailure).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
    expect(JSON.stringify(terminalFailure)).not.toContain("secret-refresh-token");
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      dispatchRemoteCliRequest(completionRequest, dispatchContext),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("cannot be retried") },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases an MCP claim after a retryable OAuth token error", async () => {
    const fixture = remoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    mockMcpAuth
      .mockImplementationOnce(async (provider: FileOAuthProvider) => {
        provider.saveCodeVerifier("persisted-pkce-verifier");
        provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" });
        provider.redirectToAuthorization(
          new URL(`https://auth.example.com/authorize?state=${provider.state()}`),
        );
        return "REDIRECT";
      })
      .mockRejectedValueOnce(new TemporarilyUnavailableError("OAuth provider overloaded"))
      .mockImplementationOnce(async (provider: FileOAuthProvider) => {
        await provider.saveTokens({
          access_token: "completed-access-token",
          token_type: "Bearer",
        });
        return "AUTHORIZED";
      });
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const completionRequest = {
      command: "auth_login_complete",
      arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
    } as const;

    await expect(
      dispatchRemoteCliRequest(completionRequest, dispatchContext),
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "pending",
    });

    await expect(dispatchRemoteCliRequest(completionRequest, dispatchContext)).resolves.toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    expect(mockMcpAuth).toHaveBeenCalledTimes(3);
  });

  it("fails an ambiguous credential-storage outcome closed without re-exchanging", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(oauthTokenResponse());
    vi.spyOn(storage.backendAuthFlows, "completeClaim").mockRejectedValueOnce(
      Object.assign(new Error("connection reset before credential commit"), {
        code: "ECONNRESET",
      }),
    );

    const ambiguous = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      dispatchContext,
    );

    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("unknown completion outcome"),
      },
    });
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "unknown",
    });
    const replay = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: { flowId: started.flowId, callbackUrl: oauthCallbackUrl(authorizationUrl) },
      },
      dispatchContext,
    );
    expect(replay).toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("unknown completion outcome"),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers a correlated completion when the atomic commit acknowledgement is lost", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(oauthTokenResponse());
    const completeClaim = storage.backendAuthFlows.completeClaim.bind(storage.backendAuthFlows);
    vi.spyOn(storage.backendAuthFlows, "completeClaim").mockImplementationOnce(async (input) => {
      await completeClaim(input);
      throw Object.assign(new Error("connection reset after credential commit"), {
        code: "ECONNRESET",
      });
    });

    await expect(
      dispatchRemoteCliRequest(
        {
          command: "auth_login_complete",
          arguments: {
            flowId: started.flowId,
            callbackUrl: oauthCallbackUrl(authorizationUrl),
          },
        },
        dispatchContext,
      ),
    ).resolves.toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(storage.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
      generation: 1,
      bundle: { accessToken: "remote-access-token" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("terminalizes state mismatch and scrubs the durable flow", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const mismatch = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: "http://127.0.0.1/callback?code=code&state=wrong-state",
        },
      },
      dispatchContext,
    );

    expect(mismatch).toMatchObject({ ok: false, error: { code: "AUTH_FAILED" } });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("terminalizes an OAuth provider callback error", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const authorizationUrl = new URL(started.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const callbackUrl = new URL("http://127.0.0.1/callback");
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("error_description", "Denied");
    callbackUrl.searchParams.set("state", state ?? "");

    const providerError = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: callbackUrl.toString(),
        },
      },
      dispatchContext,
    );

    expect(providerError).toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("provider returned an error"),
      },
    });
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("reports an expired durable flow without exchanging", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const flow = await storage.backendAuthFlows.get(started.flowId);
    if (!flow) throw new Error("Expected a persisted backend auth flow.");
    await storage.backendAuthFlows.expire(started.flowId, new Date(flow.expiresAt));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const expired = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: oauthCallbackUrl(new URL(started.authorizationUrl)),
        },
      },
      dispatchContext,
    );

    expect(expired).toMatchObject({
      ok: false,
      error: { code: "AUTH_FAILED", message: expect.stringContaining("expired") },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "expired",
    });
  });

  it("fails closed when security-sensitive OAuth configuration drifts", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const config = JSON.parse(readFileSync(fixture.context.configPath, "utf8")) as {
      httpApis: { remote: { auth: { tokenUrl: string } } };
    };
    config.httpApis.remote.auth.tokenUrl = "https://changed.example.com/token";
    writeFileSync(fixture.context.configPath, JSON.stringify(config));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const drifted = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: oauthCallbackUrl(new URL(started.authorizationUrl)),
        },
      },
      dispatchContext,
    );

    expect(drifted).toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("configuration changed"),
        nextAction: "run_caplets_auth_login",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("marks an abandoned uncorrelated claim unknown without re-exchanging", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    await storage.backendAuthFlows.claim({
      flowId: started.flowId,
      now: new Date(Date.now() - 3 * 60_000),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const abandoned = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: oauthCallbackUrl(new URL(started.authorizationUrl)),
        },
      },
      dispatchContext,
    );

    expect(abandoned).toMatchObject({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: expect.stringContaining("unknown completion outcome"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it("reconciles an abandoned claim from a correlated credential write", async () => {
    const fixture = genericRemoteFixtureWithOAuth();
    const storage = await configuredTestStorage(fixture.context);
    const dispatchContext = remoteOAuthDispatchContext(fixture.context, storage);
    const started = await startRemoteOAuth(dispatchContext);
    const claim = await storage.backendAuthFlows.claim({
      flowId: started.flowId,
      now: new Date(Date.now() - 3 * 60_000),
    });
    if (!claim.acquired) throw new Error("Expected to acquire the backend auth flow.");
    await storage.backendAuth.writeTokenBundle({
      server: "remote",
      accessToken: "committed-access-token",
      metadata: {
        backendAuthFlow: {
          flowId: started.flowId,
          completionCorrelation: claim.completionCorrelation,
        },
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const reconciled = await dispatchRemoteCliRequest(
      {
        command: "auth_login_complete",
        arguments: {
          flowId: started.flowId,
          callbackUrl: oauthCallbackUrl(new URL(started.authorizationUrl)),
        },
      },
      dispatchContext,
    );

    expect(reconciled).toEqual({
      ok: true,
      result: { server: "remote", authenticated: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "completed",
    });
  });
  it("rejects a forged Access principal for stored record administration", async () => {
    const context = testContext();
    const administration = currentHostAdministration(context);
    Object.defineProperty(administration.principal, "role", { value: "access" });

    await expect(
      dispatchRemoteCliRequest(
        { command: "storage_records_list", arguments: {} },
        context,
        administration,
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "AUTH_FAILED",
        message: "Current Host administration requires an Operator principal.",
      },
    });
  });

  it("delegates source-first record operations without reading transport-owned storage", async () => {
    const context = testContext();
    const operations = [
      {
        request: { command: "storage_records_list", arguments: {} },
        operation: { kind: "stored_caplets_list" },
        outcome: { kind: "stored_caplets_list", records: [{ id: "record" }] },
        result: [{ id: "record" }],
      },
      {
        request: { command: "storage_records_revisions", arguments: { id: "record" } },
        operation: { kind: "stored_caplet_revisions", id: "record" },
        outcome: {
          kind: "stored_caplet_revisions",
          revisions: [{ revisionKey: "rev_1", sequence: 1, name: "Record" }],
        },
        result: [{ revisionKey: "rev_1", sequence: 1, name: "Record" }],
      },
      {
        request: {
          command: "storage_records_restore",
          arguments: { id: "record", revisionKey: "rev_1", expectedGeneration: 2 },
        },
        operation: {
          kind: "stored_caplet_restore_revision",
          id: "record",
          revisionKey: "rev_1",
          expectedGeneration: 2,
        },
        outcome: {
          kind: "stored_caplet_restore_revision",
          record: { id: "record", headGeneration: 3 },
        },
        result: { id: "record", headGeneration: 3 },
      },
      {
        request: {
          command: "storage_records_delete_revision",
          arguments: { id: "record", revisionKey: "rev_1", expectedGeneration: 3 },
        },
        operation: {
          kind: "stored_caplet_delete_revision",
          id: "record",
          revisionKey: "rev_1",
          expectedGeneration: 3,
        },
        outcome: {
          kind: "stored_caplet_delete_revision",
          record: { id: "record", headGeneration: 4 },
        },
        result: { deleted: true, record: { id: "record", headGeneration: 4 } },
      },
      {
        request: {
          command: "storage_records_delete",
          arguments: { id: "record", expectedGeneration: 4 },
        },
        operation: { kind: "stored_caplet_delete", id: "record", expectedGeneration: 4 },
        outcome: { kind: "stored_caplet_delete", deleted: true, id: "record" },
        result: { deleted: true, id: "record" },
      },
    ] as const;
    const execute = vi.fn(
      async (_principal: unknown, operation: { kind: string }) =>
        operations.find(({ operation: expected }) => expected.kind === operation.kind)!.outcome,
    );
    const administration = {
      ...currentHostAdministration(context),
      operations: { execute } as unknown as CurrentHostOperations,
    };
    Object.defineProperty(administration, "storage", {
      get: () => {
        throw new Error("transport-owned HostStorage was read");
      },
    });

    for (const fixture of operations) {
      await expect(
        dispatchRemoteCliRequest(fixture.request, context, administration),
      ).resolves.toEqual({ ok: true, result: fixture.result });
    }
    expect(execute.mock.calls.map(([, operation]) => operation)).toEqual(
      operations.map(({ operation }) => operation),
    );
  });

  it("administers complete stored bundles and installation lifecycles", async () => {
    const context = testContext();
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(context.tempRoot, "records.sqlite3"),
    });
    const activateConfig = vi.fn(async () => undefined);
    const administration = currentHostAdministration({ ...context, storage, activateConfig });
    const document = (command: string, title: string) =>
      Buffer.from(
        `---\nname: Remote Record\ndescription: Remote bundle fixture.\nmcpServer:\n  command: ${command}\n---\n# ${title}\n`,
      );
    const wireFiles = (command: string, title: string) => [
      {
        path: "CAPLET.md",
        contentBase64: document(command, title).toString("base64"),
        executable: false,
      },
      {
        path: "bin/run",
        contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
        executable: true,
      },
    ];

    try {
      const imported = await dispatchRemoteCliRequest(
        {
          command: "storage_records_import",
          arguments: {
            id: "remote-record",
            files: wireFiles("first", "First"),
            historyLimit: 4,
          },
        },
        context,
        administration,
      );
      expect(imported).toMatchObject({
        ok: true,
        result: { id: "remote-record", headGeneration: 1 },
      });

      const read = await dispatchRemoteCliRequest(
        { command: "storage_records_get", arguments: { id: "remote-record" } },
        context,
        administration,
      );
      expect(read).toMatchObject({
        ok: true,
        result: {
          record: { id: "remote-record" },
          files: expect.arrayContaining([
            {
              path: "bin/run",
              contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
              executable: true,
            },
          ]),
        },
      });

      const updated = await dispatchRemoteCliRequest(
        {
          command: "storage_records_update",
          arguments: {
            id: "remote-record",
            files: wireFiles("second", "Second"),
            expectedGeneration: 1,
          },
        },
        context,
        administration,
      );
      expect(updated).toMatchObject({ ok: true, result: { headGeneration: 2 } });
      await expect(
        dispatchRemoteCliRequest(
          {
            command: "storage_records_update",
            arguments: {
              id: "remote-record",
              files: wireFiles("stale", "Stale"),
              expectedGeneration: 1,
            },
          },
          context,
          administration,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "REQUEST_INVALID", message: expect.stringContaining("reload and retry") },
      });
      await storage.installations.install({
        capletId: "remote-record",
        sourceKind: "git",
        sourceIdentity: "https://example.test/remote.git",
        operator: { role: "operator", clientId: "test" },
      });

      const revisions = await storage.caplets.listRevisions("remote-record", {
        role: "operator",
        clientId: "test",
      });
      const oldRevision = revisions.find((revision) => revision.sequence === 1);
      expect(oldRevision).toBeDefined();

      const retained = await dispatchRemoteCliRequest(
        {
          command: "storage_records_retention",
          arguments: { id: "remote-record", historyLimit: 3, expectedGeneration: 2 },
        },
        context,
        administration,
      );
      expect(retained).toMatchObject({ ok: true, result: { headGeneration: 3, historyLimit: 3 } });
      const renamed = await dispatchRemoteCliRequest(
        {
          command: "storage_records_rename",
          arguments: { id: "remote-record", newId: "renamed-record", expectedGeneration: 3 },
        },
        context,
        administration,
      );
      expect(renamed).toMatchObject({ ok: true, result: { id: "renamed-record" } });

      const status = await dispatchRemoteCliRequest(
        {
          command: "storage_records_installation_status",
          arguments: { id: "renamed-record" },
        },
        context,
        administration,
      );
      expect(status).toMatchObject({
        ok: true,
        result: { installations: [{ status: "active", generation: 1 }], observations: [] },
      });
      await expect(
        dispatchRemoteCliRequest(
          {
            command: "storage_records_installation_observe",
            arguments: {
              id: "renamed-record",
              expectedGeneration: 1,
              status: "metadata-only",
              resolvedRevision: "abc123",
              risk: { network: "low" },
            },
          },
          context,
          administration,
        ),
      ).resolves.toMatchObject({ ok: true, result: { status: "metadata-only" } });
      const detached = await dispatchRemoteCliRequest(
        {
          command: "storage_records_installation_detach",
          arguments: { id: "renamed-record", expectedGeneration: 2 },
        },
        context,
        administration,
      );
      expect(detached).toMatchObject({
        ok: true,
        result: { status: "detached", generation: 3 },
      });
      const detachedInstallationKey =
        detached.ok &&
        detached.result &&
        typeof detached.result === "object" &&
        "installationKey" in detached.result &&
        typeof detached.result.installationKey === "string"
          ? detached.result.installationKey
          : "";
      await expect(
        dispatchRemoteCliRequest(
          {
            command: "storage_records_installation_replace",
            arguments: {
              id: "renamed-record",
              expectedGeneration: 3,
              sourceKind: "git",
              sourceIdentity: "https://example.test/replacement.git",
              detachedInstallationKey,
            },
          },
          context,
          administration,
        ),
      ).resolves.toMatchObject({ ok: true, result: { status: "active", generation: 1 } });

      const restored = await dispatchRemoteCliRequest(
        {
          command: "storage_records_restore",
          arguments: {
            id: "renamed-record",
            revisionKey: oldRevision!.revisionKey,
            expectedGeneration: 4,
          },
        },
        context,
        administration,
      );
      expect(restored).toMatchObject({ ok: true, result: { headGeneration: 5 } });
      const afterRestore = await storage.caplets.listRevisions("renamed-record", {
        role: "operator",
        clientId: "test",
      });
      const deletable = afterRestore.find((revision) => revision.sequence !== 3);
      expect(deletable).toBeDefined();
      const deletedRevision = await dispatchRemoteCliRequest(
        {
          command: "storage_records_delete_revision",
          arguments: {
            id: "renamed-record",
            revisionKey: deletable!.revisionKey,
            expectedGeneration: 5,
          },
        },
        context,
        administration,
      );
      expect(deletedRevision).toMatchObject({
        ok: true,
        result: { deleted: true, record: { headGeneration: 6 } },
      });
      await expect(
        dispatchRemoteCliRequest(
          {
            command: "storage_records_delete",
            arguments: { id: "renamed-record", expectedGeneration: 6 },
          },
          context,
          administration,
        ),
      ).resolves.toEqual({
        ok: true,
        result: { deleted: true, id: "renamed-record" },
      });
      expect(activateConfig).toHaveBeenCalledTimes(9);
    } finally {
      await storage.close();
    }
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
        options: { exposure: "progressive" },
        storage: { type: "sqlite", path: join(dir, "host-state.sqlite3") },
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
  authDir?: string;
  globalCapletsRoot?: string;
  globalLockfilePath?: string;
  controlCallbackBaseUrl?: string;
  storage?: HostStorage;
  activateConfig?: () => Promise<void>;
  engine?: CurrentHostOperationsDependencies["engine"];
};

function currentHostAdministration(context: DispatchAdministrationContext) {
  return {
    operations: createCurrentHostOperations({
      engine: context.engine ?? { enabledServers: () => [] },
      control: {
        configPath: context.configPath,
        projectConfigPath: context.projectConfigPath,
        ...(context.authDir !== undefined ? { authDir: context.authDir } : {}),
        ...(context.globalCapletsRoot !== undefined
          ? { globalCapletsRoot: context.globalCapletsRoot }
          : {}),
        globalLockfilePath:
          context.globalLockfilePath ?? join(context.tempRoot, "remote-state", "caplets.lock.json"),
      },
      activityLog: new DashboardActivityLog({ dir: join(context.tempRoot, "activity") }),
      ...(context.storage
        ? {
            capletRecords: context.storage.caplets,
            capletInstallations: context.storage.installations,
            catalogStorage: context.storage,
            vaultGrants: context.storage.vaultGrants,
            vaultValues: context.storage.vaultValues,
          }
        : {}),
      version: "test-version",
      ...(context.controlCallbackBaseUrl
        ? { backendAuthCallbackBaseUrl: context.controlCallbackBaseUrl }
        : {}),
      ...(context.activateConfig ? { activateConfig: context.activateConfig } : {}),
    }),
    principal: {
      clientId: "rcli_abcdefghijklmnop",
      hostUrl: "http://127.0.0.1:5387/",
      role: "operator" as const,
    },
  };
}

async function configuredTestStorage(context: DispatchAdministrationContext): Promise<HostStorage> {
  const databasePath = join(context.tempRoot, "host-state.sqlite3");
  const config = existsSync(context.configPath)
    ? (JSON.parse(readFileSync(context.configPath, "utf8")) as Record<string, unknown>)
    : {};
  config.storage = { type: "sqlite", path: databasePath };
  writeFileSync(context.configPath, JSON.stringify(config));
  const storage = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { vaultRoot: join(context.authDir ?? context.tempRoot, "vault") },
  );
  storages.push(storage);
  return storage;
}

function remoteOAuthDispatchContext(
  context: DispatchAdministrationContext & {
    projectCapletsRoot: string;
    watch: boolean;
  },
  storage: HostStorage,
): Parameters<typeof dispatchRemoteCliRequest>[1] {
  const dispatchContext = {
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
    projectCapletsRoot: context.projectCapletsRoot,
    watch: context.watch,
    ...(context.authDir !== undefined ? { authDir: context.authDir } : {}),
    ...(context.globalCapletsRoot !== undefined
      ? { globalCapletsRoot: context.globalCapletsRoot }
      : {}),
    ...(context.globalLockfilePath !== undefined
      ? { globalLockfilePath: context.globalLockfilePath }
      : {}),
    hostStorage: storage,
    controlCallbackBaseUrl: "http://127.0.0.1:5387/control",
  };
  currentHostAdministrationByContext.set(
    dispatchContext,
    currentHostAdministration({
      ...context,
      storage,
      controlCallbackBaseUrl: dispatchContext.controlCallbackBaseUrl,
    }),
  );
  return dispatchContext;
}

async function startRemoteOAuth(
  context: Parameters<typeof dispatchRemoteCliRequest>[1],
): Promise<{ flowId: string; authorizationUrl: string }> {
  const response = await dispatchRemoteCliRequest(
    { command: "auth_login_start", arguments: { server: "remote" } },
    context,
  );
  if (!response.ok) {
    throw new Error(`Could not start remote OAuth: ${response.error.message}`);
  }
  return response.result as { flowId: string; authorizationUrl: string };
}

function oauthCallbackUrl(authorizationUrl: URL): string {
  const callbackUrl = new URL("http://127.0.0.1/callback");
  callbackUrl.searchParams.set("code", "code");
  callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
  return callbackUrl.toString();
}

function oauthTokenResponse(): Response {
  return Response.json({
    access_token: "remote-access-token",
    refresh_token: "remote-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
  });
}

function genericRemoteFixtureWithOAuth() {
  const dir = mkdtempSync(join(tmpdir(), "caplets-dispatch-generic-auth-"));
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
      httpApis: {
        remote: {
          name: "Remote",
          description: "Remote generic OAuth server.",
          baseUrl: "https://api.example.com",
          auth: {
            type: "oauth2",
            clientId: "client",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
          },
          actions: {
            status: { method: "GET", path: "/status" },
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
