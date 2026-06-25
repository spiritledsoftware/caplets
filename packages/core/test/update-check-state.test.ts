import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUpdateMetadataCache,
  recordUpdateNoticeShown,
  shouldShowUpdateNotice,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_MAX_STALE_MS,
  UPDATE_CHECK_NOTICE_REPEAT_MS,
  updateMetadataCachePath,
  writeUpdateMetadataCache,
} from "../src/update-check";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-update-check-state-"));
  dirs.push(dir);
  return dir;
}

describe("update-check state", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads fresh and max-stale positive metadata", () => {
    const dir = tempDir();
    const now = 1_000;
    writeUpdateMetadataCache(
      {
        status: "positive",
        fetchedAt: now,
        expiresAt: now + UPDATE_CHECK_CACHE_TTL_MS,
        staleUntil: now + UPDATE_CHECK_CACHE_TTL_MS + UPDATE_CHECK_MAX_STALE_MS,
        source: "https://registry.npmjs.org/caplets",
        metadata: {
          packageName: "caplets",
          distTags: { latest: "0.23.0" },
          versions: ["0.23.0"],
        },
      },
      { cacheDir: dir },
    );

    expect(readUpdateMetadataCache({ cacheDir: dir, now })?.fresh).toBe(true);
    const stale = readUpdateMetadataCache({
      cacheDir: dir,
      now: now + UPDATE_CHECK_CACHE_TTL_MS + 1,
    });
    expect(stale?.fresh).toBe(false);
    expect(stale?.usable).toBe(true);
  });

  it("ignores corrupt cache JSON", () => {
    const dir = tempDir();
    writeFileSync(updateMetadataCachePath({ cacheDir: dir }), "{");

    expect(readUpdateMetadataCache({ cacheDir: dir })).toBeUndefined();
  });

  it("suppresses repeated notices for the same version", () => {
    const dir = tempDir();
    const now = 10_000;
    expect(shouldShowUpdateNotice("0.23.0", { stateDir: dir, now })).toBe(true);
    recordUpdateNoticeShown("0.23.0", { stateDir: dir, now });
    expect(shouldShowUpdateNotice("0.23.0", { stateDir: dir, now: now + 1 })).toBe(false);
    expect(
      shouldShowUpdateNotice("0.23.0", {
        stateDir: dir,
        now: now + UPDATE_CHECK_NOTICE_REPEAT_MS + 1,
      }),
    ).toBe(true);
    expect(shouldShowUpdateNotice("0.24.0", { stateDir: dir, now: now + 1 })).toBe(true);
  });
});
