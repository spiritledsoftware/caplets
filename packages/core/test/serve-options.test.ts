import { describe, expect, it } from "vitest";
import { resolveDaemonHttpServeOptions } from "../src/daemon";
import { resolveServeOptions } from "../src/serve/options";
import { DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES } from "../src/admin-api/bundle-contract";

describe("resolveServeOptions", () => {
  it("defaults serve to stdio", () => {
    expect(resolveServeOptions({}, {})).toEqual({ transport: "stdio" });
  });

  it("defaults HTTP serving to localhost port 5387 at the fixed origin topology", () => {
    expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      auth: { type: "remote_credentials" },
      remoteCredentialStateDir: expect.stringContaining("remote-server"),
      trustProxy: false,
    });
  });

  it("defaults HTTP admin upload deployment limits", () => {
    expect(resolveServeOptions({ transport: "http" }, {})).toMatchObject({
      adminUploads: {
        stagingDir: expect.stringMatching(/caplets-uploads$/u),
        maxConcurrent: 1,
        maxStagedBytes: DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES,
      },
    });
  });

  it("resolves admin upload settings with CLI, environment, config, then built-in precedence", () => {
    const configured = {
      adminUploadStagingDir: "/config/uploads",
      adminUploadMaxConcurrent: 2,
      adminUploadMaxStagedBytes: 400_000_000,
    };
    expect(resolveServeOptions({ transport: "http" }, {}, configured)).toMatchObject({
      adminUploads: {
        stagingDir: "/config/uploads",
        maxConcurrent: 2,
        maxStagedBytes: 400_000_000,
      },
    });
    expect(
      resolveServeOptions(
        { transport: "http" },
        {
          CAPLETS_ADMIN_UPLOAD_STAGING_DIR: "/env/uploads",
          CAPLETS_ADMIN_UPLOAD_MAX_CONCURRENT: "3",
          CAPLETS_ADMIN_UPLOAD_MAX_STAGED_BYTES: "410000000",
        },
        configured,
      ),
    ).toMatchObject({
      adminUploads: {
        stagingDir: "/env/uploads",
        maxConcurrent: 3,
        maxStagedBytes: 410_000_000,
      },
    });
    expect(
      resolveServeOptions(
        {
          transport: "http",
          adminUploadStagingDir: "/cli/uploads",
          adminUploadMaxConcurrent: "4",
          adminUploadMaxStagedBytes: "420000000",
        },
        {
          CAPLETS_ADMIN_UPLOAD_STAGING_DIR: "/env/uploads",
          CAPLETS_ADMIN_UPLOAD_MAX_CONCURRENT: "3",
          CAPLETS_ADMIN_UPLOAD_MAX_STAGED_BYTES: "410000000",
        },
        configured,
      ),
    ).toMatchObject({
      adminUploads: {
        stagingDir: "/cli/uploads",
        maxConcurrent: 4,
        maxStagedBytes: 420_000_000,
      },
    });
  });

  it.each([
    [
      "CLI",
      {
        raw: { adminUploadMaxConcurrent: "1.5" },
        env: {},
        defaults: undefined,
        message: "--admin-upload-max-concurrent",
      },
    ],
    [
      "environment",
      {
        raw: {},
        env: { CAPLETS_ADMIN_UPLOAD_MAX_CONCURRENT: "NaN" },
        defaults: undefined,
        message: "CAPLETS_ADMIN_UPLOAD_MAX_CONCURRENT",
      },
    ],
    [
      "config",
      {
        raw: {},
        env: {},
        defaults: { adminUploadMaxConcurrent: Number.MAX_SAFE_INTEGER + 1 },
        message: "serve.adminUploadMaxConcurrent",
      },
    ],
    [
      "staged byte minimum",
      {
        raw: { adminUploadMaxStagedBytes: String(DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES - 1) },
        env: {},
        defaults: undefined,
        message: `at least ${DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES}`,
      },
    ],
    [
      "empty staging directory",
      {
        raw: {},
        env: { CAPLETS_ADMIN_UPLOAD_STAGING_DIR: "  " },
        defaults: undefined,
        message: "CAPLETS_ADMIN_UPLOAD_STAGING_DIR must not be empty",
      },
    ],
  ])("rejects invalid %s admin upload settings", (_source, input) => {
    expect(() =>
      resolveServeOptions({ transport: "http", ...input.raw }, input.env, input.defaults),
    ).toThrow(input.message);
  });

  it("uses CAPLETS_SERVER_URL as HTTP serve defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        {
          CAPLETS_SERVER_URL: "http://localhost:7890/",
        },
      ),
    ).toMatchObject({
      transport: "http",
      host: "localhost",
      port: 7890,
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
        remoteStatePath: "/configured/remote-auth",
        upstreamUrl: "https://upstream.example.com",
        allowUnauthenticatedHttp: true,
        trustProxy: true,
        publicOrigins: ["https://caplets.example.com"],
      },
    );
    expect(resolved).toMatchObject({
      transport: "http",
      host: "0.0.0.0",
      port: 5480,
      auth: { type: "development_unauthenticated" },
      allowUnauthenticatedHttp: true,
      upstreamUrl: "https://upstream.example.com",
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
        { CAPLETS_SERVER_URL: "http://localhost:7000/" },
        { host: "0.0.0.0", port: 5480 },
      ),
    ).toMatchObject({
      transport: "http",
      host: "localhost",
      port: 6000,
      publicOrigin: "http://localhost:7000",
    });
  });

  it("keeps configured secondary public origins when CAPLETS_SERVER_URL is set", () => {
    expect(
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "https://primary.example.com/" },
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
        { CAPLETS_SERVER_URL: "https://caplets.example.com/" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "caplets.example.com",
      port: 5387,
      publicOrigin: "https://caplets.example.com",
    });
  });

  it("uses the default HTTP port when CAPLETS_SERVER_URL has no explicit port", () => {
    expect(
      resolveServeOptions({ transport: "http" }, { CAPLETS_SERVER_URL: "http://127.0.0.1/" }),
    ).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
    });
  });

  it("uses IPv6 loopback server URLs without requiring HTTP auth opt-in", () => {
    expect(
      resolveServeOptions({ transport: "http" }, { CAPLETS_SERVER_URL: "http://[::1]:5387/" }),
    ).toMatchObject({
      transport: "http",
      host: "::1",
      port: 5387,
      auth: { type: "remote_credentials" },
      loopback: true,
      warnUnauthenticatedNetwork: false,
    });
  });

  it("rejects non-loopback HTTP and path-bearing CAPLETS_SERVER_URL values", () => {
    expect(() =>
      resolveServeOptions({ transport: "http" }, { CAPLETS_SERVER_URL: "http://0.0.0.0:5387" }),
    ).toThrow(/use --host and --port separately/u);
    expect(() =>
      resolveServeOptions(
        { transport: "http" },
        { CAPLETS_SERVER_URL: "https://caplets.example.com/prefix" },
      ),
    ).toThrow(/origin/u);
  });

  it("lets explicit HTTP bind flags override CAPLETS_SERVER_URL defaults", () => {
    expect(
      resolveServeOptions(
        { transport: "http", host: "127.0.0.1", port: "6000" },
        { CAPLETS_SERVER_URL: "http://localhost:7890/" },
      ),
    ).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 6000,
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

  it("rejects admin upload options for stdio", () => {
    expect(() =>
      resolveServeOptions(
        {
          transport: "stdio",
          adminUploadStagingDir: "/tmp/uploads",
          adminUploadMaxConcurrent: "2",
          adminUploadMaxStagedBytes: "400000000",
        },
        {},
      ),
    ).toThrow(
      "--admin-upload-staging-dir, --admin-upload-max-concurrent, --admin-upload-max-staged-bytes are only valid with --transport http",
    );
  });

  it("resolves upstream URL for HTTP serving", () => {
    expect(
      resolveServeOptions({ transport: "http", upstreamUrl: "https://upstream.example.com" }, {}),
    ).toMatchObject({
      transport: "http",
      upstreamUrl: "https://upstream.example.com",
    });
  });

  it("rejects upstream URL for stdio serving", () => {
    expect(() =>
      resolveServeOptions({ transport: "stdio", upstreamUrl: "https://upstream.example.com" }, {}),
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
        { transport: "http", upstreamUrl: "https://caplets.example.com" },
        { CAPLETS_SERVER_URL: "https://caplets.example.com/" },
      ),
    ).toThrow(/must not point back to this runtime/u);
  });

  it("defaults daemonized serve to HTTP", () => {
    expect(resolveDaemonHttpServeOptions({}, {})).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
    });
  });

  it("rejects daemonized stdio serve", () => {
    expect(() => resolveDaemonHttpServeOptions({ transport: "stdio" } as never, {})).toThrow(
      "caplets daemon install does not accept --transport.",
    );
  });

  it("rejects invalid ports and path-bearing upstream origins", () => {
    expect(() => resolveServeOptions({ transport: "http", port: "0" }, {})).toThrow(
      /valid TCP port/u,
    );
    expect(() =>
      resolveServeOptions(
        { transport: "http", upstreamUrl: "https://upstream.example.com/prefix" },
        {},
      ),
    ).toThrow(/origin/u);
  });
});
