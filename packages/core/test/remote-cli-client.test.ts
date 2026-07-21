import { describe, expect, it, vi } from "vitest";
import { RemoteCliClient, type ResolvedRemoteCliConnection } from "../src/remote-cli/client";
import { REMOTE_CLI_COMMAND_DESTINATIONS, REMOTE_CLI_COMMANDS } from "../src/remote-cli/types";

function adapter(result: unknown) {
  return { request: vi.fn(async () => result) };
}

function connection(
  bearerToken = "paired-operator-token",
  fetch = vi.fn<typeof globalThis.fetch>(),
): ResolvedRemoteCliConnection {
  return {
    baseUrl: new URL("https://host.example"),
    attachUrl: new URL("https://host.example/api/v1/attach"),
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
    fetch,
  };
}

describe("remote CLI client", () => {
  it("classifies every CLI intent without a legacy Admin destination", () => {
    expect(Object.keys(REMOTE_CLI_COMMAND_DESTINATIONS).sort()).toEqual(
      [...REMOTE_CLI_COMMANDS].sort(),
    );
    expect([...new Set(Object.values(REMOTE_CLI_COMMAND_DESTINATIONS))].sort()).toEqual(
      ["admin", "attach", "local_only_rejection", "public_auth_self_service"].sort(),
    );
  });

  it("routes Admin intents directly to the generated Admin adapter without discovery", async () => {
    const admin = adapter({ installed: [] });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new RemoteCliClient({
      resolve: async () => connection("paired-operator-token", fetch),
      createAdmin: (_resolved, token) => {
        expect(token).toBe("paired-operator-token");
        return admin;
      },
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request("install", { capletIds: ["github"] })).resolves.toEqual({
      installed: [],
    });
    expect(admin.request).toHaveBeenCalledWith("install", { capletIds: ["github"] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["tools", "complete_cli"] as const)("routes %s through Attach", async (command) => {
    const attach = adapter(["github", "github.search"]);
    const client = new RemoteCliClient({
      resolve: async () => connection(),
      createAdmin: () => adapter("admin"),
      createAttach: () => attach,
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request(command, {})).resolves.toEqual(["github", "github.search"]);
    expect(attach.request).toHaveBeenCalledWith(command, {});
  });

  it("routes backend OAuth completion through the public callback adapter", async () => {
    const publicAuth = adapter({ server: "github" });
    const client = new RemoteCliClient({
      resolve: async () => connection(),
      createAdmin: () => adapter("admin"),
      createAttach: () => adapter("attach"),
      createPublicAuth: () => publicAuth,
    });
    const args = {
      flowId: "flow-1",
      callbackUrl: "https://host.example/callback?code=provider-code&state=opaque-state",
    };

    await expect(client.request("auth_login_complete", args)).resolves.toEqual({
      server: "github",
    });
    expect(publicAuth.request).toHaveBeenCalledWith("auth_login_complete", args);
  });

  it.each(["init", "add"] as const)(
    "rejects remote %s locally without resolving or requesting",
    async (command) => {
      const resolve = vi.fn(async () => connection());
      const client = new RemoteCliClient({
        resolve,
        createAdmin: () => adapter("admin"),
        createAttach: () => adapter("attach"),
        createPublicAuth: () => adapter("public"),
      });

      await expect(client.request(command, {})).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects Admin locally when the selected Remote Profile credential is missing", async () => {
    const createAdmin = vi.fn(() => adapter("admin"));
    const client = new RemoteCliClient({
      resolve: async () => ({ ...connection(), requestInit: {} }),
      createAdmin,
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request("vault_list", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(createAdmin).not.toHaveBeenCalled();
  });

  it("resolves one connection and caches each selected adapter", async () => {
    const resolve = vi.fn(async () => connection());
    const createAdmin = vi.fn(() => adapter("admin"));
    const client = new RemoteCliClient({
      resolve,
      createAdmin,
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await client.request("vault_list", {});
    await client.request("vault_get", {});
    expect(resolve).toHaveBeenCalledOnce();
    expect(createAdmin).toHaveBeenCalledOnce();
  });
});
