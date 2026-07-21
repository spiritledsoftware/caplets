import { describe, expect, it } from "vitest";
import type { CapletsError } from "../src/errors";
import { resolveCapletsRemote, resolveRemoteMode } from "../src/remote/options";

describe("resolveRemoteMode", () => {
  it("uses local mode by default without remote client settings", () => {
    expect(resolveRemoteMode({}, {})).toEqual({ mode: "local" });
  });

  it("uses remote mode in auto when CAPLETS_REMOTE_URL is configured", () => {
    expect(resolveRemoteMode({}, { CAPLETS_REMOTE_URL: "https://example.com" })).toEqual({
      mode: "remote",
    });
  });

  it("treats a former Cloud hostname as an ordinary remote", () => {
    expect(resolveRemoteMode({}, { CAPLETS_REMOTE_URL: "https://cloud.caplets.dev" })).toEqual({
      mode: "remote",
    });
  });

  it("does not treat CAPLETS_SERVER_URL as client remote configuration", () => {
    expect(
      resolveRemoteMode({}, { CAPLETS_SERVER_URL: "https://example.com" } as Record<
        string,
        string
      >),
    ).toEqual({ mode: "local" });
  });

  it("requires CAPLETS_REMOTE_URL in explicit remote mode", () => {
    expect(() => resolveRemoteMode({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects removed and unknown modes", () => {
    for (const mode of ["cloud", "sidecar"]) {
      expect(() => resolveRemoteMode({}, { CAPLETS_MODE: mode })).toThrow(
        /Expected CAPLETS_MODE to be auto, local, or remote/u,
      );
    }
  });
});

describe("resolveCapletsRemote", () => {
  it("derives fixed Current Host protocol URLs without reading legacy credential env vars", () => {
    const resolved = resolveCapletsRemote({}, {
      CAPLETS_REMOTE_URL: "https://EXAMPLE.com:443/",
      CAPLETS_REMOTE_USER: "env-user",
      CAPLETS_REMOTE_PASSWORD: "remote-password",
      CAPLETS_REMOTE_TOKEN: "remote-token",
      CAPLETS_REMOTE_WORKSPACE: "legacy-tenant",
    } as Record<string, string>);

    expect(resolved).toMatchObject({
      baseUrl: new URL("https://example.com"),
      mcpUrl: new URL("https://example.com/mcp"),
      attachUrl: new URL("https://example.com/api/v1/attach"),
      adminUrl: new URL("https://example.com/api/v2/admin"),
      healthUrl: new URL("https://example.com/api/v1/healthz"),
      projectBindingWebSocketUrl: new URL(
        "wss://example.com/api/v1/attach/project-bindings/connect",
      ),
      auth: { type: "none", user: "caplets" },
    });
    expect(resolved).not.toHaveProperty("workspace");
    expect(new Headers(resolved.requestInit.headers).get("authorization")).toBeNull();
  });

  it.each([
    "https://host.example/base",
    "https://user:pass@host.example",
    "https://host.example?tenant=team",
    "http://host.example",
  ])("rejects non-origin generic remotes before resolving endpoints: %s", (value) => {
    expect(() => resolveCapletsRemote({}, { CAPLETS_REMOTE_URL: value })).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("supports an issued bearer token from a trusted caller", () => {
    const resolved = resolveCapletsRemote(
      { token: "input-token" },
      { CAPLETS_REMOTE_URL: "https://example.com" },
    );

    expect(resolved.auth).toEqual({ type: "bearer", token: "input-token" });
    expect(new Headers(resolved.requestInit.headers).get("authorization")).toBe(
      "Bearer input-token",
    );
  });
});
