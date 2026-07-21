import { describe, expect, it, vi } from "vitest";

import { discoverRemoteCliTransport } from "../src/remote-cli/discovery";

const baseUrl = new URL("https://host.example/caplets/");
const v1 = {
  version: 1,
  path: "/caplets/v1",
  links: {
    admin: "/caplets/v1/admin",
    attachManifest: "/caplets/v1/attach/manifest",
    attachInvoke: "/caplets/v1/attach/invoke",
  },
};
const v2 = {
  version: 2,
  path: "/caplets/v2",
  links: { admin: "/caplets/v2/admin" },
};

function root(versions: unknown[] = [v1, v2]) {
  return {
    name: "caplets",
    transport: "http",
    base: "/caplets/",
    versions,
    auth: { type: "remote" },
  };
}

describe("remote CLI transport discovery", () => {
  it("selects v2 only after root and version discovery explicitly advertise Admin v2", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/caplets/") return Response.json(root());
      if (path === "/caplets/v2") return Response.json(v2);
      throw new Error(`unexpected ${path}`);
    });

    await expect(discoverRemoteCliTransport({ baseUrl, fetch })).resolves.toEqual({
      kind: "v2",
      adminBaseUrl: new URL("https://host.example/caplets/"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("selects frozen v1 only after a definitive valid legacy version response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/caplets/") return Response.json(root([v1]));
      if (path === "/caplets/v1") return Response.json(v1);
      throw new Error(`unexpected ${path}`);
    });

    await expect(discoverRemoteCliTransport({ baseUrl, fetch })).resolves.toEqual({
      kind: "legacy-v1",
    });
  });

  it.each([
    ["malformed root", () => Response.json({ name: "caplets", versions: "v1" })],
    ["authentication failure", () => Response.json({}, { status: 401 })],
    ["server failure", () => Response.json({}, { status: 503 })],
  ])("does not downgrade after %s", async (_label, response) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    await expect(discoverRemoteCliTransport({ baseUrl, fetch })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade after a network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("offline");
    });
    await expect(discoverRemoteCliTransport({ baseUrl, fetch })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
  });

  it("does not downgrade when an advertised v2 response is malformed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/caplets/") return Response.json(root());
      return Response.json({ version: 2, path: "/caplets/v2", links: {} });
    });
    await expect(discoverRemoteCliTransport({ baseUrl, fetch })).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
    });
  });
});
