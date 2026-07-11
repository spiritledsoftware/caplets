import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import { describe, expect, it } from "vitest";
import type { CapletConfig } from "../src/config";
import type { CallableCaplet, ExposureSnapshot } from "../src/exposure/discovery";
import {
  buildExposureProjection,
  buildManifestExposureProjection,
  exposureProjectionRouteKey,
  resolveNativeProjectionMerge,
} from "../src/exposure/projection";

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
      prompts: [
        {
          ...prompt("summarize"),
          arguments: [{ name: "topic", description: "Topic to summarize.", required: true }],
        },
      ],
      completions: true,
      exposure: { value: "direct", progressive: false, direct: true, codeMode: false },
    });

    const projection = buildExposureProjection(
      snapshot({
        callableCaplets: [http, docs],
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
    expect(projection.routes.get("direct-tool:docs__read")).toEqual({
      kind: "direct-tool",
      capletId: "docs",
      downstreamName: "read",
    });
    expect(projection.routes.get("progressive-caplet:search")).toEqual({
      kind: "progressive-caplet",
      capletId: "search",
    });
    expect(projection.routes.get("code-mode-caplet:search")).toEqual({
      kind: "code-mode-caplet",
      capletId: "search",
    });
    expect(projection.routes.get("direct-tool:docs__read")).not.toEqual(
      expect.objectContaining({ callback: expect.any(Function) }),
    );
    expect(projection.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "progressive-caplet",
          id: "search",
          title: "search",
          description: expect.stringContaining("Call search actions."),
          backend: "http",
          inputSchema: expect.objectContaining({ type: "object" }),
          operationNames: [
            "inspect",
            "check",
            "tools",
            "search_tools",
            "describe_tool",
            "call_tool",
          ],
          route: { kind: "progressive-caplet", capletId: "search" },
        }),
        expect.objectContaining({
          kind: "code-mode-caplet",
          id: "search",
          title: "search",
          description: expect.stringContaining("Call search actions."),
          backend: "http",
          route: { kind: "code-mode-caplet", capletId: "search" },
        }),
        expect.objectContaining({
          kind: "direct-tool",
          id: "docs__read",
          title: "read",
          description: "Run read.",
          inputSchema: { type: "object" },
          route: { kind: "direct-tool", capletId: "docs", downstreamName: "read" },
        }),
        expect.objectContaining({
          kind: "direct-resource",
          id: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
          title: "file:///README.md",
          route: {
            kind: "direct-resource",
            capletId: "docs",
            downstreamUri: "file:///README.md",
          },
        }),
        expect.objectContaining({
          kind: "direct-resource-template",
          title: "file:///{path}",
          route: {
            kind: "direct-resource-template",
            capletId: "docs",
            downstreamUriTemplate: "file:///{path}",
          },
        }),
        expect.objectContaining({
          kind: "direct-prompt",
          id: "docs__summarize",
          inputSchema: {
            arguments: [{ name: "topic", description: "Topic to summarize.", required: true }],
          },
          arguments: [{ name: "topic", description: "Topic to summarize.", required: true }],
          route: { kind: "direct-prompt", capletId: "docs", downstreamName: "summarize" },
        }),
        expect.objectContaining({
          kind: "completion",
          id: "docs:complete",
          route: { kind: "completion", capletId: "docs" },
        }),
      ]),
    );
  });

  it("projects completion only when the downstream capability was discovered", () => {
    const caplet = mcpCaplet("docs", "direct");
    const withoutCompletions = callable(caplet, {
      exposure: { value: "direct", progressive: false, direct: true, codeMode: false },
      resourceTemplates: [resourceTemplate("file:///{path}")],
      completions: false,
    });
    const withCompletions = callable(caplet, {
      exposure: { value: "direct", progressive: false, direct: true, codeMode: false },
      resourceTemplates: [resourceTemplate("file:///{path}")],
      completions: true,
    });

    expect(
      buildExposureProjection(snapshot({ callableCaplets: [withoutCompletions] })).entries.some(
        (entry) => entry.kind === "completion",
      ),
    ).toBe(false);
    expect(
      buildExposureProjection(snapshot({ callableCaplets: [withCompletions] })).entries.some(
        (entry) => entry.kind === "completion",
      ),
    ).toBe(true);
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
              message:
                "Failed with sk-live-secret-token at /Users/ian/.config/caplets/token.json and C:\\Users\\ian\\.caplets\\config.json",
              details: {
                token: "sk-live-secret-token",
                path: "C:/Users/ian/.caplets/config.json",
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
    expect(JSON.stringify(projection.hiddenCaplets)).not.toContain("C:\\Users\\ian");
    expect(JSON.stringify(projection.hiddenCaplets)).not.toContain("C:/Users/ian");
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

describe("remote manifest exposure projection", () => {
  it("projects attach manifest surfaces into first-class exposure entries", () => {
    const projection = buildManifestExposureProjection({
      caplets: [
        manifestEntry({
          kind: "caplet",
          name: "Docs",
          capletId: "docs",
          title: "Docs",
          description: "Docs caplet.",
          inputSchema: { type: "object" },
          shadowing: "allow",
        }),
      ],
      tools: [
        manifestEntry({
          kind: "tool",
          name: "docs__search",
          downstreamName: "search",
          capletId: "docs",
          title: "Search",
          description: "Search docs.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          shadowing: "allow",
        }),
      ],
      resources: [
        manifestEntry({
          kind: "resource",
          uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
          downstreamUri: "file:///README.md",
          capletId: "docs",
          sourceCapletId: "upstream-docs",
          title: "README",
          description: "README resource.",
          mimeType: "text/markdown",
          size: 42,
          shadowing: "allow",
        }),
      ],
      resourceTemplates: [
        manifestEntry({
          kind: "resourceTemplate",
          uriTemplate: "caplets://docs/resources/{encodedUri}",
          downstreamUriTemplate: "file:///{path}",
          capletId: "docs",
          sourceCapletId: "upstream-docs",
          title: "File",
          description: "File resource.",
          mimeType: "text/plain",
          shadowing: "allow",
        }),
      ],
      prompts: [
        manifestEntry({
          kind: "prompt",
          name: "docs__explain",
          downstreamName: "explain",
          capletId: "docs",
          sourceCapletId: "upstream-docs",
          title: "Explain",
          description: "Explain prompt.",
          inputSchema: { arguments: [{ name: "topic", required: true }] },
          shadowing: "allow",
        }),
      ],
      completions: [
        manifestEntry({
          kind: "completion",
          name: "docs:complete",
          capletId: "docs",
          sourceCapletId: "upstream-docs",
          title: "Complete",
          description: "Complete docs inputs.",
          shadowing: "allow",
        }),
      ],
      codeModeCaplets: [
        manifestEntry({
          kind: "caplet",
          name: "Docs",
          capletId: "docs",
          title: "Docs",
          description: "Docs Code Mode handle.",
          shadowing: "allow",
        }),
      ],
    });

    expect(projection.entries.map((entry) => [entry.kind, entry.id, entry.route])).toEqual([
      ["progressive-caplet", "docs", { kind: "progressive-caplet", capletId: "docs" }],
      [
        "direct-tool",
        "docs__search",
        { kind: "direct-tool", capletId: "docs", downstreamName: "search" },
      ],
      [
        "direct-resource",
        "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
        { kind: "direct-resource", capletId: "docs", downstreamUri: "file:///README.md" },
      ],
      [
        "direct-resource-template",
        "caplets://docs/resources/{encodedUri}",
        {
          kind: "direct-resource-template",
          capletId: "docs",
          downstreamUriTemplate: "file:///{path}",
        },
      ],
      [
        "direct-prompt",
        "docs__explain",
        { kind: "direct-prompt", capletId: "docs", downstreamName: "explain" },
      ],
      ["completion", "docs:complete", { kind: "completion", capletId: "docs" }],
      ["code-mode-caplet", "docs", { kind: "code-mode-caplet", capletId: "docs" }],
    ]);
    expect(
      projection.routes.get(
        exposureProjectionRouteKey({ kind: "direct-tool", id: "docs__search" }),
      ),
    ).toEqual({
      kind: "direct-tool",
      capletId: "docs",
      downstreamName: "search",
    });
    expect(
      projection.entries
        .filter((entry) =>
          ["direct-resource", "direct-resource-template", "direct-prompt", "completion"].includes(
            entry.kind,
          ),
        )
        .map((entry) => [entry.kind, entry.sourceCapletId]),
    ).toEqual([
      ["direct-resource", "upstream-docs"],
      ["direct-resource-template", "upstream-docs"],
      ["direct-prompt", "upstream-docs"],
      ["completion", "upstream-docs"],
    ]);
  });

  it("keeps manifest Code Mode entries explicit instead of inferring fallback handles", () => {
    const explicitEmpty = buildManifestExposureProjection({
      caplets: [manifestEntry({ kind: "caplet", name: "Remote", capletId: "remote" })],
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      completions: [],
      codeModeCaplets: [],
    });
    const explicitHandle = buildManifestExposureProjection({
      caplets: [manifestEntry({ kind: "caplet", name: "Remote", capletId: "remote" })],
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      completions: [],
      codeModeCaplets: [manifestEntry({ kind: "caplet", name: "Remote", capletId: "remote" })],
    });

    expect(explicitEmpty.entries.filter((entry) => entry.kind === "code-mode-caplet")).toEqual([]);
    expect(explicitHandle.entries.filter((entry) => entry.kind === "code-mode-caplet")).toEqual([
      expect.objectContaining({ id: "remote", capletId: "remote" }),
    ]);
  });
});

function manifestEntry<T extends Record<string, unknown>>(
  entry: T,
): T & {
  stableId: string;
  exportId: string;
  schemaHash: null;
  shadowing: "allow" | "forbid" | "namespace";
} {
  return {
    stableId: `${String(entry.kind)}:${String(entry.name ?? entry.uri ?? entry.uriTemplate ?? entry.capletId)}`,
    exportId: `export-${String(entry.kind)}-${String(entry.name ?? entry.uri ?? entry.uriTemplate ?? entry.capletId)}`,
    schemaHash: null,
    shadowing: "forbid",
    ...entry,
  };
}

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

  it("qualifies Code Mode-only collisions and removes the bare handle", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [],
      localTools: [],
      remoteCodeModeTools: [mergeTool("shared", "remote", "namespace")],
      localCodeModeTools: [mergeTool("shared", "local", "namespace")],
      remoteIdentity: "https://remote.example.com",
      localIdentity: "local:/repo",
      namespaceAliases: { local: "mac", upstreams: { "https://remote.example.com": "vps" } },
      renameTool: renameMergeTool,
    });

    expect(result.remoteCodeModeTools.map((tool) => tool.caplet)).toEqual(["vps-d4b6__shared"]);
    expect(result.localCodeModeTools.map((tool) => tool.caplet)).toEqual(["mac-6617__shared"]);
    expect(result.routes.has("shared")).toBe(false);
    expect(result.namespaceDiagnostics.get("shared")).toMatchObject({
      requestedId: "shared",
      reason: "namespace_collision",
      alternatives: ["vps-d4b6__shared", "mac-6617__shared"],
    });
  });

  it("fails closed when generated namespace IDs collide with bare IDs", () => {
    const result = resolveNativeProjectionMerge({
      remoteTools: [
        mergeTool("shared", "remote", "namespace"),
        // These five bare IDs are calibrated to exhaust the current generated
        // namespace suffix retry policy for the `clash` namespace alias.
        mergeTool("clash-8516__shared", "remote", "forbid"),
        mergeTool("clash-85163__shared", "remote", "forbid"),
        mergeTool("clash-851639__shared", "remote", "forbid"),
        mergeTool("clash-851639a__shared", "remote", "forbid"),
        mergeTool("clash-851639a7__shared", "remote", "forbid"),
      ],
      localTools: [mergeTool("shared", "local", "namespace")],
      remoteCodeModeTools: [],
      localCodeModeTools: [],
      remoteIdentity: "http://127.0.0.1:5387/v1/attach",
      localIdentity: "local:/repo",
      namespaceAliases: { upstreams: { "http://127.0.0.1:5387/v1/attach": "clash" } },
      renameTool: renameMergeTool,
    });

    expect(result.remoteTools.map((tool) => tool.caplet)).toEqual([
      "clash-8516__shared",
      "clash-85163__shared",
      "clash-851639__shared",
      "clash-851639a__shared",
      "clash-851639a7__shared",
    ]);
    expect(result.localTools).toEqual([]);
    expect(result.routes.has("shared")).toBe(false);
    expect(result.namespaceDiagnostics.get("shared")).toMatchObject({
      reason: "generated_id_collision",
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
  const callableCaplets = overrides.callableCaplets ?? [];
  return {
    callableCaplets,
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
    completions?: boolean | undefined;
  },
): CallableCaplet {
  return {
    caplet,
    exposure: options.exposure,
    tools: options.tools ?? [],
    resources: options.resources ?? [],
    resourceTemplates: options.resourceTemplates ?? [],
    prompts: options.prompts ?? [],
    completions: options.completions ?? false,
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
