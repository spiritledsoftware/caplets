import { describe, expect, it, vi } from "vitest";
import { createActivatedControlPlane } from "../src/control-plane/service";
import { createActivationFixture } from "./helpers/control-plane-activation";
import type { ControlPlaneStore } from "../src/control-plane/store";

const DEADLINES = Object.freeze({ detectionMs: 100, compositionMs: 200, publicationMs: 100 });

describe("control-plane degraded operation", () => {
  it("freezes one warm complete snapshot and fails every security or mutation path closed", async () => {
    const fixture = createActivationFixture();
    let acknowledgementCalls = 0;
    const canaryAcknowledgementCalls: number[] = [];
    const store = {
      ...fixture.store,
      async acknowledgeNode(input) {
        acknowledgementCalls += 1;
        return fixture.store.acknowledgeNode(input);
      },
    } satisfies ControlPlaneStore;
    const published: string[] = [];
    const activated = await createActivatedControlPlane({
      store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
      verifyReady() {
        canaryAcknowledgementCalls.push(acknowledgementCalls);
      },
      publish(snapshot) {
        published.push(snapshot.effectiveRuntimeFingerprint);
      },
    });

    fixture.setConnectivityFailure(true);
    await expect(activated.refresh()).rejects.toThrow("postgres unavailable");

    expect(activated.read("catalog-read")).toMatchObject({ stale: true });
    expect(activated.read("runtime-metadata-read")).toMatchObject({ stale: true });
    for (const operation of [
      "auth",
      "admin",
      "project-binding",
      "attach",
      "vault",
      "import",
      "export",
      "mutation",
    ] as const) {
      await expect(activated.requireLive(operation)).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    }

    const health = await activated.health();
    expect(health).toMatchObject({
      backend: "postgres",
      readiness: "stale-read-only",
      connectivity: "unavailable",
      convergence: "overdue",
      guidanceCode: "storage-unavailable",
    });
    expect(Object.keys(health).toSorted()).toEqual([
      "authorityToken",
      "backend",
      "bootstrapCompatibility",
      "connectivity",
      "convergence",
      "guidanceCode",
      "migration",
      "readiness",
      "staleAgeMs",
    ]);
    expect(JSON.stringify(health)).not.toMatch(
      /storeId|logicalHostId|fingerprint|keyId|material|backup|path|record/iu,
    );
    await expect(activated.detailedDiagnostics(async () => true)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(published).toEqual([]);

    fixture.setConnectivityFailure(false);
    await activated.refresh();
    expect(activated.read("catalog-read")).toMatchObject({ stale: false });
    await expect(activated.requireLive("mutation")).resolves.toMatchObject({
      leaseId: expect.any(String),
    });
    expect(published).toHaveLength(1);
    expect(canaryAcknowledgementCalls).toEqual([0, 1]);
    await activated.close();
  });

  it("publishes before acknowledgement but never exposes a rejected candidate", async () => {
    const fixture = createActivationFixture();
    const published: string[] = [];
    let acknowledgementCalls = 0;
    const store = {
      ...fixture.store,
      async acknowledgeNode(input) {
        acknowledgementCalls += 1;
        if (acknowledgementCalls === 1) return fixture.store.acknowledgeNode(input);
        return { status: "rejected", reason: "lease-revoked" } as const;
      },
    } satisfies ControlPlaneStore;
    const activated = await createActivatedControlPlane({
      store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
      publish(snapshot) {
        published.push(snapshot.effectiveRuntimeFingerprint);
      },
    });
    fixture.setToken({ authorityGeneration: 1, effectiveGeneration: 1, securityEpoch: 0 });

    await expect(activated.refresh()).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

    expect(published).toEqual(["a".repeat(56) + "0changed", "a".repeat(56) + "0initial"]);
    expect(fixture.stats().commitCount).toBe(0);
    expect(activated.read("catalog-read")).toMatchObject({
      stale: true,
      snapshot: { authorityGeneration: 0, effectiveGeneration: 0 },
    });
    await expect(activated.requireLive("mutation")).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await activated.close();
  });

  it("contains background node-sweep failures during a partition", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createActivationFixture();
      let sweepCalls = 0;
      const store = {
        ...fixture.store,
        async sweepOverdueNodes() {
          sweepCalls += 1;
          throw new Error("postgres unavailable");
        },
      } satisfies ControlPlaneStore;
      const activated = await createActivatedControlPlane({
        store,
        loader: fixture.loader,
        node: fixture.node,
        pollingIntervalMs: 1_000,
        deadlines: DEADLINES,
      });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(sweepCalls).toBe(1);
      await activated.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts timed-out publishers before a late runtime swap", async () => {
    const fixture = createActivationFixture();
    const release = Promise.withResolvers<void>();
    const published: string[] = [];
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
      async publish(snapshot, publication) {
        await release.promise;
        if (!publication.signal.aborted) published.push(snapshot.effectiveRuntimeFingerprint);
      },
    });
    fixture.setToken({ authorityGeneration: 1, effectiveGeneration: 1, securityEpoch: 0 });

    await expect(activated.refresh()).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    release.resolve();
    await release.promise;
    await Promise.resolve();

    expect(published).toEqual([]);
    expect(activated.current()).toMatchObject({
      authorityGeneration: 0,
      effectiveGeneration: 0,
    });
    await activated.close();
  });

  it("never extends the oldest coalesced refresh deadline for a newer wake", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createActivationFixture();
      let delayed = false;
      let advanced = false;
      const pause = (milliseconds: number) =>
        delayed ? new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) : undefined;
      const store = {
        ...fixture.store,
        async convergenceToken() {
          await pause(700);
          return fixture.store.convergenceToken();
        },
        async activationState() {
          await pause(700);
          return fixture.store.activationState();
        },
        async acknowledgeNode(input) {
          await pause(300);
          const result = await fixture.store.acknowledgeNode(input);
          if (delayed && !advanced && input.appliedToken.effectiveGeneration === 1) {
            advanced = true;
            fixture.setToken(
              { authorityGeneration: 1, effectiveGeneration: 2, securityEpoch: 0 },
              "two",
            );
          }
          return result;
        },
      } satisfies ControlPlaneStore;
      const loader = {
        ...fixture.loader,
        async reload(context: Parameters<typeof fixture.loader.reload>[0]) {
          await pause(900);
          return fixture.loader.reload(context);
        },
      };
      const activated = await createActivatedControlPlane({
        store,
        loader,
        node: fixture.node,
        pollingIntervalMs: 900,
        deadlines: { detectionMs: 750, compositionMs: 1_000, publicationMs: 375 },
        async verifyReady() {
          await pause(300);
        },
        async publish() {
          await pause(300);
        },
      });
      delayed = true;
      fixture.setToken({ authorityGeneration: 1, effectiveGeneration: 1, securityEpoch: 0 }, "one");
      const first = activated.refresh();
      const queued = activated.refresh();

      await vi.advanceTimersByTimeAsync(2_800);
      fixture.notify({ authorityGeneration: 1, effectiveGeneration: 2, securityEpoch: 0 });
      const coalesced = activated.refresh();
      expect(coalesced).toBe(queued);
      for (let step = 0; step < 20; step += 1) {
        await vi.advanceTimersByTimeAsync(500);
      }

      await expect(first).resolves.toBeDefined();
      await expect(queued).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      delayed = false;
      const closing = activated.close();
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces timed-out health reads so probes cannot exhaust the SQL pool", async () => {
    const fixture = createActivationFixture();
    const release = Promise.withResolvers<void>();
    let slow = false;
    let healthCalls = 0;
    const store = {
      ...fixture.store,
      async health() {
        healthCalls += 1;
        if (slow) await release.promise;
        return fixture.store.health();
      },
    } satisfies ControlPlaneStore;
    const activated = await createActivatedControlPlane({
      store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });
    slow = true;

    const [first, second] = await Promise.all([activated.health(), activated.health()]);
    expect(first).toMatchObject({ readiness: "stale-read-only" });
    expect(second).toMatchObject({ readiness: "stale-read-only" });
    expect(healthCalls).toBe(2);

    release.resolve();
    await activated.close();
  });

  it("rejects a timed-out startup transition and revokes only its lease epoch", async () => {
    const fixture = createActivationFixture();
    const release = Promise.withResolvers<void>();
    let revokedFence: Parameters<ControlPlaneStore["revokeNode"]>[1];
    const store = {
      ...fixture.store,
      async acknowledgeNode(input) {
        await release.promise;
        return fixture.store.acknowledgeNode(input);
      },
      async revokeNode(_nodeId, writerFence) {
        revokedFence = writerFence;
      },
    } satisfies ControlPlaneStore;
    const startup = createActivatedControlPlane({
      store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await new Promise((resolve) => setTimeout(resolve, DEADLINES.publicationMs + 10));
    const outcome = await startup;
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "SERVER_UNAVAILABLE" },
    });
    expect(revokedFence).toMatchObject({
      leaseId: `writer:${fixture.node.nodeId}`,
      writerEpoch: 1,
    });
    release.resolve();
  });

  it("does not persist activation or readiness when initial composition is invalid", async () => {
    const fixture = createActivationFixture();
    const initializeActivationFingerprint = vi.fn(fixture.store.initializeActivationFingerprint);
    const registerNode = vi.fn(fixture.store.registerNode);
    const initialize = vi.fn(async () => {
      throw new Error("invalid initial candidate");
    });

    await expect(
      createActivatedControlPlane({
        store: { ...fixture.store, initializeActivationFingerprint, registerNode },
        loader: { ...fixture.loader, initialize },
        node: fixture.node,
        pollingIntervalMs: 4_000,
        deadlines: DEADLINES,
      }),
    ).rejects.toThrow("invalid initial candidate");

    expect(initializeActivationFingerprint).not.toHaveBeenCalled();
    expect(registerNode).not.toHaveBeenCalled();
  });

  it("leaves a staged fingerprint untouched when its candidate is invalid", async () => {
    const fixture = createActivationFixture();
    const stagedFingerprint = "b".repeat(64);
    await fixture.store.stageNextFingerprint(stagedFingerprint);
    const initializeActivationFingerprint = vi.fn(fixture.store.initializeActivationFingerprint);
    const registerNode = vi.fn(fixture.store.registerNode);
    const initialize = vi.fn(async () => {
      throw new Error("invalid staged candidate");
    });

    await expect(
      createActivatedControlPlane({
        store: { ...fixture.store, initializeActivationFingerprint, registerNode },
        loader: { ...fixture.loader, initialize },
        node: { ...fixture.node, bootstrapFingerprint: stagedFingerprint },
        pollingIntervalMs: 4_000,
        deadlines: DEADLINES,
      }),
    ).rejects.toThrow("invalid staged candidate");

    expect(initializeActivationFingerprint).not.toHaveBeenCalled();
    expect(registerNode).not.toHaveBeenCalled();
    await expect(fixture.store.activationState()).resolves.toMatchObject({
      currentFingerprint: fixture.node.bootstrapFingerprint,
      nextFingerprint: stagedFingerprint,
    });
  });

  it("reloads a catching-up startup candidate until the node becomes ready", async () => {
    const fixture = createActivationFixture();
    fixture.setToken({
      authorityGeneration: 1,
      effectiveGeneration: 0,
      securityEpoch: 0,
    });

    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });

    expect(activated.current().authorityGeneration).toBe(1);
    expect(fixture.stats()).toEqual({ reloadCount: 1, commitCount: 1 });
    await activated.close();
  });

  it("rejects a stale security tuple before the next poll despite a valid writer fence", async () => {
    const fixture = createActivationFixture();
    let acknowledgementCalls = 0;
    const store = {
      ...fixture.store,
      async validateWriterFence() {
        return true;
      },
      async acknowledgeNode(input) {
        acknowledgementCalls += 1;
        return fixture.store.acknowledgeNode(input);
      },
    } satisfies ControlPlaneStore;
    const activated = await createActivatedControlPlane({
      store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });
    expect(acknowledgementCalls).toBe(1);
    fixture.setToken({
      authorityGeneration: 0,
      effectiveGeneration: 0,
      securityEpoch: 1,
    });

    await expect(activated.requireLive("vault")).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(acknowledgementCalls).toBe(2);
    await activated.close();
  });

  it("retains a healthy lease across sustained writes for longer than its TTL", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createActivationFixture();
      let registrations = 0;
      let leaseExpiresAt = 0;
      const store = {
        ...fixture.store,
        async registerNode(input) {
          registrations += 1;
          const result = await fixture.store.registerNode(input);
          if (result.status === "ready") {
            leaseExpiresAt = performance.now() + input.ttlMs;
          }
          return result;
        },
        async acknowledgeNode(input) {
          if (performance.now() >= leaseExpiresAt) {
            return { status: "rejected", reason: "lease-revoked" } as const;
          }
          return fixture.store.acknowledgeNode(input);
        },
      } satisfies ControlPlaneStore;
      const activated = await createActivatedControlPlane({
        store,
        loader: fixture.loader,
        node: { ...fixture.node, ttlMs: 3_000 },
        pollingIntervalMs: 4_000,
        deadlines: DEADLINES,
      });

      for (let index = 0; index < 21; index += 1) {
        await expect(activated.requireLive("mutation")).resolves.toMatchObject({
          leaseId: "writer:node-1",
        });
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(registrations).toBeGreaterThanOrEqual(10);
      await activated.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps heartbeat renewal monotonic when the wall clock rolls back", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createActivationFixture();
      let registrations = 0;
      const store = {
        ...fixture.store,
        async registerNode(input) {
          registrations += 1;
          return fixture.store.registerNode(input);
        },
      } satisfies ControlPlaneStore;
      const activated = await createActivatedControlPlane({
        store,
        loader: fixture.loader,
        node: { ...fixture.node, ttlMs: 3_000 },
        pollingIntervalMs: 1_000,
        deadlines: DEADLINES,
      });
      expect(registrations).toBe(1);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(registrations).toBeGreaterThanOrEqual(2);
      vi.setSystemTime(Date.now() - 60_000);
      await vi.advanceTimersByTimeAsync(3_001);

      expect(registrations).toBeGreaterThanOrEqual(4);
      await activated.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cold start unready and makes detailed diagnostics depend on live reauthorization", async () => {
    const cold = createActivationFixture();
    cold.setConnectivityFailure(true);
    await expect(
      createActivatedControlPlane({
        store: cold.store,
        loader: cold.loader,
        node: cold.node,
        pollingIntervalMs: 4_000,
        deadlines: DEADLINES,
      }),
    ).rejects.toThrow("postgres unavailable");

    const live = createActivationFixture();
    const activated = await createActivatedControlPlane({
      store: live.store,
      loader: live.loader,
      node: live.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });
    await expect(activated.detailedDiagnostics(async () => false)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await expect(
      activated.detailedDiagnostics(async () => {
        throw new Error("authorization backend unavailable");
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

    const diagnostics = await activated.detailedDiagnostics(async () => true);
    expect(diagnostics).toMatchObject({
      backend: "postgres",
      store: fixtureIdentity(),
      fingerprint: { currentFingerprint: "a".repeat(64) },
      keyCompatibility: {
        status: "compatible",
        activeVersion: 1,
        providerCommitmentPresent: true,
        canaryCommitmentPresent: true,
      },
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/credential|secret|keyMaterial|password/iu);
    await activated.close();
  });
});

function fixtureIdentity() {
  return {
    logicalHostId: "host_01J00000000000000000000000",
    storeId: "store_01J00000000000000000000000",
    operationNamespace: "operations_01J00000000000000000000000",
  };
}
