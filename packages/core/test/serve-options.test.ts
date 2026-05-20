import { describe, expect, it } from "vitest";
import { resolveServeOptions } from "../src/serve/options";

describe("resolveServeOptions", () => {
  it("defaults serve to stdio", () => {
    expect(resolveServeOptions({}, {})).toEqual({ transport: "stdio" });
  });

  it("defaults HTTP serving to localhost port 5387 and root base path", () => {
    expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/",
      auth: { enabled: false, user: "caplets" },
      trustProxy: false,
    });
  });

  it("uses CAPLETS_SERVER_URL as HTTP serve defaults", () => {
    const testPassword = ["test", "env", "password"].join("-");

    expect(
      resolveServeOptions(
        { transport: "http" },
        {
          CAPLETS_SERVER_URL: "http://localhost:7890/caplets/",
          CAPLETS_SERVER_PASSWORD: testPassword,
        },
      ),
    ).toMatchObject({
      transport: "http",
      host: "localhost",
      port: 7890,
      path: "/caplets",
      auth: { enabled: true, user: "caplets", password: testPassword },
    });
  });

  it("uses the default HTTP port when CAPLETS_SERVER_URL has no explicit port", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "http://127.0.0.1/caplets" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/caplets",
    });
  });

  it("uses IPv6 loopback server URLs without requiring HTTP auth opt-in", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "http://[::1]:5387/caplets" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "::1",
      port: 5387,
      path: "/caplets",
      auth: { enabled: false, user: "caplets" },
      loopback: true,
      warnUnauthenticatedNetwork: false,
    });
  });

  it("clarifies non-loopback HTTP server URL bind configuration", () => {
    expect(() =>
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "http://0.0.0.0:5387/caplets" },
      ),
    ).toThrow(/use --host, --port, and --path separately/u);
  });

  it("lets explicit HTTP flags override CAPLETS_SERVER_URL defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http", host: "127.0.0.1", port: "6000", path: "/local" },
        { CAPLETS_SERVER_URL: "http://localhost:7890/caplets" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 6000,
      path: "/local",
    });
  });

  it("normalizes trailing slashes in HTTP path", () => {
    expect(resolveServeOptions({ transport: "http", path: "/custom/" }, {})).toMatchObject({
      transport: "http",
      path: "/custom",
    });
  });

  it("resolves Basic Auth from password with default user", () => {
    const testPassword = ["test", "password"].join("-");

    expect(resolveServeOptions({ transport: "http", password: testPassword }, {})).toMatchObject({
      transport: "http",
      auth: { enabled: true, user: "caplets", password: testPassword },
    });
  });

  it("resolves Basic Auth from env and lets flags win", () => {
    const envPassword = ["test", "env", "password"].join("-");

    expect(
      resolveServeOptions(
        { transport: "http", user: "cli-user" },
        { CAPLETS_SERVER_USER: "env-user", CAPLETS_SERVER_PASSWORD: envPassword },
      ),
    ).toMatchObject({
      transport: "http",
      auth: { enabled: true, user: "cli-user", password: envPassword },
    });
  });

  it("rejects explicit user without password", () => {
    expect(() => resolveServeOptions({ transport: "http", user: "alice" }, {})).toThrow(
      /requires a password/u,
    );
  });

  it("requires explicit opt-in for unauthenticated non-loopback HTTP serving", () => {
    expect(() => resolveServeOptions({ transport: "http", host: "0.0.0.0" }, {})).toThrow(
      /requires --allow-unauthenticated-http/u,
    );
  });

  it("enables proxy trust only with explicit HTTP opt-in", () => {
    expect(resolveServeOptions({ transport: "http", trustProxy: true }, {})).toMatchObject({
      transport: "http",
      trustProxy: true,
    });
  });

  it("allows unauthenticated non-loopback HTTP serving with explicit opt-in", () => {
    expect(
      resolveServeOptions(
        { transport: "http", host: "0.0.0.0", allowUnauthenticatedHttp: true },
        {},
      ),
    ).toMatchObject({
      transport: "http",
      host: "0.0.0.0",
      auth: { enabled: false, user: "caplets" },
      warnUnauthenticatedNetwork: true,
    });
  });

  it("rejects HTTP-only options for stdio", () => {
    expect(() => resolveServeOptions({ transport: "stdio", host: "127.0.0.1" }, {})).toThrow(
      /only valid with --transport http/u,
    );
  });

  it("rejects invalid port and path", () => {
    expect(() => resolveServeOptions({ transport: "http", port: "0" }, {})).toThrow(
      /valid TCP port/u,
    );
    expect(() => resolveServeOptions({ transport: "http", path: "mcp" }, {})).toThrow(
      /must start with/u,
    );
    expect(() => resolveServeOptions({ transport: "http", path: "/mcp?x=1" }, {})).toThrow(
      /query string/u,
    );
  });
});
