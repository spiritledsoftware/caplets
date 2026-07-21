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
  it("wires an arbitrary Current Host selection as a generic profile-backed remote", () => {
    const selection: ResolvedRemoteSelection = {
      kind: "remote",
      remote: {
        baseUrl: new URL("https://cloud.caplets.dev/"),
        mcpUrl: new URL("https://cloud.caplets.dev/mcp"),
        attachUrl: new URL("https://cloud.caplets.dev/api/v1/attach"),
        adminUrl: new URL("https://cloud.caplets.dev/api/v2/admin"),
        healthUrl: new URL("https://cloud.caplets.dev/api/v1/healthz"),
        projectBindingWebSocketUrl: new URL(
          "wss://cloud.caplets.dev/api/v1/attach/project-bindings/connect",
        ),
        auth: { type: "bearer", token: "remote-access" },
        requestInit: { headers: { Authorization: "Bearer remote-access" } },
      },
      credentialExpiresAt: "2999-01-01T00:00:00.000Z",
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
        remote: {
          url: "https://cloud.caplets.dev/",
        },
      }),
    );
  });
  it("wires local daemon selections as ordinary remote Current Hosts", () => {
    const selection: ResolvedRemoteSelection = {
      kind: "local_daemon",
      remote: {
        baseUrl: new URL("http://127.0.0.1:5387"),
        mcpUrl: new URL("http://127.0.0.1:5387/mcp"),
        attachUrl: new URL("http://127.0.0.1:5387/api/v1/attach"),
        adminUrl: new URL("http://127.0.0.1:5387/api/v2/admin"),
        healthUrl: new URL("http://127.0.0.1:5387/api/v1/healthz"),
        projectBindingWebSocketUrl: new URL(
          "ws://127.0.0.1:5387/api/v1/attach/project-bindings/connect",
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
        remote: {
          url: "http://127.0.0.1:5387/",
        },
      }),
    );
  });
});
