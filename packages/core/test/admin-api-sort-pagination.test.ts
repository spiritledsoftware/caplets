import { describe, expect, it, vi } from "vitest";

import { createAdminV2Router } from "../src/admin-api/router";
import type {
  CurrentHostOperations,
  CurrentHostOperatorPrincipal,
  CurrentHostPrincipal,
} from "../src/current-host/operations";

const principal: CurrentHostOperatorPrincipal = {
  clientId: "operator-1",
  hostUrl: "https://host.example",
  role: "operator",
};

type ClientKey = {
  clientId: string;
  createdAt: string;
};

type Client = ClientKey & {
  role: "access" | "operator";
};

type ClientPageOperation = {
  kind: "remote_clients_page";
  limit: number;
  sort: "asc" | "desc";
  after?: ClientKey;
  role?: "access" | "operator";
  revoked?: boolean;
};

function compareClient(left: ClientKey, right: ClientKey): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.clientId.localeCompare(right.clientId)
  );
}

function operationsWith(
  execute: (principal: CurrentHostPrincipal, operation: ClientPageOperation) => Promise<unknown>,
): CurrentHostOperations {
  return { execute } as unknown as CurrentHostOperations;
}

function routerFor(
  execute: (principal: CurrentHostPrincipal, operation: ClientPageOperation) => Promise<unknown>,
) {
  return createAdminV2Router({
    operations: operationsWith(execute),
    authorityProvider: async () => ({ principal: await (async () => principal)() }),
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
}

describe("Admin v2 sort keyset pagination", () => {
  it("returns filtered descending pages without duplicates or gaps across intervening inserts and deletes", async () => {
    const clients: Client[] = [
      { clientId: "client-a", role: "operator", createdAt: "2026-07-20T12:00:00.000Z" },
      { clientId: "client-b", role: "operator", createdAt: "2026-07-20T12:00:00.000Z" },
      { clientId: "client-c", role: "access", createdAt: "2026-07-20T12:00:01.000Z" },
      { clientId: "client-d", role: "operator", createdAt: "2026-07-20T12:00:02.000Z" },
      { clientId: "client-e", role: "operator", createdAt: "2026-07-20T12:00:03.000Z" },
    ];
    const execute = vi.fn(
      async (_principal: CurrentHostPrincipal, operation: ClientPageOperation) => {
        const direction = operation.sort === "asc" ? 1 : -1;
        const ordered = clients
          .filter((client) => operation.role === undefined || client.role === operation.role)
          .filter((client) => {
            if (!operation.after) return true;
            return direction * compareClient(client, operation.after) > 0;
          })
          .sort((left, right) => direction * compareClient(left, right));
        const pageItems = ordered.slice(0, operation.limit);
        return {
          kind: "remote_clients_page",
          page: {
            items: pageItems,
            ...(ordered.length > operation.limit
              ? {
                  nextKey: {
                    createdAt: pageItems[pageItems.length - 1]!.createdAt,
                    clientId: pageItems[pageItems.length - 1]!.clientId,
                  },
                }
              : {}),
          },
        };
      },
    );
    const app = routerFor(execute);

    const firstResponse = await app.request(
      "https://host.example/remote-clients?limit=2&role=operator&sort=desc",
    );
    const first = (await firstResponse.json()) as { items: Client[]; nextCursor: string };
    expect(firstResponse.status).toBe(200);
    expect(first.items.map((client) => client.clientId)).toEqual(["client-e", "client-d"]);
    expect(execute).toHaveBeenLastCalledWith(
      principal,
      expect.objectContaining({ kind: "remote_clients_page", sort: "desc", role: "operator" }),
    );

    clients.push({
      clientId: "client-f",
      role: "operator",
      createdAt: "2026-07-20T12:00:04.000Z",
    });
    clients.splice(
      clients.findIndex((client) => client.clientId === "client-e"),
      1,
    );

    const secondResponse = await app.request(
      `https://host.example/remote-clients?limit=2&role=operator&sort=desc&cursor=${first.nextCursor}`,
    );
    const second = (await secondResponse.json()) as { items: Client[] };
    expect(secondResponse.status).toBe(200);
    expect(second.items.map((client) => client.clientId)).toEqual(["client-b", "client-a"]);
    expect([...first.items, ...second.items].map((client) => client.clientId)).toEqual([
      "client-e",
      "client-d",
      "client-b",
      "client-a",
    ]);
  });

  it("defaults to ascending and rejects a descending cursor reused across sort direction", async () => {
    const clients: Client[] = [
      { clientId: "client-a", role: "operator", createdAt: "2026-07-20T12:00:00.000Z" },
      { clientId: "client-b", role: "operator", createdAt: "2026-07-20T12:00:01.000Z" },
    ];
    const execute = vi.fn(
      async (_principal: CurrentHostPrincipal, operation: ClientPageOperation) => ({
        kind: "remote_clients_page",
        page: {
          items: [clients[operation.sort === "desc" ? 1 : 0]],
          nextKey: {
            createdAt: clients[operation.sort === "desc" ? 1 : 0]!.createdAt,
            clientId: clients[operation.sort === "desc" ? 1 : 0]!.clientId,
          },
        },
      }),
    );
    const app = routerFor(execute);

    const ascendingResponse = await app.request("https://host.example/remote-clients?limit=1");
    expect(ascendingResponse.status).toBe(200);
    expect(execute).toHaveBeenLastCalledWith(principal, expect.objectContaining({ sort: "asc" }));

    const descendingResponse = await app.request(
      "https://host.example/remote-clients?limit=1&sort=desc",
    );
    const descending = (await descendingResponse.json()) as { nextCursor: string };
    expect(descendingResponse.status).toBe(200);

    const rebound = await app.request(
      `https://host.example/remote-clients?limit=1&cursor=${descending.nextCursor}`,
    );
    expect(rebound.status).toBe(400);
    await expect(rebound.json()).resolves.toMatchObject({ status: 400, code: "REQUEST_INVALID" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
