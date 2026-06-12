import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeModeLogStore, redactCodeModeLogText } from "../src/code-mode/logs";

describe("Code Mode logs", () => {
  it("redacts common secrets, credentials, and PII", () => {
    const redacted = redactCodeModeLogText(
      [
        "Authorization: Bearer secret-token-value",
        "cookie=session=secret-cookie",
        "email ian@example.com",
        "phone +1 (555) 123-4567",
        "ssn 123-45-6789",
        "card 4111 1111 1111 1111",
        "token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL0123456789",
      ].join("\n"),
    );

    expect(redacted).not.toContain("secret-token-value");
    expect(redacted).not.toContain("secret-cookie");
    expect(redacted).not.toContain("ian@example.com");
    expect(redacted).not.toContain("123-45-6789");
    expect(redacted).not.toContain("4111 1111 1111 1111");
    expect(redacted).toContain("[REDACTED:token]");
    expect(redacted).toContain("[REDACTED:email]");
    expect(redacted).toContain("[REDACTED:ssn]");
    expect(redacted).toContain("[REDACTED:credit-card]");
  });

  it("stores redacted entries and reads them by opaque logRef", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-logs-"));
    try {
      const store = new CodeModeLogStore({
        stateDir: dir,
        now: () => new Date("2026-06-07T12:00:00.000Z"),
      });
      const stored = await store.store([
        {
          level: "log",
          message: "hello bearer secret-token-value ian@example.com",
          timestamp: "2026-06-07T12:00:00.000Z",
        },
      ]);

      expect(stored.logRef).toMatch(/^[a-f0-9]{48}$/u);
      const raw = readFileSync(join(dir, "code-mode", "logs", `${stored.logRef}.json`), "utf8");
      expect(raw).not.toContain("secret-token-value");
      expect(raw).not.toContain("ian@example.com");

      const read = await store.read({ logRef: stored.logRef, limit: 10 });

      expect(read.entries).toEqual([
        {
          level: "log",
          message: "hello bearer [REDACTED:token] [REDACTED:email]",
          timestamp: "2026-06-07T12:00:00.000Z",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no entries for expired or unknown log refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-logs-"));
    try {
      const store = new CodeModeLogStore({
        stateDir: dir,
        now: () => new Date("2026-06-07T12:00:00.000Z"),
        logRefTtlMs: 1,
      });
      const stored = await store.store([
        {
          level: "log",
          message: "hello",
          timestamp: "2026-06-07T12:00:00.000Z",
        },
      ]);
      const expiredStore = new CodeModeLogStore({
        stateDir: dir,
        now: () => new Date("2026-06-07T12:00:01.000Z"),
        logRefTtlMs: 1,
      });

      await expect(expiredStore.read({ logRef: stored.logRef })).resolves.toEqual({ entries: [] });
      await expect(expiredStore.read({ logRef: "0".repeat(48) })).resolves.toEqual({ entries: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
