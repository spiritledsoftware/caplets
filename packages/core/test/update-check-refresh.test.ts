import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readUpdateMetadataCache,
  refreshUpdateMetadata,
  updateRefreshLockPath,
  writePrivateJson,
} from "../src/update-check";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-update-check-refresh-"));
  dirs.push(dir);
  return dir;
}

describe("update-check refresh", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes positive package metadata for later invocations", async () => {
    const dir = tempDir();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        name: "caplets",
        "dist-tags": { latest: "0.23.0" },
        versions: { "0.22.0": {}, "0.23.0": {}, "0.24.0-beta.1": {} },
      }),
    );

    await expect(refreshUpdateMetadata({ cacheDir: dir, fetcher, now: 1_000 })).resolves.toBe(
      "refreshed",
    );

    expect(readUpdateMetadataCache({ cacheDir: dir, now: 1_001 })).toMatchObject({
      status: "positive",
      metadata: {
        packageName: "caplets",
        distTags: { latest: "0.23.0" },
        versions: ["0.22.0", "0.23.0", "0.24.0-beta.1"],
      },
    });
  });

  it("writes negative backoff when refresh fails", async () => {
    const dir = tempDir();
    const fetcher = vi.fn<typeof fetch>(async () => new Response("nope", { status: 503 }));

    await expect(refreshUpdateMetadata({ cacheDir: dir, fetcher, now: 1_000 })).resolves.toBe(
      "failed",
    );

    expect(readUpdateMetadataCache({ cacheDir: dir, now: 1_001 })).toMatchObject({
      status: "negative",
      reason: "http",
      fresh: true,
    });
  });

  it("skips refresh when a fresh lock exists", async () => {
    const dir = tempDir();
    writePrivateJson(updateRefreshLockPath({ cacheDir: dir }), { lockedAt: 1_000 });
    const fetcher = vi.fn<typeof fetch>();

    await expect(refreshUpdateMetadata({ cacheDir: dir, fetcher, now: 1_001 })).resolves.toBe(
      "skipped",
    );

    expect(fetcher).not.toHaveBeenCalled();
  });
});
