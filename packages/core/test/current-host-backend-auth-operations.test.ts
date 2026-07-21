import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCurrentHostOperations,
  type CurrentHostBackendAuthCallbackPrincipal,
  type CurrentHostPrincipal,
  type CurrentHostOperationsDependencies,
} from "../src/current-host/operations";
import { createHostStorage, type HostStorage } from "../src/storage";

const roots: string[] = [];
const storages: HostStorage[] = [];
const operator = {
  clientId: "rcli_abcdefghijklmnop",
  hostUrl: "https://caplets.example.com/",
  role: "operator" as const,
};
const activityLog: CurrentHostOperationsDependencies["activityLog"] = {
  append: vi.fn(),
  list: () => ({ entries: [] }),
};
const engine: CurrentHostOperationsDependencies["engine"] = { enabledServers: () => [] };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(storages.splice(0).map(async (storage) => await storage.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Current Host backend auth operations", () => {
  it("projects bounded connection pages without exposing credential payloads", async () => {
    const storage = await testStorage();
    await storage.backendAuth.writeTokenBundle({
      server: "remote",
      authType: "oauth2",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: "2999-01-01T00:00:00.000Z",
      scope: "read write",
      clientId: "public-client",
      clientSecret: "client-secret",
      metadata: { stateVerifier: "state-secret" },
    });
    const listPage = vi.spyOn(storage.backendAuth, "listConnectionsPage");
    const listAll = vi.spyOn(storage.backendAuth, "listTokenBundles");
    const operations = createCurrentHostOperations({
      engine,
      activityLog,
      catalogStorage: storage,
      version: "test-version",
    });

    const outcome = await operations.execute(operator, {
      kind: "backend_auth_connections_page",
      limit: 1,
      sort: "asc",
    });

    expect(outcome).toEqual({
      kind: "backend_auth_connections_page",
      page: {
        items: [
          {
            server: "remote",
            generation: 1,
            status: "authenticated",
            authType: "oauth2",
            expiresAt: "2999-01-01T00:00:00.000Z",
            scope: "read write",
          },
        ],
      },
    });
    expect(listPage).toHaveBeenCalledWith({ limit: 1, sort: "asc" });
    expect(listAll).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toMatch(
      /access-secret|refresh-secret|client-secret|state-secret|tokenBundle|bundle/u,
    );
  });
  it("lists configured OAuth targets with missing, expired, and authenticated statuses", async () => {
    const fixture = await oauthFixture();
    await fixture.first.backendAuth.writeTokenBundle({
      server: "expired",
      authType: "oauth2",
      accessToken: "expired-secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
      scope: "expired:read",
    });
    await fixture.first.backendAuth.writeTokenBundle({
      server: "remote",
      authType: "oidc",
      accessToken: "authenticated-secret",
      expiresAt: "2999-01-01T00:00:00.000Z",
      scope: "openid profile",
    });
    const operations = createCurrentHostOperations({
      engine,
      activityLog: fixture.first.operatorActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      version: "test-version",
    });

    const outcome = await operations.execute(operator, {
      kind: "backend_auth_configured_statuses",
    });

    expect(outcome).toEqual({
      kind: "backend_auth_configured_statuses",
      rows: [
        {
          server: "expired",
          status: "expired",
          expiresAt: "2020-01-01T00:00:00.000Z",
          scope: "expired:read",
        },
        { server: "missing", status: "missing" },
        {
          server: "remote",
          status: "authenticated",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scope: "openid profile",
        },
      ],
    });
    expect(JSON.stringify(outcome)).not.toMatch(/expired-secret|authenticated-secret/u);
  });
  it("deletes configured credentials if present without requiring a generation", async () => {
    const fixture = await oauthFixture();
    const invalidateConfig = vi.fn(async () => undefined);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: fixture.first.operatorActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      invalidateConfig,
      version: "test-version",
    });

    await expect(
      operations.execute(operator, {
        kind: "backend_auth_connection_delete_if_present",
        server: "missing",
      }),
    ).resolves.toEqual({
      kind: "backend_auth_connection_delete_if_present",
      server: "missing",
      deleted: false,
    });
    expect(invalidateConfig).not.toHaveBeenCalled();
    await expect(
      operations.execute(operator, {
        kind: "backend_auth_connection_delete_if_present",
        server: "unknown",
      }),
    ).rejects.toMatchObject({
      code: "SERVER_NOT_FOUND",
      message: "Server unknown is not configured for OAuth",
    });

    await fixture.first.backendAuth.writeTokenBundle({
      server: "remote",
      authType: "oauth2",
      accessToken: "access-secret",
    });
    await expect(
      operations.execute(operator, {
        kind: "backend_auth_connection_delete_if_present",
        server: "remote",
      }),
    ).resolves.toEqual({
      kind: "backend_auth_connection_delete_if_present",
      server: "remote",
      deleted: true,
    });
    expect(invalidateConfig).toHaveBeenCalledWith(operator.clientId);
    await expect(fixture.second.backendAuth.readTokenBundle("remote")).resolves.toBeUndefined();
    await expect(
      fixture.second.operatorActivity.list({ action: "backend_auth_deleted" }),
    ).resolves.toEqual({
      entries: [
        expect.objectContaining({
          actorClientId: operator.clientId,
          action: "backend_auth_deleted",
          target: { type: "backend_auth", id: "remote" },
        }),
      ],
    });
  });
  it("gets safe connection details and deletes only the expected generation", async () => {
    const storage = await testStorage();
    await storage.backendAuth.writeTokenBundle({
      server: "remote",
      authType: "oidc",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
      scope: "openid",
      clientSecret: "client-secret",
    });
    const invalidateConfig = vi.fn(async () => undefined);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: storage.operatorActivity,
      catalogStorage: storage,
      invalidateConfig,
      version: "test-version",
    });

    const detail = await operations.execute(operator, {
      kind: "backend_auth_connection_get",
      server: "remote",
    });
    expect(detail).toEqual({
      kind: "backend_auth_connection_get",
      connection: {
        server: "remote",
        generation: 1,
        status: "expired",
        authType: "oidc",
        expiresAt: "2020-01-01T00:00:00.000Z",
        scope: "openid",
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /access-secret|refresh-secret|client-secret|bundle/u,
    );

    await expect(
      operations.execute(operator, {
        kind: "backend_auth_connection_delete",
        server: "remote",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      details: { kind: "stale_generation" },
    });
    expect(invalidateConfig).not.toHaveBeenCalled();

    await expect(
      operations.execute(operator, {
        kind: "backend_auth_connection_delete",
        server: "remote",
        expectedGeneration: 1,
      }),
    ).resolves.toEqual({
      kind: "backend_auth_connection_delete",
      server: "remote",
      deleted: true,
    });
    expect(invalidateConfig).toHaveBeenCalledWith(operator.clientId);
    await expect(
      storage.operatorActivity.list({ action: "backend_auth_deleted" }),
    ).resolves.toEqual({
      entries: [
        expect.objectContaining({
          actorClientId: operator.clientId,
          action: "backend_auth_deleted",
          target: { type: "backend_auth", id: "remote" },
        }),
      ],
    });
  });
  it("starts on one node and completes through opaque callback state on another", async () => {
    const fixture = await oauthFixture();
    const startActivity = fixture.first.operatorActivity;
    const startInvalidation = vi.fn(async () => undefined);
    const callbackInvalidation = vi.fn(async () => undefined);
    const startOperations = createCurrentHostOperations({
      engine,
      activityLog: startActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      backendAuthCallbackBaseUrl: "https://caplets.example.com/v2/admin/",
      invalidateConfig: startInvalidation,
      version: "test-version",
    });
    const callbackOperations = createCurrentHostOperations({
      engine,
      activityLog: fixture.second.operatorActivity,
      catalogStorage: fixture.second,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      backendAuthCallbackBaseUrl: "https://caplets.example.com/v2/admin/",
      invalidateConfig: callbackInvalidation,
      version: "test-version",
    });

    const started = await startOperations.execute(operator, {
      kind: "backend_auth_flow_start",
      server: "remote",
    });
    if ("authenticated" in started) {
      throw new Error("Expected a pending backend auth flow.");
    }
    expect(started).toMatchObject({
      kind: "backend_auth_flow_start",
      server: "remote",
      flowId: expect.any(String),
      authorizationUrl: expect.stringContaining("https://auth.example.com/authorize"),
    });
    const flow = await startOperations.execute(operator, {
      kind: "backend_auth_flow_get",
      flowId: started.flowId,
    });
    expect(flow).toEqual({
      kind: "backend_auth_flow_get",
      flow: expect.objectContaining({
        flowId: started.flowId,
        server: "remote",
        status: "pending",
      }),
    });
    expect(JSON.stringify(flow)).not.toMatch(
      /encrypted|payload|stateVerifier|pkceVerifier|clientSecret|claimToken/u,
    );
    await expect(
      fixture.first.operatorActivity.list({ action: "backend_auth_flow_started" }),
    ).resolves.toEqual({
      entries: [
        expect.objectContaining({
          actorClientId: operator.clientId,
          target: { type: "backend_auth", id: "remote" },
        }),
      ],
    });
    expect(startInvalidation).not.toHaveBeenCalled();

    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `https://caplets.example.com/v2/admin/backend-auth-flows/${started.flowId}/callback`,
    );
    const callbackUrl = new URL("https://caplets.example.com/oauth-return");
    callbackUrl.searchParams.set("code", "authorization-code");
    callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-secret",
        refresh_token: "new-refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const callbackPrincipal: CurrentHostBackendAuthCallbackPrincipal = {
      role: "backend_auth_callback",
      flowId: started.flowId,
    };

    await expect(
      callbackOperations.execute(callbackPrincipal, {
        kind: "backend_auth_flow_callback_complete",
        flowId: started.flowId,
        callbackUrl: callbackUrl.toString(),
      }),
    ).resolves.toEqual({
      kind: "backend_auth_flow_callback_complete",
      server: "remote",
      authenticated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(fixture.first.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(fixture.second.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
      bundle: { accessToken: "new-access-secret" },
      generation: 1,
    });
    expect(callbackInvalidation).toHaveBeenCalledTimes(1);
  });
  it("refreshes only the expected connection generation and attributes the operator", async () => {
    const fixture = await oauthFixture();
    await fixture.first.backendAuth.writeTokenBundle({
      server: "remote",
      authType: "oauth2",
      accessToken: "old-access-secret",
      refreshToken: "old-refresh-secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
      clientId: "public-client",
      clientSecret: "stored-client-secret",
      protectedResourceOrigin: "https://api.example.com",
    });
    const invalidateConfig = vi.fn(async () => undefined);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: fixture.first.operatorActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      invalidateConfig,
      version: "test-version",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      operations.execute(operator, {
        kind: "backend_auth_refresh",
        server: "remote",
        expectedGeneration: 0,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      details: { kind: "stale_generation", currentGeneration: 1 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invalidateConfig).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
      Response.json({
        access_token: "refreshed-access-secret",
        refresh_token: "refreshed-refresh-secret",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const refreshed = await operations.execute(operator, {
      kind: "backend_auth_refresh",
      server: "remote",
      expectedGeneration: 1,
    });

    expect(refreshed).toEqual({
      kind: "backend_auth_refresh",
      connection: expect.objectContaining({
        server: "remote",
        generation: 2,
        status: "authenticated",
        authType: "oauth2",
      }),
    });
    expect(JSON.stringify(refreshed)).not.toMatch(
      /old-access|old-refresh|refreshed-access|refreshed-refresh|client-secret|bundle/u,
    );
    expect(invalidateConfig).toHaveBeenCalledWith(operator.clientId);
    await expect(
      fixture.second.operatorActivity.list({ action: "backend_auth_written" }),
    ).resolves.toEqual({
      entries: [
        expect.objectContaining({
          actorClientId: operator.clientId,
          target: { type: "backend_auth", id: "remote" },
        }),
      ],
    });
  });
  it("requires Operators for administration and permits callback principals only for their flow", async () => {
    const storage = await testStorage();
    const connectionPage = vi.spyOn(storage.backendAuth, "listConnectionsPage");
    const flowGet = vi.spyOn(storage.backendAuthFlows, "get");
    const operations = createCurrentHostOperations({
      engine,
      activityLog: storage.operatorActivity,
      catalogStorage: storage,
      backendAuthCallbackBaseUrl: "https://caplets.example.com/v2/admin/",
      version: "test-version",
    });
    const accessPrincipal: CurrentHostPrincipal = { ...operator, role: "access" };
    const callbackPrincipal: CurrentHostBackendAuthCallbackPrincipal = {
      role: "backend_auth_callback",
      flowId: "11111111-1111-4111-8111-111111111111",
    };
    const operatorOnlyOperations = [
      { kind: "backend_auth_connections_page", limit: 10, sort: "asc" },
      { kind: "backend_auth_configured_statuses" },
      { kind: "backend_auth_connection_get", server: "remote" },
      {
        kind: "backend_auth_connection_delete",
        server: "remote",
        expectedGeneration: 0,
      },
      { kind: "backend_auth_connection_delete_if_present", server: "remote" },
      { kind: "backend_auth_flow_start", server: "remote" },
      {
        kind: "backend_auth_flow_get",
        flowId: "11111111-1111-4111-8111-111111111111",
      },
      { kind: "backend_auth_refresh", server: "remote", expectedGeneration: 0 },
    ] as const;

    for (const operation of operatorOnlyOperations) {
      await expect(operations.execute(accessPrincipal, operation)).rejects.toMatchObject({
        code: "AUTH_FAILED",
      });
      await expect(operations.execute(callbackPrincipal, operation)).rejects.toMatchObject({
        code: "AUTH_FAILED",
      });
    }
    await expect(
      operations.execute(callbackPrincipal, {
        kind: "summary",
        baseUrl: "https://caplets.example.com/",
        dashboardUrl: "https://caplets.example.com/dashboard",
        dashboardPath: "/dashboard",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      operations.execute(operator, {
        kind: "backend_auth_flow_callback_complete",
        flowId: callbackPrincipal.flowId,
        callbackUrl: "https://caplets.example.com/callback?code=code&state=state",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      operations.execute(callbackPrincipal, {
        kind: "backend_auth_flow_callback_complete",
        flowId: "22222222-2222-4222-8222-222222222222",
        callbackUrl: "https://caplets.example.com/callback?code=code&state=state",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(connectionPage).not.toHaveBeenCalled();
    expect(flowGet).not.toHaveBeenCalled();
  });
  it("does not treat a callback principal as authority without matching opaque OAuth state", async () => {
    const fixture = await oauthFixture();
    const invalidateConfig = vi.fn(async () => undefined);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: fixture.first.operatorActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      backendAuthCallbackBaseUrl: "https://caplets.example.com/v2/admin/",
      invalidateConfig,
      version: "test-version",
    });
    const started = await operations.execute(operator, {
      kind: "backend_auth_flow_start",
      server: "remote",
    });
    if ("authenticated" in started) throw new Error("Expected a pending backend auth flow.");
    const callbackPrincipal: CurrentHostBackendAuthCallbackPrincipal = {
      role: "backend_auth_callback",
      flowId: started.flowId,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      operations.execute(callbackPrincipal, {
        kind: "backend_auth_flow_callback_complete",
        flowId: started.flowId,
        callbackUrl: "https://caplets.example.com/callback?code=code&state=wrong-state",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fixture.second.backendAuth.readTokenBundle("remote")).resolves.toBeUndefined();
    await expect(fixture.second.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(invalidateConfig).not.toHaveBeenCalled();
  });

  it("terminalizes ambiguous completion outcomes as unknown and fails closed on retry", async () => {
    const fixture = await oauthFixture();
    const invalidateConfig = vi.fn(async () => undefined);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: fixture.first.operatorActivity,
      catalogStorage: fixture.first,
      control: {
        configPath: fixture.configPath,
        projectConfigPath: fixture.projectConfigPath,
        authDir: fixture.authDir,
      },
      backendAuthCallbackBaseUrl: "https://caplets.example.com/v2/admin/",
      invalidateConfig,
      version: "test-version",
    });
    const started = await operations.execute(operator, {
      kind: "backend_auth_flow_start",
      server: "remote",
    });
    if ("authenticated" in started) throw new Error("Expected a pending backend auth flow.");
    const authorizationUrl = new URL(started.authorizationUrl);
    const callbackUrl = new URL("https://caplets.example.com/callback");
    callbackUrl.searchParams.set("code", "authorization-code");
    callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    const callbackPrincipal: CurrentHostBackendAuthCallbackPrincipal = {
      role: "backend_auth_callback",
      flowId: started.flowId,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("fetch network failed"));
    const complete = () =>
      operations.execute(callbackPrincipal, {
        kind: "backend_auth_flow_callback_complete",
        flowId: started.flowId,
        callbackUrl: callbackUrl.toString(),
      });

    await expect(complete()).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("unknown completion outcome"),
    });
    await expect(fixture.second.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
      status: "unknown",
    });
    await expect(complete()).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("unknown completion outcome"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateConfig).not.toHaveBeenCalled();
  });
});

async function testStorage(): Promise<HostStorage> {
  const root = mkdtempSync(join(tmpdir(), "caplets-current-host-backend-auth-"));
  roots.push(root);
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "host.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  storages.push(storage);
  return storage;
}

async function oauthFixture() {
  const root = mkdtempSync(join(tmpdir(), "caplets-current-host-backend-auth-oauth-"));
  roots.push(root);
  const authDir = join(root, "auth");
  const projectRoot = join(root, "project", ".caplets");
  mkdirSync(authDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(root, "config.json");
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
            clientId: "public-client",
            clientSecret: "configured-client-secret",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
          },
          actions: {
            status: { method: "GET", path: "/status" },
          },
        },
        expired: {
          name: "Expired",
          description: "Expired generic OAuth server.",
          baseUrl: "https://expired.example.com",
          auth: {
            type: "oauth2",
            clientId: "public-client",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
          },
          actions: {
            status: { method: "GET", path: "/status" },
          },
        },
        missing: {
          name: "Missing",
          description: "Missing generic OAuth server.",
          baseUrl: "https://missing.example.com",
          auth: {
            type: "oauth2",
            clientId: "public-client",
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
  const databasePath = join(root, "host.sqlite3");
  const first = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { vaultRoot: join(authDir, "vault") },
  );
  const second = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { vaultRoot: join(authDir, "vault") },
  );
  storages.push(first, second);
  return { first, second, configPath, projectConfigPath, authDir };
}
