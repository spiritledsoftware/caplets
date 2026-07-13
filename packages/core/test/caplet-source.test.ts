import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleCapletSource } from "../src/caplet-source/bundle";
import { FilesystemCapletSource } from "../src/caplet-source/filesystem";
import { parseCapletSource } from "../src/caplet-source/parse";

const fixtureFiles = [
  {
    path: "./weather/CAPLET.md",
    content: `---
name: Weather
description: Query weather forecast metadata.
shadowing: namespace
openapiEndpoint:
  specPath: ./openapi.yaml
  auth:
    type: bearer
    token: \${WEATHER_TOKEN}
---

# Weather
`,
  },
  {
    path: "weather/openapi.yaml",
    content: `openapi: 3.1.0
info:
  title: Weather
  version: 1.0.0
paths: {}
`,
  },
  {
    path: "drive/CAPLET.md",
    content: `---
name: Drive
description: Query Google Drive metadata.
googleDiscoveryApi:
  discoveryPath: ./drive.discovery.json
  auth:
    type: oauth2
    issuer: https://accounts.google.com
    scopes:
      - https://www.googleapis.com/auth/drive.metadata.readonly
---

# Drive
`,
  },
  {
    path: "drive/drive.discovery.json",
    content: `{
  "kind": "discovery#restDescription",
  "name": "drive",
  "version": "v3"
}
`,
  },
  {
    path: "tools/CAPLET.md",
    content: `---
name: Project Tools
description: Run project maintenance tools.
setup:
  commands:
    - label: Install tools
      command: pnpm
      args: [install]
cliTools:
  projectBinding:
    required: true
  runtime:
    features: [docker]
    resources:
      class: heavy
  actions:
    list_files:
      description: List project files.
      command: npx
      args: [-y, "@playwright/mcp", ./scripts/list-files.js]
---

# Project Tools
`,
  },
  {
    path: "tools/scripts/list-files.js",
    content: "console.log(JSON.stringify(process.argv.slice(2)));\n",
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CapletSource adapters", () => {
  it("list and read normalized relative files for bundles", async () => {
    const source = new BundleCapletSource(fixtureFiles);

    await expect(source.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: "drive/CAPLET.md" }),
      expect.objectContaining({ path: "drive/drive.discovery.json" }),
      expect.objectContaining({ path: "tools/CAPLET.md" }),
      expect.objectContaining({ path: "tools/scripts/list-files.js" }),
      expect.objectContaining({ path: "weather/CAPLET.md" }),
      expect.objectContaining({ path: "weather/openapi.yaml" }),
    ]);
    await expect(source.readFile("./weather\\openapi.yaml")).resolves.toEqual({
      path: "weather/openapi.yaml",
      content: fixtureFiles[1]!.content,
    });
    await expect(source.readFile("../outside.yaml")).resolves.toBeUndefined();
  });

  it("list and read normalized relative files for filesystems", async () => {
    const root = writeFixtureTree();
    const source = new FilesystemCapletSource(root);

    await expect(source.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: "drive/CAPLET.md" }),
      expect.objectContaining({ path: "drive/drive.discovery.json" }),
      expect.objectContaining({ path: "tools/CAPLET.md" }),
      expect.objectContaining({ path: "tools/scripts/list-files.js" }),
      expect.objectContaining({ path: "weather/CAPLET.md" }),
      expect.objectContaining({ path: "weather/openapi.yaml" }),
    ]);
    await expect(source.readFile("./tools/scripts/list-files.js")).resolves.toEqual({
      path: "tools/scripts/list-files.js",
      content: fixtureFiles[5]!.content,
    });
    await expect(source.readFile("/absolute.js")).resolves.toBeUndefined();
  });

  it("does not replace source paths with directory-symlink aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-source-symlink-"));
    tempDirs.push(root);
    mkdirSync(join(root, "sourcegraph"), { recursive: true });
    mkdirSync(join(root, "toolkit", "caplets"), { recursive: true });
    writeFileSync(
      join(root, "sourcegraph", "CAPLET.md"),
      "---\nname: Sourcegraph\ndescription: Search source code.\nmcpServer:\n  url: https://example.com/mcp\n---\n",
    );
    writeFileSync(
      join(root, "toolkit", "CAPLET.md"),
      "---\nname: Toolkit\ndescription: Group source tools.\ncapletSet:\n  capletsRoot: ./caplets\n---\n",
    );
    symlinkSync(join(root, "sourcegraph"), join(root, "toolkit", "caplets", "sourcegraph"), "dir");

    const source = new FilesystemCapletSource(root);

    await expect(source.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: "sourcegraph/CAPLET.md" }),
      expect.objectContaining({ path: "toolkit/CAPLET.md" }),
    ]);
    expect(source.declaredInputReader().list("toolkit/caplets")).toEqual(
      expect.objectContaining({
        state: "present",
        paths: ["toolkit/caplets/sourcegraph/CAPLET.md"],
      }),
    );
  });

  it("parses equivalent bundle and filesystem multi-file Caplets identically", async () => {
    const bundle = await parseCapletSource(new BundleCapletSource(fixtureFiles));
    const filesystem = await parseCapletSource(new FilesystemCapletSource(writeFixtureTree()));

    expect(summary(bundle)).toEqual(summary(filesystem));
    expect(summary(bundle)).toEqual([
      {
        id: "weather",
        backend: "openapi",
        shadowing: "namespace",
        setupRequired: false,
        authRequired: true,
        projectBindingRequired: false,
        runtime: {
          route: "worker_safe",
          setupTarget: undefined,
          features: [],
          resources: { class: "small", cpu: 1, memoryMb: 1024, diskMb: 4096 },
        },
        localReferences: [{ path: "weather/openapi.yaml", exists: true }],
      },
      {
        id: "drive",
        backend: "googleDiscovery",
        shadowing: "forbid",
        setupRequired: false,
        authRequired: true,
        projectBindingRequired: false,
        runtime: {
          route: "worker_safe",
          setupTarget: undefined,
          features: [],
          resources: { class: "small", cpu: 1, memoryMb: 1024, diskMb: 4096 },
        },
        localReferences: [{ path: "drive/drive.discovery.json", exists: true }],
      },
      {
        id: "tools",
        backend: "cli",
        shadowing: "forbid",
        setupRequired: true,
        authRequired: false,
        projectBindingRequired: true,
        runtime: {
          route: "project_bound_process",
          setupTarget: "hosted_sandbox",
          features: ["docker", "browser"],
          resources: { class: "heavy", cpu: 8, memoryMb: 16384, diskMb: 40960 },
        },
        localReferences: [],
      },
    ]);
  });

  it("reports missing local references through shared parser semantics", async () => {
    const result = await parseCapletSource(
      new BundleCapletSource(fixtureFiles.filter((file) => file.path !== "weather/openapi.yaml")),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toMatch(
      /weather\/openapi\.yaml/,
    );
  });

  it("preserves parent and child source metadata for plural Caplet files", async () => {
    const result = await parseCapletSource(
      new BundleCapletSource([
        {
          path: "workspace/CAPLET.md",
          content: `---
name: Workspace
description: Work with several workspace APIs.
auth:
  type: oauth2
  issuer: https://accounts.google.com
googleDiscoveryApis:
  drive:
    name: Drive
    description: Search Drive files and folders.
    discoveryPath: ./drive.discovery.json
  gmail:
    name: Gmail
    description: Search Gmail messages and labels.
    discoveryPath: ./gmail.discovery.json
---

# Workspace
`,
        },
        {
          path: "workspace/drive.discovery.json",
          content: `{"kind":"discovery#restDescription","name":"drive","version":"v3"}`,
        },
        {
          path: "workspace/gmail.discovery.json",
          content: `{"kind":"discovery#restDescription","name":"gmail","version":"v1"}`,
        },
      ]),
    );

    expect(result.ok).toBe(true);
    expect(
      result.resolvedCaplets.map((caplet) => ({
        id: caplet.id,
        parentId: caplet.parentId,
        childId: caplet.childId,
        sourcePath: caplet.sourcePath,
        localReferences: caplet.localReferences,
      })),
    ).toEqual([
      {
        id: "workspace__drive",
        parentId: "workspace",
        childId: "drive",
        sourcePath: "workspace/CAPLET.md",
        localReferences: [{ path: "workspace/drive.discovery.json", exists: true }],
      },
      {
        id: "workspace__gmail",
        parentId: "workspace",
        childId: "gmail",
        sourcePath: "workspace/CAPLET.md",
        localReferences: [{ path: "workspace/gmail.discovery.json", exists: true }],
      },
    ]);
  });
});

function summary(result: Awaited<ReturnType<typeof parseCapletSource>>) {
  expect(result.ok).toBe(true);
  return result.resolvedCaplets.map((caplet) => ({
    id: caplet.id,
    backend: caplet.backend,
    shadowing: caplet.config.shadowing,
    setupRequired: caplet.setupRequired,
    authRequired: caplet.authRequired,
    projectBindingRequired: caplet.projectBindingRequired,
    runtime: {
      route: caplet.runtime.route,
      setupTarget: caplet.runtime.setupTarget,
      features: caplet.runtime.features,
      resources: caplet.runtime.resources,
    },
    localReferences: caplet.localReferences,
  }));
}

function writeFixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-source-"));
  tempDirs.push(root);
  for (const file of fixtureFiles) {
    const normalized = file.path.replace(/^\.\//u, "");
    const path = join(root, normalized);
    mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(path, file.content, "utf8");
  }
  return root;
}
