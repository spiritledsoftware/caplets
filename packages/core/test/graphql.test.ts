import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
  type PathLike,
} from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphQLManager, type GraphqlEndpointConfig } from "../src/graphql";
import { MEDIA_ARTIFACT_MAX_BYTES } from "../src/media/results";
import { ServerRegistry } from "../src/registry";
import {
  createMediaArtifactWriter,
  resolveMediaArtifact,
  writeMediaArtifact,
} from "../src/media/artifacts";

const mediaArtifactFailure = vi.hoisted(() => ({
  metadataPublication: false,
  backupCleanup: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fsPromises = (await importOriginal()) as typeof FsPromises;
  return {
    ...fsPromises,
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      if (
        mediaArtifactFailure.metadataPublication &&
        String(from).endsWith(".partial.caplets.json") &&
        String(to).endsWith("response.bin.caplets.json")
      ) {
        throw new Error("metadata publication failed");
      }
      await fsPromises.rename(from, to);
    },
    rm: async (...args: Parameters<typeof fsPromises.rm>): Promise<void> => {
      if (
        mediaArtifactFailure.backupCleanup &&
        String(args[0]).endsWith(".previous.caplets.json")
      ) {
        throw new Error("backup cleanup failed");
      }
      await fsPromises.rm(...args);
    },
  };
});

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
          if (payload.variables?.id === "large-error") {
            response.end(
              JSON.stringify({
                errors: [{ message: "response too large" }],
                padding: "x".repeat(1024 * 1024),
              }),
            );
            return;
          }
          if (payload.variables?.id === "exact-inline") {
            response.end(graphQlPayload(1024 * 1024));
            return;
          }
          if (payload.variables?.id === "over-inline") {
            response.end(graphQlPayload(1024 * 1024 + 1));
            return;
          }
          if (payload.variables?.id === "advertised-over-cap") {
            response.setHeader("content-length", String(MEDIA_ARTIFACT_MAX_BYTES + 1));
            response.end("x");
            return;
          }
          if (payload.variables?.id === "streamed-over-cap") {
            response.write("x".repeat(9));
            response.end("x".repeat(8));
            return;
          }
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

  it("artifactizes oversized GraphQL errors without losing error classification", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-artifacts-"));
    const manager = new GraphQLManager(registry(), {
      artifactDir,
      exposeLocalArtifactPaths: false,
    });
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
    });

    try {
      const result = await manager.callTool(endpoint, "query_user", { id: "large-error" });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          kind: "remote-reference",
          uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
          filename: "response.bin",
          byteLength: expect.any(Number),
          sha256: expect.any(String),
        },
      });
      expect(result.structuredContent).not.toHaveProperty("path");
      expect(result.structuredContent).not.toHaveProperty("pathResolution");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("streams oversized GraphQL artifacts before the upstream response completes", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-streaming-artifacts-"));
    let releaseResponse: (() => void) | undefined;
    let artifactWatcher: FSWatcher | undefined;
    const partialArtifactCreated = new Promise<void>((resolve) => {
      artifactWatcher = watch(artifactDir, { recursive: true }, (_event, filename) => {
        if (String(filename).endsWith(".partial")) {
          artifactWatcher?.close();
          resolve();
        }
      });
    });
    let markFirstChunkSent: (() => void) | undefined;
    const firstChunkSent = new Promise<void>((resolve) => {
      markFirstChunkSent = resolve;
    });
    const artifactServer = createServer(async (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.write('{"data":{"user":{"id":"42"}},"padding":"');
      response.write("x".repeat(4096));
      markFirstChunkSent?.();
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      response.end('"}');
    });

    try {
      await new Promise<void>((resolve) => artifactServer.listen(0, "127.0.0.1", resolve));
      const address = artifactServer.address();
      if (!address || typeof address === "string") {
        throw new Error("streaming GraphQL test server did not bind");
      }
      const manager = new GraphQLManager(registry(), {
        artifactDir,
        mediaInlineThresholdBytes: 1024,
      });
      const endpoint = graphqlEndpoint({
        schemaUrl: `${baseUrl}/schema.graphql`,
        endpointUrl: `http://127.0.0.1:${address.port}/graphql`,
        requestTimeoutMs: 1000,
      });
      const resultPromise = manager.callTool(endpoint, "query_user", { id: "streaming" });

      await firstChunkSent;
      const observedBeforeUpstreamCompleted = await Promise.race([
        partialArtifactCreated.then(() => "artifact"),
        resultPromise.then(
          () => "result",
          () => "failed",
        ),
      ]);
      expect(observedBeforeUpstreamCompleted).toBe("artifact");
      releaseResponse?.();

      await expect(resultPromise).resolves.toMatchObject({
        isError: false,
        structuredContent: {
          kind: "local-artifact",
          byteLength: expect.any(Number),
          sha256: expect.any(String),
        },
      });
    } finally {
      artifactWatcher?.close();
      releaseResponse?.();
      await new Promise<void>((resolve) => artifactServer.close(() => resolve()));
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("removes partial GraphQL artifacts when the streamed hard cap is exceeded", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-streaming-cap-"));
    const manager = new GraphQLManager(registry(), {
      artifactDir,
      mediaInlineThresholdBytes: 8,
      mediaArtifactMaxBytes: 16,
    });
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
    });

    try {
      await expect(
        manager.callTool(endpoint, "query_user", { id: "streamed-over-cap" }),
      ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
      const artifactFiles = readdirSync(artifactDir, {
        recursive: true,
        withFileTypes: true,
      }).filter((entry) => entry.isFile());
      expect(artifactFiles).toEqual([]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("restores an existing GraphQL artifact when metadata publication fails", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-transaction-"));
    const outputPath = join(artifactDir, "users", "call-1", "response.bin");
    const original = await writeMediaArtifact({
      rootDir: artifactDir,
      capletId: "users",
      callId: "call-1",
      outputPath,
      mimeType: "application/json",
      bytes: Buffer.from("original GraphQL artifact"),
    });
    const originalBytes = readFileSync(outputPath);
    const originalMetadata = readFileSync(`${outputPath}.caplets.json`);
    mediaArtifactFailure.metadataPublication = true;

    try {
      await expect(
        writeMediaArtifact({
          rootDir: artifactDir,
          capletId: "users",
          callId: "call-1",
          outputPath,
          mimeType: "application/json",
          bytes: Buffer.from("replacement GraphQL artifact"),
        }),
      ).rejects.toThrow("metadata publication failed");
      expect(readFileSync(outputPath)).toEqual(originalBytes);
      expect(readFileSync(`${outputPath}.caplets.json`)).toEqual(originalMetadata);
      expect(
        readdirSync(artifactDir, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(["response.bin", "response.bin.caplets.json"]);
      expect(original.path).toBe(outputPath);
    } finally {
      mediaArtifactFailure.metadataPublication = false;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("keeps a published GraphQL artifact when backup cleanup fails", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-cleanup-"));
    const outputPath = join(artifactDir, "users", "call-1", "response.bin");
    await writeMediaArtifact({
      rootDir: artifactDir,
      capletId: "users",
      callId: "call-1",
      outputPath,
      mimeType: "application/json",
      bytes: Buffer.from("original GraphQL artifact"),
    });
    mediaArtifactFailure.backupCleanup = true;

    try {
      await expect(
        writeMediaArtifact({
          rootDir: artifactDir,
          capletId: "users",
          callId: "call-1",
          outputPath,
          mimeType: "application/json",
          bytes: Buffer.from("replacement GraphQL artifact"),
        }),
      ).rejects.toMatchObject({ code: "DOWNSTREAM_TOOL_ERROR" });
      expect(readFileSync(outputPath)).toEqual(Buffer.from("replacement GraphQL artifact"));
      expect(readFileSync(`${outputPath}.caplets.json`, "utf8")).toContain("application/json");
      mediaArtifactFailure.backupCleanup = false;
      await writeMediaArtifact({
        rootDir: artifactDir,
        capletId: "users",
        callId: "call-1",
        outputPath,
        mimeType: "text/plain",
        bytes: Buffer.from("cleanup retry GraphQL artifact"),
      });
      expect(
        readdirSync(artifactDir, { recursive: true, withFileTypes: true }).filter((entry) =>
          entry.name.includes(".previous"),
        ),
      ).toEqual([]);
    } finally {
      mediaArtifactFailure.backupCleanup = false;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent GraphQL artifact publication for one output path", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-concurrent-"));
    const outputPath = join(artifactDir, "users", "call-1", "response.bin");
    const firstWriter = await createMediaArtifactWriter({
      rootDir: artifactDir,
      capletId: "users",
      callId: "call-1",
      outputPath,
      mimeType: "text/plain",
    });
    const secondWriter = await createMediaArtifactWriter({
      rootDir: artifactDir,
      capletId: "users",
      callId: "call-1",
      outputPath,
      mimeType: "application/json",
    });

    try {
      await Promise.all([
        firstWriter.write(Buffer.from("first GraphQL artifact")),
        secondWriter.write(Buffer.from('{"artifact":"second"}')),
      ]);
      const [first, second] = await Promise.all([firstWriter.complete(), secondWriter.complete()]);
      const stored = resolveMediaArtifact(first.uri, { artifactRoot: artifactDir });
      const published = [first, second].find(
        (candidate) =>
          candidate.byteLength === stored.byteLength &&
          candidate.sha256 === stored.sha256 &&
          candidate.mimeType === stored.mimeType,
      );

      expect(published).toBeDefined();
      expect(stored.sha256).toBe(
        createHash("sha256").update(readFileSync(outputPath)).digest("hex"),
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not classify errors from invalid JSON split across GraphQL response chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-graphql-invalid-json-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(schemaPath, schemaSdl);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"errors":[{"message":"bad"}],'));
              controller.enqueue(new TextEncoder().encode("}"));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const manager = new GraphQLManager(registry());
    const endpoint = graphqlEndpoint({ schemaPath });

    try {
      const result = await manager.callTool(endpoint, "query_user", { id: "invalid-json" });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        kind: "inline",
        body: '{"errors":[{"message":"bad"}],}',
      });
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the 1 MiB GraphQL inline threshold and bounded artifact cap", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "caplets-graphql-boundaries-"));
    const endpoint = graphqlEndpoint({
      schemaUrl: `${baseUrl}/schema.graphql`,
      endpointUrl: `${baseUrl}/graphql`,
    });
    const manager = new GraphQLManager(registry(), { artifactDir });
    const boundedManager = new GraphQLManager(registry(), { mediaArtifactMaxBytes: 16 });
    const overCapOverrideManager = new GraphQLManager(registry(), {
      mediaArtifactMaxBytes: MEDIA_ARTIFACT_MAX_BYTES * 2,
    });

    try {
      const exact = await manager.callTool(endpoint, "query_user", { id: "exact-inline" });
      const over = await manager.callTool(endpoint, "query_user", { id: "over-inline" });

      expect(exact.structuredContent).toMatchObject({ kind: "inline" });
      expect(over.structuredContent).toMatchObject({
        kind: "local-artifact",
        byteLength: 1024 * 1024 + 1,
      });
      await expect(
        manager.callTool(endpoint, "query_user", { id: "advertised-over-cap" }),
      ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
      await expect(
        boundedManager.callTool(endpoint, "query_user", { id: "streamed-over-cap" }),
      ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
      await expect(
        overCapOverrideManager.callTool(endpoint, "query_user", { id: "advertised-over-cap" }),
      ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
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

function graphQlPayload(byteLength: number): string {
  const payload = { data: { user: { id: "42", name: "Ada" } }, padding: "" };
  const paddingLength = byteLength - Buffer.byteLength(JSON.stringify(payload));
  return JSON.stringify({ ...payload, padding: "x".repeat(paddingLength) });
}

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
