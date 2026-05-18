import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphQLManager, type GraphqlEndpointConfig } from "../src/graphql";
import { ServerRegistry } from "../src/registry";

describe("GraphQLManager", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;
  const requests: Array<{ url?: string; method?: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.url === "/schema.graphql") {
          response.setHeader("content-type", "text/plain");
          response.end(schemaSdl);
          return;
        }
        if (request.url === "/redirect-schema.graphql") {
          response.statusCode = 302;
          response.setHeader("location", "/schema.graphql");
          response.end();
          return;
        }
        if (request.url === "/large-schema.graphql") {
          response.end("x".repeat(2 * 1024 * 1024));
          return;
        }
        if (request.url === "/slow-schema.graphql") {
          setTimeout(() => {
            response.setHeader("content-type", "text/plain");
            response.end(schemaSdl);
          }, 100);
          return;
        }
        if (request.url === "/graphql") {
          requests.push({
            ...(request.url ? { url: request.url } : {}),
            ...(request.method ? { method: request.method } : {}),
            body,
          });
          const payload = JSON.parse(body) as {
            query: string;
            variables?: Record<string, unknown>;
            operationName?: string;
          };
          response.setHeader("content-type", "application/json");
          if (payload.variables?.id === "missing") {
            response.end(JSON.stringify({ errors: [{ message: "not found" }] }));
            return;
          }
          if (payload.variables?.id === "unauthorized") {
            response.statusCode = 401;
            response.statusMessage = "Unauthorized";
            response.setHeader(
              "www-authenticate",
              'Bearer error="invalid_token", access_token="secret-token"',
            );
            response.end(JSON.stringify({ error: "secret-token" }));
            return;
          }
          if (payload.query.includes("updateUser")) {
            response.end(JSON.stringify({ data: { updateUser: { id: payload.variables?.id } } }));
            return;
          }
          response.end(
            JSON.stringify({
              data: {
                user: {
                  __typename: "User",
                  id: payload.variables?.id,
                  name: "Ada",
                  profile: { __typename: "Profile", bio: "math" },
                },
              },
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end("not found");
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

  it("validates configured documents and executes POST with variables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-graphql-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(schemaPath, schemaSdl);
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({
      schemaPath,
      endpointUrl: `${baseUrl}/graphql`,
      operations: {
        get_user: {
          document: "query GetUser($id: ID!) { user(id: $id) { id name } }",
          operationName: "GetUser",
          description: "Fetch one user.",
        },
      },
    });

    try {
      const tools = await manager.listTools(endpoint);
      expect(tools).toMatchObject([
        {
          name: "get_user",
          description: "Fetch one user.",
          annotations: { readOnlyHint: true, destructiveHint: false },
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      ]);

      const result = await manager.callTool(endpoint, "get_user", { id: "42" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        status: 200,
        body: { data: { user: { id: "42", name: "Ada" } } },
      });
      expect(JSON.parse(requests.at(-1)!.body)).toEqual({
        query: "query GetUser($id: ID!) { user(id: $id) { id name } }",
        variables: { id: "42" },
        operationName: "GetUser",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-generates query and mutation tools with bounded scalar selections", async () => {
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
      operations: {},
    });

    const tools = await manager.listTools(endpoint);
    expect(tools.map((tool) => tool.name)).toEqual(["mutation_updateUser", "query_user"]);
    expect(tools.find((tool) => tool.name === "query_user")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    });
    expect(tools.find((tool) => tool.name === "mutation_updateUser")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });

    const result = await manager.callTool(endpoint, "query_user", { id: "42" });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(requests.at(-1)!.body) as { query: string; variables: unknown };
    expect(payload.variables).toEqual({ id: "42" });
    expect(payload.query).toContain("query query_user");
    expect(payload.query).toContain("__typename");
    expect(payload.query).toContain("profile {");
    expect(payload.query).toContain("bio");
    expect(payload.query).not.toContain("posts(");
  });

  it("marks GraphQL errors as tool errors without throwing", async () => {
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
    });

    const result = await manager.callTool(endpoint, "query_user", { id: "missing" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 200,
      body: { errors: [{ message: "not found" }] },
    });
  });

  it("redacts GraphQL auth failures without returning downstream error bodies", async () => {
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
    });

    await expect(
      manager.callTool(endpoint, "query_user", { id: "unauthorized" }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: {
        server: "users",
        status: 401,
        authType: "none",
        challenge: "[REDACTED]",
      },
    });
  });

  it("does not send endpoint auth headers to cross-origin schema URLs", async () => {
    let schemaAuthorization: string | undefined;
    const schemaServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      schemaAuthorization = request.headers.authorization;
      response.setHeader("content-type", "text/plain");
      response.end(schemaSdl);
    });
    try {
      await new Promise<void>((resolve) => schemaServer.listen(0, "127.0.0.1", resolve));
      const address = schemaServer.address();
      if (!address || typeof address === "string") {
        throw new Error("schema test server did not bind");
      }
      const manager = new GraphQLManager(registry());

      await manager.listTools(
        graphqlEndpoint({
          schemaUrl: `http://127.0.0.1:${address.port}/schema.graphql`,
          endpointUrl: `${baseUrl}/graphql`,
          auth: { type: "bearer", token: "secret-graphql-token" },
        }),
      );

      expect(schemaAuthorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => schemaServer.close(() => resolve()));
    }
  });

  it("times out slow remote schema loading", async () => {
    const manager = new GraphQLManager(registry());

    await expect(
      manager.listTools(
        graphqlEndpoint({
          schemaUrl: `${baseUrl}/slow-schema.graphql`,
          endpointUrl: `${baseUrl}/graphql`,
          requestTimeoutMs: 5,
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_CALL_TIMEOUT" });
  });

  it("rejects invalid configured documents and unsafe remote schema URLs", async () => {
    const manager = new GraphQLManager(registry());
    await expect(
      manager.listTools(
        graphqlEndpoint({
          schemaUrl: `${baseUrl}/schema.graphql`,
          endpointUrl: `${baseUrl}/graphql`,
          operations: {
            bad: { document: "query Bad { missingField }" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await expect(
      manager.listTools(
        graphqlEndpoint({
          schemaUrl: "http://example.com/schema.graphql",
          endpointUrl: `${baseUrl}/graphql`,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await expect(
      manager.listTools(
        graphqlEndpoint({
          schemaUrl: `${baseUrl}/redirect-schema.graphql`,
          endpointUrl: `${baseUrl}/graphql`,
        }),
      ),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
  });

  it("invalidates cached operations for one endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-graphql-invalidate-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(
      schemaPath,
      `
        type Query {
          first: String
        }
      `,
    );
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({
      schemaPath,
      operationCacheTtlMs: 30_000,
    });

    try {
      expect((await manager.listTools(endpoint)).map((tool) => tool.name)).toEqual(["query_first"]);

      writeFileSync(
        schemaPath,
        `
          type Query {
            second: String
          }
        `,
      );
      expect((await manager.listTools(endpoint)).map((tool) => tool.name)).toEqual(["query_first"]);

      manager.invalidate("users");

      expect((await manager.listTools(endpoint)).map((tool) => tool.name)).toEqual([
        "query_second",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const schemaSdl = `
  type Query {
    user(id: ID!): User!
  }

  type Mutation {
    updateUser(id: ID!, name: String!): User!
  }

  type User {
    id: ID!
    name: String!
    profile: Profile
    posts(limit: Int): [Post!]!
  }

  type Profile {
    bio: String
  }

  type Post {
    id: ID!
    title: String!
  }
`;

function graphqlEndpoint(overrides: Partial<GraphqlEndpointConfig> = {}): GraphqlEndpointConfig {
  return {
    server: "users",
    backend: "graphql",
    name: "Users GraphQL",
    description: "Manage users through the internal GraphQL API.",
    endpointUrl: "http://127.0.0.1/graphql",
    auth: { type: "none" },
    requestTimeoutMs: 60000,
    operationCacheTtlMs: 0,
    disabled: false,
    selectionDepth: 2,
    ...overrides,
  };
}

function registry(): ServerRegistry {
  return {
    setStatus: () => {},
  } as unknown as ServerRegistry;
}
