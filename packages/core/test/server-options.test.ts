import { describe, expect, it } from "vitest";

import type { CapletsError } from "../src/errors";
import { resolveCapletsMode, resolveCapletsServer } from "../src/server/options";

describe("resolveCapletsMode", () => {
  it("defaults to local mode without a server URL", () => {
    expect(resolveCapletsMode({}, {})).toEqual({ mode: "local" });
  });

  it("uses remote mode in auto when a server URL is configured", () => {
    expect(resolveCapletsMode({}, { CAPLETS_SERVER_URL: "https://example.com" })).toEqual({
      mode: "remote",
    });
  });

  it("uses local mode from CAPLETS_MODE=local even with a server URL", () => {
    expect(
      resolveCapletsMode({}, { CAPLETS_MODE: "local", CAPLETS_SERVER_URL: "https://example.com" }),
    ).toEqual({ mode: "local" });
  });

  it("uses remote mode from CAPLETS_MODE=remote with a server URL", () => {
    expect(
      resolveCapletsMode({}, { CAPLETS_MODE: "remote", CAPLETS_SERVER_URL: "https://example.com" }),
    ).toEqual({ mode: "remote" });
  });

  it("lets explicit local mode ignore server settings", () => {
    expect(
      resolveCapletsMode(
        { mode: "local", serverUrl: "https://input.example.com" },
        { CAPLETS_SERVER_URL: "https://env.example.com" },
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
  it("normalizes an origin and derives fixed protocol URLs without legacy server auth", () => {
    const resolved = resolveCapletsServer(
      { url: "https://EXAMPLE.com:443/" } as never,
      {
        CAPLETS_SERVER_USER: "env-user",
        CAPLETS_SERVER_PASSWORD: ["server", "password"].join("-"),
      } as Record<string, string>,
    );

    expect(resolved).toMatchObject({
      baseUrl: new URL("https://example.com"),
      mcpUrl: new URL("https://example.com/mcp"),
      attachUrl: new URL("https://example.com/api/v1/attach"),
      adminUrl: new URL("https://example.com/api/v2/admin"),
      healthUrl: new URL("https://example.com/api/v1/healthz"),
      auth: { type: "none" },
      requestInit: {},
    });
  });

  it("derives service URLs from a root URL", () => {
    expect(resolveCapletsServer({ url: "https://example.com" }, {})).toMatchObject({
      baseUrl: new URL("https://example.com/"),
      mcpUrl: new URL("https://example.com/mcp"),
      attachUrl: new URL("https://example.com/api/v1/attach"),
      adminUrl: new URL("https://example.com/api/v2/admin"),
      healthUrl: new URL("https://example.com/api/v1/healthz"),
    });
  });

  it("accepts loopback http IPv6 bracket URLs", () => {
    expect(resolveCapletsServer({ url: "http://[::1]:5387" }, {})).toMatchObject({
      baseUrl: new URL("http://[::1]:5387/"),
      mcpUrl: new URL("http://[::1]:5387/mcp"),
      attachUrl: new URL("http://[::1]:5387/api/v1/attach"),
      adminUrl: new URL("http://[::1]:5387/api/v2/admin"),
      healthUrl: new URL("http://[::1]:5387/api/v1/healthz"),
    });
  });

  it("rejects non-loopback HTTP and every non-origin URL component", () => {
    for (const url of [
      "http://example.com",
      "https://caplets@example.com",
      "https://caplets:secret@example.com",
      "https://example.com/caplets",
      "https://example.com?token=secret",
      "https://example.com#token",
    ]) {
      expect(() => resolveCapletsServer({ url }, {})).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
      );
    }
  });

  it("ignores removed server Basic Auth fields", () => {
    expect(
      resolveCapletsServer(
        {
          url: "https://input.example.com",
          user: "input-user",
          password: "input-password",
        } as never,
        {
          CAPLETS_SERVER_URL: "https://example.com",
          CAPLETS_SERVER_USER: "env-user",
          CAPLETS_SERVER_PASSWORD: "env-password",
        } as Record<string, string>,
      ),
    ).toMatchObject({
      baseUrl: new URL("https://input.example.com"),
      auth: { type: "none" },
      requestInit: {},
    });
  });
});
