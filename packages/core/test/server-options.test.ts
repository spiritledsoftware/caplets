import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import type { CapletsError } from "../src/errors";
import { resolveCapletsMode, resolveCapletsServer } from "../src/server/options";

describe("resolveCapletsMode", () => {
  it("defaults to local mode without a server URL", () => {
    expect(resolveCapletsMode({}, {})).toEqual({ mode: "local" });
  });

  it("uses remote mode in auto when a server URL is configured", () => {
    expect(resolveCapletsMode({}, { CAPLETS_SERVER_URL: "https://example.com/caplets" })).toEqual({
      mode: "remote",
    });
  });

  it("uses local mode from CAPLETS_MODE=local even with a server URL", () => {
    expect(
      resolveCapletsMode(
        {},
        { CAPLETS_MODE: "local", CAPLETS_SERVER_URL: "https://example.com/caplets" },
      ),
    ).toEqual({ mode: "local" });
  });

  it("uses remote mode from CAPLETS_MODE=remote with a server URL", () => {
    expect(
      resolveCapletsMode(
        {},
        { CAPLETS_MODE: "remote", CAPLETS_SERVER_URL: "https://example.com/caplets" },
      ),
    ).toEqual({ mode: "remote" });
  });

  it("lets explicit local mode ignore server settings", () => {
    expect(
      resolveCapletsMode(
        { mode: "local", serverUrl: "https://input.example.com/caplets" },
        { CAPLETS_SERVER_URL: "https://env.example.com/caplets" },
      ),
    ).toEqual({ mode: "local" });
  });

  it("requires a URL in explicit remote mode", () => {
    expect(() => resolveCapletsMode({ mode: "remote" }, {})).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects invalid mode values with allowed values", () => {
    expect(() => resolveCapletsMode({ mode: "invalid" }, {})).toThrow(/auto, local, or remote/u);
  });
});

describe("resolveCapletsServer", () => {
  it("normalizes a base path URL and derives service URLs with Basic Auth", () => {
    const password = ["server", "password"].join("-");
    const resolved = resolveCapletsServer({ url: "https://example.com/caplets/", password }, {});

    expect(resolved).toMatchObject({
      baseUrl: new URL("https://example.com/caplets"),
      mcpUrl: new URL("https://example.com/caplets/v1/mcp"),
      controlUrl: new URL("https://example.com/caplets/v1/admin"),
      healthUrl: new URL("https://example.com/caplets/v1/healthz"),
      auth: { enabled: true, user: "caplets", password },
      requestInit: {
        headers: {
          Authorization: `Basic ${Buffer.from(`caplets:${password}`).toString("base64")}`,
        },
      },
    });
  });

  it("derives service URLs from a root URL", () => {
    expect(resolveCapletsServer({ url: "https://example.com" }, {})).toMatchObject({
      baseUrl: new URL("https://example.com/"),
      mcpUrl: new URL("https://example.com/v1/mcp"),
      controlUrl: new URL("https://example.com/v1/admin"),
      healthUrl: new URL("https://example.com/v1/healthz"),
    });
  });

  it("accepts loopback http IPv6 bracket URLs", () => {
    expect(resolveCapletsServer({ url: "http://[::1]:5387" }, {})).toMatchObject({
      baseUrl: new URL("http://[::1]:5387/"),
      mcpUrl: new URL("http://[::1]:5387/v1/mcp"),
      controlUrl: new URL("http://[::1]:5387/v1/admin"),
      healthUrl: new URL("http://[::1]:5387/v1/healthz"),
    });
  });

  it("rejects non-loopback http URLs", () => {
    expect(() => resolveCapletsServer({ url: "http://example.com/caplets" }, {})).toThrow(/https/u);
  });

  it("rejects URLs with username, password, query, or fragment", () => {
    for (const url of [
      "https://caplets@example.com/caplets",
      "https://caplets:secret@example.com/caplets",
      "https://example.com/caplets?token=secret",
      "https://example.com/caplets#token",
    ]) {
      expect(() => resolveCapletsServer({ url }, {})).toThrow(
        /must not include username, password, query string, or fragment/u,
      );
    }
  });

  it("requires a password when user is explicit", () => {
    expect(() =>
      resolveCapletsServer({ url: "https://example.com/caplets", user: "alice" }, {}),
    ).toThrow(/requires a password/u);
  });

  it("resolves Basic Auth from CAPLETS_SERVER_USER and CAPLETS_SERVER_PASSWORD", () => {
    const password = ["env", "password"].join("-");

    expect(
      resolveCapletsServer(
        {},
        {
          CAPLETS_SERVER_URL: "https://example.com/caplets",
          CAPLETS_SERVER_USER: "env-user",
          CAPLETS_SERVER_PASSWORD: password,
        },
      ),
    ).toMatchObject({
      auth: { enabled: true, user: "env-user", password },
      requestInit: {
        headers: {
          Authorization: `Basic ${Buffer.from(`env-user:${password}`).toString("base64")}`,
        },
      },
    });
  });
});
