import { describe, expect, it, vi } from "vitest";

import {
  executeWithIdempotency,
  type IdempotencyExecutionStore,
} from "../src/admin-api/idempotency";
import type { IdempotencyClaimResult, IdempotencyFinalResponse } from "../src/storage/idempotency";

const response: IdempotencyFinalResponse = {
  status: 201,
  contentType: "application/json",
  body: '{"id":"created"}',
};

function storeWithClaim(claim: IdempotencyClaimResult): IdempotencyExecutionStore {
  return {
    claim: vi.fn().mockResolvedValue(claim),
    heartbeat: vi.fn().mockResolvedValue(true),
    finalize: vi.fn().mockResolvedValue(true),
  };
}

const key = {
  principalClientId: "operator-1",
  operationId: "adminV2CreateThing",
  idempotencyKey: "intent-1",
};

describe("Admin idempotent execution", () => {
  it("canonicalizes validated JSON before durable fingerprinting", async () => {
    const first = storeWithClaim({ outcome: "conflict" });
    const second = storeWithClaim({ outcome: "conflict" });

    await executeWithIdempotency({
      store: first,
      ...key,
      validatedRequest: { b: 2, a: { d: 4, c: 3 } },
      execute: vi.fn(),
    });
    await executeWithIdempotency({
      store: second,
      ...key,
      validatedRequest: { a: { c: 3, d: 4 }, b: 2 },
      execute: vi.fn(),
    });

    const firstSource = vi.mocked(first.claim).mock.calls[0]?.[0].requestFingerprintSource;
    const secondSource = vi.mocked(second.claim).mock.calls[0]?.[0].requestFingerprintSource;
    expect(firstSource).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(secondSource).toBe(firstSource);
  });

  it("replays a finalized response without executing again", async () => {
    const store = storeWithClaim({ outcome: "replay", response });
    const execute = vi.fn();

    await expect(
      executeWithIdempotency({ store, ...key, validatedRequest: { value: 1 }, execute }),
    ).resolves.toEqual({ outcome: "response", response, replayed: true });
    expect(execute).not.toHaveBeenCalled();
    expect(store.finalize).not.toHaveBeenCalled();
  });

  it("executes an acquired claim and finalizes with the fenced owner token", async () => {
    const store = storeWithClaim({
      outcome: "acquired",
      ownerToken: "owner-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const execute = vi.fn().mockResolvedValue(response);

    await expect(
      executeWithIdempotency({ store, ...key, validatedRequest: { value: 1 }, execute }),
    ).resolves.toEqual({ outcome: "response", response, replayed: false });
    expect(store.finalize).toHaveBeenCalledWith({ ...key, ownerToken: "owner-1", response });
  });

  it.each([
    [{ outcome: "conflict" } as const, { outcome: "conflict" }],
    [
      { outcome: "in_progress", retryAfterSeconds: 3 } as const,
      { outcome: "in_progress", retryAfterSeconds: 3 },
    ],
    [
      { outcome: "unknown", reconciliationLinks: ["/v2/admin/things/1"] } as IdempotencyClaimResult,
      { outcome: "unknown", reconciliationLinks: ["/v2/admin/things/1"] },
    ],
    [{ outcome: "capacity_exceeded" } as const, { outcome: "capacity_exceeded" }],
  ])("returns a non-owner claim outcome without executing: %j", async (claim, expected) => {
    const store = storeWithClaim(claim);
    const execute = vi.fn();
    await expect(
      executeWithIdempotency({ store, ...key, validatedRequest: {}, execute }),
    ).resolves.toEqual(expected);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when guarded finalization loses ownership", async () => {
    const store = storeWithClaim({
      outcome: "acquired",
      ownerToken: "owner-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    vi.mocked(store.finalize).mockResolvedValue(false);

    await expect(
      executeWithIdempotency({
        store,
        ...key,
        validatedRequest: {},
        reconciliationLinks: ["/v2/admin/things/1"],
        execute: async () => response,
      }),
    ).resolves.toEqual({
      outcome: "ownership_lost",
      reconciliationLinks: ["/v2/admin/things/1"],
    });
  });

  it("keeps the claim alive during long work and fails closed after a fenced heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWithClaim({
        outcome: "acquired",
        ownerToken: "owner-1",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      vi.mocked(store.heartbeat).mockResolvedValue(false);
      const deferred = Promise.withResolvers<IdempotencyFinalResponse>();
      const operation = executeWithIdempotency({
        store,
        ...key,
        validatedRequest: {},
        heartbeatIntervalMs: 10,
        reconciliationLinks: ["/v2/admin/things/1"],
        execute: () => deferred.promise,
      });

      await vi.advanceTimersByTimeAsync(10);
      deferred.resolve(response);

      await expect(operation).resolves.toEqual({
        outcome: "ownership_lost",
        reconciliationLinks: ["/v2/admin/things/1"],
      });
      expect(store.heartbeat).toHaveBeenCalledTimes(1);
      expect(store.finalize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
