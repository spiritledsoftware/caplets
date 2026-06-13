import { describe, expect, it, vi } from "vitest";

const mockMcpAuth = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth")>()),
  auth: mockMcpAuth,
}));

import {
  classifyRemoteAuthError,
  genericOAuthHeaders,
  extractCompletion,
  FileOAuthProvider,
  authStorePath,
  oauthHeaders,
  readTokenBundle,
  runOAuthFlow,
  runGenericOAuthFlow,
  startGenericOAuthFlow,
  writeTokenBundle,
} from "../src/auth";
import { formatAuthRows, listAuth } from "../src/cli/auth";
import { runCli } from "../src/cli";
import { parseConfig } from "../src/config";
import { DEFAULT_AUTH_DIR } from "../src/config/paths";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

describe("auth helpers", () => {
  it("extracts callback code and state together", () => {
    expect(extractCompletion("http://127.0.0.1/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
    expect(extractCompletion("manual-code")).toEqual({ code: "manual-code" });
  });

  it("reports OAuth error callbacks before extracting an authorization code", async () => {
    const flow = await startGenericOAuthFlow(
      {
        server: "remote",
        backend: "http",
        baseUrl: "https://api.example.com",
        auth: {
          type: "oauth2",
          clientId: "client",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
        },
      },
      { redirectUri: "http://127.0.0.1/callback" },
    );

    await expect(
      flow.complete(
        "http://127.0.0.1/callback?error=access_denied&error_description=Access%20denied&state=abc",
      ),
    ).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "OAuth provider returned an error: Access denied",
    });
  });

  it("requires stored OAuth tokens before remote operations", async () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    }).mcpServers.remote!;

    await expect(oauthHeaders(server, "/tmp/does-not-exist")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("uses stored OIDC tokens for remote MCP headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      const server = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote server.",
            transport: "http",
            url: "https://example.com/mcp",
            auth: { type: "oidc", clientId: "client" },
          },
        },
      }).mcpServers.remote!;
      writeTokenBundle({ server: "remote", accessToken: "secret-token" }, dir);

      await expect(oauthHeaders(server, dir)).resolves.toEqual({
        authorization: "Bearer secret-token",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes expired remote MCP OAuth tokens before building headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-mcp-refresh-"));
    const requests: Array<{ url?: string; body: string }> = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ ...(request.url ? { url: request.url } : {}), body });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "new-mcp-access-token",
            refresh_token: "new-mcp-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const config = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote OAuth server.",
            transport: "http",
            url: `${baseUrl}/mcp`,
            auth: {
              type: "oauth2",
              clientId: "client",
              tokenUrl: `${baseUrl}/token`,
            },
          },
        },
      });
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "old-mcp-access-token",
          refreshToken: "old-mcp-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
        dir,
      );

      const headers = await oauthHeaders(config.mcpServers.remote!, dir);

      expect(headers).toEqual({ authorization: "Bearer new-mcp-access-token" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/token");
      expect(new URLSearchParams(requests[0]?.body).get("grant_type")).toBe("refresh_token");
      expect(new URLSearchParams(requests[0]?.body).get("refresh_token")).toBe(
        "old-mcp-refresh-token",
      );
      expect(readTokenBundle("remote", dir)).toMatchObject({
        accessToken: "new-mcp-access-token",
        refreshToken: "new-mcp-refresh-token",
        clientId: "client",
        protectedResourceOrigin: baseUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt token bundle files", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      writeFileSync(join(dir, "remote.json"), "{not-json\n");

      expect(readTokenBundle("remote", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects auth store path traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      expect(() => authStorePath("../remote", dir)).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores remote auth under the shared default auth directory", () => {
    expect(authStorePath("remote")).toBe(join(DEFAULT_AUTH_DIR, "remote.json"));
  });

  it("honors explicit auth directory overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      expect(authStorePath("remote", dir)).toBe(join(dir, "remote.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors filesystem root as an explicit auth directory", () => {
    const root = parse(process.cwd()).root;

    expect(authStorePath("remote", root)).toBe(join(root, "remote.json"));
  });

  it("builds generic OAuth headers for OpenAPI and GraphQL auth targets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      writeTokenBundle(
        {
          server: "users",
          accessToken: "secret-access-token",
          authType: "oidc",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
          idToken: "secret-id-token",
          issuer: "https://issuer.example",
          subject: "user-123",
        },
        dir,
      );

      expect(
        await genericOAuthHeaders(
          {
            server: "users",
            backend: "openapi",
            auth: { type: "oidc" },
          },
          dir,
        ),
      ).toEqual({ authorization: "Bearer secret-access-token" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes expired generic OAuth tokens before building headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-refresh-"));
    const requests: Array<{ url?: string; body: string }> = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ ...(request.url ? { url: request.url } : {}), body });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "api:read",
          }),
        );
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      writeTokenBundle(
        {
          server: "users",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2000-01-01T00:00:00.000Z",
          scope: "api:read",
          clientId: "client",
          protectedResourceOrigin: baseUrl,
        },
        dir,
      );

      const headers = await genericOAuthHeaders(
        {
          server: "users",
          backend: "http",
          baseUrl,
          auth: {
            type: "oauth2",
            clientId: "client",
            tokenUrl: `${baseUrl}/token`,
          },
        },
        dir,
      );

      expect(headers).toEqual({ authorization: "Bearer new-access-token" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/token");
      expect(new URLSearchParams(requests[0]?.body).get("grant_type")).toBe("refresh_token");
      expect(new URLSearchParams(requests[0]?.body).get("refresh_token")).toBe("old-refresh-token");
      expect(new URLSearchParams(requests[0]?.body).get("client_id")).toBe("client");
      expect(readTokenBundle("users", dir)).toMatchObject({
        accessToken: "new-access-token",
        refreshToken: "rotated-refresh-token",
        tokenType: "Bearer",
        scope: "api:read",
        clientId: "client",
        protectedResourceOrigin: baseUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects generic OAuth headers when refresh returns an expired token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-refresh-expired-"));
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "already-expired-token",
          token_type: "Bearer",
          expires_in: -1,
        }),
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      writeTokenBundle(
        {
          server: "users",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
          clientId: "client",
          protectedResourceOrigin: baseUrl,
        },
        dir,
      );

      await expect(
        genericOAuthHeaders(
          {
            server: "users",
            backend: "http",
            baseUrl,
            auth: {
              type: "oauth2",
              clientId: "client",
              tokenUrl: `${baseUrl}/token`,
            },
          },
          dir,
        ),
      ).rejects.toMatchObject({ code: "AUTH_REFRESH_FAILED" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves usable generic OAuth expiry metadata when refresh omits expires_in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-refresh-expiry-"));
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "new-access-token",
          token_type: "Bearer",
        }),
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const expiresAt = "2999-01-01T00:00:00.000Z";
      writeTokenBundle(
        {
          server: "users",
          authType: "oauth2",
          accessToken: "",
          refreshToken: "old-refresh-token",
          expiresAt,
          clientId: "client",
          protectedResourceOrigin: baseUrl,
        },
        dir,
      );

      await expect(
        genericOAuthHeaders(
          {
            server: "users",
            backend: "http",
            baseUrl,
            auth: {
              type: "oauth2",
              clientId: "client",
              tokenUrl: `${baseUrl}/token`,
            },
          },
          dir,
        ),
      ).resolves.toEqual({ authorization: "Bearer new-access-token" });

      expect(readTokenBundle("users", dir)).toMatchObject({
        accessToken: "new-access-token",
        expiresAt,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes HTTP APIs in OAuth auth target listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-config-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          httpApis: {
            status: {
              name: "Status HTTP",
              description: "Check internal service status through HTTP.",
              baseUrl: "https://api.example.com",
              auth: { type: "oidc", clientId: "client" },
              actions: { check: { method: "GET", path: "/check" } },
            },
          },
        }),
      );
      const output: string[] = [];

      listAuth({ configPath, writeOut: (value) => output.push(value) });

      expect(output.join("")).toContain("status\n  Status: missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists auth rows from project and global sources with source metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-sources-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      writeAuthConfig(configPath, "global-auth");
      writeAuthConfig(projectConfigPath, "project-auth");
      const output: string[] = [];

      await runCli(["auth", "list", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => output.push(value),
      });

      expect(JSON.parse(output.join(""))).toEqual([
        expect.objectContaining({ server: "global-auth", source: "global" }),
        expect.objectContaining({ server: "project-auth", source: "project" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters local auth list rows by explicit target scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-filter-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      writeAuthConfig(configPath, "global-auth");
      writeAuthConfig(projectConfigPath, "project-auth");
      const output: string[] = [];

      await runCli(["auth", "list", "--project", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => output.push(value),
      });

      expect(JSON.parse(output.join(""))).toEqual([
        expect.objectContaining({ server: "project-auth", source: "project" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no auth rows for empty explicit local scopes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-empty-scope-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(configPath, "{}", "utf8");
      writeFileSync(projectConfigPath, "{}", "utf8");
      const globalOutput: string[] = [];
      const projectOutput: string[] = [];

      await runCli(["auth", "list", "--global", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => globalOutput.push(value),
      });
      await runCli(["auth", "list", "--project", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => projectOutput.push(value),
      });

      expect(JSON.parse(globalOutput.join(""))).toEqual([]);
      expect(JSON.parse(projectOutput.join(""))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not include global Caplet files in project-only auth list rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-project-only-files-"));
    try {
      const globalRoot = join(dir, "global");
      const configPath = join(globalRoot, "config.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      mkdirSync(globalRoot, { recursive: true });
      writeAuthConfig(projectConfigPath, "project-auth");
      writeAuthCapletFile(join(globalRoot, "global-file-auth.md"), "Global File Auth");
      const output: string[] = [];

      await runCli(["auth", "list", "--project", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => output.push(value),
      });

      expect(JSON.parse(output.join(""))).toEqual([
        expect.objectContaining({ server: "project-auth", source: "project" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not load sentinel-named directories for project-only auth list rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-no-sentinel-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      writeAuthConfig(projectConfigPath, "project-auth");
      writeAuthConfig(join(dir, ".caplets-missing-global", "config.json"), "sentinel-auth");
      const output: string[] = [];

      await runCli(["auth", "list", "--project", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        authDir: join(dir, "auth"),
        writeOut: (value) => output.push(value),
      });

      expect(JSON.parse(output.join(""))).toEqual([
        expect.objectContaining({ server: "project-auth", source: "project" }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces malformed scoped auth configs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-invalid-scope-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      writeAuthConfig(configPath, "global-auth");
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(projectConfigPath, "{ invalid json", "utf8");

      await expect(
        runCli(["auth", "list", "--project", "--json"], {
          env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
          authDir: join(dir, "auth"),
          writeOut: () => {},
        }),
      ).rejects.toThrow(/not valid JSON/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes source in plain and markdown auth row output", () => {
    expect(
      formatAuthRows([{ server: "remote", status: "authenticated", source: "remote" }], "plain"),
    ).toContain("  Source: remote");
    expect(
      formatAuthRows(
        [{ server: "project-auth", status: "missing", source: "project" }],
        "markdown",
      ),
    ).toContain("- `project-auth` — missing (source project)");
  });

  it("rejects ambiguous local auth targets without a target flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-ambiguous-"));
    try {
      const configPath = join(dir, "global.json");
      const projectConfigPath = join(dir, "project", ".caplets", "config.json");
      writeAuthConfig(configPath, "shared");
      writeAuthConfig(projectConfigPath, "shared");

      await expect(
        runCli(["auth", "logout", "shared"], {
          env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
          authDir: join(dir, "auth"),
          writeOut: () => {},
        }),
      ).rejects.toThrow(/--project.*--global.*--remote/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies remote 401 and 403 as safe auth errors", () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    }).mcpServers.remote!;

    const unauthorized = classifyRemoteAuthError(
      server,
      new Response("", {
        status: 401,
        statusText: "Unauthorized",
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://auth.example/meta"' },
      }),
    );
    expect(unauthorized).toMatchObject({ code: "AUTH_REQUIRED" });

    const forbidden = classifyRemoteAuthError(server, new Response("", { status: 403 }));
    expect(forbidden).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("keeps OAuth client authentication callback bound when SDK calls it detached", async () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client", clientSecret: "secret" },
        },
      },
    }).mcpServers.remote!;
    const provider = new FileOAuthProvider(server, "http://127.0.0.1/callback", () => {});
    const addClientAuthentication = provider.addClientAuthentication;
    const headers = new Headers();
    const params = new URLSearchParams();

    await addClientAuthentication(headers, params);

    expect(params.get("client_id")).toBe("client");
    expect(params.get("client_secret")).toBe("secret");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("adds configured OAuth public client ID during SDK token exchange", async () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    }).mcpServers.remote!;
    const provider = new FileOAuthProvider(server, "http://127.0.0.1/callback", () => {});
    const addClientAuthentication = provider.addClientAuthentication;
    const headers = new Headers();
    const params = new URLSearchParams();

    await addClientAuthentication(headers, params);

    expect(params.get("client_id")).toBe("client");
    expect(params.has("client_secret")).toBe(false);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("exposes configured OAuth client metadata URL for URL-based client IDs", () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: {
            type: "oauth2",
            clientMetadataUrl: "https://example.com/caplets/oauth-client-metadata.json",
          },
        },
      },
    }).mcpServers.remote!;
    const provider = new FileOAuthProvider(server, "http://127.0.0.1/callback", () => {});

    expect(provider.clientMetadataUrl).toBe(
      "https://example.com/caplets/oauth-client-metadata.json",
    );
    expect(provider.clientInformation()).toBeUndefined();
  });

  it("does not rewrite SDK dynamic-registration errors when MCP OAuth uses a client metadata URL", async () => {
    const sdkError = new Error("server does not support dynamic client registration");
    mockMcpAuth.mockRejectedValueOnce(sdkError);
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: {
            type: "oauth2",
            clientMetadataUrl: "https://example.com/caplets/oauth-client-metadata.json",
          },
        },
      },
    }).mcpServers.remote!;

    await expect(runOAuthFlow(server, { noOpen: true })).rejects.toBe(sdkError);
  });

  it.each(["oauth2", "oidc"] as const)(
    "adds dynamically registered %s client information during SDK token exchange",
    async (authType) => {
      const server = parseConfig({
        mcpServers: {
          remote: {
            name: "Remote",
            description: "A useful remote server.",
            transport: "http",
            url: "https://example.com/mcp",
            auth: { type: authType },
          },
        },
      }).mcpServers.remote!;
      const provider = new FileOAuthProvider(server, "http://127.0.0.1/callback", () => {});
      provider.saveClientInformation({
        client_id: "dynamic-client",
        client_secret: "dynamic-secret",
      });
      const addClientAuthentication = provider.addClientAuthentication;
      const headers = new Headers();
      const params = new URLSearchParams();

      await addClientAuthentication(headers, params);

      expect(params.get("client_id")).toBe("dynamic-client");
      expect(params.get("client_secret")).toBe("dynamic-secret");
      expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    },
  );

  it("does not mix dynamic public client ID with configured client secret", async () => {
    const server = parseConfig({
      mcpServers: {
        remote: {
          name: "Remote",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "static-client", clientSecret: "static-secret" },
        },
      },
    }).mcpServers.remote!;
    const provider = new FileOAuthProvider(server, "http://127.0.0.1/callback", () => {});
    provider.saveClientInformation({ client_id: "dynamic-client" });
    const addClientAuthentication = provider.addClientAuthentication;
    const headers = new Headers();
    const params = new URLSearchParams();

    await addClientAuthentication(headers, params);

    expect(params.get("client_id")).toBe("dynamic-client");
    expect(params.has("client_secret")).toBe(false);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("runs generic OIDC authorization code flow with discovery and dynamic client registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    let baseUrl = "";
    let authorizationUrl = "";
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          ...(request.method ? { method: request.method } : {}),
          ...(request.url ? { url: request.url } : {}),
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/.well-known/oauth-protected-resource") {
          response.end(JSON.stringify({ authorization_servers: [baseUrl] }));
          return;
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "missing" }));
          return;
        }
        if (request.url === "/.well-known/openid-configuration") {
          response.end(
            JSON.stringify({
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              registration_endpoint: `${baseUrl}/register`,
            }),
          );
          return;
        }
        if (request.url === "/register") {
          response.statusCode = 201;
          response.end(JSON.stringify({ client_id: "dynamic-client" }));
          return;
        }
        if (request.url === "/token") {
          const idToken = [
            "header",
            Buffer.from(
              JSON.stringify({ iss: baseUrl, sub: "subject-123", aud: "dynamic-client" }),
            ).toString("base64url"),
            "signature",
          ].join(".");
          response.end(
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              id_token: idToken,
              token_type: "Bearer",
              expires_in: 3600,
              scope: "openid profile email",
            }),
          );
          return;
        }
        response.end("{}");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

      await runGenericOAuthFlow(
        {
          server: "users",
          backend: "openapi",
          url: baseUrl,
          auth: { type: "oidc" },
        },
        {
          authDir: dir,
          noOpen: true,
          print: (line) => {
            authorizationUrl = line.match(/https?:\/\/\S+/)?.[0] ?? "";
          },
          readManualInput: async () => {
            const url = new URL(authorizationUrl);
            return `http://127.0.0.1/callback?code=auth-code&state=${url.searchParams.get("state")}`;
          },
        },
      );

      expect(requests.find((request) => request.url === "/register")?.body).toContain(
        "redirect_uris",
      );
      expect(requests.find((request) => request.url === "/token")?.body).toContain(
        "client_id=dynamic-client",
      );
      const bundle = await genericOAuthHeaders(
        { server: "users", backend: "openapi", auth: { type: "oidc" } },
        dir,
      );
      expect(bundle).toEqual({ authorization: "Bearer new-access-token" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-loopback plaintext OAuth endpoints before token exchange", async () => {
    await expect(
      runGenericOAuthFlow(
        {
          server: "users",
          backend: "openapi",
          url: "https://api.example.com",
          auth: {
            type: "oauth2",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "http://example.com/token",
            clientId: "client",
          },
        },
        {
          noOpen: true,
          manualInput: "http://127.0.0.1/callback?code=code",
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("uses configured client metadata URLs as URL-based client IDs for generic OAuth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    let baseUrl = "";
    let authorizationUrl = "";
    let tokenRequestBody = "";
    const clientMetadataUrl = "https://client.example.com/caplets/oauth-client-metadata.json";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/token") {
          tokenRequestBody = body;
          response.end(JSON.stringify({ access_token: "metadata-url-token" }));
          return;
        }
        response.end("{}");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(
        runGenericOAuthFlow(
          {
            server: "users",
            backend: "openapi",
            url: baseUrl,
            auth: {
              type: "oauth2",
              authorizationUrl: `${baseUrl}/authorize`,
              tokenUrl: `${baseUrl}/token`,
              clientMetadataUrl,
              clientSecret: "metadata-url-secret",
            },
          },
          {
            authDir: dir,
            noOpen: true,
            print: (line) => {
              authorizationUrl = line.match(/https?:\/\/\S+/)?.[0] ?? "";
            },
            readManualInput: async () => {
              const url = new URL(authorizationUrl);
              return `http://127.0.0.1/callback?code=auth-code&state=${url.searchParams.get("state")}`;
            },
          },
        ),
      ).resolves.toMatchObject({ accessToken: "metadata-url-token", clientId: clientMetadataUrl });

      expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(clientMetadataUrl);
      expect(new URLSearchParams(tokenRequestBody).get("client_id")).toBe(clientMetadataUrl);
      expect(new URLSearchParams(tokenRequestBody).get("client_secret")).toBe(
        "metadata-url-secret",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches generic OAuth token bundles against configured client metadata URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    try {
      writeTokenBundle(
        {
          server: "users",
          authType: "oauth2",
          accessToken: "metadata-url-token",
          clientId: "https://client.example.com/caplets/oauth-client-metadata.json",
          protectedResourceOrigin: "https://api.example.com",
        },
        dir,
      );

      expect(
        await genericOAuthHeaders(
          {
            server: "users",
            backend: "openapi",
            url: "https://api.example.com/openapi.json",
            auth: {
              type: "oauth2",
              clientMetadataUrl: "https://client.example.com/caplets/oauth-client-metadata.json",
            },
          },
          dir,
        ),
      ).toEqual({ authorization: "Bearer metadata-url-token" });

      await expect(
        genericOAuthHeaders(
          {
            server: "users",
            backend: "openapi",
            url: "https://api.example.com/openapi.json",
            auth: {
              type: "oauth2",
              clientMetadataUrl: "https://client.example.com/other-client.json",
            },
          },
          dir,
        ),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects insecure explicit OAuth discovery URLs instead of falling back", async () => {
    await expect(
      runGenericOAuthFlow(
        {
          server: "users",
          backend: "openapi",
          url: "https://api.example.com",
          auth: {
            type: "oidc",
            resourceMetadataUrl: "http://example.com/.well-known/oauth-protected-resource",
            clientId: "client",
          },
        },
        {
          noOpen: true,
          manualInput: "http://127.0.0.1/callback?code=code",
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("discovers path-based OIDC issuers using the issuer path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    let baseUrl = "";
    let authorizationUrl = "";
    const requests: string[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        if (request.url === "/.well-known/oauth-protected-resource") {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "missing" }));
          return;
        }
        if (request.url === "/.well-known/oauth-authorization-server/realms/acme") {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "missing" }));
          return;
        }
        if (request.url === "/realms/acme/.well-known/openid-configuration") {
          response.end(
            JSON.stringify({
              issuer: `${baseUrl}/realms/acme`,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
            }),
          );
          return;
        }
        if (request.url === "/token") {
          const idToken = [
            "header",
            Buffer.from(
              JSON.stringify({
                iss: `${baseUrl}/realms/acme`,
                sub: "subject-123",
                aud: "client",
              }),
            ).toString("base64url"),
            "signature",
          ].join(".");
          response.end(JSON.stringify({ access_token: "token", id_token: idToken }));
          return;
        }
        response.end("{}");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(
        runGenericOAuthFlow(
          {
            server: "users",
            backend: "openapi",
            url: baseUrl,
            auth: { type: "oidc", issuer: `${baseUrl}/realms/acme`, clientId: "client" },
          },
          {
            authDir: dir,
            noOpen: true,
            print: (line) => {
              authorizationUrl = line.match(/https?:\/\/\S+/)?.[0] ?? "";
            },
            readManualInput: async () => {
              const url = new URL(authorizationUrl);
              return `http://127.0.0.1/callback?code=auth-code&state=${url.searchParams.get("state")}`;
            },
          },
        ),
      ).resolves.toMatchObject({ accessToken: "token" });
      expect(requests).toContain("/realms/acme/.well-known/openid-configuration");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects OIDC token responses with missing or mismatched id_token claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    let baseUrl = "";
    let authorizationUrl = "";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/.well-known/oauth-protected-resource") {
          response.end(JSON.stringify({ authorization_servers: [baseUrl] }));
          return;
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "missing" }));
          return;
        }
        if (request.url === "/.well-known/openid-configuration") {
          response.end(
            JSON.stringify({
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
            }),
          );
          return;
        }
        if (request.url === "/token") {
          const idToken = [
            "header",
            Buffer.from(
              JSON.stringify({
                iss: "https://attacker.example",
                sub: "subject-123",
                aud: "client",
              }),
            ).toString("base64url"),
            "signature",
          ].join(".");
          response.end(JSON.stringify({ access_token: "token", id_token: idToken }));
          return;
        }
        response.end("{}");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(
        runGenericOAuthFlow(
          {
            server: "users",
            backend: "openapi",
            url: baseUrl,
            auth: { type: "oidc", clientId: "client" },
          },
          {
            authDir: dir,
            noOpen: true,
            print: (line) => {
              authorizationUrl = line.match(/https?:\/\/\S+/)?.[0] ?? "";
            },
            readManualInput: async () => {
              const url = new URL(authorizationUrl);
              return `http://127.0.0.1/callback?code=auth-code&state=${url.searchParams.get("state")}`;
            },
          },
        ),
      ).rejects.toMatchObject({
        code: "AUTH_FAILED",
        message: "OIDC issuer did not match discovered metadata",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows loopback plaintext OAuth endpoints for development", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    let baseUrl = "";
    let authorizationUrl = "";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/token") {
          response.end(JSON.stringify({ access_token: "loopback-token" }));
          return;
        }
        response.end("{}");
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(
        runGenericOAuthFlow(
          {
            server: "users",
            backend: "openapi",
            url: baseUrl,
            auth: {
              type: "oauth2",
              authorizationUrl: `${baseUrl}/authorize`,
              tokenUrl: `${baseUrl}/token`,
              clientId: "client",
            },
          },
          {
            authDir: dir,
            noOpen: true,
            print: (line) => {
              authorizationUrl = line.match(/https?:\/\/\S+/)?.[0] ?? "";
            },
            readManualInput: async () => {
              const url = new URL(authorizationUrl);
              return `http://127.0.0.1/callback?code=auth-code&state=${url.searchParams.get("state")}`;
            },
          },
        ),
      ).resolves.toMatchObject({ accessToken: "loopback-token" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeAuthConfig(path: string, serverId: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        [serverId]: {
          name: serverId,
          description: `${serverId} auth`,
          transport: "http",
          url: "https://example.com/mcp",
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    }),
  );
}

function writeAuthCapletFile(path: string, name: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "---",
      `name: ${name}`,
      `description: ${name}`,
      "mcpServer:",
      "  transport: http",
      "  url: https://example.com/mcp",
      "  auth:",
      "    type: oauth2",
      "    clientId: client",
      "---",
      `# ${name}`,
    ].join("\n"),
  );
}
