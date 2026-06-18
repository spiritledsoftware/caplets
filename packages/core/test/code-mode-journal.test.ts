import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeModeJournalStore, classifyCodeModeRecovery } from "../src/code-mode/journal";

describe("Code Mode journal", () => {
  it("stores redacted entries without raw capability tokens and reads by recovery ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-"));
    try {
      const store = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:00.000Z"),
      });
      const sessionId = "019ed8b0-a705-7bd1-bf54-62f0d30c9e94";

      const stored = await store.store({
        sessionId,
        code: `const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL0123456789';\nconst session = '${sessionId}';\nreturn token;`,
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
        logRef: "a".repeat(48),
      });

      expect(stored.recoveryRef).toMatch(/^[a-f0-9]{48}$/u);
      const raw = readFileSync(
        join(dir, "code-mode", "journal", `${stored.journalKey}.json`),
        "utf8",
      );
      expect(raw).not.toContain(sessionId);
      expect(raw).not.toContain(stored.recoveryRef);
      expect(raw).not.toContain("a".repeat(48));
      expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL0123456789");
      expect(raw).toContain("[REDACTED:credential]");
      expect(raw).toContain("[REDACTED:capability]");

      const read = await store.readRecovery({ recoveryRef: stored.recoveryRef });

      expect(read.entries).toEqual([
        expect.objectContaining({
          code: expect.stringContaining("[REDACTED:credential]"),
          declarationHash: "hash-1",
          outcome: { ok: true },
          recoveryClassification: "setup_like",
          logsStored: true,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looks up retained history by session id without revealing recovery refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-"));
    try {
      const first = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:00.000Z"),
      });
      const stored = await first.store({
        sessionId: "session-retained",
        code: "function helper() { return 1; }",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });
      const second = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });

      await expect(second.lookupSession("session-retained")).resolves.toEqual({
        expiresAt: stored.expiresAt,
        recoveryRef: stored.recoveryRef,
      });
      await expect(second.readRecovery({ recoveryRef: stored.recoveryRef })).resolves.toMatchObject(
        {
          entries: [expect.objectContaining({ recoveryClassification: "setup_like" })],
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps earlier recovery refs valid across fresh journal store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-"));
    try {
      const firstStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:00.000Z"),
      });
      const first = await firstStore.store({
        sessionId: "session-stable-ref",
        code: "var first = 1;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });
      const secondStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });
      const second = await secondStore.store({
        sessionId: "session-stable-ref",
        code: "var second = 2;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });

      expect(second.recoveryRef).toBe(first.recoveryRef);
      await expect(
        secondStore.readRecovery({ recoveryRef: first.recoveryRef }),
      ).resolves.toMatchObject({
        entries: [expect.any(Object), expect.any(Object)],
      });
      await expect(
        secondStore.readRecovery({ recoveryRef: second.recoveryRef }),
      ).resolves.toMatchObject({
        entries: [expect.any(Object), expect.any(Object)],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims old entries, expires files, and rejects invalid recovery refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-"));
    try {
      let now = new Date("2026-06-17T12:00:00.000Z");
      const store = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => now,
        retentionMs: 10,
        maxEntries: 2,
        maxCodeBytes: 8,
      });

      const first = await store.store({
        sessionId: "session-capped",
        code: "const alpha = 1;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });
      await store.store({
        sessionId: "session-capped",
        code: "const beta = 2;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });
      await store.store({
        sessionId: "session-capped",
        code: "const gamma = 3;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });

      const retained = await store.readRecovery({ recoveryRef: first.recoveryRef });
      expect(retained.entries).toHaveLength(2);
      expect(retained.entries[0]?.code).toBe("const be");
      await expect(store.readRecovery({ recoveryRef: "not-a-ref" })).resolves.toEqual({
        entries: [],
      });
      await expect(
        store.readRecovery({ recoveryRef: first.recoveryRef, limit: 0 }),
      ).resolves.toEqual({
        entries: [],
      });

      now = new Date("2026-06-17T12:00:00.011Z");
      await expect(store.readRecovery({ recoveryRef: first.recoveryRef })).resolves.toEqual({
        entries: [],
      });
      await expect(store.lookupSession("session-capped")).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses owner-only journal files and rejects symlinked storage paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-"));
    try {
      const store = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:00.000Z"),
      });
      const stored = await store.store({
        sessionId: "session-mode",
        code: "var x = 1;",
        declarationHash: "hash-1",
        outcome: { ok: true },
        diagnostics: [],
        recoveryClassification: "setup_like",
      });

      expect(lstatSync(join(dir, "code-mode", "journal")).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(join(dir, "code-mode", "journal", `${stored.journalKey}.json`)).mode & 0o777,
      ).toBe(0o600);

      const symlinkRoot = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-link-"));
      mkdirSync(join(symlinkRoot, "code-mode"));
      symlinkSync(join(dir, "code-mode", "journal"), join(symlinkRoot, "code-mode", "journal"));
      const symlinked = new CodeModeJournalStore({
        stateDir: symlinkRoot,
        secret: "test-secret",
      });

      await expect(
        symlinked.store({
          sessionId: "session-link",
          code: "var x = 1;",
          declarationHash: "hash-1",
          outcome: { ok: true },
          diagnostics: [],
          recoveryClassification: "setup_like",
        }),
      ).rejects.toThrow("Code Mode journal path must not contain symlinks");
      rmSync(symlinkRoot, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked intermediate code-mode parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-parent-link-"));
    const outside = mkdtempSync(join(tmpdir(), "caplets-code-mode-journal-outside-"));
    try {
      symlinkSync(outside, join(dir, "code-mode"));
      const store = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
      });

      await expect(
        store.store({
          sessionId: "session-link",
          code: "var x = 1;",
          declarationHash: "hash-1",
          outcome: { ok: true },
          diagnostics: [],
          recoveryClassification: "setup_like",
        }),
      ).rejects.toThrow("Code Mode journal path must not contain symlinks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("classifies Caplet execution as side-effecting and helper setup as setup-like", () => {
    expect(
      classifyCodeModeRecovery({ code: "function helper() { return 1; }", invokedCaplet: false }),
    ).toBe("setup_like");
    expect(classifyCodeModeRecovery({ code: "return 1;", invokedCaplet: false })).toBe("unknown");
    expect(
      classifyCodeModeRecovery({
        code: 'return await caplets.github.callTool("create", {});',
        invokedCaplet: true,
      }),
    ).toBe("side_effecting");
  });
});
