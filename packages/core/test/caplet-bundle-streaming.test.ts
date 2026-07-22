import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createHostStorage } from "../src/storage";
import type { AssetObjectStore } from "../src/storage/asset-store";
import { CapletRecordStore } from "../src/storage/caplet-records";
import {
  bufferBundleFileSource,
  readVerifiedBundleFile,
  stagedBundleFileSource,
  type ReopenableBundleFileSource,
} from "../src/storage/bundle-source";
import * as sqlite from "../src/storage/schema/sqlite";

const directories: string[] = [];
const operator = { clientId: "operator_streaming", role: "operator" } as const;

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function document(name = "Streaming"): Buffer {
  return Buffer.from(
    `---\nname: ${name}\ndescription: Exercise streaming Caplet Bundle storage.\nmcpServer:\n  command: stream-mcp\n---\n# ${name}\n`,
  );
}

function source(path: string, content: Buffer, executable = false): ReopenableBundleFileSource {
  return {
    path,
    size: content.byteLength,
    sha256: digest(content),
    executable,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      }),
  };
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = Buffer.from(chunk.value);
    chunks.push(value);
    length += value.byteLength;
  }
  return Buffer.concat(chunks, length);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Caplet Bundle streaming storage", () => {
  it("keeps Buffer imports compatible and staged sources reopenable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-stream-buffer-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "db.sqlite3"),
    });
    const stagedPath = join(directory, "staged.bin");
    const payload = Buffer.from("reopen this staged payload");
    writeFileSync(stagedPath, payload);
    const staged = stagedBundleFileSource({
      path: "assets/staged.bin",
      stagedPath,
      size: payload.byteLength,
      sha256: digest(payload),
      executable: false,
    });

    try {
      const created = await storage.caplets.importBundle({
        id: "buffer-compatible",
        operator,
        files: [
          { path: "CAPLET.md", content: document(), executable: false },
          { path: "asset.txt", content: Buffer.from("buffer asset"), executable: false },
        ],
      });
      expect(created.currentRevision.bundle).toHaveLength(1);
      await expect(readVerifiedBundleFile(staged, { maxBytes: 1024 })).resolves.toEqual(payload);
      await expect(readVerifiedBundleFile(staged, { maxBytes: 1024 })).resolves.toEqual(payload);
      await expect(
        storage.caplets.readBundle("buffer-compatible", { operator }),
      ).resolves.toMatchObject({
        files: [{ path: "CAPLET.md" }, { path: "asset.txt", content: Buffer.from("buffer asset") }],
      });
    } finally {
      await storage.close();
    }
  });

  it("validates every manifest before writes and opens sources one at a time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-stream-order-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "db.sqlite3"),
    });
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const tracked = (path: string, content: Buffer): ReopenableBundleFileSource => ({
      path,
      size: content.byteLength,
      sha256: digest(content),
      executable: false,
      open() {
        events.push(`open:${path}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        let offset = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === content.byteLength) {
              active -= 1;
              events.push(`close:${path}`);
              controller.close();
              return;
            }
            const end = Math.min(
              offset + Math.max(1, Math.floor(content.byteLength / 2)),
              content.byteLength,
            );
            controller.enqueue(content.subarray(offset, end));
            offset = end;
          },
          cancel() {
            active -= 1;
            events.push(`cancel:${path}`);
          },
        });
      },
    });

    try {
      await storage.caplets.importBundleSources({
        id: "sequential",
        operator,
        sources: [
          tracked("CAPLET.md", document()),
          tracked("b.txt", Buffer.from("second")),
          tracked("a.txt", Buffer.from("first")),
        ],
      });
      expect(maxActive).toBe(1);
      expect(events).toEqual([
        "open:CAPLET.md",
        "close:CAPLET.md",
        "open:a.txt",
        "close:a.txt",
        "open:b.txt",
        "close:b.txt",
      ]);

      let collisionOpens = 0;
      const collision = source("README.txt", Buffer.from("one"));
      collision.open = () => {
        collisionOpens += 1;
        return new ReadableStream();
      };
      await expect(
        storage.caplets.importBundleSources({
          id: "collision",
          operator,
          sources: [
            source("CAPLET.md", document()),
            collision,
            source("readme.TXT", Buffer.from("two")),
          ],
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(collisionOpens).toBe(0);
      await expect(
        storage.caplets.importBundleSources({
          id: "duplicate",
          operator,
          sources: [source("CAPLET.md", document()), collision, collision],
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(collisionOpens).toBe(0);
      await expect(storage.caplets.get("collision")).resolves.toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("rejects late tampering and removes prepared orphan blobs after failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-stream-cleanup-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "db.sqlite3"),
    });
    const corrupt = source("z.txt", Buffer.from("declared"));
    corrupt.open = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("tampered"));
          controller.close();
        },
      });

    try {
      const wrongSize = source("size.txt", Buffer.from("short"));
      wrongSize.size += 1;
      await expect(
        storage.caplets.importBundleSources({
          id: "wrong-size",
          operator,
          sources: [source("CAPLET.md", document()), wrongSize],
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      await expect(storage.caplets.get("wrong-size")).resolves.toBeUndefined();
      await expect(storage.caplets.assetStats()).resolves.toEqual({ blobs: 0, entries: 0 });

      await expect(
        storage.caplets.importBundleSources({
          id: "tampered",
          operator,
          sources: [
            source("CAPLET.md", document()),
            source("a.txt", Buffer.from("prepared first")),
            corrupt,
          ],
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      await expect(storage.caplets.get("tampered")).resolves.toBeUndefined();
      await expect(storage.caplets.assetStats()).resolves.toEqual({ blobs: 0, entries: 0 });

      await storage.caplets.importBundle({
        id: "existing",
        operator,
        files: [{ path: "CAPLET.md", content: document("Existing"), executable: false }],
      });
      await expect(
        storage.caplets.importBundleSources({
          id: "existing",
          operator,
          sources: [
            source("CAPLET.md", document("Collision")),
            source("new.bin", Buffer.from("orphan")),
          ],
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(storage.caplets.assetStats()).resolves.toEqual({ blobs: 0, entries: 0 });
    } finally {
      await storage.close();
    }
  });

  it("preserves source-update generation semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-stream-update-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "db.sqlite3"),
    });

    try {
      await storage.caplets.importBundleSources({
        id: "tracked-stream",
        operator,
        sources: [source("CAPLET.md", document("One"))],
        historyLimit: 2,
        sourceRevision: "v1",
        sourceContentHash: "hash-v1",
        installation: { sourceKind: "catalog", sourceIdentity: "test/tracked-stream" },
      });
      const updated = await storage.caplets.updateFromBundleSources({
        id: "tracked-stream",
        operator,
        sources: [source("CAPLET.md", document("Two"))],
        expectedGeneration: 1,
        expectedInstallationGeneration: 1,
        sourceRevision: "v2",
        sourceContentHash: "hash-v2",
        observationStatus: "current",
      });
      expect(updated).toMatchObject({
        headGeneration: 2,
        currentRevision: { sequence: 2, name: "Two" },
      });
      await expect(storage.installations.getActive("tracked-stream")).resolves.toMatchObject({
        generation: 2,
      });
    } finally {
      await storage.close();
    }
  });

  it("reads manifest order with integrity checks and propagates cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-stream-read-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "db.sqlite3"),
    });

    try {
      const created = await storage.caplets.importBundleSources({
        id: "stream-read",
        operator,
        sources: [
          source("CAPLET.md", document()),
          source("z-last.txt", Buffer.from("last")),
          source("a-first.txt", Buffer.from("first")),
        ],
      });
      const streamed = await storage.caplets.readBundleSources("stream-read", { operator });
      expect(streamed.sources.map((item) => item.path)).toEqual([
        "CAPLET.md",
        "a-first.txt",
        "z-last.txt",
      ]);
      await expect(bytes(streamed.sources[1]!.open())).resolves.toEqual(Buffer.from("first"));
      await expect(bytes(streamed.sources[1]!.open())).resolves.toEqual(Buffer.from("first"));

      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
      const firstEntry = created.currentRevision.bundle[0]!;
      storage.database.db
        .update(sqlite.capletAssetBlobs)
        .set({ payload: Buffer.from("corrupt") })
        .where(eq(sqlite.capletAssetBlobs.hash, firstEntry.hash))
        .run();
      const corrupted = await storage.caplets.readBundleSources("stream-read", { operator });
      await expect(bytes(corrupted.sources[1]!.open())).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });

      let cancelledWith: unknown;
      const objectStore: AssetObjectStore = {
        async putVerifiedStream(hash, _size, stream) {
          await bytes(stream);
          return `objects/${hash}`;
        },
        async getVerifiedStream() {
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(Buffer.from("chunk"));
            },
            cancel(reason) {
              cancelledWith = reason;
            },
          });
        },
        async putVerified(hash, payload) {
          return await this.putVerifiedStream(
            hash,
            payload.byteLength,
            bufferBundleFileSource({ path: "x", content: payload, executable: false }).open(),
          );
        },
        async getVerified(key, expected) {
          return await bytes(await this.getVerifiedStream(key, expected));
        },
        async delete() {},
        async list() {
          return [];
        },
        async health() {
          return true;
        },
        close() {},
      };
      const objectRecords = new CapletRecordStore(storage.database, { objectStore });
      await objectRecords.importBundleSources({
        id: "cancel-read",
        operator,
        sources: [
          source("CAPLET.md", document("Cancel")),
          source("payload.bin", Buffer.from("chunk")),
        ],
      });
      const cancellable = await objectRecords.readBundleSources("cancel-read", { operator });
      const reader = cancellable.sources[1]!.open().getReader();
      await reader.read();
      await reader.cancel("consumer disconnected");
      expect(cancelledWith).toBe("consumer disconnected");
    } finally {
      await storage.close();
    }
  });
});
