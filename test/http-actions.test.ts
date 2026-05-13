import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseConfig, type HttpApiConfig } from "../src/config.js";
import { HttpActionManager } from "../src/http-actions.js";
import { ServerRegistry } from "../src/registry.js";

describe("HttpActionManager", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;
  const requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body: string;
  }> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
          headers: request.headers,
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/redirect") {
          response.statusCode = 302;
          response.setHeader("location", "/ok");
          response.end();
          return;
        }
        if (request.url === "/slow") {
          setTimeout(() => response.end(JSON.stringify({ ok: true })), 100);
          return;
        }
        if (request.url === "/large") {
          response.end("x".repeat(2 * 1024 * 1024));
          return;
        }
        if (request.url === "/missing") {
          response.statusCode = 404;
          response.statusMessage = "Not Found";
          response.end(JSON.stringify({ error: "missing" }));
          return;
        }
        if (request.url === "/unauthorized") {
          response.statusCode = 401;
          response.statusMessage = "Unauthorized";
          response.setHeader("www-authenticate", 'Bearer error="invalid_token", token="secret"');
          response.setHeader("set-cookie", "session=secret; HttpOnly");
          response.end(JSON.stringify({ error: "secret" }));
          return;
        }
        if (request.url === "/forbidden") {
          response.statusCode = 403;
          response.statusMessage = "Forbidden";
          response.end(JSON.stringify({ error: "denied" }));
          return;
        }
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lists configured actions as MCP tools with default input schema", async () => {
    const manager = new HttpActionManager(registry());
    const api = httpApi({
      actions: {
        ping: { method: "GET", path: "/ping", description: "Ping the service." },
        update_user: {
          method: "PATCH",
          path: "/users/{id}",
          inputSchema: { type: "object", required: ["id"] },
        },
      },
    });

    const tools = await manager.listTools(api);

    expect(tools).toEqual([
      {
        name: "ping",
        description: "Ping the service.",
        inputSchema: { type: "object", additionalProperties: true },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "update_user",
        inputSchema: { type: "object", required: ["id"] },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
    ]);
  });

  it("builds requests from path, query, header, and JSON body mappings", async () => {
    requests.length = 0;
    const manager = new HttpActionManager(registry());
    const api = httpApi({
      auth: { type: "bearer", token: "secret-token" },
      actions: {
        create: {
          method: "POST",
          path: "/teams/{teamId}/users/{id}",
          query: { include: "$input.include", fixed: "yes" },
          headers: { "x-request-id": "$input.requestId" },
          jsonBody: {
            user: "$input.user",
            tags: ["static", "$input.tag"],
            all: "$input",
          },
        },
      },
    });

    const result = await manager.callTool(api, "create", {
      teamId: "alpha/beta",
      id: "42",
      include: true,
      requestId: "req-1",
      tag: "new",
      user: { name: "Ada" },
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 200, body: { ok: true } });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "/teams/alpha%2Fbeta/users/42?include=true&fixed=yes",
      headers: {
        authorization: "Bearer secret-token",
        "x-request-id": "req-1",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({
      user: { name: "Ada" },
      tags: ["static", "new"],
      all: {
        teamId: "alpha/beta",
        id: "42",
        include: true,
        requestId: "req-1",
        tag: "new",
        user: { name: "Ada" },
      },
    });
  });

  it("marks non-2xx responses as tool errors without throwing", async () => {
    const manager = new HttpActionManager(registry());
    const api = httpApi({ actions: { missing: { method: "GET", path: "/missing" } } });

    const result = await manager.callTool(api, "missing", {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 404,
      statusText: "Not Found",
      body: { error: "missing" },
    });
    expect(result.structuredContent).toHaveProperty("elapsedMs");
  });

  it("rejects query and header mappings that resolve to non-objects", async () => {
    const manager = new HttpActionManager(registry());

    await expect(
      manager.callTool(
        httpApi({
          actions: { bad_query: { method: "GET", path: "/ok", query: "$input.query" } },
        }),
        "bad_query",
        { query: "not-an-object" },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await expect(
      manager.callTool(
        httpApi({
          actions: { bad_headers: { method: "GET", path: "/ok", headers: "$input.headers" } },
        }),
        "bad_headers",
        { headers: ["not", "an", "object"] },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("returns structured 401 and 403 responses instead of throwing auth errors", async () => {
    const manager = new HttpActionManager(registry());
    const api = httpApi({
      actions: {
        unauthorized: { method: "GET", path: "/unauthorized" },
        forbidden: { method: "GET", path: "/forbidden" },
      },
    });

    const unauthorized = await manager.callTool(api, "unauthorized", {});
    const forbidden = await manager.callTool(api, "forbidden", {});

    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.structuredContent).toMatchObject({
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json" },
      body: { error: "secret" },
    });
    expect(JSON.stringify(unauthorized.structuredContent)).not.toContain("www-authenticate");
    expect(JSON.stringify(unauthorized.structuredContent)).not.toContain("set-cookie");
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent).toMatchObject({
      status: 403,
      statusText: "Forbidden",
      body: { error: "denied" },
    });
  });

  it("rejects unsafe paths, forbidden headers, redirects, timeouts, and oversized responses", async () => {
    const manager = new HttpActionManager(registry());
    const unsafePathApi = httpApi({ actions: { escape: { method: "GET", path: "/ok" } } });
    unsafePathApi.actions.escape!.path = "https://evil.example/x";
    await expect(manager.callTool(unsafePathApi, "escape", {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const basePathEscapeApi = httpApi({
      baseUrl: `${baseUrl}/api/v1`,
      actions: { escape: { method: "GET", path: "/../admin" } },
    });
    await expect(manager.callTool(basePathEscapeApi, "escape", {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(
      manager.callTool(
        httpApi({
          actions: { bad: { method: "GET", path: "/ok", headers: { authorization: "x" } } },
        }),
        "bad",
        {},
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      manager.callTool(
        httpApi({
          actions: { bad_dynamic: { method: "GET", path: "/ok", headers: "$input.headers" } },
        }),
        "bad_dynamic",
        { headers: { authorization: "Bearer attacker" } },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      manager.callTool(
        httpApi({ actions: { redirect: { method: "GET", path: "/redirect" } } }),
        "redirect",
        {},
      ),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
    await expect(
      manager.callTool(
        httpApi({ requestTimeoutMs: 10, actions: { slow: { method: "GET", path: "/slow" } } }),
        "slow",
        {},
      ),
    ).rejects.toMatchObject({ code: "TOOL_CALL_TIMEOUT" });
    await expect(
      manager.callTool(
        httpApi({ maxResponseBytes: 100, actions: { large: { method: "GET", path: "/large" } } }),
        "large",
        {},
      ),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
  });

  function httpApi(overrides: Partial<HttpApiConfig>): HttpApiConfig {
    return parseConfig({
      httpApis: {
        http: {
          name: "HTTP API",
          description: "Call configured HTTP service actions.",
          baseUrl,
          auth: { type: "none" },
          actions: { ok: { method: "GET", path: "/ok" } },
          ...overrides,
        },
      },
    }).httpApis.http!;
  }
});

function registry(): ServerRegistry {
  return new ServerRegistry(
    parseConfig({
      httpApis: {
        http: {
          name: "HTTP API",
          description: "Call configured HTTP service actions.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ok: { method: "GET", path: "/ok" } },
        },
      },
    }),
  );
}
