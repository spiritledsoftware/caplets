import { describe, expect, it, vi } from "vitest";
import { CapletsCloudClient } from "../src/cloud/client";

describe("CapletsCloudClient", () => {
  it("registers local presence with bearer auth", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ presenceId: "presence_1", expiresAt: "2026-05-30T00:05:00.000Z" }),
    );
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(
      client.registerPresence({
        workspaceId: "ws_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:abc",
        allowedCapletIds: ["repo-cli"],
      }),
    ).resolves.toEqual({ presenceId: "presence_1", expiresAt: "2026-05-30T00:05:00.000Z" });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/presence"),
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer token");
  });

  it("stops local presence and ignores missing records", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev/ws/ian"),
      accessToken: "token",
      fetch,
    });

    await expect(client.stopPresence("presence_1")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/ws/ian/api/presence/presence_1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("heartbeats local presence", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ presenceId: "presence_1", expiresAt: "2026-05-30T00:10:00.000Z" }),
    );
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(client.heartbeatPresence("presence_1")).resolves.toEqual({
      presenceId: "presence_1",
      expiresAt: "2026-05-30T00:10:00.000Z",
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/presence/presence_1/heartbeat"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updates visible local Caplets for an active presence", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(client.updatePresenceCaplets("presence_1", ["repo-cli"])).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/presence/presence_1/caplets"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ allowedCapletIds: ["repo-cli"] }),
      }),
    );
  });
});
