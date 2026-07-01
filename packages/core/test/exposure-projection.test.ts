import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import type { CallableCaplet, ExposureSnapshot } from "../src/exposure/discovery";
import { buildExposureProjection } from "../src/exposure/projection";

const discoveredAt = 1_719_000_000_000;

describe("Caplets exposure projection", () => {
  it("projects mixed snapshot surfaces into adapter-neutral entries and route descriptors", () => {
    const http = callable(httpCaplet("search", "progressive_and_code_mode"), {
      tools: [tool("query")],
      exposure: {
        value: "progressive_and_code_mode",
        progressive: true,
        direct: false,
        codeMode: true,
      },
    });
    const docsCaplet = mcpCaplet("docs", "direct");
    const docs = callable(docsCaplet, {
      tools: [tool("read")],
      resources: [resource("file:///README.md")],
      resourceTemplates: [resourceTemplate("file:///{path}")],
      prompts: [prompt("summarize")],
      exposure: { value: "direct", progressive: false, direct: true, codeMode: false },
    });

    const projection = buildExposureProjection(
      snapshot({
        callableCaplets: [http, docs],
        progressiveCaplets: [http],
        codeModeCaplets: [http],
        directTools: [
          { caplet: docsCaplet, downstreamName: "read", name: "docs__read", tool: tool("read") },
        ],
        directResources: [
          {
            caplet: docsCaplet,
            downstreamUri: "file:///README.md",
            uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
            resource: resource("file:///README.md"),
          },
        ],
        directResourceTemplates: [
          {
            caplet: docsCaplet,
            downstreamUriTemplate: "file:///{path}",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            resourceTemplate: resourceTemplate("file:///{path}"),
          },
        ],
        directPrompts: [
          {
            caplet: docsCaplet,
            downstreamName: "summarize",
            name: "docs__summarize",
            prompt: prompt("summarize"),
          },
        ],
      }),
    );

    expect(projection.availability).toEqual({ state: "ready" });
    expect(projection.entries.map((entry) => [entry.kind, entry.id, entry.capletId])).toEqual([
      ["progressive-caplet", "search", "search"],
      ["code-mode-caplet", "search", "search"],
      ["direct-tool", "docs__read", "docs"],
      ["direct-resource", "caplets://docs/resources/file%3A%2F%2F%2FREADME.md", "docs"],
      [
        "direct-resource-template",
        "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
        "docs",
      ],
      ["direct-prompt", "docs__summarize", "docs"],
      ["completion", "docs:complete", "docs"],
    ]);
    expect(projection.routes.get("docs__read")).toEqual({
      kind: "direct-tool",
      capletId: "docs",
      downstreamName: "read",
    });
    expect(projection.routes.get("docs__read")).not.toEqual(
      expect.objectContaining({ callback: expect.any(Function) }),
    );
  });

  it("keeps hidden Caplets non-callable while exposing safe diagnostic breadcrumbs", () => {
    const projection = buildExposureProjection(
      snapshot({
        hiddenCaplets: [
          {
            capletId: "vaulted",
            reason: "discovery_failed",
            error: {
              code: "SERVER_UNAVAILABLE",
              message: "Failed with sk-live-secret-token at /Users/ian/.config/caplets/token.json",
              details: {
                token: "sk-live-secret-token",
                path: "/Users/ian/.config/caplets/token.json",
              },
            },
          },
          { capletId: "workspace", reason: "project_binding_missing_context" },
        ],
      }),
    );

    expect(projection.entries.map((entry) => entry.capletId)).not.toContain("vaulted");
    expect(projection.hiddenCaplets).toEqual([
      expect.objectContaining({
        capletId: "vaulted",
        reason: "discovery_failed",
        diagnostic: expect.objectContaining({
          code: "SERVER_UNAVAILABLE",
        }),
      }),
      expect.objectContaining({
        capletId: "workspace",
        reason: "project_binding_missing_context",
      }),
    ]);
    expect(JSON.stringify(projection.hiddenCaplets)).not.toContain("sk-live-secret-token");
    expect(JSON.stringify(projection.hiddenCaplets)).not.toContain("/Users/ian");
  });

  it("preserves skipped non-direct MCP surface discovery as an empty projection", () => {
    const docs = callable(mcpCaplet("docs", "progressive_and_code_mode"), {
      exposure: {
        value: "progressive_and_code_mode",
        progressive: true,
        direct: false,
        codeMode: true,
      },
    });

    const projection = buildExposureProjection(
      snapshot({
        callableCaplets: [docs],
        progressiveCaplets: [docs],
        codeModeCaplets: [docs],
      }),
    );

    expect(projection.entries.map((entry) => entry.kind)).toEqual([
      "progressive-caplet",
      "code-mode-caplet",
    ]);
    expect(projection.entries).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ kind: "direct-resource" }),
        expect.objectContaining({ kind: "direct-prompt" }),
      ]),
    );
  });
});

function snapshot(overrides: Partial<ExposureSnapshot>): ExposureSnapshot {
  return {
    callableCaplets: [],
    progressiveCaplets: [],
    codeModeCaplets: [],
    directTools: [],
    directResources: [],
    directResourceTemplates: [],
    directPrompts: [],
    hiddenCaplets: [],
    ...overrides,
  };
}

function callable(
  caplet: CapletConfig,
  options: {
    exposure: CallableCaplet["exposure"];
    tools?: Tool[] | undefined;
    resources?: Resource[] | undefined;
    resourceTemplates?: ResourceTemplate[] | undefined;
    prompts?: Prompt[] | undefined;
  },
): CallableCaplet {
  return {
    caplet,
    exposure: options.exposure,
    tools: options.tools ?? [],
    resources: options.resources ?? [],
    resourceTemplates: options.resourceTemplates ?? [],
    prompts: options.prompts ?? [],
    discoveredAt,
  };
}

function httpCaplet(
  server: string,
  exposure: CapletConfig["exposure"],
): Extract<CapletConfig, { backend: "http" }> {
  return {
    server,
    backend: "http",
    name: server,
    description: `Call ${server} actions.`,
    exposure,
    baseUrl: "https://example.com",
    auth: { type: "none" },
    actions: { query: { method: "GET", path: "/query" } },
    requestTimeoutMs: 60000,
    maxResponseBytes: 200000,
    disabled: false,
  };
}

function mcpCaplet(
  server: string,
  exposure: CapletConfig["exposure"],
): Extract<CapletConfig, { backend: "mcp" }> {
  return {
    server,
    backend: "mcp",
    name: server,
    description: `Call ${server} MCP server.`,
    exposure,
    transport: "stdio",
    command: process.execPath,
    disabled: false,
    startupTimeoutMs: 60000,
    callTimeoutMs: 60000,
    toolCacheTtlMs: 300000,
  };
}

function tool(name: string): Tool {
  return { name, description: `Run ${name}.`, inputSchema: { type: "object" } };
}

function resource(uri: string): Resource {
  return { uri, name: uri };
}

function resourceTemplate(uriTemplate: string): ResourceTemplate {
  return { uriTemplate, name: uriTemplate };
}

function prompt(name: string): Prompt {
  return { name, description: `Prompt ${name}.` };
}
