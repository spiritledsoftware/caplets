import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { CapletsError } from "../src/errors";
import { resolveCapletsRemote, resolveRemoteMode } from "../src/remote/options";

describe("resolveRemoteMode", () => {
  it("uses local mode by default without remote client settings", () => {
    expect(resolveRemoteMode({}, {})).toEqual({ mode: "local" });
  });

  it("uses remote mode in auto when CAPLETS_REMOTE_URL is configured", () => {
    expect(resolveRemoteMode({}, { CAPLETS_REMOTE_URL: "https://example.com/caplets" })).toEqual({
      mode: "remote",
    });
  });

  it("does not treat CAPLETS_SERVER_URL as client remote configuration", () => {
    expect(resolveRemoteMode({}, { CAPLETS_SERVER_URL: "https://example.com/caplets" })).toEqual({
      mode: "local",
    });
  });

  it("requires CAPLETS_REMOTE_URL in explicit remote mode", () => {
    expect(() => resolveRemoteMode({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });
});

describe("resolveCapletsRemote", () => {
  it("derives remote service URLs and Basic Auth from CAPLETS_REMOTE variables", () => {
    const password = "remote-password";
    const resolved = resolveCapletsRemote(
      {},
      {
        CAPLETS_REMOTE_URL: "https://example.com/caplets/",
        CAPLETS_REMOTE_USER: "env-user",
        CAPLETS_REMOTE_PASSWORD: password,
      },
    );

    expect(resolved).toMatchObject({
      baseUrl: new URL("https://example.com/caplets"),
      mcpUrl: new URL("https://example.com/caplets/mcp"),
      controlUrl: new URL("https://example.com/caplets/control"),
      healthUrl: new URL("https://example.com/caplets/healthz"),
      projectBindingWebSocketUrl: new URL(
        "wss://example.com/caplets/control/project-bindings/connect",
      ),
      auth: { type: "basic", user: "env-user", password },
    });
    expect(resolved.workspace).toBeUndefined();
    expect(new Headers(resolved.requestInit.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(`env-user:${password}`).toString("base64")}`,
    );
  });

  it("supports bearer token and workspace settings", () => {
    const resolved = resolveCapletsRemote(
      { token: "input-token", workspace: "team" },
      { CAPLETS_REMOTE_URL: "https://example.com" },
    );

    expect(resolved.auth).toEqual({ type: "bearer", token: "input-token" });
    expect(resolved.workspace).toBe("team");
    expect(new Headers(resolved.requestInit.headers).get("authorization")).toBe(
      "Bearer input-token",
    );
  });
});
