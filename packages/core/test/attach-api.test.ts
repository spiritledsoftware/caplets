import { describe, expect, it, vi } from "vitest";
import { invokeAttachExport, type AttachProjection } from "../src/attach/api";
import type { CapletsEngine } from "../src/engine";

describe("Attach API dispatch", () => {
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
});
