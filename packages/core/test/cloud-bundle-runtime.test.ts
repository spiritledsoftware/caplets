import { describe, expect, it } from "vitest";
import { BundleCapletSource, parseCapletSource } from "../src/caplet-source";
import { classifyCapletRuntimeRoute, planCapletRuntimeRoutes } from "../src/runtime-plan";

describe("neutral hosted Caplet bundle runtime", () => {
  it("validates a bundle with a CAPLET.md and companion OpenAPI file", async () => {
    const parsed = await parseCapletSource(
      new BundleCapletSource([
        {
          path: "CAPLET.md",
          content: `---
name: PyPI
description: Query Python package metadata.
openapiEndpoint:
  specPath: ./openapi.yaml
  auth:
    type: none
---

# PyPI
`,
        },
        {
          path: "openapi.yaml",
          content: `openapi: 3.1.0
info:
  title: PyPI
  version: 1.0.0
paths: {}
`,
        },
      ]),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.resolvedCaplets).toEqual([
      expect.objectContaining({
        id: "CAPLET",
        backend: "openapi",
        sourcePath: "CAPLET.md",
      }),
    ]);
    expect(
      planCapletRuntimeRoutes(
        parsed.resolvedCaplets.map((caplet) => caplet.config),
        { deployment: "hosted" },
      ),
    ).toEqual([expect.objectContaining({ id: "CAPLET", route: "worker_safe" })]);
    expect(parsed.errors).toEqual([]);
  });

  it("rejects missing local references", async () => {
    const parsed = await parseCapletSource(
      new BundleCapletSource([
        {
          path: "CAPLET.md",
          content: `---
name: Missing Spec
description: Missing OpenAPI spec file.
openapiEndpoint:
  specPath: ./missing.yaml
  auth:
    type: none
---
`,
        },
      ]),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.errors.map((error) => error.message).join("\n")).toMatch(/missing\.yaml/);
  });

  it("classifies remote-safe backends for worker execution", () => {
    expect(
      classifyCapletRuntimeRoute({
        backend: "mcp",
        transport: "http",
        url: "https://example.com/mcp",
      }),
    ).toBe("worker_safe");
    expect(classifyCapletRuntimeRoute({ backend: "http" })).toBe("worker_safe");
    expect(classifyCapletRuntimeRoute({ backend: "graphql", introspection: true })).toBe(
      "worker_safe",
    );
  });

  it("classifies process-backed and setup routes semantically", () => {
    expect(
      classifyCapletRuntimeRoute({
        backend: "mcp",
        transport: "stdio",
        command: "uvx",
      }),
    ).toBe("process");
    expect(classifyCapletRuntimeRoute({ backend: "cli", actions: {} })).toBe("process");
    expect(
      classifyCapletRuntimeRoute({
        backend: "openapi",
        setup: { commands: [{ label: "Install", command: "npm" }] },
      }),
    ).toBe("process");
    expect(
      classifyCapletRuntimeRoute({
        backend: "cli",
        projectBinding: { required: true },
        actions: {},
      }),
    ).toBe("project_bound_process");
  });
});
