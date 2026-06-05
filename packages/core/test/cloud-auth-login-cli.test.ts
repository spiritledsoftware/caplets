import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli";
import { assertNoSecrets, tempCloudAuthPath } from "./fixtures/cloud-auth";

describe("caplets cloud auth login", () => {
  it("polls completion, writes one workspace-scoped profile, and redacts JSON", async () => {
    const path = tempCloudAuthPath();
    const responses = [
      Response.json({
        loginId: "login_123",
        loginUrl: "https://cloud.caplets.dev/cli-login/login_123",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-06-03T12:10:00.000Z",
        requestId: "req_start",
      }),
      Response.json({
        status: "completed",
        selectedWorkspace: { workspaceId: "workspace_team", slug: "team" },
        oneTimeCode: "one_time_code_secret",
        requestId: "req_poll",
      }),
      Response.json({
        status: "authenticated",
        cloudUrl: "https://cloud.caplets.dev",
        workspaceId: "workspace_team",
        workspaceSlug: "team",
        accessToken: "cap_access_secret",
        refreshToken: "cap_refresh_secret",
        expiresAt: "2099-06-03T13:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
        credentialFamilyId: "family_123",
        deviceName: "Test Device",
        requestId: "req_token",
      }),
    ];
    const out: string[] = [];

    await runCli(
      [
        "cloud",
        "auth",
        "login",
        "--cloud-url",
        "https://cloud.caplets.dev",
        "--workspace",
        "team",
        "--no-open",
        "--json",
      ],
      {
        env: { CAPLETS_CLOUD_AUTH_PATH: path, CAPLETS_CLOUD_AUTH_POLL_INTERVAL_MS: "0" },
        fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
        writeOut: (value) => out.push(value),
      },
    );

    expect(JSON.parse(out.join(""))).toMatchObject({
      authenticated: true,
      status: "authenticated",
      cloudUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
    });
    assertNoSecrets(out.join(""));
    expect(readFileSync(path, "utf8")).toContain("cap_refresh_secret");
  });

  it("continues polling while browser workspace selection is required", async () => {
    const path = tempCloudAuthPath();
    const requests: string[] = [];
    const responses = [
      Response.json({
        loginId: "login_123",
        loginUrl: "https://cloud.caplets.dev/cli-login/login_123",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-06-03T12:10:00.000Z",
      }),
      Response.json({
        status: "workspace_selection_required",
        workspaces: [
          { workspaceId: "workspace_personal", slug: "personal" },
          { workspaceId: "workspace_team", slug: "team" },
        ],
        expiresAt: "2026-06-03T12:10:00.000Z",
      }),
      Response.json({
        status: "completed",
        selectedWorkspace: { workspaceId: "workspace_team", slug: "team" },
        oneTimeCode: "one_time_code_secret",
      }),
      Response.json({
        status: "authenticated",
        cloudUrl: "https://cloud.caplets.dev",
        workspaceId: "workspace_team",
        workspaceSlug: "team",
        accessToken: "cap_access_secret",
        refreshToken: "cap_refresh_secret",
        expiresAt: "2099-06-03T13:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
        credentialFamilyId: "family_123",
      }),
    ];

    await runCli(
      ["cloud", "auth", "login", "--cloud-url", "https://cloud.caplets.dev", "--no-open", "--json"],
      {
        env: { CAPLETS_CLOUD_AUTH_PATH: path, CAPLETS_CLOUD_AUTH_POLL_INTERVAL_MS: "0" },
        fetch: async (input) => {
          requests.push(String(input));
          return responses.shift() ?? Response.json({}, { status: 500 });
        },
        writeOut: () => undefined,
      },
    );

    expect(
      requests.filter((url) => url.endsWith("/api/cloud-client/login/login_123")),
    ).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toContain("workspace_team");
  });
});
