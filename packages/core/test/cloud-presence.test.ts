import { describe, expect, it, vi } from "vitest";
import { ProjectBindingSessionManager } from "../src/cloud/presence";
import { NativeProjectBindingLifecycle } from "../src/native/project-binding-lifecycle";

describe("ProjectBindingSessionManager", () => {
  it("registers and stops local presence", async () => {
    const client = {
      registerPresence: vi.fn(async () => ({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      })),
      stopPresence: vi.fn(async () => undefined),
    };
    const manager = new ProjectBindingSessionManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
    });

    await manager.start();
    await manager.close();

    expect(client.registerPresence).toHaveBeenCalledOnce();
    expect(client.stopPresence).toHaveBeenCalledWith("presence_1", expect.anything());
  });

  it("does not stop before registration succeeds", async () => {
    const client = {
      registerPresence: vi.fn(async () => {
        throw new Error("offline");
      }),
      stopPresence: vi.fn(async () => undefined),
    };
    const manager = new ProjectBindingSessionManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
    });

    await expect(manager.start()).rejects.toThrow("offline");
    await manager.close();

    expect(client.stopPresence).not.toHaveBeenCalled();
  });

  it("aborts a timed out Cloud registration and ignores its late result", async () => {
    vi.useFakeTimers();
    try {
      const registrationStarted = Promise.withResolvers<void>();
      const lateRegistration = Promise.withResolvers<{
        presenceId: string;
        expiresAt: string;
      }>();
      let registrationSignal: AbortSignal | undefined;
      const client = {
        registerPresence: vi.fn(async (_input: unknown, options?: { signal?: AbortSignal }) => {
          registrationSignal = options?.signal;
          registrationStarted.resolve();
          return await lateRegistration.promise;
        }),
        stopPresence: vi.fn(async () => undefined),
      };
      const manager = new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
        mutationTimeoutMs: 100,
      });

      const starting = manager.start();
      await registrationStarted.promise;
      vi.advanceTimersToNextTimer();
      await expect(starting).rejects.toThrow("timed out");
      expect(registrationSignal?.aborted).toBe(true);

      lateRegistration.resolve({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      });
      await Promise.resolve();
      await manager.close();

      expect(client.stopPresence).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeats active local presence until closed", async () => {
    vi.useFakeTimers();
    const client = {
      registerPresence: vi.fn(async () => ({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      })),
      heartbeatPresence: vi.fn(async () => undefined),
      stopPresence: vi.fn(async () => undefined),
    };
    const manager = new ProjectBindingSessionManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
      heartbeatIntervalMs: 1_000,
    });

    await manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.heartbeatPresence).toHaveBeenCalledTimes(1);
    expect(client.heartbeatPresence).toHaveBeenCalledWith("presence_1", expect.anything());
    vi.useRealTimers();
  });

  it("updates active local presence with the current local Caplet set", async () => {
    const client = {
      registerPresence: vi.fn(async () => ({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      })),
      updatePresenceCaplets: vi.fn(async () => undefined),
    };
    const manager = new ProjectBindingSessionManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
    });

    await manager.start();
    await manager.updateAllowedCapletIds(["repo-cli", "eslint"]);

    expect(client.updatePresenceCaplets).toHaveBeenCalledWith(
      "presence_1",
      ["repo-cli", "eslint"],
      expect.anything(),
    );
  });
  it("serializes heartbeat, allowed-ID update, and stop so cleanup is last", async () => {
    vi.useFakeTimers();
    try {
      const heartbeatStarted = Promise.withResolvers<void>();
      const releaseHeartbeat = Promise.withResolvers<void>();
      const events: string[] = [];
      const client = {
        registerPresence: vi.fn(async () => ({
          presenceId: "presence_1",
          expiresAt: "2026-05-30T00:05:00.000Z",
        })),
        heartbeatPresence: vi.fn(async () => {
          events.push("heartbeat");
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
        }),
        updatePresenceCaplets: vi.fn(async () => {
          events.push("update");
        }),
        stopPresence: vi.fn(async () => {
          events.push("stop");
        }),
      };
      const manager = new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
        heartbeatIntervalMs: 1_000,
      });

      await manager.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await heartbeatStarted.promise;
      const updating = manager.updateAllowedCapletIds(["eslint"]);
      const closing = manager.close();
      await Promise.resolve();
      await Promise.resolve();

      expect(client.stopPresence).not.toHaveBeenCalled();
      releaseHeartbeat.resolve();
      await Promise.all([updating, closing]);

      expect(events).toEqual(["heartbeat", "update", "stop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled Cloud heartbeat, reports it, and releases serialized close", async () => {
    vi.useFakeTimers();
    try {
      const heartbeatStarted = Promise.withResolvers<void>();
      let heartbeatSignal: AbortSignal | undefined;
      const onError = vi.fn();
      const client = {
        registerPresence: vi.fn(async () => ({
          presenceId: "presence_1",
          expiresAt: "2026-05-30T00:05:00.000Z",
        })),
        heartbeatPresence: vi.fn(
          async (_presenceId: string, options?: { signal?: AbortSignal }) => {
            heartbeatSignal = options?.signal;
            heartbeatStarted.resolve();
            return await new Promise<never>(() => undefined);
          },
        ),
        updatePresenceCaplets: vi.fn(async () => undefined),
        stopPresence: vi.fn(async () => undefined),
      };
      const manager = new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
        heartbeatIntervalMs: 1_000,
        mutationTimeoutMs: 100,
        onError,
      });

      await manager.start();
      vi.advanceTimersToNextTimer();
      await Promise.resolve();
      await heartbeatStarted.promise;
      const closing = manager.close();
      vi.advanceTimersToNextTimer();
      await Promise.resolve();
      await closing;

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/timed out/u) }),
      );
      expect(heartbeatSignal?.aborted).toBe(true);
      expect(client.stopPresence).toHaveBeenCalledWith("presence_1", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces timer heartbeats while preserving explicit update and close ordering", async () => {
    vi.useFakeTimers();
    try {
      const heartbeatStarted = Promise.withResolvers<void>();
      const releaseHeartbeat = Promise.withResolvers<void>();
      const events: string[] = [];
      const client = {
        registerPresence: vi.fn(async () => ({
          presenceId: "presence_1",
          expiresAt: "2026-05-30T00:05:00.000Z",
        })),
        heartbeatPresence: vi.fn(async () => {
          events.push("heartbeat");
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
        }),
        updatePresenceCaplets: vi.fn(async () => {
          events.push("update");
        }),
        stopPresence: vi.fn(async () => {
          events.push("stop");
        }),
      };
      const manager = new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
        heartbeatIntervalMs: 1_000,
      });

      await manager.start();
      vi.advanceTimersByTime(3_000);
      await heartbeatStarted.promise;
      const updating = manager.updateAllowedCapletIds(["eslint"]);
      releaseHeartbeat.resolve();
      await updating;
      await manager.close();

      expect(client.heartbeatPresence).toHaveBeenCalledOnce();
      expect(events).toEqual(["heartbeat", "update", "stop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a heartbeat failure without disconnecting the active Cloud presence", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("offline");
      const onError = vi.fn();
      const client = {
        registerPresence: vi.fn(async () => ({
          presenceId: "presence_1",
          expiresAt: "2026-05-30T00:05:00.000Z",
        })),
        heartbeatPresence: vi.fn(async () => {
          throw failure;
        }),
        updatePresenceCaplets: vi.fn(async () => undefined),
        stopPresence: vi.fn(async () => undefined),
      };
      const manager = new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
        heartbeatIntervalMs: 1_000,
        onError,
      });

      await manager.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
      await manager.updateAllowedCapletIds(["eslint"]);
      await manager.close();

      expect(client.updatePresenceCaplets).toHaveBeenCalledWith(
        "presence_1",
        ["eslint"],
        expect.anything(),
      );
      expect(client.stopPresence).toHaveBeenCalledWith("presence_1", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed Cloud allowed-ID PATCH instead of acknowledging it through an active start", async () => {
    let updateAttempts = 0;
    const client = {
      registerPresence: vi.fn(async () => ({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      })),
      updatePresenceCaplets: vi.fn(async () => {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error("offline");
      }),
    };
    const lifecycle = new NativeProjectBindingLifecycle(
      new ProjectBindingSessionManager({
        client,
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["alpha"],
      }),
      ["alpha"],
    );

    await lifecycle.start();
    await expect(lifecycle.updateAllowedCapletIds(["bravo"])).rejects.toThrow("offline");
    await lifecycle.start();

    expect(client.updatePresenceCaplets).toHaveBeenCalledTimes(2);
    expect(client.updatePresenceCaplets).toHaveBeenLastCalledWith(
      "presence_1",
      ["bravo"],
      expect.anything(),
    );
  });
});
