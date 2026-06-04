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
