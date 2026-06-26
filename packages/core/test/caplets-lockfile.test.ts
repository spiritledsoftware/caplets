import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCapletsLockfile,
  validateLockfileDestination,
  writeCapletsLockfile,
  type CapletsLockfile,
} from "../src/cli/lockfile";
import type { CapletsError } from "../src/errors";

describe("caplets lockfile", () => {
  it("writes and reads lockfiles atomically with stable entry ordering", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-"));
    const lockPath = join(dir, "nested", "caplets.lock.json");
    try {
      const lockfile: CapletsLockfile = {
        version: 1,
        entries: [
          lockEntry({ id: "github", destination: "github" }),
          lockEntry({ id: "filesystem", destination: "filesystem.md", kind: "file" }),
        ],
      };

      writeCapletsLockfile(lockPath, lockfile);

      expect(readFileSync(lockPath, "utf8")).toBe(
        `${JSON.stringify(
          {
            version: 1,
            entries: [
              lockEntry({ id: "filesystem", destination: "filesystem.md", kind: "file" }),
              lockEntry({ id: "github", destination: "github" }),
            ],
          },
          null,
          2,
        )}\n`,
      );
      expect(readCapletsLockfile(lockPath)).toEqual({
        version: 1,
        entries: [
          lockEntry({ id: "filesystem", destination: "filesystem.md", kind: "file" }),
          lockEntry({ id: "github", destination: "github" }),
        ],
      });
      expect(existsSync(join(dir, "nested", "caplets.lock.json.tmp"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed, unsupported, duplicate, and credential-bearing lock entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-invalid-"));
    const lockPath = join(dir, "caplets.lock.json");
    try {
      writeFileSync(lockPath, "{ invalid");
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(lockPath, `${JSON.stringify({ version: 2, entries: [] })}\n`);
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          entries: [lockEntry({ id: "github" }), lockEntry({ id: "github" })],
        })}\n`,
      );
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );

      writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          entries: [
            lockEntry({
              source: {
                type: "git",
                repository: "https://token@example.com/private/repo.git",
                path: "caplets/github",
                trackedRef: "main",
                resolvedRevision: "abc123",
                portability: "portable",
              },
            }),
          ],
        })}\n`,
      );
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates lockfile destinations against the selected Caplets root", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-destination-"));
    const root = join(dir, "caplets");
    const outside = join(dir, "outside");
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, "linked"));

      expect(validateLockfileDestination(root, "github")).toBe(join(root, "github"));
      expect(() => validateLockfileDestination(root, "/tmp/github")).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
      expect(() => validateLockfileDestination(root, "../github")).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
      expect(() => validateLockfileDestination(root, "linked/github")).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function lockEntry(overrides: Partial<CapletsLockfile["entries"][number]> = {}) {
  return {
    id: "github",
    destination: "github",
    kind: "directory" as const,
    source: {
      type: "git" as const,
      repository: "https://github.com/spiritledsoftware/caplets.git",
      path: "caplets/github",
      trackedRef: "main",
      resolvedRevision: "abc123",
      portability: "portable" as const,
    },
    installedHash: "sha256:abc",
    installedAt: "2026-06-26T12:00:00.000Z",
    updatedAt: "2026-06-26T12:00:00.000Z",
    risk: {
      backendFamilies: ["mcp"],
      safety: "standard" as const,
      projectBindingRequired: false,
      mutating: false,
      destructive: false,
    },
    ...overrides,
  };
}
