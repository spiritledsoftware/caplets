import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completionCacheKey,
  readCompletionCacheEntry,
  writeCompletionCacheEntry,
} from "../src/cli/completion-cache";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("completion cache", () => {
  it("round-trips fresh positive entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "repo",
      backend: "cli",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "positive",
      fetchedAt: 1000,
      expiresAt: 2000,
      candidates: [{ value: "repo.status" }],
    });
    expect(readCompletionCacheEntry(dir, key, 1500)).toEqual(
      expect.objectContaining({ status: "positive", fresh: true }),
    );
  });

  it("marks expired entries as stale instead of deleting usable candidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "repo",
      backend: "cli",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "positive",
      fetchedAt: 1000,
      expiresAt: 2000,
      candidates: [{ value: "repo.status" }],
    });
    expect(readCompletionCacheEntry(dir, key, 2500)).toEqual(
      expect.objectContaining({ status: "positive", fresh: false }),
    );
  });

  it("stores negative entries without candidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const key = completionCacheKey({
      server: "github",
      backend: "mcp",
      kind: "tools",
      fingerprint: "abc",
    });
    writeCompletionCacheEntry(dir, key, {
      status: "negative",
      fetchedAt: 1000,
      expiresAt: 2000,
      reason: "auth_required",
    });
    expect(readCompletionCacheEntry(dir, key, 1500)).toEqual(
      expect.objectContaining({ status: "negative", fresh: true, reason: "auth_required" }),
    );
  });
});
