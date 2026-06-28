import { describe, expect, it } from "vitest";
import { loadCapletFilesFromMap } from "../src/caplet-files";

describe("in-memory Caplet files", () => {
  it("loads directory CAPLET.md files from an in-memory map", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "pypi/CAPLET.md",
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
      ],
    });

    expect(result?.paths).toEqual({ pypi: "pypi/CAPLET.md" });
    expect(result?.config.openapiEndpoints?.pypi).toEqual(
      expect.objectContaining({
        name: "PyPI",
        description: "Query Python package metadata.",
        specPath: "pypi/openapi.yaml",
        body: "\n# PyPI\n",
      }),
    );
  });

  it("loads top-level exposure from CAPLET.md frontmatter", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "github/CAPLET.md",
          content: `---
name: GitHub
description: Manage GitHub repositories.
exposure: direct_and_code_mode
mcpServer:
  command: github-mcp
---

# GitHub
`,
        },
      ],
    });

    expect(result?.config.mcpServers?.github).toEqual(
      expect.objectContaining({
        exposure: "direct_and_code_mode",
      }),
    );
  });

  it("loads top-level shadowing from CAPLET.md frontmatter", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "github/CAPLET.md",
          content: `---
name: GitHub
description: Manage GitHub repositories.
shadowing: allow
mcpServer:
  command: github-mcp
---

# GitHub
`,
        },
      ],
    });

    expect(result?.config.mcpServers?.github).toEqual(
      expect.objectContaining({
        shadowing: "allow",
      }),
    );
  });

  it("loads namespace shadowing from CAPLET.md frontmatter", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "github/CAPLET.md",
          content: `---
name: GitHub
description: Manage GitHub repositories.
shadowing: namespace
mcpServer:
  command: github-mcp
---

# GitHub
`,
        },
      ],
    });

    expect(result?.config.mcpServers?.github).toEqual(
      expect.objectContaining({
        shadowing: "namespace",
      }),
    );
  });

  it("accepts catalog icon metadata without exposing it to runtime config", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "github/CAPLET.md",
          content: `---
name: GitHub
description: Manage GitHub repositories.
catalog:
  icon: ./icon.svg
mcpServer:
  command: github-mcp
---

# GitHub
`,
        },
      ],
    });

    expect(result?.config.mcpServers?.github).toEqual(
      expect.not.objectContaining({
        catalog: expect.anything(),
      }),
    );
  });

  it("rejects unsafe catalog icon metadata", () => {
    expect(() =>
      loadCapletFilesFromMap({
        files: [
          {
            path: "github/CAPLET.md",
            content: `---
name: GitHub
description: Manage GitHub repositories.
catalog:
  icon: http://example.com/icon.svg
mcpServer:
  command: github-mcp
---

# GitHub
`,
          },
        ],
      }),
    ).toThrow(/invalid frontmatter/);
  });

  it("rejects duplicate in-memory caplet ids", () => {
    expect(() =>
      loadCapletFilesFromMap({
        files: [
          { path: "search.md", content: caplet("Search A") },
          { path: "search/CAPLET.md", content: caplet("Search B") },
        ],
      }),
    ).toThrow(/Duplicate Caplet ID search/);
  });
});

function caplet(name: string): string {
  return `---
name: ${name}
description: Search project resources.
httpApi:
  baseUrl: https://example.com
  auth:
    type: none
  actions:
    list:
      method: GET
      path: /list
---
`;
}
