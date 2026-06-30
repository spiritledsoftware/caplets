import { describe, expect, it } from "vitest";
import { resolveDaemonHttpServeOptions } from "../src/daemon";
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
      auth: { type: "remote_credentials" },
      remoteCredentialStateDir: expect.stringContaining("remote-server"),
      trustProxy: false,
    });
  });

  it("uses CAPLETS_SERVER_URL as HTTP serve defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        {
          CAPLETS_SERVER_URL: "http://localhost:7890/caplets/",
        },
      ),
    ).toMatchObject({
      transport: "http",
      host: "localhost",
      port: 7890,
      path: "/caplets",
      auth: { type: "remote_credentials" },
      publicOrigin: "http://localhost:7890",
    });
  });

  it("uses global serve config defaults for HTTP serving", () => {
    const resolved = resolveServeOptions(
      { transport: "http" },
      {},
      {
        host: "0.0.0.0",
        port: 5480,
        path: "/caplets",
        remoteStatePath: "/configured/remote-auth",
        upstreamUrl: "https://upstream.example.com/caplets",
        allowUnauthenticatedHttp: true,
        trustProxy: true,
        publicOrigins: ["https://caplets.example.com"],
      },
    );
    expect(resolved).toMatchObject({
      transport: "http",
      host: "0.0.0.0",
      port: 5480,
      path: "/caplets",
      auth: { type: "development_unauthenticated" },
      allowUnauthenticatedHttp: true,
      upstreamUrl: "https://upstream.example.com/caplets",
      trustProxy: true,
      publicOrigin: "https://caplets.example.com",
    });
    expect("remoteCredentialStateDir" in resolved).toBe(false);
  });

  it("keeps the first public origin canonical while preserving additional origins", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        {},
        {
          publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        },
      ),
    ).toMatchObject({
      transport: "http",
      publicOrigin: "https://primary.example.com",
      publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
    });
  });

  it("keeps global HTTP serve defaults from affecting stdio", () => {
    expect(resolveServeOptions({ transport: "stdio" }, {}, { port: 5480 })).toEqual({
      transport: "stdio",
    });
  });

  it("applies CLI and environment values before global serve config defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http", port: 6000 },
        { CAPLETS_SERVER_URL: "http://localhost:7000/env" },
        { host: "0.0.0.0", port: 5480, path: "/configured" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "localhost",
      port: 6000,
      path: "/env",
      publicOrigin: "http://localhost:7000",
    });
  });

  it("keeps configured secondary public origins when CAPLETS_SERVER_URL is set", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "https://primary.example.com/caplets" },
        {
          publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        },
      ),
    ).toMatchObject({
      publicOrigin: "https://primary.example.com",
      publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
    });
  });

  it("lets explicit false command booleans override true global serve defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http", allowUnauthenticatedHttp: false, trustProxy: false },
        {},
        { allowUnauthenticatedHttp: true, trustProxy: true },
      ),
    ).toMatchObject({
      transport: "http",
      auth: { type: "remote_credentials" },
      allowUnauthenticatedHttp: false,
      trustProxy: false,
    });
  });

  it("preserves legacy credential-free daemon auth before applying global defaults", () => {
    expect(
      resolveDaemonHttpServeOptions(
        { preserveUnauthenticatedAuth: true },
        {},
        { allowUnauthenticatedHttp: false },
      ),
    ).toMatchObject({
      auth: { type: "development_unauthenticated" },
      allowUnauthenticatedHttp: true,
    });
  });

  it("preserves HTTPS CAPLETS_SERVER_URL as the public origin", () => {
    expect(
      resolveServeOptions(
        { transport: "http", allowUnauthenticatedHttp: true },
        { CAPLETS_SERVER_URL: "https://caplets.example.com/caplets" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "caplets.example.com",
      port: 5387,
      path: "/caplets",
      publicOrigin: "https://caplets.example.com",
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
      auth: { type: "remote_credentials" },
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

  it("ignores removed Basic Auth env vars and keeps remote credential auth", () => {
    expect(
      resolveServeOptions({ transport: "http" }, {
        CAPLETS_SERVER_USER: "env-user",
        CAPLETS_SERVER_PASSWORD: "env-password",
      } as Record<string, string>),
    ).toMatchObject({
      transport: "http",
      auth: { type: "remote_credentials" },
    });
  });

  it("allows non-loopback HTTP serving when protected by remote credentials", () => {
    expect(resolveServeOptions({ transport: "http", host: "0.0.0.0" }, {})).toMatchObject({
      transport: "http",
      host: "0.0.0.0",
      auth: { type: "remote_credentials" },
      warnUnauthenticatedNetwork: false,
    });
  });

  it("enables proxy trust only with explicit HTTP opt-in", () => {
    expect(resolveServeOptions({ transport: "http", trustProxy: true }, {})).toMatchObject({
      transport: "http",
      trustProxy: true,
    });
  });

  it("resolves the server-owned remote credential state directory", () => {
    expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
      remoteCredentialStateDir: expect.stringContaining("remote-server"),
    });
    expect(
      resolveServeOptions(
        { transport: "http", remoteStatePath: "/var/lib/caplets/remote-auth" },
        { CAPLETS_REMOTE_SERVER_STATE_DIR: "/env/remote-auth" },
      ),
    ).toMatchObject({
      remoteCredentialStateDir: "/var/lib/caplets/remote-auth",
    });
    expect(
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_REMOTE_SERVER_STATE_DIR: "/env/remote-auth" },
      ),
    ).toMatchObject({
      remoteCredentialStateDir: "/env/remote-auth",
    });
  });

  it("allows unauthenticated non-loopback HTTP serving with explicit opt-in", () => {
    const resolved = resolveServeOptions(
      { transport: "http", host: "0.0.0.0", allowUnauthenticatedHttp: true },
      {},
    );
    expect(resolved).toMatchObject({
      transport: "http",
      host: "0.0.0.0",
      auth: { type: "development_unauthenticated" },
      warnUnauthenticatedNetwork: true,
    });
    expect("remoteCredentialStateDir" in resolved).toBe(false);
  });

  it("rejects HTTP-only options for stdio", () => {
    expect(() => resolveServeOptions({ transport: "stdio", host: "127.0.0.1" }, {})).toThrow(
      /only valid with --transport http/u,
    );
  });

  it("resolves upstream URL for HTTP serving", () => {
    expect(
      resolveServeOptions(
        { transport: "http", upstreamUrl: "https://caplets.example.com/caplets" },
        {},
      ),
    ).toMatchObject({
      transport: "http",
      upstreamUrl: "https://caplets.example.com/caplets",
    });
  });

  it("rejects upstream URL for stdio serving", () => {
    expect(() =>
      resolveServeOptions(
        { transport: "stdio", upstreamUrl: "https://caplets.example.com/caplets" },
        {},
      ),
    ).toThrow(/--upstream-url is only valid with --transport http/u);
  });

  it("rejects self-referential upstream URLs", () => {
    expect(() =>
      resolveServeOptions({ transport: "http", upstreamUrl: "http://127.0.0.1:5387/" }, {}),
    ).toThrow(/must not point back to this runtime/u);

    expect(() =>
      resolveServeOptions({ transport: "http", upstreamUrl: "http://localhost:5387/" }, {}),
    ).toThrow(/must not point back to this runtime/u);

    expect(() =>
      resolveServeOptions(
        { transport: "http", host: "::1", upstreamUrl: "http://127.0.0.1:5387/" },
        {},
      ),
    ).toThrow(/must not point back to this runtime/u);

    expect(() =>
      resolveServeOptions(
        { transport: "http", host: "0.0.0.0", upstreamUrl: "http://127.0.0.1:5387/" },
        {},
      ),
    ).toThrow(/must not point back to this runtime/u);

    expect(() =>
      resolveServeOptions({ transport: "http", host: "::", upstreamUrl: "http://[::1]:5387/" }, {}),
    ).toThrow(/must not point back to this runtime/u);

    expect(() =>
      resolveServeOptions(
        { transport: "http", upstreamUrl: "https://caplets.example.com/caplets" },
        { CAPLETS_SERVER_URL: "https://caplets.example.com/caplets/" },
      ),
    ).toThrow(/must not point back to this runtime/u);
  });

  it("defaults daemonized serve to HTTP", () => {
    expect(resolveDaemonHttpServeOptions({}, {})).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/",
    });
  });

  it("rejects daemonized stdio serve", () => {
    expect(() => resolveDaemonHttpServeOptions({ transport: "stdio" } as never, {})).toThrow(
      "caplets daemon install does not accept --transport.",
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
