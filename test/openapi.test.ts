import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { ServerRegistry } from "../src/registry.js";
import { DownstreamManager } from "../src/downstream.js";
import { OpenApiManager } from "../src/openapi.js";
import { handleServerTool } from "../src/tools.js";

describe("native OpenAPI Caplets", () => {
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
        if (request.url === "/slow-openapi.json") {
          setTimeout(() => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(openApiSpec(baseUrl)));
          }, 100);
          return;
        }
        if (request.url === "/large-openapi.json") {
          response.setHeader("content-type", "application/json");
          response.end("x".repeat(2 * 1024 * 1024));
          return;
        }
        if (request.url === "/redirect-openapi.json") {
          response.statusCode = 302;
          response.setHeader("location", "/openapi.json");
          response.end();
          return;
        }
        if (request.url === "/openapi.json") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(openApiSpec(baseUrl)));
          return;
        }
        requests.push({
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
          headers: request.headers,
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/users/42?active=true")) {
          response.end(JSON.stringify({ id: "42", active: true }));
          return;
        }
        if (request.url?.startsWith("/api/v1/users/42?active=true")) {
          response.end(JSON.stringify({ id: "42", active: true, prefixed: true }));
          return;
        }
        if (request.url === "/users" && request.method === "POST") {
          response.statusCode = 201;
          response.end(JSON.stringify({ created: JSON.parse(body).name }));
          return;
        }
        if (request.url === "/invalid-json") {
          response.end("{not json");
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
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

  it("loads OpenAPI endpoints from config and exposes safe Caplet detail", () => {
    const config = parseConfig({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/users-openapi.json",
          baseUrl,
          auth: { type: "bearer", token: "secret-token" },
        },
      },
    });
    const registry = new ServerRegistry(config);

    expect(registry.enabledServers().map((caplet) => caplet.server)).toEqual(["users"]);
    expect(config.openapiEndpoints.users?.backend).toBe("openapi");
    expect(registry.detail(config.openapiEndpoints.users!)).toEqual({
      caplet: "users",
      name: "Users API",
      description: "Manage users through the internal HTTP API.",
      backend: {
        type: "openapi",
        disabled: false,
        requestTimeoutMs: 60000,
        operationCacheTtlMs: 30000,
        source: "specPath",
      },
    });
    expect(JSON.stringify(registry.detail(config.openapiEndpoints.users!))).not.toContain(
      "secret-token",
    );
  });

  it("lists, inspects, and calls OpenAPI operations through generated Caplet operations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(openApiSpec(baseUrl)));
    process.env.CAPLETS_TEST_API_KEY = "secret-key";
    const config = parseConfig({
      defaultSearchLimit: 10,
      maxSearchLimit: 20,
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "headers", headers: { "x-api-key": "$env:CAPLETS_TEST_API_KEY" } },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const caplet = config.openapiEndpoints.users!;
    const openapi = new OpenApiManager(registry);
    const downstream = new DownstreamManager(registry);

    try {
      const list = (await handleServerTool(
        caplet,
        { operation: "list_tools" },
        registry,
        downstream,
        openapi,
      )) as any;
      expect(
        list.structuredContent.result.tools.map((tool: { tool: string }) => tool.tool),
      ).toEqual(["createUser", "GET /users/{id}"]);

      const tool = (await handleServerTool(
        caplet,
        { operation: "get_tool", tool: "GET /users/{id}" },
        registry,
        downstream,
        openapi,
      )) as any;
      expect(tool.structuredContent.result.tool.inputSchema).toMatchObject({
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "object",
            required: ["id"],
          },
          query: {
            type: "object",
          },
        },
      });

      const result = (await handleServerTool(
        caplet,
        {
          operation: "call_tool",
          tool: "GET /users/{id}",
          arguments: { path: { id: "42" }, query: { active: true } },
        },
        registry,
        downstream,
        openapi,
      )) as any;
      expect(result.structuredContent).toMatchObject({
        status: 200,
        body: { id: "42", active: true },
      });

      const create = (await handleServerTool(
        caplet,
        {
          operation: "call_tool",
          tool: "createUser",
          arguments: { body: { name: "Ada" } },
        },
        registry,
        downstream,
        openapi,
      )) as any;
      expect(create.structuredContent).toMatchObject({
        status: 201,
        body: { created: "Ada" },
      });
      expect(requests.some((request) => request.headers["x-api-key"] === "secret-key")).toBe(true);

      await expect(
        openapi.callTool(caplet, "GET /users/{id}", {
          path: { id: "42" },
          header: { "x-api-key": "attacker-key" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      await expect(
        openapi.callTool(caplet, "GET /users/{id}", {
          path: { id: "42" },
          header: { authorization: "Bearer attacker" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      await expect(
        openapi.callTool(caplet, "GET /users/{id}", {
          path: { id: "42" },
          query: { active: { nested: true } },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      requests.length = 0;
      const prefixedConfig = parseConfig({
        openapiEndpoints: {
          prefixed: {
            name: "Prefixed API",
            description: "Exercise base URL path preservation.",
            specPath,
            baseUrl: `${baseUrl}/api/v1`,
            auth: { type: "none" },
          },
        },
      });
      const prefixedResult = await openapi.callTool(
        prefixedConfig.openapiEndpoints.prefixed!,
        "GET /users/{id}",
        { path: { id: "42" }, query: { active: true } },
      );
      expect(prefixedResult.structuredContent).toMatchObject({
        status: 200,
        body: { prefixed: true },
      });
      expect(requests.at(-1)?.url).toBe("/api/v1/users/42?active=true");
    } finally {
      await downstream.close();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.CAPLETS_TEST_API_KEY;
    }
  });

  it("does not dereference external files from OpenAPI specs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-ref-"));
    const specPath = join(dir, "openapi.json");
    const secretPath = join(dir, "secret.json");
    writeFileSync(
      secretPath,
      JSON.stringify({ type: "object", properties: { secret: { const: "leak" } } }),
    );
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Ref API", version: "1.0.0" },
        servers: [{ url: baseUrl }],
        paths: {
          "/ref": {
            post: {
              operationId: "refLeak",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: secretPath },
                  },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        ref: {
          name: "Ref API",
          description: "Exercise external reference blocking.",
          specPath,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);

    try {
      await expect(openapi.listTools(config.openapiEndpoints.ref!)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports OpenAPI check unavailable when base URL is not executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-base-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "No Server API", version: "1.0.0" },
        paths: {
          "/users": {
            get: {
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        noServer: {
          name: "No Server API",
          description: "Exercise missing server handling.",
          specPath,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const status = await new OpenApiManager(registry).checkEndpoint(
      config.openapiEndpoints.noServer!,
    );

    expect(status.status).toBe("unavailable");
    expect(status.error).toMatchObject({ code: "CONFIG_INVALID" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects operation paths that escape the configured base URL origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-origin-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Origin API", version: "1.0.0" },
        paths: {
          "//evil.example/users": {
            get: {
              operationId: "escapeOrigin",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        origin: {
          name: "Origin API",
          description: "Exercise operation URL origin checks.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);

    try {
      await expect(
        openapi.callTool(config.openapiEndpoints.origin!, "escapeOrigin", {}),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(
        openapi.callTool(
          { ...config.openapiEndpoints.origin!, baseUrl: `${baseUrl}?token=secret` },
          "escapeOrigin",
          {},
        ),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to text when a JSON response body cannot be parsed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-invalid-json-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Invalid JSON API", version: "1.0.0" },
        paths: {
          "/invalid-json": {
            get: {
              operationId: "invalidJson",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        invalidJson: {
          name: "Invalid JSON API",
          description: "Exercise invalid JSON response fallback.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);

    try {
      const result = await openapi.callTool(
        config.openapiEndpoints.invalidJson!,
        "invalidJson",
        {},
      );
      expect(result.structuredContent).toMatchObject({ status: 200, body: "{not json" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads remote specs with timeout, redirect, and size controls", async () => {
    const registry = new ServerRegistry(
      parseConfig({
        openapiEndpoints: {
          remote: {
            name: "Remote API",
            description: "Exercise remote OpenAPI spec loading.",
            specUrl: `${baseUrl}/openapi.json`,
            baseUrl,
            requestTimeoutMs: 50,
            auth: { type: "none" },
          },
        },
      }),
    );
    const openapi = new OpenApiManager(registry);
    const remote = registry.config.openapiEndpoints.remote!;

    await expect(openapi.listTools(remote)).resolves.toHaveLength(2);
    await expect(
      openapi.listTools({ ...remote, specUrl: `${baseUrl}/slow-openapi.json` }),
    ).rejects.toMatchObject({ code: "TOOL_CALL_TIMEOUT" });
    await expect(
      openapi.listTools({ ...remote, specUrl: `${baseUrl}/redirect-openapi.json` }),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
    await expect(
      openapi.listTools({ ...remote, specUrl: `${baseUrl}/large-openapi.json` }),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
  });
});

function openApiSpec(baseUrl: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Users API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/users/{id}": {
        get: {
          summary: "Read a user",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "active",
              in: "query",
              schema: { type: "boolean" },
            },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/users": {
        post: {
          operationId: "createUser",
          summary: "Create a user",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
    },
  };
}
