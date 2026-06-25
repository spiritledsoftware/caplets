import { describe, expect, it, vi } from "vitest";
import {
  ManagedMutagenProjectSync,
  buildMutagenSyncPolicy,
  managedSyncQuarantineRecord,
  mutagenProjectSyncDoctorData,
  planMutagenSyncCreateCommand,
  planMutagenSyncListCommand,
  planMutagenSyncTerminateCommand,
  planMutagenVersionCommand,
  type ManagedSyncStateSnapshot,
  type MutagenProcessRunner,
} from "../src/project-binding/mutagen";

const bindingId = "bind_123";
const localProjectRoot = "/Users/alice/project";
const serverProjectRoot = "/state/caplets/workspaces/fp/project";

describe("project binding Mutagen command planning", () => {
  it("plans the version command", () => {
    expect(planMutagenVersionCommand()).toEqual({ command: "mutagen", args: ["version"] });
  });

  it("plans sync creation with the project roots and binding-scoped name", () => {
    expect(
      planMutagenSyncCreateCommand({ bindingId, localProjectRoot, serverProjectRoot }),
    ).toEqual({
      command: "mutagen",
      args: ["sync", "create", localProjectRoot, serverProjectRoot, "--name", "caplets-bind_123"],
    });
  });

  it("plans sync creation with enforceable ignore policy", () => {
    const policy = buildMutagenSyncPolicy({
      manifest: {
        projectRoot: localProjectRoot,
        files: [{ relativePath: "src/index.ts", sizeBytes: 10 }],
        totalBytes: 10,
        exclusionSummary: [
          { source: "hard_denylist", pattern: ".env", count: 1 },
          { source: "gitignore", pattern: "dist", count: 1 },
          { source: "capletsignore", pattern: "tmp-local", count: 1 },
        ],
      },
      size: {
        ok: true,
        totalBytes: 10,
        maxSingleFileBytes: 100,
        maxProjectBytes: 100,
      },
    });

    expect(
      planMutagenSyncCreateCommand({
        bindingId,
        localProjectRoot,
        serverProjectRoot,
        syncPolicy: policy,
      }),
    ).toEqual({
      command: "mutagen",
      args: [
        "sync",
        "create",
        localProjectRoot,
        serverProjectRoot,
        "--name",
        "caplets-bind_123",
        "--ignore-vcs",
        "--ignore",
        ".env",
        "--ignore",
        "dist",
        "--ignore",
        "tmp-local",
      ],
    });
  });

  it("plans sync list as JSON for status inspection", () => {
    expect(planMutagenSyncListCommand()).toEqual({
      command: "mutagen",
      args: ["sync", "list", "--template", "json"],
    });
  });

  it("plans sync termination by binding-scoped name", () => {
    expect(planMutagenSyncTerminateCommand(bindingId)).toEqual({
      command: "mutagen",
      args: ["sync", "terminate", "caplets-bind_123"],
    });
  });
});

describe("managed project sync state transitions", () => {
  it("starts project sync through an injectable process runner", async () => {
    const runner = recordRunner([
      { stdout: "Mutagen version 0.18.1\nLicense profile: mit\n" },
      { stdout: "" },
    ]);
    const sync = new ManagedMutagenProjectSync({ runner });

    await sync.start({ bindingId, localProjectRoot, serverProjectRoot });

    expect(runner.calls).toEqual([
      { command: "mutagen", args: ["version"] },
      {
        command: "mutagen",
        args: ["sync", "create", localProjectRoot, serverProjectRoot, "--name", "caplets-bind_123"],
      },
    ]);
    expect(sync.snapshot()).toEqual({
      state: "syncing",
      bindingId,
      publicMessage: "Project sync is starting.",
      mutagenBinary: "mutagen",
      mutagenVersion: "0.18.1",
      lastCommand: {
        args: ["sync", "create", localProjectRoot, serverProjectRoot, "--name", "caplets-bind_123"],
        command: "mutagen",
        exitCode: 0,
        stderr: "",
        stdout: "",
      },
    } satisfies ManagedSyncStateSnapshot);
  });

  it("blocks before starting Mutagen when sync policy is not enforceable", async () => {
    const runner = recordRunner([]);
    const sync = new ManagedMutagenProjectSync({ runner });

    await sync.start({
      bindingId,
      localProjectRoot,
      serverProjectRoot,
      syncPolicy: {
        ok: false,
        diagnosticCode: "project_sync_policy_denied",
        publicMessage: "Project sync policy cannot be enforced.",
        recoveryCommand: "Add exclusions to .capletsignore or reduce project size.",
        exclusionSummary: [],
      },
    });

    expect(runner.calls).toEqual([]);
    expect(sync.snapshot()).toMatchObject({
      state: "blocked",
      bindingId,
      diagnosticCode: "project_sync_policy_denied",
      publicMessage: "Project sync policy cannot be enforced.",
    });
  });

  it("marks project sync ready when the named session is watching cleanly", async () => {
    const sync = new ManagedMutagenProjectSync({
      runner: recordRunner([
        {
          stdout: JSON.stringify({
            synchronizations: [{ name: "caplets-bind_123", status: "Watching" }],
          }),
        },
      ]),
    });

    await sync.refresh({ bindingId });

    expect(sync.snapshot()).toMatchObject({
      state: "ready",
      bindingId,
      publicMessage: "Project sync is ready.",
    });
  });

  it("marks project sync syncing while the named session is staging or scanning", async () => {
    const sync = new ManagedMutagenProjectSync({
      runner: recordRunner([
        {
          stdout: JSON.stringify({ sessions: [{ name: "caplets-bind_123", status: "Scanning" }] }),
        },
      ]),
    });

    await sync.refresh({ bindingId });

    expect(sync.snapshot()).toMatchObject({
      state: "syncing",
      publicMessage: "Project sync is catching up.",
    });
  });

  it("terminates project sync and transitions to stopped", async () => {
    const runner = recordRunner([{ stdout: "" }]);
    const sync = new ManagedMutagenProjectSync({ runner });

    await sync.stop({ bindingId });

    expect(runner.calls).toEqual([
      { command: "mutagen", args: ["sync", "terminate", "caplets-bind_123"] },
    ]);
    expect(sync.snapshot()).toMatchObject({
      state: "stopped",
      bindingId,
      publicMessage: "Project sync has stopped.",
    });
  });

  it.each([
    {
      name: "missing binary",
      error: Object.assign(new Error("spawn mutagen ENOENT"), { code: "ENOENT" }),
      diagnosticCode: "project_sync_binary_missing",
    },
    {
      name: "auth failure",
      error: new Error("permission denied: unable to authenticate"),
      diagnosticCode: "project_sync_auth_failed",
    },
    {
      name: "conflict",
      error: new Error("synchronization session already exists with this name"),
      diagnosticCode: "project_sync_conflict",
    },
    {
      name: "process exit",
      error: Object.assign(new Error("mutagen exited with code 2"), { exitCode: 2 }),
      diagnosticCode: "project_sync_process_exit",
    },
  ])("maps $name to a blocked project sync diagnostic", async ({ error, diagnosticCode }) => {
    const sync = new ManagedMutagenProjectSync({
      runner: recordRunner([error]),
    });

    await sync.start({ bindingId, localProjectRoot, serverProjectRoot });

    expect(sync.snapshot()).toMatchObject({
      state: "blocked",
      bindingId,
      diagnosticCode,
      publicMessage: "Project sync is blocked.",
    });
  });

  it("keeps Mutagen details in doctor-level data", async () => {
    const runner = recordRunner([
      { stdout: "Mutagen version 0.18.1\nLicense profile: mit\n" },
      { stdout: "" },
    ]);
    const sync = new ManagedMutagenProjectSync({ runner, mutagenBinary: "/usr/local/bin/mutagen" });

    await sync.start({ bindingId, localProjectRoot, serverProjectRoot });

    expect(mutagenProjectSyncDoctorData(sync.snapshot())).toMatchObject({
      state: "syncing",
      mutagenBinary: "/usr/local/bin/mutagen",
      mutagenVersion: "0.18.1",
      lastCommand: {
        command: "/usr/local/bin/mutagen",
        exitCode: 0,
      },
    });
  });

  it("projects blocked sync state into a redacted quarantine record", async () => {
    const sync = new ManagedMutagenProjectSync({
      runner: recordRunner([new Error("authorization bearer super-secret-token failed")]),
    });

    await sync.start({ bindingId, localProjectRoot, serverProjectRoot });

    expect(
      managedSyncQuarantineRecord({
        capletId: "repo-tools",
        snapshot: sync.snapshot(),
        recordedAt: "2026-06-25T12:00:00.000Z",
      }),
    ).toEqual({
      capletId: "repo-tools",
      reason: "sync_failed",
      message: "Project sync is blocked.",
      code: "project_sync_auth_failed",
      recordedAt: "2026-06-25T12:00:00.000Z",
      sync: {
        state: "blocked",
        diagnosticCode: "project_sync_auth_failed",
        mutagenBinary: "mutagen",
        lastCommand: {
          command: "mutagen",
          args: ["version"],
          stderr: "authorization bearer [REDACTED] failed",
          stdout: "",
        },
      },
    });
  });
});

function recordRunner(
  results: Array<Awaited<ReturnType<MutagenProcessRunner>> | Error>,
): MutagenProcessRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = vi.fn<MutagenProcessRunner>(async (command, args) => {
    calls.push({ command, args });
    const result = results.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result ?? { stdout: "" };
  }) as unknown as MutagenProcessRunner & { calls: Array<{ command: string; args: string[] }> };
  run.calls = calls;
  return run;
}
