import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  OBSERVED_OUTPUT_SHAPE_LIMITS,
  type ObservedOutputShape,
  type ObservedOutputShapeKey,
  type ObservedOutputShapePruneResult,
  type ObservedOutputShapeStore,
  type ObservedOutputShapeStoreHealth,
} from "./types";
import { observedOutputShapeStorageKey } from "./key";

type StoredObservedOutputShape = {
  key: ObservedOutputShapeKey;
  shape: ObservedOutputShape;
  createdAt: string;
  expiresAt: string;
};

export class FileObservedOutputShapeStore implements ObservedOutputShapeStore {
  constructor(
    private readonly cacheDir: string,
    private readonly options: {
      ttlMs?: number | undefined;
      maxEntries?: number | undefined;
    } = {},
  ) {}

  async read(key: ObservedOutputShapeKey): Promise<ObservedOutputShape | undefined> {
    try {
      const parsed = JSON.parse(
        readFileSync(this.pathFor(key), "utf8"),
      ) as StoredObservedOutputShape;
      if (Date.now() > Date.parse(parsed.expiresAt)) return undefined;
      if (!isObservedOutputShape(parsed.shape)) return undefined;
      return parsed.shape;
    } catch {
      return undefined;
    }
  }

  async write(key: ObservedOutputShapeKey, shape: ObservedOutputShape): Promise<void> {
    const payload: StoredObservedOutputShape = {
      key,
      shape,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlMs()).toISOString(),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > OBSERVED_OUTPUT_SHAPE_LIMITS.maxStoredJsonBytes) return;
    mkdirSync(this.cacheDir, { recursive: true });
    const path = this.pathFor(key);
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tempPath, path);
    void this.prune().catch(() => undefined);
  }

  async prune(now = new Date()): Promise<ObservedOutputShapePruneResult> {
    if (!existsSync(this.cacheDir)) return { removed: 0, remaining: 0 };
    const files = this.entries();
    let removed = 0;
    const live: { path: string; expiresAt: number; mtimeMs: number }[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(file.path, "utf8")) as StoredObservedOutputShape;
        const expiresAt = Date.parse(parsed.expiresAt);
        if (
          !Number.isFinite(expiresAt) ||
          now.getTime() > expiresAt ||
          !isObservedOutputShape(parsed.shape)
        ) {
          rmSync(file.path, { force: true });
          removed++;
          continue;
        }
        live.push({ path: file.path, expiresAt, mtimeMs: file.mtimeMs });
      } catch {
        rmSync(file.path, { force: true });
        removed++;
      }
    }
    const maxEntries = this.maxEntries();
    const overflow = Math.max(0, live.length - maxEntries);
    if (overflow > 0) {
      for (const entry of live.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, overflow)) {
        rmSync(entry.path, { force: true });
        removed++;
      }
    }
    return { removed, remaining: Math.max(0, live.length - overflow) };
  }

  async health(): Promise<ObservedOutputShapeStoreHealth> {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const probe = join(this.cacheDir, `.health-${process.pid}.json`);
      writeFileSync(probe, "{}", { mode: 0o600 });
      rmSync(probe, { force: true });
      const prune = await this.prune();
      return {
        path: this.cacheDir,
        readable: true,
        writable: true,
        entryCount: this.entries().length,
        prune,
      };
    } catch (error) {
      return {
        path: this.cacheDir,
        readable: false,
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private pathFor(key: ObservedOutputShapeKey): string {
    return join(this.cacheDir, `${observedOutputShapeStorageKey(key)}.json`);
  }

  private entries(): { path: string; mtimeMs: number }[] {
    try {
      return readdirSync(this.cacheDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const path = join(this.cacheDir, entry.name);
          return { path, mtimeMs: readMtimeMs(path) };
        });
    } catch {
      return [];
    }
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? OBSERVED_OUTPUT_SHAPE_LIMITS.ttlMs;
  }

  private maxEntries(): number {
    return this.options.maxEntries ?? OBSERVED_OUTPUT_SHAPE_LIMITS.maxLocalEntries;
  }
}

function readMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isObservedOutputShape(value: unknown): value is ObservedOutputShape {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 1 &&
    (value as { source?: unknown }).source === "observed" &&
    typeof (value as { typeScript?: unknown }).typeScript === "string" &&
    typeof (value as { sampleCount?: unknown }).sampleCount === "number",
  );
}
