import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsError } from "../src/errors";
import { FileRemoteProfileStore, createRemoteProfileStore } from "../src/remote/profile-store";
import type {
  RefreshRemoteProfileInput,
  RemoteProfileStoreFaultPoint,
} from "../src/remote/profile-store";
import { remoteProfileKey, remoteProfileStatus } from "../src/remote/profiles";
const filesystemTrap = vi.hoisted(() => ({
  accesses: [] as string[],
  forbidden: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const guarded =
    (operation: string, implementation: unknown) =>
    (...args: unknown[]) => {
      const attempted = args
        .slice(0, operation === "renameSync" ? 2 : 1)
        .filter((value): value is string => typeof value === "string")
        .find((path) => filesystemTrap.forbidden.has(path));
      if (attempted) {
        filesystemTrap.accesses.push(`${operation}:${attempted}`);
        throw new Error(`Forbidden Cloud filesystem access: ${operation}`);
      }
      return Reflect.apply(implementation as (...values: unknown[]) => unknown, actual, args);
    };
  return {
    ...actual,
    chmodSync: guarded("chmodSync", actual.chmodSync),
    existsSync: guarded("existsSync", actual.existsSync),
    lstatSync: guarded("lstatSync", actual.lstatSync),
    openSync: guarded("openSync", actual.openSync),
    readFileSync: guarded("readFileSync", actual.readFileSync),
    renameSync: guarded("renameSync", actual.renameSync),
    rmSync: guarded("rmSync", actual.rmSync),
    statSync: guarded("statSync", actual.statSync),
    writeFileSync: guarded("writeFileSync", actual.writeFileSync),
  };
});

const tempDirs: string[] = [];
const credential = {
  accessToken: "access_secret",
  refreshToken: "refresh_secret",
  tokenType: "Bearer",
  expiresAt: "2099-06-19T12:00:00.000Z",
  scope: ["mcp:tools"],
  clientSecret: "client_secret",
  pairingCode: "pairing_code",
};

const faultPoints: RemoteProfileStoreFaultPoint[] = [
  "before-credential-write",
  "after-credential-write",
  "after-credential-flush",
  "before-credential-rename",
  "after-credential-rename",
  "before-profile-write",
  "after-profile-write",
  "after-profile-flush",
  "before-profile-rename",
  "after-profile-rename",
  "before-verification",
  "after-verification",
  "before-legacy-profile-delete",
  "after-legacy-profile-delete",
  "before-legacy-credential-delete",
  "after-legacy-credential-delete",
];

afterEach(() => {
  filesystemTrap.forbidden.clear();
  filesystemTrap.accesses.length = 0;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("generic Remote Profile storage", () => {
  it("stores one versioned remote profile with redacted status", async () => {
    const root = tempRoot();
    const store = new FileRemoteProfileStore({ root });

    const status = await store.saveRemoteProfile({
      origin: "https://CAPLETS.Example.COM:443/",
      hostIdentity: "host_123",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: credential,
      now: new Date("2026-06-19T10:00:00.000Z"),
    });

    expect(status).toEqual({
      authenticated: true,
      key: "remote:https://caplets.example.com",
      origin: "https://caplets.example.com",
      hostIdentity: "host_123",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:00:00.000Z",
      expiresAt: credential.expiresAt,
      scope: credential.scope,
      tokenType: "Bearer",
    });
    expect(JSON.stringify(status)).not.toMatch(
      /access_secret|refresh_secret|client_secret|pairing_code/u,
    );
    expect(readJson(profilePath(root, status.key))).toEqual({
      version: 2,
      key: status.key,
      origin: status.origin,
      hostIdentity: "host_123",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:00:00.000Z",
    });
    expect(await store.getRemoteProfileStatus({ origin: status.origin })).toEqual(status);
    expect(await store.listRemoteProfileStatuses()).toEqual([status]);
    if (process.platform !== "win32") {
      expect(statSync(join(root, "profiles")).mode & 0o777).toBe(0o700);
      expect(statSync(profilePath(root, status.key)).mode & 0o777).toBe(0o600);
      expect(statSync(credentialPath(root, status.key)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects invalid origins before creating the store root", async () => {
    for (const origin of [
      "https://user:pass@caplets.example.com",
      "https://caplets.example.com/base",
      "https://caplets.example.com?workspace=team",
      "https://caplets.example.com/#fragment",
      "file:///tmp/caplets",
      "http://caplets.example.com",
    ]) {
      const root = join(tempDir("caplets-invalid-origin-"), "not-created");
      await expect(
        new FileRemoteProfileStore({ root }).saveRemoteProfile({
          origin,
          clientId: "rcli_123",
          credentials: credential,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
      expect(existsSync(root)).toBe(false);
    }
  });

  it("fails closed on host identity mismatch", async () => {
    const store = new FileRemoteProfileStore({ root: tempRoot() });
    await store.saveRemoteProfile({
      origin: "https://caplets.example.com",
      hostIdentity: "host_original",
      clientId: "rcli_123",
      credentials: credential,
    });

    await expect(
      store.getRemoteProfileStatus({
        origin: "https://caplets.example.com",
        hostIdentity: "host_replaced",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "AUTH_FAILED" }) as CapletsError);
  });

  it("refreshes once under contention and preserves identity and creation time", async () => {
    const root = tempRoot();
    const storeA = new FileRemoteProfileStore({ root, lease: testLease() });
    const storeB = new FileRemoteProfileStore({ root, lease: testLease() });
    await storeA.saveRemoteProfile({
      origin: "https://caplets.example.com",
      hostIdentity: "host_original",
      clientId: "rcli_123",
      credentials: { ...credential, accessToken: "old", expiresAt: "2000-01-01T00:00:00Z" },
      now: new Date("2026-06-19T10:00:00.000Z"),
    });
    let refreshCalls = 0;
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const refresh = async () => {
      refreshCalls += 1;
      started.resolve();
      await resume.promise;
      return {
        origin: "https://caplets.example.com",
        clientId: "rcli_123",
        credentials: { ...credential, accessToken: "new", expiresAt: "2999-01-01T00:00:00Z" },
        now: new Date("2026-06-19T10:05:00.000Z"),
      };
    };
    const input: RefreshRemoteProfileInput = {
      origin: "https://caplets.example.com",
      needsRefresh: (candidate) => candidate.accessToken === "old",
      refresh,
    };

    const firstPending = storeA.refreshRemoteProfileIfNeeded(input);
    await started.promise;
    const secondPending = storeB.refreshRemoteProfileIfNeeded(input);
    resume.resolve();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(refreshCalls).toBe(1);
    expect(first?.credential.accessToken).toBe("new");
    expect(second?.credential.accessToken).toBe("new");
    expect(first?.status).toMatchObject({
      hostIdentity: "host_original",
      createdAt: "2026-06-19T10:00:00.000Z",
      updatedAt: "2026-06-19T10:05:00.000Z",
    });
  });
});

describe("self-hosted profile migration", () => {
  it("rejects a path-bearing legacy profile without rewriting it", async () => {
    const root = tempRoot();
    const legacy = writeLegacyPair(root, "https://CAPLETS.Example.COM:443/caplets/", {
      hostIdentity: "host_legacy",
      clientId: "rcli_legacy",
      clientLabel: "Legacy Device",
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T09:00:00.000Z",
    });
    const before = snapshotTree(root);

    await expect(new FileRemoteProfileStore({ root }).listRemoteProfileStatuses()).rejects.toEqual(
      expect.objectContaining({
        code: "REQUEST_INVALID",
        message: expect.stringContaining("Current Host origin"),
      }),
    );

    expect(snapshotTree(root)).toEqual(before);
    expect(existsSync(legacy.profilePath)).toBe(true);
    expect(existsSync(legacy.credentialPath)).toBe(true);
  });

  it.each(["missing", "malformed", "symlink", "non-regular"] as const)(
    "fails closed on a %s legacy credential",
    async (failure) => {
      const root = tempRoot();
      const legacy = writeLegacyPair(root, "https://caplets.example.com");
      if (failure === "missing") rmSync(legacy.credentialPath);
      if (failure === "malformed")
        writeFileSync(legacy.credentialPath, "not-json", { mode: 0o600 });
      if (failure === "symlink") {
        rmSync(legacy.credentialPath);
        symlinkSync(join(root, "missing-target"), legacy.credentialPath);
      }
      if (failure === "non-regular") {
        rmSync(legacy.credentialPath);
        mkdirSync(legacy.credentialPath);
      }

      await expect(
        new FileRemoteProfileStore({ root }).listRemoteProfileStatuses(),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
      expect(existsSync(legacy.profilePath)).toBe(true);
      expect(existsSync(profilePath(root, "remote:https://caplets.example.com"))).toBe(false);
    },
  );
  it.each(["missing", "malformed", "symlink", "non-regular"] as const)(
    "fails closed on a %s legacy profile",
    async (failure) => {
      const root = tempRoot();
      const legacy = writeLegacyPair(root, "https://caplets.example.com");
      if (failure === "missing") rmSync(legacy.profilePath);
      if (failure === "malformed") writeFileSync(legacy.profilePath, "not-json", { mode: 0o600 });
      if (failure === "symlink") {
        rmSync(legacy.profilePath);
        symlinkSync(join(root, "missing-target"), legacy.profilePath);
      }
      if (failure === "non-regular") {
        rmSync(legacy.profilePath);
        mkdirSync(legacy.profilePath);
      }

      await expect(
        new FileRemoteProfileStore({ root }).listRemoteProfileStatuses(),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
      expect(existsSync(legacy.credentialPath)).toBe(true);
      expect(existsSync(profilePath(root, "remote:https://caplets.example.com"))).toBe(false);
    },
  );

  it("fails closed on a conflicting generic destination", async () => {
    const root = tempRoot();
    const legacy = writeLegacyPair(root, "https://caplets.example.com");
    const key = "remote:https://caplets.example.com";
    writeFileSync(
      profilePath(root, key),
      `${JSON.stringify({
        version: 2,
        key,
        origin: "https://caplets.example.com",
        clientId: "different_client",
        createdAt: "2026-06-18T08:00:00.000Z",
        updatedAt: "2026-06-18T09:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(credentialPath(root, key), '{"accessToken":"different_access"}\n', {
      mode: 0o600,
    });
    const before = snapshotTree(root);

    await expect(new FileRemoteProfileStore({ root }).listRemoteProfileStatuses()).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );

    expect(snapshotTree(root)).toEqual(before);
    expect(existsSync(legacy.profilePath)).toBe(true);
  });

  it.each(faultPoints)("recovers idempotently after %s", async (faultPoint) => {
    const root = tempRoot();
    const legacy = writeLegacyPair(root, "https://caplets.example.com");
    let injected = false;
    const crashing = new FileRemoteProfileStore({
      root,
      faultInjection: (point) => {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`crash:${point}`);
        }
      },
    });

    await expect(crashing.listRemoteProfileStatuses()).rejects.toThrow(`crash:${faultPoint}`);
    const recovered = await new FileRemoteProfileStore({ root }).listRemoteProfileStatuses();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      key: "remote:https://caplets.example.com",
      clientId: "rcli_legacy",
      authenticated: true,
    });
    expect(readFileSync(credentialPath(root, recovered[0]!.key))).toEqual(
      Buffer.from(defaultRawCredential),
    );
    expect(existsSync(legacy.profilePath)).toBe(false);
    expect(existsSync(legacy.credentialPath)).toBe(false);
  });

  it("does not resurrect a migrated legacy pair after logout", async () => {
    const root = tempRoot();
    const legacy = writeLegacyPair(root, "https://caplets.example.com");
    const store = new FileRemoteProfileStore({ root });
    await store.listRemoteProfileStatuses();
    writeLegacyPair(root, "https://caplets.example.com");

    await expect(
      store.logoutRemoteProfile({ origin: "https://caplets.example.com" }),
    ).resolves.toBe(true);
    await expect(
      new FileRemoteProfileStore({ root }).getRemoteProfileStatus({
        origin: "https://caplets.example.com",
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(legacy.profilePath)).toBe(false);
    expect(existsSync(legacy.credentialPath)).toBe(false);
  });
});

describe("Remote Profile lock leases", () => {
  it("does not reclaim an expired lease owned by a live process", async () => {
    const root = tempRoot();
    const lockPath = join(root, "remote-profiles.lock");
    writeLockOwner(lockPath, {
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      leaseExpiresAt: Date.now() - 10_000,
    });
    const store = new FileRemoteProfileStore({
      root,
      lease: { acquireTimeoutMs: 40, durationMs: 20, renewIntervalMs: 5 },
    });

    await expect(
      store.saveRemoteProfile({
        origin: "https://caplets.example.com",
        clientId: "rcli_123",
        credentials: credential,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "SERVER_UNAVAILABLE" }) as CapletsError);
    expect(readJson(join(lockPath, "owner.json"))).toMatchObject({ token: "live-owner" });
  });

  it("reclaims only an expired lease whose owner is proven dead", async () => {
    const root = tempRoot();
    const lockPath = join(root, "remote-profiles.lock");
    writeLockOwner(lockPath, {
      token: "dead-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      leaseExpiresAt: Date.now() - 10_000,
    });

    await expect(
      new FileRemoteProfileStore({ root, lease: testLease() }).saveRemoteProfile({
        origin: "https://caplets.example.com",
        clientId: "rcli_123",
        credentials: credential,
      }),
    ).resolves.toMatchObject({ authenticated: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("renews a refresh lease while work exceeds the lease duration", async () => {
    const root = tempRoot();
    const store = new FileRemoteProfileStore({ root, lease: testLease() });
    await store.saveRemoteProfile({
      origin: "https://caplets.example.com",
      clientId: "rcli_123",
      credentials: { ...credential, accessToken: "old" },
    });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.useFakeTimers();
    try {
      const pending = store.refreshRemoteProfileIfNeeded({
        origin: "https://caplets.example.com",
        needsRefresh: (candidate) => candidate.accessToken === "old",
        refresh: async () => {
          started.resolve();
          await resume.promise;
          return {
            origin: "https://caplets.example.com",
            clientId: "rcli_123",
            credentials: { ...credential, accessToken: "new" },
          };
        },
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(100);
      const key = remoteProfileKey({ origin: "https://caplets.example.com" });
      const owner = readJsonRecord(
        join(root, "remote-profile-refresh-locks", `${encodeURIComponent(key)}.lock`, "owner.json"),
      );
      expect(owner).toMatchObject({ leaseExpiresAt: expect.any(Number) });
      expect(owner.leaseExpiresAt).toBeGreaterThan(Date.now());
      resume.resolve();
      await expect(pending).resolves.toMatchObject({ credential: { accessToken: "new" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release or commit after its owner token is replaced", async () => {
    const root = tempRoot();
    const store = new FileRemoteProfileStore({ root, lease: testLease() });
    await store.saveRemoteProfile({
      origin: "https://caplets.example.com",
      clientId: "rcli_123",
      credentials: { ...credential, accessToken: "old" },
    });
    const key = remoteProfileKey({ origin: "https://caplets.example.com" });
    const lockPath = join(root, "remote-profile-refresh-locks", `${encodeURIComponent(key)}.lock`);
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const paused = store.refreshRemoteProfileIfNeeded({
      origin: "https://caplets.example.com",
      needsRefresh: () => true,
      refresh: async () => {
        started.resolve();
        await resume.promise;
        return {
          origin: "https://caplets.example.com",
          clientId: "rcli_123",
          credentials: { ...credential, accessToken: "new" },
        };
      },
    });
    await started.promise;
    const owner = readJsonRecord(join(lockPath, "owner.json"));
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ ...owner, token: "replacement-owner" }),
      { mode: 0o600 },
    );
    resume.resolve();

    await expect(paused).rejects.toThrow(
      expect.objectContaining({ code: "SERVER_UNAVAILABLE" }) as CapletsError,
    );
    expect(readJson(join(lockPath, "owner.json"))).toMatchObject({ token: "replacement-owner" });
    expect(readJson(credentialPath(root, key))).toMatchObject({ accessToken: "old" });
  });
});

describe("legacy Cloud state quarantine", () => {
  it("ignores Cloud auth root selection and leaves Cloud files untouched", async () => {
    const authDir = tempDir("caplets-generic-auth-");
    const root = join(authDir, "remote-profiles");
    const externalCloudPath = join(tempDir("caplets-cloud-auth-"), "cloud-auth.json");
    writeFileSync(externalCloudPath, "cloud-auth-secret", { mode: 0o600 });
    mkdirSync(join(root, "profiles"), { recursive: true });
    mkdirSync(join(root, "credentials"), { recursive: true });
    mkdirSync(join(root, "selections"), { recursive: true });
    const cloudPaths = [
      join(root, "profiles", `${encodeURIComponent("cloud:https://cloud.caplets.dev/:team")}.json`),
      join(
        root,
        "credentials",
        `${encodeURIComponent("cloud:https://cloud.caplets.dev/:team")}.json`,
      ),
      join(
        root,
        "selections",
        `${encodeURIComponent("cloud:https://cloud.caplets.dev/:selected-workspace")}.json`,
      ),
    ];
    writeFileSync(cloudPaths[0]!, "not-json-cloud-profile", { mode: 0o600 });
    writeFileSync(cloudPaths[1]!, "cloud-credential-secret", { mode: 0o600 });
    symlinkSync(join(root, "missing-cloud-selection"), cloudPaths[2]!);
    const before = cloudPaths.map(snapshotPath);
    for (const path of [...cloudPaths, externalCloudPath]) filesystemTrap.forbidden.add(path);
    filesystemTrap.accesses.length = 0;

    const env = { CAPLETS_CLOUD_AUTH_PATH: externalCloudPath };
    const derived = createRemoteProfileStore({ env });
    expect(derived.root).not.toBe(join(tempDirs[1]!, "remote-profiles"));
    const store = createRemoteProfileStore({ authDir, env });
    await store.saveRemoteProfile({
      origin: "https://cloud.caplets.dev",
      clientId: "rcli_generic",
      credentials: credential,
    });
    await store.getRemoteProfileStatus({ origin: "https://cloud.caplets.dev" });
    await store.listRemoteProfileStatuses();
    await store.refreshRemoteProfileIfNeeded({
      origin: "https://cloud.caplets.dev",
      needsRefresh: () => false,
      refresh: async () => {
        throw new Error("must not refresh");
      },
    });
    await store.logoutRemoteProfile({ origin: "https://cloud.caplets.dev" });
    filesystemTrap.forbidden.clear();
    expect(filesystemTrap.accesses).toEqual([]);

    expect(cloudPaths.map(snapshotPath)).toEqual(before);
    expect(readFileSync(externalCloudPath, "utf8")).toBe("cloud-auth-secret");
  });
});

describe("Remote Profile helpers", () => {
  it("derives generic canonical keys and redacted status", () => {
    expect(remoteProfileKey({ origin: "https://CAPLETS.Example.COM:443/" })).toBe(
      "remote:https://caplets.example.com",
    );
    const status = remoteProfileStatus({
      origin: "https://caplets.example.com",
      clientId: "rcli_123",
      credential,
    });
    expect(status).toMatchObject({
      authenticated: true,
      key: "remote:https://caplets.example.com",
      origin: "https://caplets.example.com",
    });
    expect(JSON.stringify(status)).not.toMatch(
      /access_secret|refresh_secret|client_secret|pairing_code/u,
    );
  });

  it("does not report partial credentials as authenticated", () => {
    expect(
      remoteProfileStatus({
        origin: "https://caplets.example.com",
        clientId: "rcli_123",
        credential: { refreshToken: "refresh_secret" },
      }),
    ).toMatchObject({ authenticated: false });
  });
});

const defaultRawCredential = `${JSON.stringify(credential, null, 2)}\n`;

function writeLegacyPair(
  root: string,
  hostUrl: string,
  options: {
    rawCredential?: string;
    hostIdentity?: string;
    clientId?: string;
    clientLabel?: string;
    createdAt?: string;
    updatedAt?: string;
  } = {},
): { key: string; profilePath: string; credentialPath: string } {
  const key = `self-hosted:${hostUrl}`;
  const paths = {
    key,
    profilePath: profilePath(root, key),
    credentialPath: credentialPath(root, key),
  };
  mkdirSync(join(root, "profiles"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "credentials"), { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.profilePath,
    `${JSON.stringify(
      {
        version: 1,
        kind: "self-hosted",
        key,
        hostUrl,
        ...(options.hostIdentity ? { hostIdentity: options.hostIdentity } : {}),
        clientId: options.clientId ?? "rcli_legacy",
        ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
        createdAt: options.createdAt ?? "2026-06-18T08:00:00.000Z",
        updatedAt: options.updatedAt ?? "2026-06-18T09:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(paths.credentialPath, options.rawCredential ?? defaultRawCredential, {
    mode: 0o600,
  });
  return paths;
}

function writeLockOwner(
  path: string,
  owner: { token: string; pid: number; hostname: string; leaseExpiresAt: number },
): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({ version: 1, acquiredAt: Date.now() - 20_000, ...owner }),
    { mode: 0o600 },
  );
}

function testLease(): { acquireTimeoutMs: number; durationMs: number; renewIntervalMs: number } {
  return { acquireTimeoutMs: 1_000, durationMs: 30, renewIntervalMs: 5 };
}

function profilePath(root: string, key: string): string {
  return join(root, "profiles", `${encodeURIComponent(key)}.json`);
}

function credentialPath(root: string, key: string): string {
  return join(root, "credentials", `${encodeURIComponent(key)}.json`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(path: string): Record<string, unknown> {
  const value = readJson(path);
  if (!isJsonRecord(value)) {
    throw new Error(`Expected an object in ${path}`);
  }
  return value;
}

function snapshotTree(root: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  for (const directory of ["profiles", "credentials", "selections"]) {
    const path = join(root, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      if (lstatSync(entry).isFile()) result[`${directory}/${name}`] = readFileSync(entry);
    }
  }
  return result;
}

function snapshotPath(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isSymbolicLink()
    ? { mode: stat.mode, mtimeMs: stat.mtimeMs, target: readlinkSync(path) }
    : { mode: stat.mode, mtimeMs: stat.mtimeMs, bytes: readFileSync(path) };
}

function tempRoot(): string {
  return tempDir("caplets-remote-profiles-");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
