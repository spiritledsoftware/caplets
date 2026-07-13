import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BundleCapletSource } from "../src/caplet-source/bundle";
import { FilesystemCapletSource } from "../src/caplet-source/filesystem";
import { parseCapletSource } from "../src/caplet-source/parse";
import {
  createMemoryDeclaredInputReader,
  createRuntimeFingerprintSnapshot,
  resolvedExecutionFingerprintForConfig,
} from "../src/caplet-source/runtime-fingerprint";
import { runCapletSetupCli } from "../src/cli/setup-caplet";
import { createCloudRuntimeAdapter } from "../src/cloud/runtime-adapter";
import { loadConfigWithSources } from "../src/config";
import { LocalSetupStore } from "../src/setup/local-store";
import { parseConfig } from "../src/config-runtime";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runtime fingerprints", () => {
  it("domain-separates private resolved-execution equality from stable fingerprints", () => {
    const config = parseConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
          env: { TOKEN: "first-secret" },
        },
      },
    });
    const same = parseConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
          env: { TOKEN: "first-secret" },
        },
      },
    });
    const rotated = parseConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha project documents.",
          command: process.execPath,
          env: { TOKEN: "second-secret" },
        },
      },
    });
    const stable = createRuntimeFingerprintSnapshot({
      config,
      provenance: {},
      reader: createMemoryDeclaredInputReader({}),
    });
    const resolved = resolvedExecutionFingerprintForConfig(config);

    expect(resolved).toBe(resolvedExecutionFingerprintForConfig(same));
    expect(resolved).not.toBe(resolvedExecutionFingerprintForConfig(rotated));
    expect(resolved).not.toBe(stable.hostConfigurationFingerprint);
    expect(resolved).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is body-blind, semantic, source-root independent, and adapter-consistent", async () => {
    const first = [
      {
        path: "weather/CAPLET.md",
        content: `---
name: Weather
# formatting and key order are not semantics
description: Inspect weather forecasts.
openapiEndpoint:
  auth: { type: none }
  specPath: ./openapi.yaml
---
# Operator notes
First README.
`,
      },
      {
        path: "weather/openapi.yaml",
        content: "openapi: 3.1.0\ninfo: {title: Weather, version: 1.0.0}\npaths: {}\n",
      },
    ];
    const second = [
      {
        path: "weather/CAPLET.md",
        content: `---
description: Inspect weather forecasts.
openapiEndpoint:
  specPath: ././openapi.yaml
  auth:
    type: none
name: Weather
---
# Entirely different README
Troubleshooting only.
`,
      },
      first[1]!,
    ];

    const firstBundle = await parseCapletSource(new BundleCapletSource(first));
    const secondBundle = await parseCapletSource(new BundleCapletSource(second));
    const root = writeTree(first);
    const filesystem = await parseCapletSource(new FilesystemCapletSource(root));

    expect(firstBundle.runtimeFingerprint).toEqual(secondBundle.runtimeFingerprint);
    expect(firstBundle.runtimeFingerprint).toEqual(filesystem.runtimeFingerprint);
    expect(firstBundle.runtimeFingerprint?.version).toBe(1);
    expect(firstBundle.runtimeFingerprint?.caplets.weather?.declaredInputs).toEqual([
      expect.objectContaining({
        kind: "openapi",
        logicalPath: "weather/openapi.yaml",
        state: "present",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
  });

  it("changes only the applicable scopes for declared inputs, child semantics, and host options", () => {
    const base = parseConfig({
      defaultSearchLimit: 20,
      maxSearchLimit: 50,
      options: { exposure: "code_mode" },
      openapiEndpoints: {
        weather: {
          name: "Weather",
          description: "Inspect weather forecasts.",
          specPath: "weather/openapi.yaml",
          auth: { type: "none" },
        },
      },
      httpApis: {
        status: {
          name: "Status",
          description: "Inspect service status safely.",
          baseUrl: "https://status.example.com",
          auth: { type: "none" },
          actions: { get: { method: "GET", path: "/status" } },
        },
      },
    });
    const provenance = {
      weather: { parentId: "weather", sourcePath: "weather/CAPLET.md" },
      status: { parentId: "status", sourcePath: "status/CAPLET.md" },
    };
    const first = createRuntimeFingerprintSnapshot({
      config: base,
      provenance,
      reader: createMemoryDeclaredInputReader({ "weather/openapi.yaml": "first" }),
    });
    const inputChanged = createRuntimeFingerprintSnapshot({
      config: base,
      provenance,
      reader: createMemoryDeclaredInputReader({ "weather/openapi.yaml": "second" }),
    });
    const hostChanged = createRuntimeFingerprintSnapshot({
      config: { ...base, options: { ...base.options, defaultSearchLimit: 21 } },
      provenance,
      reader: createMemoryDeclaredInputReader({ "weather/openapi.yaml": "first" }),
    });

    expect(inputChanged.caplets.weather?.fingerprint).not.toBe(first.caplets.weather?.fingerprint);
    expect(inputChanged.caplets.status?.fingerprint).toBe(first.caplets.status?.fingerprint);
    expect(inputChanged.artifactFingerprint).not.toBe(first.artifactFingerprint);
    expect(inputChanged.hostConfigurationFingerprint).not.toBe(first.hostConfigurationFingerprint);
    expect(hostChanged.caplets).toEqual(first.caplets);
    expect(hostChanged.artifactFingerprint).toBe(first.artifactFingerprint);
    expect(hostChanged.hostConfigurationFingerprint).not.toBe(first.hostConfigurationFingerprint);
  });
  it("includes every enumerated host runtime option only in the host aggregate", () => {
    const base = parseConfig({
      mcpServers: {
        tool: {
          name: "Tool",
          description: "Run one stable host option test tool.",
          command: "tool",
        },
      },
    });
    const variants = [
      { ...base, options: { ...base.options, defaultSearchLimit: 21 } },
      { ...base, options: { ...base.options, maxSearchLimit: 49 } },
      { ...base, options: { ...base.options, exposure: "direct" as const } },
      { ...base, options: { ...base.options, exposureDiscoveryTimeoutMs: 16_000 } },
      { ...base, options: { ...base.options, exposureDiscoveryConcurrency: 5 } },
      {
        ...base,
        options: {
          ...base.options,
          completion: { ...base.options.completion, discoveryTimeoutMs: 751 },
        },
      },
      {
        ...base,
        options: {
          ...base.options,
          completion: { ...base.options.completion, overallTimeoutMs: 1_501 },
        },
      },
      {
        ...base,
        options: {
          ...base.options,
          completion: { ...base.options.completion, cacheTtlMs: 300_001 },
        },
      },
      {
        ...base,
        options: {
          ...base.options,
          completion: { ...base.options.completion, negativeCacheTtlMs: 30_001 },
        },
      },
      { ...base, namespaceAliases: { local: "local", upstreams: {} } },
      { ...base, namespaceAliases: { upstreams: { source: "upstream" } } },
      Object.assign(structuredClone(base), { telemetry: false }),
      Object.assign(structuredClone(base), { serve: { host: "127.0.0.1" } }),
      Object.assign(structuredClone(base), { serve: { port: 5387 } }),
      Object.assign(structuredClone(base), { serve: { path: "/caplets" } }),
      Object.assign(structuredClone(base), { serve: { remoteStatePath: "/private/state" } }),
      Object.assign(structuredClone(base), {
        serve: { upstreamUrl: "https://upstream.example.com" },
      }),
      Object.assign(structuredClone(base), { serve: { allowUnauthenticatedHttp: true } }),
      Object.assign(structuredClone(base), { serve: { trustProxy: true } }),
      Object.assign(structuredClone(base), {
        serve: { publicOrigins: ["https://public.example.com"] },
      }),
    ];
    const provenance = { tool: { parentId: "tool", sourcePath: "tool/CAPLET.md" } };
    const first = createRuntimeFingerprintSnapshot({
      config: base,
      provenance,
      reader: createMemoryDeclaredInputReader({}),
    });

    for (const variant of variants) {
      const changed = createRuntimeFingerprintSnapshot({
        config: variant,
        provenance,
        reader: createMemoryDeclaredInputReader({}),
      });
      expect(changed.caplets).toEqual(first.caplets);
      expect(changed.artifactFingerprint).toBe(first.artifactFingerprint);
      expect(changed.hostConfigurationFingerprint).not.toBe(first.hostConfigurationFingerprint);
    }
  });

  it("changes fingerprints for every runtime semantic family", () => {
    const base = parseConfig({
      mcpServers: {
        tool: {
          name: "Tool",
          description: "Run a stable remote tool safely.",
          useWhen: "Use for stable work.",
          avoidWhen: "Avoid for unstable work.",
          tags: ["stable"],
          exposure: "code_mode",
          shadowing: "forbid",
          url: "https://tool.example.com/mcp",
          auth: { type: "bearer", token: "$env:TOOL_TOKEN" },
          setup: { commands: [{ label: "Install", command: "install-tool" }] },
          projectBinding: { required: true },
          runtime: { features: ["browser"], resources: { class: "large" } },
          startupTimeoutMs: 10_000,
          callTimeoutMs: 60_000,
          toolCacheTtlMs: 30_000,
        },
      },
    });
    const variants = [
      { description: "Run a changed remote tool safely." },
      { useWhen: "Use for changed work." },
      { avoidWhen: "Avoid for changed work." },
      { tags: ["changed"] },
      { exposure: "direct" as const },
      { shadowing: "allow" as const },
      { url: "https://changed.example.com/mcp" },
      { auth: { type: "bearer" as const, token: "$vault:TOOL_TOKEN" } },
      { setup: { commands: [{ label: "Install", command: "install-tool-v2" }] } },
      { projectBinding: undefined },
      { runtime: { features: ["docker" as const], resources: { class: "heavy" as const } } },
      { startupTimeoutMs: 10_001 },
      { callTimeoutMs: 60_001 },
      { toolCacheTtlMs: 30_001 },
    ];
    const provenance = { tool: { parentId: "tool", sourcePath: "tool/CAPLET.md" } };
    const first = createRuntimeFingerprintSnapshot({
      config: base,
      provenance,
      reader: createMemoryDeclaredInputReader({}),
    });

    for (const change of variants) {
      const changedConfig = structuredClone(base);
      Object.assign(changedConfig.mcpServers.tool!, change);
      const changed = createRuntimeFingerprintSnapshot({
        config: changedConfig,
        provenance,
        reader: createMemoryDeclaredInputReader({}),
      });
      expect(changed.caplets.tool?.fingerprint).not.toBe(first.caplets.tool?.fingerprint);
      expect(changed.artifactFingerprint).not.toBe(first.artifactFingerprint);
      expect(changed.hostConfigurationFingerprint).not.toBe(first.hostConfigurationFingerprint);
    }
  });

  it("retains live-only identity for literal credentials, headers, and environment values", () => {
    const config = parseConfig({
      mcpServers: {
        token: {
          name: "Token",
          description: "Use a literal bearer credential.",
          url: "https://token.example.com/mcp",
          auth: { type: "bearer", token: "token-a" },
        },
        headers: {
          name: "Headers",
          description: "Use a literal custom header.",
          url: "https://headers.example.com/mcp",
          auth: { type: "headers", headers: { "X-Feature": "feature-a" } },
        },
        environment: {
          name: "Environment",
          description: "Use a literal process environment value.",
          command: "environment-tool",
          env: { MODE: "mode-a" },
        },
        oauth: {
          name: "OAuth",
          description: "Use a literal OAuth client credential.",
          url: "https://oauth.example.com/mcp",
          auth: { type: "oauth2", clientSecret: "client-a" },
        },
      },
    });
    const provenance = Object.fromEntries(
      ["token", "headers", "environment", "oauth"].map((id) => [
        id,
        { parentId: id, sourcePath: `${id}/CAPLET.md` },
      ]),
    );
    const first = createRuntimeFingerprintSnapshot({
      config,
      provenance,
      reader: createMemoryDeclaredInputReader({}),
    });
    const variants = [
      [
        "token",
        (next: typeof config) => {
          next.mcpServers.token!.auth = { type: "bearer", token: "token-b" };
        },
      ],
      [
        "headers",
        (next: typeof config) => {
          next.mcpServers.headers!.auth = {
            type: "headers",
            headers: { "X-Feature": "feature-b" },
          };
        },
      ],
      [
        "environment",
        (next: typeof config) => {
          next.mcpServers.environment!.env = { MODE: "mode-b" };
        },
      ],
      [
        "oauth",
        (next: typeof config) => {
          next.mcpServers.oauth!.auth = { type: "oauth2", clientSecret: "client-b" };
        },
      ],
    ] as const;

    for (const [id, mutate] of variants) {
      const changedConfig = structuredClone(config);
      mutate(changedConfig);
      const changed = createRuntimeFingerprintSnapshot({
        config: changedConfig,
        provenance,
        reader: createMemoryDeclaredInputReader({}),
      });
      expect(changed.caplets[id]?.fingerprint).not.toBe(first.caplets[id]?.fingerprint);
      expect(changed.caplets[id]?.persistenceEligible).toBe(false);
    }
    const serialized = JSON.stringify(first);
    for (const value of ["token-a", "feature-a", "mode-a", "client-a"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("scopes shared and child-local changes across a multi-backend artifact", async () => {
    const caplet = (description: string, actionPath = "/items") => `---
name: Workspace
description: ${description}
auth: { type: none }
googleDiscoveryApis:
  drive:
    name: Drive
    discoveryPath: ./drive.json
httpApis:
  status:
    name: Status
    baseUrl: https://status.example.com
    actions:
      list:
        method: GET
        path: ${actionPath}
---
README
`;
    const parse = async (content: string) =>
      await parseCapletSource(
        new BundleCapletSource([
          { path: "workspace/CAPLET.md", content },
          { path: "workspace/drive.json", content: '{"name":"drive","version":"v3"}' },
        ]),
      );
    const first = await parse(caplet("Work with several workspace APIs."));
    const sharedChanged = await parse(caplet("Work with changed workspace APIs."));
    const childChanged = await parse(caplet("Work with several workspace APIs.", "/changed"));

    expect(sharedChanged.runtimeFingerprint?.caplets["workspace__drive"]?.fingerprint).not.toBe(
      first.runtimeFingerprint?.caplets["workspace__drive"]?.fingerprint,
    );
    expect(sharedChanged.runtimeFingerprint?.caplets["workspace__status"]?.fingerprint).not.toBe(
      first.runtimeFingerprint?.caplets["workspace__status"]?.fingerprint,
    );
    expect(childChanged.runtimeFingerprint?.caplets["workspace__drive"]?.fingerprint).toBe(
      first.runtimeFingerprint?.caplets["workspace__drive"]?.fingerprint,
    );
    expect(childChanged.runtimeFingerprint?.caplets["workspace__status"]?.fingerprint).not.toBe(
      first.runtimeFingerprint?.caplets["workspace__status"]?.fingerprint,
    );
    expect(childChanged.runtimeFingerprint?.artifactFingerprint).not.toBe(
      first.runtimeFingerprint?.artifactFingerprint,
    );
  });

  it("distinguishes safe missing and unreadable inputs without leaking private details", () => {
    const config = parseConfig({
      graphqlEndpoints: {
        graph: {
          name: "Graph",
          description: "Query a private graph endpoint.",
          endpointUrl: "https://graph.example.com/graphql",
          schemaPath: "graph/schema.graphql",
          operations: {
            present: { documentPath: "graph/present.graphql" },
            missing: { documentPath: "graph/missing.graphql" },
            unreadable: { documentPath: "graph/unreadable.graphql" },
          },
          auth: { type: "none" },
        },
      },
    });
    const snapshot = createRuntimeFingerprintSnapshot({
      config,
      provenance: { graph: { parentId: "graph", sourcePath: "graph/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({
        "graph/schema.graphql": "type Query { ok: Boolean! }",
        "graph/present.graphql": "query Present { ok }",
        "graph/unreadable.graphql": { state: "unreadable", privateKey: "/private/root/EACCES" },
      }),
    });
    const serialized = JSON.stringify(snapshot);

    expect(
      snapshot.caplets.graph?.declaredInputs.map(({ logicalPath, state }) => ({
        logicalPath,
        state,
      })),
    ).toEqual([
      { logicalPath: "graph/missing.graphql", state: "missing" },
      { logicalPath: "graph/present.graphql", state: "present" },
      { logicalPath: "graph/schema.graphql", state: "present" },
      { logicalPath: "graph/unreadable.graphql", state: "unreadable" },
    ]);
    expect(serialized).not.toContain("/private/root");
    expect(serialized).not.toContain("EACCES");
  });

  it("tracks every Discovery and GraphQL declared input independently", () => {
    const config = parseConfig({
      googleDiscoveryApis: {
        drive: {
          name: "Drive",
          description: "Search Drive resources safely.",
          discoveryPath: "drive/discovery.json",
          auth: { type: "none" },
        },
      },
      graphqlEndpoints: {
        graph: {
          name: "Graph",
          description: "Query a GraphQL service safely.",
          endpointUrl: "https://graph.example.com/graphql",
          schemaPath: "graph/schema.graphql",
          operations: {
            viewer: { documentPath: "graph/viewer.graphql" },
          },
          auth: { type: "none" },
        },
      },
    });
    const provenance = {
      drive: { parentId: "drive", sourcePath: "drive/CAPLET.md" },
      graph: { parentId: "graph", sourcePath: "graph/CAPLET.md" },
    };
    const files = {
      "drive/discovery.json": '{"name":"drive","version":"v3"}',
      "graph/schema.graphql": "type Query { viewer: String }",
      "graph/viewer.graphql": "query Viewer { viewer }",
    };
    const first = createRuntimeFingerprintSnapshot({
      config,
      provenance,
      reader: createMemoryDeclaredInputReader(files),
    });

    for (const logicalPath of Object.keys(files)) {
      const changed = createRuntimeFingerprintSnapshot({
        config,
        provenance,
        reader: createMemoryDeclaredInputReader({
          ...files,
          [logicalPath]: `${files[logicalPath as keyof typeof files]} changed`,
        }),
      });
      const runtimeId = logicalPath.startsWith("drive/") ? "drive" : "graph";
      expect(changed.caplets[runtimeId]?.fingerprint, logicalPath).not.toBe(
        first.caplets[runtimeId]?.fingerprint,
      );
    }
  });

  it("fails persistence eligibility closed for literal secrets and absolute host values", () => {
    const template = parseConfig({
      mcpServers: {
        safe: {
          name: "Safe",
          description: "Use portable secret references.",
          url: "https://safe.example.com/mcp",
          auth: { type: "bearer", token: "$vault:SAFE_TOKEN" },
        },
        literal: {
          name: "Literal",
          description: "Use a literal secret value.",
          url: "https://literal.example.com/mcp",
          auth: { type: "bearer", token: "secret-value" },
        },
        absolute: {
          name: "Absolute",
          description: "Use an absolute host executable.",
          command: "/opt/private/bin/tool",
        },
        windowsAbsolute: {
          name: "Windows absolute",
          description: "Use an absolute Windows host executable.",
          command: "C:\\private\\bin\\tool.exe",
        },
      },
    });
    const provenance = Object.fromEntries(
      ["safe", "literal", "absolute", "windowsAbsolute"].map((id) => [
        id,
        { parentId: id, sourcePath: `${id}/CAPLET.md` },
      ]),
    );
    const snapshot = createRuntimeFingerprintSnapshot({
      config: template,
      provenance,
      reader: createMemoryDeclaredInputReader({}),
    });
    const retargetedTemplate = structuredClone(template);
    retargetedTemplate.mcpServers.absolute!.command = "/opt/private/bin/other-tool";
    const retargeted = createRuntimeFingerprintSnapshot({
      config: retargetedTemplate,
      provenance,
      reader: createMemoryDeclaredInputReader({}),
    });

    expect(snapshot.caplets.safe?.persistenceEligible).toBe(true);
    expect(snapshot.caplets.literal?.persistenceEligible).toBe(false);
    expect(snapshot.caplets.absolute?.persistenceEligible).toBe(false);
    expect(snapshot.caplets.windowsAbsolute?.persistenceEligible).toBe(false);
    expect(retargeted.caplets.absolute?.fingerprint).not.toBe(
      snapshot.caplets.absolute?.fingerprint,
    );
    expect(snapshot.persistenceEligible).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
    expect(JSON.stringify(snapshot)).not.toContain("/opt/private");
    expect(JSON.stringify(snapshot)).not.toContain("C:\\private");
    expect(JSON.stringify(retargeted)).not.toContain("/opt/private");
  });

  it("keeps Vault resolution values outside stable and persistable snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-vault-fingerprint-"));
    tempDirs.push(root);
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          vault: {
            name: "Vault",
            description: "Use a Vault-backed bearer credential.",
            url: "https://vault.example.com/mcp",
            auth: { type: "bearer", token: "$vault:RUNTIME_TOKEN" },
          },
        },
      }),
      "utf8",
    );
    const first = loadConfigWithSources(configPath, projectConfigPath, {
      vaultResolver: () => ({ storedKey: "first", value: "resolved-vault-secret-one" }),
    }).runtimeFingerprint;
    const second = loadConfigWithSources(configPath, projectConfigPath, {
      vaultResolver: () => ({ storedKey: "second", value: "resolved-vault-secret-two" }),
    }).runtimeFingerprint;

    expect(first).toEqual(second);
    expect(first?.caplets.vault?.persistenceEligible).toBe(true);
    expect(JSON.stringify(first)).not.toContain("resolved-vault-secret-one");
    expect(JSON.stringify(second)).not.toContain("resolved-vault-secret-two");
  });

  it("hashes explicitly absolute declared inputs live without exposing their host path", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-absolute-fingerprint-"));
    tempDirs.push(root);
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");
    const specPath = join(root, "openapi.yaml");
    writeFileSync(specPath, "first", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        openapiEndpoints: {
          absolute: {
            name: "Absolute",
            description: "Read an explicitly absolute OpenAPI input.",
            specPath,
            auth: { type: "none" },
          },
        },
      }),
      "utf8",
    );
    const first = loadConfigWithSources(configPath, projectConfigPath).runtimeFingerprint;
    writeFileSync(specPath, "second", "utf8");
    const second = loadConfigWithSources(configPath, projectConfigPath).runtimeFingerprint;
    const retargetedSpecPath = join(root, "retargeted-openapi.yaml");
    writeFileSync(retargetedSpecPath, "second", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        openapiEndpoints: {
          absolute: {
            name: "Absolute",
            description: "Read an explicitly absolute OpenAPI input.",
            specPath: retargetedSpecPath,
            auth: { type: "none" },
          },
        },
      }),
      "utf8",
    );
    const retargeted = loadConfigWithSources(configPath, projectConfigPath).runtimeFingerprint;

    expect(first?.caplets.absolute?.persistenceEligible).toBe(false);
    expect(first?.caplets.absolute?.declaredInputs).toEqual([
      expect.objectContaining({
        logicalPath: "@absolute/openapi",
        state: "present",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(second?.caplets.absolute?.fingerprint).not.toBe(first?.caplets.absolute?.fingerprint);
    expect(retargeted?.caplets.absolute?.fingerprint).not.toBe(
      second?.caplets.absolute?.fingerprint,
    );
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(second)).not.toContain(root);
    expect(JSON.stringify(retargeted)).not.toContain(root);
  });

  it("recurses through explicitly absolute Caplet-set inputs without persisting host identity", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-absolute-set-fingerprint-"));
    tempDirs.push(root);
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");
    const nestedConfigPath = join(root, "nested.json");
    const nestedRoot = join(root, "nested-caplets");
    mkdirSync(join(nestedRoot, "file-child"), { recursive: true });
    writeFileSync(
      join(nestedRoot, "file-child", "CAPLET.md"),
      `---
name: File child
description: Load a discovered nested child.
mcpServer:
  command: file-child
---
README
`,
      "utf8",
    );
    const writeNestedConfig = (command: string): void => {
      writeFileSync(
        nestedConfigPath,
        JSON.stringify({
          mcpServers: {
            configured: {
              name: "Configured child",
              description: "Load a configured nested child.",
              command,
            },
          },
        }),
        "utf8",
      );
    };
    writeNestedConfig("first");
    writeFileSync(
      configPath,
      JSON.stringify({
        capletSets: {
          workspace: {
            name: "Workspace",
            description: "Expose an absolute nested Caplet collection.",
            configPath: nestedConfigPath,
            capletsRoot: nestedRoot,
          },
        },
      }),
      "utf8",
    );
    const first = loadConfigWithSources(configPath, projectConfigPath).runtimeFingerprint;
    writeNestedConfig("second");
    const second = loadConfigWithSources(configPath, projectConfigPath).runtimeFingerprint;

    expect(first?.caplets.workspace?.persistenceEligible).toBe(false);
    expect(first?.caplets.workspace?.declaredInputs).toEqual([
      expect.objectContaining({ logicalPath: "@absolute/caplet-config", state: "present" }),
      expect.objectContaining({ logicalPath: "@absolute/caplets-root", state: "present" }),
    ]);
    expect(second?.caplets.workspace?.fingerprint).not.toBe(first?.caplets.workspace?.fingerprint);
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(second)).not.toContain(root);
  });

  it("records unreadable effective Caplet-root files without leaking private identity", () => {
    const config = parseConfig({
      capletSets: {
        workspace: {
          name: "Workspace",
          description: "Expose a nested Caplet collection.",
          capletsRoot: "nested/caplets",
        },
      },
    });
    const snapshot = createRuntimeFingerprintSnapshot({
      config,
      provenance: {
        workspace: {
          parentId: "workspace",
          sourcePath: "workspace/CAPLET.md",
        },
      },
      reader: createMemoryDeclaredInputReader({
        "nested/caplets/tool.md": {
          state: "unreadable",
          privateKey: "/private/runtime/tool.md",
        },
      }),
    });

    expect(snapshot.caplets.workspace?.declaredInputs).toEqual([
      expect.objectContaining({
        kind: "caplets-root",
        logicalPath: "nested/caplets",
        state: "unreadable",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("/private/runtime");
  });

  it("fingerprints effective nested Caplet-set config and Caplet-root discovery", () => {
    const config = parseConfig({
      capletSets: {
        workspace: {
          name: "Workspace",
          description: "Expose effective nested Caplets.",
          configPath: "nested/config.json",
          capletsRoot: "nested/caplets",
        },
      },
    });
    const files = {
      "nested/config.json": JSON.stringify({
        mcpServers: {
          duplicate: {
            name: "Configured duplicate",
            description: "This configured entry loses to the Caplet file.",
            command: "configured",
          },
        },
      }),
      "nested/caplets/duplicate.md": `---\nname: File duplicate\ndescription: The discovered Caplet file wins by runtime precedence.\nmcpServer:\n  command: file-wins\n---\nREADME`,
      "nested/caplets/immediate/CAPLET.md": `---\nname: Immediate\ndescription: This immediate directory is discovered.\nmcpServer:\n  command: immediate\n---\nREADME`,
      "nested/caplets/shadowed.md": `---\nname: Shadowed flat file\ndescription: This flat file loses to the directory Caplet.\nmcpServer:\n  command: flat-loses\n---\nREADME`,
      "nested/caplets/shadowed/CAPLET.md": `---\nname: Shadowing directory\ndescription: This directory Caplet wins runtime precedence.\nmcpServer:\n  command: directory-wins\n---\nREADME`,
      "nested/caplets/deeper/ignored/CAPLET.md": `---\nname: Ignored\ndescription: This deeper directory is ignored.\nmcpServer:\n  command: ignored\n---\nREADME`,
    };
    const first = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader(files),
    });
    const ignoredChanged = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({
        ...files,
        "nested/caplets/deeper/ignored/CAPLET.md":
          files["nested/caplets/deeper/ignored/CAPLET.md"] + " changed",
      }),
    });
    const shadowedChanged = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({
        ...files,
        "nested/caplets/shadowed.md": `${files["nested/caplets/shadowed.md"]} changed`,
      }),
    });
    const effectiveChanged = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({
        ...files,
        "nested/caplets/immediate/CAPLET.md": files["nested/caplets/immediate/CAPLET.md"].replace(
          "immediate",
          "changed",
        ),
      }),
    });

    const configuredDuplicateChanged = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({
        ...files,
        "nested/config.json": files["nested/config.json"].replace("configured", "changed"),
      }),
    });

    expect(ignoredChanged.caplets.workspace?.fingerprint).toBe(
      first.caplets.workspace?.fingerprint,
    );
    expect(shadowedChanged.caplets.workspace?.fingerprint).toBe(
      first.caplets.workspace?.fingerprint,
    );
    expect(configuredDuplicateChanged.caplets.workspace?.fingerprint).toBe(
      first.caplets.workspace?.fingerprint,
    );
    expect(effectiveChanged.caplets.workspace?.fingerprint).not.toBe(
      first.caplets.workspace?.fingerprint,
    );
  });

  it("propagates nested live-only taint to the owning Caplet set", () => {
    const config = parseConfig({
      capletSets: {
        workspace: {
          name: "Workspace",
          description: "Expose a nested secret-bearing collection.",
          configPath: "nested/config.json",
        },
      },
    });
    const nestedConfig = JSON.stringify({
      mcpServers: {
        private: {
          name: "Private",
          description: "Uses a literal nested bearer credential.",
          url: "https://private.example.com/mcp",
          auth: { type: "bearer", token: "nested-literal-secret" },
        },
      },
    });
    const snapshot = createRuntimeFingerprintSnapshot({
      config,
      provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
      reader: createMemoryDeclaredInputReader({ "nested/config.json": nestedConfig }),
    });

    expect(snapshot.caplets.workspace?.persistenceEligible).toBe(false);
    expect(snapshot.persistenceEligible).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("nested-literal-secret");
  });

  it("rejects recursive Caplet-set source cycles", () => {
    const config = parseConfig({
      capletSets: {
        workspace: {
          name: "Workspace",
          description: "Expose a recursive nested collection.",
          configPath: "nested/config.json",
        },
      },
    });
    const nestedConfig = JSON.stringify({
      capletSets: {
        self: {
          name: "Self",
          description: "Points back to the same nested source.",
          configPath: "config.json",
        },
      },
    });

    expect(() =>
      createRuntimeFingerprintSnapshot({
        config,
        provenance: { workspace: { parentId: "workspace", sourcePath: "workspace/CAPLET.md" } },
        reader: createMemoryDeclaredInputReader({ "nested/config.json": nestedConfig }),
      }),
    ).toThrow(/cycle/iu);
  });

  it("uses one secret-independent per-Caplet fingerprint for local and hosted setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-setup-fingerprint-"));
    tempDirs.push(root);
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "missing-project.json");
    const capletDir = join(root, "tool");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(configPath, "{}", "utf8");
    const capletFile = (body: string, tokenReference = "$env:SETUP_RUNTIME_TOKEN") => `---
name: Setup tool
description: Run a setup-enabled remote tool.
setup:
  commands:
    - label: Install
      command: install-tool
mcpServer:
  url: https://tool.example.com/mcp
  auth:
    type: bearer
    token: ${tokenReference}
---
${body}
`;
    writeFileSync(capletPath, capletFile("# First README"), "utf8");
    const previousToken = process.env.SETUP_RUNTIME_TOKEN;
    const previousOtherToken = process.env.OTHER_TOKEN;
    process.env.SETUP_RUNTIME_TOKEN = "resolved-secret-one";
    process.env.OTHER_TOKEN = "resolved-secret-two";
    try {
      const first = loadConfigWithSources(configPath, projectConfigPath);
      const expected = first.runtimeFingerprint?.caplets.tool?.fingerprint;
      expect(expected).toMatch(/^[a-f0-9]{64}$/u);

      const localStoreRoot = join(root, "local-setup");
      await runCapletSetupCli("tool", {
        yes: true,
        configPath,
        projectConfigPath,
        baseDir: localStoreRoot,
        spawn: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      });
      const approvals = JSON.parse(
        readFileSync(join(localStoreRoot, "approvals.json"), "utf8"),
      ) as Array<{ contentHash: string }>;

      const hosted = createCloudRuntimeAdapter({
        configPath,
        projectConfigPath,
        runtimeId: "runtime-test",
        executionKind: "cloud",
        setupStore: new LocalSetupStore({ baseDir: join(root, "hosted-setup") }),
      });
      const hostedPlan = await hosted.setupPlan("tool");
      await hosted.close();

      process.env.SETUP_RUNTIME_TOKEN = "resolved-secret-two";
      writeFileSync(capletPath, capletFile("# Different README"), "utf8");
      const second = loadConfigWithSources(configPath, projectConfigPath);

      expect(approvals[0]?.contentHash).toBe(expected);
      expect(hostedPlan.contentHash).toBe(expected);
      expect(second.runtimeFingerprint?.caplets.tool?.fingerprint).toBe(expected);
      expect(JSON.stringify(first.runtimeFingerprint)).not.toContain("resolved-secret-one");
      expect(JSON.stringify(second.runtimeFingerprint)).not.toContain("resolved-secret-two");

      writeFileSync(capletPath, capletFile("# Different README", "$env:OTHER_TOKEN"), "utf8");
      const templateChanged = loadConfigWithSources(configPath, projectConfigPath);
      expect(templateChanged.runtimeFingerprint?.caplets.tool?.fingerprint).not.toBe(expected);

      writeFileSync(capletPath, capletFile("# Literal README", "literal-secret"), "utf8");
      const liveOnly = loadConfigWithSources(configPath, projectConfigPath);
      expect(liveOnly.runtimeFingerprint?.caplets.tool?.persistenceEligible).toBe(false);
      const liveOnlyStoreRoot = join(root, "live-only-setup");
      await runCapletSetupCli("tool", {
        yes: true,
        configPath,
        projectConfigPath,
        baseDir: liveOnlyStoreRoot,
        spawn: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      });
      expect(existsSync(join(liveOnlyStoreRoot, "approvals.json"))).toBe(false);
      const liveOnlyAttempt = readFileSync(
        join(liveOnlyStoreRoot, "projects", "default", "attempts", "tool.jsonl"),
        "utf8",
      );
      expect(liveOnlyAttempt).toContain('"contentHash":"live-only"');
      expect(liveOnlyAttempt).not.toContain("literal-secret");

      const liveHostedRoot = join(root, "live-only-hosted");
      const liveHosted = createCloudRuntimeAdapter({
        configPath,
        projectConfigPath,
        runtimeId: "runtime-live-only",
        executionKind: "cloud",
        setupStore: new LocalSetupStore({ baseDir: liveHostedRoot }),
      });
      const liveHostedPlan = await liveHosted.setupPlan("tool");
      await liveHosted.close();
      expect(liveHostedPlan.contentHash).toBe("live-only");
      expect(liveHostedPlan.approved).toBe(false);
      expect(existsSync(join(liveHostedRoot, "approvals.json"))).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.SETUP_RUNTIME_TOKEN;
      else process.env.SETUP_RUNTIME_TOKEN = previousToken;
      if (previousOtherToken === undefined) delete process.env.OTHER_TOKEN;
      else process.env.OTHER_TOKEN = previousOtherToken;
    }
  });

  it("rejects traversal and reports filesystem symlink escape as unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-fingerprint-root-"));
    const outside = mkdtempSync(join(tmpdir(), "caplets-fingerprint-outside-"));
    tempDirs.push(root, outside);
    mkdirSync(join(root, "weather"), { recursive: true });
    writeFileSync(join(outside, "openapi.yaml"), "outside", "utf8");
    symlinkSync(join(outside, "openapi.yaml"), join(root, "weather", "openapi.yaml"));
    writeFileSync(
      join(root, "weather", "CAPLET.md"),
      `---\nname: Weather\ndescription: Inspect weather forecasts.\nopenapiEndpoint:\n  specPath: ./openapi.yaml\n  auth: { type: none }\n---\nREADME`,
      "utf8",
    );

    const escaped = await parseCapletSource(new FilesystemCapletSource(root));
    expect(escaped.ok).toBe(false);
    expect(escaped.errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/unreadable|outside the source root/iu),
      }),
    ]);

    const traversal = await parseCapletSource(
      new BundleCapletSource([
        {
          path: "weather/CAPLET.md",
          content: `---\nname: Weather\ndescription: Inspect weather forecasts.\nopenapiEndpoint:\n  specPath: ../outside.yaml\n  auth: { type: none }\n---\nREADME`,
        },
        { path: "outside.yaml", content: "outside" },
      ]),
    );
    expect(traversal.ok).toBe(false);
    expect(traversal.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/traversal/iu) }),
    ]);
  });

  it("changes the digest when an in-root declared-input symlink is retargeted", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-fingerprint-retarget-"));
    tempDirs.push(root);
    mkdirSync(join(root, "weather"), { recursive: true });
    writeFileSync(join(root, "first.yaml"), "first", "utf8");
    writeFileSync(join(root, "second.yaml"), "second", "utf8");
    const linked = join(root, "weather", "openapi.yaml");
    symlinkSync(join(root, "first.yaml"), linked);
    writeFileSync(
      join(root, "weather", "CAPLET.md"),
      `---\nname: Weather\ndescription: Inspect weather forecasts.\nopenapiEndpoint:\n  specPath: ./openapi.yaml\n  auth: { type: none }\n---\nREADME`,
      "utf8",
    );
    const first = await parseCapletSource(new FilesystemCapletSource(root));
    unlinkSync(linked);
    symlinkSync(join(root, "second.yaml"), linked);
    const second = await parseCapletSource(new FilesystemCapletSource(root));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.runtimeFingerprint?.caplets.weather?.fingerprint).not.toBe(
      second.runtimeFingerprint?.caplets.weather?.fingerprint,
    );
  });
});

function writeTree(files: Array<{ path: string; content: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-fingerprint-"));
  tempDirs.push(root);
  for (const file of files) {
    const path = join(root, file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.content, "utf8");
  }
  return root;
}
