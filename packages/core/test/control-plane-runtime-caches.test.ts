import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeyCanaryProofCache,
  RuntimeAssetCache,
  keyCanaryProofKey,
} from "../src/control-plane/runtime-caches";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "caplets-runtime-cache-"));
  roots.push(value);
  return value;
}

function asset(capletId: string, logicalPath: string, value: string) {
  const content = Buffer.from(value);
  return {
    capletId,
    logicalPath,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

describe("runtime SQL asset cache", () => {
  it("hits immutable content without rereading and reclaims only superseded generations", async () => {
    const cache = new RuntimeAssetCache(await root(), { retainedGenerations: 1 });
    const firstAsset = asset("caplet-a", "assets/a.txt", "alpha");
    const secondAsset = asset("caplet-b", "assets/b.txt", "bravo");
    const thirdAsset = asset("caplet-c", "assets/c.txt", "charlie");

    const first = await cache.prepare([firstAsset]);
    const firstPath = cache.resolve(
      firstAsset.capletId,
      firstAsset.logicalPath,
      firstAsset.contentHash,
    )!;
    await cache.commit(first);
    const repeated = await cache.prepare([firstAsset]);
    await cache.commit(repeated);
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, reclaimedEntries: 0 });

    const second = await cache.prepare([secondAsset]);
    await cache.commit(second);
    await expect(access(firstPath)).resolves.toBeUndefined();
    const third = await cache.prepare([thirdAsset]);
    await cache.commit(third);

    await expect(access(firstPath)).rejects.toThrow();
    expect(cache.stats()).toMatchObject({
      entries: 2,
      hits: 1,
      misses: 3,
      reclaimedEntries: 1,
      reclaimedBytes: firstAsset.content.byteLength,
    });
  });

  it("does not rehash replacement bytes after immutable content is cached", async () => {
    const cache = new RuntimeAssetCache(await root());
    const verified = asset("caplet-a", "assets/a.txt", "verified");
    const first = await cache.prepare([verified]);
    await cache.commit(first);

    const hit = await cache.prepare([
      {
        ...verified,
        content: Buffer.from("different bytes that must not replace the cached asset"),
      },
    ]);

    await expect(cache.commit(hit)).resolves.toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  it("publishes the next generation even when superseded asset cleanup fails", async () => {
    if (process.platform === "win32") return;
    const cache = new RuntimeAssetCache(await root(), { retainedGenerations: 0 });
    const firstAsset = asset("caplet-a", "assets/a.txt", "first");
    const secondAsset = asset("caplet-b", "assets/b.txt", "second");
    const first = await cache.prepare([firstAsset]);
    const firstPath = cache.resolve(
      firstAsset.capletId,
      firstAsset.logicalPath,
      firstAsset.contentHash,
    )!;
    await cache.commit(first);
    await chmod(dirname(firstPath), 0o755);
    const second = await cache.prepare([secondAsset]);

    await expect(cache.commit(second)).resolves.toBeUndefined();

    expect(cache.resolve(firstAsset.capletId, firstAsset.logicalPath, firstAsset.contentHash)).toBe(
      undefined,
    );
    expect(
      cache.resolve(secondAsset.capletId, secondAsset.logicalPath, secondAsset.contentHash),
    ).toBeDefined();
    await expect(access(firstPath)).resolves.toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 2, reclaimedEntries: 0 });
  });

  it("restores the acknowledged asset generation after a committed publication is rejected", async () => {
    const cache = new RuntimeAssetCache(await root(), { retainedGenerations: 1 });
    const acknowledgedAsset = asset("caplet-a", "assets/a.txt", "acknowledged");
    const rejectedAsset = asset("caplet-b", "assets/b.txt", "rejected");
    const acknowledged = await cache.prepare([acknowledgedAsset]);
    await cache.commit(acknowledged);
    const rejected = await cache.prepare([rejectedAsset]);
    const rejectedPath = cache.resolve(
      rejectedAsset.capletId,
      rejectedAsset.logicalPath,
      rejectedAsset.contentHash,
    )!;
    await cache.commit(rejected);

    await cache.rollback(rejected);

    expect(
      cache.resolve(
        acknowledgedAsset.capletId,
        acknowledgedAsset.logicalPath,
        acknowledgedAsset.contentHash,
      ),
    ).toBeDefined();
    expect(
      cache.resolve(rejectedAsset.capletId, rejectedAsset.logicalPath, rejectedAsset.contentHash),
    ).toBeUndefined();
    await expect(access(rejectedPath)).rejects.toThrow();
  });

  it("fails closed before exceeding entry or byte capacity and discards aborted candidates", async () => {
    const cache = new RuntimeAssetCache(await root(), {
      maxCacheEntries: 2,
      maxCacheBytes: 10,
      retainedGenerations: 1,
    });
    const first = await cache.prepare([asset("a", "a.txt", "12345")]);
    await cache.commit(first);
    const aborted = await cache.prepare([asset("b", "b.txt", "67890")]);
    await cache.abort(aborted);
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 5 });

    await expect(
      cache.prepare([asset("b", "b.txt", "67890"), asset("c", "c.txt", "x")]),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 5 });
  });
});

describe("key canary proof cache", () => {
  const fence = { leaseId: "writer:node-a", writerEpoch: 1, authorityGeneration: 4 };
  const base = {
    nodeId: "node-a",
    purpose: "vault-record",
    keyId: "key-a",
    keyVersion: 2,
  };

  it("invalidates equal-version proofs when material changes and when keys transition", () => {
    const cache = new KeyCanaryProofCache();
    cache.beginFence(fence);
    const oldMaterial = keyCanaryProofKey({ ...base, materialCommitment: "a".repeat(64) });
    const changedMaterial = keyCanaryProofKey({ ...base, materialCommitment: "b".repeat(64) });
    cache.reconcile(new Set([oldMaterial]));
    cache.record(oldMaterial);
    expect(cache.has(oldMaterial)).toBe(true);

    cache.reconcile(new Set([changedMaterial]));
    expect(cache.has(oldMaterial)).toBe(false);
    expect(cache.has(changedMaterial)).toBe(false);
    cache.record(changedMaterial);

    const nextKey = keyCanaryProofKey({
      ...base,
      keyId: "key-b",
      keyVersion: 3,
      materialCommitment: "c".repeat(64),
    });
    cache.reconcile(new Set([nextKey]));
    expect(cache.size).toBe(0);
  });

  it("invalidates proofs when the exact writer fence changes", () => {
    const cache = new KeyCanaryProofCache();
    const proof = keyCanaryProofKey({ ...base, materialCommitment: "a".repeat(64) });
    cache.beginFence(fence);
    cache.record(proof);
    cache.beginFence({ ...fence, writerEpoch: 2 });
    expect(cache.has(proof)).toBe(false);
  });
});
