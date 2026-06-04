import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      expect.objectContaining({ path: "tools/CAPLET.md" }),
      expect.objectContaining({ path: "tools/scripts/list-files.js" }),
      expect.objectContaining({ path: "weather/CAPLET.md" }),
      expect.objectContaining({ path: "weather/openapi.yaml" }),
    ]);
    await expect(source.readFile("./tools/scripts/list-files.js")).resolves.toEqual({
      path: "tools/scripts/list-files.js",
      content: fixtureFiles[3]!.content,
    });
    await expect(source.readFile("/absolute.js")).resolves.toBeUndefined();
  });

  it("parses equivalent bundle and filesystem multi-file Caplets identically", async () => {
    const bundle = await parseCapletSource(new BundleCapletSource(fixtureFiles));
    const filesystem = await parseCapletSource(new FilesystemCapletSource(writeFixtureTree()));

    expect(summary(bundle)).toEqual(summary(filesystem));
    expect(summary(bundle)).toEqual([
      {
        id: "weather",
        backend: "openapi",
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
        id: "tools",
        backend: "cli",
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
});

function summary(result: Awaited<ReturnType<typeof parseCapletSource>>) {
  expect(result.ok).toBe(true);
  return result.resolvedCaplets.map((caplet) => ({
    id: caplet.id,
    backend: caplet.backend,
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
