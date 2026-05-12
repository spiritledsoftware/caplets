import { describe, expect, it } from "vitest";
import {
  classifyRemoteAuthError,
  extractCompletion,
  FileOAuthProvider,
  oauthHeaders,
} from "../src/auth.js";
import { parseConfig } from "../src/config.js";

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
});
