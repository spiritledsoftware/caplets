import { describe, expect, it, vi } from "vitest";
import { CapletsCloudClient } from "../src/cloud/client";

describe("CapletsCloudClient", () => {
  it("registers Project Binding with bearer auth and synced project files", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ binding: { bindingId: "project_binding_1" } }, { status: 201 }),
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
        projectFiles: [{ path: "src/app.ts", content: "app" }],
      }),
    ).resolves.toMatchObject({ presenceId: "project_binding_1" });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings"),
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(init.body as string)).toMatchObject({
      workspaceId: "ws_1",
      projectRoot: "/repo",
      projectFingerprint: "sha256:abc",
      state: "ready",
      syncState: "idle",
      projectFiles: [{ path: "src/app.ts", content: "app" }],
    });
  });

  it("marks Project Binding offline and ignores missing records", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev/ws/ian"),
      accessToken: "token",
      fetch,
    });

    await expect(client.stopPresence("presence_1")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/ws/ian/api/project-bindings/presence_1"),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "offline" }) }),
    );
  });

  it("heartbeats Project Binding state", async () => {
    const fetch = vi.fn(async () => Response.json({ binding: { bindingId: "presence_1" } }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(client.heartbeatPresence("presence_1")).resolves.toEqual({
      presenceId: "presence_1",
      expiresAt: expect.any(String),
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings/presence_1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "ready", syncState: "idle" }),
      }),
    );
  });

  it("updates visible local Caplet allowlist on the Project Binding", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(client.updatePresenceCaplets("presence_1", ["repo-cli"])).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings/presence_1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ allowedCapletIds: ["repo-cli"] }),
      }),
    );
  });
});
