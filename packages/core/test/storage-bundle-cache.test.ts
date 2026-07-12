import { mkdtemp, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContentAddressedBundleCache,
  MAX_AUTHORITY_BUNDLE_ASSET_BYTES,
  normalizeAuthorityBundle,
} from "../src/storage/bundle-cache";
import { CapletsError } from "../src/errors";

import type { AuthorityCapletBundle } from "../src/storage/bundle-cache";

const bundle = (): AuthorityCapletBundle => ({
  entryPath: "app/CAPLET.md",
  files: [
    {
      path: "app/CAPLET.md",
      content: "---\nname: App\nmcpServer:\n  command: ./tool.sh\n---\n",
    },
    { path: "app/tool.sh", content: "#!/bin/sh\nprintf bundle\n", mode: 0o755 },
  ],
});

describe("authority bundle normalization", () => {
  it("rejects traversal, duplicate, digest, length, and oversized assets", () => {
    expect(() =>
      normalizeAuthorityBundle({ files: [{ path: "../escape", content: "x" }] }),
    ).toThrow(/traverses/);
    expect(() =>
      normalizeAuthorityBundle({
        files: [
          { path: "a.md", content: "x" },
          { path: "a.md", content: "y" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      normalizeAuthorityBundle({
        files: [{ path: "CAPLET.md", content: "x", digest: "sha256:bad" }],
      }),
    ).toThrow(/digest/);
    expect(() =>
      normalizeAuthorityBundle({ files: [{ path: "CAPLET.md", content: "x", length: 2 }] }),
    ).toThrow(/length/);
    expect(() =>
      normalizeAuthorityBundle(
        { files: [{ path: "CAPLET.md", content: "x" }] },
        { maxAssetBytes: 0 },
      ),
    ).toThrow(/byte limit/);
    expect(MAX_AUTHORITY_BUNDLE_ASSET_BYTES).toBeGreaterThan(0);
  });
});

describe("content-addressed authority bundle cache", () => {
  it("materializes executable files, shares references, and cleans only unpinned entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-cache-"));
    const cache = new ContentAddressedBundleCache({ root });
    const normalized = cache.normalize(bundle());
    const first = await cache.materialize(bundle());
    const second = await cache.materialize(bundle());
    expect(first.fingerprint).toBe(normalized.fingerprint);
    expect(first.entryPath).toBe(join(first.root, "app", "CAPLET.md"));
    expect(first.files.find((file) => file.path === "app/tool.sh")?.mode).toBe(0o755);

    cache.pin(first.fingerprint);
    await first.release();
    await second.release();
    expect(await cache.cleanup()).toEqual([]);
    expect((await readdir(root)).filter((entry) => entry === first.fingerprint)).toEqual([
      first.fingerprint,
    ]);

    await cache.unpin(first.fingerprint);
    expect(await cache.cleanup()).toEqual([first.fingerprint]);
    expect((await readdir(root)).filter((entry) => entry === first.fingerprint)).toEqual([]);
  });

  it("age-gates interrupted temporary candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-cache-"));
    const fresh = join(root, ".tmp-fresh");
    const stale = join(root, ".tmp-stale");
    await mkdir(fresh);
    await writeFile(join(fresh, "partial"), "partial");
    await mkdir(stale);
    await writeFile(join(stale, "partial"), "partial");
    const now = Date.now();
    const staleAt = new Date(now - 120_000);
    await utimes(stale, staleAt, staleAt);
    const cache = new ContentAddressedBundleCache({ root });

    expect(await cache.cleanup({ now })).toEqual([]);
    await expect(readdir(fresh)).resolves.toEqual(["partial"]);
    await expect(readdir(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a local materialization while cleanup runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-cache-"));
    const cache = new ContentAddressedBundleCache({ root });
    const pending = cache.materialize(bundle());
    expect(await cache.cleanup({ now: Date.now() + 120_000 })).toEqual([]);
    const result = await pending;
    await expect(readdir(result.root)).resolves.toEqual(
      expect.arrayContaining([".bundle.json", "app"]),
    );
    await result.release();
    expect(await cache.cleanup()).toEqual([result.fingerprint]);
  });

  it("rejects malformed bundles before materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-cache-"));
    const cache = new ContentAddressedBundleCache({ root });
    await expect(
      cache.materialize({
        files: [{ path: "CAPLET.md", content: "---\nname: Broken\n---\n", length: 999 }],
      }),
    ).rejects.toBeInstanceOf(CapletsError);
    expect(await readdir(root)).toEqual([]);
  });
});
