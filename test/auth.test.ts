import { describe, expect, it } from "vitest";
import {
  classifyRemoteAuthError,
  genericOAuthHeaders,
  extractCompletion,
  FileOAuthProvider,
  oauthHeaders,
  runGenericOAuthFlow,
  writeTokenBundle,
} from "../src/auth.js";
import { parseConfig } from "../src/config.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("auth helpers", () => {
  it("extracts callback code and state together", () => {
    expect(extractCompletion("http://127.0.0.1/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
    expect(extractCompletion("manual-code")).toEqual({ code: "manual-code" });
  });

  it("requires stored OAuth tokens before remote operations", () => {
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

    expect(() => oauthHeaders(server, "/tmp/does-not-exist")).toThrow(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
  });

  it("uses stored OIDC tokens for remote MCP headers", () => {
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

      expect(oauthHeaders(server, dir)).toEqual({ authorization: "Bearer secret-token" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds generic OAuth headers for OpenAPI and GraphQL auth targets", () => {
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
        genericOAuthHeaders(
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
      const bundle = genericOAuthHeaders(
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
