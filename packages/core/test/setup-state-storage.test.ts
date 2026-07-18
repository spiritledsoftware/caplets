import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage/database";
import { SetupStateStore } from "../src/storage/setup-state";
import type { SetupAttempt } from "../src/setup/types";
import * as sqlite from "../src/storage/schema/sqlite";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQL setup state", () => {
  it("shares approvals and retained attempts across repository instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-setup-state-"));
    directories.push(root);
    const firstStorage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    const now = new Date("2026-07-18T12:00:00.000Z");
    const first = new SetupStateStore(firstStorage.database, {
      now: () => now,
      maxAttempts: 2,
      retentionDays: 7,
    });
    const second = new SetupStateStore(firstStorage.database, {
      now: () => now,
      maxAttempts: 2,
      retentionDays: 7,
    });

    try {
      await first.approve({
        projectFingerprint: "project-a",
        capletId: "ast-grep",
        contentHash: "sha256:content",
        targetKind: "remote_host",
        approvedAt: now.toISOString(),
        actor: "ui",
      });

      await expect(
        second.getApproval("project-a", "ast-grep", "sha256:content", "remote_host"),
      ).resolves.toEqual({
        projectFingerprint: "project-a",
        capletId: "ast-grep",
        contentHash: "sha256:content",
        targetKind: "remote_host",
        approvedAt: now.toISOString(),
        actor: "ui",
      });

      await expect(
        first.approve(
          {
            projectFingerprint: "project-a",
            capletId: "ast-grep",
            contentHash: "sha256:content",
            targetKind: "remote_host",
            approvedAt: now.toISOString(),
            actor: "automation",
          },
          { expectedGeneration: 0 },
        ),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: expect.objectContaining({ kind: "stale_generation" }),
      });

      await first.recordAttempt(attempt("attempt-1", "first", now));
      await second.recordAttempt(attempt("attempt-2", "second", now));
      await first.recordAttempt(attempt("attempt-3", "third", now));
      await expect(
        second.recordAttempt(attempt("attempt-stale", "stale", now), {
          expectedGeneration: 2,
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: expect.objectContaining({ kind: "stale_generation" }),
      });

      await expect(second.listAttempts("project-a", "ast-grep")).resolves.toMatchObject([
        { attemptId: "attempt-2", commandLabel: "second" },
        { attemptId: "attempt-3", commandLabel: "third" },
      ]);
      await expect(first.getAttempt("project-a", "ast-grep", "attempt-3")).resolves.toMatchObject({
        commandLabel: "third",
      });
      await expect(second.clearAttempts("project-a", "ast-grep")).resolves.toBe(true);
      await expect(first.listAttempts("project-a", "ast-grep")).resolves.toEqual([]);
      if (firstStorage.database.dialect !== "sqlite") {
        throw new Error("Expected SQLite storage.");
      }
      expect(firstStorage.database.db.select().from(sqlite.setupApprovals).all()).toHaveLength(1);
    } finally {
      await firstStorage.close();
    }
  });
});

function attempt(attemptId: string, commandLabel: string, now: Date): SetupAttempt {
  return {
    attemptId,
    projectFingerprint: "project-a",
    capletId: "ast-grep",
    contentHash: "sha256:content",
    targetKind: "remote_host",
    actor: "automation",
    status: "succeeded",
    phase: "commands",
    commandLabel,
    argv: ["echo", commandLabel],
    exitCode: 0,
    durationMs: 1,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    stdout: "ok",
    stderr: "",
    redacted: true,
    retention: { maxAttempts: 2, days: 7 },
  };
}
