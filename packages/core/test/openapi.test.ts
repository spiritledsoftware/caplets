import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { ServerRegistry } from "../src/registry";
import { DownstreamManager } from "../src/downstream";
import { OpenApiManager } from "../src/openapi";
import { handleServerTool } from "../src/tools";
import { writeTokenBundle } from "../src/auth";
import { testBackendOperationRuntime } from "./backend-operation-runtime";

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
        if (request.url === "/scalar-openapi.json") {
          response.setHeader("content-type", "application/json");
          response.end("42");
          return;
        }
        if (request.url === "/openapi.yaml") {
          response.setHeader("content-type", "application/yaml");
          response.end(openApiYamlSpec(baseUrl));
          return;
        }
        if (request.url === "/scalar-openapi.yaml") {
          response.setHeader("content-type", "application/yaml");
          response.end("not-an-openapi-object");
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
          response.end(JSON.stringify({ id: "42", active: true, name: "Ada" }));
          return;
        }
        if (request.url?.startsWith("/users/large?active=true")) {
          response.end(
            JSON.stringify({ id: "large", name: "Ada", padding: "x".repeat(1024 * 1024) }),
          );
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
        if (request.url === "/schema-less") {
          response.end(JSON.stringify({ public: "ok", secret: "hidden" }));
          return;
        }
        if (request.url === "/reports/large") {
          const bytes = Buffer.alloc(1024 * 1024 + 1, "x");
          response.setHeader("content-type", "application/pdf");
          response.setHeader("content-length", String(bytes.byteLength));
          response.end(bytes);
          return;
        }
        if (request.url === "/reports/42" && request.method === "HEAD") {
          response.setHeader("content-type", "application/pdf");
          response.setHeader("content-length", String(1024 * 1024 + 1));
          response.end();
          return;
        }
        if (request.url === "/reports/42") {
          response.setHeader("content-type", "application/pdf");
          response.end(Buffer.from("%PDF-1.7 test"));
          return;
        }
        if (request.url === "/protected") {
          response.statusCode = 401;
          response.statusMessage = "Unauthorized";
          response.setHeader(
            "www-authenticate",
            'Bearer error="invalid_token", access_token="secret-openapi-token"',
          );
          response.end(JSON.stringify({ error: "secret-openapi-token" }));
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
      id: "users",
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
        { operation: "tools" },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
      )) as any;
      expect(
        list.structuredContent.result.items.map((tool: { name: string }) => tool.name),
      ).toEqual(["createUser", "GET /users/{id}", "getReport", "headReport"]);
      expect(
        list.structuredContent.result.items.find(
          (candidate: { name: string }) => candidate.name === "GET /users/{id}",
        ),
      ).toMatchObject({
        hasOutputSchema: true,
        readOnlyHint: true,
        destructiveHint: false,
      });

      const tool = (await handleServerTool(
        caplet,
        { operation: "describe_tool", name: "GET /users/{id}" },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
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
      expect(tool.structuredContent.result.tool.outputSchema).toMatchObject({
        type: "object",
        required: ["status", "statusText", "headers", "kind"],
        properties: {
          status: { type: "number" },
          statusText: { type: "string" },
          headers: {
            type: "object",
            required: ["content-type"],
            properties: { "content-type": { type: "string" } },
          },
          body: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          kind: { enum: ["inline", "local-artifact", "remote-reference"] },
          uri: { type: "string" },
          path: { type: "string" },
        },
        oneOf: expect.any(Array),
      });

      const result = (await handleServerTool(
        caplet,
        {
          operation: "call_tool",
          name: "GET /users/{id}",
          args: { path: { id: "42" }, query: { active: true } },
        },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
      )) as any;
      expect(result.structuredContent).toMatchObject({
        status: 200,
        body: { id: "42", active: true, name: "Ada" },
      });

      const projected = (await handleServerTool(
        caplet,
        {
          operation: "call_tool",
          name: "GET /users/{id}",
          args: { path: { id: "42" }, query: { active: true } },
          fields: ["body.name"],
        },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
      )) as any;
      expect(projected.structuredContent).toEqual({ body: { name: "Ada" } });

      const create = (await handleServerTool(
        caplet,
        {
          operation: "call_tool",
          name: "createUser",
          args: { body: { name: "Ada" } },
        },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
      )) as any;
      expect(create.structuredContent).toMatchObject({
        status: 201,
        body: { created: "Ada" },
      });
      await expect(
        handleServerTool(
          caplet,
          {
            operation: "call_tool",
            name: "createUser",
            args: { body: { name: "Ada" } },
            fields: ["body.created"],
          },
          registry,
          testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
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

  it("sends safe static header defaults from OpenAPI parameters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-header-default-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(headerDefaultSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        simple: {
          name: "Simple API",
          description: "Exercise static header defaults.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);

    try {
      const tool = await openapi.getTool(config.openapiEndpoints.simple!, "getSimple");
      const inputProperties = tool.inputSchema.properties as Record<string, unknown>;
      const header = inputProperties.header as { properties: Record<string, unknown> };
      expect(header).toMatchObject({
        properties: { "x-trace-id": { type: "string" } },
      });
      expect(header.properties).not.toHaveProperty("Accept");

      requests.length = 0;
      await openapi.callTool(config.openapiEndpoints.simple!, "getSimple", {});

      expect(requests.at(-1)?.headers.accept).toBe("application/vnd.pypi.simple.v1+json");

      await openapi.callTool(config.openapiEndpoints.simple!, "getSimple", {
        header: { "x-trace-id": "trace-1" },
      });

      expect(requests.at(-1)?.headers["x-trace-id"]).toBe("trace-1");
      expect(requests.at(-1)?.headers.accept).toBe("application/vnd.pypi.simple.v1+json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects argument-supplied Accept headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-accept-argument-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(headerDefaultSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        simple: {
          name: "Simple API",
          description: "Exercise protected Accept handling.",
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
        openapi.callTool(config.openapiEndpoints.simple!, "getSimple", {
          header: { Accept: "application/json" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
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

  it("does not synthesize output schemas for JSON responses without actual schemas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-schema-less-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Schema-less API", version: "1.0.0" },
        servers: [{ url: baseUrl }],
        paths: {
          "/schema-less": {
            get: {
              operationId: "schemaLess",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {},
                  },
                },
              },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        schemaLess: {
          name: "Schema-less API",
          description: "Exercise JSON responses without schemas.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const caplet = config.openapiEndpoints.schemaLess!;
    const openapi = new OpenApiManager(registry);
    const downstream = new DownstreamManager(registry);

    try {
      const tool = (await handleServerTool(
        caplet,
        { operation: "describe_tool", name: "schemaLess" },
        registry,
        testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
      )) as any;
      expect(tool.structuredContent.result.tool.outputSchema).toBeUndefined();

      requests.length = 0;
      await expect(
        handleServerTool(
          caplet,
          { operation: "call_tool", name: "schemaLess", args: {}, fields: ["body"] },
          registry,
          testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(requests.some((request) => request.url === "/schema-less")).toBe(false);
    } finally {
      await downstream.close();
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

    await expect(openapi.listTools(remote)).resolves.toHaveLength(4);
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

  it("loads remote YAML specs from specUrl", async () => {
    const registry = new ServerRegistry(
      parseConfig({
        openapiEndpoints: {
          remoteYaml: {
            name: "Remote YAML API",
            description: "Exercise remote OpenAPI YAML spec loading.",
            specUrl: `${baseUrl}/openapi.yaml`,
            baseUrl,
            auth: { type: "none" },
          },
        },
      }),
    );
    const openapi = new OpenApiManager(registry);

    await expect(openapi.listTools(registry.config.openapiEndpoints.remoteYaml!)).resolves.toEqual([
      expect.objectContaining({ name: "listUsers" }),
    ]);
  });

  it("reports non-object remote YAML specs clearly", async () => {
    const registry = new ServerRegistry(
      parseConfig({
        openapiEndpoints: {
          scalarYaml: {
            name: "Scalar YAML API",
            description: "Exercise remote OpenAPI YAML validation diagnostics.",
            specUrl: `${baseUrl}/scalar-openapi.yaml`,
            baseUrl,
            auth: { type: "none" },
          },
        },
      }),
    );
    const openapi = new OpenApiManager(registry);

    await expect(
      openapi.listTools(registry.config.openapiEndpoints.scalarYaml!),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
      details: expect.objectContaining({
        message: "OpenAPI source must parse to an object",
      }),
    });
  });

  it("reports non-object remote JSON specs clearly", async () => {
    const registry = new ServerRegistry(
      parseConfig({
        openapiEndpoints: {
          scalarJson: {
            name: "Scalar JSON API",
            description: "Exercise remote OpenAPI JSON validation diagnostics.",
            specUrl: `${baseUrl}/scalar-openapi.json`,
            baseUrl,
            auth: { type: "none" },
          },
        },
      }),
    );
    const openapi = new OpenApiManager(registry);

    await expect(
      openapi.listTools(registry.config.openapiEndpoints.scalarJson!),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
      details: expect.objectContaining({
        message: "OpenAPI source must parse to an object",
      }),
    });
  });

  it("applies stored OAuth tokens to remote specs and OpenAPI requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-auth-"));
    const authDir = join(dir, "auth");
    try {
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "secret-openapi-access-token",
          authType: "oauth2",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
          clientId: "client",
          protectedResourceOrigin: baseUrl,
        },
        authDir,
      );
      requests.length = 0;
      const endpoint = {
        server: "remote",
        backend: "openapi" as const,
        name: "Remote API",
        description: "Exercise OAuth auth for OpenAPI.",
        specUrl: `${baseUrl}/openapi.json`,
        baseUrl,
        auth: { type: "oauth2" as const, clientId: "client" },
        requestTimeoutMs: 1000,
        operationCacheTtlMs: 0,
        disabled: false,
      };
      const registry = new ServerRegistry({
        version: 1,
        options: {
          defaultSearchLimit: 20,
          maxSearchLimit: 50,
          exposure: "progressive_and_code_mode",
          exposureDiscoveryTimeoutMs: 15000,
          exposureDiscoveryConcurrency: 4,
          completion: {
            discoveryTimeoutMs: 750,
            overallTimeoutMs: 1500,
            cacheTtlMs: 300_000,
            negativeCacheTtlMs: 30_000,
          },
        },
        namespaceAliases: { upstreams: {} },
        mcpServers: {},
        openapiEndpoints: { remote: endpoint },
        googleDiscoveryApis: {},
        graphqlEndpoints: {},
        httpApis: {},
        cliTools: {},
        capletSets: {},
      });
      const openapi = new OpenApiManager(registry, { authDir });

      await openapi.listTools(endpoint);
      await openapi.callTool(endpoint, "GET /users/{id}", {
        path: { id: "42" },
        query: { active: true },
      });

      expect(
        requests.some(
          (request) => request.headers.authorization === "Bearer secret-openapi-access-token",
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts OpenAPI auth failures without returning downstream error bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-auth-failure-"));
    const authDir = join(dir, "auth");
    const specPath = join(dir, "openapi.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Protected API", version: "1.0.0" },
        servers: [{ url: baseUrl }],
        paths: {
          "/protected": {
            get: {
              operationId: "protected",
              responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
            },
          },
        },
      }),
    );
    const config = parseConfig({
      openapiEndpoints: {
        protectedApi: {
          name: "Protected API",
          description: "Exercise protected OpenAPI failure handling.",
          specPath,
          baseUrl,
          auth: { type: "oauth2", clientId: "client" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    writeTokenBundle(
      {
        server: "protectedApi",
        accessToken: "expired-downstream-token",
        authType: "oauth2",
        tokenType: "Bearer",
        expiresAt: "2999-01-01T00:00:00.000Z",
        clientId: "client",
        protectedResourceOrigin: baseUrl,
      },
      authDir,
    );
    const openapi = new OpenApiManager(registry, { authDir });

    try {
      await expect(
        openapi.callTool(config.openapiEndpoints.protectedApi!, "protected", {}),
      ).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        details: {
          server: "protectedApi",
          status: 401,
          authType: "oauth2",
          challenge: "[REDACTED]",
          nextAction: "run_caplets_auth_login",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates cached operations for one endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-invalidate-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(singleOperationSpec("first")));
    const config = parseConfig({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);
    const endpoint = config.openapiEndpoints.users!;

    try {
      expect((await openapi.listTools(endpoint)).map((tool) => tool.name)).toEqual(["first"]);

      writeFileSync(specPath, JSON.stringify(singleOperationSpec("second")));
      expect((await openapi.listTools(endpoint)).map((tool) => tool.name)).toEqual(["first"]);

      openapi.invalidate("users");

      expect((await openapi.listTools(endpoint)).map((tool) => tool.name)).toEqual(["second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes binary OpenAPI responses as media artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-artifacts-"));
    const specPath = join(dir, "openapi.json");
    const artifactDir = join(dir, "artifacts");
    writeFileSync(specPath, JSON.stringify(openApiSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        reports: {
          name: "Reports API",
          description: "Download reports from the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry, { artifactDir });

    try {
      const result = await openapi.callTool(config.openapiEndpoints.reports!, "getReport", {
        path: { id: "42" },
      });

      expect(result.structuredContent).toMatchObject({
        status: 200,
        headers: { "content-type": "application/pdf" },
        kind: "local-artifact",
        mimeType: "application/pdf",
        byteLength: 13,
      });
      expect(readFileSync(localArtifactPath(result), "utf8")).toBe("%PDF-1.7 test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes large OpenAPI responses as media artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-large-artifacts-"));
    const specPath = join(dir, "openapi.json");
    const artifactDir = join(dir, "artifacts");
    writeFileSync(specPath, JSON.stringify(openApiSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        reports: {
          name: "Reports API",
          description: "Download reports from the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry, { artifactDir });

    try {
      const result = await openapi.callTool(config.openapiEndpoints.reports!, "getReport", {
        path: { id: "large" },
      });

      expect(result.structuredContent).toMatchObject({
        status: 200,
        kind: "local-artifact",
        mimeType: "application/pdf",
        byteLength: 1024 * 1024 + 1,
      });
      expect(readFileSync(localArtifactPath(result)).byteLength).toBe(1024 * 1024 + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects field projection when OpenAPI JSON responses become artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-large-json-fields-"));
    const specPath = join(dir, "openapi.json");
    const artifactDir = join(dir, "artifacts");
    writeFileSync(specPath, JSON.stringify(openApiSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const caplet = config.openapiEndpoints.users!;
    const openapi = new OpenApiManager(registry, { artifactDir });
    const downstream = new DownstreamManager(registry);

    try {
      await expect(
        handleServerTool(
          caplet,
          {
            operation: "call_tool",
            name: "GET /users/{id}",
            args: { path: { id: "large" }, query: { active: true } },
            fields: ["body.name"],
          },
          registry,
          testBackendOperationRuntime(registry, { mcp: downstream, openapi }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reject OpenAPI HEAD responses by content length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-openapi-head-"));
    const specPath = join(dir, "openapi.json");
    writeFileSync(specPath, JSON.stringify(openApiSpec(baseUrl)));
    const config = parseConfig({
      openapiEndpoints: {
        reports: {
          name: "Reports API",
          description: "Download reports from the internal HTTP API.",
          specPath,
          baseUrl,
          auth: { type: "none" },
        },
      },
    });
    const registry = new ServerRegistry(config);
    const openapi = new OpenApiManager(registry);

    try {
      const result = await openapi.callTool(config.openapiEndpoints.reports!, "headReport", {
        path: { id: "42" },
      });

      expect(result.structuredContent).toMatchObject({
        status: 200,
        headers: {
          "content-type": "application/pdf",
        },
      });
      expect(result.structuredContent).not.toHaveProperty("body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                      id: { type: "string" },
                      active: { type: "boolean" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
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
      "/reports/{id}": {
        get: {
          operationId: "getReport",
          summary: "Download a report",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/pdf": {},
              },
            },
          },
        },
        head: {
          operationId: "headReport",
          summary: "Inspect a report",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/pdf": {},
              },
            },
          },
        },
      },
    },
  };
}

function openApiYamlSpec(baseUrl: string) {
  return [
    'openapi: "3.0.3"',
    "info:",
    "  title: Remote YAML API",
    '  version: "1.0.0"',
    "servers:",
    `  - url: ${baseUrl}`,
    "paths:",
    "  /users:",
    "    get:",
    "      operationId: listUsers",
    "      responses:",
    '        "200":',
    "          description: OK",
    "",
  ].join("\n");
}

function singleOperationSpec(operationId: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Users API", version: "1.0.0" },
    paths: {
      "/users": {
        get: {
          operationId,
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
}

function headerDefaultSpec(baseUrl: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Simple API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/simple/project/": {
        get: {
          operationId: "getSimple",
          parameters: [
            {
              name: "Accept",
              in: "header",
              schema: { type: "string", default: "application/vnd.pypi.simple.v1+json" },
            },
            {
              name: "x-trace-id",
              in: "header",
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
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
