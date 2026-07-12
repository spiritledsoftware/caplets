import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { genericOAuthHeaders } from "../src/auth";
import {
  AuthorityOAuthTokenStore,
  FileOAuthTokenStore,
  type StoredOAuthTokenBundle,
} from "../src/auth/store";
import { FilesystemAuthority } from "../src/storage/filesystem-authority";
import type {
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  WritableAuthority,
} from "../src/storage/types";
import { AuthorityVaultStore, type VaultConfigOrigin } from "../src/vault";

const origin: VaultConfigOrigin = {
  kind: "global-file",
  path: "/staged/mount/CAPLET.md",
  identity: "sha256:staged-caplet",
};

function key(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64url");
}
type Snapshot = Record<string, unknown>;

function identityFromHead(head: AuthorityHead | null): AuthorityGenerationIdentity | null {
  return head
    ? {
        authorityId: head.authorityId,
        id: head.id,
        sequence: head.sequence,
        predecessorId: head.predecessorId,
      }
    : null;
}

function interleaveAfterGenerationRead(
  authority: WritableAuthority<unknown, unknown>,
  onRead: () => Promise<void>,
): WritableAuthority<unknown, unknown> {
  let interleaved = false;
  return new Proxy(authority, {
    get(target, property) {
      if (property === "readGeneration") {
        return async (id: string): Promise<AuthorityGeneration<unknown>> => {
          const generation = await target.readGeneration(id);
          if (!interleaved) {
            interleaved = true;
            await onRead();
          }
          return generation;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function commitSnapshot(
  authority: WritableAuthority<unknown, unknown>,
  snapshot: Snapshot,
  idempotencyKey: string,
): Promise<void> {
  const head = await authority.readHead();
  const result = await authority.commit({
    authorityId: head?.authorityId ?? "authority-a",
    currentHostId: "test-host",
    principalId: "test",
    expectedGeneration: identityFromHead(head),
    idempotencyKey,
    requestDigest: idempotencyKey,
    command: { kind: "replace_snapshot", snapshot },
  });
  expect(result.kind).toBe("committed");
}

async function authority(root: string, authorityId = "authority-a") {
  const value = new FilesystemAuthority({ root, authorityId });
  await value.initialize();
  return value;
}

describe("authority-backed secret domain codecs", () => {
  it("rejects missing or rotating Vault keys before shared persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-vault-key-"));
    try {
      const writable = await authority(root);
      expect(
        () =>
          new AuthorityVaultStore({
            authority: writable,
            authorityId: writable.authorityId,
            key: undefined as never,
          }),
      ).toThrow(/Shared Vault encryption key.*automatic key generation is disabled/i);
      const store = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(1),
      });
      await store.set("TOKEN", "vault-secret");
      expect(
        () =>
          new AuthorityVaultStore({
            authority: writable,
            authorityId: writable.authorityId,
            key: key(2),
          }),
      ).not.toThrow();
      await expect(
        new AuthorityVaultStore({
          authority: writable,
          authorityId: writable.authorityId,
          key: key(2),
        }).getStatus("TOKEN"),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores encrypted Vault records, stable grants, and one authorized reveal", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-vault-"));
    try {
      const writable = await authority(root);
      const store = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(3),
      });
      await store.set("TOKEN", "vault-secret");
      await store.grantAccess({
        storedKey: "TOKEN",
        referenceName: "TOKEN",
        capletId: "github",
        origin,
      });
      const result = await store.resolveGrantedValue({
        referenceName: "TOKEN",
        capletId: "github",
        origin: { ...origin, path: "/different/mount/CAPLET.md" },
      });
      expect(result).toEqual({ storedKey: "TOKEN", value: "vault-secret" });
      expect(await store.listValues()).toEqual([expect.objectContaining({ key: "TOKEN" })]);
      const exported = await writable.exportState();
      const raw = JSON.stringify(exported);
      expect(raw).not.toContain("vault-secret");
      expect(raw).not.toContain(key(3));
      expect(JSON.stringify(await store.listValues())).not.toContain("vault-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically sets a value and stable grant with one CAS generation and replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-vault-atomic-"));
    try {
      const writable = await authority(root);
      const calls: string[] = [];
      const store = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        currentHostId: "host-a",
        key: key(6),
        authorize: ({ operation }) => {
          calls.push(operation);
        },
      });
      expect(await writable.readHead()).toBeNull();
      const result = await store.setWithGrant("TOKEN", "atomic-secret", {
        idempotencyKey: "set-grant-1",
        grant: {
          storedKey: "TOKEN",
          referenceName: "TOKEN",
          capletId: "github",
          origin: {
            kind: "authority",
            authorityId: writable.authorityId,
            recordId: "github",
            generationId: "pending",
          },
        },
      });
      const head = await writable.readHead();
      expect(head?.sequence).toBe(1);
      expect(result).toEqual({
        status: expect.objectContaining({ key: "TOKEN", present: true }),
        grant: expect.objectContaining({ storedKey: "TOKEN", capletId: "github" }),
      });
      expect(calls).toEqual(["write", "grant"]);
      const replica = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        currentHostId: "host-b",
        key: key(6),
      });
      await expect(replica.listValues()).resolves.toEqual([
        expect.objectContaining({ key: "TOKEN", present: true }),
      ]);
      await expect(replica.listAccess()).resolves.toEqual([
        expect.objectContaining({ storedKey: "TOKEN", capletId: "github" }),
      ]);
      const replay = await store.setWithGrant("TOKEN", "atomic-secret", {
        idempotencyKey: "set-grant-1",
        force: true,
        grant: {
          storedKey: "TOKEN",
          referenceName: "TOKEN",
          capletId: "github",
          origin: {
            kind: "authority",
            authorityId: writable.authorityId,
            recordId: "github",
            generationId: "rotated",
          },
        },
      });
      expect(replay.replayed).toBe(true);
      expect((await writable.readHead())?.id).toBe(head?.id);
      await expect(
        replica.setWithGrant("OTHER", "stale-secret", {
          expectedGeneration: null,
          idempotencyKey: "stale-1",
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect((await writable.readHead())?.id).toBe(head?.id);
      const raw = JSON.stringify(await writable.exportState());
      expect(raw).not.toContain("atomic-secret");
      expect(raw).not.toContain("stale-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conflicts a stale Vault snapshot instead of replacing concurrent state", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-vault-cas-"));
    try {
      const writable = await authority(root);
      const seedStore = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(8),
      });
      await seedStore.set("TOKEN", "initial-secret");
      const interleavedAuthority = interleaveAfterGenerationRead(
        writable as unknown as WritableAuthority<unknown, unknown>,
        async () => {
          const head = await writable.readHead();
          if (!head) throw new Error("expected seeded Vault authority head");
          const generation = await writable.readGeneration(head.id);
          await commitSnapshot(
            writable as unknown as WritableAuthority<unknown, unknown>,
            { ...(generation.snapshot as Snapshot), concurrent: { keep: true } },
            "vault-concurrent",
          );
        },
      );
      const staleStore = new AuthorityVaultStore({
        authority: interleavedAuthority as never,
        authorityId: writable.authorityId,
        key: key(8),
      });

      await expect(staleStore.set("OTHER", "stale-secret")).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });

      const head = await writable.readHead();
      if (!head) throw new Error("expected concurrent Vault authority head");
      const current = await writable.readGeneration(head.id);
      expect(current.snapshot).toMatchObject({
        vault: expect.any(Object),
        concurrent: { keep: true },
      });
      expect(await seedStore.getStatus("OTHER")).toEqual({ key: "OTHER", present: false });
      expect(await seedStore.getStatus("TOKEN")).toMatchObject({ key: "TOKEN", present: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unstable shared grant origins before authority reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-vault-origin-"));
    try {
      const writable = await authority(root);
      const store = new AuthorityVaultStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(7),
      });
      await expect(
        store.setWithGrant("TOKEN", "origin-secret", {
          grant: {
            storedKey: "TOKEN",
            referenceName: "TOKEN",
            capletId: "github",
            origin: { kind: "global-file", path: "/unstable/CAPLET.md" },
          },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(await writable.readHead()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips OAuth bundles through the file adapter and encrypts authority records", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-oauth-"));
    try {
      const writable = await authority(root);
      const authorityStore = new AuthorityOAuthTokenStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(4),
      });
      const bundle: StoredOAuthTokenBundle = {
        server: "drive",
        authType: "oidc",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        clientId: "client-id",
        clientSecret: "client-secret",
      };
      await authorityStore.write(bundle);
      expect(await authorityStore.read("drive")).toEqual(bundle);
      const raw = JSON.stringify(await writable.exportState());
      expect(raw).not.toContain("access-secret");
      expect(raw).not.toContain("refresh-secret");
      expect(raw).not.toContain("client-secret");

      const fileDir = join(root, "file");
      const fileStore = new FileOAuthTokenStore(fileDir);
      await fileStore.write(bundle);
      expect(await fileStore.read("drive")).toEqual(bundle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conflicts a stale OAuth snapshot instead of replacing concurrent state", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-oauth-cas-"));
    try {
      const writable = await authority(root);
      const seedStore = new AuthorityOAuthTokenStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(9),
      });
      await seedStore.write({
        server: "drive",
        accessToken: "initial-access-secret",
      });
      const interleavedAuthority = interleaveAfterGenerationRead(
        writable as unknown as WritableAuthority<unknown, unknown>,
        async () => {
          const head = await writable.readHead();
          if (!head) throw new Error("expected seeded OAuth authority head");
          const generation = await writable.readGeneration(head.id);
          await commitSnapshot(
            writable as unknown as WritableAuthority<unknown, unknown>,
            { ...(generation.snapshot as Snapshot), concurrent: { keep: true } },
            "oauth-concurrent",
          );
        },
      );
      const staleStore = new AuthorityOAuthTokenStore({
        authority: interleavedAuthority as never,
        authorityId: writable.authorityId,
        key: key(9),
      });

      await expect(
        staleStore.write({ server: "users", accessToken: "stale-access-secret" }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      const head = await writable.readHead();
      if (!head) throw new Error("expected concurrent OAuth authority head");
      const current = await writable.readGeneration(head.id);
      expect(current.snapshot).toMatchObject({ concurrent: { keep: true } });
      expect(await seedStore.read("drive")).toMatchObject({
        server: "drive",
        accessToken: "initial-access-secret",
      });
      expect(await seedStore.read("users")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves and rotates an authority OAuth bundle at request time", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-oauth-refresh-"));
    const requests: string[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(body);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "rotated-access-secret",
            refresh_token: "rotated-refresh-secret",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const writable = await authority(root);
      const tokenStore = new AuthorityOAuthTokenStore({
        authority: writable,
        authorityId: writable.authorityId,
        key: key(5),
      });
      await tokenStore.write({
        server: "users",
        authType: "oauth2",
        accessToken: "expired-access-secret",
        refreshToken: "old-refresh-secret",
        expiresAt: "2000-01-01T00:00:00.000Z",
        clientId: "client",
        protectedResourceOrigin: baseUrl,
      });
      await expect(
        genericOAuthHeaders(
          {
            server: "users",
            backend: "http",
            baseUrl,
            auth: { type: "oauth2", clientId: "client", tokenUrl: `${baseUrl}/token` },
          },
          undefined,
          { tokenStore },
        ),
      ).resolves.toEqual({ authorization: "Bearer rotated-access-secret" });
      expect(requests[0]).toContain("old-refresh-secret");
      expect((await tokenStore.read("users"))?.refreshToken).toBe("rotated-refresh-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
