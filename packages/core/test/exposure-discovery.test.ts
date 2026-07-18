import type { ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types";
import { describe, expect, it, vi } from "vitest";
import type { CapletConfig, CapletsConfig } from "../src/config";
import { discoverExposureSnapshot } from "../src/exposure/discovery";
import { buildExposureProjection } from "../src/exposure/projection";

describe("exposure discovery", () => {
  it("discovers callable direct and Code Mode surfaces", async () => {
    const caplet = httpCaplet("osv", "direct_and_code_mode");
    const snapshot = await discoverExposureSnapshot({
      config: configFor([caplet], { exposure: "progressive" }),
      caplets: [caplet],
      listTools: async () => [tool("query")],
    });
    const projection = buildExposureProjection(snapshot);

    expect(snapshot.callableCaplets.map((entry) => entry.caplet.server)).toEqual(["osv"]);
    expect(
      projection.entries
        .filter((entry) => entry.kind === "code-mode-caplet")
        .map((entry) => entry.capletId),
    ).toEqual(["osv"]);
    expect(
      projection.entries.filter((entry) => entry.kind === "direct-tool").map((entry) => entry.id),
    ).toEqual(["osv__query"]);
    expect(projection.entries.filter((entry) => entry.kind === "progressive-caplet")).toEqual([]);
  });

  it("keeps disabled and setup-required Code Mode Caplets out of callable projection", async () => {
    const disabled = { ...httpCaplet("disabled", "code_mode"), disabled: true };
    const setupRequired = {
      ...httpCaplet("setup", "code_mode"),
      setup: { commands: [{ label: "Install", command: "install-setup" }] },
    };
    const listTools = vi.fn(async () => [tool("run")]);
    const snapshot = await discoverExposureSnapshot({
      config: configFor([disabled, setupRequired]),
      caplets: [disabled, setupRequired],
      listTools,
    });
    const projection = buildExposureProjection(snapshot);

    expect(projection.entries).toEqual([]);
    expect(projection.hiddenCaplets).toEqual([
      expect.objectContaining({ capletId: "disabled", reason: "disabled" }),
      expect.objectContaining({ capletId: "setup", reason: "setup_required" }),
    ]);
    expect(listTools).not.toHaveBeenCalled();
  });

  it("hides failed discovery without failing the whole snapshot", async () => {
    const direct = httpCaplet("direct", "direct");
    const progressive = httpCaplet("progressive", "progressive");
    const snapshot = await discoverExposureSnapshot({
      config: configFor([direct, progressive]),
      caplets: [direct, progressive],
      listTools: async (caplet) => {
        if (caplet.server === "direct") throw new Error("unavailable");
        return [tool("search")];
      },
    });
    const projection = buildExposureProjection(snapshot);

    expect(projection.entries.filter((entry) => entry.kind === "direct-tool")).toEqual([]);
    expect(
      projection.entries
        .filter((entry) => entry.kind === "progressive-caplet")
        .map((entry) => entry.capletId),
    ).toEqual(["progressive"]);
    expect(snapshot.hiddenCaplets).toEqual([
      expect.objectContaining({ capletId: "direct", reason: "discovery_failed" }),
    ]);
  });

  it("hides non-direct caplets with an empty discovered surface", async () => {
    const progressive = httpCaplet("progressive", "progressive_and_code_mode");
    const snapshot = await discoverExposureSnapshot({
      config: configFor([progressive]),
      caplets: [progressive],
      listTools: async () => [],
    });

    expect(snapshot.callableCaplets).toEqual([]);
    expect(snapshot.hiddenCaplets).toEqual([
      expect.objectContaining({ capletId: "progressive", reason: "empty_surface" }),
    ]);
  });

  it("hides project-bound caplets without session context with a stable diagnostic", async () => {
    const projectBound = {
      ...httpCaplet("workspace", "progressive"),
      projectBinding: { required: true },
    } satisfies Extract<CapletConfig, { backend: "http" }>;

    const snapshot = await discoverExposureSnapshot({
      config: configFor([projectBound]),
      caplets: [projectBound],
      listTools: async () => [tool("run")],
    });

    expect(snapshot.callableCaplets).toEqual([]);
    expect(snapshot.hiddenCaplets).toEqual([
      {
        capletId: "workspace",
        reason: "project_binding_missing_context",
        error: {
          code: "UNSUPPORTED_CAPABILITY",
          message: "Project Binding session context is required before this Caplet can be exposed.",
          details: {
            projectBinding: {
              reason: "missing_context",
              recoveryCommand:
                "Reconnect through an attach or native session with project context.",
            },
          },
        },
      },
    ]);
  });

  it("discovers project-bound caplets when session context is available", async () => {
    const projectBound = {
      ...httpCaplet("workspace", "progressive"),
      projectBinding: { required: true },
    } satisfies Extract<CapletConfig, { backend: "http" }>;

    const snapshot = await discoverExposureSnapshot({
      config: configFor([projectBound]),
      caplets: [projectBound],
      projectBindingContext: {
        sessionId: "session_1",
        bindingId: "binding_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:repo",
      },
      listTools: async () => [tool("run")],
    });

    expect(snapshot.callableCaplets.map((entry) => entry.caplet.server)).toEqual(["workspace"]);
    expect(snapshot.hiddenCaplets).toEqual([]);
  });

  it("hides quarantined project-bound caplets even when session context is available", async () => {
    const projectBound = {
      ...httpCaplet("workspace", "progressive"),
      projectBinding: { required: true },
    } satisfies Extract<CapletConfig, { backend: "http" }>;

    const snapshot = await discoverExposureSnapshot({
      config: configFor([projectBound]),
      caplets: [projectBound],
      projectBindingContext: {
        sessionId: "session_1",
        bindingId: "binding_1",
        projectRoot: "/repo",
        projectFingerprint: "sha256:repo",
        quarantineRecords: [
          {
            capletId: "workspace",
            reason: "sync_failed",
            message: "Project sync failed.",
            code: "project_sync_process_exit",
          },
        ],
      },
      listTools: vi.fn(async () => [tool("run")]),
    });

    expect(snapshot.callableCaplets).toEqual([]);
    expect(snapshot.hiddenCaplets).toEqual([
      expect.objectContaining({
        capletId: "workspace",
        reason: "project_binding_sync_failed",
        error: expect.objectContaining({
          message: "Project sync failed.",
          details: {
            projectBinding: expect.objectContaining({
              reason: "sync_failed",
              capletId: "workspace",
              diagnosticCode: "[REDACTED]",
            }),
          },
        }),
      }),
    ]);
  });

  it("keeps direct resource templates unique per downstream template", async () => {
    const docs = mcpCaplet("docs", "direct");
    const snapshot = await discoverExposureSnapshot({
      config: configFor([docs]),
      caplets: [docs],
      listTools: async () => [],
      listResourceTemplates: async () => [
        resourceTemplate("file:///repo/{path}"),
        resourceTemplate("git://repo/{ref}/{path}"),
      ],
    });
    const projection = buildExposureProjection(snapshot);

    expect(
      projection.entries
        .filter((entry) => entry.kind === "direct-resource-template")
        .map((entry) => entry.id),
    ).toEqual([
      "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2Frepo%2F%7Bpath%7D",
      "caplets://docs/resources/{encodedUri}?template=git%3A%2F%2Frepo%2F%7Bref%7D%2F%7Bpath%7D",
    ]);
  });

  it("limits concurrent discovery", async () => {
    const caplets = [
      httpCaplet("one", "direct"),
      httpCaplet("two", "direct"),
      httpCaplet("three", "direct"),
    ];
    let active = 0;
    let maxActive = 0;
    const snapshot = await discoverExposureSnapshot({
      config: configFor(caplets, { exposureDiscoveryConcurrency: 2 }),
      caplets,
      listTools: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [tool("run")];
      }),
    });
    const projection = buildExposureProjection(snapshot);

    expect(projection.entries.filter((entry) => entry.kind === "direct-tool")).toHaveLength(3);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

function configFor(
  caplets: CapletConfig[],
  options: Partial<CapletsConfig["options"]> = {},
): CapletsConfig {
  return {
    version: 1,
    storage: { type: "sqlite" },
    options: {
      defaultSearchLimit: 20,
      maxSearchLimit: 50,
      exposure: "progressive_and_code_mode",
      exposureDiscoveryTimeoutMs: 15000,
      exposureDiscoveryConcurrency: 4,
      completion: {
        discoveryTimeoutMs: 750,
        overallTimeoutMs: 1500,
        cacheTtlMs: 300000,
        negativeCacheTtlMs: 30000,
      },
      ...options,
    },
    namespaceAliases: { upstreams: {} },
    mcpServers: Object.fromEntries(
      caplets.filter((caplet) => caplet.backend === "mcp").map((caplet) => [caplet.server, caplet]),
    ) as CapletsConfig["mcpServers"],
    openapiEndpoints: {},
    googleDiscoveryApis: {},
    graphqlEndpoints: {},
    httpApis: Object.fromEntries(
      caplets
        .filter((caplet) => caplet.backend === "http")
        .map((caplet) => [caplet.server, caplet]),
    ) as CapletsConfig["httpApis"],
    cliTools: {},
    capletSets: {},
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

function resourceTemplate(uriTemplate: string): ResourceTemplate {
  return { uriTemplate, name: uriTemplate };
}
