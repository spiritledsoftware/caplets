import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import { runSetup } from "../src/cli/setup";
import { capletSetupContentHash } from "../src/setup/hash";
import { LocalSetupStore } from "../src/setup/local-store";
import { runCapletSetup, type SetupSpawn } from "../src/setup/runner";
import type { SetupAttempt, SetupTargetKind } from "../src/setup/types";

describe("setup runner", () => {
  it("accepts only local_host, remote_host, and hosted_sandbox setup targets", async () => {
    const accepted: SetupTargetKind[] = ["local_host", "remote_host", "hosted_sandbox"];
    expect([...accepted].sort()).toEqual(["hosted_sandbox", "local_host", "remote_host"]);

    for (const targetKind of accepted) {
      await expect(
        runCapletSetup({
          projectFingerprint: "project",
          capletId: "ast-grep",
          contentHash: "hash",
          targetKind,
          actor: "cli-yes",
          approved: true,
          setup: { commands: [] },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).resolves.toEqual([]);
    }
  });

  it.each(["local", "remote_server", "hosted_container"])(
    "rejects legacy stored setup target %s",
    async (targetKind) => {
      await expect(
        runCapletSetup({
          projectFingerprint: "project",
          capletId: "ast-grep",
          contentHash: "hash",
          targetKind: targetKind as SetupTargetKind,
          actor: "cli-yes",
          approved: true,
          setup: { commands: [] },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: "setup target must be one of: local_host, remote_host, hosted_sandbox",
      });
    },
  );

  it("changes content hash when setup metadata changes", () => {
    const first = caplet("npm", ["install", "-g", "first"]);
    const second = caplet("npm", ["install", "-g", "second"]);
    expect(capletSetupContentHash(first)).not.toBe(capletSetupContentHash(second));
  });

  it("requires approval before commands run", async () => {
    const store = memoryStore();
    await expect(
      runCapletSetup({
        projectFingerprint: "project",
        capletId: "ast-grep",
        contentHash: "hash",
        targetKind: "local_host",
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
      projectFingerprint: "project",
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local_host",
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
    expect(attempts[0]?.projectFingerprint).toBe("project");
    expect(store.attempts).toHaveLength(2);
  });

  it("leaves status failed when verify fails", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local_host",
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
      projectFingerprint: "project",
      capletId: "secret",
      contentHash: "hash",
      targetKind: "local_host",
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

  it("keys approvals by project fingerprint, caplet, content hash, and target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir });
      await store.approve({
        projectFingerprint: "project-a",
        capletId: "ast-grep",
        contentHash: "hash",
        targetKind: "remote_host",
        actor: "cli-yes",
        approvedAt: "2026-06-02T12:00:00.000Z",
      });

      await expect(
        store.getApproval("project-a", "ast-grep", "hash", "remote_host"),
      ).resolves.toMatchObject({ projectFingerprint: "project-a" });
      await expect(
        store.getApproval("project-b", "ast-grep", "hash", "remote_host"),
      ).resolves.toBeUndefined();
      await expect(
        store.getApproval("project-a", "ast-grep", "hash", "local_host"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      const attempts = await store.listAttempts("project", "ast-grep");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((entry) => entry.commandLabel)).toEqual(["2", "3", "4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps attempt retention scoped to a project fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir, maxAttempts: 3, retentionDays: 7 });
      await store.recordAttempt({
        ...attempt(0),
        projectFingerprint: "project-a",
        commandLabel: "a",
      });
      await store.recordAttempt({
        ...attempt(1),
        projectFingerprint: "project-b",
        commandLabel: "b",
      });

      await expect(store.listAttempts("project-a", "ast-grep")).resolves.toMatchObject([
        { projectFingerprint: "project-a", commandLabel: "a" },
      ]);
      await expect(store.listAttempts("project-b", "ast-grep")).resolves.toMatchObject([
        { projectFingerprint: "project-b", commandLabel: "b" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses neutral setup target names in CLI setup copy", async () => {
    const local = await runSetup("opencode", {
      target: "local_host",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(local)).toMatchObject({ targetKind: "local_host" });

    const remoteServer = await runSetup("opencode", {
      remote: true,
      target: "remote_host",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(remoteServer)).toMatchObject({ targetKind: "remote_host" });

    const hostedContainer = await runSetup("opencode", {
      target: "hosted_sandbox",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(hostedContainer)).toMatchObject({ targetKind: "hosted_sandbox" });
  });

  it.each(["remote", "cloud", "hosted_worker"])(
    "serializes legacy CLI setup alias %s to a semantic target",
    async (target) => {
      const result = await runSetup("opencode", {
        target: target as "remote" | "cloud" | "hosted_worker",
        dryRun: true,
        format: "json",
      });
      expect(JSON.parse(result).targetKind).toBe(
        target === "remote" ? "remote_host" : "hosted_sandbox",
      );
    },
  );

  it("records setup hash and runtime features without requiring project output retention", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "browser",
      contentHash: "content",
      setupHash: "setup",
      targetKind: "hosted_sandbox",
      runtimeFeatures: ["browser"],
      actor: "cli-yes",
      approved: true,
      setup: { commands: [{ label: "Install", command: "npx", args: ["playwright", "install"] }] },
      store,
      spawn: successfulSpawn(),
    });

    expect(attempts[0]).toMatchObject({
      setupHash: "setup",
      runtimeFeatures: ["browser"],
      targetKind: "hosted_sandbox",
    });
  });

  it("rejects non-project setup commands that run inside a synced project workspace", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "caplets-project-"));
    try {
      await expect(
        runCapletSetup({
          capletId: "global-tool",
          contentHash: "hash",
          targetKind: "local_host",
          actor: "cli-yes",
          approved: true,
          projectWorkspacePath: projectRoot,
          projectBindingRequired: false,
          setup: {
            commands: [{ label: "Install", command: "npm", cwd: join(projectRoot, "tools") }],
          },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: expect.stringContaining("Non-project setup cannot run inside project workspace"),
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
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
    projectFingerprint: "project",
    capletId: "ast-grep",
    contentHash: "hash",
    setupHash: "hash",
    targetKind: "local_host",
    runtimeFeatures: [],
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
