import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
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

  it("removes interrupted temporary candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-bundle-cache-"));
    await mkdir(join(root, ".tmp-interrupted"));
    await writeFile(join(root, ".tmp-interrupted", "partial"), "partial");
    const cache = new ContentAddressedBundleCache({ root });
    expect(await cache.cleanup()).toEqual([]);
    await expect(readdir(join(root, ".tmp-interrupted"))).rejects.toMatchObject({ code: "ENOENT" });
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
