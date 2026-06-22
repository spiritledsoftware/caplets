import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsError } from "../src/errors";
import { createPairingCodeVerifier, isPairingCodeFormat } from "../src/remote/pairing";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("self-hosted remote pairing", () => {
  it("creates pending login flows that approve and complete with separate possession material", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const pending = store.createPendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      hostIdentity: "https://caplets.example.com/caplets",
      clientLabel: "MacBook Pro",
      clientFingerprint: "fp_123",
      sourceHint: "127.0.0.1",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(pending).toMatchObject({
      flowId: expect.stringMatching(/^rlogin_/u),
      operatorCode: expect.stringMatching(/^cap_login_/u),
      pendingRefreshSecret: expect.stringMatching(/^cap_pending_refresh_/u),
      pendingCompletionSecret: expect.stringMatching(/^cap_pending_complete_/u),
      codeExpiresAt: "2026-06-19T12:10:00.000Z",
      flowExpiresAt: "2026-06-20T12:00:00.000Z",
      intervalSeconds: 5,
    });
    expect(pending.pendingRefreshSecret).not.toBe(pending.pendingCompletionSecret);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.operatorCode);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.pendingRefreshSecret);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(pending.pendingCompletionSecret);

    expect(
      store.pollPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:01:00.000Z"),
      }),
    ).toMatchObject({ status: "pending" });

    expect(() =>
      store.completePendingLogin({
        hostUrl: "https://caplets.example.com/caplets",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:01:30.000Z"),
      }),
    ).toThrow(/approved/u);

    const approved = store.approvePendingLogin({
      operatorCode: pending.operatorCode,
      now: new Date("2026-06-19T12:02:00.000Z"),
    });
    expect(approved).toMatchObject({
      flowId: pending.flowId,
      status: "approved",
      clientLabel: "MacBook Pro",
      clientFingerprint: "fp_123",
      sourceHint: "127.0.0.1",
    });

    expect(() =>
      store.refreshPendingLogin({
        flowId: pending.flowId,
        pendingRefreshSecret: pending.pendingRefreshSecret,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:02:30.000Z"),
      }),
    ).toThrow(/approved/u);

    const credentials = store.completePendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      now: new Date("2026-06-19T12:03:00.000Z"),
    });
    expect(credentials).toMatchObject({
      hostUrl: "https://caplets.example.com/caplets",
      clientLabel: "MacBook Pro",
      tokenType: "Bearer",
    });
    expect(credentials.accessToken).not.toBe(pending.pendingRefreshSecret);
    expect(credentials.refreshToken).not.toBe(pending.pendingCompletionSecret);
    expect(store.listClients()).toEqual([
      expect.objectContaining({ clientId: credentials.clientId, clientLabel: "MacBook Pro" }),
    ]);
    expect(() =>
      store.completePendingLogin({
        hostUrl: "https://caplets.example.com/caplets",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:03:30.000Z"),
      }),
    ).toThrow(/exchanged/u);
  });

  it("rotates pending login codes and rejects terminal pending flows", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const pending = store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      clientLabel: "MacBook Pro",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    const refreshed = store.refreshPendingLogin({
      flowId: pending.flowId,
      pendingRefreshSecret: pending.pendingRefreshSecret,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      now: new Date("2026-06-19T12:09:00.000Z"),
    });

    expect(refreshed).toMatchObject({
      flowId: pending.flowId,
      operatorCode: expect.stringMatching(/^cap_login_/u),
      pendingRefreshSecret: expect.stringMatching(/^cap_pending_refresh_/u),
      codeExpiresAt: "2026-06-19T12:19:00.000Z",
      flowExpiresAt: pending.flowExpiresAt,
      intervalSeconds: 5,
    });
    expect(refreshed.operatorCode).not.toBe(pending.operatorCode);
    expect(refreshed.pendingRefreshSecret).not.toBe(pending.pendingRefreshSecret);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(refreshed.operatorCode);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(refreshed.pendingRefreshSecret);
    expect(() =>
      store.approvePendingLogin({
        operatorCode: pending.operatorCode,
        now: new Date("2026-06-19T12:10:00.000Z"),
      }),
    ).toThrow(/unknown/u);
    expect(() =>
      store.refreshPendingLogin({
        flowId: pending.flowId,
        pendingRefreshSecret: pending.pendingRefreshSecret,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:10:00.000Z"),
      }),
    ).toThrow(/stale/u);

    store.denyPendingLogin({
      operatorCode: refreshed.operatorCode,
      now: new Date("2026-06-19T12:11:00.000Z"),
    });
    expect(
      store.pollPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:12:00.000Z"),
      }),
    ).toMatchObject({ status: "denied" });
    expect(() =>
      store.completePendingLogin({
        hostUrl: "https://caplets.example.com",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        now: new Date("2026-06-19T12:12:30.000Z"),
      }),
    ).toThrow(/denied/u);
  });

  it("cancels and expires pending login flows without issuing credentials", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const cancelled = store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(
      store.cancelPendingLogin({
        flowId: cancelled.flowId,
        pendingCompletionSecret: cancelled.pendingCompletionSecret,
        now: new Date("2026-06-19T12:01:00.000Z"),
      }),
    ).toMatchObject({ flowId: cancelled.flowId, status: "cancelled" });
    expect(() =>
      store.completePendingLogin({
        hostUrl: "https://caplets.example.com",
        flowId: cancelled.flowId,
        pendingCompletionSecret: cancelled.pendingCompletionSecret,
        now: new Date("2026-06-19T12:01:30.000Z"),
      }),
    ).toThrow(/cancelled/u);

    const expired = store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    expect(
      store.pollPendingLogin({
        flowId: expired.flowId,
        pendingCompletionSecret: expired.pendingCompletionSecret,
        now: new Date("2026-06-20T12:00:01.000Z"),
      }),
    ).toMatchObject({ flowId: expired.flowId, status: "expired" });
    expect(() =>
      store.approvePendingLogin({
        operatorCode: expired.operatorCode,
        now: new Date("2026-06-20T12:00:01.000Z"),
      }),
    ).toThrow(/expired/u);
    expect(store.listClients()).toHaveLength(0);
  });

  it("cleans up expired pending login records before listing and creating new flows", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(store.listPendingLogins(new Date("2026-06-22T12:00:00.000Z"))).toEqual([]);

    const fresh = store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-22T12:00:00.000Z"),
    });

    expect(store.listPendingLogins(new Date("2026-06-22T12:01:00.000Z"))).toEqual([
      expect.objectContaining({ flowId: fresh.flowId, status: "pending" }),
    ]);
  });

  it("bounds active pending login flows per observed source", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });

    for (let index = 0; index < 8; index += 1) {
      store.createPendingLogin({
        hostUrl: "https://caplets.example.com",
        sourceHint: "203.0.113.7",
        now: new Date("2026-06-19T12:00:00.000Z"),
      });
    }

    expect(() =>
      store.createPendingLogin({
        hostUrl: "https://caplets.example.com",
        sourceHint: "203.0.113.7",
        now: new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).toThrow(/Too many active pending logins for this source/u);

    expect(
      store.createPendingLogin({
        hostUrl: "https://caplets.example.com",
        sourceHint: "203.0.113.8",
        now: new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).toMatchObject({ operatorCode: expect.stringMatching(/^cap_login_/u) });
  });

  it("issues one-time Pairing Codes that exchange for client credentials", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com/caplets",
      clientLabel: "MacBook Pro",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(isPairingCodeFormat(issued.code)).toBe(true);
    expect(JSON.stringify(store.dumpForTest())).not.toContain(issued.code);

    const exchanged = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com/caplets",
      code: issued.code,
      clientLabel: "MacBook Pro",
      now: new Date("2026-06-19T12:01:00.000Z"),
    });

    expect(exchanged).toMatchObject({
      clientLabel: "MacBook Pro",
      hostUrl: "https://caplets.example.com/caplets",
      tokenType: "Bearer",
    });
    expect(exchanged.accessToken).not.toBe(issued.code);
    expect(exchanged.refreshToken).not.toBe(issued.code);

    expect(() =>
      store.exchangePairingCode({
        hostUrl: "https://caplets.example.com/caplets",
        code: issued.code,
      }),
    ).toThrow(/used/u);
  });

  it("rejects expired, wrong-host, and attempt-exhausted Pairing Codes", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const expired = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      ttlMs: 1_000,
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    expect(() =>
      store.exchangePairingCode({
        hostUrl: "https://caplets.example.com",
        code: expired.code,
        now: new Date("2026-06-19T12:00:02.000Z"),
      }),
    ).toThrow(/expired/u);

    const wrongHost = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    expect(() =>
      store.exchangePairingCode({
        hostUrl: "https://other.example.com",
        code: wrongHost.code,
      }),
    ).toThrow(/host/u);

    const exhausted = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      maxAttempts: 2,
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const badCode = createPairingCodeVerifier(
      exhausted.codeId,
      "wrong-secret-value-that-is-long-enough",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() =>
        store.exchangePairingCode({
          hostUrl: "https://caplets.example.com",
          code: badCode,
          now: new Date("2026-06-19T12:01:00.000Z"),
        }),
      ).toThrow(CapletsError);
    }
    expect(() =>
      store.exchangePairingCode({
        hostUrl: "https://caplets.example.com",
        code: exhausted.code,
        now: new Date("2026-06-19T12:01:00.000Z"),
      }),
    ).toThrow(/attempts/u);
  });

  it("lists, persists, and revokes paired clients without exposing secrets", () => {
    const dir = tempDir();
    const store = new RemoteServerCredentialStore({ dir });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      clientLabel: "CI Runner",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });

    const restarted = new RemoteServerCredentialStore({ dir });
    expect(restarted.listClients()).toEqual([
      expect.objectContaining({
        clientId: credentials.clientId,
        clientLabel: "CI Runner",
      }),
    ]);
    expect(restarted.listClients()[0]).not.toHaveProperty("revokedAt");
    expect(JSON.stringify(restarted.listClients())).not.toContain(credentials.accessToken);
    expect(JSON.stringify(restarted.listClients())).not.toContain(credentials.refreshToken);

    restarted.validateAccessToken({
      hostUrl: "https://caplets.example.com",
      accessToken: credentials.accessToken,
      now: new Date("2026-06-19T12:01:00.000Z"),
    });
    restarted.revokeClient(credentials.clientId, new Date("2026-06-19T12:02:00.000Z"));
    expect(() =>
      restarted.validateAccessToken({
        hostUrl: "https://caplets.example.com",
        accessToken: credentials.accessToken,
      }),
    ).toThrow(/revoked/u);
  });

  it("rotates refresh tokens once and invalidates the family on delayed stale reuse", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      now: new Date("2026-06-19T12:01:00.000Z"),
    });

    const refreshed = store.refreshClientCredentials({
      hostUrl: "https://caplets.example.com",
      refreshToken: credentials.refreshToken,
      now: new Date("2026-06-19T12:02:00.000Z"),
    });

    expect(refreshed.refreshToken).not.toBe(credentials.refreshToken);
    expect(() =>
      store.refreshClientCredentials({
        hostUrl: "https://caplets.example.com",
        refreshToken: credentials.refreshToken,
        now: new Date("2026-06-19T12:03:00.000Z"),
      }),
    ).toThrow(/stale/u);
    expect(() =>
      store.validateAccessToken({
        hostUrl: "https://caplets.example.com",
        accessToken: refreshed.accessToken,
        now: new Date("2026-06-19T12:04:00.000Z"),
      }),
    ).toThrow(/revoked/u);
  });

  it("does not revoke a client on immediate stale refresh retry", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      now: new Date("2026-06-19T12:01:00.000Z"),
    });

    const refreshed = store.refreshClientCredentials({
      hostUrl: "https://caplets.example.com",
      refreshToken: credentials.refreshToken,
      now: new Date("2026-06-19T12:02:00.000Z"),
    });

    expect(() =>
      store.refreshClientCredentials({
        hostUrl: "https://caplets.example.com",
        refreshToken: credentials.refreshToken,
        now: new Date("2026-06-19T12:02:05.000Z"),
      }),
    ).toThrow(/stale/u);
    expect(
      store.validateAccessToken({
        hostUrl: "https://caplets.example.com",
        accessToken: refreshed.accessToken,
        now: new Date("2026-06-19T12:02:10.000Z"),
      }),
    ).toMatchObject({ clientId: credentials.clientId });
  });

  it("validates access tokens without rewriting server credential state", () => {
    const dir = tempDir();
    const store = new RemoteServerCredentialStore({ dir });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      now: new Date("2026-06-19T12:01:00.000Z"),
    });
    const statePath = join(dir, "remote-server-credentials.json");
    const before = readFileSync(statePath, "utf8");

    expect(
      store.validateAccessToken({
        hostUrl: "https://caplets.example.com",
        accessToken: credentials.accessToken,
        now: new Date("2026-06-19T12:02:00.000Z"),
      }),
    ).toMatchObject({
      clientId: credentials.clientId,
      tokenType: "Bearer",
    });

    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("prunes superseded refresh token hashes after the retention window", () => {
    const store = new RemoteServerCredentialStore({ dir: tempDir() });
    const issued = store.createPairingCode({
      hostUrl: "https://caplets.example.com",
      now: new Date("2026-06-19T12:00:00.000Z"),
    });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      now: new Date("2026-06-19T12:01:00.000Z"),
    });
    const firstRefresh = store.refreshClientCredentials({
      hostUrl: "https://caplets.example.com",
      refreshToken: credentials.refreshToken,
      now: new Date("2026-06-19T12:02:00.000Z"),
    });

    store.refreshClientCredentials({
      hostUrl: "https://caplets.example.com",
      refreshToken: firstRefresh.refreshToken,
      now: new Date("2026-06-20T13:02:00.000Z"),
    });

    const client = store.dumpForTest().clients[0] as {
      supersededRefreshTokenHashes: unknown[];
    };
    expect(client.supersededRefreshTokenHashes).toHaveLength(1);
  });

  it("recovers stale server credential locks left by crashed processes", () => {
    const dir = tempDir();
    const lockPath = join(dir, "remote-server-credentials.lock");
    mkdirSync(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTime, staleTime);
    const store = new RemoteServerCredentialStore({ dir });

    expect(store.createPairingCode({ hostUrl: "https://caplets.example.com" })).toMatchObject({
      codeId: expect.any(String),
    });
  });

  it("creates private server-owned state files where supported", () => {
    const dir = tempDir();
    const store = new RemoteServerCredentialStore({ dir });
    store.createPairingCode({ hostUrl: "https://caplets.example.com" });

    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "remote-server-credentials.json")).mode & 0o777).toBe(0o600);
    }
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-remote-pairing-"));
  dirs.push(dir);
  return dir;
}
