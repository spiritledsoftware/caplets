import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAttachProjection,
  buildNativeAttachProjection,
  invokeAttachExport,
  invokeNativeAttachExport,
  type AttachProjection,
} from "../src/attach/api";
import { parseConfig } from "../src/config";
import { CapletsEngine } from "../src/engine";
import type { NativeCapletsService } from "../src/native/service";
import { sanitizeRemoteEngineOptions } from "../src/serve/http";

describe("Attach API dispatch", () => {
  it("sorts attach exports before hashing revisions", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
    };
    let reversed = false;
    const tools = [
      {
        caplet,
        downstreamName: "beta",
        name: "docs__beta",
        tool: { name: "beta", inputSchema: { type: "object" } },
      },
      {
        caplet,
        downstreamName: "alpha",
        name: "docs__alpha",
        tool: { name: "alpha", inputSchema: { type: "object" } },
      },
    ];
    const engine = {
      exposureSnapshot: async () => {
        reversed = !reversed;
        return {
          callableCaplets: [],
          progressiveCaplets: [],
          codeModeCaplets: [],
          directTools: reversed ? tools : [...tools].reverse(),
          directResources: [],
          directResourceTemplates: [],
          directPrompts: [],
          hiddenCaplets: [],
        };
      },
    } as unknown as CapletsEngine;

    const first = await buildAttachProjection(engine);
    const second = await buildAttachProjection(engine);

    expect(first.manifest.revision).toBe(second.manifest.revision);
    expect(first.manifest.tools.map((tool) => tool.stableId)).toEqual([
      "tool:docs:alpha",
      "tool:docs:beta",
    ]);
  });

  it("preserves direct tool annotations in attach manifests", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
    };
    const engine = {
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [],
        codeModeCaplets: [],
        directTools: [
          {
            caplet,
            downstreamName: "delete",
            name: "docs__delete",
            tool: {
              name: "delete",
              inputSchema: { type: "object" },
              annotations: { destructiveHint: true },
            },
          },
        ],
        directResources: [],
        directResourceTemplates: [],
        directPrompts: [],
        hiddenCaplets: [],
      }),
    } as unknown as CapletsEngine;

    const projection = await buildAttachProjection(engine);

    expect(projection.manifest.tools).toEqual([
      expect.objectContaining({
        annotations: { destructiveHint: true },
      }),
    ]);
  });

  it("sanitizes hidden discovery diagnostics through exposure projection", async () => {
    const engine = {
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [],
        codeModeCaplets: [],
        directTools: [],
        directResources: [],
        directResourceTemplates: [],
        directPrompts: [],
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
        ],
      }),
    } as unknown as CapletsEngine;

    const projection = await buildAttachProjection(engine);

    expect(projection.manifest.diagnostics).toEqual([
      expect.objectContaining({
        code: "ATTACH_CAPLET_DISCOVERY_FAILED",
        capletId: "vaulted",
        details: expect.objectContaining({
          code: "SERVER_UNAVAILABLE",
        }),
      }),
    ]);
    expect(JSON.stringify(projection.manifest.diagnostics)).not.toContain("sk-live-secret-token");
    expect(JSON.stringify(projection.manifest.diagnostics)).not.toContain("/Users/ian");
  });

  it("includes authoritative Project Binding metadata for hidden Caplets", async () => {
    const engine = {
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [],
        codeModeCaplets: [],
        directTools: [],
        directResources: [],
        directResourceTemplates: [],
        directPrompts: [],
        hiddenCaplets: [
          {
            capletId: "workspace",
            reason: "project_binding_missing_context",
            error: {
              code: "UNSUPPORTED_CAPABILITY",
              message:
                "Project Binding session context is required before this Caplet can be exposed.",
              details: {
                projectBinding: {
                  reason: "missing_context",
                  recoveryCommand:
                    "Reconnect through an attach or native session with project context.",
                },
              },
            },
          },
        ],
      }),
    } as unknown as CapletsEngine;

    const projection = await buildAttachProjection(engine);

    expect(projection.manifest.diagnostics).toEqual([
      expect.objectContaining({
        code: "ATTACH_CAPLET_PROJECT_BINDING_MISSING_CONTEXT",
        capletId: "workspace",
        details: {
          projectBinding: expect.objectContaining({
            required: true,
            capability: "project_binding",
            version: 1,
            reason: "missing_context",
          }),
        },
      }),
    ]);
  });

  it("uses configured Caplet shadowing policy in attach manifests", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
      shadowing: "namespace",
    };
    const engine = {
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [{ caplet }],
        codeModeCaplets: [{ caplet }],
        directTools: [
          {
            caplet,
            downstreamName: "read",
            name: "docs__read",
            tool: { name: "read", inputSchema: { type: "object" } },
          },
        ],
        directResources: [],
        directResourceTemplates: [],
        directPrompts: [],
        hiddenCaplets: [],
      }),
    } as unknown as CapletsEngine;

    const projection = await buildAttachProjection(engine);

    expect(projection.manifest.caplets).toEqual([
      expect.objectContaining({ shadowing: "namespace" }),
    ]);
    expect(projection.manifest.codeModeCaplets).toEqual([
      expect.objectContaining({ shadowing: "namespace" }),
    ]);
    expect(projection.manifest.tools).toEqual([
      expect.objectContaining({ shadowing: "namespace" }),
    ]);
  });

  it("preserves native stacked Caplet IDs and shadowing policies in attach manifests", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "filesystem",
          toolName: "caplets__filesystem",
          title: "Local Filesystem",
          description: "Local project filesystem.",
          promptGuidance: [],
          inputSchema: { type: "object" },
          shadowing: "allow",
        },
        {
          caplet: "github",
          toolName: "caplets__github",
          title: "Remote GitHub",
          description: "Upstream GitHub.",
          promptGuidance: [],
          inputSchema: { type: "object" },
          shadowing: "forbid",
        },
        {
          caplet: "vps__browser",
          toolName: "caplets__vps__browser",
          title: "Remote Browser",
          description: "Namespaced upstream browser.",
          promptGuidance: [],
          inputSchema: { type: "object" },
          shadowing: "namespace",
        },
      ],
      execute: vi.fn(),
      reload: vi.fn(),
      onToolsChanged: vi.fn(),
      close: vi.fn(),
    } as unknown as NativeCapletsService;

    const projection = await buildNativeAttachProjection(service);

    expect(
      projection.manifest.caplets.map((caplet) => ({
        name: caplet.name,
        capletId: caplet.capletId,
        shadowing: caplet.shadowing,
      })),
    ).toEqual([
      { name: "filesystem", capletId: "filesystem", shadowing: "allow" },
      { name: "github", capletId: "github", shadowing: "forbid" },
      { name: "vps__browser", capletId: "vps__browser", shadowing: "namespace" },
    ]);
  });

  it("preserves native direct tool identity in attach manifests", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "docs__read",
          sourceCaplet: "docs",
          toolName: "caplets__docs__read",
          title: "read",
          description: "Read docs.",
          promptGuidance: [],
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          shadowing: "namespace",
        },
      ],
      execute: vi.fn(async () => ({ ok: true })),
      reload: vi.fn(),
      onToolsChanged: vi.fn(),
      close: vi.fn(),
    } as unknown as NativeCapletsService;

    const projection = await buildNativeAttachProjection(service);

    expect(projection.manifest.caplets).toEqual([]);
    expect(projection.manifest.tools).toEqual([
      expect.objectContaining({
        stableId: "native-tool:docs__read",
        kind: "tool",
        name: "docs__read",
        downstreamName: "read",
        capletId: "docs",
        shadowing: "namespace",
        annotations: { readOnlyHint: true },
      }),
    ]);

    await expect(
      invokeNativeAttachExport(service, projection, {
        revision: projection.manifest.revision,
        kind: "tool",
        exportId: projection.manifest.tools[0]!.exportId,
        input: { path: "README.md" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(service.execute).toHaveBeenCalledWith("docs__read", { path: "README.md" });
  });

  it("preserves native Code Mode caplets in attach manifests", async () => {
    const service = {
      listTools: () => [
        {
          caplet: "filesystem",
          toolName: "caplets__filesystem",
          title: "Filesystem",
          description: "Filesystem.",
          promptGuidance: [],
          inputSchema: { type: "object" },
          shadowing: "allow",
        },
        {
          caplet: "code_mode",
          toolName: "caplets__code_mode",
          title: "Code Mode",
          description: "Code Mode.",
          promptGuidance: [],
          inputSchema: { type: "object" },
          codeModeRun: true,
          codeModeCaplets: [
            {
              id: "filesystem",
              name: "Filesystem",
              description: "Filesystem.",
              shadowing: "allow",
            },
          ],
        },
      ],
      execute: vi.fn(),
      reload: vi.fn(),
      onToolsChanged: vi.fn(),
      close: vi.fn(),
    } as unknown as NativeCapletsService;

    const projection = await buildNativeAttachProjection(service);

    expect(projection.manifest.caplets.map((caplet) => caplet.capletId)).toEqual(["filesystem"]);
    expect(projection.manifest.codeModeCaplets).toEqual([
      expect.objectContaining({
        stableId: "native-code-mode:filesystem",
        kind: "caplet",
        name: "Filesystem",
        capletId: "filesystem",
        shadowing: "allow",
      }),
    ]);
  });

  it("preserves direct resource metadata in attach manifests", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
    };
    const engine = {
      exposureSnapshot: async () => ({
        callableCaplets: [],
        progressiveCaplets: [],
        codeModeCaplets: [],
        directTools: [],
        directResources: [
          {
            caplet,
            downstreamUri: "file:///README.md",
            uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
            resource: {
              uri: "file:///README.md",
              name: "README",
              description: "README resource.",
              mimeType: "text/markdown",
              size: 42,
            },
          },
        ],
        directResourceTemplates: [
          {
            caplet,
            downstreamUriTemplate: "file:///{path}",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            resourceTemplate: {
              uriTemplate: "file:///{path}",
              name: "File",
              description: "File resource.",
              mimeType: "text/plain",
            },
          },
        ],
        directPrompts: [],
        hiddenCaplets: [],
      }),
    } as unknown as CapletsEngine;

    const projection = await buildAttachProjection(engine);

    expect(projection.manifest.resources).toEqual([
      expect.objectContaining({
        mimeType: "text/markdown",
        size: 42,
      }),
    ]);
    expect(projection.manifest.resourceTemplates).toEqual([
      expect.objectContaining({
        mimeType: "text/plain",
      }),
    ]);
  });

  it("returns reference-only HTTP artifacts from Attach exports", async () => {
    const http = await startPdfServer();
    try {
      const artifactDir = mkdtempSync(join(tmpdir(), "caplets-attach-artifacts-"));
      const engine = new CapletsEngine(
        sanitizeRemoteEngineOptions({
          artifactDir,
          exposeLocalArtifactPaths: true,
          watch: false,
          configLoader: () =>
            parseConfig({
              options: { exposure: "direct" },
              httpApis: {
                status: {
                  name: "Status HTTP",
                  description: "Download an Attach report.",
                  exposure: "direct",
                  baseUrl: http.baseUrl,
                  auth: { type: "none" },
                  actions: { download: { method: "GET", path: "/report" } },
                },
              },
            }),
        }),
      );

      try {
        const projection = await buildAttachProjection(engine);
        const tool = projection.manifest.tools.find((entry) => entry.name === "status__download");
        if (!tool) throw new Error("expected the HTTP Attach export");
        const result = await invokeAttachExport(engine, projection, {
          revision: projection.manifest.revision,
          kind: "tool",
          exportId: tool.exportId,
          input: {},
        });
        const structuredContent = remoteArtifact(result);
        const reference = artifactReference(result);

        expect(structuredContent).toMatchObject({
          kind: "remote-reference",
          uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
          mimeType: "application/pdf",
          byteLength: 15,
        });
        expect(structuredContent).not.toHaveProperty("path");
        expect(structuredContent).not.toHaveProperty("pathResolution");
        expect(reference).toMatchObject({
          presentation: "reference",
          reference: structuredContent.uri,
        });
        expect(reference).not.toHaveProperty("path");
        expect(reference).not.toHaveProperty("pathResolution");
      } finally {
        await engine.close();
        rmSync(artifactDir, { recursive: true, force: true });
      }
    } finally {
      await http.close();
    }
  });

  it("reads resource template exports from an explicit expanded URI", async () => {
    const engine = {
      execute: vi.fn(async () => ({ ok: true })),
      readDirectResource: vi.fn(async () => ({ contents: [{ uri: "file:///README.md" }] })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [
          {
            stableId: "resourceTemplate:docs:file:///{path}",
            exportId: "export-resource-template",
            kind: "resourceTemplate",
            uriTemplate: "caplets://docs/{path}",
            downstreamUriTemplate: "file:///{path}",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        prompts: [],
        completions: [],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-resource-template",
          {
            kind: "resourceTemplate",
            capletId: "docs",
            downstreamUriTemplate: "file:///{path}",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await expect(
      invokeAttachExport(engine, projection, {
        revision: "rev-1",
        kind: "resourceTemplate",
        exportId: "export-resource-template",
        input: { uri: "file:///README.md" },
      }),
    ).resolves.toEqual({ contents: [{ uri: "file:///README.md" }] });
    expect(engine.execute).not.toHaveBeenCalled();
    expect(engine.readDirectResource).toHaveBeenCalledWith("docs", "file:///README.md");
  });

  it("decodes advertised resource template wrapper URIs before downstream reads", async () => {
    const engine = {
      execute: vi.fn(async () => ({ ok: true })),
      readDirectResource: vi.fn(async () => ({ contents: [{ uri: "file:///README.md" }] })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [
          {
            stableId: "resourceTemplate:docs:file:///{path}",
            exportId: "export-resource-template",
            kind: "resourceTemplate",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            downstreamUriTemplate: "file:///{path}",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        prompts: [],
        completions: [],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-resource-template",
          {
            kind: "resourceTemplate",
            capletId: "docs",
            downstreamUriTemplate: "file:///{path}",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await invokeAttachExport(engine, projection, {
      revision: "rev-1",
      kind: "resourceTemplate",
      exportId: "export-resource-template",
      input: { uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md" },
    });

    expect(engine.readDirectResource).toHaveBeenCalledWith("docs", "file:///README.md");
  });

  it("rejects resource template reads outside the advertised template", async () => {
    const engine = {
      execute: vi.fn(async () => ({ ok: true })),
      readDirectResource: vi.fn(async () => ({ contents: [{ uri: "secrets:///README.md" }] })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [
          {
            stableId: "resourceTemplate:docs:file:///{path}",
            exportId: "export-resource-template",
            kind: "resourceTemplate",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            downstreamUriTemplate: "file:///{path}",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        prompts: [],
        completions: [],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-resource-template",
          {
            kind: "resourceTemplate",
            capletId: "docs",
            downstreamUriTemplate: "file:///{path}",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await expect(
      invokeAttachExport(engine, projection, {
        revision: "rev-1",
        kind: "resourceTemplate",
        exportId: "export-resource-template",
        input: { uri: "secrets:///README.md" },
      }),
    ).rejects.toMatchObject({
      code: "ATTACH_EXPORT_NOT_FOUND",
    });
    expect(engine.readDirectResource).not.toHaveBeenCalled();
  });

  it("returns request errors for malformed wrapped resource template URIs", async () => {
    const engine = {
      execute: vi.fn(async () => ({ ok: true })),
      readDirectResource: vi.fn(async () => ({ contents: [] })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [
          {
            stableId: "resourceTemplate:docs:file:///{path}",
            exportId: "export-resource-template",
            kind: "resourceTemplate",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            downstreamUriTemplate: "file:///{path}",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        prompts: [],
        completions: [],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-resource-template",
          {
            kind: "resourceTemplate",
            capletId: "docs",
            downstreamUriTemplate: "file:///{path}",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await expect(
      invokeAttachExport(engine, projection, {
        revision: "rev-1",
        kind: "resourceTemplate",
        exportId: "export-resource-template",
        input: { uri: "caplets://docs/resources/%E0%A4%A" },
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    expect(engine.readDirectResource).not.toHaveBeenCalled();
  });

  it("normalizes prompt completion refs to downstream prompt names", async () => {
    const engine = {
      execute: vi.fn(async () => ({ completion: "ok" })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [
          {
            stableId: "prompt:docs:review",
            exportId: "export-prompt",
            kind: "prompt",
            name: "docs__review",
            downstreamName: "review",
            title: "Review",
            description: "Review prompt.",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        completions: [
          {
            stableId: "completion:docs",
            exportId: "export-completion",
            kind: "completion",
            name: "docs__complete",
            capletId: "docs",
            schemaHash: null,
            shadowing: "forbid",
          },
        ],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-completion",
          {
            kind: "completion",
            capletId: "docs",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await invokeAttachExport(engine, projection, {
      revision: "rev-1",
      kind: "completion",
      exportId: "export-completion",
      input: {
        ref: { type: "prompt", name: "docs__review" },
        argument: { name: "topic", value: "attach" },
      },
    });

    expect(engine.execute).toHaveBeenCalledWith("docs", {
      operation: "complete",
      ref: { type: "prompt", name: "review" },
      argument: { name: "topic", value: "attach" },
    });
  });

  it("normalizes resource template completion refs to downstream templates", async () => {
    const engine = {
      execute: vi.fn(async () => ({ completion: "ok" })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [
          {
            stableId: "resourceTemplate:docs:file:///{path}",
            exportId: "export-resource-template",
            kind: "resourceTemplate",
            uriTemplate:
              "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
            downstreamUriTemplate: "file:///{path}",
            schemaHash: null,
            capletId: "docs",
            shadowing: "forbid",
          },
        ],
        prompts: [],
        completions: [
          {
            stableId: "completion:docs",
            exportId: "export-completion",
            kind: "completion",
            name: "docs__complete",
            capletId: "docs",
            schemaHash: null,
            shadowing: "forbid",
          },
        ],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-completion",
          {
            kind: "completion",
            capletId: "docs",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await invokeAttachExport(engine, projection, {
      revision: "rev-1",
      kind: "completion",
      exportId: "export-completion",
      input: {
        ref: {
          type: "resourceTemplate",
          uri: "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
        },
        argument: { name: "path", value: "README.md" },
      },
    });

    expect(engine.execute).toHaveBeenCalledWith("docs", {
      operation: "complete",
      ref: { type: "resourceTemplate", uri: "file:///{path}" },
      argument: { name: "path", value: "README.md" },
    });
  });

  it("keeps completion invokes on the completion operation", async () => {
    const engine = {
      execute: vi.fn(async () => ({ completion: "ok" })),
    } as unknown as CapletsEngine;
    const projection = {
      manifest: {
        version: 1,
        revision: "rev-1",
        generatedAt: new Date(0).toISOString(),
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        completions: [
          {
            stableId: "completion:docs",
            exportId: "export-completion",
            kind: "completion",
            name: "docs__complete",
            capletId: "docs",
            schemaHash: null,
            shadowing: "forbid",
          },
        ],
        codeModeCaplets: [],
        diagnostics: [],
      },
      routes: new Map([
        [
          "export-completion",
          {
            kind: "completion",
            capletId: "docs",
          },
        ],
      ]),
    } satisfies AttachProjection;

    await invokeAttachExport(engine, projection, {
      revision: "rev-1",
      kind: "completion",
      exportId: "export-completion",
      input: {
        operation: "read_resource",
        ref: { type: "prompt", name: "review" },
        argument: { name: "topic", value: "attach" },
      },
    });

    expect(engine.execute).toHaveBeenCalledWith("docs", {
      operation: "complete",
      ref: { type: "prompt", name: "review" },
      argument: { name: "topic", value: "attach" },
    });
  });
});

async function startPdfServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/pdf");
    response.end(Buffer.from("%PDF-1.7 attach"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Attach HTTP test server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function remoteArtifact(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  throw new Error("expected structured artifact content");
}

function artifactReference(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result._meta) || !isRecord(result._meta.caplets)) {
    throw new Error("expected Caplets result metadata");
  }
  const artifacts = result._meta.caplets.artifacts;
  if (Array.isArray(artifacts) && isRecord(artifacts[0])) {
    return artifacts[0];
  }
  throw new Error("expected artifact reference metadata");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
