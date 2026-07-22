import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminBundleUploadAdmissionController } from "../src/admin-api/bundle-upload-admission";
import {
  DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES,
  DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
} from "../src/admin-api/bundle-contract";
import { parseAdminBundleUpload } from "../src/admin-api/bundle-upload-parser";
import { createRemoteAdminCommandAdapter } from "../src/remote-cli/admin";

const baseUrl = new URL("https://host.example");
const temporaryDirectories: string[] = [];
function vaultGrantFixture(referenceName: string, capletId = "github") {
  return {
    storedKey: "API_TOKEN",
    capletId,
    referenceName,
    origin: { kind: "operator" },
    resourceVersion: `version-${referenceName}`,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function installationFixture(status: "active" | "detached", generation: number) {
  return {
    installationKey: "install-1",
    capletId: "github",
    recordKey: "record-1",
    generation,
    status,
    sourceKind: "catalog",
    sourceIdentity: "github",
    channel: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    detachedAt: status === "detached" ? "2026-07-21T00:00:00.000Z" : null,
    detachedBy: status === "detached" ? "operator" : null,
  };
}

function remoteVaultGrantFixture(referenceName: string, capletId = "github") {
  const { resourceVersion: _resourceVersion, ...grant } = vaultGrantFixture(
    referenceName,
    capletId,
  );
  return grant;
}

function notFoundProblem(detail: string) {
  return Response.json(
    {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail,
      code: "SERVER_NOT_FOUND",
    },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

function idempotencyProblem(code: string, retryAfter?: string) {
  return Response.json(
    {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "The idempotent operation is not finalized.",
      code,
    },
    {
      status: 409,
      headers: {
        "content-type": "application/problem+json",
        ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote CLI public SDK Admin adapter", () => {
  it("uses the caller base URL, paired Operator bearer, and one idempotency key across retry", async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await request.clone().json(),
      });
      if (requests.length === 1) {
        throw new TypeError("socket reset");
      }
      return Response.json(
        { installed: [{ id: "github", destination: "sql", status: "installed" }] },
        { status: 201 },
      );
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "intent-fixed",
    });

    await expect(
      client.request("install", { repo: "owner/repo", capletIds: ["github"], force: false }),
    ).resolves.toEqual({
      remote: true,
      installed: [{ id: "github", destination: "sql", status: "installed" }],
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("https://host.example/api/v2/admin/catalog/installations");
      expect(request.headers.get("authorization")).toBe("Bearer paired-operator-token");
      expect(request.headers.get("idempotency-key")).toBe("intent-fixed");
      expect(request.body).toEqual({ repo: "owner/repo", capletIds: ["github"], force: false });
    }
  });

  it("recovers a lost mutation response through in-progress replay with the same key", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (requests.length === 1) throw new TypeError("socket reset");
      if (requests.length === 2) return idempotencyProblem("IDEMPOTENCY_IN_PROGRESS", "0");
      return Response.json(
        { installed: [{ id: "github", destination: "sql", status: "installed" }] },
        { status: 201 },
      );
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "recover-intent",
    });

    await expect(client.request("install", { capletIds: ["github"] })).resolves.toMatchObject({
      remote: true,
      installed: [{ id: "github" }],
    });
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "recover-intent",
      "recover-intent",
      "recover-intent",
    ]);
  });

  it("bounds perpetual idempotency in-progress recovery", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      idempotencyProblem("IDEMPOTENCY_IN_PROGRESS", "0"),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "perpetual-intent",
    });

    await expect(client.request("install", { capletIds: ["github"] })).rejects.toMatchObject({
      code: "IDEMPOTENCY_IN_PROGRESS",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry idempotency in-progress with invalid Retry-After", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      idempotencyProblem("IDEMPOTENCY_IN_PROGRESS", "not-a-delay"),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("install", { capletIds: ["github"] })).rejects.toMatchObject({
      code: "IDEMPOTENCY_IN_PROGRESS",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ordinary idempotency conflict", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      idempotencyProblem("IDEMPOTENCY_CONFLICT", "0"),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("install", { capletIds: ["github"] })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps SDK clients isolated by endpoint, Fetch adapter, and bearer token", async () => {
    const firstRequests: Request[] = [];
    const secondRequests: Request[] = [];
    const firstFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      firstRequests.push(input instanceof Request ? input : new Request(input, init));
      return Response.json({ items: [{ server: "github" }], nextCursor: null });
    });
    const secondFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      secondRequests.push(input instanceof Request ? input : new Request(input, init));
      return Response.json({ items: [{ server: "linear" }], nextCursor: null });
    });
    const firstClient = createRemoteAdminCommandAdapter({
      baseUrl: new URL("https://first.example"),
      bearerToken: "first-operator-token",
      fetch: firstFetch,
    });
    const secondClient = createRemoteAdminCommandAdapter({
      baseUrl: new URL("https://second.example"),
      bearerToken: "second-operator-token",
      fetch: secondFetch,
    });

    await expect(
      Promise.all([firstClient.request("auth_list", {}), secondClient.request("auth_list", {})]),
    ).resolves.toEqual([[{ server: "github" }], [{ server: "linear" }]]);
    expect(firstRequests).toHaveLength(1);
    expect(secondRequests).toHaveLength(1);
    expect(firstRequests[0]?.url).toBe(
      "https://first.example/api/v2/admin/backend-auth-connections",
    );
    expect(secondRequests[0]?.url).toBe(
      "https://second.example/api/v2/admin/backend-auth-connections",
    );
    expect(firstRequests[0]?.headers.get("authorization")).toBe("Bearer first-operator-token");
    expect(secondRequests[0]?.headers.get("authorization")).toBe("Bearer second-operator-token");
  });

  it("auto-pages only complete-list commands through opaque nextCursor values", async () => {
    const requests: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.href);
      if (!url.searchParams.has("cursor")) {
        return Response.json({ items: [{ server: "github" }], nextCursor: "opaque:next/+=" });
      }
      expect(url.searchParams.get("cursor")).toBe("opaque:next/+=");
      return Response.json({ items: [{ server: "linear" }], nextCursor: null });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("auth_list", {})).resolves.toEqual([
      { server: "github" },
      { server: "linear" },
    ]);
    expect(requests).toHaveLength(2);
  });

  it("rejects a repeated nonempty cursor instead of requesting pages forever", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [{ server: "github" }], nextCursor: "repeated-cursor" }),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("auth_list", {})).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects endless distinct cursors at the finite page cap", async () => {
    let page = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [{ server: `server-${page}` }], nextCursor: `cursor-${page++}` }),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("auth_list", {})).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
    expect(fetch).toHaveBeenCalledTimes(100);
  });

  it("rejects accumulated page items above the finite item cap", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        items: Array.from({ length: 10_001 }, (_, index) => ({ server: `server-${index}` })),
      }),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("auth_list", {})).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("force-sets a missing Vault key with a create-only precondition", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json(
          {
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: "Vault value not found.",
            code: "SERVER_NOT_FOUND",
          },
          { status: 404, headers: { "content-type": "application/problem+json" } },
        );
      }
      return Response.json(
        {
          key: "API_TOKEN",
          present: true,
          generation: 1,
          valueBytes: 6,
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
        { status: 201 },
      );
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-force-create",
    });

    await expect(
      client.request("vault_set", { name: "API_TOKEN", value: "secret", force: true }),
    ).resolves.toMatchObject({ remote: true, key: "API_TOKEN", present: true });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.headers.get("if-none-match")).toBe("*");
    expect(requests[1]?.headers.get("if-match")).toBeNull();
    expect(requests[1]?.headers.get("idempotency-key")).toBe("vault-force-create");
  });

  it("force-sets an existing Vault key with its strong detail ETag", async () => {
    const requests: Request[] = [];
    const vaultValue = {
      key: "API_TOKEN",
      present: true as const,
      generation: 2,
      valueBytes: 6,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json(vaultValue, { headers: { ETag: '"vault-existing"' } });
      }
      return Response.json(vaultValue);
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-force-update",
    });

    await expect(
      client.request("vault_set", { name: "API_TOKEN", value: "secret", force: true }),
    ).resolves.toMatchObject({ remote: true, key: "API_TOKEN", present: true });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.headers.get("if-match")).toBe('"vault-existing"');
    expect(requests[1]?.headers.get("if-none-match")).toBeNull();
    expect(requests[1]?.headers.get("idempotency-key")).toBe("vault-force-update");
  });

  it("atomically force-upserts an existing Vault grant with its opaque detail ETag", async () => {
    const requests: Request[] = [];
    const vaultValue = {
      key: "API_TOKEN",
      present: true as const,
      generation: 2,
      valueBytes: 6,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "PUT") return Response.json(vaultValue);
      if (request.url.includes("/grants/demo/token")) {
        return Response.json(vaultGrantFixture("token"), {
          headers: { ETag: '"grant-current"' },
        });
      }
      return Response.json(vaultValue, { headers: { ETag: '"vault-existing"' } });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-force-grant-update",
    });

    await expect(
      client.request("vault_set", {
        name: "API_TOKEN",
        value: "secret",
        force: true,
        grant: "demo",
        referenceName: "token",
      }),
    ).resolves.toMatchObject({ remote: true, key: "API_TOKEN", present: true });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(requests[1]?.url).toContain("/vault-values/API_TOKEN/grants/demo/token");
    expect(requests[2]?.headers.get("if-match")).toBe('"vault-existing"');
    expect(requests[2]?.headers.get("x-caplets-grant-if-match")).toBe('"grant-current"');
  });

  it("atomically creates an absent Vault grant without a secondary condition", async () => {
    const requests: Request[] = [];
    const vaultValue = {
      key: "API_TOKEN",
      present: true as const,
      generation: 2,
      valueBytes: 6,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "PUT") return Response.json(vaultValue);
      if (request.url.includes("/grants/demo/token")) {
        return Response.json(
          {
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: "Vault grant not found.",
            code: "SERVER_NOT_FOUND",
          },
          { status: 404, headers: { "content-type": "application/problem+json" } },
        );
      }
      return Response.json(vaultValue, { headers: { ETag: '"vault-existing"' } });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-force-grant-create",
    });

    await expect(
      client.request("vault_set", {
        name: "API_TOKEN",
        value: "secret",
        force: true,
        grant: "demo",
        referenceName: "token",
      }),
    ).resolves.toMatchObject({ remote: true, key: "API_TOKEN", present: true });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(requests[2]?.headers.get("x-caplets-grant-if-match")).toBeNull();
  });

  it("creates a missing Vault grant with a create-only precondition", async () => {
    const requests: Request[] = [];
    const grant = vaultGrantFixture("token");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") return notFoundProblem("Vault grant not found.");
      return Response.json(grant, { status: 201 });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-grant-create",
    });

    await expect(
      client.request("vault_access_grant", {
        name: "API_TOKEN",
        capletId: "github",
        referenceName: "token",
      }),
    ).resolves.toMatchObject({ storedKey: "API_TOKEN", referenceName: "token" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.headers.get("if-none-match")).toBe("*");
    expect(requests[1]?.headers.get("if-match")).toBeNull();
  });

  it("replaces an existing Vault grant with its opaque detail ETag", async () => {
    const requests: Request[] = [];
    const grant = vaultGrantFixture("token");
    const opaqueEtag = '"opaque/grant-etag:not-reconstructed"';
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json(grant, { headers: { ETag: opaqueEtag } });
      }
      return Response.json(grant);
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-grant-replace",
    });

    await expect(
      client.request("vault_access_grant", {
        name: "API_TOKEN",
        capletId: "github",
        referenceName: "token",
      }),
    ).resolves.toMatchObject({ storedKey: "API_TOKEN", referenceName: "token" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(requests[1]?.headers.get("if-match")).toBe(opaqueEtag);
    expect(requests[1]?.headers.get("if-none-match")).toBeNull();
  });

  it("reports CONFIG_NOT_FOUND when no matching Vault grant exists", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [vaultGrantFixture("other", "linear")] }),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(
      client.request("vault_access_revoke", {
        name: "API_TOKEN",
        capletId: "github",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("revokes one named Vault grant with its opaque detail ETag", async () => {
    const requests: Request[] = [];
    const grant = vaultGrantFixture("token");
    const opaqueEtag = '"opaque/single-grant"';
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/grants")) return Response.json({ items: [grant] });
      if (request.method === "GET") {
        return Response.json(grant, { headers: { ETag: opaqueEtag } });
      }
      return Response.json({ revoked: [grant] });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-revoke-single",
    });

    await expect(
      client.request("vault_access_revoke", {
        name: "API_TOKEN",
        capletId: "github",
        referenceName: "token",
      }),
    ).resolves.toEqual([remoteVaultGrantFixture("token")]);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
    expect(requests[2]?.headers.get("if-match")).toBe(opaqueEtag);
  });

  it("blanket-revokes every matching Vault grant with distinct deterministic keys", async () => {
    const requests: Request[] = [];
    const token = vaultGrantFixture("token");
    const backup = vaultGrantFixture("backup");
    const unrelated = vaultGrantFixture("linear-token", "linear");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/grants")) {
        return Response.json({
          items: [
            token,
            { ...token, origin: { kind: "global-file", path: "/stale/CAPLET.md" } },
            unrelated,
            backup,
          ],
        });
      }
      const grant = request.url.endsWith("/backup") ? backup : token;
      if (request.method === "GET") {
        return Response.json(grant, {
          headers: { ETag: `"opaque-${grant.referenceName}"` },
        });
      }
      return Response.json({ revoked: [grant] });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "vault-revoke-blanket",
    });

    await expect(
      client.request("vault_access_revoke", {
        name: "API_TOKEN",
        capletId: "github",
      }),
    ).resolves.toEqual([remoteVaultGrantFixture("token"), remoteVaultGrantFixture("backup")]);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE", "GET", "DELETE"]);
    const deletes = requests.filter(({ method }) => method === "DELETE");
    const keys = deletes.map((request) => request.headers.get("idempotency-key"));
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([
      expect.stringMatching(/^vault-revoke:0:/),
      expect.stringMatching(/^vault-revoke:1:/),
    ]);
    expect(deletes.map((request) => request.headers.get("if-match"))).toEqual([
      '"opaque-token"',
      '"opaque-backup"',
    ]);
    await client.request("vault_access_revoke", {
      name: "API_TOKEN",
      capletId: "github",
    });
    const repeatedKeys = requests
      .filter(({ method }) => method === "DELETE")
      .slice(2)
      .map((request) => request.headers.get("idempotency-key"));
    expect(repeatedKeys).toEqual(keys);
  });

  it("returns nonempty persisted installation observations across bounded pages", async () => {
    const requests: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.href);
      if (url.pathname.endsWith("/installations")) {
        return Response.json({
          items: [
            {
              installationKey: "install-1",
              capletId: "github",
              recordKey: "record-1",
              generation: 1,
              status: "active",
              sourceKind: "catalog",
              sourceIdentity: "github",
              channel: null,
              createdAt: "2026-07-20T00:00:00.000Z",
              updatedAt: "2026-07-20T00:00:00.000Z",
              detachedAt: null,
              detachedBy: null,
            },
          ],
        });
      }
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          items: [
            {
              observationKey: "observation-1",
              installationKey: "install-1",
              resolvedRevision: "rev-1",
              contentHash: "hash-1",
              risk: null,
              status: "current",
              observedAt: "2026-07-20T01:00:00.000Z",
            },
          ],
          nextCursor: "observation-next",
        });
      }
      expect(url.searchParams.get("cursor")).toBe("observation-next");
      return Response.json({
        items: [
          {
            observationKey: "observation-2",
            installationKey: "install-1",
            resolvedRevision: null,
            contentHash: null,
            risk: null,
            status: "source-unavailable",
            observedAt: "2026-07-21T01:00:00.000Z",
          },
        ],
      });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(
      client.request("storage_records_installation_status", { id: "github" }),
    ).resolves.toMatchObject({
      installations: [{ installationKey: "install-1" }],
      observations: [
        { observationKey: "observation-1", status: "current" },
        { observationKey: "observation-2", status: "source-unavailable" },
      ],
    });
    expect(requests).toEqual([
      "https://host.example/api/v2/admin/caplet-records/github/installations",
      "https://host.example/api/v2/admin/caplet-records/github/installation-observations",
      "https://host.example/api/v2/admin/caplet-records/github/installation-observations?cursor=observation-next",
    ]);
  });

  it("rejects stale expected generations before every retained storage mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-cli-admin-generation-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "CAPLET.md");
    writeFileSync(sourcePath, "# GitHub\n");
    const files = [{ path: "CAPLET.md", sourcePath, size: 9, executable: false }];
    const cases = [
      { command: "storage_records_update", args: { id: "github", files } },
      {
        command: "storage_records_restore",
        args: { id: "github", revisionKey: "rev-1" },
      },
      {
        command: "storage_records_delete_revision",
        args: { id: "github", revisionKey: "rev-1" },
      },
      { command: "storage_records_retention", args: { id: "github", historyLimit: 4 } },
      { command: "storage_records_rename", args: { id: "github", newId: "github-renamed" } },
      { command: "storage_records_delete", args: { id: "github" } },
      { command: "storage_records_installation_detach", args: { id: "github" } },
      {
        command: "storage_records_installation_observe",
        args: { id: "github", status: "current" },
      },
      {
        command: "storage_records_installation_replace",
        args: {
          id: "github",
          detachedInstallationKey: "install-1",
          sourceKind: "catalog",
          sourceIdentity: "github",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const requests: Request[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/installations")) {
          return Response.json({ items: [installationFixture("active", 2)] });
        }
        if (request.url.includes("/installations/")) {
          return Response.json(installationFixture("active", 2), {
            headers: { ETag: '"installation-current"' },
          });
        }
        return Response.json(
          { record: { id: "github", headGeneration: 2 }, document: "" },
          { headers: { ETag: '"record-current"' } },
        );
      });
      const client = createRemoteAdminCommandAdapter({
        baseUrl,
        bearerToken: "paired-operator-token",
        fetch,
      });

      await expect(
        client.request(testCase.command, { ...testCase.args, expectedGeneration: 1 }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      });
      expect(requests.every(({ method }) => method === "GET")).toBe(true);
    }
  });

  it("uses latest opaque ETags when expectedGeneration is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-cli-admin-latest-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "CAPLET.md");
    writeFileSync(sourcePath, "# GitHub\n");
    const files = [{ path: "CAPLET.md", sourcePath, size: 9, executable: false }];
    const cases = [
      {
        command: "storage_records_update",
        args: { id: "github", files },
        etag: '"record-current"',
      },
      {
        command: "storage_records_restore",
        args: { id: "github", revisionKey: "rev-1" },
        etag: '"record-current"',
      },
      {
        command: "storage_records_delete_revision",
        args: { id: "github", revisionKey: "rev-1" },
        etag: '"revision-current"',
        parentEtag: '"record-current"',
      },
      {
        command: "storage_records_retention",
        args: { id: "github", historyLimit: 4 },
        etag: '"record-current"',
      },
      {
        command: "storage_records_rename",
        args: { id: "github", newId: "github-renamed" },
        etag: '"record-current"',
      },
      { command: "storage_records_delete", args: { id: "github" }, etag: '"record-current"' },
      {
        command: "storage_records_installation_detach",
        args: { id: "github" },
        etag: '"installation-current"',
      },
      {
        command: "storage_records_installation_observe",
        args: { id: "github", status: "current" },
        etag: '"installation-current"',
      },
      {
        command: "storage_records_installation_replace",
        args: {
          id: "github",
          detachedInstallationKey: "install-1",
          sourceKind: "catalog",
          sourceIdentity: "github",
        },
        etag: '"installation-current"',
      },
    ] as const;

    for (const testCase of cases) {
      const requests: Request[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        if (request.method !== "GET") {
          return Response.json({ deleted: true, id: "github" });
        }
        if (request.url.endsWith("/installations")) {
          return Response.json({ items: [installationFixture("active", 2)] });
        }
        if (request.url.includes("/installations/")) {
          return Response.json(installationFixture("active", 2), {
            headers: { ETag: '"installation-current"' },
          });
        }
        if (request.url.includes("/revisions/")) {
          return Response.json(
            { revisionKey: "rev-1" },
            { headers: { ETag: '"revision-current"' } },
          );
        }
        return Response.json(
          { record: { id: "github", headGeneration: 2 }, document: "" },
          { headers: { ETag: '"record-current"' } },
        );
      });
      const client = createRemoteAdminCommandAdapter({
        baseUrl,
        bearerToken: "paired-operator-token",
        fetch,
      });

      await expect(client.request(testCase.command, testCase.args)).resolves.toBeDefined();
      const mutation = requests.find(({ method }) => method !== "GET");
      expect(mutation?.headers.get("if-match")).toBe(testCase.etag);
      expect(mutation?.headers.get("x-caplets-parent-if-match")).toBe(
        "parentEtag" in testCase ? testCase.parentEtag : null,
      );
    }
  });

  it("forwards opaque parent and revision ETags for atomic revision delete CAS", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.url.includes("/revisions/") && request.method === "GET") {
        return Response.json(
          { revisionKey: "rev-1" },
          { headers: { ETag: '"opaque-revision-etag"' } },
        );
      }
      if (request.method === "GET") {
        return Response.json(
          { record: { id: "github", headGeneration: 2 }, document: "" },
          { headers: { ETag: '"opaque-parent-etag"' } },
        );
      }
      return Response.json(
        {
          type: "about:blank",
          title: "Precondition Failed",
          status: 412,
          detail: "The parent record changed.",
          code: "PRECONDITION_FAILED",
        },
        { status: 412, headers: { "content-type": "application/problem+json" } },
      );
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(
      client.request("storage_records_delete_revision", {
        id: "github",
        revisionKey: "rev-1",
        expectedGeneration: 2,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
    expect(requests[2]?.headers.get("if-match")).toBe('"opaque-revision-etag"');
    expect(requests[2]?.headers.get("x-caplets-parent-if-match")).toBe('"opaque-parent-etag"');
  });

  it("preserves installation metadata in streamed create-import manifests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-cli-admin-upload-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "CAPLET.md");
    writeFileSync(sourcePath, "# GitHub\n");
    let request: Request | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({ id: "github", currentRevision: {} }, { status: 201 });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "bundle-intent",
    });

    await client.request("storage_records_import", {
      id: "github",
      sourceKind: "catalog",
      sourceIdentity: "github",
      channel: "stable",
      files: [
        {
          path: "CAPLET.md",
          sourcePath,
          size: 9,
          executable: false,
        },
      ],
    });

    expect(request?.url).toBe("https://host.example/api/v2/admin/caplet-records/github/bundle");
    expect(request?.headers.get("idempotency-key")).toBe("bundle-intent");
    expect(request?.headers.get("if-none-match")).toBe("*");
    const form = await request!.clone().formData();
    expect(JSON.parse(String(form.get("manifest")))).toMatchObject({
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: 9,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          executable: false,
        },
      ],
      installation: {
        sourceKind: "catalog",
        sourceIdentity: "github",
        channel: "stable",
      },
    });
    const uploaded = form.getAll("file");
    expect(uploaded).toHaveLength(1);
    expect(await (uploaded[0] as File).text()).toBe("# GitHub\n");
  });

  it("rejects partial create-import installation metadata locally", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    for (const metadata of [
      { sourceKind: "catalog" },
      { sourceIdentity: "github" },
      { channel: "stable" },
      { sourceKind: "catalog", sourceIdentity: "github", channel: "" },
    ]) {
      await expect(
        client.request("storage_records_import", {
          id: "github",
          files: [],
          ...metadata,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not include installation metadata in update manifests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-cli-admin-update-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "CAPLET.md");
    writeFileSync(sourcePath, "# GitHub\n");
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json(
          { record: { id: "github", headGeneration: 2 }, document: "" },
          { headers: { ETag: '"record-etag"' } },
        );
      }
      return Response.json({ id: "github", currentRevision: {} });
    });
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => "bundle-update",
    });

    await client.request("storage_records_update", {
      id: "github",
      sourceKind: "catalog",
      sourceIdentity: "github",
      channel: "stable",
      files: [
        {
          path: "CAPLET.md",
          sourcePath,
          size: 9,
          executable: false,
        },
      ],
    });

    const form = await requests[1]!.clone().formData();
    expect(JSON.parse(String(form.get("manifest")))).not.toHaveProperty("installation");
    expect(requests[1]?.headers.get("if-match")).toBe('"record-etag"');
  });

  it("emits server-parseable bounded multipart boundaries for create and update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-cli-admin-boundary-"));
    temporaryDirectories.push(directory);
    const stagingDirectory = mkdtempSync(join(tmpdir(), "remote-cli-admin-staging-"));
    temporaryDirectories.push(stagingDirectory);
    const sourcePath = join(directory, "CAPLET.md");
    writeFileSync(sourcePath, "# GitHub\n");
    const boundaries: string[] = [];
    const manifests: unknown[] = [];
    const admission = new AdminBundleUploadAdmissionController({
      stagingDir: stagingDirectory,
      limits: DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET") {
        return Response.json(
          { record: { id: "github", headGeneration: 2 }, document: "" },
          { headers: { ETag: '"record-etag"' } },
        );
      }
      const contentType = request.headers.get("content-type");
      const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/u.exec(contentType ?? "");
      boundaries.push(boundary?.[1] ?? boundary?.[2] ?? "");
      const parsed = await parseAdminBundleUpload({
        input: Readable.fromWeb(request.body as never),
        contentType: contentType ?? undefined,
        contentLength: request.headers.get("content-length") ?? undefined,
        admission,
        signal: new AbortController().signal,
      });
      manifests.push(parsed.manifest);
      await parsed.cleanup();
      return Response.json({ id: "github", currentRevision: {} });
    });
    const keys = ["bundle-create-boundary", "bundle-update-boundary"];
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
      idempotencyKey: () => keys.shift()!,
    });
    const files = [
      {
        path: "CAPLET.md",
        sourcePath,
        size: 9,
        executable: false,
      },
    ];

    await client.request("storage_records_import", { id: "github", files });
    await client.request("storage_records_update", { id: "github", files });
    await admission.close();

    expect(boundaries).toHaveLength(2);
    expect(new Set(boundaries).size).toBe(2);
    for (const boundary of boundaries) {
      expect(Buffer.byteLength(boundary)).toBeLessThanOrEqual(DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES);
      expect(boundary).toMatch(/^caplets-[A-Za-z0-9_-]{43}$/u);
    }
    expect(manifests).toEqual([
      expect.objectContaining({ files: [expect.objectContaining({ path: "CAPLET.md", size: 9 })] }),
      expect.objectContaining({ files: [expect.objectContaining({ path: "CAPLET.md", size: 9 })] }),
    ]);
  });

  it("returns bundle download bodies as streams without buffering them", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          headers: { "content-type": "multipart/mixed; boundary=caplets-test" },
        }),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-operator-token",
      fetch,
    });

    await expect(client.request("storage_records_export", { id: "github" })).resolves.toEqual({
      body: stream,
      contentType: "multipart/mixed; boundary=caplets-test",
    });
  });

  it("does not retry an Admin authorization rejection", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "Operator role required.",
          code: "AUTH_FAILED",
        },
        { status: 403, headers: { "content-type": "application/problem+json" } },
      ),
    );
    const client = createRemoteAdminCommandAdapter({
      baseUrl,
      bearerToken: "paired-access-token",
      fetch,
    });

    await expect(client.request("vault_list", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
