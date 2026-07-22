import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDaemon } from "../src/daemon";
import type { DaemonConfig, DaemonManager, NativeDaemonStatus } from "../src/daemon/types";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { resolveRemoteSelection } from "../src/remote/selection";

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

  it("resolves a setup-validated loopback origin as a credential-free daemon selection", async () => {
    const daemon = await setupPersistedLocalDaemon();
    const fetched: string[] = [];
    await expect(
      resolveRemoteSelection(
        {
          authDir: daemon.options.home,
          remoteUrl: "http://127.0.0.1:5387",
          fetch: async (url) => {
            fetched.push(String(url));
            return Response.json({ ok: true });
          },
        },
        daemon.env,
        { daemon: daemon.options },
      ),
    ).resolves.toMatchObject({
      kind: "local_daemon",
      remote: {
        baseUrl: new URL("http://127.0.0.1:5387"),
        attachUrl: new URL("http://127.0.0.1:5387/api/v1/attach"),
        auth: { type: "none" },
      },
    });
    expect(fetched).toEqual(["http://127.0.0.1:5387/api/v1/healthz"]);
  });

  it("does not classify a spoofed loopback origin as the local daemon", async () => {
    const dir = tempDir("caplets-remote-selection-spoof-daemon-");
    const manager = runningDaemonManager();
    const fetched: string[] = [];
    await expect(
      resolveRemoteSelection(
        {
          remoteUrl: "http://127.0.0.1:9999",
          fetch: async (url) => {
            fetched.push(String(url));
            return Response.json({ ok: true });
          },
        },
        daemonTestEnv(dir),
        { daemon: { home: dir, platform: "linux", manager } },
      ),
    ).rejects.toMatchObject({ projectBindingCode: "remote_credentials_required" });
    expect(fetched).toEqual([]);
  });

  it("prefers a stored Remote Profile over local daemon classification", async () => {
    const authDir = tempDir("caplets-remote-selection-loopback-auth-");
    await saveProfile(authDir, "http://127.0.0.1:5387", {
      accessToken: "profile-access-token",
      refreshToken: "profile-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    await expect(
      resolveRemoteSelection(
        { authDir },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
        },
      ),
    ).resolves.toMatchObject({
      kind: "remote",
      remote: {
        baseUrl: new URL("http://127.0.0.1:5387"),
        auth: { type: "bearer", token: "profile-access-token" },
      },
    });
  });

  it("resolves generic remote authentication from a stored Remote Profile", async () => {
    const authDir = tempDir("caplets-remote-selection-auth-");
    await saveProfile(authDir, "https://caplets.example.com", {
      accessToken: "profile-access-token",
      refreshToken: "profile-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    await expect(
      resolveRemoteSelection(
        { authDir },
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com",
        },
      ),
    ).resolves.toMatchObject({
      kind: "remote",
      remote: {
        baseUrl: new URL("https://caplets.example.com"),
        auth: { type: "bearer", token: "profile-access-token" },
      },
    });
  });

  it("treats a former Cloud hostname as an ordinary Current Host origin", async () => {
    const authDir = tempDir("caplets-remote-selection-former-cloud-");
    await saveProfile(authDir, "https://cloud.caplets.dev", {
      accessToken: "generic-access-token",
      refreshToken: "generic-refresh-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    await expect(
      resolveRemoteSelection(
        { authDir },
        {
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: join(authDir, "legacy-cloud-auth.json"),
        },
      ),
    ).resolves.toMatchObject({
      kind: "remote",
      remote: {
        baseUrl: new URL("https://cloud.caplets.dev"),
        mcpUrl: new URL("https://cloud.caplets.dev/mcp"),
        attachUrl: new URL("https://cloud.caplets.dev/api/v1/attach"),
        auth: { type: "bearer", token: "generic-access-token" },
      },
    });
  });

  it("refreshes expired generic credentials through the Current Host API", async () => {
    const authDir = tempDir("caplets-remote-selection-refresh-");
    await saveProfile(authDir, "https://caplets.example.com", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const resolved = await resolveRemoteSelection(
      {
        authDir,
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://caplets.example.com/api/v1/remote/refresh");
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
        CAPLETS_REMOTE_URL: "https://caplets.example.com",
      },
    );

    expect(resolved).toMatchObject({
      kind: "remote",
      remote: { auth: { type: "bearer", token: "new-access" } },
    });
    await expect(
      resolveRemoteSelection(
        {
          authDir,
          fetch: async () => {
            throw new Error("refreshed credentials should not be refreshed again");
          },
        },
        { CAPLETS_REMOTE_URL: "https://caplets.example.com" },
      ),
    ).resolves.toMatchObject({ remote: { auth: { token: "new-access" } } });
  });

  it("serializes concurrent expired credential refreshes", async () => {
    const authDir = tempDir("caplets-remote-selection-refresh-lock-");
    await saveProfile(authDir, "https://caplets.example.com", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    let refreshCalls = 0;
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    const fetchRefresh: typeof fetch = async (_url, init) => {
      refreshCalls += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return Response.json({
        clientId: "rcli_123",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
    };

    const leftPending = resolveRemoteSelection(
      { authDir, fetch: fetchRefresh },
      { CAPLETS_REMOTE_URL: "https://caplets.example.com" },
    );
    const rightPending = resolveRemoteSelection(
      { authDir, fetch: fetchRefresh },
      { CAPLETS_REMOTE_URL: "https://caplets.example.com" },
    );
    await refreshStarted.promise;
    releaseRefresh.resolve();
    const [left, right] = await Promise.all([leftPending, rightPending]);

    expect(refreshCalls).toBe(1);
    expect(left).toMatchObject({ remote: { auth: { token: "new-access" } } });
    expect(right).toMatchObject({ remote: { auth: { token: "new-access" } } });
  });

  it("surfaces transient refresh failures without requiring login", async () => {
    const authDir = tempDir("caplets-remote-selection-transient-");
    await saveProfile(authDir, "https://caplets.example.com", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(
      resolveRemoteSelection(
        {
          authDir,
          fetch: async () =>
            Response.json(
              { error: { code: "SERVER_UNAVAILABLE", message: "Remote state is locked." } },
              { status: 503 },
            ),
        },
        { CAPLETS_REMOTE_URL: "https://caplets.example.com" },
      ),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE", message: "Remote state is locked." });
  });

  it("reports revoked credentials with relogin guidance", async () => {
    const authDir = tempDir("caplets-remote-selection-revoked-");
    await saveProfile(authDir, "https://caplets.example.com", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(
      resolveRemoteSelection(
        {
          authDir,
          fetch: async () =>
            Response.json(
              { error: { code: "REMOTE_CREDENTIALS_REVOKED", message: "Access denied." } },
              { status: 401 },
            ),
        },
        { CAPLETS_REMOTE_URL: "https://caplets.example.com" },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "remote_credentials_revoked",
      recoveryCommand: "caplets remote login https://caplets.example.com",
      message: expect.stringContaining("server operator"),
    });
  });

  it("fails closed when only legacy environment token state exists", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_REMOTE_URL: "https://caplets.example.com",
          CAPLETS_REMOTE_TOKEN: "legacy-token",
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "remote_credentials_required",
      recoveryCommand: "caplets remote login https://caplets.example.com",
    });
  });
});

async function saveProfile(
  authDir: string,
  origin: string,
  credentials: { accessToken: string; refreshToken: string; expiresAt: string },
): Promise<void> {
  await new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") }).saveRemoteProfile({
    origin,
    clientId: "rcli_123",
    clientLabel: "Test Device",
    credentials,
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupPersistedLocalDaemon(): Promise<{
  env: Record<string, string>;
  options: { home: string; platform: "linux"; manager: DaemonManager };
}> {
  const home = tempDir("caplets-remote-selection-daemon-");
  const env = daemonTestEnv(home);
  const manager = runningDaemonManager();
  const options = { home, platform: "linux" as const, manager };
  await installDaemon(
    { host: "127.0.0.1", port: 5387, validate: false, noRestart: true },
    { env, ...options },
  );
  return { env, options };
}

function daemonTestEnv(dir: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
}

function runningDaemonManager(): DaemonManager {
  const running: NativeDaemonStatus = { state: "running", installed: true, running: true };
  return {
    descriptor: (config: DaemonConfig) => ({
      kind: "systemd-user",
      unitName: "caplets-daemon-default.service",
      path: config.paths.descriptorFile,
      contents: "",
    }),
    status: async () => running,
    install: async () => ({ action: "install", native: running, commands: [] }),
    uninstall: async () => ({ action: "uninstall", native: running, commands: [] }),
    start: async () => ({ action: "start", native: running, commands: [] }),
    restart: async () => ({ action: "restart", native: running, commands: [] }),
    stop: async () => ({ action: "stop", native: running, commands: [] }),
  };
}
