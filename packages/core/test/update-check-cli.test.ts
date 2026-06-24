import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import {
  readUpdateNoticeState,
  UPDATE_CHECK_CACHE_TTL_MS,
  writeUpdateMetadataCache,
} from "../src/update-check";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-update-check-cli-"));
  dirs.push(dir);
  return dir;
}

function writeCachedLatest(cacheDir: string, now = Date.now()): void {
  writeUpdateMetadataCache(
    {
      status: "positive",
      fetchedAt: now,
      expiresAt: now + UPDATE_CHECK_CACHE_TTL_MS,
      staleUntil: now + UPDATE_CHECK_CACHE_TTL_MS * 2,
      source: "https://registry.npmjs.org/caplets",
      metadata: {
        packageName: "caplets",
        distTags: { latest: "0.23.0" },
        versions: ["0.22.0", "0.23.0"],
      },
    },
    { cacheDir },
  );
}

describe("update-check CLI", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints cached updates to stderr only for eligible human-facing commands", async () => {
    const dir = tempDir();
    const out: string[] = [];
    const err: string[] = [];
    writeCachedLatest(join(dir, "cache"));

    await runCli(["telemetry", "status"], {
      version: "0.22.0",
      stderrIsTTY: true,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
    });

    expect(out.join("")).toContain("Telemetry:");
    expect(out.join("")).not.toContain("Update available");
    expect(err.join("")).toContain("Update available: caplets 0.22.0 -> 0.23.0");
    expect(readUpdateNoticeState({ stateDir: join(dir, "state") }).shown["0.23.0"]).toBeDefined();
  });

  it("does not fall back to the core package version when no CLI version is injected", async () => {
    const dir = tempDir();
    const err: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    writeCachedLatest(join(dir, "cache"));

    await runCli(["telemetry", "status"], {
      stderrIsTTY: true,
      fetch: fetcher,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: () => {},
      writeErr: (value) => err.push(value),
    });

    expect(err.join("")).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("suppresses help, version, JSON, and completion output products", async () => {
    const dir = tempDir();
    const err: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    writeCachedLatest(join(dir, "cache"));
    const io = {
      version: "0.22.0",
      stderrIsTTY: true,
      fetch: fetcher,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: () => {},
      writeErr: (value: string) => err.push(value),
    };

    await runCli(["--version"], io);
    await runCli(["config", "paths", "--json"], io);
    await runCli(["completion", "bash"], io);

    expect(err.join("")).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps default stdio serve quiet even when stderr is a TTY", async () => {
    const dir = tempDir();
    const err: string[] = [];
    writeCachedLatest(join(dir, "cache"));

    await runCli(["serve"], {
      version: "0.22.0",
      stderrIsTTY: true,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeErr: (value) => err.push(value),
      serve: async () => {},
    });

    expect(err.join("")).toBe("");
  });

  it("allows explicit stdio stderr opt-in without touching stdout", async () => {
    const dir = tempDir();
    const out: string[] = [];
    const err: string[] = [];
    writeCachedLatest(join(dir, "cache"));

    await runCli(["serve"], {
      env: { CAPLETS_UPDATE_NOTICE_STDERR: "1" },
      version: "0.22.0",
      stderrIsTTY: false,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: (value) => out.push(value),
      writeErr: (value) => err.push(value),
      serve: async () => {},
    });

    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("Update available: caplets 0.22.0 -> 0.23.0");
  });

  it("does not let telemetry disablement suppress update detection", async () => {
    const dir = tempDir();
    const err: string[] = [];
    writeCachedLatest(join(dir, "cache"));

    await runCli(["telemetry", "status"], {
      env: { CAPLETS_DISABLE_TELEMETRY: "1" },
      version: "0.22.0",
      stderrIsTTY: true,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: () => {},
      writeErr: (value) => err.push(value),
    });

    expect(err.join("")).toContain("Update available: caplets 0.22.0 -> 0.23.0");
  });

  it("suppresses CI and non-interactive contexts without refresh by default", async () => {
    const dir = tempDir();
    const fetcher = vi.fn<typeof fetch>();

    await runCli(["telemetry", "status"], {
      env: { CI: "true" },
      version: "0.22.0",
      stderrIsTTY: true,
      fetch: fetcher,
      updateCheckCacheDir: join(dir, "ci-cache"),
      updateCheckStateDir: join(dir, "ci-state"),
      writeOut: () => {},
      writeErr: () => {},
    });
    await runCli(["telemetry", "status"], {
      version: "0.22.0",
      stderrIsTTY: false,
      fetch: fetcher,
      updateCheckCacheDir: join(dir, "script-cache"),
      updateCheckStateDir: join(dir, "script-state"),
      writeOut: () => {},
      writeErr: () => {},
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disables notice and refresh with CAPLETS_DISABLE_UPDATE_CHECK", async () => {
    const dir = tempDir();
    const err: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    writeCachedLatest(join(dir, "cache"));

    await runCli(["telemetry", "status"], {
      env: { CAPLETS_DISABLE_UPDATE_CHECK: "1" },
      version: "0.22.0",
      stderrIsTTY: true,
      fetch: fetcher,
      updateCheckCacheDir: join(dir, "cache"),
      updateCheckStateDir: join(dir, "state"),
      writeOut: () => {},
      writeErr: (value) => err.push(value),
    });

    expect(err.join("")).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not mark an update shown when stderr write fails", async () => {
    const dir = tempDir();
    writeCachedLatest(join(dir, "cache"));

    await expect(
      runCli(["telemetry", "status"], {
        version: "0.22.0",
        stderrIsTTY: true,
        updateCheckCacheDir: join(dir, "cache"),
        updateCheckStateDir: join(dir, "state"),
        writeOut: () => {},
        writeErr: () => {
          throw new Error("stderr failed");
        },
      }),
    ).resolves.toBeUndefined();

    expect(readUpdateNoticeState({ stateDir: join(dir, "state") }).shown["0.23.0"]).toBeUndefined();
  });
});
