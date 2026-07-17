import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeHttpApp } from "../src/cloud/runtime-http";
import { parseConfig, runtimeFingerprintForConfig } from "../src/config";
import {
  createInternalCloudRuntimeAdapter,
  type CloudRuntimeAdapter,
} from "../src/cloud/runtime-adapter";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "../src/control-plane/snapshot";
import type { ControlPlaneSecurityRepository } from "../src/control-plane/security/repository";
import { CapletsError } from "../src/errors";

describe("Cloud runtime adapter HTTP provenance boundary", () => {
  it("rejects runtime adapter calls without the runtime bearer token", async () => {
    const app = createRuntimeHttpApp({
      configPath: join(tmpdir(), "caplets-missing-config.json"),
      projectConfigPath: join(tmpdir(), "caplets-missing-project-config.json"),
      runtimeId: "runtime_1",
      sandboxId: "sandbox_1",
      executionKind: "cloud",
      token: "runtime_secret",
    });

    const response = await app.request("http://adapter.local/runtime/tools/list", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("never reports nominal readiness before SQL activation completes", async () => {
    const app = createRuntimeHttpApp({
      configPath: join(tmpdir(), "caplets-missing-config.json"),
      projectConfigPath: join(tmpdir(), "caplets-missing-project-config.json"),
      runtimeId: "runtime_unready",
      executionKind: "cloud",
      token: "runtime_secret",
    });

    const response = await app.request("http://adapter.local/healthz");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      runtimeId: "runtime_unready",
    });
  });
  it("returns 503 for authenticated live operations before SQL activation", async () => {
    const app = createRuntimeHttpApp({
      configPath: join(tmpdir(), "caplets-missing-config.json"),
      projectConfigPath: join(tmpdir(), "caplets-missing-project-config.json"),
      runtimeId: "runtime_unready",
      executionKind: "cloud",
      token: "runtime_secret",
    });
    const headers = {
      authorization: "Bearer runtime_secret",
      "content-type": "application/json",
    };

    for (const [path, body] of [
      ["/runtime/tools/list", undefined],
      [
        "/runtime/caplets/example/setup/run",
        JSON.stringify({ approved: true, actor: "automation" }),
      ],
    ] as const) {
      const response = await app.request(`http://adapter.local${path}`, {
        method: "POST",
        headers,
        ...(body ? { body } : {}),
      });
      expect(response.status, path).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "storage_unavailable" });
    }
  });

  it("retries SQL activation after a transient startup rejection", async () => {
    let attempts = 0;
    const readyAdapter = {
      listTools: async () => ({ tools: [{ name: "recovered" }] }),
    } as unknown as CloudRuntimeAdapter;
    const failedStartup = Promise.withResolvers<CloudRuntimeAdapter>();
    const app = createRuntimeHttpApp(
      {
        runtimeId: "runtime_retry",
        executionKind: "cloud",
        token: "runtime_secret",
      },
      {
        createAdapter() {
          attempts += 1;
          return attempts === 1 ? failedStartup.promise : Promise.resolve(readyAdapter);
        },
      },
    );
    const unavailableRequest = app.request("http://adapter.local/runtime/tools/list", {
      method: "POST",
      headers: { authorization: "Bearer runtime_secret" },
    });
    failedStartup.reject(new Error("transient SQL startup failure"));
    const unavailable = await unavailableRequest;
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "storage_unavailable" });
    const recovered = await app.request("http://adapter.local/runtime/tools/list", {
      method: "POST",
      headers: { authorization: "Bearer runtime_secret" },
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ tools: [{ name: "recovered" }] });
    expect(attempts).toBe(2);
  });

  it("redacts setup plans and labels warm degraded discovery while refusing live work", async () => {
    const config = parseConfig({
      cliTools: {
        secretSetup: {
          name: "Secret setup",
          description: "Exercises cloud setup safety.",
          setup: {
            commands: [
              {
                label: "Install",
                command: "installer",
                args: ["--token", "setup-secret"],
                env: { SETUP_TOKEN: "setup-secret" },
              },
            ],
          },
          actions: {
            run: { description: "Run.", command: "installer" },
          },
        },
      },
    });
    const snapshot = {
      config,
      configWithSources: {
        config,
        sources: {},
        runtimeFingerprint: runtimeFingerprintForConfig(config),
      },
      backend: "postgres",
      identity: {
        logicalHostId: "host-cloud-test",
        storeId: "store-cloud-test",
        operationNamespace: "namespace-cloud-test",
      },
      authorityGeneration: 7,
      effectiveGeneration: 8,
      securityEpoch: 9,
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "b".repeat(64),
      caplets: {},
      hostSettings: {},
      resolvedRuntimeInputs: {},
    } as unknown as ControlPlaneRuntimeSnapshot;
    const loader: ControlPlaneRuntimeSnapshotLoader = {
      initialize: async () => snapshot,
      reload: async () => snapshot,
      commit: () => true,
      current: () => snapshot,
    };
    const security = {
      getApproval: vi.fn(async () => undefined),
    } as unknown as ControlPlaneSecurityRepository;
    let degraded = false;
    const adapter = await createInternalCloudRuntimeAdapter(
      { runtimeId: "runtime-stale", executionKind: "cloud" },
      loader,
      {
        security,
        requireLive: async () => {
          if (degraded) {
            throw new CapletsError("SERVER_UNAVAILABLE", "Storage unavailable.");
          }
        },
        read: () => ({
          identity: snapshot.identity,
          snapshot,
          stale: degraded,
          ...(degraded ? { staleAgeMs: 2_000 } : {}),
        }),
      },
    );
    try {
      const plan = await adapter.setupPlan("secretSetup");
      expect(plan.commands).toEqual([
        {
          label: "Install",
          command: "installer",
          args: ["[REDACTED]", "[REDACTED]"],
          env: { SETUP_TOKEN: "[REDACTED]" },
        },
      ]);
      expect(JSON.stringify(plan)).not.toContain("setup-secret");

      degraded = true;
      await expect(adapter.listTools()).resolves.toMatchObject({
        _meta: {
          caplets: {
            availability: { stale: true, staleAgeMs: 2_000 },
          },
        },
      });
      for (const operation of [
        adapter.callTool("secretSetup", {}),
        adapter.checkBackend("secretSetup"),
        adapter.setupPlan("secretSetup"),
        adapter.runSetup("secretSetup", { approved: true, actor: "automation" }),
      ]) {
        await expect(operation).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      }
    } finally {
      await adapter.close();
    }
  });
});
