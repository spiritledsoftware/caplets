import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { resolveRemoteSelection } from "../src/remote/selection";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveRemoteSelection", () => {
  it("rejects attach selection in local mode", async () => {
    await expect(resolveRemoteSelection({}, { CAPLETS_MODE: "local" })).rejects.toThrow(
      /caplets attach requires a remote upstream; set CAPLETS_REMOTE_URL or use caplets serve/u,
    );
  });

  it("rejects auto mode without a remote URL for attach", async () => {
    await expect(resolveRemoteSelection({}, {})).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
  });

  it("resolves self-hosted remote auth from a stored Remote Profile", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "profile-access-token",
        refreshToken: "profile-refresh-token",
        tokenType: "Bearer",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    await expect(
      resolveRemoteSelection(
        { authDir },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
    ).resolves.toMatchObject({
      kind: "self_hosted_remote",
      remote: {
        baseUrl: new URL("https://caplets.example.com/caplets"),
        auth: { type: "bearer", token: "profile-access-token" },
      },
    });
  });

  it("refreshes expired self-hosted credentials before returning the upstream", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    const resolved = await resolveRemoteSelection(
      {
        authDir,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://caplets.example.com/caplets/v1/remote/refresh");
          expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
          return Response.json({
            clientId: "rcli_123",
            clientLabel: "Test Device",
            accessToken: "new-access",
            refreshToken: "new-refresh",
            tokenType: "Bearer",
            expiresAt: "2999-01-01T00:00:00.000Z",
          });
        },
      },
      {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
      },
    );

    expect(resolved).toMatchObject({
      kind: "self_hosted_remote",
      remote: { auth: { type: "bearer", token: "new-access" } },
    });
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    const status = await store.getSelfHostedProfileStatus({
      hostUrl: "https://caplets.example.com/caplets",
    });
    expect(status).toMatchObject({
      clientLabel: "Test Device",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await expect(store.credentials.load(status!.key)).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
  });

  it("surfaces transient self-hosted refresh failures without requiring login", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    await expect(
      resolveRemoteSelection(
        {
          authDir,
          fetch: async () =>
            Response.json(
              {
                ok: false,
                error: {
                  code: "SERVER_UNAVAILABLE",
                  message: "Remote credential state is locked.",
                },
              },
              { status: 503 },
            ),
        },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: "Remote credential state is locked.",
    });
  });

  it("reports revoked self-hosted credentials with relogin and operator approval guidance", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    await expect(
      resolveRemoteSelection(
        {
          authDir,
          fetch: async () =>
            Response.json(
              { error: { code: "AUTH_FAILED", message: "Remote client was revoked." } },
              { status: 401 },
            ),
        },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "remote_credentials_revoked",
      recoveryCommand: "caplets remote login https://caplets.example.com/caplets",
      message: expect.stringContaining("server operator"),
    });
  });

  it("preserves CAPLETS_REMOTE_WORKSPACE for self-hosted remotes", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "profile-access-token",
        refreshToken: "profile-refresh-token",
        tokenType: "Bearer",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    const resolved = await resolveRemoteSelection(
      { authDir },
      {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        CAPLETS_REMOTE_WORKSPACE: "tenant-a",
      },
    );

    expect(resolved).toMatchObject({
      kind: "self_hosted_remote",
      remote: { workspace: "tenant-a" },
    });
  });

  it("serializes concurrent expired self-hosted credential refreshes", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });
    let refreshCalls = 0;
    const fetchRefresh: typeof fetch = async (_url, init) => {
      refreshCalls += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        clientId: "rcli_123",
        clientLabel: "Test Device",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
    };

    const [left, right] = await Promise.all([
      resolveRemoteSelection(
        { authDir, fetch: fetchRefresh },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
      resolveRemoteSelection(
        { authDir, fetch: fetchRefresh },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
        },
      ),
    ]);

    expect(refreshCalls).toBe(1);
    expect(left).toMatchObject({ remote: { auth: { type: "bearer", token: "new-access" } } });
    expect(right).toMatchObject({ remote: { auth: { type: "bearer", token: "new-access" } } });
  });

  it("fails closed when self-hosted attach has only legacy env-token state", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
          CAPLETS_REMOTE_TOKEN: "remote-token",
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "remote_credentials_required",
      recoveryCommand: "caplets remote login https://caplets.example.com/caplets",
    });
  });

  it("uses saved Cloud Remote Profiles in cloud mode and ignores self-hosted token vars", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") }).saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_personal",
      workspaceSlug: "personal",
      credentials: {
        accessToken: "cloud-access",
        refreshToken: "cloud-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });

    const resolved = await resolveRemoteSelection(
      { authDir },
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_REMOTE_TOKEN: "self-hosted-token",
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

  it("honors an explicit Cloud workspace with a bare Cloud URL", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      credentials: {
        accessToken: "old-cloud-access",
        refreshToken: "old-cloud-refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    await store.clearSelectedCloudWorkspace("https://cloud.caplets.dev");

    const resolved = await resolveRemoteSelection(
      {
        authDir,
        remoteUrl: "https://cloud.caplets.dev",
        workspace: "team",
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://cloud.caplets.dev/api/cloud-client/refresh");
          expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-cloud-refresh" });
          return Response.json({
            status: "authenticated",
            cloudUrl: "https://cloud.caplets.dev",
            workspaceId: "workspace_team",
            workspaceSlug: "team",
            accessToken: "new-cloud-access",
            refreshToken: "new-cloud-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z",
            scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
            tokenType: "Bearer",
          });
        },
      },
      {
        CAPLETS_MODE: "cloud",
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "team",
      remote: {
        mcpUrl: new URL("https://cloud.caplets.dev/v1/ws/team/mcp"),
        auth: { type: "bearer", token: "new-cloud-access" },
      },
    });
  });

  it("derives Cloud MCP and Project Binding URLs from the selected workspace", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        cloudUrl: "https://cloud.pr-2.preview.caplets.dev",
        workspaceSlug: "personal-c9b49d",
      }),
    );

    const resolved = await resolveRemoteSelection(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.pr-2.preview.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "personal-c9b49d",
      remote: {
        baseUrl: new URL("https://cloud.pr-2.preview.caplets.dev/"),
        mcpUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/mcp"),
        attachUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach"),
        controlUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/admin"),
        healthUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/healthz"),
        projectBindingWebSocketUrl: new URL(
          "wss://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach/project-bindings/connect",
        ),
      },
    });
  });

  it("normalizes copied Cloud MCP endpoints for attach", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        cloudUrl: "https://cloud.pr-2.preview.caplets.dev",
        workspaceSlug: "personal-c9b49d",
      }),
    );

    const resolved = await resolveRemoteSelection(
      {
        remoteUrl: "https://cloud.pr-2.preview.caplets.dev/ws/personal-c9b49d/mcp",
      },
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "personal-c9b49d",
      remote: {
        baseUrl: new URL("https://cloud.pr-2.preview.caplets.dev/"),
        mcpUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/mcp"),
        attachUrl: new URL("https://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach"),
        projectBindingWebSocketUrl: new URL(
          "wss://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach/project-bindings/connect",
        ),
      },
      cloudPresence: {
        url: new URL("https://cloud.pr-2.preview.caplets.dev/"),
      },
    });
  });

  it("accepts legacy Cloud Auth credentials that predate hosted MCP tool scope", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        scope: ["project_binding:read", "project_binding:write"],
      }),
    );

    const resolved = await resolveRemoteSelection(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "personal",
    });
  });

  it("requires Cloud Auth credentials to include project binding scopes", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        scope: ["project_binding:read"],
      }),
    );

    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "cloud_auth_required",
      recoveryCommand: "caplets remote login <cloud-url>",
    });
  });

  it("rejects copied Cloud MCP endpoints for a different selected workspace", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        cloudUrl: "https://cloud.pr-2.preview.caplets.dev",
        workspaceSlug: "personal-c9b49d",
      }),
    );

    await expect(
      resolveRemoteSelection(
        {
          remoteUrl: "https://cloud.pr-2.preview.caplets.dev/ws/team/mcp",
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "workspace_switch_required",
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
            scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
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

  it("serializes concurrent expired Cloud Remote Profile refreshes", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") }).saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_personal",
      workspaceSlug: "personal",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    let refreshCalls = 0;
    const fetchRefresh: typeof fetch = async (_url, init) => {
      refreshCalls += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        status: "authenticated",
        cloudUrl: "https://cloud.caplets.dev",
        workspaceId: "workspace_personal",
        workspaceSlug: "personal",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
        credentialFamilyId: "family_123",
      });
    };

    const [left, right] = await Promise.all([
      resolveRemoteSelection(
        { authDir, fetch: fetchRefresh },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        },
      ),
      resolveRemoteSelection(
        { authDir, fetch: fetchRefresh },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        },
      ),
    ]);

    expect(refreshCalls).toBe(1);
    expect(left.remote.auth).toEqual({ type: "bearer", token: "new-access" });
    expect(right.remote.auth).toEqual({ type: "bearer", token: "new-access" });
  });

  it("requires Cloud Auth when cloud mode is selected", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: tempCloudAuthPath(),
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "cloud_auth_required",
    });
  });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
