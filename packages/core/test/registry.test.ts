import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { capabilityDescription, ServerRegistry } from "../src/registry";

describe("registry", () => {
  it("omits disabled servers and builds safe capability cards", () => {
    process.env.SECRET_TOKEN = "secret-env-value";
    const config = parseConfig({
      mcpServers: {
        enabled: {
          name: "Enabled Server",
          description: "A useful enabled server.",
          command: "node",
          useWhen: "Use for enabled test workflows.",
          avoidWhen: "Avoid for disabled server checks.",
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
    expect(description).toContain("Use when: Use for enabled test workflows.");
    expect(description).toContain("Avoid when: Avoid for disabled server checks.");
    expect(description).toContain("Use tools/search_tools for downstream names");
    expect(description).toContain("callTemplate");
    expect(description).toContain("Prefer direct call_tool");
    expect(description).toContain("call_tool.args must match inputSchema exactly");
    expect(description).toContain("do not guess tool names or schemas");
    expect(description).toContain("Resources/prompts/completions may exist");
    expect(description).not.toContain("Recommended flow:");
    expect(description).not.toContain("secret-arg");
    expect(description).not.toContain("secret-env-value");

    const remoteDetail = registry.detail(config.mcpServers.remote!);
    const enabledDetail = registry.detail(config.mcpServers.enabled!);
    expect(enabledDetail).toMatchObject({
      useWhen: "Use for enabled test workflows.",
      avoidWhen: "Avoid for disabled server checks.",
    });
    const serialized = JSON.stringify(remoteDetail);
    expect(serialized).toContain('"transport":"http"');
    expect(serialized).not.toContain("secret-url-value");
    expect(serialized).not.toContain("secret-bearer-value");

    const openApiDescription = capabilityDescription(config.openapiEndpoints.users!);
    expect(openApiDescription).toContain("Use tools/search_tools for downstream names");
    expect(openApiDescription).toContain("call_tool.args must match inputSchema exactly");
    expect(openApiDescription).toContain("do not guess tool names or schemas");
    const openApiDetail = registry.detail(config.openapiEndpoints.users!);
    expect(openApiDetail).toEqual({
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
    expect(JSON.stringify(openApiDetail)).not.toContain("secret-token");

    const graphQlDescription = capabilityDescription(config.graphqlEndpoints.catalog!);
    expect(graphQlDescription).toContain("Use tools/search_tools for downstream names");
    expect(graphQlDescription).toContain("reserve describe_tool for complex schemas");
    const graphQlDetail = registry.detail(config.graphqlEndpoints.catalog!);
    expect(graphQlDetail).toEqual({
      id: "catalog",
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
    expect(httpDescription).toContain("Use tools/search_tools for downstream names");
    expect(httpDescription).toContain("callTemplate");
    const httpDetail = registry.detail(config.httpApis.status!);
    expect(httpDetail).toEqual({
      id: "status",
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
    expect(cliDescription).toContain("Use tools/search_tools for downstream names");
    expect(cliDescription).toContain("call_tool.args must match inputSchema exactly");
    const cliDetail = registry.detail(config.cliTools.repo!);
    expect(cliDetail).toEqual({
      id: "repo",
      name: "Repo CLI",
      description: "Run curated repository CLI workflows.",
      backend: {
        type: "cli",
        disabled: false,
        timeoutMs: 60000,
        maxOutputBytes: 200000,
        configuredActions: 1,
      },
    });

    const capletSetDescription = capabilityDescription(config.capletSets.nested!);
    expect(capletSetDescription).toContain("Use tools/search_tools for downstream names");
    expect(capletSetDescription).toContain("Prefer direct call_tool");
    const capletSetDetail = registry.detail(config.capletSets.nested!);
    expect(capletSetDetail).toEqual({
      id: "nested",
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
