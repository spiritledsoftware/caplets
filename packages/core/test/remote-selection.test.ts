import { describe, expect, it } from "vitest";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { resolveRemoteSelection } from "../src/remote/selection";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("resolveRemoteSelection", () => {
  it("rejects attach selection in local mode", async () => {
    await expect(resolveRemoteSelection({}, { CAPLETS_MODE: "local" })).rejects.toThrow(
      /caplets attach requires a remote upstream; set CAPLETS_REMOTE_URL or use caplets serve/u,
    );
  });

  it("rejects auto mode without a remote URL for attach", async () => {
    await expect(resolveRemoteSelection({}, {})).rejects.toThrow(/CAPLETS_REMOTE_URL/u);
  });

  it("resolves self-hosted remote auth from CAPLETS_REMOTE variables", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
          CAPLETS_REMOTE_TOKEN: "remote-token",
        },
      ),
    ).resolves.toMatchObject({
      kind: "self_hosted_remote",
      remote: {
        baseUrl: new URL("https://caplets.example.com/caplets"),
        auth: { type: "bearer", token: "remote-token" },
      },
    });
  });

  it("uses saved Cloud Auth in cloud mode and ignores self-hosted token vars", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(hostedCredentials({ accessToken: "cloud-access" }));

    const resolved = await resolveRemoteSelection(
      {},
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_REMOTE_TOKEN: "self-hosted-token",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved).toMatchObject({
      kind: "hosted_cloud",
      selectedWorkspace: "personal",
      remote: {
        baseUrl: new URL("https://cloud.caplets.dev"),
        auth: { type: "bearer", token: "cloud-access" },
      },
    });
  });

  it("refreshes expired Cloud credentials before returning the upstream", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-06-03T00:00:00.000Z",
      }),
    );

    const resolved = await resolveRemoteSelection(
      {
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://cloud.caplets.dev/api/cloud-client/refresh");
          expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh" });
          return Response.json({
            status: "authenticated",
            cloudUrl: "https://cloud.caplets.dev",
            workspaceId: "workspace_personal",
            workspaceSlug: "personal",
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: "2999-01-01T00:00:00.000Z",
            scope: ["project_binding:read", "project_binding:write"],
            tokenType: "Bearer",
            credentialFamilyId: "family_123",
          });
        },
      },
      {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
    );

    expect(resolved.remote.auth).toEqual({ type: "bearer", token: "new-access" });
  });

  it("requires Cloud Auth when cloud mode is selected", async () => {
    await expect(
      resolveRemoteSelection(
        {},
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        },
      ),
    ).rejects.toMatchObject({
      projectBindingCode: "cloud_auth_required",
    });
  });
});
