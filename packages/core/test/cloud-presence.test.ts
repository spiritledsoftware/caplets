import { describe, expect, it, vi } from "vitest";
import { LocalPresenceManager } from "../src/cloud/presence";

describe("LocalPresenceManager", () => {
  it("registers and stops local presence", async () => {
    const client = {
      registerPresence: vi.fn(async () => ({
        presenceId: "presence_1",
        expiresAt: "2026-05-30T00:05:00.000Z",
      })),
      stopPresence: vi.fn(async () => undefined),
    };
    const manager = new LocalPresenceManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
    });

    await manager.start();
    await manager.close();

    expect(client.registerPresence).toHaveBeenCalledOnce();
    expect(client.stopPresence).toHaveBeenCalledWith("presence_1");
  });

  it("does not stop before registration succeeds", async () => {
    const client = {
      registerPresence: vi.fn(async () => {
        throw new Error("offline");
      }),
      stopPresence: vi.fn(async () => undefined),
    };
    const manager = new LocalPresenceManager({
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
    const manager = new LocalPresenceManager({
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
    expect(client.heartbeatPresence).toHaveBeenCalledWith("presence_1");
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
    const manager = new LocalPresenceManager({
      client,
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      allowedCapletIds: ["repo-cli"],
    });

    await manager.start();
    await manager.updateAllowedCapletIds(["repo-cli", "eslint"]);

    expect(client.updatePresenceCaplets).toHaveBeenCalledWith("presence_1", ["repo-cli", "eslint"]);
  });
});
