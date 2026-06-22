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
      allowedCapletIds: ["repo-cli"],
      fallbackConsent: "deny",
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

  it("sends Vault set requests to the selected workspace contract without redacting the request body", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ key: "GH_TOKEN", present: true, valueBytes: 12 }),
    );
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(
      client.setVaultValue({
        workspace: "team",
        name: "GH_TOKEN",
        value: "cloud_secret",
        force: true,
        grant: "github",
        referenceName: "GH_TOKEN",
      }),
    ).resolves.toEqual({ key: "GH_TOKEN", present: true, valueBytes: 12 });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/workspaces/team/vault/values/GH_TOKEN"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.any(Headers),
        body: JSON.stringify({
          value: "cloud_secret",
          force: true,
          grant: "github",
          referenceName: "GH_TOKEN",
        }),
      }),
    );
  });

  it("sends explicit human context for Cloud Vault reveal requests", async () => {
    const fetch = vi.fn(async () => Response.json({ key: "GH_TOKEN", value: "cloud_secret" }));
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev"),
      accessToken: "token",
      fetch,
    });

    await expect(
      client.getVaultValue({ workspace: "team", name: "GH_TOKEN", reveal: true }),
    ).resolves.toEqual({ key: "GH_TOKEN", value: "cloud_secret" });

    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "GET" }));
    const revealCalls = fetch.mock.calls as unknown as Array<[URL, RequestInit?]>;
    const revealUrl = new URL(String(revealCalls[0]?.[0]));
    expect(revealUrl.pathname).toBe("/api/workspaces/team/vault/values/GH_TOKEN");
    expect(revealUrl.searchParams.get("reveal")).toBe("true");
    expect(revealUrl.searchParams.get("revealContext")).toBe("human-cli");
  });

  it("sends Vault access management requests to the selected workspace contract", async () => {
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0]) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/vault/access")) {
        return Response.json([{ storedKey: "GH_TOKEN", capletId: "github" }]);
      }
      return Response.json({
        storedKey: "GH_TOKEN",
        referenceName: "GH_TOKEN",
        capletId: "github",
      });
    });
    const client = new CapletsCloudClient({
      baseUrl: new URL("https://cloud.caplets.dev/ws/ian"),
      accessToken: "token",
      fetch,
    });

    await client.grantVaultAccess({
      workspace: "team",
      name: "GH_TOKEN",
      capletId: "github",
      referenceName: "GH_TOKEN",
    });
    await client.listVaultAccess({ workspace: "team", name: "GH_TOKEN", capletId: "github" });
    await client.revokeVaultAccess({
      workspace: "team",
      name: "GH_TOKEN",
      capletId: "github",
      referenceName: "GH_TOKEN",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://cloud.caplets.dev/ws/ian/api/workspaces/team/vault/access/GH_TOKEN/github"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ referenceName: "GH_TOKEN" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({ method: "GET" }),
    );
    const accessCalls = fetch.mock.calls as unknown as Array<[URL, RequestInit?]>;
    const listUrl = new URL(String(accessCalls[1]?.[0]));
    expect(listUrl.pathname).toBe("/ws/ian/api/workspaces/team/vault/access");
    expect(listUrl.searchParams.get("name")).toBe("GH_TOKEN");
    expect(listUrl.searchParams.get("capletId")).toBe("github");
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.any(URL),
      expect.objectContaining({ method: "DELETE" }),
    );
    const revokeUrl = new URL(String(accessCalls[2]?.[0]));
    expect(revokeUrl.pathname).toBe("/ws/ian/api/workspaces/team/vault/access/GH_TOKEN/github");
    expect(revokeUrl.searchParams.get("referenceName")).toBe("GH_TOKEN");
  });
});
