import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type HttpApiConfig } from "../src/config";
import { DownstreamManager } from "../src/downstream";
import { HttpActionManager } from "../src/http-actions";
import { ServerRegistry } from "../src/registry";
import { CapletsEngine } from "../src/engine";
import { handleServerTool } from "../src/tools";
import { testBackendOperationRuntime } from "./backend-operation-runtime";

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
        if (request.url === "/inline-threshold") {
          response.end("x".repeat(1024 * 1024));
          return;
        }
        if (request.url === "/over-inline-threshold") {
          response.end("x".repeat(1024 * 1024 + 1));
          return;
        }
        if (request.url === "/large-stream") {
          response.write("x".repeat(128));
          response.write("x".repeat(128));
          response.end();
          return;
        }
        if (request.url === "/pdf") {
          response.setHeader("content-type", "application/pdf");
          response.end(Buffer.from("%PDF-1.7 test"));
          return;
        }
        if (request.url === "/attachment") {
          response.removeHeader("content-type");
          response.setHeader("content-disposition", 'attachment; filename="report.bin"');
          response.end(Buffer.from([0, 1, 2, 3]));
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
          outputSchema: {
            type: "object",
            required: ["status", "body"],
            properties: {
              status: { type: "number" },
              body: {
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              },
            },
          },
        },
      },
    });

    const tools = await manager.listTools(api);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: "ping",
      description: "Ping the service.",
      inputSchema: { type: "object", additionalProperties: true },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(tools[1]).toMatchObject({
      name: "update_user",
      inputSchema: { type: "object", required: ["id"] },
      outputSchema: {
        type: "object",
        required: ["status", "statusText", "headers", "kind"],
        properties: {
          body: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          kind: { enum: ["inline", "local-artifact", "remote-reference"] },
          uri: { type: "string" },
          path: { type: "string" },
        },
        oneOf: expect.any(Array),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
  });

  it("exposes output schemas through describe_tool, compact metadata, and call_tool.fields", async () => {
    requests.length = 0;
    const config = parseConfig({
      httpApis: {
        http: {
          name: "HTTP API",
          description: "Call configured HTTP service actions.",
          baseUrl,
          auth: { type: "none" },
          actions: {
            ping: {
              method: "GET",
              path: "/ping",
              outputSchema: {
                type: "object",
                required: ["status", "body"],
                properties: {
                  status: { type: "number" },
                  body: {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const caplet = config.httpApis.http!;
    const registry = new ServerRegistry(config);
    const http = new HttpActionManager(registry);
    const downstream = new DownstreamManager(registry);

    const tool = await http.getTool(caplet, "ping");
    expect(tool.outputSchema).toMatchObject({
      type: "object",
      required: ["status", "statusText", "headers", "kind"],
      properties: {
        body: { properties: { ok: { type: "boolean" } } },
        kind: { enum: ["inline", "local-artifact", "remote-reference"] },
        uri: { type: "string" },
      },
      oneOf: expect.any(Array),
    });
    expect(http.compact(caplet, tool)).toMatchObject({
      name: "ping",
      hasInputSchema: true,
      hasOutputSchema: true,
      readOnlyHint: true,
      destructiveHint: false,
    });

    const fetched = (await handleServerTool(
      caplet,
      { operation: "describe_tool", name: "ping" },
      registry,
      testBackendOperationRuntime(registry, { mcp: downstream, http }),
    )) as any;
    expect(fetched.structuredContent.result.tool.outputSchema).toMatchObject({
      properties: { body: { properties: { ok: { type: "boolean" } } } },
    });

    const projected = (await handleServerTool(
      caplet,
      { operation: "call_tool", name: "ping", args: {}, fields: ["body.ok"] },
      registry,
      testBackendOperationRuntime(registry, { mcp: downstream, http }),
    )) as any;
    expect(projected.structuredContent).toEqual({ body: { ok: true } });
    expect(projected.content[0].text).toContain("# HTTP API call_tool ping");
    expect(projected.content[0].text).toContain("## Body");
    expect(projected.content[0].text).toContain('"ok": true');
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

  it("writes binary HTTP responses as media artifacts", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-artifacts-"));
    const manager = new HttpActionManager(registry(), { artifactDir });
    const api = httpApi({ actions: { pdf: { method: "GET", path: "/pdf" } } });

    try {
      const result = await manager.callTool(api, "pdf", {});

      expect(result.structuredContent).toMatchObject({
        status: 200,
        headers: { "content-type": "application/pdf" },
        kind: "local-artifact",
        mimeType: "application/pdf",
        byteLength: 13,
      });
      expect(readFileSync(localArtifactPath(result), "utf8")).toBe("%PDF-1.7 test");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("writes attachment responses without content type as media artifacts", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-attachment-artifacts-"));
    const manager = new HttpActionManager(registry(), { artifactDir });
    const api = httpApi({ actions: { attachment: { method: "GET", path: "/attachment" } } });

    try {
      const result = await manager.callTool(api, "attachment", {});

      expect(result.structuredContent).toMatchObject({
        kind: "local-artifact",
        filename: "report.bin",
        byteLength: 4,
        uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
        sha256: expect.any(String),
      });
      expect(readFileSync(localArtifactPath(result))).toEqual(Buffer.from([0, 1, 2, 3]));
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("writes HTTP artifacts through handleServerTool", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-tool-artifacts-"));
    const config = parseConfig({
      httpApis: {
        http: {
          name: "HTTP API",
          description: "Call configured HTTP service actions.",
          baseUrl,
          auth: { type: "none" },
          actions: { pdf: { method: "GET", path: "/pdf" } },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const http = new HttpActionManager(registry, { artifactDir });
    const downstream = new DownstreamManager(registry);

    try {
      const result = await handleServerTool(
        config.httpApis.http!,
        { operation: "call_tool", name: "pdf", args: {} },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, http }),
      );

      expect(localArtifactPath(result)).toContain(artifactDir);
      expect(readFileSync(localArtifactPath(result), "utf8")).toBe("%PDF-1.7 test");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("writes oversized streamed text responses as media artifacts", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-stream-artifacts-"));
    const manager = new HttpActionManager(registry(), {
      artifactDir,
      mediaInlineThresholdBytes: 100,
    });
    const api = httpApi({
      actions: { large_stream: { method: "GET", path: "/large-stream" } },
    });

    try {
      const result = await manager.callTool(api, "large_stream", {});

      expect(result.structuredContent).toMatchObject({
        status: 200,
        kind: "local-artifact",
        mimeType: "application/json",
        byteLength: 256,
      });
      expect(readFileSync(localArtifactPath(result), "utf8")).toBe("x".repeat(256));
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("keeps the default inline threshold distinct from an HTTP Action hard cap", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-default-threshold-"));
    const manager = new HttpActionManager(registry(), { artifactDir });
    const api = httpApi({
      maxResponseBytes: 2 * 1024 * 1024,
      actions: {
        exact: { method: "GET", path: "/inline-threshold" },
        over: { method: "GET", path: "/over-inline-threshold" },
      },
    });

    try {
      const exact = await manager.callTool(api, "exact", {});
      const over = await manager.callTool(api, "over", {});

      expect(exact.structuredContent).toMatchObject({ kind: "inline" });
      expect(over.structuredContent).toMatchObject({
        kind: "local-artifact",
        byteLength: 1024 * 1024 + 1,
      });
      expect(readFileSync(localArtifactPath(over)).byteLength).toBe(1024 * 1024 + 1);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("applies the engine Media inline threshold below an action hard cap", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-engine-http-artifacts-"));
    const config = parseConfig({
      httpApis: {
        http: {
          name: "HTTP API",
          description: "Call configured HTTP service actions.",
          baseUrl,
          auth: { type: "none" },
          maxResponseBytes: 512,
          actions: {
            large_stream: {
              method: "GET",
              path: "/large-stream",
            },
          },
        },
      },
    });
    const engine = CapletsEngine.unactivatedForTests({
      watch: false,
      artifactDir,
      mediaInlineThresholdBytes: 128,
      configLoader: () => config,
    });

    try {
      const progressive = await engine.execute("http", {
        operation: "call_tool",
        name: "large_stream",
        args: {},
      });
      const direct = await engine.executeDirectTool("http", "large_stream", {});

      expect(progressive).toMatchObject({
        structuredContent: {
          kind: "local-artifact",
          byteLength: 256,
          path: expect.stringContaining(artifactDir),
        },
      });
      expect(direct).toMatchObject({
        structuredContent: {
          kind: "local-artifact",
          byteLength: 256,
          path: expect.stringContaining(artifactDir),
        },
      });
    } finally {
      await engine.close();
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("enforces maxResponseBytes as a hard response cap", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-http-cap-artifacts-"));
    const manager = new HttpActionManager(registry(), {
      artifactDir,
      mediaInlineThresholdBytes: 100,
    });
    const api = httpApi({
      maxResponseBytes: 200,
      actions: { large_stream: { method: "GET", path: "/large-stream" } },
    });

    try {
      await expect(manager.callTool(api, "large_stream", {})).rejects.toMatchObject({
        code: "DOWNSTREAM_PROTOCOL_ERROR",
      });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("rejects query and header mappings that resolve to non-objects", async () => {
    const manager = new HttpActionManager(registry());
    const badQueryApi = httpApi({ actions: { bad_query: { method: "GET", path: "/ok" } } });
    badQueryApi.actions.bad_query!.query = "$input.query" as never;

    await expect(
      manager.callTool(badQueryApi, "bad_query", { query: "not-an-object" }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    const badHeadersApi = httpApi({ actions: { bad_headers: { method: "GET", path: "/ok" } } });
    badHeadersApi.actions.bad_headers!.headers = "$input.headers" as never;

    await expect(
      manager.callTool(badHeadersApi, "bad_headers", { headers: ["not", "an", "object"] }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects JSON body mappings that resolve to undefined", async () => {
    const manager = new HttpActionManager(registry());
    const api = httpApi({
      actions: { create: { method: "POST", path: "/ok", jsonBody: "$input.missing" } },
    });

    await expect(manager.callTool(api, "create", {})).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "HTTP action jsonBody must not resolve to undefined",
    });
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
    const encodedEscapeApi = httpApi({
      baseUrl: `${baseUrl}/api/v1`,
      actions: { escape: { method: "GET", path: "/ok" } },
    });
    encodedEscapeApi.actions.escape!.path = "/%2e%2e/admin";
    await expect(manager.callTool(encodedEscapeApi, "escape", {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const encodedSlashApi = httpApi({ actions: { escape: { method: "GET", path: "/ok" } } });
    encodedSlashApi.actions.escape!.path = "/safe%2Fescape";
    await expect(manager.callTool(encodedSlashApi, "escape", {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const forbiddenHeaderApi = httpApi({ actions: { bad: { method: "GET", path: "/ok" } } });
    forbiddenHeaderApi.actions.bad!.headers = { authorization: "x" } as never;
    await expect(manager.callTool(forbiddenHeaderApi, "bad", {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const dynamicHeaderApi = httpApi({ actions: { bad_dynamic: { method: "GET", path: "/ok" } } });
    dynamicHeaderApi.actions.bad_dynamic!.headers = "$input.headers" as never;
    await expect(
      manager.callTool(dynamicHeaderApi, "bad_dynamic", {
        headers: { "proxy-authorization": "Bearer attacker" },
      }),
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

function localArtifactPath(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "structuredContent" in result &&
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    "kind" in result.structuredContent &&
    result.structuredContent.kind === "local-artifact" &&
    "path" in result.structuredContent &&
    typeof result.structuredContent.path === "string"
  ) {
    return result.structuredContent.path;
  }
  throw new Error("expected a local artifact result");
}
