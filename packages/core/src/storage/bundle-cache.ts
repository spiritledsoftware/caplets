import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { CapletsError } from "../errors";

/** Provider-neutral limit for one materialized authority bundle. */
export const MAX_AUTHORITY_BUNDLE_BYTES = 64 * 1024 * 1024;
/** A single asset is deliberately bounded below the generation ceiling. */
export const MAX_AUTHORITY_BUNDLE_ASSET_BYTES = 16 * 1024 * 1024;

export type AuthorityBundleAsset = {
  path: string;
  content: string | Uint8Array | ArrayBuffer;
  length?: number | undefined;
  digest?: string | undefined;
  mode?: number | undefined;
};

export type AuthorityCapletBundle = {
  /** Virtual path of the entry Markdown document. */
  entryPath?: string | undefined;
  files: AuthorityBundleAsset[];
};

export type AuthorityCapletRecord = {
  id: string;
  /** Safe dashboard-authored presentation metadata kept beside the executable bundle. */
  name?: string | undefined;
  description?: string | undefined;
  bundle?: AuthorityCapletBundle | undefined;
  /** Compatibility shape used by authority snapshots that call assets "files". */
  files?: AuthorityBundleAsset[] | undefined;
  entryPath?: string | undefined;
  config?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

export type NormalizedAuthorityBundleAsset = {
  path: string;
  bytes: Uint8Array;
  length: number;
  digest: string;
  mode?: number | undefined;
};

export type NormalizedAuthorityBundle = {
  entryPath: string;
  files: NormalizedAuthorityBundleAsset[];
  totalBytes: number;
  fingerprint: string;
};

export type MaterializedAuthorityBundle = {
  root: string;
  entryPath: string;
  fingerprint: string;
  files: NormalizedAuthorityBundleAsset[];
  release: () => Promise<void>;
};

type CacheOptions = {
  root: string;
  maxBundleBytes?: number;
  maxAssetBytes?: number;
};

type MaterializeOptions = {
  maxBundleBytes?: number;
  maxAssetBytes?: number;
};

/**
 * Content-addressed, disposable replica cache for authority-managed assets.
 *
 * A bundle is verified before any bytes become visible to a runtime. Writes go
 * to a unique temporary directory and are renamed into the fingerprint path;
 * readers therefore see either a complete bundle or no bundle at all.
 */
export class ContentAddressedBundleCache {
  private readonly root: string;
  private readonly maxBundleBytes: number;
  private readonly maxAssetBytes: number;
  private readonly references = new Map<string, number>();
  private readonly pending = new Map<string, Promise<MaterializedAuthorityBundle>>();

  constructor(options: CacheOptions) {
    this.root = resolve(options.root);
    this.maxBundleBytes = options.maxBundleBytes ?? MAX_AUTHORITY_BUNDLE_BYTES;
    this.maxAssetBytes = options.maxAssetBytes ?? MAX_AUTHORITY_BUNDLE_ASSET_BYTES;
    if (!Number.isSafeInteger(this.maxBundleBytes) || this.maxBundleBytes <= 0) {
      throw new CapletsError("CONFIG_INVALID", "Authority bundle cache byte limit is invalid");
    }
    if (!Number.isSafeInteger(this.maxAssetBytes) || this.maxAssetBytes <= 0) {
      throw new CapletsError("CONFIG_INVALID", "Authority bundle asset byte limit is invalid");
    }
  }

  get cacheRoot(): string {
    return this.root;
  }

  /** Normalize and verify a bundle without writing it. */
  normalize(
    bundle: AuthorityCapletBundle,
    options: MaterializeOptions = {},
  ): NormalizedAuthorityBundle {
    return normalizeAuthorityBundle(bundle, {
      maxBundleBytes: options.maxBundleBytes ?? this.maxBundleBytes,
      maxAssetBytes: options.maxAssetBytes ?? this.maxAssetBytes,
    });
  }

  async materialize(
    bundle: AuthorityCapletBundle,
    options: MaterializeOptions = {},
  ): Promise<MaterializedAuthorityBundle> {
    const normalized = this.normalize(bundle, options);
    const existingPending = this.pending.get(normalized.fingerprint);
    if (existingPending) {
      const result = await existingPending;
      this.retain(normalized.fingerprint);
      return this.withRelease(result);
    }

    const pending = this.materializeNormalized(normalized);
    this.pending.set(normalized.fingerprint, pending);
    try {
      const result = await pending;
      this.retain(normalized.fingerprint);
      return this.withRelease(result);
    } finally {
      this.pending.delete(normalized.fingerprint);
    }
  }

  retain(fingerprint: string): void {
    this.references.set(fingerprint, (this.references.get(fingerprint) ?? 0) + 1);
  }

  async release(fingerprint: string): Promise<void> {
    const references = this.references.get(fingerprint) ?? 0;
    if (references <= 1) {
      this.references.delete(fingerprint);
    } else {
      this.references.set(fingerprint, references - 1);
    }
  }

  /** Pin a bundle for rollback/backup retention independent of runtime refs. */
  pin(fingerprint: string): void {
    this.retain(`pin:${fingerprint}`);
  }

  async unpin(fingerprint: string): Promise<void> {
    await this.release(`pin:${fingerprint}`);
  }

  /**
   * Remove only unreferenced cache entries. Active and pinned fingerprints are
   * never removed, even if their reference bookkeeping was reconstructed by a
   * caller after restart.
   */
  async cleanup(
    options: {
      activeFingerprints?: Iterable<string>;
      pinnedFingerprints?: Iterable<string>;
      now?: number;
    } = {},
  ): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const active = new Set(options.activeFingerprints ?? []);
    const pinned = new Set(options.pinnedFingerprints ?? []);
    const removed: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) {
        if (entry.name.startsWith(".tmp-")) {
          await rm(join(this.root, entry.name), { recursive: true, force: true });
        }
        continue;
      }
      const fingerprint = entry.name;
      if (
        active.has(fingerprint) ||
        pinned.has(fingerprint) ||
        (this.references.get(fingerprint) ?? 0) > 0 ||
        (this.references.get(`pin:${fingerprint}`) ?? 0) > 0
      ) {
        continue;
      }
      await rm(join(this.root, fingerprint), { recursive: true, force: true });
      removed.push(fingerprint);
    }
    return removed;
  }

  /** Remove one candidate after failed preparation when it is not retained. */
  async discard(fingerprint: string): Promise<void> {
    if (
      (this.references.get(fingerprint) ?? 0) > 0 ||
      (this.references.get(`pin:${fingerprint}`) ?? 0) > 0
    ) {
      return;
    }
    await rm(join(this.root, fingerprint), { recursive: true, force: true });
  }

  private async materializeNormalized(
    normalized: NormalizedAuthorityBundle,
  ): Promise<MaterializedAuthorityBundle> {
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, normalized.fingerprint);
    if (await isCompleteMaterialization(target, normalized)) {
      return this.createResult(normalized, target);
    }
    await rm(target, { recursive: true, force: true });

    const temporary = join(this.root, `.tmp-${normalized.fingerprint}-${randomUUID()}`);
    try {
      for (const file of normalized.files) {
        const destination = join(temporary, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes, { mode: file.mode ?? 0o600 });
        if (file.mode !== undefined) {
          await chmod(destination, file.mode & 0o7777);
        }
      }
      await writeFile(
        join(temporary, ".bundle.json"),
        JSON.stringify({ fingerprint: normalized.fingerprint, entryPath: normalized.entryPath }),
        { mode: 0o600 },
      );
      await rename(temporary, target);
      return this.createResult(normalized, target);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw new CapletsError("CONFIG_INVALID", "Authority bundle materialization failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createResult(
    normalized: NormalizedAuthorityBundle,
    root: string,
  ): MaterializedAuthorityBundle {
    return {
      root,
      entryPath: join(root, normalized.entryPath),
      fingerprint: normalized.fingerprint,
      files: normalized.files,
      release: async () => this.release(normalized.fingerprint),
    };
  }

  private withRelease(result: MaterializedAuthorityBundle): MaterializedAuthorityBundle {
    return {
      ...result,
      release: async () => this.release(result.fingerprint),
    };
  }
}

export function authorityBundleBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0));
  return new Uint8Array(content.slice());
}

export function normalizeAuthorityBundle(
  bundle: AuthorityCapletBundle,
  options: { maxBundleBytes?: number; maxAssetBytes?: number } = {},
): NormalizedAuthorityBundle {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new CapletsError("CONFIG_INVALID", "Authority Caplet bundle must contain files");
  }
  const maxBundleBytes = options.maxBundleBytes ?? MAX_AUTHORITY_BUNDLE_BYTES;
  const maxAssetBytes = options.maxAssetBytes ?? MAX_AUTHORITY_BUNDLE_ASSET_BYTES;
  const paths = new Set<string>();
  const files: NormalizedAuthorityBundleAsset[] = [];
  let totalBytes = 0;
  for (const input of bundle.files) {
    const path = normalizeBundlePath(input.path);
    if (paths.has(path)) {
      throw new CapletsError("CONFIG_INVALID", `Authority bundle contains duplicate asset ${path}`);
    }
    paths.add(path);
    const bytes = authorityBundleBytes(input.content);
    if (bytes.byteLength > maxAssetBytes) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Authority bundle asset ${path} exceeds its byte limit`,
      );
    }
    if (input.length !== undefined && input.length !== bytes.byteLength) {
      throw new CapletsError("CONFIG_INVALID", `Authority bundle asset ${path} length is invalid`);
    }
    const digest = sha256(bytes);
    if (input.digest !== undefined && normalizeDigest(input.digest) !== digest) {
      throw new CapletsError("CONFIG_INVALID", `Authority bundle asset ${path} digest is invalid`);
    }
    const mode = input.mode;
    if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
      throw new CapletsError("CONFIG_INVALID", `Authority bundle asset ${path} mode is invalid`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBundleBytes) {
      throw new CapletsError("CONFIG_INVALID", "Authority Caplet bundle exceeds the 64 MiB limit");
    }
    files.push({
      path,
      bytes,
      length: bytes.byteLength,
      digest,
      ...(mode === undefined ? {} : { mode }),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const entryPath = normalizeBundlePath(
    bundle.entryPath ?? inferEntryPath(files.map((file) => file.path)),
  );
  if (!paths.has(entryPath)) {
    throw new CapletsError("CONFIG_INVALID", `Authority bundle entry ${entryPath} is missing`);
  }
  const hash = createHash("sha256");
  hash.update("caplets-authority-bundle\0");
  hash.update(entryPath);
  for (const file of files) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.digest);
    hash.update("\0");
    hash.update(String(file.length));
    hash.update("\0");
    hash.update(String(file.mode ?? 0));
  }
  return {
    entryPath,
    files,
    totalBytes,
    fingerprint: `sha256:${hash.digest("hex")}`,
  };
}

export function normalizeBundlePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new CapletsError("CONFIG_INVALID", "Authority bundle asset path is invalid");
  }
  const slash = value.replace(/\\/gu, "/");
  if (slash.startsWith("/") || /^[A-Za-z]:\//u.test(slash)) {
    throw new CapletsError("CONFIG_INVALID", `Authority bundle asset path ${value} is absolute`);
  }
  const normalized = posix.normalize(slash);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Authority bundle asset path ${value} traverses its root`,
    );
  }
  return normalized;
}

function inferEntryPath(paths: string[]): string {
  const markdown = paths.filter((path) => path === "CAPLET.md" || path.endsWith("/CAPLET.md"));
  if (markdown.length === 1) return markdown[0]!;
  const topLevel = paths.filter((path) => !path.includes("/") && /\\.md$/iu.test(path));
  if (topLevel.length === 1) return topLevel[0]!;
  throw new CapletsError("CONFIG_INVALID", "Authority bundle must identify one entry document");
}

function normalizeDigest(value: string): string {
  return value.replace(/^sha256:/iu, "").toLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function isCompleteMaterialization(
  root: string,
  normalized: NormalizedAuthorityBundle,
): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(root, ".bundle.json"), "utf8")) as {
      fingerprint?: unknown;
      entryPath?: unknown;
    };
    if (
      marker.fingerprint !== normalized.fingerprint ||
      marker.entryPath !== normalized.entryPath
    ) {
      return false;
    }
    for (const file of normalized.files) {
      const bytes = new Uint8Array(await readFile(join(root, file.path)));
      if (bytes.byteLength !== file.length || sha256(bytes) !== file.digest) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function bundleFingerprint(bundle: AuthorityCapletBundle): Promise<string> {
  return normalizeAuthorityBundle(bundle).fingerprint;
}

export function authorityBundleRecordBundle(
  record: AuthorityCapletRecord,
): AuthorityCapletBundle | undefined {
  if (record.bundle) return record.bundle;
  if (record.files) {
    return { files: record.files, ...(record.entryPath ? { entryPath: record.entryPath } : {}) };
  }
  return undefined;
}

export function virtualBundlePath(root: string, virtualPath: string): string {
  const normalized = normalizeBundlePath(virtualPath);
  const candidate = resolve(root, normalized);
  const rel = relative(resolve(root), candidate);
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new CapletsError("CONFIG_INVALID", "Authority bundle path escapes materialized root");
  }
  return candidate;
}

export async function inspectMaterializedBundle(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ".bundle.json") continue;
    total += (await stat(join(root, entry.name))).size;
  }
  return total;
}
