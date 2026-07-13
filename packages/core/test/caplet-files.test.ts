import { describe, expect, it } from "vitest";
import { loadCapletFilesFromMap } from "../src/caplet-files";
import { CapletsError } from "../src/errors";

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
    const config = result?.config.openapiEndpoints?.pypi;
    expect(config).toEqual(
      expect.objectContaining({
        name: "PyPI",
        description: "Query Python package metadata.",
        specPath: "pypi/openapi.yaml",
      }),
    );
    expect(config).not.toHaveProperty("body");
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

  it("expands plural backend maps into runtime child ids with inherited metadata", () => {
    const result = loadCapletFilesFromMap({
      files: [
        {
          path: "google-workspace/CAPLET.md",
          content: `---
name: Google Workspace
description: Work with Google Workspace APIs.
tags: [google, workspace]
runtime:
  features: [browser]
setup:
  commands:
    - label: Parent setup
      command: parent-setup
auth:
  type: oauth2
  issuer: https://accounts.google.com
  scopes:
    - https://www.googleapis.com/auth/drive.metadata.readonly
googleDiscoveryApis:
  drive:
    name: Google Drive
    description: Search and inspect Google Drive files.
    tags: [drive]
    runtime:
      features: [docker]
      resources:
        class: large
    setup:
      verify:
        - label: Verify Drive
          command: drive-verify
    discoveryPath: ./drive.discovery.json
    includeOperations: [files.list]
  gmail:
    name: Gmail
    description: Read Gmail metadata and message headers.
    discoveryPath: ./gmail.discovery.json
    auth:
      type: oauth2
      issuer: https://accounts.google.com
      scopes:
        - https://www.googleapis.com/auth/gmail.readonly
---

# Google Workspace
`,
        },
      ],
    });

    expect(result?.paths).toEqual({
      "google-workspace__drive": "google-workspace/CAPLET.md",
      "google-workspace__gmail": "google-workspace/CAPLET.md",
    });
    expect(result?.metadata).toEqual({
      "google-workspace__drive": {
        path: "google-workspace/CAPLET.md",
        parentId: "google-workspace",
        childId: "drive",
        backend: "googleDiscovery",
      },
      "google-workspace__gmail": {
        path: "google-workspace/CAPLET.md",
        parentId: "google-workspace",
        childId: "gmail",
        backend: "googleDiscovery",
      },
    });
    const drive = result?.config.googleDiscoveryApis?.["google-workspace__drive"];
    expect(drive).toMatchObject({
      name: "Google Drive",
      description: "Search and inspect Google Drive files.",
      tags: ["google", "workspace", "drive"],
      discoveryPath: "google-workspace/drive.discovery.json",
      auth: {
        type: "oauth2",
        issuer: "https://accounts.google.com",
        scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
      },
      runtime: {
        features: ["browser", "docker"],
        resources: { class: "large" },
      },
      setup: {
        commands: [{ label: "Parent setup", command: "parent-setup" }],
        verify: [{ label: "Verify Drive", command: "drive-verify" }],
      },
    });
    expect(drive).not.toHaveProperty("body");
    expect(result?.config.googleDiscoveryApis?.["google-workspace__gmail"]).toMatchObject({
      name: "Gmail",
      discoveryPath: "google-workspace/gmail.discovery.json",
      auth: {
        type: "oauth2",
        issuer: "https://accounts.google.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
  });

  it("rejects files that mix singular and plural backend syntax", () => {
    expect(() =>
      loadCapletFilesFromMap({
        files: [
          {
            path: "mixed/CAPLET.md",
            content: `---
name: Mixed
description: Invalid mixed backend syntax.
mcpServer:
  command: single
mcpServers:
  child:
    command: child
---
`,
          },
        ],
      }),
    ).toThrow(/invalid frontmatter/);
  });

  it("rejects duplicate child ids across plural backend maps", () => {
    try {
      loadCapletFilesFromMap({
        files: [
          {
            path: "workspace/CAPLET.md",
            content: `---
name: Workspace
description: Invalid duplicate child IDs.
auth:
  type: none
googleDiscoveryApis:
  api:
    name: Google API
    description: Search Google metadata.
    discoveryPath: ./google.discovery.json
httpApis:
  api:
    name: HTTP API
    description: Search HTTP metadata.
    baseUrl: https://api.example.com
    actions:
      list:
        method: GET
        path: /items
---
`,
          },
        ],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CapletsError);
      expect(JSON.stringify((error as CapletsError).details)).toContain(
        "plural backend child ID api is already used by googleDiscoveryApis",
      );
      return;
    }
    throw new Error("Expected duplicate plural child IDs to be rejected");
  });

  it("rejects actions as a plural cliTools child id", () => {
    expect(() =>
      loadCapletFilesFromMap({
        files: [
          {
            path: "tools/CAPLET.md",
            content: `---
name: Tools
description: Invalid plural CLI child id.
cliTools:
  actions:
    actions:
      list:
        command: node
---
`,
          },
        ],
      }),
    ).toThrow(/invalid frontmatter/);
  });

  it("validates plural child entries against their backend schema", () => {
    expect(() =>
      loadCapletFilesFromMap({
        files: [
          {
            path: "workspace/CAPLET.md",
            content: `---
name: Workspace
description: Invalid plural child backend fields.
auth:
  type: oauth2
  issuer: https://accounts.google.com
googleDiscoveryApis:
  drive:
    name: Drive
    description: Search Drive metadata.
    discoveryPath: ./drive.discovery.json
    unsupportedBackendField: true
---
`,
          },
        ],
      }),
    ).toThrow(/invalid frontmatter/);
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
