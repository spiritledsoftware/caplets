import { describe, expect, it, vi } from "vitest";

import {
  MigratingRemoteCliClient,
  type ResolvedRemoteCliConnection,
} from "../src/remote-cli/client";

const baseUrl = new URL("https://host.example/caplets/");
const v1 = {
  version: 1,
  path: "/caplets/v1",
  links: { admin: "/caplets/v1/admin" },
};
const v2 = {
  version: 2,
  path: "/caplets/v2",
  links: { admin: "/caplets/v2/admin" },
};

function adapter(result: unknown) {
  return { request: vi.fn(async () => result) };
}

function connection(
  fetch: typeof globalThis.fetch,
  bearerToken = "paired-operator-token",
): ResolvedRemoteCliConnection {
  return {
    baseUrl,
    attachUrl: new URL("https://host.example/caplets/v1/attach"),
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
    fetch,
  };
}

function discoveryFetch(versions: unknown[], selected: unknown): typeof globalThis.fetch {
  return vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/caplets/") {
      return Response.json({
        name: "caplets",
        transport: "http",
        base: "/caplets/",
        versions,
        auth: { type: "remote" },
      });
    }
    return Response.json(selected);
  });
}

describe("migrating remote CLI client", () => {
  it("routes v2 resources to the generated Admin adapter after positive v2 discovery", async () => {
    const admin = adapter({ installed: [] });
    const legacy = adapter("legacy");
    const attach = adapter("attach");
    const fetch = discoveryFetch([v1, v2], v2);
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(fetch),
      createAdmin: (_resolved, token) => {
        expect(token).toBe("paired-operator-token");
        return admin;
      },
      createLegacy: () => legacy,
      createAttach: () => attach,
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request("install", { capletIds: ["github"] })).resolves.toEqual({
      installed: [],
    });
    expect(admin.request).toHaveBeenCalledWith("install", { capletIds: ["github"] });
    expect(legacy.request).not.toHaveBeenCalled();
  });

  it("uses the frozen v1 adapter only after definitive legacy discovery", async () => {
    const legacy = adapter({ installed: [] });
    const fetch = discoveryFetch([v1], v1);
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(fetch),
      createAdmin: () => adapter("admin"),
      createLegacy: () => legacy,
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await client.request("install", {});
    expect(legacy.request).toHaveBeenCalledWith("install", {});
  });

  it.each(["storage_records_import", "storage_records_update", "storage_records_export"] as const)(
    "rejects legacy %s before a base64 compatibility request",
    async (command) => {
      const legacy = adapter("legacy");
      const fetch = discoveryFetch([v1], v1);
      const client = new MigratingRemoteCliClient({
        resolve: async () => connection(fetch),
        createAdmin: () => adapter("admin"),
        createLegacy: () => legacy,
        createAttach: () => adapter("attach"),
        createPublicAuth: () => adapter("public"),
      });

      await expect(client.request(command, {})).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
      expect(legacy.request).not.toHaveBeenCalled();
    },
  );

  it("routes runtime commands through Attach even on v2 hosts", async () => {
    const attach = adapter({ tools: [] });
    const fetch = discoveryFetch([v1, v2], v2);
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(fetch),
      createAdmin: () => adapter("admin"),
      createLegacy: () => adapter("legacy"),
      createAttach: () => attach,
      createPublicAuth: () => adapter("public"),
    });

    await client.request("tools", { caplet: "github", request: { operation: "tools" } });
    expect(attach.request).toHaveBeenCalledOnce();
  });

  it("routes CLI completion through Attach instead of Admin v2", async () => {
    const admin = adapter("admin");
    const attach = adapter(["github", "github.search"]);
    const fetch = discoveryFetch([v1, v2], v2);
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(fetch),
      createAdmin: () => admin,
      createLegacy: () => adapter("legacy"),
      createAttach: () => attach,
      createPublicAuth: () => adapter("public"),
    });

    await expect(
      client.request("complete_cli", { shell: "bash", words: ["call-tool", "git"] }),
    ).resolves.toEqual(["github", "github.search"]);
    expect(attach.request).toHaveBeenCalledWith("complete_cli", {
      shell: "bash",
      words: ["call-tool", "git"],
    });
    expect(admin.request).not.toHaveBeenCalled();
  });

  it("routes backend OAuth completion through the public callback adapter", async () => {
    const admin = adapter("admin");
    const publicAuth = adapter({ server: "github" });
    const fetch = discoveryFetch([v1, v2], v2);
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(fetch),
      createAdmin: () => admin,
      createLegacy: () => adapter("legacy"),
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
    expect(admin.request).not.toHaveBeenCalled();
  });

  it.each(["init", "add"] as const)(
    "rejects remote %s locally without resolving or requesting",
    async (command) => {
      const resolve = vi.fn(async () => connection(discoveryFetch([v1, v2], v2)));
      const client = new MigratingRemoteCliClient({
        resolve,
        createAdmin: () => adapter("admin"),
        createLegacy: () => adapter("legacy"),
        createAttach: () => adapter("attach"),
        createPublicAuth: () => adapter("public"),
      });

      await expect(client.request(command, {})).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["malformed discovery", async () => Response.json({ name: "caplets", versions: "v1" })],
    ["authentication failure", async () => Response.json({}, { status: 401 })],
    ["server failure", async () => Response.json({}, { status: 503 })],
    [
      "network failure",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("never downgrades to v1 after %s", async (_label, respond) => {
    const legacy = adapter("legacy");
    const client = new MigratingRemoteCliClient({
      resolve: async () => connection(vi.fn<typeof globalThis.fetch>(respond)),
      createAdmin: () => adapter("admin"),
      createLegacy: () => legacy,
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request("install", {})).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(legacy.request).not.toHaveBeenCalled();
  });

  it("rejects v2 Admin locally when the selected Remote Profile credential is missing", async () => {
    const createAdmin = vi.fn(() => adapter("admin"));
    const fetch = discoveryFetch([v1, v2], v2);
    const client = new MigratingRemoteCliClient({
      resolve: async () => ({
        ...connection(fetch),
        requestInit: {},
      }),
      createAdmin,
      createLegacy: () => adapter("legacy"),
      createAttach: () => adapter("attach"),
      createPublicAuth: () => adapter("public"),
    });

    await expect(client.request("vault_list", {})).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(createAdmin).not.toHaveBeenCalled();
  });
});
