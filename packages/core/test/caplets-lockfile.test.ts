import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
      expect(
        readdirSync(join(dir, "nested")).filter((entry) =>
          entry.startsWith(".caplets.lock.json.tmp-"),
        ),
      ).toEqual([]);
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

      writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          entries: [
            lockEntry({
              source: {
                type: "git",
                repository: "https://github.com/spiritledsoftware/caplets.git",
                path: "../outside",
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

  it("rejects unknown and duplicate JSON fields at every manifest level", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-strict-fields-"));
    const lockPath = join(dir, "caplets.lock.json");
    try {
      for (const lockfile of [
        { version: 1, entries: [], unexpected: true },
        { version: 1, entries: [{ ...lockEntry(), unexpected: true }] },
        {
          version: 1,
          entries: [{ ...lockEntry(), source: { ...lockEntry().source, unexpected: true } }],
        },
        {
          version: 1,
          entries: [{ ...lockEntry(), risk: { ...lockEntry().risk, unexpected: true } }],
        },
        {
          version: 1,
          entries: [
            {
              ...lockEntry(),
              runtimeFingerprint: {
                version: 1,
                artifactFingerprint: "sha256:runtime",
                unexpected: true,
              },
            },
          ],
        },
      ]) {
        writeFileSync(lockPath, `${JSON.stringify(lockfile)}\n`);
        expect(() => readCapletsLockfile(lockPath)).toThrow(
          expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
        );
      }

      writeFileSync(lockPath, '{"version":1,"version":1,"entries":[]}\n');
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(
        lockPath,
        `{"version":1,"entries":[${JSON.stringify(lockEntry()).replace(
          '"destination":"github"',
          '"destination":"github","destination":"github"',
        )}]}\n`,
      );
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips optional v1 runtime fingerprints and rejects malformed present state", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-runtime-fingerprint-"));
    const lockPath = join(dir, "caplets.lock.json");
    try {
      const persisted = lockEntry({
        runtimeFingerprint: {
          version: 1,
          artifactFingerprint: "sha256:runtime",
        },
      });
      writeCapletsLockfile(lockPath, { version: 1, entries: [persisted] });
      expect(readCapletsLockfile(lockPath)).toMatchObject({ version: 1, entries: [persisted] });

      for (const runtimeFingerprint of [
        null,
        {},
        { version: 2, artifactFingerprint: "sha256:runtime" },
        { version: 1, artifactFingerprint: "" },
      ]) {
        writeFileSync(
          lockPath,
          `${JSON.stringify({
            version: 1,
            entries: [{ ...lockEntry(), runtimeFingerprint }],
          })}\n`,
        );
        expect(() => readCapletsLockfile(lockPath)).toThrow(
          expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing lockfiles as not found instead of invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-lockfile-missing-"));
    const lockPath = join(dir, "caplets.lock.json");
    try {
      expect(() => readCapletsLockfile(lockPath)).toThrow(
        expect.objectContaining({
          code: "CONFIG_NOT_FOUND",
          message: `Caplets lockfile not found at ${lockPath}`,
        }) as CapletsError,
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
