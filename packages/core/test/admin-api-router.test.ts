import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type {
  CurrentHostOperations,
  CurrentHostOperatorPrincipal,
  CurrentHostPrincipal,
} from "../src/current-host/operations";
import { AdminV2PrincipalError, createAdminV2Router } from "../src/admin-api/router";
import { CapletsError } from "../src/errors";
import { AdminBundleUploadAdmissionController } from "../src/admin-api/bundle-upload-admission";
import { ADMIN_V2_ROUTE_DEFINITIONS, adminRuntimeEventSchema } from "../src/admin-api/openapi";
import { createStrongEtag } from "../src/admin-api/conditional";

const principal: CurrentHostOperatorPrincipal = {
  clientId: "operator-1",
  hostUrl: "https://host.example",
  role: "operator",
};

function operationsWith(
  execute: (
    principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => Promise<unknown>,
  runtimeEvents?: CurrentHostOperations["runtimeEvents"],
): CurrentHostOperations {
  return {
    execute,
    ...(runtimeEvents === undefined ? {} : { runtimeEvents }),
  } as unknown as CurrentHostOperations;
}

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<{
  events: Array<{ event: string; data: unknown }>;
  decoded: string;
}> {
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  let decoded = "";
  let buffered = "";
  while (events.length < count) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = decoder.decode(next.value, { stream: true });
    decoded += chunk;
    buffered += chunk;
    let delimiter = buffered.indexOf("\n\n");
    while (delimiter !== -1) {
      const frame = buffered.slice(0, delimiter);
      buffered = buffered.slice(delimiter + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trimStart();
        if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
      }
      if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
      delimiter = buffered.indexOf("\n\n");
    }
  }
  return { events, decoded };
}

function recordOutcomeFixture(
  id: string,
  headGeneration: number,
  updatedAt = "2026-07-20T12:00:00.000Z",
) {
  return {
    recordKey: "record-key",
    id,
    headGeneration,
    historyLimit: null,
    createdAt: "2026-07-20T11:00:00.000Z",
    updatedAt,
    currentRevision: {
      revisionKey: "revision-key",
      sequence: 1,
      name: "Demo",
      createdAt: "2026-07-20T11:00:00.000Z",
    },
  };
}
function resourceEtag(namespace: string, identity: string, version: string | number): string {
  return createStrongEtag(namespace, JSON.stringify([identity, version]));
}

describe("relative Admin v2 router", () => {
  it("authenticates a GET as safe and maps the host resource through CurrentHostOperations", async () => {
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "summary",
      summary: { host: { current: true }, requested: operation },
    }));
    const principalProvider = vi.fn(async () => principal);
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
        publicOrigin: null,
      },
    });

    const response = await app.request("https://host.example/host");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ host: { current: true } });
    expect(principalProvider).toHaveBeenCalledWith(expect.any(Request), { mutates: false });
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "summary",
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
    });
  });
  it("authenticates safe requests before validating route input", async () => {
    const execute = vi.fn(async () => {
      throw new Error("unauthenticated input must not execute");
    });
    const principalProvider = vi.fn(async () => {
      throw new AdminV2PrincipalError(401, "Bearer authentication is required.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/remote-clients?limit=invalid");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(principalProvider).toHaveBeenCalledWith(expect.any(Request), { mutates: false });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ["/runtime", "runtime"],
    ["/logs", "logs"],
    ["/diagnostics", "diagnostics"],
    ["/project-binding", "project_binding"],
    ["/activity", "activity_page"],
    ["/caplets", "caplets_page"],
    ["/catalog/entries?source=default", "catalog_entries_page"],
    ["/catalog/entries/demo?source=default", "catalog_detail"],
    ["/catalog/update-candidates", "catalog_update_candidates_page"],
    ["/remote-clients", "remote_clients_page"],
    ["/remote-clients/client-a", "remote_client_get"],
    ["/remote-login-requests", "remote_login_requests_page"],
    ["/remote-login-requests/flow-a", "remote_login_request_get"],
    ["/backend-auth-connections", "backend_auth_connections_page"],
    ["/backend-auth-connections/server-a", "backend_auth_connection_get"],
    ["/backend-auth-flows/flow-a", "backend_auth_flow_get"],
    ["/vault-values", "vault_values_page"],
    ["/vault-values/secret", "vault_get"],
    ["/vault-grants", "vault_grants_page"],
    ["/vault-values/secret/grants", "vault_grants_page"],
    ["/caplet-records", "stored_caplets_page"],
    ["/caplet-records/demo", "stored_caplet_get"],
    ["/caplet-records/demo/revisions", "stored_caplet_revisions_page"],
    ["/caplet-records/demo/revisions/rev-a", "stored_caplet_get"],
    ["/caplet-records/demo/installations", "stored_caplet_installations_page"],
    ["/caplet-records/demo/installations/install-a", "stored_caplet_installation_get"],
    [
      "/caplet-records/demo/installation-observations",
      "stored_caplet_installation_observations_page",
    ],
  ])("maps GET %s to %s", async (path, expectedKind) => {
    const execute = vi.fn(async (_principal, operation) => ({
      kind: operation.kind,
      status: "ok",
      page: { items: [] },
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request(`https://host.example${path}`);

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ kind: expectedKind }),
    );
  });

  it("projects an absent Vault value as a v2 not-found Problem", async () => {
    const execute = vi.fn(async () => ({
      kind: "vault_get",
      name: "missing",
      present: false,
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/vault-values/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      code: "SERVER_NOT_FOUND",
      status: 404,
    });
  });

  it("keeps an immutable revision ETag stable when the record head advances", async () => {
    let headGeneration = 7;
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "stored_caplet_get",
      record: {
        id: "demo",
        headGeneration: headGeneration++,
        currentRevision: { revisionKey: "rev-a" },
      },
      document: "immutable",
      requested: operation,
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const first = await app.request("https://host.example/caplet-records/demo/revisions/rev-a");
    const second = await app.request("https://host.example/caplet-records/demo/revisions/rev-a");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_get",
      id: "demo",
      revisionKey: "rev-a",
    });
  });

  it("binds opaque cursors to the paged route filters, direction, and stable key", async () => {
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "remote_clients_page",
      page: {
        items: [{ clientId: "client-2", role: "operator", createdAt: "2026-07-20T12:00:00.000Z" }],
        nextKey: { createdAt: "2026-07-20T12:00:00.000Z", clientId: "client-2" },
        requested: operation,
      },
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const first = await app.request(
      "https://host.example/remote-clients?limit=2&role=operator&revoked=false",
    );
    const firstPage = (await first.json()) as { nextCursor: string };
    expect(first.status).toBe(200);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "remote_clients_page",
      limit: 2,
      sort: "asc",
      role: "operator",
      revoked: false,
    });

    const second = await app.request(
      `https://host.example/remote-clients?limit=2&role=operator&revoked=false&cursor=${firstPage.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "remote_clients_page",
      limit: 2,
      sort: "asc",
      role: "operator",
      revoked: false,
      after: { createdAt: "2026-07-20T12:00:00.000Z", clientId: "client-2" },
    });

    const rebound = await app.request(
      `https://host.example/remote-clients?limit=2&role=access&revoked=false&cursor=${firstPage.nextCursor}`,
    );
    expect(rebound.status).toBe(400);
    expect(rebound.headers.get("content-type")).toBe("application/problem+json");
    await expect(rebound.json()).resolves.toMatchObject({
      status: 400,
      code: "REQUEST_INVALID",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a record cursor rebound to a different materialized record path", async () => {
    const nextKey = {
      createdAt: "2026-07-20T12:00:00.000Z",
      revisionKey: "rev-2",
    };
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "stored_caplet_revisions_page",
      page: {
        items: [],
        ...(operation.after === undefined ? { nextKey } : {}),
      },
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const alpha = await app.request("https://host.example/caplet-records/alpha/revisions?limit=1");
    const alphaPage = (await alpha.json()) as { nextCursor: string };
    expect(alpha.status).toBe(200);

    const rebound = await app.request(
      `https://host.example/caplet-records/beta/revisions?limit=1&cursor=${alphaPage.nextCursor}`,
    );

    expect(rebound.status).toBe(400);
    await expect(rebound.json()).resolves.toMatchObject({
      code: "REQUEST_INVALID",
      status: 400,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps bounded installation observation pages through typed cursors", async () => {
    const nextKey = {
      observedAt: "2026-07-20T12:00:00.000Z",
      observationKey: "observation-2",
    };
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "stored_caplet_installation_observations_page",
      page: {
        items: [],
        ...(operation.after === undefined ? { nextKey } : {}),
      },
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const first = await app.request(
      "https://host.example/caplet-records/demo/installation-observations?limit=1",
    );
    const firstPage = (await first.json()) as { nextCursor: string };
    expect(first.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_installation_observations_page",
      id: "demo",
      limit: 1,
      sort: "asc",
    });

    const second = await app.request(
      `https://host.example/caplet-records/demo/installation-observations?limit=1&cursor=${firstPage.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_installation_observations_page",
      id: "demo",
      limit: 1,
      sort: "asc",
      after: nextKey,
    });

    const descending = await app.request(
      "https://host.example/caplet-records/demo/installation-observations?limit=1&sort=desc",
    );
    const descendingPage = (await descending.json()) as { nextCursor: string };
    expect(descending.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_installation_observations_page",
      id: "demo",
      limit: 1,
      sort: "desc",
    });

    const mismatched = await app.request(
      `https://host.example/caplet-records/demo/installation-observations?limit=1&cursor=${descendingPage.nextCursor}`,
    );
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: "REQUEST_INVALID",
      status: 400,
    });
  });
  it("returns 404 when an installation-observation parent record is missing", async () => {
    const execute = vi.fn(async () => {
      throw new CapletsError("CONFIG_NOT_FOUND", "Caplet Record missing was not found.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request(
      "https://host.example/caplet-records/missing/installation-observations",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      status: 404,
    });
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "stored_caplet_installation_observations_page",
      id: "missing",
      limit: 100,
      sort: "asc",
    });
  });
  it("round-trips filter-bound log cursors through the typed stable key", async () => {
    const nextKey = {
      timestamp: "2026-07-20T12:00:00.000Z",
      logKey: "daemon-0002",
    };
    const execute = vi.fn(async (_principal, operation) => ({
      kind: "logs",
      page: {
        items:
          operation.after === undefined
            ? [
                {
                  timestamp: "2026-07-20T12:00:01.000Z",
                  level: "info",
                  message: "newer",
                },
              ]
            : [
                {
                  timestamp: "2026-07-20T11:59:59.000Z",
                  level: "warn",
                  message: "older",
                },
              ],
        ...(operation.after === undefined ? { nextKey } : {}),
      },
    }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const first = await app.request("https://host.example/logs?limit=1&sort=desc");
    const firstPage = (await first.json()) as {
      items: Array<{ message: string }>;
      nextCursor: string;
    };
    expect(first.status).toBe(200);
    expect(firstPage.items).toEqual([expect.objectContaining({ message: "newer" })]);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "logs",
      limit: 1,
      sort: "desc",
    });

    const second = await app.request(
      `https://host.example/logs?limit=1&sort=desc&cursor=${firstPage.nextCursor}`,
    );
    await expect(second.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ message: "older" })],
    });
    expect(second.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "logs",
      limit: 1,
      sort: "desc",
      after: nextKey,
    });
  });
  it("requires current strong conditions and idempotency before update or delete execution", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("demo", 7),
          document: "old",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture("demo", 8, "2026-07-20T12:01:00.000Z"),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const store = {
      claim: vi.fn(async () => ({
        outcome: "acquired" as const,
        ownerToken: "owner-1",
        expiresAt: "2026-07-20T12:01:00.000Z",
      })),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(async () => true),
    };
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const current = await app.request("https://host.example/caplet-records/demo");
    const etag = current.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

    const invalidIdempotencyKey = await app.request("https://host.example/caplet-records/demo", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "x".repeat(129),
        "If-Match": etag!,
      },
      body: JSON.stringify({ document: "new" }),
    });
    expect(invalidIdempotencyKey.status).toBe(400);
    expect(store.claim).not.toHaveBeenCalled();

    const missing = await app.request("https://host.example/caplet-records/demo", {
      method: "DELETE",
      headers: { "Idempotency-Key": "delete-demo" },
    });
    expect(missing.status).toBe(428);
    expect(store.claim).not.toHaveBeenCalled();

    const stale = await app.request("https://host.example/caplet-records/demo", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "update-stale",
        "If-Match": '"stale"',
      },
      body: JSON.stringify({ document: "new" }),
    });
    expect(stale.status).toBe(412);

    const updated = await app.request("https://host.example/caplet-records/demo", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "update-current",
        "If-Match": etag!,
      },
      body: JSON.stringify({ document: "new" }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).not.toBe(etag);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_update",
      id: "demo",
      document: "new",
      expectedGeneration: 7,
    });
  });
  it("claims and finalizes current-state precondition failures after request validation", async () => {
    let currentExists = false;
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        if (!currentExists) {
          return { kind: "stored_caplet_get", status: "not_found", id: operation.id };
        }
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture(operation.id, 7),
          document: "old",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture(operation.id, 8, "2026-07-20T12:01:00.000Z"),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const store = {
      claim: vi.fn(async () => ({
        outcome: "acquired" as const,
        ownerToken: "owner-1",
        expiresAt: "2026-07-20T12:01:00.000Z",
      })),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(async () => true),
    };
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const request = (idempotencyKey: string, ifMatch: string) =>
      app.request("https://host.example/caplet-records/recoverable", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": idempotencyKey,
          "If-Match": ifMatch,
        },
        body: JSON.stringify({ document: "new" }),
      });

    const missing = await request("missing-record", '"unavailable"');
    expect(missing.status).toBe(404);
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(store.finalize).toHaveBeenLastCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ status: 404 }) }),
    );

    currentExists = true;
    const stale = await request("stale-record", '"stale"');
    expect(stale.status).toBe(412);
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(store.finalize).toHaveBeenLastCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ status: 412 }) }),
    );

    const corrected = await request(
      "current-record",
      resourceEtag("admin-caplet-record", JSON.stringify(["recoverable", null]), 7),
    );
    expect(corrected.status).toBe(200);
    expect(store.claim).toHaveBeenCalledTimes(3);
    expect(store.finalize).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_update",
      id: "recoverable",
      document: "new",
      expectedGeneration: 7,
    });
  });
  it("replays a finalized conditional mutation before re-reading current state and fingerprints validators", async () => {
    let currentGeneration = 7;
    let currentExists = true;
    let finalized:
      | {
          requestFingerprintSource: string;
          response: { status: number; contentType: string; body: string };
        }
      | undefined;
    const store = {
      claim: vi.fn(async (input: { requestFingerprintSource: string }) => {
        if (!finalized) {
          return {
            outcome: "acquired" as const,
            ownerToken: "owner-conditional",
            expiresAt: "2026-07-20T12:01:00.000Z",
          };
        }
        return input.requestFingerprintSource === finalized.requestFingerprintSource
          ? { outcome: "replay" as const, response: finalized.response }
          : { outcome: "conflict" as const };
      }),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(
        async (input: { response: { status: number; contentType: string; body: string } }) => {
          const claimInput = store.claim.mock.calls[0]![0] as {
            requestFingerprintSource: string;
          };
          finalized = {
            requestFingerprintSource: claimInput.requestFingerprintSource,
            response: input.response,
          };
          return true;
        },
      ),
    };
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return currentExists
          ? {
              kind: "stored_caplet_get",
              record: recordOutcomeFixture("demo", currentGeneration),
              document: "old",
            }
          : { kind: "stored_caplet_get", status: "not_found", id: "demo" };
      }
      if (operation.kind === "stored_caplet_update") {
        currentGeneration += 1;
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture("demo", currentGeneration),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const request = (ifMatch: string) =>
      app.request("https://host.example/caplet-records/demo", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": "lost-response",
          "If-Match": ifMatch,
        },
        body: JSON.stringify({ document: "new" }),
      });
    const originalValidator = resourceEtag(
      "admin-caplet-record",
      JSON.stringify(["demo", null]),
      7,
    );

    const first = await request(originalValidator);
    expect(first.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);

    currentGeneration = 11;
    const advancedReplay = await request(originalValidator);
    expect(advancedReplay.status).toBe(200);
    expect(advancedReplay.headers.get("idempotency-replayed")).toBe("true");
    expect(execute).toHaveBeenCalledTimes(2);

    currentExists = false;
    const deletedReplay = await request(originalValidator);
    expect(deletedReplay.status).toBe(200);
    expect(deletedReplay.headers.get("idempotency-replayed")).toBe("true");
    expect(execute).toHaveBeenCalledTimes(2);

    const changedValidator = await request(
      resourceEtag("admin-caplet-record", JSON.stringify(["demo", null]), 11),
    );
    expect(changedValidator.status).toBe(409);
    await expect(changedValidator.json()).resolves.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("finalizes a storage compare-and-swap loss as a precondition failure", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: { id: "demo", headGeneration: 7 },
          document: "old",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        throw new CapletsError("REQUEST_INVALID", "The Caplet Record generation is stale.", {
          kind: "stale_generation",
          expectedGeneration: 7,
          currentGeneration: 8,
        });
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const store = {
      claim: vi.fn(async () => ({
        outcome: "acquired" as const,
        ownerToken: "owner-cas-loss",
        expiresAt: "2026-07-20T12:01:00.000Z",
      })),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(async () => true),
    };
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/caplet-records/demo", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "cas-loss",
        "If-Match": resourceEtag("admin-caplet-record", JSON.stringify(["demo", null]), 7),
      },
      body: JSON.stringify({ document: "new" }),
    });

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(store.finalize).toHaveBeenCalledTimes(1);
    expect(store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ status: 412 }),
      }),
    );
  });
  it("returns the renamed Caplet Record canonical URI in Location", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("old-id", 7),
          document: "old",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture("new-id", 8),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-rename",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/caplet-records/old-id", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "rename-location",
        "If-Match": resourceEtag("admin-caplet-record", JSON.stringify(["old-id", null]), 7),
      },
      body: JSON.stringify({ id: "new-id" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBe("/caplet-records/new-id");
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_update",
      id: "old-id",
      newId: "new-id",
      expectedGeneration: 7,
    });
  });
  it("reconciles an unknown rename outcome against the new Caplet Record URI", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("old-id", 7),
          document: "old",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture("new-id", 8),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-rename-unknown",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => false),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/caplet-records/old-id", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "rename-unknown",
        "If-Match": resourceEtag("admin-caplet-record", JSON.stringify(["old-id", null]), 7),
      },
      body: JSON.stringify({ id: "new-id" }),
    });

    expect(response.status).toBe(409);
    const problem = (await response.json()) as {
      code: string;
      links: Record<string, string>;
    };
    expect(problem.code).toBe("IDEMPOTENCY_UNKNOWN");
    expect(Object.values(problem.links)).toContain("/caplet-records/new-id");
  });
  it("replays finalized actions and rejects conflicting, in-progress, and unknown keys", async () => {
    let finalized:
      | {
          requestFingerprintSource: string;
          response: { status: number; contentType: string; body: string };
        }
      | undefined;
    const store = {
      claim: vi.fn(async (input: { requestFingerprintSource: string }) => {
        if (!finalized) {
          return {
            outcome: "acquired" as const,
            ownerToken: "owner-1",
            expiresAt: "2026-07-20T12:01:00.000Z",
          };
        }
        return input.requestFingerprintSource === finalized.requestFingerprintSource
          ? { outcome: "replay" as const, response: finalized.response }
          : { outcome: "conflict" as const };
      }),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(
        async (input: { response: { status: number; contentType: string; body: string } }) => {
          const claimInput = store.claim.mock.calls[0]![0] as {
            requestFingerprintSource: string;
          };
          finalized = {
            requestFingerprintSource: claimInput.requestFingerprintSource,
            response: input.response,
          };
          return true;
        },
      ),
    };
    const execute = vi.fn(async () => ({
      kind: "catalog_update",
      installed: [{ id: "demo", status: "updated" }],
      setupActions: [],
    }));
    const baseOptions = {
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    };
    const app = createAdminV2Router({ ...baseOptions, idempotencyStore: store });
    const request = (body: unknown) =>
      app.request("https://host.example/catalog/update-runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "update-run-1",
          "If-None-Match": "*",
        },
        body: JSON.stringify(body),
      });

    const first = await request({ capletIds: ["demo"], acknowledgeRiskIncrease: true });
    const firstBody = await first.text();
    const replay = await request({ capletIds: ["demo"], acknowledgeRiskIncrease: true });
    expect(replay.status).toBe(first.status);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("content-type")).toBe(first.headers.get("content-type"));
    expect(replay.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    expect(replay.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(replay.headers.get("location")).toBe(first.headers.get("location"));
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "catalog_update",
      capletIds: ["demo"],
      allowRiskIncrease: true,
    });

    const conflict = await request({ capletIds: ["other"], acknowledgeRiskIncrease: true });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(execute).toHaveBeenCalledTimes(1);

    for (const claim of [
      { outcome: "in_progress" as const, retryAfterSeconds: 3 },
      {
        outcome: "unknown" as const,
        reconciliationLinks: ["/catalog/update-candidates"],
      },
    ]) {
      const blockedExecute = vi.fn();
      const blocked = createAdminV2Router({
        ...baseOptions,
        operations: operationsWith(blockedExecute),
        idempotencyStore: {
          claim: vi.fn(async () => claim),
          heartbeat: vi.fn(async () => true),
          finalize: vi.fn(async () => true),
        },
      });
      const response = await blocked.request("https://host.example/catalog/update-runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `blocked-${claim.outcome}`,
          "If-None-Match": "*",
        },
        body: JSON.stringify({ capletIds: ["demo"] }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: claim.outcome === "in_progress" ? "IDEMPOTENCY_IN_PROGRESS" : "IDEMPOTENCY_UNKNOWN",
      });
      if (claim.outcome === "in_progress") {
        expect(response.headers.get("retry-after")).toBe("3");
      }
      expect(blockedExecute).not.toHaveBeenCalled();
    }
  });

  it("finalizes and replays an atomic create-only race as a precondition failure", async () => {
    let finalized:
      | {
          requestFingerprintSource: string;
          response: { status: number; contentType: string; body: string };
        }
      | undefined;
    const store = {
      claim: vi.fn(async (input: { requestFingerprintSource: string }) => {
        if (!finalized) {
          return {
            outcome: "acquired" as const,
            ownerToken: "owner-create-race",
            expiresAt: "2026-07-20T12:01:00.000Z",
          };
        }
        return input.requestFingerprintSource === finalized.requestFingerprintSource
          ? { outcome: "replay" as const, response: finalized.response }
          : { outcome: "conflict" as const };
      }),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(
        async (input: { response: { status: number; contentType: string; body: string } }) => {
          const claimInput = store.claim.mock.calls[0]![0] as {
            requestFingerprintSource: string;
          };
          finalized = {
            requestFingerprintSource: claimInput.requestFingerprintSource,
            response: input.response,
          };
          return true;
        },
      ),
    };
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "vault_get") {
        return { kind: "vault_get", name: "secret", present: false };
      }
      if (operation.kind === "vault_set") {
        throw new CapletsError("CONFIG_EXISTS", "The Vault value already exists.");
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const request = () =>
      app.request("https://host.example/vault-values/secret", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "vault-create-race",
          "If-None-Match": "*",
        },
        body: JSON.stringify({ value: "secret-value" }),
      });

    const first = await request();
    const firstBody = await first.text();
    const replay = await request();

    expect(first.status).toBe(412);
    expect(JSON.parse(firstBody)).toMatchObject({
      code: "PRECONDITION_FAILED",
      status: 412,
    });
    expect(replay.status).toBe(412);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ status: 412 }),
      }),
    );
  });

  it("enforces the secondary Vault grant condition for atomic value-and-grant upserts", async () => {
    let grantPresent = true;
    let grantCreateRace = false;
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "vault_get") {
        return {
          kind: "vault_get",
          status: {
            key: "secret",
            present: true,
            generation: 2,
            valueBytes: 6,
            createdAt: "2026-07-20T12:00:00.000Z",
            updatedAt: "2026-07-20T12:00:00.000Z",
          },
        };
      }
      if (operation.kind === "vault_access_list") {
        return {
          kind: "vault_access_list",
          grants: grantPresent
            ? [
                {
                  storedKey: "secret",
                  capletId: "demo",
                  referenceName: "token",
                  origin: { kind: "operator" },
                  resourceVersion: "rv-1",
                  createdAt: "2026-07-20T12:00:00.000Z",
                  updatedAt: "2026-07-20T12:00:00.000Z",
                },
              ]
            : [],
        };
      }
      if (operation.kind === "vault_set") {
        if (grantCreateRace) {
          throw new CapletsError("CONFIG_EXISTS", "The Vault grant already exists.");
        }
        return {
          kind: "vault_set",
          status: {
            key: "secret",
            present: true,
            generation: 3,
            valueBytes: 7,
            createdAt: "2026-07-20T12:00:00.000Z",
            updatedAt: "2026-07-20T12:01:00.000Z",
          },
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const claim = vi.fn(
      async (_input: { idempotencyKey: string; requestFingerprintSource: string }) => ({
        outcome: "acquired" as const,
        ownerToken: "owner-grant-condition",
        expiresAt: "2026-07-20T12:01:00.000Z",
      }),
    );
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim,
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const valueEtag = resourceEtag("admin-vault-value", "secret", 2);
    const grantEtag = resourceEtag(
      "admin-vault-grant",
      JSON.stringify(["secret", "demo", "token"]),
      "rv-1",
    );
    const request = (idempotencyKey: string, grantIfMatch?: string) =>
      app.request("https://host.example/vault-values/secret", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "If-Match": valueEtag,
          ...(grantIfMatch === undefined ? {} : { "X-Caplets-Grant-If-Match": grantIfMatch }),
        },
        body: JSON.stringify({
          value: "updated",
          grant: "demo",
          referenceName: "token",
        }),
      });

    const missingCondition = await request("grant-condition-required");
    expect(missingCondition.status).toBe(428);
    await expect(missingCondition.json()).resolves.toMatchObject({
      code: "PRECONDITION_REQUIRED",
    });

    grantPresent = false;
    const absentWithCondition = await request("grant-condition-absent", grantEtag);
    expect(absentWithCondition.status).toBe(412);
    await expect(absentWithCondition.json()).resolves.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    grantPresent = true;
    const stale = await request("grant-condition-stale", '"stale"');
    expect(stale.status).toBe(412);
    const current = await request("grant-condition-current", grantEtag);
    expect(current.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_set",
      name: "secret",
      value: "updated",
      grant: "demo",
      referenceName: "token",
      expectedGeneration: 2,
      expectedGrantResourceVersion: "rv-1",
    });

    grantPresent = false;
    const created = await request("grant-condition-create");
    expect(created.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_set",
      name: "secret",
      value: "updated",
      grant: "demo",
      referenceName: "token",
      expectedGeneration: 2,
      grantCreateOnly: true,
    });

    grantCreateRace = true;
    const raced = await request("grant-condition-create-race");
    expect(raced.status).toBe(412);
    await expect(raced.json()).resolves.toMatchObject({
      status: 412,
      code: "PRECONDITION_FAILED",
    });

    const staleClaim = claim.mock.calls.find(
      ([input]) => input.idempotencyKey === "grant-condition-stale",
    )?.[0];
    const currentClaim = claim.mock.calls.find(
      ([input]) => input.idempotencyKey === "grant-condition-current",
    )?.[0];
    if (!staleClaim || !currentClaim) throw new Error("Expected both conditional claims.");
    expect(staleClaim.requestFingerprintSource).not.toBe(currentClaim.requestFingerprintSource);
  });

  it("converts semantic failures to redacted Problem Details before idempotent finalization", async () => {
    const execute = vi.fn(async () => {
      throw new CapletsError(
        "REQUEST_INVALID",
        "bad token=secret-value at /srv/private/config.json",
      );
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-1",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/runtime-restarts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "restart-1",
        "If-None-Match": "*",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = JSON.stringify(await response.json());
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("secret-value");
    expect(body).not.toContain("/srv/private");
  });
  it("returns a durable 503 when restart is unavailable and reserves 201 for acceptance", async () => {
    const execute = vi.fn(async () => ({
      kind: "runtime_restart",
      restartAvailable: false,
      reason: "daemon_manager_unavailable",
    }));
    const finalize = vi.fn(async () => true);
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-restart",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize,
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/runtime-restarts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "restart-unavailable",
        "If-None-Match": "*",
      },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:caplets:problem:service-unavailable",
      status: 503,
      code: "SERVER_UNAVAILABLE",
    });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 503,
          contentType: "application/problem+json",
        }),
      }),
    );

    execute.mockImplementationOnce(async () => ({
      kind: "runtime_restart",
      restartAvailable: true,
      reason: "accepted",
    }));
    const accepted = await app.request("https://host.example/runtime-restarts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "restart-accepted",
        "If-None-Match": "*",
      },
      body: "{}",
    });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("content-type")).toBe("application/json");
    await expect(accepted.json()).resolves.toEqual({ restartAvailable: true });
  });
  it("keeps staged bundle sources alive through semantic import and cleans them afterward", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-upload-test-"));
    const admission = new AdminBundleUploadAdmissionController({ stagingDir });
    const file = new TextEncoder().encode("bundle file");
    const manifest = {
      version: 1,
      files: [
        {
          path: "assets/data.txt",
          size: file.byteLength,
          sha256: createHash("sha256").update(file).digest("hex"),
          executable: false,
        },
      ],
      installation: {
        sourceKind: "git",
        sourceIdentity: "https://example.com/demo.git",
        channel: "stable",
      },
    };
    const boundary = "caplets-router-boundary";
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const upload = new Uint8Array(prefix.byteLength + file.byteLength + suffix.byteLength);
    upload.set(prefix);
    upload.set(file, prefix.byteLength);
    upload.set(suffix, prefix.byteLength + file.byteLength);
    let sourceAfterExecution: { open(): ReadableStream<Uint8Array> } | undefined;
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("demo", 1),
          document: "current",
        };
      }
      expect(operation.kind).toBe("stored_caplet_bundle_import");
      expect(operation).toMatchObject({
        installation: {
          sourceKind: "git",
          sourceIdentity: "https://example.com/demo.git",
          channel: "stable",
        },
      });
      const sources = operation.sources as Array<{ open(): ReadableStream<Uint8Array> }>;
      sourceAfterExecution = sources[0];
      const reader = sources[0]!.open().getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(file));
      return {
        kind: "stored_caplet_bundle_import",
        record: recordOutcomeFixture("demo", 1),
      };
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-1",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    try {
      const response = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-demo",
          "If-None-Match": "*",
        },
        body: upload as never,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("location")).toBe("/caplet-records/demo/bundle");
      expect(execute).toHaveBeenCalledTimes(1);
      const update = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-demo-update",
          "If-Match": response.headers.get("etag")!,
        },
        body: upload as never,
      });
      expect(update.status).toBe(400);
      await expect(update.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalledWith(
        principal,
        expect.objectContaining({ kind: "stored_caplet_bundle_update" }),
      );
      await expect(sourceAfterExecution!.open().getReader().read()).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("finalizes and replays an atomic bundle create collision as an exact 412 Problem", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-bundle-race-test-"));
    const admission = new AdminBundleUploadAdmissionController({ stagingDir });
    const file = new TextEncoder().encode("bundle file");
    const manifest = {
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: file.byteLength,
          sha256: createHash("sha256").update(file).digest("hex"),
          executable: false,
        },
      ],
    };
    const boundary = "caplets-router-bundle-race";
    const upload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let finalized:
      | {
          requestFingerprintSource: string;
          response: { status: number; contentType: string; body: string };
        }
      | undefined;
    const store = {
      claim: vi.fn(async (input: { requestFingerprintSource: string }) => {
        if (!finalized) {
          return {
            outcome: "acquired" as const,
            ownerToken: "owner-bundle-race",
            expiresAt: "2026-07-20T12:01:00.000Z",
          };
        }
        return input.requestFingerprintSource === finalized.requestFingerprintSource
          ? { outcome: "replay" as const, response: finalized.response }
          : { outcome: "conflict" as const };
      }),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(
        async (input: { response: { status: number; contentType: string; body: string } }) => {
          const claimInput = store.claim.mock.calls[0]![0] as {
            requestFingerprintSource: string;
          };
          finalized = {
            requestFingerprintSource: claimInput.requestFingerprintSource,
            response: input.response,
          };
          return true;
        },
      ),
    };
    const execute = vi.fn(async (_principal, operation) => {
      expect(operation.kind).toBe("stored_caplet_bundle_import");
      throw new CapletsError("CONFIG_EXISTS", "Caplet Record demo already exists.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    try {
      const first = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-create-race",
          "If-None-Match": "*",
        },
        body: upload,
      });
      const firstBody = await first.text();
      const replay = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-create-race",
          "If-None-Match": "*",
        },
        body: upload,
      });
      const expectedProblem = {
        type: "urn:caplets:problem:precondition-failed",
        title: "Precondition failed",
        status: 412,
        detail: "The resource was created before this create-only mutation committed.",
        code: "PRECONDITION_FAILED",
      };

      expect(first.status).toBe(412);
      expect(first.headers.get("content-type")).toBe("application/problem+json");
      expect(JSON.parse(firstBody)).toEqual(expectedProblem);
      expect(replay.status).toBe(412);
      expect(replay.headers.get("content-type")).toBe("application/problem+json");
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(expectedProblem);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(store.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          response: {
            status: 412,
            contentType: "application/problem+json",
            body: JSON.stringify(expectedProblem),
          },
        }),
      );
    } finally {
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("returns and replays a durable bundle success when post-finalization cleanup fails", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-upload-cleanup-test-"));
    const admission = new AdminBundleUploadAdmissionController({
      stagingDir,
      maxConcurrent: 1,
    });
    const file = Buffer.from("bundle file");
    const manifest = {
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: file.byteLength,
          sha256: createHash("sha256").update(file).digest("hex"),
          executable: false,
        },
      ],
    };
    const boundary = "caplets-router-cleanup-failure";
    const upload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let processRoot: string | undefined;
    const denyRequestRemoval = async () => {
      const rootName = (await readdir(stagingDir)).find((entry) =>
        entry.startsWith("caplets-admin-upload-"),
      );
      if (!rootName) throw new Error("Expected an owned upload process root.");
      processRoot = join(stagingDir, rootName);
      await chmod(processRoot, 0o500);
    };
    let finalized:
      | {
          requestFingerprintSource: string;
          response: { status: number; contentType: string; body: string };
        }
      | undefined;
    const store = {
      claim: vi.fn(async (input: { requestFingerprintSource: string }) => {
        if (!finalized) {
          return {
            outcome: "acquired" as const,
            ownerToken: "owner-cleanup-failure",
            expiresAt: "2026-07-20T12:01:00.000Z",
          };
        }
        await denyRequestRemoval();
        return input.requestFingerprintSource === finalized.requestFingerprintSource
          ? { outcome: "replay" as const, response: finalized.response }
          : { outcome: "conflict" as const };
      }),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(
        async (input: { response: { status: number; contentType: string; body: string } }) => {
          const claimCall = store.claim.mock.calls[0];
          if (!claimCall) throw new Error("Expected an acquired idempotency claim.");
          const [claimInput] = claimCall;
          finalized = {
            requestFingerprintSource: claimInput.requestFingerprintSource,
            response: input.response,
          };
          return true;
        },
      ),
    };
    const execute = vi.fn(async (_principal, operation) => {
      expect(operation.kind).toBe("stored_caplet_bundle_import");
      await denyRequestRemoval();
      return {
        kind: "stored_caplet_bundle_import",
        record: recordOutcomeFixture("demo", 1),
      };
    });
    const cleanupErrors = vi.fn();
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: store,
      reportBundleUploadCleanupError: cleanupErrors,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const request = () =>
      app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-cleanup-failure",
          "If-None-Match": "*",
        },
        body: upload,
      });

    try {
      const first = await request();
      expect(first.status, await first.clone().text()).toBe(201);
      const leakedRoot = processRoot;
      if (!leakedRoot) throw new Error("Expected cleanup to retain the upload process root.");
      expect(await readdir(leakedRoot)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^request-/u),
          expect.stringMatching(/^\.reservation-/u),
        ]),
      );
      const capacityProbe = await admission.acquire();
      await capacityProbe.cleanup();
      await chmod(leakedRoot, 0o700);

      const replay = await request();
      expect(replay.status, await replay.clone().text()).toBe(201);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(await first.json());
      expect(execute).toHaveBeenCalledTimes(1);
      expect(store.finalize).toHaveBeenCalledTimes(1);
      expect(cleanupErrors).toHaveBeenCalledTimes(2);
      for (const [safeError] of cleanupErrors.mock.calls) {
        expect(safeError).toEqual({
          code: "SERVER_UNAVAILABLE",
          message: "Caplet Bundle upload request staging could not be removed.",
          details: { reason: "upload_staging_unavailable" },
        });
        expect(JSON.stringify(safeError)).not.toContain(stagingDir);
      }
    } finally {
      if (processRoot) await chmod(processRoot, 0o700).catch(() => undefined);
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("does not suppress upload cleanup failure before durable finalization", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-upload-precommit-test-"));
    const admission = new AdminBundleUploadAdmissionController({ stagingDir });
    const file = Buffer.from("bundle file");
    const manifest = {
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: file.byteLength,
          sha256: createHash("sha256").update(file).digest("hex"),
          executable: false,
        },
      ],
    };
    const boundary = "caplets-router-precommit-cleanup";
    const upload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let processRoot: string | undefined;
    const cleanupErrors = vi.fn();
    const execute = vi.fn(async () => {
      throw new Error("A conflicted idempotency claim must not execute.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      reportBundleUploadCleanupError: cleanupErrors,
      idempotencyStore: {
        claim: vi.fn(async () => {
          const rootName = (await readdir(stagingDir)).find((entry) =>
            entry.startsWith("caplets-admin-upload-"),
          );
          if (!rootName) throw new Error("Expected an owned upload process root.");
          processRoot = join(stagingDir, rootName);
          await chmod(processRoot, 0o500);
          return { outcome: "conflict" as const };
        }),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    try {
      const response = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(upload.byteLength),
          "Idempotency-Key": "bundle-precommit-cleanup",
          "If-None-Match": "*",
        },
        body: upload,
      });

      expect(response.status, await response.clone().text()).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "SERVER_UNAVAILABLE",
        detail: "Caplet Bundle upload request staging could not be removed.",
      });
      expect(cleanupErrors).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (processRoot) await chmod(processRoot, 0o700).catch(() => undefined);
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("maps malformed bundle representations to 400 and domain-invalid manifests to 422", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-upload-status-test-"));
    const admission = new AdminBundleUploadAdmissionController({ stagingDir });
    const execute = vi.fn(async () => {
      throw new Error("Invalid bundle uploads must not execute.");
    });
    const claim = vi.fn(async () => {
      throw new Error("Invalid bundle uploads must not claim idempotency.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: {
        claim,
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const emptyFile = (path: string) => ({
      path,
      size: 0,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      executable: false,
    });
    const cases = [
      {
        label: "malformed JSON",
        manifest: "{not-json",
        status: 400,
        code: "REQUEST_INVALID",
        detail: "The Caplet Bundle manifest is malformed JSON.",
      },
      {
        label: "schema-invalid JSON",
        manifest: JSON.stringify({ version: 1, files: [] }),
        status: 400,
        code: "REQUEST_INVALID",
        detail: "The Caplet Bundle manifest is invalid.",
      },
      {
        label: "path traversal",
        manifest: JSON.stringify({ version: 1, files: [emptyFile("../escape")] }),
        status: 422,
        code: "CONFIG_INVALID",
        detail: "Invalid Caplet bundle path ../escape.",
      },
      {
        label: "canonical path collision",
        manifest: JSON.stringify({
          version: 1,
          files: [emptyFile("dir/../same"), emptyFile("same")],
        }),
        status: 422,
        code: "CONFIG_INVALID",
        detail: "Duplicate Caplet bundle path same.",
      },
    ] as const;

    try {
      for (const testCase of cases) {
        const boundary = `caplets-router-status-${testCase.status}`;
        const upload = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n` +
            `${testCase.manifest}\r\n--${boundary}--\r\n`,
        );
        const response = await app.request("https://host.example/caplet-records/demo/bundle", {
          method: "PUT",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(upload.byteLength),
            "Idempotency-Key": `bundle-${testCase.status}`,
            "If-None-Match": "*",
          },
          body: upload,
        });

        expect(response.status, testCase.label).toBe(testCase.status);
        expect(response.headers.get("content-type")).toBe("application/problem+json");
        await expect(response.json()).resolves.toMatchObject({
          status: testCase.status,
          code: testCase.code,
          detail: testCase.detail,
        });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
    } finally {
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent bundle upload with bounded retry guidance before reading its body", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "caplets-router-upload-capacity-test-"));
    const admission = new AdminBundleUploadAdmissionController({
      stagingDir,
      maxConcurrent: 1,
    });
    const activeLease = await admission.acquire();
    let bodyPulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyPulls += 1;
          throw new Error("Capacity-rejected request body must not be read.");
        },
      },
      { highWaterMark: 0 },
    );
    const execute = vi.fn(async () => {
      throw new Error("Capacity-rejected upload must not execute.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: {
        claim: vi.fn(async () => {
          throw new Error("Capacity-rejected upload must not claim idempotency.");
        }),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const requestInit: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: {
        "content-type": "multipart/form-data; boundary=capacity",
        "content-length": "1",
        "Idempotency-Key": "bundle-capacity",
        "If-None-Match": "*",
      },
      body,
      duplex: "half",
    };

    try {
      const response = await app.request(
        "https://host.example/caplet-records/demo/bundle",
        requestInit,
      );

      expect(response.status, await response.clone().text()).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const retryAfter = Number(response.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      await expect(response.json()).resolves.toMatchObject({
        status: 429,
        code: "UPLOAD_CAPACITY_EXCEEDED",
        type: "urn:caplets:problem:too-many-requests",
      });
      expect(bodyPulls).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await activeLease.cleanup();
      await admission.close();
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  it("reports unavailable upload staging infrastructure as 503 without retry guidance", async () => {
    const stagingParent = await mkdtemp(join(tmpdir(), "caplets-router-upload-staging-test-"));
    const stagingPath = join(stagingParent, "not-a-directory");
    await writeFile(stagingPath, "occupied");
    const admission = new AdminBundleUploadAdmissionController({ stagingDir: stagingPath });
    const execute = vi.fn(async () => {
      throw new Error("Infrastructure-rejected upload must not execute.");
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      bundleUploadAdmission: admission,
      idempotencyStore: {
        claim: vi.fn(async () => {
          throw new Error("Infrastructure-rejected upload must not claim idempotency.");
        }),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    try {
      const response = await app.request("https://host.example/caplet-records/demo/bundle", {
        method: "PUT",
        headers: {
          "content-type": "multipart/form-data; boundary=staging",
          "content-length": "1",
          "Idempotency-Key": "bundle-staging",
          "If-None-Match": "*",
        },
        body: new Uint8Array([0]),
      });

      expect(response.status, await response.clone().text()).toBe(503);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        status: 503,
        code: "SERVER_UNAVAILABLE",
        type: "urn:caplets:problem:service-unavailable",
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await admission.close();
      await rm(stagingParent, { recursive: true, force: true });
    }
  });

  it("streams bundle exports and cancels the active source when the consumer disconnects", async () => {
    const file = new TextEncoder().encode("streamed");
    let cancelled = false;
    const source = {
      path: "data.txt",
      size: file.byteLength,
      sha256: createHash("sha256").update(file).digest("hex"),
      executable: false,
      open: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(file);
          },
          cancel() {
            cancelled = true;
          },
        }),
    };
    const app = createAdminV2Router({
      operations: operationsWith(async () => ({
        kind: "stored_caplet_bundle_get",
        record: { id: "demo", generation: 3 },
        sources: [source],
      })),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/caplet-records/demo/bundle");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary=/);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="demo.bundle"');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    await reader.cancel("disconnect");
    expect(cancelled).toBe(true);
  });

  it("frames initial and subsequent semantic Host events as SSE and cancels the source", async () => {
    let sourceController!: ReadableStreamDefaultController<{
      type: "runtime_health";
      runtime: { status: "ok" | "error"; version: string; reason?: string };
      projectBinding: { state: "connected" | "disconnected" };
    }>;
    const sourceCancelled = vi.fn();
    const runtimeEvents = vi.fn(
      () =>
        new ReadableStream({
          start(controller) {
            sourceController = controller;
            controller.enqueue({
              type: "runtime_health",
              runtime: { status: "ok", version: "test" },
              projectBinding: { state: "disconnected" },
            });
          },
          cancel(reason) {
            sourceCancelled(reason);
          },
        }),
    );
    const app = createAdminV2Router({
      operations: operationsWith(vi.fn(), runtimeEvents),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request("https://host.example/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    sourceController.enqueue({
      type: "runtime_health",
      runtime: { status: "error", version: "test", reason: "daemon unavailable" },
      projectBinding: { state: "connected" },
    });

    const reader = response.body!.getReader();
    const parsed = await readSseEvents(reader, 2);
    expect(parsed.events).toEqual([
      {
        event: "runtime",
        data: {
          type: "runtime_health",
          runtime: { status: "ok", version: "test" },
          projectBinding: { state: "disconnected" },
        },
      },
      {
        event: "runtime",
        data: {
          type: "runtime_health",
          runtime: { status: "error", version: "test", reason: "daemon unavailable" },
          projectBinding: { state: "connected" },
        },
      },
    ]);
    for (const event of parsed.events) {
      expect(adminRuntimeEventSchema.safeParse(event.data).success).toBe(true);
    }
    const validEvent = parsed.events[0]!.data;
    if (!validEvent || typeof validEvent !== "object" || Array.isArray(validEvent)) {
      throw new Error("Expected an object Admin runtime event.");
    }
    expect(adminRuntimeEventSchema.safeParse({ ...validEvent, unexpected: true }).success).toBe(
      false,
    );
    expect(
      adminRuntimeEventSchema.safeParse({
        ...validEvent,
        runtime: { status: "ok", version: "test", unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      adminRuntimeEventSchema.safeParse({
        ...validEvent,
        projectBinding: { state: "disconnected", unexpected: true },
      }).success,
    ).toBe(false);
    expect(parsed.decoded).not.toContain("\\n");

    await reader.cancel("disconnect");
    expect(runtimeEvents).toHaveBeenCalledWith(principal);
    expect(sourceCancelled).toHaveBeenCalledWith("disconnect");
  });
  it("creates and replaces path-keyed Caplet Installations with the matching precondition", async () => {
    const installation = (installationKey: string, generation: number) => ({
      installationKey,
      capletId: "demo",
      recordKey: "record-demo",
      generation,
      status: "active" as const,
      sourceKind: "git",
      sourceIdentity: "https://example.com/demo.git",
      channel: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
      detachedAt: null,
      detachedBy: null,
    });
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_installation_get") {
        return {
          kind: operation.kind,
          status: "found",
          installation: installation(
            String(operation.installationKey),
            operation.installationKey === "replacement-generated" ? 1 : 7,
          ),
        };
      }
      if (operation.kind === "stored_caplet_installation_put") {
        return {
          kind: operation.kind,
          status: operation.createOnly ? "created" : "replaced",
          installation: installation(
            operation.createOnly ? String(operation.installationKey) : "replacement-generated",
            1,
          ),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const store = {
      claim: vi.fn(async () => ({
        outcome: "acquired" as const,
        ownerToken: "owner-1",
        expiresAt: "2026-07-20T12:01:00.000Z",
      })),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(async () => true),
    };
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const body = JSON.stringify({
      sourceKind: "git",
      sourceIdentity: "https://example.com/demo.git",
    });

    const created = await app.request(
      "https://host.example/caplet-records/demo/installations/new",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "installation-create",
          "If-None-Match": "*",
        },
        body,
      },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/caplet-records/demo/installations/new");
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "stored_caplet_installation_put",
      id: "demo",
      installationKey: "new",
      createOnly: true,
      sourceKind: "git",
      sourceIdentity: "https://example.com/demo.git",
    });

    const current = await app.request(
      "https://host.example/caplet-records/demo/installations/existing",
    );
    const replaced = await app.request(
      "https://host.example/caplet-records/demo/installations/existing",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "installation-replace",
          "If-Match": current.headers.get("etag")!,
        },
        body,
      },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("location")).toBe(
      "/caplet-records/demo/installations/replacement-generated",
    );
    const replacementResource = await app.request(
      "https://host.example/caplet-records/demo/installations/replacement-generated",
    );
    expect(replaced.headers.get("etag")).toBe(replacementResource.headers.get("etag"));
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "stored_caplet_installation_put",
      id: "demo",
      installationKey: "existing",
      expectedGeneration: 7,
      sourceKind: "git",
      sourceIdentity: "https://example.com/demo.git",
    });
  });

  it("threads Vault resource versions and backend generations through conditional mutations", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      switch (operation.kind) {
        case "vault_access_list":
          return {
            kind: "vault_access_list",
            grants: [
              {
                storedKey: "secret",
                referenceName: "token",
                capletId: "demo",
                origin: { kind: "operator" },
                resourceVersion: "rv-1",
                createdAt: "2026-07-20T12:00:00.000Z",
                updatedAt: "2026-07-20T12:00:00.000Z",
              },
            ],
          };
        case "vault_access_grant":
          return {
            kind: "vault_access_grant",
            grant: {
              storedKey: "secret",
              referenceName: "token",
              capletId: "demo",
              origin: { kind: "operator" },
              resourceVersion: "rv-2",
              createdAt: "2026-07-20T12:00:00.000Z",
              updatedAt: "2026-07-20T12:01:00.000Z",
            },
          };
        case "vault_access_revoke":
          return {
            kind: "vault_access_revoke",
            revoked: [
              {
                storedKey: "secret",
                referenceName: "token",
                capletId: "demo",
                origin: { kind: "operator" },
                resourceVersion: "rv-1",
                createdAt: "2026-07-20T12:00:00.000Z",
                updatedAt: "2026-07-20T12:00:00.000Z",
              },
            ],
          };
        case "backend_auth_connection_get":
          return {
            kind: "backend_auth_connection_get",
            connection: {
              server: "server-a",
              generation: 4,
              status: "authenticated",
            },
          };
        case "backend_auth_refresh":
          return {
            kind: "backend_auth_refresh",
            connection: {
              server: "server-a",
              generation: 5,
              status: "authenticated",
            },
          };
        default:
          throw new Error(`unexpected ${operation.kind}`);
      }
    });
    const store = {
      claim: vi.fn(async () => ({
        outcome: "acquired" as const,
        ownerToken: "owner-1",
        expiresAt: "2026-07-20T12:01:00.000Z",
      })),
      heartbeat: vi.fn(async () => true),
      finalize: vi.fn(async () => true),
    };
    const principalProvider = vi.fn(async () => principal);
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider,
      idempotencyStore: store,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const detail = await app.request("https://host.example/vault-values/secret/grants/demo/token");
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      storedKey: "secret",
      capletId: "demo",
      referenceName: "token",
      resourceVersion: "rv-1",
    });
    const grantEtag = detail.headers.get("etag");
    expect(grantEtag).toBe(
      resourceEtag("admin-vault-grant", JSON.stringify(["secret", "demo", "token"]), "rv-1"),
    );
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_access_list",
      storedKey: "secret",
      capletId: "demo",
      referenceName: "token",
    });

    const grant = await app.request("https://host.example/vault-values/secret/grants/demo/token", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "grant-update",
        "If-Match": grantEtag!,
      },
      body: "{}",
    });
    expect(grant.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_access_grant",
      storedKey: "secret",
      capletId: "demo",
      referenceName: "token",
      expectedResourceVersion: "rv-1",
    });

    const revoked = await app.request(
      "https://host.example/vault-values/secret/grants/demo/token",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "grant-revoke",
          "If-Match": grantEtag!,
        },
      },
    );
    expect(revoked.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_access_revoke",
      storedKey: "secret",
      capletId: "demo",
      referenceName: "token",
      expectedResourceVersion: "rv-1",
    });

    const refreshed = await app.request("https://host.example/backend-auth-refreshes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "refresh-server-a",
        "If-Match": resourceEtag("admin-backend-auth-connection", "server-a", 4),
      },
      body: JSON.stringify({ serverId: "server-a" }),
    });
    expect(refreshed.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "backend_auth_refresh",
      server: "server-a",
      expectedGeneration: 4,
    });
    expect(principalProvider).toHaveBeenCalledWith(expect.any(Request), { mutates: true });
  });
  it("returns a no-store 404 Problem for an absent Vault grant detail", async () => {
    const execute = vi.fn(async () => ({ kind: "vault_access_list", grants: [] }));
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const response = await app.request(
      "https://host.example/vault-values/secret/grants/demo/missing",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      status: 404,
      code: "SERVER_NOT_FOUND",
    });
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "vault_access_list",
      storedKey: "secret",
      capletId: "demo",
      referenceName: "missing",
    });
  });

  it("scopes strong Caplet Record ETags to the concrete record identity", async () => {
    let betaGeneration = 7;
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture(
            String(operation.id),
            operation.id === "beta" ? betaGeneration : 7,
          ),
          document: "current",
        };
      }
      if (operation.kind === "stored_caplet_update") {
        betaGeneration = 8;
        return {
          kind: "stored_caplet_update",
          record: recordOutcomeFixture(String(operation.id), 8),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-resource-etag",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const alpha = await app.request("https://host.example/caplet-records/alpha");
    const beta = await app.request("https://host.example/caplet-records/beta");
    expect(alpha.headers.get("etag")).not.toBe(beta.headers.get("etag"));

    const siblingValidator = await app.request("https://host.example/caplet-records/beta", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "cross-resource-etag",
        "If-Match": alpha.headers.get("etag")!,
      },
      body: JSON.stringify({ document: "changed" }),
    });
    expect(siblingValidator.status).toBe(412);
    expect(execute.mock.calls.map(([, operation]) => operation.kind)).not.toContain(
      "stored_caplet_update",
    );

    const exactValidator = await app.request("https://host.example/caplet-records/beta", {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "exact-resource-etag",
        "If-Match": beta.headers.get("etag")!,
      },
      body: JSON.stringify({ document: "changed" }),
    });
    expect(exactValidator.status).toBe(200);
    const replacement = await app.request("https://host.example/caplet-records/beta");
    expect(exactValidator.headers.get("etag")).toBe(replacement.headers.get("etag"));
  });

  it("validates observation POSTs against the active installation without creation preconditions", async () => {
    const installation = {
      installationKey: "active-installation",
      capletId: "demo",
      recordKey: "record-demo",
      generation: 4,
      status: "active" as const,
      sourceKind: "git",
      sourceIdentity: "https://example.com/demo.git",
      channel: null,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
      detachedAt: null,
      detachedBy: null,
    };
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("demo", 4),
          document: "current",
        };
      }
      if (operation.kind === "stored_caplet_installation_get") {
        return {
          kind: "stored_caplet_installation_get",
          status: "found",
          installation,
        };
      }
      if (operation.kind === "stored_caplet_installation_observe") {
        return {
          kind: "stored_caplet_installation_observe",
          observation: {
            observationKey: "observation-1",
            installationKey: installation.installationKey,
            resolvedRevision: null,
            contentHash: null,
            status: "current",
            observedAt: "2026-07-20T12:01:00.000Z",
          },
          installation: { ...installation, generation: 5 },
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-observation",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const record = await app.request("https://host.example/caplet-records/demo");
    const parentValidator = await app.request(
      "https://host.example/caplet-records/demo/installation-observations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "observe-with-parent-etag",
          "If-Match": record.headers.get("etag")!,
        },
        body: JSON.stringify({ status: "current" }),
      },
    );
    expect(parentValidator.status).toBe(412);

    const active = await app.request(
      "https://host.example/caplet-records/demo/installations/active-installation",
    );
    const response = await app.request(
      "https://host.example/caplet-records/demo/installation-observations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "observe-active-installation",
          "If-Match": active.headers.get("etag")!,
        },
        body: JSON.stringify({ status: "current" }),
      },
    );

    expect(response.status).toBe(201);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "stored_caplet_installation_get",
      id: "demo",
    });
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_installation_observe",
      id: "demo",
      expectedGeneration: 4,
      status: "current",
    });
  });

  it("validates revision deletion with the revision ETag and CASes the parent head", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind === "stored_caplet_get") {
        const record = recordOutcomeFixture("demo", 8);
        return {
          kind: "stored_caplet_get",
          record:
            operation.revisionKey === undefined
              ? record
              : {
                  ...record,
                  currentRevision: {
                    ...record.currentRevision,
                    revisionKey: String(operation.revisionKey),
                  },
                },
          document: "current",
        };
      }
      if (operation.kind === "stored_caplet_delete_revision") {
        return {
          kind: "stored_caplet_delete_revision",
          record: recordOutcomeFixture("demo", 9),
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const claim = vi.fn(
      async (_input: { idempotencyKey: string; requestFingerprintSource: string }) => ({
        outcome: "acquired" as const,
        ownerToken: "owner-delete-revision",
        expiresAt: "2026-07-20T12:01:00.000Z",
      }),
    );
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim,
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    const parent = await app.request("https://host.example/caplet-records/demo");
    const revision = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
    );
    const missingParent = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "delete-historical-revision-missing-parent",
          "If-Match": revision.headers.get("etag")!,
        },
      },
    );
    expect(missingParent.status).toBe(428);
    await expect(missingParent.json()).resolves.toMatchObject({
      status: 428,
      code: "PRECONDITION_REQUIRED",
    });
    const response = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "delete-historical-revision",
          "If-Match": revision.headers.get("etag")!,
          "X-Caplets-Parent-If-Match": parent.headers.get("etag")!,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(principal, {
      kind: "stored_caplet_get",
      id: "demo",
      revisionKey: "revision-historical",
    });
    expect(execute).toHaveBeenLastCalledWith(principal, {
      kind: "stored_caplet_delete_revision",
      id: "demo",
      revisionKey: "revision-historical",
      expectedGeneration: 8,
    });
    const staleParent = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "delete-historical-revision-stale-parent",
          "If-Match": revision.headers.get("etag")!,
          "X-Caplets-Parent-If-Match": '"stale-parent"',
        },
      },
    );
    expect(staleParent.status).toBe(412);
    const currentClaim = claim.mock.calls.find(
      ([input]) => input.idempotencyKey === "delete-historical-revision",
    )?.[0];
    const staleClaim = claim.mock.calls.find(
      ([input]) => input.idempotencyKey === "delete-historical-revision-stale-parent",
    )?.[0];
    if (!currentClaim || !staleClaim) throw new Error("Expected both revision delete claims.");
    expect(currentClaim.requestFingerprintSource).not.toBe(staleClaim.requestFingerprintSource);
  });

  it("rejects revision deletion when the parent advances after client preflight", async () => {
    let parentReads = 0;
    const execute = vi.fn(async (_principal, operation) => {
      if (operation.kind !== "stored_caplet_get") {
        throw new Error(`unexpected ${operation.kind}`);
      }
      if (operation.revisionKey !== undefined) {
        const record = recordOutcomeFixture("demo", 8);
        return {
          kind: "stored_caplet_get" as const,
          record: {
            ...record,
            currentRevision: {
              ...record.currentRevision,
              revisionKey: String(operation.revisionKey),
            },
          },
          document: "historical",
        };
      }
      parentReads += 1;
      return {
        kind: "stored_caplet_get" as const,
        record: recordOutcomeFixture("demo", parentReads === 1 ? 7 : 8),
        document: "current",
      };
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-delete-revision-parent-race",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const parent = await app.request("https://host.example/caplet-records/demo");
    const revision = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
    );

    const response = await app.request(
      "https://host.example/caplet-records/demo/revisions/revision-historical",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "delete-historical-revision-parent-race",
          "If-Match": revision.headers.get("etag")!,
          "X-Caplets-Parent-If-Match": parent.headers.get("etag")!,
        },
      },
    );

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      status: 412,
      code: "PRECONDITION_FAILED",
    });
    expect(execute).not.toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ kind: "stored_caplet_delete_revision" }),
    );
  });

  it.each(["/v2/admin", "/dashboard/api/v2"])(
    "qualifies renamed resource locations with the active %s mount",
    async (mount) => {
      const execute = vi.fn(async (_principal, operation) => {
        if (operation.kind === "stored_caplet_get") {
          return {
            kind: "stored_caplet_get",
            record: recordOutcomeFixture("old-id", 7),
            document: "old",
          };
        }
        if (operation.kind === "stored_caplet_update") {
          return {
            kind: "stored_caplet_update",
            record: recordOutcomeFixture("new-id", 8),
          };
        }
        throw new Error(`unexpected ${operation.kind}`);
      });
      const router = createAdminV2Router({
        operations: operationsWith(execute),
        principalProvider: async () => principal,
        idempotencyStore: {
          claim: vi.fn(async () => ({
            outcome: "acquired" as const,
            ownerToken: `owner-mounted-rename-${mount}`,
            expiresAt: "2026-07-20T12:01:00.000Z",
          })),
          heartbeat: vi.fn(async () => true),
          finalize: vi.fn(async () => true),
        },
        host: {
          baseUrl: "https://host.example",
          dashboardUrl: "https://host.example/dashboard",
          dashboardPath: "/dashboard",
          bind: "127.0.0.1:5387",
        },
      });
      const app = new Hono().route(mount, router);
      const current = await app.request(`https://host.example${mount}/caplet-records/old-id`);
      const response = await app.request(`https://host.example${mount}/caplet-records/old-id`, {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": `rename-${mount}`,
          "If-Match": current.headers.get("etag")!,
        },
        body: JSON.stringify({ id: "new-id" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBe(`${mount}/caplet-records/new-id`);
    },
  );

  it("returns canonical mounted locations for created backend-auth flows", async () => {
    const router = createAdminV2Router({
      operations: operationsWith(
        vi.fn(async (_principal, operation) => {
          if (operation.kind !== "backend_auth_flow_start") {
            throw new Error(`unexpected ${operation.kind}`);
          }
          return {
            kind: "backend_auth_flow_start",
            server: "server-a",
            flowId: "flow-created",
            authorizationUrl: "https://provider.example/authorize",
          };
        }),
      ),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-backend-flow",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const app = new Hono().route("/v2/admin", router);
    const response = await app.request("https://host.example/v2/admin/backend-auth-flows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "create-backend-flow",
        "If-None-Match": "*",
      },
      body: JSON.stringify({ serverId: "server-a" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/v2/admin/backend-auth-flows/flow-created");
  });

  it("persists mount-qualified idempotency reconciliation links", async () => {
    const claim = vi.fn(async (input: { reconciliationLinks?: readonly string[] | undefined }) => ({
      outcome: "unknown" as const,
      reconciliationLinks: [...(input.reconciliationLinks ?? [])],
    }));
    const router = createAdminV2Router({
      operations: operationsWith(vi.fn()),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim,
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });
    const app = new Hono().route("/dashboard/api/v2", router);
    const response = await app.request(
      "https://host.example/dashboard/api/v2/caplet-records/old-id",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": "mounted-unknown-rename",
          "If-Match": '"opaque-current-validator"',
        },
        body: JSON.stringify({ id: "new-id" }),
      },
    );
    const problem = (await response.json()) as { links: Record<string, string> };

    expect(response.status).toBe(409);
    expect(Object.values(problem.links)).toEqual([
      "/dashboard/api/v2/caplet-records/new-id",
      "/dashboard/api/v2/caplet-records/old-id",
    ]);
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliationLinks: [
          "/dashboard/api/v2/caplet-records/new-id",
          "/dashboard/api/v2/caplet-records/old-id",
        ],
      }),
    );
  });

  it("returns 404 for missing nested record resources and mutation targets", async () => {
    const execute = vi.fn(async (_principal, operation) => {
      if (
        operation.kind === "stored_caplet_revisions_page" ||
        operation.kind === "stored_caplet_installations_page" ||
        operation.kind === "stored_caplet_installation_put" ||
        operation.kind === "stored_caplet_restore_revision"
      ) {
        throw new CapletsError("CONFIG_NOT_FOUND", "The requested nested resource was not found.");
      }
      if (operation.kind === "stored_caplet_get") {
        if (operation.revisionKey !== undefined) {
          throw new CapletsError("SERVER_NOT_FOUND", "The requested revision was not found.");
        }
        return {
          kind: "stored_caplet_get",
          record: recordOutcomeFixture("demo", 7),
          document: "current",
        };
      }
      throw new Error(`unexpected ${operation.kind}`);
    });
    const app = createAdminV2Router({
      operations: operationsWith(execute),
      principalProvider: async () => principal,
      idempotencyStore: {
        claim: vi.fn(async () => ({
          outcome: "acquired" as const,
          ownerToken: "owner-missing-nested-resource",
          expiresAt: "2026-07-20T12:01:00.000Z",
        })),
        heartbeat: vi.fn(async () => true),
        finalize: vi.fn(async () => true),
      },
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

    for (const path of [
      "/caplet-records/missing/revisions",
      "/caplet-records/missing/installations",
    ]) {
      const response = await app.request(`https://host.example${path}`);
      expect(response.status).toBe(404);
    }

    const missingInstallation = await app.request(
      "https://host.example/caplet-records/missing/installations/new-installation",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "install-under-missing-parent",
          "If-None-Match": "*",
        },
        body: JSON.stringify({
          sourceKind: "git",
          sourceIdentity: "https://example.com/missing.git",
        }),
      },
    );
    expect(missingInstallation.status).toBe(404);

    const current = await app.request("https://host.example/caplet-records/demo");
    const missingRestore = await app.request(
      "https://host.example/caplet-records/demo/current-revision",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "restore-missing-revision",
          "If-Match": current.headers.get("etag")!,
        },
        body: JSON.stringify({ revisionKey: "missing-revision" }),
      },
    );
    expect(missingRestore.status).toBe(404);

    const missingDelete = await app.request(
      "https://host.example/caplet-records/demo/revisions/missing-revision",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "delete-missing-revision",
          "If-Match": '"opaque-revision-validator"',
          "X-Caplets-Parent-If-Match": current.headers.get("etag")!,
        },
      },
    );
    expect(missingDelete.status).toBe(404);
  });

  it("keeps the complete relative route table bound to explicit semantic discriminants", () => {
    const actual = Object.fromEntries(
      ADMIN_V2_ROUTE_DEFINITIONS.map((route) => [
        `${route.method.toUpperCase()} ${route.relativePath}`,
        [...route.operationKinds],
      ]),
    );
    expect(actual).toEqual({
      "GET /host": ["summary"],
      "GET /runtime": ["runtime"],
      "POST /runtime-restarts": ["runtime_restart"],
      "GET /logs": ["logs"],
      "GET /diagnostics": ["diagnostics"],
      "GET /project-binding": ["project_binding"],
      "GET /events": ["runtime_event"],
      "GET /activity": ["activity_page"],
      "GET /caplets": ["caplets_page"],
      "GET /catalog/entries": ["catalog_entries_page"],
      "GET /catalog/entries/{entryKey}": ["catalog_detail"],
      "GET /catalog/update-candidates": ["catalog_update_candidates_page"],
      "POST /catalog/installations": ["catalog_install"],
      "POST /catalog/update-runs": ["catalog_update"],
      "GET /remote-clients": ["remote_clients_page"],
      "GET /remote-clients/{clientId}": ["remote_client_get"],
      "PATCH /remote-clients/{clientId}": ["client_change_role"],
      "DELETE /remote-clients/{clientId}": ["client_revoke"],
      "GET /remote-login-requests": ["remote_login_requests_page"],
      "GET /remote-login-requests/{flowId}": ["remote_login_request_get"],
      "PATCH /remote-login-requests/{flowId}": ["pending_login_approve", "pending_login_deny"],
      "GET /backend-auth-connections": ["backend_auth_connections_page"],
      "GET /backend-auth-connections/{serverId}": ["backend_auth_connection_get"],
      "DELETE /backend-auth-connections/{serverId}": ["backend_auth_connection_delete"],
      "POST /backend-auth-flows": ["backend_auth_flow_start"],
      "GET /backend-auth-flows/{flowId}": ["backend_auth_flow_get"],
      "POST /backend-auth-refreshes": ["backend_auth_refresh"],
      "GET /vault-values": ["vault_values_page"],
      "GET /vault-values/{storedKey}": ["vault_get"],
      "PUT /vault-values/{storedKey}": ["vault_set"],
      "DELETE /vault-values/{storedKey}": ["vault_delete"],
      "GET /vault-grants": ["vault_grants_page"],
      "GET /vault-values/{storedKey}/grants": ["vault_grants_page"],
      "GET /vault-values/{storedKey}/grants/{capletId}/{referenceName}": ["vault_access_list"],
      "PUT /vault-values/{storedKey}/grants/{capletId}/{referenceName}": ["vault_access_grant"],
      "DELETE /vault-values/{storedKey}/grants/{capletId}/{referenceName}": ["vault_access_revoke"],
      "GET /caplet-records": ["stored_caplets_page"],
      "GET /caplet-records/{id}": ["stored_caplet_get"],
      "PATCH /caplet-records/{id}": ["stored_caplet_update"],
      "DELETE /caplet-records/{id}": ["stored_caplet_delete"],
      "GET /caplet-records/{id}/bundle": ["stored_caplet_bundle_get"],
      "PUT /caplet-records/{id}/bundle": [
        "stored_caplet_bundle_import",
        "stored_caplet_bundle_update",
      ],
      "GET /caplet-records/{id}/revisions": ["stored_caplet_revisions_page"],
      "GET /caplet-records/{id}/revisions/{revisionKey}": ["stored_caplet_get"],
      "GET /caplet-records/{id}/revisions/{revisionKey}/bundle": ["stored_caplet_bundle_get"],
      "DELETE /caplet-records/{id}/revisions/{revisionKey}": ["stored_caplet_delete_revision"],
      "PUT /caplet-records/{id}/current-revision": ["stored_caplet_restore_revision"],
      "GET /caplet-records/{id}/installations": ["stored_caplet_installations_page"],
      "GET /caplet-records/{id}/installation-observations": [
        "stored_caplet_installation_observations_page",
      ],
      "GET /caplet-records/{id}/installations/{installationKey}": [
        "stored_caplet_installation_get",
      ],
      "PUT /caplet-records/{id}/installations/{installationKey}": [
        "stored_caplet_installation_put",
      ],
      "DELETE /caplet-records/{id}/installations/{installationKey}": [
        "stored_caplet_installation_delete",
      ],
      "POST /caplet-records/{id}/installation-observations": ["stored_caplet_installation_observe"],
    });
  });
});
