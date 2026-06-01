import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyRemoteFileChanges,
  classifyApplyResult,
  createApplyReceipt,
  sha256,
} from "../src/cloud/apply";

describe("cloud apply receipts", () => {
  it("creates a clean apply receipt", () => {
    expect(
      createApplyReceipt({
        projectFingerprint: "sha256:abc",
        filesChanged: ["src/app.ts"],
        skipped: [],
        policyWarnings: [],
      }),
    ).toEqual({
      status: "applied",
      projectFingerprint: "sha256:abc",
      filesChanged: ["src/app.ts"],
      skipped: [],
      policyWarnings: [],
    });
  });

  it("classifies conflicts as recoverable", () => {
    expect(classifyApplyResult({ conflicts: [{ path: "src/app.ts", kind: "content" }] })).toEqual({
      status: "apply_conflict",
      recoverable: true,
      conflicts: [{ path: "src/app.ts", kind: "content" }],
    });
  });

  it("implicitly applies clean remote sandbox file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-apply-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/app.ts"), "old", "utf8");

      const result = applyRemoteFileChanges(dir, [
        { path: "src/app.ts", baseSha256: sha256("old"), content: "new" },
      ]);

      expect(result).toMatchObject({ status: "applied", filesChanged: ["src/app.ts"] });
      expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns conflicts without writing when local files diverged", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-apply-conflict-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/app.ts"), "local edit", "utf8");

      const result = applyRemoteFileChanges(dir, [
        { path: "src/app.ts", baseSha256: sha256("old"), content: "remote edit" },
      ]);

      expect(result).toMatchObject({
        status: "apply_conflict",
        recoverable: true,
        conflicts: [expect.objectContaining({ path: "src/app.ts", kind: "content" })],
      });
      expect(readFileSync(join(dir, "src/app.ts"), "utf8")).toBe("local edit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow project symlinks while applying changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-apply-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "caplets-outside-"));
    try {
      writeFileSync(join(outside, "target.txt"), "outside", "utf8");
      symlinkSync(join(outside, "target.txt"), join(dir, "link.txt"));

      const result = applyRemoteFileChanges(dir, [
        { path: "link.txt", baseSha256: sha256("outside"), content: "remote edit" },
      ]);

      expect(result).toMatchObject({
        status: "apply_conflict",
        conflicts: [expect.objectContaining({ path: "link.txt" })],
      });
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
