import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import { capletSetupContentHash } from "../src/setup/hash";
import { LocalSetupStore } from "../src/setup/local-store";
import { runCapletSetup, type SetupSpawn } from "../src/setup/runner";
import type { SetupAttempt } from "../src/setup/types";

describe("setup runner", () => {
  it("changes content hash when setup metadata changes", () => {
    const first = caplet("npm", ["install", "-g", "first"]);
    const second = caplet("npm", ["install", "-g", "second"]);
    expect(capletSetupContentHash(first)).not.toBe(capletSetupContentHash(second));
  });

  it("requires approval before commands run", async () => {
    const store = memoryStore();
    await expect(
      runCapletSetup({
        capletId: "ast-grep",
        contentHash: "hash",
        targetKind: "local",
        actor: "cli-interactive",
        approved: false,
        setup: { commands: [{ label: "Install", command: "npm" }] },
        store,
        spawn: successfulSpawn(),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(store.attempts).toEqual([]);
  });

  it("records successful setup and verify attempts without executing real package managers", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [{ label: "Install", command: "npm", args: ["install"] }],
        verify: [{ label: "Verify", command: "ast-grep-mcp", args: ["--help"] }],
      },
      store,
      spawn: successfulSpawn(),
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["succeeded", "succeeded"]);
    expect(attempts[0]?.actor).toBe("cli-yes");
    expect(store.attempts).toHaveLength(2);
  });

  it("leaves status failed when verify fails", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [{ label: "Install", command: "npm" }],
        verify: [{ label: "Verify", command: "ast-grep-mcp" }],
      },
      store,
      spawn: async (command) => ({
        exitCode: command === "ast-grep-mcp" ? 1 : 0,
        stdout: "",
        stderr: "missing",
        durationMs: 1,
      }),
    });
    expect(attempts.at(-1)).toMatchObject({ phase: "verify", status: "failed" });
  });

  it("caps output and redacts secret-looking env values", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      capletId: "secret",
      contentHash: "hash",
      targetKind: "local",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [
          {
            label: "Install",
            command: "echo",
            env: { API_TOKEN: "super-secret-value" },
            maxOutputBytes: 12,
          },
        ],
      },
      store,
      spawn: async () => ({
        exitCode: 0,
        stdout: "super-secret-value with trailing data",
        stderr: "",
        durationMs: 1,
      }),
    });
    expect(attempts[0]?.stdout).toBe("[REDACTED] w");
    expect(attempts[0]?.redacted).toBe(true);
  });

  it("keeps local attempts to the free retention window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir, maxAttempts: 3, retentionDays: 7 });
      for (let index = 0; index < 5; index += 1) {
        await store.recordAttempt({
          ...attempt(index),
          capletId: "ast-grep",
        });
      }
      const attempts = await store.listAttempts("ast-grep");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((entry) => entry.commandLabel)).toEqual(["2", "3", "4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function caplet(command: string, args: string[]): CapletConfig {
  return {
    server: "ast-grep",
    backend: "mcp",
    name: "ast-grep",
    description: "Structural search",
    transport: "stdio",
    command: "ast-grep-mcp",
    startupTimeoutMs: 10,
    callTimeoutMs: 10,
    toolCacheTtlMs: 10,
    disabled: false,
    setup: { commands: [{ label: "Install", command, args }] },
  };
}

function successfulSpawn(): SetupSpawn {
  return async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
}

function memoryStore() {
  const attempts: SetupAttempt[] = [];
  return {
    attempts,
    retention: () => ({ maxAttempts: 3, days: 7 }),
    recordAttempt: async (attempt: SetupAttempt) => {
      attempts.push(attempt);
    },
  };
}

function attempt(index: number): SetupAttempt {
  return {
    attemptId: `attempt-${index}`,
    capletId: "caplet",
    contentHash: "hash",
    targetKind: "local",
    actor: "cli-yes",
    status: "succeeded",
    phase: "commands",
    commandLabel: String(index),
    argv: ["true"],
    exitCode: 0,
    durationMs: 1,
    startedAt: new Date(Date.now() + index).toISOString(),
    finishedAt: new Date(Date.now() + index).toISOString(),
    stdout: "",
    stderr: "",
    redacted: false,
    retention: { maxAttempts: 3, days: 7 },
  };
}
