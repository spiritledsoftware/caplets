import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createAdminV2Router } from "../src/admin-api/router";
import type {
  CurrentHostOperations,
  CurrentHostOperatorPrincipal,
  CurrentHostPrincipal,
} from "../src/current-host/operations";
import {
  createHostStorage,
  MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
  type HostStorage,
} from "../src/storage";
import { MAX_BUNDLE_FILE_BYTES } from "../src/storage/caplet-records";

const principal: CurrentHostOperatorPrincipal = {
  clientId: "operator-1",
  hostUrl: "https://host.example",
  role: "operator",
};
const timestamp = "2026-07-20T12:00:00.000Z";

it("finalizes and replays a maximum-domain Caplet Record mutation response", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-large-idempotency-"));
  const databasePath = join(root, "caplets.sqlite3");
  const vaultRoot = join(root, "vault");
  let first: HostStorage | undefined;
  let second: HostStorage | undefined;
  let currentGeneration = 7;
  let updateExecutions = 0;
  const largeRecord = {
    recordKey: "record-demo",
    id: "demo",
    headGeneration: 8,
    historyLimit: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentRevision: {
      revisionKey: "revision-8",
      sequence: 8,
      name: "Demo",
      description: "",
      body: "x".repeat(MAX_BUNDLE_FILE_BYTES),
      schemaUrl: null,
      content: {},
      contentHash: "0".repeat(64),
      sourceRevision: null,
      sourceContentHash: null,
      createdAt: timestamp,
      actor: "operator-1",
      tags: [],
      backends: [],
      bundle: [],
    },
  };
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind === "stored_caplet_get") {
      return {
        kind: "stored_caplet_get" as const,
        record: {
          ...largeRecord,
          headGeneration: currentGeneration,
          currentRevision: {
            ...largeRecord.currentRevision,
            revisionKey: `revision-${currentGeneration}`,
            sequence: currentGeneration,
            body: "old",
          },
        },
        document: "old",
      };
    }
    if (operation.kind === "stored_caplet_update") {
      updateExecutions += 1;
      currentGeneration = 8;
      return { kind: "stored_caplet_update" as const, record: largeRecord };
    }
    throw new Error(`Unexpected operation ${operation.kind}`);
  };
  const operations = { execute } as unknown as CurrentHostOperations;
  const requestUrl = "https://host.example/caplet-records/demo";
  const router = (storage: HostStorage) =>
    createAdminV2Router({
      operations,
      principalProvider: async () => principal,
      idempotencyStore: storage.idempotency,
      host: {
        baseUrl: "https://host.example",
        dashboardUrl: "https://host.example/dashboard",
        dashboardPath: "/dashboard",
        bind: "127.0.0.1:5387",
      },
    });

  try {
    first = await createHostStorage({ type: "sqlite", path: databasePath }, { vaultRoot });
    const firstRouter = router(first);
    const current = await firstRouter.request(requestUrl);
    const currentEtag = current.headers.get("ETag");
    expect(current.status).toBe(200);
    expect(currentEtag).toBeTruthy();
    const requestInit = {
      method: "PATCH",
      headers: {
        "content-type": "application/merge-patch+json",
        "Idempotency-Key": "large-record-update",
        "If-Match": currentEtag!,
      },
      body: JSON.stringify({ document: "new" }),
    } satisfies RequestInit;
    const initial = await firstRouter.request(new Request(requestUrl, requestInit));
    expect(initial.status).toBe(200);
    const initialBody = await initial.text();
    expect(Buffer.byteLength(initialBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(initialBody)).not.toHaveProperty("currentRevision.body");

    await first.close();
    first = undefined;
    second = await createHostStorage({ type: "sqlite", path: databasePath }, { vaultRoot });
    const replay = await router(second).request(new Request(requestUrl, requestInit));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(initialBody);
    expect(updateExecutions).toBe(1);
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("finalizes and replays the maximum installation source identity and rejects one byte more", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-installation-idempotency-"));
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "caplets.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  let executions = 0;
  const maxSourceIdentityLength = 64 * 1024;
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind !== "stored_caplet_installation_put") {
      throw new Error(`Unexpected operation ${operation.kind}`);
    }
    executions += 1;
    return {
      kind: "stored_caplet_installation_put" as const,
      status: "created" as const,
      installation: {
        installationKey: "maximum",
        capletId: "demo",
        recordKey: "record-demo",
        generation: 1,
        status: "active" as const,
        sourceKind: "catalog",
        sourceIdentity: operation.sourceIdentity,
        channel: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        detachedAt: null,
        detachedBy: null,
      },
    };
  };
  const app = createAdminV2Router({
    operations: { execute } as unknown as CurrentHostOperations,
    principalProvider: async () => principal,
    idempotencyStore: storage.idempotency,
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
  const request = (key: string, sourceIdentity: string) =>
    app.request("https://host.example/caplet-records/demo/installations/maximum", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "If-None-Match": "*",
      },
      body: JSON.stringify({ sourceKind: "catalog", sourceIdentity }),
    });

  try {
    const maximum = await request("maximum-installation", "x".repeat(maxSourceIdentityLength));
    expect(maximum.status).toBe(201);
    const maximumBody = await maximum.text();
    expect(Buffer.byteLength(maximumBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(maximumBody)).not.toHaveProperty("sourceIdentity");

    const replay = await request("maximum-installation", "x".repeat(maxSourceIdentityLength));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(maximumBody);

    const overLimit = await request(
      "over-limit-installation",
      "x".repeat(maxSourceIdentityLength + 1),
    );
    expect(overLimit.status).toBe(400);
    expect(overLimit.headers.get("content-type")).toContain("application/problem+json");
    await expect(overLimit.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
    expect(executions).toBe(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds and durably replays catalog mutation summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-catalog-idempotency-"));
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "caplets.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  let executions = 0;
  const maximumRequestedCaplets = 500;
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind !== "catalog_update") {
      throw new Error(`Unexpected operation ${operation.kind}`);
    }
    executions += 1;
    return {
      kind: "catalog_update" as const,
      installed: Array.from({ length: maximumRequestedCaplets }, (_, index) => ({
        id: `caplet-${index}`,
        source: "s".repeat(32 * 1024),
        destination: "d".repeat(32 * 1024),
        kind: "file" as const,
        hash: "0".repeat(64),
        status: index === 0 ? ("content_updated" as const) : ("updated" as const),
        lockfile: "l".repeat(32 * 1024),
        catalogIndexing: {
          status: "accepted" as const,
          entryKey: `entry-${index}`,
          reason: "r".repeat(32 * 1024),
        },
      })),
      setupActions: Array.from({ length: 500 }, (_, index) => ({
        kind: "auth" as const,
        label: `Setup action ${index} ${"x".repeat(32 * 1024)}`,
        required: true,
      })),
    };
  };
  const app = createAdminV2Router({
    operations: { execute } as unknown as CurrentHostOperations,
    principalProvider: async () => principal,
    idempotencyStore: storage.idempotency,
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
  const request = (key: string, capletIds: string[]) =>
    app.request("https://host.example/catalog/update-runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "If-None-Match": "*",
      },
      body: JSON.stringify({ capletIds }),
    });
  const maximumIds = Array.from(
    { length: maximumRequestedCaplets },
    (_, index) => `caplet-${index}`,
  );

  try {
    const maximum = await request("maximum-catalog-update", maximumIds);
    expect(maximum.status).toBe(201);
    const maximumBody = await maximum.text();
    expect(Buffer.byteLength(maximumBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(maximumBody)).toMatchObject({
      installedCount: maximumRequestedCaplets,
      setupActionCount: 500,
    });

    const replay = await request("maximum-catalog-update", maximumIds);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(maximumBody);

    const overLimit = await request("over-limit-catalog-update", [...maximumIds, "one-too-many"]);
    expect(overLimit.status).toBe(400);
    expect(overLimit.headers.get("content-type")).toContain("application/problem+json");
    await expect(overLimit.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
    expect(executions).toBe(1);

    const overlongId = await request("overlong-catalog-id", [
      "x".repeat(129),
      ...maximumIds.slice(1),
    ]);
    expect(overlongId.status).toBe(400);
    expect(overlongId.headers.get("content-type")).toContain("application/problem+json");
    await expect(overlongId.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
    expect(executions).toBe(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("finalizes and replays a maximum installation risk and rejects one byte more", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-observation-idempotency-"));
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "caplets.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  let mutationExecutions = 0;
  const installation = {
    installationKey: "active-installation",
    capletId: "demo",
    recordKey: "record-demo",
    generation: 7,
    status: "active" as const,
    sourceKind: "catalog",
    sourceIdentity: "official/demo",
    channel: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    detachedAt: null,
    detachedBy: null,
  };
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind === "stored_caplet_installation_get") {
      return {
        kind: "stored_caplet_installation_get" as const,
        status: "found" as const,
        installation,
      };
    }
    if (operation.kind === "stored_caplet_installation_observe") {
      mutationExecutions += 1;
      return {
        kind: "stored_caplet_installation_observe" as const,
        observation: {
          observationKey: "observation-8",
          installationKey: installation.installationKey,
          resolvedRevision: "a".repeat(256),
          contentHash: "0".repeat(128),
          risk: operation.risk,
          status: "current" as const,
          observedAt: timestamp,
        },
        installation: { ...installation, generation: 8 },
      };
    }
    throw new Error(`Unexpected operation ${operation.kind}`);
  };
  const app = createAdminV2Router({
    operations: { execute } as unknown as CurrentHostOperations,
    principalProvider: async () => principal,
    idempotencyStore: storage.idempotency,
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
  const current = await app.request(
    "https://host.example/caplet-records/demo/installations/active-installation",
  );
  const currentEtag = current.headers.get("ETag");
  expect(current.status).toBe(200);
  expect(currentEtag).toBeTruthy();
  const maximumRisk = {
    backendFamilies: Array.from({ length: 64 }, () => "b".repeat(128)),
    safety: "local_control",
    projectBindingRequired: true,
    authScopes: Array.from({ length: 64 }, () => "a".repeat(512)),
    runtimeFeatures: Array.from({ length: 64 }, () => "r".repeat(512)),
    mutating: true,
    destructive: true,
    bodyHash: "0".repeat(128),
    referenceHash: "1".repeat(128),
  };
  const request = (key: string, risk: Record<string, unknown>) =>
    app.request("https://host.example/caplet-records/demo/installation-observations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "If-Match": currentEtag!,
      },
      body: JSON.stringify({
        status: "current",
        resolvedRevision: "a".repeat(256),
        contentHash: "0".repeat(128),
        risk,
      }),
    });

  try {
    const maximum = await request("maximum-observation", maximumRisk);
    expect(maximum.status).toBe(201);
    const maximumBody = await maximum.text();
    expect(Buffer.byteLength(maximumBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(maximumBody)).not.toHaveProperty("risk");

    const replay = await request("maximum-observation", maximumRisk);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(maximumBody);

    const overLimit = await request("over-limit-observation", {
      ...maximumRisk,
      authScopes: ["a".repeat(513)],
    });
    expect(overLimit.status).toBe(400);
    expect(overLimit.headers.get("content-type")).toContain("application/problem+json");
    await expect(overLimit.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
    expect(mutationExecutions).toBe(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("finalizes and replays a maximum backend authorization URL and rejects an overlong server", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-backend-flow-idempotency-"));
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "caplets.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  let executions = 0;
  const authorizationPrefix = "https://auth.example/";
  const authorizationUrl = authorizationPrefix + "x".repeat(32_768 - authorizationPrefix.length);
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind !== "backend_auth_flow_start") {
      throw new Error(`Unexpected operation ${operation.kind}`);
    }
    executions += 1;
    return {
      kind: "backend_auth_flow_start" as const,
      server: operation.server,
      flowId: "flow-1",
      authorizationUrl,
    };
  };
  const app = createAdminV2Router({
    operations: { execute } as unknown as CurrentHostOperations,
    principalProvider: async () => principal,
    idempotencyStore: storage.idempotency,
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
  const request = (key: string, serverId: string) =>
    app.request("https://host.example/backend-auth-flows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "If-None-Match": "*",
      },
      body: JSON.stringify({ serverId }),
    });
  const maximumServerId = "s".repeat(512);

  try {
    const maximum = await request("maximum-backend-flow", maximumServerId);
    expect(maximum.status).toBe(201);
    const maximumBody = await maximum.text();
    expect(Buffer.byteLength(maximumBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(maximumBody)).toMatchObject({ authorizationUrl });

    const replay = await request("maximum-backend-flow", maximumServerId);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(maximumBody);

    const overLimit = await request("over-limit-backend-flow", `${maximumServerId}x`);
    expect(overLimit.status).toBe(400);
    expect(overLimit.headers.get("content-type")).toContain("application/problem+json");
    await expect(overLimit.json()).resolves.toMatchObject({ code: "REQUEST_INVALID" });
    expect(executions).toBe(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("finalizes a bounded Problem when a semantic outcome violates the response contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "caplets-oversized-outcome-idempotency-"));
  const storage = await createHostStorage(
    { type: "sqlite", path: join(root, "caplets.sqlite3") },
    { vaultRoot: join(root, "vault") },
  );
  let executions = 0;
  const execute = async (
    _principal: CurrentHostPrincipal,
    operation: { kind: string } & Record<string, unknown>,
  ) => {
    if (operation.kind !== "backend_auth_flow_start") {
      throw new Error(`Unexpected operation ${operation.kind}`);
    }
    executions += 1;
    return {
      kind: "backend_auth_flow_start" as const,
      server: operation.server,
      flowId: "flow-oversized",
      authorizationUrl: "https://auth.example/" + "x".repeat(MAX_IDEMPOTENCY_FINAL_BODY_BYTES + 1),
    };
  };
  const app = createAdminV2Router({
    operations: { execute } as unknown as CurrentHostOperations,
    principalProvider: async () => principal,
    idempotencyStore: storage.idempotency,
    host: {
      baseUrl: "https://host.example",
      dashboardUrl: "https://host.example/dashboard",
      dashboardPath: "/dashboard",
      bind: "127.0.0.1:5387",
    },
  });
  const request = () =>
    app.request("https://host.example/backend-auth-flows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "oversized-semantic-outcome",
        "If-None-Match": "*",
      },
      body: JSON.stringify({ serverId: "backend" }),
    });

  try {
    const initial = await request();
    expect(initial.status).toBe(500);
    const initialBody = await initial.text();
    expect(Buffer.byteLength(initialBody, "utf8")).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
    );
    expect(JSON.parse(initialBody)).toMatchObject({ code: "INTERNAL_ERROR" });

    const replay = await request();
    expect(replay.status).toBe(500);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replay.text()).resolves.toBe(initialBody);
    expect(executions).toBe(1);
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
