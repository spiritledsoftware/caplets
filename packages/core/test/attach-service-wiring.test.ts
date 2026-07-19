import { describe, expect, it, vi } from "vitest";
import type { AttachServeOptions } from "../src/attach/options";
import type { ResolvedRemoteSelection } from "../src/remote/selection";
import { createAttachNativeServiceForTests } from "../src/attach/server";

const { createNativeCapletsService } = vi.hoisted(() => ({
  createNativeCapletsService: vi.fn((options: unknown) => ({ options })),
}));

vi.mock("../src/native/service", () => ({
  createNativeCapletsService,
}));

describe("attach native service wiring", () => {
  it("forwards the resolved Cloud workspace into profile-backed native remotes", () => {
    const selection: ResolvedRemoteSelection = {
      kind: "hosted_cloud",
      remote: {
        baseUrl: new URL("https://cloud.caplets.dev/"),
        mcpUrl: new URL("https://cloud.caplets.dev/v1/ws/team/mcp"),
        attachUrl: new URL("https://cloud.caplets.dev/v1/ws/team/attach"),
        controlUrl: new URL("https://cloud.caplets.dev/v1/admin"),
        healthUrl: new URL("https://cloud.caplets.dev/v1/healthz"),
        projectBindingWebSocketUrl: new URL(
          "wss://cloud.caplets.dev/v1/ws/team/attach/project-bindings/connect",
        ),
        auth: { type: "bearer", token: "cloud-access" },
        requestInit: { headers: { Authorization: "Bearer cloud-access" } },
        workspace: "team",
      },
      selectedWorkspace: "team",
      credentials: {
        cloudUrl: "https://cloud.caplets.dev",
        workspaceId: "workspace_team",
        workspaceSlug: "team",
        accessToken: "cloud-access",
        refreshToken: "cloud-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
        createdAt: "2026-06-19T00:00:00.000Z",
      },
      credentialExpiresAt: "2999-01-01T00:00:00.000Z",
      cloudPresence: {
        url: new URL("https://cloud.caplets.dev/"),
        accessToken: "cloud-access",
        workspaceId: "workspace_team",
      },
    };

    createAttachNativeServiceForTests(
      {
        transport: "stdio",
        configPath: "/repo/caplets.json",
        projectRoot: "/repo",
        projectConfigPath: "/repo/.caplets/config.json",
        selection,
      } as AttachServeOptions,
      {},
    );

    expect(createNativeCapletsService).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "cloud",
        remote: expect.objectContaining({
          url: "https://cloud.caplets.dev/",
          workspace: "team",
        }),
      }),
    );
  });
  it("wires local daemon selections without Cloud workspace or Remote Profile fields", () => {
    const selection: ResolvedRemoteSelection = {
      kind: "local_daemon",
      remote: {
        baseUrl: new URL("http://127.0.0.1:5387/caplets"),
        mcpUrl: new URL("http://127.0.0.1:5387/caplets/v1/mcp"),
        attachUrl: new URL("http://127.0.0.1:5387/caplets/v1/attach"),
        controlUrl: new URL("http://127.0.0.1:5387/caplets/v1/admin"),
        healthUrl: new URL("http://127.0.0.1:5387/caplets/v1/healthz"),
        projectBindingWebSocketUrl: new URL(
          "ws://127.0.0.1:5387/caplets/v1/attach/project-bindings/connect",
        ),
        auth: { type: "none", user: "caplets" },
        requestInit: {},
      },
    };

    createAttachNativeServiceForTests(
      {
        transport: "stdio",
        configPath: "/repo/caplets.json",
        projectRoot: "/repo",
        projectConfigPath: "/repo/.caplets/config.json",
        selection,
      } as AttachServeOptions,
      {},
    );

    expect(createNativeCapletsService).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "remote",
        remote: expect.objectContaining({
          url: "http://127.0.0.1:5387/caplets",
        }),
      }),
    );
    expect(createNativeCapletsService).toHaveBeenCalledWith(
      expect.not.objectContaining({
        remote: expect.objectContaining({ workspace: expect.anything() }),
      }),
    );
  });
});
