import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { attachProjectOnce } from "../src/project-binding/attach";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("hosted Cloud Auth refresh before attach", () => {
  it("refreshes expired hosted credentials, persists rotation, and attaches with the new access token", async () => {
    const path = tempCloudAuthPath();
    const store = new CloudAuthStore({ path });
    await store.save(
      hostedCredentials({
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
      }),
    );
    const authorizationHeaders: string[] = [];

    await expect(
      attachProjectOnce(
        {
          projectRoot: "/repo",
          fetch: async (url, init) => {
            if (String(url).endsWith("/api/cloud-client/refresh")) {
              expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old_refresh" });
              return Response.json({
                status: "authenticated",
                cloudUrl: "https://cloud.caplets.dev",
                workspaceId: "workspace_personal",
                workspaceSlug: "personal",
                accessToken: "new_access",
                refreshToken: "new_refresh",
                expiresAt: "2999-01-01T00:00:00.000Z",
                scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
                tokenType: "Bearer",
                credentialFamilyId: "family_123",
              });
            }
            authorizationHeaders.push(headerValue(init?.headers, "authorization"));
            return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
          },
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(store.load()).resolves.toMatchObject({
      accessToken: "old_access",
      refreshToken: "old_refresh",
      expiresAt: "2026-06-03T00:00:00.000Z",
    });
    const profileStore = new FileRemoteProfileStore({
      root: join(dirname(path), "remote-profiles"),
    });
    const status = await profileStore.getCloudProfileStatus({
      hostUrl: "https://cloud.caplets.dev",
    });
    expect(status).toMatchObject({
      hostUrl: "https://cloud.caplets.dev/",
      workspaceSlug: "personal",
    });
    await expect(profileStore.credentials.load(status?.key ?? "")).resolves.toMatchObject({
      accessToken: "new_access",
      refreshToken: "new_refresh",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(authorizationHeaders).toEqual(["Bearer new_access"]);
  });

  it("fails closed when the saved refresh token is revoked", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        expiresAt: "2026-06-03T00:00:00.000Z",
        refreshToken: "revoked_refresh",
      }),
    );

    await expect(
      attachProjectOnce(
        {
          projectRoot: "/repo",
          fetch: async () =>
            Response.json(
              { error: "invalid_refresh_token", message: "Refresh token was revoked." },
              { status: 401 },
            ),
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("does not implicitly use saved Cloud Auth without cloud mode or a Cloud remote URL", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(hostedCredentials());

    await expect(
      attachProjectOnce({ projectRoot: "/repo" }, { CAPLETS_CLOUD_AUTH_PATH: path }),
    ).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
  });
});

function headerValue(headers: RequestInit["headers"] | undefined, name: string): string {
  return new Headers(headers).get(name) ?? "";
}
