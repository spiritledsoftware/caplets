import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import type { CallableCaplet, ExposureSnapshot } from "../src/exposure/discovery";
import { buildExposureProjection, resolveNativeProjectionMerge } from "../src/exposure/projection";

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

describe("native projection merge", () => {
  it("suppresses local entries when remote forbids shadowing", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [mergeTool("shared", "remote", "forbid")],
      localTools: [mergeTool("shared", "local", "namespace")],
      remoteCodeModeTools: [],
      localCodeModeTools: [],
      remoteIdentity: "https://remote.example.com",
      localIdentity: "local:/repo",
      namespaceAliases: { upstreams: {} },
      renameTool: renameMergeTool,
    });

    expect(result.remoteTools.map((tool) => tool.caplet)).toEqual(["shared"]);
    expect(result.localTools).toEqual([]);
    expect(result.routes.get("shared")).toEqual({ service: "remote", capletId: "shared" });
    expect(result.suppressedLocalIds).toEqual(new Set(["shared"]));
  });

  it("keeps local entries visible when remote allows shadowing", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [mergeTool("shared", "remote", "allow")],
      localTools: [mergeTool("shared", "local", "namespace")],
      remoteCodeModeTools: [],
      localCodeModeTools: [],
      remoteIdentity: "https://remote.example.com",
      localIdentity: "local:/repo",
      namespaceAliases: { upstreams: {} },
      renameTool: renameMergeTool,
    });

    expect(result.remoteTools.map((tool) => tool.caplet)).toEqual(["shared"]);
    expect(result.localTools.map((tool) => tool.caplet)).toEqual(["shared"]);
    expect(result.routes.get("shared")).toEqual({ service: "local", capletId: "shared" });
  });

  it("qualifies namespace collisions and makes bare IDs diagnostic-only", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [mergeTool("shared", "remote", "namespace")],
      localTools: [mergeTool("shared", "local", "namespace")],
      remoteCodeModeTools: [],
      localCodeModeTools: [],
      remoteIdentity: "https://remote.example.com",
      localIdentity: "local:/repo",
      namespaceAliases: { local: "mac", upstreams: { "https://remote.example.com": "vps" } },
      renameTool: renameMergeTool,
    });

    expect(result.remoteTools.map((tool) => tool.caplet)).toEqual(["vps-d4b6__shared"]);
    expect(result.localTools.map((tool) => tool.caplet)).toEqual(["mac-6617__shared"]);
    expect(result.routes.has("shared")).toBe(false);
    expect(result.namespaceDiagnostics.get("shared")).toMatchObject({
      requestedId: "shared",
      reason: "namespace_collision",
      alternatives: ["vps-d4b6__shared", "mac-6617__shared"],
    });
  });

  it("rewrites direct-tool alternatives while preserving source routes", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [mergeTool("shared__read", "remote", "namespace", "shared")],
      localTools: [mergeTool("shared__write", "local", "namespace", "shared")],
      remoteCodeModeTools: [],
      localCodeModeTools: [],
      remoteIdentity: "https://remote.example.com",
      localIdentity: "local:/repo",
      namespaceAliases: { local: "mac", upstreams: { "https://remote.example.com": "vps" } },
      renameTool: renameMergeTool,
    });

    expect(result.remoteTools.map((tool) => [tool.caplet, tool.sourceCaplet])).toEqual([
      ["vps-d4b6__shared__read", "vps-d4b6__shared"],
    ]);
    expect(result.localTools.map((tool) => [tool.caplet, tool.sourceCaplet])).toEqual([
      ["mac-6617__shared__write", "mac-6617__shared"],
    ]);
    expect(result.routes.get("vps-d4b6__shared__read")).toEqual({
      service: "remote",
      capletId: "shared__read",
    });
    expect(result.namespaceDiagnostics.get("shared__read")).toMatchObject({
      alternatives: ["vps-d4b6__shared__read", "mac-6617__shared__write"],
    });
  });
});

type MergeTool = {
  caplet: string;
  sourceCaplet?: string | undefined;
  shadowing?: "forbid" | "allow" | "namespace" | undefined;
  service: "local" | "remote";
};

function mergeTool(
  caplet: string,
  service: "local" | "remote",
  shadowing: "forbid" | "allow" | "namespace",
  sourceCaplet?: string,
): MergeTool {
  return {
    caplet,
    service,
    shadowing,
    ...(sourceCaplet ? { sourceCaplet } : {}),
  };
}

function renameMergeTool(tool: MergeTool, visibleBaseId: string): MergeTool {
  const baseId = tool.sourceCaplet ?? tool.caplet;
  const directTool = Boolean(tool.sourceCaplet && tool.caplet.startsWith(`${baseId}__`));
  return {
    ...tool,
    caplet: directTool ? `${visibleBaseId}${tool.caplet.slice(baseId.length)}` : visibleBaseId,
    sourceCaplet: directTool ? visibleBaseId : tool.sourceCaplet,
  };
}

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
