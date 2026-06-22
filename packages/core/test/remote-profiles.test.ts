import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudAuthStore, type CloudAuthCredentials } from "../src/cloud-auth/store";
import { CapletsError } from "../src/errors";
import { FileRemoteCredentialStore } from "../src/remote/credential-store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import {
  remoteProfileKey,
  remoteProfileStatus,
  selectedWorkspaceKey,
} from "../src/remote/profiles";

const tempDirs: string[] = [];

const cloudCredentials = {
  accessToken: "access_secret",
  refreshToken: "refresh_secret",
  expiresAt: "2099-06-19T12:00:00.000Z",
  scope: ["mcp:tools"],
  tokenType: "Bearer",
  clientSecret: "client_secret",
  pairingCode: "pairing_code",
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Remote Profile storage", () => {
  it("saves a self-hosted profile with redacted status and credential storage", async () => {
    const store = tempRemoteProfileStore();

    const status = await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets/",
      hostIdentity: "host_self_123",
      clientId: "rcli_123",
      clientLabel: "Ian's MacBook",
      credentials: {
        accessToken: "self_hosted_access_secret",
        refreshToken: "self_hosted_refresh_secret",
        tokenType: "Bearer",
        expiresAt: "2099-06-19T12:00:00.000Z",
      },
      now: new Date("2026-06-19T10:00:00.000Z"),
    });

    expect(status).toEqual({
      authenticated: true,
      kind: "self-hosted",
      key: remoteProfileKey({
        kind: "self-hosted",
        hostUrl: "https://caplets.example.com/caplets",
      }),
      hostUrl: "https://caplets.example.com/caplets",
      hostIdentity: "host_self_123",
      clientId: "rcli_123",
      selected: false,
      clientLabel: "Ian's MacBook",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:00:00.000Z",
      expiresAt: "2099-06-19T12:00:00.000Z",
      tokenType: "Bearer",
    });
    expect(JSON.stringify(status)).not.toContain("self_hosted_access_secret");
    expect(JSON.stringify(status)).not.toContain("self_hosted_refresh_secret");

    await expect(
      store.getSelfHostedProfileStatus({
        hostUrl: "https://caplets.example.com/caplets",
        hostIdentity: "host_self_123",
      }),
    ).resolves.toMatchObject({
      clientId: "rcli_123",
      clientLabel: "Ian's MacBook",
      hostIdentity: "host_self_123",
    });
    await expect(
      store.credentials.load(
        remoteProfileKey({
          kind: "self-hosted",
          hostUrl: "https://caplets.example.com/caplets",
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "self_hosted_access_secret" });
  });

  it("fails closed when a self-hosted profile identity does not match the contacted host", async () => {
    const store = tempRemoteProfileStore();
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com",
      hostIdentity: "host_original",
      clientId: "rcli_123",
      credentials: {
        accessToken: "self_hosted_access_secret",
        refreshToken: "self_hosted_refresh_secret",
      },
    });

    await expect(
      store.getSelfHostedProfileStatus({
        hostUrl: "https://caplets.example.com",
        hostIdentity: "host_replaced",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "AUTH_FAILED" }) as CapletsError);
  });

  it("logs out a self-hosted profile without touching Cloud profiles", async () => {
    const store = tempRemoteProfileStore();
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com",
      clientId: "rcli_123",
      credentials: {
        accessToken: "self_hosted_access_secret",
        refreshToken: "self_hosted_refresh_secret",
      },
    });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      credentials: cloudCredentials,
    });

    await expect(
      store.logoutSelfHostedProfile({ hostUrl: "https://caplets.example.com" }),
    ).resolves.toBe(true);

    await expect(
      store.getSelfHostedProfileStatus({ hostUrl: "https://caplets.example.com" }),
    ).resolves.toBeUndefined();
    await expect(
      store.getCloudProfileStatus({ hostUrl: "https://cloud.caplets.dev" }),
    ).resolves.toMatchObject({ workspaceSlug: "team" });
  });

  it("saves a Cloud profile with redacted status and selected workspace pointer", async () => {
    const store = tempRemoteProfileStore();

    const status = await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev/v1/ws/team/mcp",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      clientLabel: "Ian's MacBook",
      credentials: cloudCredentials,
      now: new Date("2026-06-19T10:00:00.000Z"),
    });

    expect(status).toEqual({
      authenticated: true,
      kind: "cloud",
      key: remoteProfileKey({
        kind: "cloud",
        hostUrl: "https://cloud.caplets.dev/",
        workspace: "team",
      }),
      hostUrl: "https://cloud.caplets.dev/",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      selected: true,
      clientLabel: "Ian's MacBook",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:00:00.000Z",
      expiresAt: "2099-06-19T12:00:00.000Z",
      scope: ["mcp:tools"],
      tokenType: "Bearer",
    });
    expect(JSON.stringify(status)).not.toContain("access_secret");
    expect(JSON.stringify(status)).not.toContain("refresh_secret");
    expect(JSON.stringify(status)).not.toContain("client_secret");
    expect(JSON.stringify(status)).not.toContain("pairing_code");
    await expect(
      store.getCloudProfileStatus({ hostUrl: "https://cloud.caplets.dev" }),
    ).resolves.toMatchObject({ workspaceSlug: "team", selected: true });
  });

  it("keeps Cloud workspaces distinct under one host and only logs out the selected profile", async () => {
    const store = tempRemoteProfileStore();
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_a",
      workspaceSlug: "alpha",
      credentials: { ...cloudCredentials, accessToken: "alpha_access" },
    });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_b",
      workspaceSlug: "beta",
      credentials: { ...cloudCredentials, accessToken: "beta_access" },
    });

    expect(await store.listCloudProfileStatuses("https://cloud.caplets.dev")).toEqual([
      expect.objectContaining({ workspaceSlug: "alpha", selected: false }),
      expect.objectContaining({ workspaceSlug: "beta", selected: true }),
    ]);

    await store.logoutCloudProfile({ hostUrl: "https://cloud.caplets.dev" });

    expect(await store.listCloudProfileStatuses("https://cloud.caplets.dev")).toEqual([
      expect.objectContaining({ workspaceSlug: "alpha", selected: false }),
    ]);
    await expect(
      store.credentials.load(
        remoteProfileKey({
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev/",
          workspace: "alpha",
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "alpha_access" });
  });

  it("requires an explicit workspace before mutating a bare Cloud host with no selected workspace", async () => {
    const store = tempRemoteProfileStore();
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_a",
      workspaceSlug: "alpha",
      credentials: cloudCredentials,
    });
    await store.clearSelectedCloudWorkspace("https://cloud.caplets.dev");

    await expect(
      store.getCloudProfileStatus({ hostUrl: "https://cloud.caplets.dev" }),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    await expect(
      store.logoutCloudProfile({ hostUrl: "https://cloud.caplets.dev" }),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });

  it("refreshes explicit Cloud workspaces without changing the selected workspace", async () => {
    const store = tempRemoteProfileStore();
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_alpha",
      workspaceSlug: "alpha",
      credentials: { ...cloudCredentials, accessToken: "alpha_access" },
    });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_beta",
      workspaceSlug: "beta",
      credentials: { ...cloudCredentials, accessToken: "beta_access" },
    });

    const refreshed = await store.refreshCloudProfileIfNeeded({
      hostUrl: "https://cloud.caplets.dev/v1/ws/alpha/mcp",
      needsRefresh: () => true,
      refresh: async (status) => ({
        hostUrl: status.hostUrl,
        workspaceId: status.workspaceId ?? "",
        ...(status.workspaceSlug ? { workspaceSlug: status.workspaceSlug } : {}),
        credentials: { ...cloudCredentials, accessToken: "alpha_refreshed" },
      }),
    });

    expect(refreshed?.status).toMatchObject({ workspaceSlug: "alpha", selected: false });
    await expect(
      store.getCloudProfileStatus({ hostUrl: "https://cloud.caplets.dev" }),
    ).resolves.toMatchObject({ workspaceSlug: "beta", selected: true });
    await expect(
      store.credentials.load(
        remoteProfileKey({
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev/",
          workspace: "alpha",
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "alpha_refreshed" });
  });

  it("recovers stale mutation locks left by crashed processes", async () => {
    const root = tempDir("caplets-remote-profiles-");
    const lockPath = join(root, "remote-profiles.lock");
    mkdirSync(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTime, staleTime);
    const store = new FileRemoteProfileStore({ root });

    await expect(
      store.saveSelfHostedProfile({
        hostUrl: "https://caplets.example.com",
        clientId: "rcli_123",
        credentials: { accessToken: "access", refreshToken: "refresh" },
      }),
    ).resolves.toMatchObject({ authenticated: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects credential-bearing remote URLs before persisting profile data", async () => {
    const root = tempDir("caplets-remote-profiles-");
    const store = new FileRemoteProfileStore({ root });

    await expect(
      store.saveCloudProfile({
        hostUrl: "https://user:pass@cloud.caplets.dev/v1/ws/team/mcp?token=query#refresh",
        workspaceId: "ws_123",
        workspaceSlug: "team",
        credentials: cloudCredentials,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(readdirSync(root)).toEqual([]);
  });

  it("creates private directories and credential files with restrictive permissions", async () => {
    const root = tempDir("caplets-remote-credentials-");
    const credentials = new FileRemoteCredentialStore({ root });

    await credentials.save("profile-key", cloudCredentials);

    expect(await credentials.load("profile-key")).toEqual(cloudCredentials);
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(credentials.pathForKey("profile-key")).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates legacy Cloud Auth through the remote profile store without deleting legacy state", async () => {
    const legacyPath = join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
    const legacy = new CloudAuthStore({ path: legacyPath });
    await legacy.save({
      ...legacyCloudCredentials,
      cloudUrl: "https://cloud.caplets.dev",
      workspaceSlug: "team",
    });
    const store = tempRemoteProfileStore({ legacyCloudAuthStore: legacy });

    const status = await store.getCloudProfileStatus({
      hostUrl: "https://cloud.caplets.dev",
      workspace: "team",
    });

    expect(status).toMatchObject({
      authenticated: true,
      kind: "cloud",
      hostUrl: "https://cloud.caplets.dev/",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      selected: true,
    });
    expect(existsSync(legacyPath)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("legacy_access");
    await expect(
      store.credentials.load(
        remoteProfileKey({
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev/",
          workspace: "team",
        }),
      ),
    ).resolves.toMatchObject({ accessToken: "legacy_access", refreshToken: "legacy_refresh" });
  });

  it("clears matching legacy Cloud Auth when logging out a migrated Cloud Remote Profile", async () => {
    const legacyPath = join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
    const legacy = new CloudAuthStore({ path: legacyPath });
    await legacy.save({
      ...legacyCloudCredentials,
      cloudUrl: "https://cloud.caplets.dev",
      workspaceSlug: "team",
    });
    const store = tempRemoteProfileStore({ legacyCloudAuthStore: legacy });
    await store.getCloudProfileStatus({
      hostUrl: "https://cloud.caplets.dev",
      workspace: "team",
    });

    await expect(
      store.logoutCloudProfile({ hostUrl: "https://cloud.caplets.dev", workspace: "team" }),
    ).resolves.toBe(true);

    expect(existsSync(legacyPath)).toBe(false);
    await expect(
      store.getCloudProfileStatus({ hostUrl: "https://cloud.caplets.dev", workspace: "team" }),
    ).resolves.toBeUndefined();
  });

  it("keeps mismatched legacy Cloud Auth when logging out a different workspace profile", async () => {
    const legacyPath = join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
    const legacy = new CloudAuthStore({ path: legacyPath });
    await legacy.save({
      ...legacyCloudCredentials,
      cloudUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_other",
      workspaceSlug: "other",
    });
    const store = tempRemoteProfileStore({ legacyCloudAuthStore: legacy });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_123",
      workspaceSlug: "team",
      credentials: cloudCredentials,
    });

    await expect(
      store.logoutCloudProfile({ hostUrl: "https://cloud.caplets.dev", workspace: "team" }),
    ).resolves.toBe(true);

    expect(existsSync(legacyPath)).toBe(true);
  });

  it("keeps no-slug legacy Cloud Auth when logging out a different no-slug workspace", async () => {
    const legacyPath = join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
    const legacy = new CloudAuthStore({ path: legacyPath });
    const { workspaceSlug: _workspaceSlug, ...legacyWithoutSlug } = legacyCloudCredentials;
    await legacy.save({
      ...legacyWithoutSlug,
      cloudUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_legacy",
    });
    const store = tempRemoteProfileStore({ legacyCloudAuthStore: legacy });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "ws_profile",
      credentials: cloudCredentials,
    });

    await expect(
      store.logoutCloudProfile({ hostUrl: "https://cloud.caplets.dev", workspace: "ws_profile" }),
    ).resolves.toBe(true);

    expect(existsSync(legacyPath)).toBe(true);
  });
});

describe("Remote Profile helpers", () => {
  it("derives normalized profile and selected workspace keys", () => {
    expect(
      remoteProfileKey({
        kind: "cloud",
        hostUrl: "https://cloud.caplets.dev/v1/ws/team/mcp",
        workspace: "team",
      }),
    ).toBe("cloud:https://cloud.caplets.dev/:team");
    expect(selectedWorkspaceKey("https://cloud.caplets.dev/v1/ws/team/mcp")).toBe(
      "cloud:https://cloud.caplets.dev/:selected-workspace",
    );
  });

  it("redacts raw credential-shaped fields from profile status helpers", () => {
    expect(
      JSON.stringify(
        remoteProfileStatus({
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev",
          workspaceId: "ws_123",
          workspaceSlug: "team",
          clientLabel: "Test",
          credential: cloudCredentials,
        }),
      ),
    ).not.toMatch(/access_secret|refresh_secret|client_secret|pairing_code/u);
  });

  it("does not report partial credentials without access tokens as authenticated", () => {
    expect(
      remoteProfileStatus({
        kind: "self-hosted",
        hostUrl: "https://caplets.example.com",
        clientId: "rcli_123",
        credential: { refreshToken: "refresh_secret" },
      }),
    ).toMatchObject({ authenticated: false });
  });
});

const legacyCloudCredentials: CloudAuthCredentials = {
  version: 2,
  cloudUrl: "https://cloud.caplets.dev",
  workspaceId: "ws_123",
  workspaceSlug: "team",
  accessToken: "legacy_access",
  refreshToken: "legacy_refresh",
  expiresAt: "2099-06-19T12:00:00.000Z",
  scope: ["mcp:tools"],
  tokenType: "Bearer",
  credentialFamilyId: "family_123",
  deviceName: "Legacy CLI",
  createdAt: "2026-06-19T09:00:00.000Z",
  lastRefreshAt: "2026-06-19T09:00:00.000Z",
};

function tempRemoteProfileStore(
  options: { legacyCloudAuthStore?: CloudAuthStore } = {},
): FileRemoteProfileStore {
  return new FileRemoteProfileStore({
    root: tempDir("caplets-remote-profiles-"),
    credentials: new FileRemoteCredentialStore({ root: tempDir("caplets-remote-credentials-") }),
    legacyCloudAuthStore: options.legacyCloudAuthStore,
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
