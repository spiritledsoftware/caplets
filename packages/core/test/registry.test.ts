import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { capabilityDescription, ServerRegistry } from "../src/registry.js";

describe("registry", () => {
  it("omits disabled servers and builds safe capability cards", () => {
    process.env.SECRET_TOKEN = "secret-env-value";
    const config = parseConfig({
      mcpServers: {
        enabled: {
          name: "Enabled Server",
          description: "A useful enabled server.",
          command: "node",
          args: ["secret-arg", "$env:SECRET_TOKEN"],
          env: { SECRET_TOKEN: "$env:SECRET_TOKEN" },
          auth: undefined,
        },
        remote: {
          name: "Remote Server",
          description: "A useful remote server.",
          transport: "http",
          url: "https://example.com/mcp?token=secret-url-value",
          auth: { type: "bearer", token: "secret-bearer-value" },
        },
        disabled: {
          name: "Disabled Server",
          description: "A useful disabled server.",
          command: "node",
          disabled: true,
        },
      },
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/users-openapi.json",
          auth: { type: "bearer", token: "secret-token" },
        },
      },
      graphqlEndpoints: {
        catalog: {
          name: "Catalog GraphQL",
          description: "Query catalog data through GraphQL.",
          endpointUrl: "https://api.example.com/graphql?token=secret-graphql-url",
          schemaPath: "/tmp/catalog.graphql",
          auth: { type: "bearer", token: "secret-graphql-token" },
        },
      },
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Check internal service status through HTTP.",
          baseUrl: "https://api.example.com/status",
          auth: { type: "bearer", token: "secret-http-token" },
          actions: {
            check: { method: "GET", path: "/check" },
          },
        },
      },
      cliTools: {
        repo: {
          name: "Repo CLI",
          description: "Run curated repository CLI workflows.",
          actions: {
            status: { command: "git", args: ["status", "--short"] },
          },
        },
      },
      capletSets: {
        nested: {
          name: "Nested Caplets",
          description: "Expose child Caplets through a nested collection.",
          capletsRoot: "/tmp/caplets",
        },
      },
    });
    const registry = new ServerRegistry(config);
    expect(registry.enabledServers().map((server) => server.server)).toEqual([
      "enabled",
      "remote",
      "users",
      "catalog",
      "status",
      "repo",
      "nested",
    ]);
    expect(registry.get("disabled")).toBeUndefined();
    expect(registry.get("status")?.backend).toBe("http");
    const description = capabilityDescription(config.mcpServers.enabled!);
    expect(description).toContain("Enabled Server");
    expect(description).toContain(
      '{"operation":"call_tool","tool":"<tool name>","arguments":{...}}',
    );
    expect(description).toContain(
      'After get_tool shows outputSchema (non-GraphQL), call_tool may use fields: ["path.to.field"].',
    );
    expect(description).toContain("Do not put downstream arguments at the top level");
    expect(description).not.toContain("secret-arg");
    expect(description).not.toContain("secret-env-value");

    const remoteDetail = registry.detail(config.mcpServers.remote!);
    const serialized = JSON.stringify(remoteDetail);
    expect(serialized).toContain('"transport":"http"');
    expect(serialized).not.toContain("secret-url-value");
    expect(serialized).not.toContain("secret-bearer-value");

    const openApiDescription = capabilityDescription(config.openapiEndpoints.users!);
    expect(openApiDescription).toContain("OpenAPI endpoint backend");
    expect(openApiDescription).toContain('"operation":"check_backend"');
    const openApiDetail = registry.detail(config.openapiEndpoints.users!);
    expect(openApiDetail).toEqual({
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
    expect(JSON.stringify(openApiDetail)).not.toContain("secret-token");

    const graphQlDescription = capabilityDescription(config.graphqlEndpoints.catalog!);
    expect(graphQlDescription).toContain("GraphQL endpoint backend");
    expect(graphQlDescription).toContain('"operation":"check_backend"');
    const graphQlDetail = registry.detail(config.graphqlEndpoints.catalog!);
    expect(graphQlDetail).toEqual({
      caplet: "catalog",
      name: "Catalog GraphQL",
      description: "Query catalog data through GraphQL.",
      backend: {
        type: "graphql",
        disabled: false,
        requestTimeoutMs: 60000,
        operationCacheTtlMs: 30000,
        source: "schemaPath",
        configuredOperations: false,
      },
    });
    expect(JSON.stringify(graphQlDetail)).not.toContain("secret-graphql");

    const httpDescription = capabilityDescription(config.httpApis.status!);
    expect(httpDescription).toContain("HTTP API backend");
    expect(httpDescription).toContain('"operation":"check_backend"');
    const httpDetail = registry.detail(config.httpApis.status!);
    expect(httpDetail).toEqual({
      caplet: "status",
      name: "Status HTTP",
      description: "Check internal service status through HTTP.",
      backend: {
        type: "http",
        disabled: false,
        requestTimeoutMs: 60000,
        configuredActions: 1,
      },
    });
    expect(JSON.stringify(httpDetail)).not.toContain("secret-http");

    const cliDescription = capabilityDescription(config.cliTools.repo!);
    expect(cliDescription).toContain("CLI tools backend");
    expect(cliDescription).toContain('"operation":"check_backend"');
    const cliDetail = registry.detail(config.cliTools.repo!);
    expect(cliDetail).toEqual({
      caplet: "repo",
      name: "Repo CLI",
      description: "Run curated repository CLI workflows.",
      backend: {
        type: "cli",
        disabled: false,
        timeoutMs: 60000,
        maxOutputBytes: 1000000,
        configuredActions: 1,
      },
    });

    const capletSetDescription = capabilityDescription(config.capletSets.nested!);
    expect(capletSetDescription).toContain("nested Caplets backend");
    expect(capletSetDescription).toContain('"operation":"check_backend"');
    const capletSetDetail = registry.detail(config.capletSets.nested!);
    expect(capletSetDetail).toEqual({
      caplet: "nested",
      name: "Nested Caplets",
      description: "Expose child Caplets through a nested collection.",
      backend: {
        type: "caplets",
        disabled: false,
        source: "capletsRoot",
        toolCacheTtlMs: 30000,
      },
    });
  });
});
