import { describe, expect, it, vi } from "vitest";
import {
  buildAttachProjection,
  invokeAttachExport,
  type AttachProjection,
} from "../src/attach/api";
import type { CapletsEngine } from "../src/engine";

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

  it("uses configured Caplet shadowing policy in attach manifests", async () => {
    const caplet = {
      server: "docs",
      name: "Docs",
      description: "Docs.",
      backend: "mcp",
      command: process.execPath,
      shadowing: "allow",
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

    expect(projection.manifest.caplets).toEqual([expect.objectContaining({ shadowing: "allow" })]);
    expect(projection.manifest.codeModeCaplets).toEqual([
      expect.objectContaining({ shadowing: "allow" }),
    ]);
    expect(projection.manifest.tools).toEqual([expect.objectContaining({ shadowing: "allow" })]);
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
