import { describe, expect, it } from "vitest";

import { CloudAuthClient } from "../src/cloud-auth/client";

describe("CloudAuthClient", () => {
  it("starts a browser-mediated CLI login transaction", async () => {
    const requests: Request[] = [];
    const client = new CloudAuthClient({
      cloudUrl: "https://cloud.caplets.dev",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(
          {
            loginId: "login_123",
            loginUrl: "https://cloud.caplets.dev/cli-login/login_123",
            userCode: "ABCD-EFGH",
            expiresAt: "2026-06-03T12:10:00.000Z",
            requestId: "req_login_start",
          },
          { status: 201, headers: { "x-request-id": "req_login_start" } },
        );
      },
    });

    const result = await client.startLogin({
      requestedWorkspace: "team",
      deviceName: "MacBook",
    });

    expect(requests[0]?.url).toBe("https://cloud.caplets.dev/api/cloud-client/login/start");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      requestedWorkspace: "team",
      deviceName: "MacBook",
      scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
    });
    expect(result).toMatchObject({
      loginId: "login_123",
      userCode: "ABCD-EFGH",
      requestId: "req_login_start",
    });
  });

  it("exchanges a completed one-time login for redacted workspace-scoped credentials", async () => {
    const client = new CloudAuthClient({
      cloudUrl: "https://cloud.caplets.dev",
      fetch: async () =>
        Response.json({
          status: "authenticated",
          cloudUrl: "https://cloud.caplets.dev",
          workspaceId: "workspace_team",
          workspaceSlug: "team",
          accessToken: "cap_access_secret",
          refreshToken: "cap_refresh_secret",
          expiresAt: "2026-06-03T13:00:00.000Z",
          scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
          tokenType: "Bearer",
          credentialFamilyId: "family_123",
          deviceName: "MacBook",
          requestId: "req_token",
        }),
    });

    const credentials = await client.exchangeToken({
      loginId: "login_123",
      oneTimeCode: "one_time_code_secret",
    });

    expect(credentials.workspaceId).toBe("workspace_team");
    expect(credentials.scope).toEqual([
      "project_binding:read",
      "project_binding:write",
      "mcp:tools",
    ]);
    expect(JSON.stringify(credentials.redacted)).not.toContain("cap_access_secret");
    expect(JSON.stringify(credentials.redacted)).not.toContain("cap_refresh_secret");
  });
});
