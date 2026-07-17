import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CapletsError } from "../errors";
import {
  assertSecureStateDirectory,
  ensureSecureStateDirectory,
  readBoundedSecureFile,
  writeSecureFileExclusive,
} from "./secure-state";

const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 3 * 256 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 3 * 4096;
const DEFAULT_RETAINED_GENERATIONS = 1;

type AssetInput = Readonly<{
  capletId: string;
  logicalPath: string;
  contentHash: string;
  content: Uint8Array;
}>;

type CacheEntry = Readonly<{
  path: string;
  directory: string;
  byteLength: number;
}>;

export type AssetCacheCandidate = Readonly<{
  generation: number;
  aliases: ReadonlyMap<string, string>;
  entries: ReadonlySet<string>;
}>;

export type RuntimeAssetCacheStats = Readonly<{
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  reclaimedEntries: number;
  reclaimedBytes: number;
}>;

/** Caches immutable, content-addressed SQL assets; it never caches access decisions. */
export class RuntimeAssetCache {
  readonly #root: string;
  readonly #maxAssetBytes: number;
  readonly #maxCacheBytes: number;
  readonly #maxCacheEntries: number;
  readonly #retainedGenerations: number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #generations: AssetCacheCandidate[] = [];
  #aliases = new Map<string, string>();
  #pending: AssetCacheCandidate | undefined;
  #generation = 0;
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #reclaimedEntries = 0;
  #reclaimedBytes = 0;

  constructor(
    stateRoot: string,
    limits: Readonly<{
      maxAssetBytes?: number;
      maxCacheBytes?: number;
      maxCacheEntries?: number;
      retainedGenerations?: number;
    }> = {},
  ) {
    this.#root = resolve(stateRoot, "runtime-assets");
    this.#maxAssetBytes = positiveLimit(limits.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES);
    this.#maxCacheBytes = positiveLimit(limits.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES);
    this.#maxCacheEntries = positiveLimit(limits.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES);
    this.#retainedGenerations = nonnegativeLimit(
      limits.retainedGenerations,
      DEFAULT_RETAINED_GENERATIONS,
    );
  }

  async prepare(assets: readonly AssetInput[]): Promise<AssetCacheCandidate> {
    if (this.#pending) throw new Error("A runtime asset cache publication is already pending");
    await ensureSecureStateDirectory(this.#root);
    const aliases = new Map<string, string>();
    const entries = new Set<string>();
    const created: string[] = [];
    try {
      for (const asset of assets) {
        assertAssetMetadata(asset, this.#maxAssetBytes);
        const entryKey = contentEntryKey(asset.contentHash, asset.logicalPath);
        let entry = this.#entries.get(entryKey);
        if (entry) {
          this.#hits += 1;
        } else {
          assertAssetContent(asset);
          this.#assertCapacity(asset.content.byteLength);
          const directory = join(this.#root, asset.contentHash);
          await ensureSecureStateDirectory(directory);
          const path = join(directory, basename(asset.logicalPath));
          try {
            await writeSecureFileExclusive(path, asset.content);
          } catch {
            await assertSecureStateDirectory(directory);
            const existing = await readBoundedSecureFile(path, {
              maxBytes: asset.content.byteLength,
            });
            const digest = createHash("sha256").update(existing).digest("hex");
            if (digest !== asset.contentHash || existing.byteLength !== asset.content.byteLength) {
              throw new CapletsError("AUTH_FAILED", "Materialized SQL asset commitment changed.");
            }
          }
          entry = Object.freeze({ path, directory, byteLength: asset.content.byteLength });
          this.#entries.set(entryKey, entry);
          this.#bytes += entry.byteLength;
          this.#misses += 1;
          created.push(entryKey);
        }
        entries.add(entryKey);
        aliases.set(
          assetAliasKey(asset.capletId, asset.logicalPath, asset.contentHash),
          entry.path,
        );
      }
    } catch (error) {
      await this.#discardCreated(created);
      throw error;
    }
    const candidate = Object.freeze({
      generation: ++this.#generation,
      aliases,
      entries,
    });
    this.#pending = candidate;
    return candidate;
  }

  resolve(capletId: string, logicalPath: string, contentHash: string): string | undefined {
    const key = assetAliasKey(capletId, logicalPath, contentHash);
    return this.#pending?.aliases.get(key) ?? this.#aliases.get(key);
  }

  async commit(candidate: AssetCacheCandidate): Promise<void> {
    this.#requirePending(candidate);
    this.#aliases = new Map(candidate.aliases);
    this.#generations.push(candidate);
    this.#pending = undefined;
    while (this.#generations.length > this.#retainedGenerations + 1) {
      this.#generations.shift();
    }
    await this.#reclaimBestEffort();
  }

  async rollback(candidate: AssetCacheCandidate): Promise<void> {
    if (this.#pending) {
      throw new Error("A pending runtime asset cache candidate cannot be rolled back");
    }
    if (this.#generations.at(-1) !== candidate) {
      throw new Error("Only the latest committed runtime asset cache candidate can be rolled back");
    }
    this.#generations.pop();
    this.#aliases = new Map(this.#generations.at(-1)?.aliases ?? []);
    await this.#reclaimBestEffort();
  }

  async abort(candidate: AssetCacheCandidate): Promise<void> {
    this.#requirePending(candidate);
    this.#pending = undefined;
    await this.#reclaimBestEffort();
  }

  stats(): RuntimeAssetCacheStats {
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
      reclaimedEntries: this.#reclaimedEntries,
      reclaimedBytes: this.#reclaimedBytes,
    });
  }

  #requirePending(candidate: AssetCacheCandidate): void {
    if (this.#pending !== candidate)
      throw new Error("Runtime asset cache candidate is not pending");
  }

  #assertCapacity(byteLength: number): void {
    if (
      this.#entries.size + 1 > this.#maxCacheEntries ||
      this.#bytes + byteLength > this.#maxCacheBytes
    ) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Runtime SQL asset cache capacity was exceeded.",
      );
    }
  }

  async #reclaimBestEffort(): Promise<void> {
    // Publication state is already atomic. Cleanup failure may retain bytes and make a later
    // capacity check fail closed, but it must never roll back only one runtime generation.
    await this.#reclaimUnreferenced().catch(() => undefined);
  }

  async #reclaimUnreferenced(): Promise<void> {
    const retained = new Set<string>();
    for (const generation of this.#generations) {
      for (const key of generation.entries) retained.add(key);
    }
    for (const [key, entry] of this.#entries) {
      if (retained.has(key)) continue;
      await this.#removeEntry(key, entry);
    }
  }

  async #discardCreated(keys: readonly string[]): Promise<void> {
    const retained = new Set(this.#generations.flatMap((generation) => [...generation.entries]));
    for (const key of keys) {
      if (retained.has(key)) continue;
      const entry = this.#entries.get(key);
      if (entry) await this.#removeEntry(key, entry);
    }
  }

  async #removeEntry(key: string, entry: CacheEntry): Promise<void> {
    await assertSecureStateDirectory(entry.directory);
    await rm(entry.path, { force: true });
    await rm(entry.directory, { recursive: false, force: true }).catch(() => undefined);
    this.#entries.delete(key);
    this.#bytes -= entry.byteLength;
    this.#reclaimedEntries += 1;
    this.#reclaimedBytes += entry.byteLength;
  }
}

/** Caches only successful cryptographic key-material proofs, never authorization decisions. */
export class KeyCanaryProofCache {
  readonly #proofs = new Set<string>();
  #fence = "";

  beginFence(
    fence: Readonly<{ leaseId: string; writerEpoch: number; authorityGeneration: number }>,
  ): void {
    const next = `${fence.leaseId}\u001f${fence.writerEpoch}\u001f${fence.authorityGeneration}`;
    if (next === this.#fence) return;
    this.#fence = next;
    this.#proofs.clear();
  }

  reconcile(keys: ReadonlySet<string>): void {
    for (const proof of this.#proofs) {
      if (!keys.has(proof)) this.#proofs.delete(proof);
    }
  }

  has(key: string): boolean {
    return this.#proofs.has(key);
  }

  record(key: string): void {
    this.#proofs.add(key);
  }

  get size(): number {
    return this.#proofs.size;
  }
}

export function keyCanaryProofKey(
  input: Readonly<{
    nodeId: string;
    purpose: string;
    keyId: string;
    keyVersion: number;
    materialCommitment: string;
  }>,
): string {
  return [
    input.nodeId,
    input.purpose,
    input.keyId,
    String(input.keyVersion),
    input.materialCommitment,
  ].join("\u001f");
}

function assetAliasKey(capletId: string, logicalPath: string, contentHash: string): string {
  return `${capletId}\u001f${logicalPath}\u001f${contentHash}`;
}

function contentEntryKey(contentHash: string, logicalPath: string): string {
  return `${contentHash}\u001f${basename(logicalPath)}`;
}

function assertAssetMetadata(asset: AssetInput, maxAssetBytes: number): void {
  if (!/^[a-f0-9]{64}$/u.test(asset.contentHash)) {
    throw new CapletsError("AUTH_FAILED", "Runtime SQL asset commitment is invalid.");
  }
  if (asset.content.byteLength <= 0 || asset.content.byteLength > maxAssetBytes) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Runtime SQL asset size limit was exceeded.");
  }
}

function assertAssetContent(asset: AssetInput): void {
  const digest = createHash("sha256").update(asset.content).digest("hex");
  if (digest !== asset.contentHash) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Runtime SQL asset content does not match its commitment.",
    );
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    throw new Error("Cache limit must be positive");
  return resolved;
}

function nonnegativeLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error("Cache retention must be non-negative");
  }
  return resolved;
}
