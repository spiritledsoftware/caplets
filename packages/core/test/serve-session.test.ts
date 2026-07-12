import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ResourceTemplate,
  type RegisteredPrompt,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp";
import { getCompleter } from "@modelcontextprotocol/sdk/server/completable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { CapletsMcpSession } from "../src/serve/session";
import type { PreparedRuntimeView, RuntimeEpochLease } from "../src/storage/coordinator";
import type { ResolvedExposureProjection } from "../src/engine";
import {
  buildManifestExposureProjection,
  type ExposureProjection,
} from "../src/exposure/projection";
import { directPromptName, directResourceTemplateUri } from "../src/exposure/direct-names";
import { sanitizeRemoteEngineOptions } from "../src/serve/http";
import { connectMcpTestClient } from "./mcp-test-client";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CapletsMcpSession", () => {
  it("registers enabled Caplets from a shared engine", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: { name: "Alpha", description: "Search alpha.", command: "node" },
        beta: { name: "Beta", description: "Search beta.", command: "node", disabled: true },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    expect(session.registeredToolIds()).toEqual([]);
    await session.refreshExposure();

    expect(session.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registerTool).toHaveBeenCalledTimes(2);
    expect(server.registered.get("code_mode")).toBeDefined();
    expect(server.registered.get("run")).toBeUndefined();
    expect(server.registerTool).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        inputSchema: expect.objectContaining({ fields: expect.anything() }),
      }),
      expect.any(Function),
    );

    await session.close();
    await engine.close();
  });

  it("releases a retained runtime epoch exactly once on session close", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: { name: "Alpha", description: "Search alpha.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const release = vi.fn();
    const lease = {
      view: {} as PreparedRuntimeView,
      release,
    } as RuntimeEpochLease;
    const session = new CapletsMcpSession(engine, {
      server: mockServer(),
      runtimeLease: lease,
    });

    await session.close();
    await session.close();

    expect(release).toHaveBeenCalledOnce();
    await engine.close();
  });

  it("registers project-bound Caplets when the engine has session context", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: {
          name: "Alpha",
          description: "Search alpha.",
          command: "node",
          projectBinding: { required: true },
        },
      },
    });
    dirs.push(dir);
    const projectRoot = join(dir, "project");
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      watch: false,
      projectBindingContext: {
        sessionId: "session_1",
        bindingId: "binding_1",
        projectRoot,
        projectFingerprint: "sha256:project",
      },
    });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();

    expect(session.registeredToolIds()).toEqual(["alpha"]);
    expect(server.registered.get("alpha")).toBeDefined();

    await session.close();
    await engine.close();
  });

  it("reconciles tools when the shared engine reloads", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        alpha: { name: "Alpha", description: "Search alpha.", command: "node" },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });
    await session.refreshExposure();
    const alpha = server.registered.get("alpha")!;
    const codeMode = server.registered.get("code_mode")!;

    writeConfig(configPath, {
      httpApis: {
        gamma: {
          name: "Gamma HTTP",
          description: "Call gamma over HTTP.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { search: { method: "GET", path: "/search" } },
        },
      },
    });
    await engine.reload();
    await session.refreshExposure();

    expect(alpha.remove).toHaveBeenCalledTimes(1);
    expect(codeMode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('gamma:CapletHandle<"gamma">'),
      }),
    );
    expect(codeMode.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        description: expect.stringContaining('alpha:CapletHandle<"alpha">'),
      }),
    );
    expect(session.registeredToolIds()).toEqual(["gamma"]);
    expect(server.registered.get("gamma")).toBeDefined();

    await session.close();
    await engine.close();
  });

  it("fails stale callbacks closed until the matching projection resolves", async () => {
    const harness = projectionEngineHarness();
    harness.enqueueResolved(0, progressiveProjection("alpha", "Alpha"));
    const server = mockServer();
    const session = new CapletsMcpSession(harness.engine, { server });
    await session.refreshExposure();
    const oldCallback = server.handlers.get("alpha");
    const alpha = server.registered.get("alpha");
    expect(oldCallback).toBeDefined();
    expect(alpha).toBeDefined();

    harness.advanceGeneration();
    await expect(oldCallback?.({ operation: "inspect" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(harness.execute).not.toHaveBeenCalled();

    harness.enqueueResolved(1, progressiveProjection("alpha", "Alpha v2"));
    await session.refreshExposure();
    const update = lastToolUpdate(alpha);
    const currentCallback = update.callback;
    expect(currentCallback).toEqual(expect.any(Function));
    await (currentCallback as (request: unknown) => Promise<unknown>)({ operation: "inspect" });
    expect(harness.execute).toHaveBeenCalledWith("alpha", { operation: "inspect" });

    await session.close();
  });

  it("invalidates prior callbacks when availability changes within one config generation", async () => {
    const harness = projectionEngineHarness();
    harness.enqueueResolved(0, progressiveProjection("alpha", "Alpha", true));
    const server = mockServer();
    const session = new CapletsMcpSession(harness.engine, { server });
    await session.refreshExposure();
    const progressiveCallback = server.handlers.get("alpha");
    const codeModeCallback = server.handlers.get("code_mode");
    expect(progressiveCallback).toBeDefined();
    expect(codeModeCallback).toBeDefined();

    harness.enqueueResolved(
      0,
      buildManifestExposureProjection({
        caplets: [],
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        completions: [],
        codeModeCaplets: [],
      }),
    );
    await session.refreshExposure();

    await expect(progressiveCallback?.({ operation: "inspect" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await expect(
      codeModeCallback?.({ code: "return await caplets.alpha.inspect();" }),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(server.registered.get("code_mode")).toBeUndefined();
    expect(harness.execute).not.toHaveBeenCalled();

    await session.close();
  });

  it("discards an older projection when overlapping refreshes resolve out of order", async () => {
    const harness = projectionEngineHarness();
    harness.enqueueResolved(0, progressiveProjection("alpha", "Initial"));
    const server = mockServer();
    const session = new CapletsMcpSession(harness.engine, { server });
    await session.refreshExposure();
    const alpha = server.registered.get("alpha");
    expect(alpha).toBeDefined();

    const older = Promise.withResolvers<ResolvedExposureProjection>();
    const newer = Promise.withResolvers<ResolvedExposureProjection>();
    harness.enqueue(older.promise);
    harness.enqueue(newer.promise);
    const olderRefresh = session.refreshExposure();
    const newerRefresh = session.refreshExposure();
    newer.resolve({ generation: 0, projection: progressiveProjection("alpha", "Newest") });
    await newerRefresh;
    older.resolve({ generation: 0, projection: progressiveProjection("alpha", "Older") });
    await olderRefresh;

    expect(lastToolUpdate(alpha)).toMatchObject({ title: "Newest" });
    expect(toolUpdates(alpha)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Older" })]),
    );

    await session.close();
  });

  it("renders resource, template, and prompt registrations directly from projection entries", async () => {
    const harness = projectionEngineHarness();
    harness.enqueueResolved(0, directSurfaceProjection());
    const server = mockServer();
    const session = new CapletsMcpSession(harness.engine, { server });
    await session.refreshExposure();

    expect(server.registerResource).toHaveBeenCalledTimes(2);
    expect(server.registerPrompt).toHaveBeenCalledTimes(1);
    await server.resourceHandlers.get("README")?.();
    await server.resourceHandlers.get("docs:File")?.(
      new URL("caplets://docs/resources/file%3A%2F%2F%2Fguide.md"),
    );
    await server.promptHandlers.get("docs__review")?.({ topic: "architecture" });
    const resourceCompletion = server.resourceTemplates
      .get("docs:File")
      ?.completeCallback("encodedUri");
    const promptArgsSchema = server.promptDefinitions.get("docs__review")?.argsSchema;
    const topicSchema = isRecord(promptArgsSchema)
      ? (promptArgsSchema.topic as {
          description?: string;
          safeParse(value: unknown): { success: boolean };
        })
      : undefined;
    const promptCompletion = isRecord(promptArgsSchema)
      ? getCompleter(promptArgsSchema.topic as Parameters<typeof getCompleter>[0])
      : undefined;
    await expect(resourceCompletion?.("READ")).resolves.toEqual(["file:///README.md"]);
    await expect(promptCompletion?.("arch")).resolves.toEqual(["architecture"]);
    expect(topicSchema?.description).toBe("Topic to summarize.");
    expect(topicSchema?.safeParse(undefined).success).toBe(false);

    expect(harness.readDirectResource).toHaveBeenNthCalledWith(1, "docs", "file:///README.md");
    expect(harness.readDirectResource).toHaveBeenNthCalledWith(2, "docs", "file:///guide.md");
    expect(harness.getDirectPrompt).toHaveBeenCalledWith("docs", "review", {
      topic: "architecture",
    });
    expect(harness.completeDirectReference).toHaveBeenNthCalledWith(
      1,
      "docs",
      { type: "resourceTemplate", uri: "file:///{path}" },
      { name: "path", value: "READ" },
      { arguments: {} },
    );
    expect(harness.completeDirectReference).toHaveBeenNthCalledWith(
      2,
      "docs",
      { type: "prompt", name: "review" },
      { name: "topic", value: "arch" },
      undefined,
    );

    await session.close();
  });

  it("fails closed when projection registration cannot reconcile atomically", async () => {
    const harness = projectionEngineHarness();
    harness.enqueueResolved(0, progressiveProjection("alpha", "Alpha"));
    const server = mockServer();
    const session = new CapletsMcpSession(harness.engine, { server });
    await session.refreshExposure();
    const oldCallback = server.handlers.get("alpha");
    server.registerResource.mockImplementationOnce(() => {
      throw new Error("resource registration failed");
    });
    harness.enqueueResolved(0, directSurfaceProjection());

    await expect(session.refreshExposure()).rejects.toThrow("resource registration failed");

    expect(session.registeredToolIds()).toEqual([]);
    expect(server.registered.get("code_mode")).toBeUndefined();
    await expect(oldCallback?.({ operation: "inspect" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });

    await session.close();
  });

  it("registers direct operation tools without progressive wrapper or Code Mode", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      httpApis: {
        status: {
          name: "Status HTTP",
          description: "Call status over HTTP.",
          exposure: "direct",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: {
            ping: {
              method: "GET",
              path: "/ping",
              description: "Ping the service.",
              inputSchema: {
                type: "object",
                properties: { verbose: { type: "boolean" } },
              },
            },
          },
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const server = mockServer();
    const session = new CapletsMcpSession(engine, { server });

    await session.refreshExposure();

    expect(session.registeredToolIds()).toEqual(["status__ping"]);
    expect(server.registered.get("status")).toBeUndefined();
    expect(server.registered.get("code_mode")).toBeUndefined();
    expect(server.definitions.get("status__ping")).toMatchObject({
      description: "Ping the service.",
      inputSchema: expect.objectContaining({ safeParse: expect.any(Function) }),
    });

    await session.close();
    await engine.close();
  });

  it("forwards direct MCP resource and prompt completions through projected registrations", async () => {
    const fixture = fileURLToPath(new URL("fixtures/stdio-server.ts", import.meta.url));
    const { dir, configPath, projectConfigPath } = tempConfig({
      options: { exposure: "direct" },
      mcpServers: {
        docs: {
          name: "Docs",
          description: "Fixture direct MCP surface.",
          command: process.execPath,
          args: ["--import", import.meta.resolve("tsx"), fixture],
        },
      },
    });
    dirs.push(dir);
    const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
    const session = new CapletsMcpSession(engine);
    const client = await connectMcpTestClient(session);

    try {
      const resource = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "file:///repo/{path}"),
        },
        argument: { name: "encodedUri", value: "READ" },
      });
      const packageOwner = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "repo://{owner}/{name}{?region}"),
        },
        argument: { name: "encodedUri", value: "repo://ca" },
      });
      const packageName = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "repo://{owner}/{name}{?region}"),
        },
        argument: { name: "encodedUri", value: "repo://caplets/co" },
        context: { arguments: { region: "eu" } },
      });
      const skippedQueryOwner = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "repo://{tenant}/items{?owner,region}"),
        },
        argument: { name: "encodedUri", value: "repo://acme/items?region=e" },
      });
      const incompleteEscape = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "repo://{tenant}/items{?owner,region}"),
        },
        argument: { name: "encodedUri", value: "repo://acme/items?region=%" },
      });
      const encodedOwner = await client.complete({
        ref: {
          type: "ref/resource",
          uri: directResourceTemplateUri("docs", "repo://{owner}/{name}{?region}"),
        },
        argument: { name: "encodedUri", value: "repo://caplets%20inc/co" },
        context: { arguments: { region: "eu" } },
      });
      const prompt = await client.complete({
        ref: { type: "ref/prompt", name: directPromptName("docs", "review_issue") },
        argument: { name: "issueId", value: "12" },
      });
      const contextualPrompt = await client.complete({
        ref: { type: "ref/prompt", name: directPromptName("docs", "review_issue") },
        argument: { name: "issueId", value: "CAP" },
        context: { arguments: { owner: "caplets" } },
      });

      expect(resource.completion.values).toEqual(["file:///repo/README.md"]);
      expect(prompt.completion.values).toEqual(["123", "124"]);
      expect(packageOwner.completion.values).toEqual(["repo://caplets/"]);
      expect(packageName.completion.values).toEqual(["repo://caplets/core?region=eu"]);
      expect(skippedQueryOwner.completion.values).toEqual(["repo://acme/items?region=eu"]);
      expect(incompleteEscape.completion.values).toEqual([]);
      expect(encodedOwner.completion.values).toEqual(["repo://caplets%20inc/core?region=eu"]);
      expect(contextualPrompt.completion.values).toEqual(["CAP-123"]);
    } finally {
      await client.close();
      await session.close();
      await engine.close();
    }
  });

  it("validates remote artifact references through a real direct MCP registration", async () => {
    const http = await startPdfServer();
    try {
      const outputSchema = strictHttpOutputSchema();
      const { dir, configPath, projectConfigPath } = tempConfig({
        options: { exposure: "direct" },
        httpApis: {
          status: {
            name: "Status HTTP",
            description: "Download a remote-safe report.",
            exposure: "direct",
            baseUrl: http.baseUrl,
            auth: { type: "none" },
            actions: {
              status: {
                method: "GET",
                path: "/status",
                outputSchema,
              },
              download: {
                method: "GET",
                path: "/report",
                outputSchema,
              },
            },
          },
        },
      });
      dirs.push(dir);
      const engine = new CapletsEngine(
        sanitizeRemoteEngineOptions({
          configPath,
          projectConfigPath,
          artifactDir: join(dir, "artifacts"),
          exposeLocalArtifactPaths: true,
          watch: false,
        }),
      );
      const session = new CapletsMcpSession(engine);
      const client = await connectMcpTestClient(session);

      try {
        const listed = await client.listTools();
        const tool = listed.tools.find((candidate) => candidate.name === "status__download");
        expect(tool?.outputSchema).toMatchObject({
          properties: {
            body: { type: "object" },
            kind: { enum: ["inline", "local-artifact", "remote-reference"] },
            uri: { type: "string" },
          },
        });
        const inline = await client.callTool({
          name: "status__status",
          arguments: {},
        });
        expect(remoteArtifact(inline)).toMatchObject({
          kind: "inline",
          body: { ok: true },
        });
        const result = await client.callTool({
          name: "status__download",
          arguments: {},
        });
        const structuredContent = remoteArtifact(result);
        const reference = artifactReference(result);

        expect(structuredContent).toMatchObject({
          kind: "remote-reference",
          uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
          mimeType: "application/pdf",
          byteLength: 16,
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
        await client.close();
        await session.close();
        await engine.close();
      }
    } finally {
      await http.close();
    }
  });

  it("validates Discovery media references through a real direct MCP registration", async () => {
    const google = await startGooglePdfServer();
    try {
      const { dir, configPath, projectConfigPath } = tempConfig({
        options: { exposure: "direct" },
        googleDiscoveryApis: {
          drive: {
            name: "Google Drive",
            description: "Download a remote-safe Drive report.",
            exposure: "direct",
            discoveryUrl: `${google.baseUrl}/discovery.json`,
            baseUrl: `${google.baseUrl}/`,
            auth: { type: "none" },
          },
        },
      });
      dirs.push(dir);
      const engine = new CapletsEngine(
        sanitizeRemoteEngineOptions({
          configPath,
          projectConfigPath,
          artifactDir: join(dir, "artifacts"),
          exposeLocalArtifactPaths: true,
          watch: false,
        }),
      );
      const session = new CapletsMcpSession(engine);
      const client = await connectMcpTestClient(session);

      try {
        const name = "drive__drive.files.download";
        const listed = await client.listTools();
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(tool?.outputSchema).toMatchObject({
          properties: {
            body: { type: "object" },
            kind: { enum: ["inline", "local-artifact", "remote-reference"] },
            uri: { type: "string" },
          },
        });
        const result = await client.callTool({
          name,
          arguments: { filename: "report.pdf" },
        });
        const structuredContent = remoteArtifact(result);
        const reference = artifactReference(result);

        expect(structuredContent).toMatchObject({
          kind: "remote-reference",
          uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
          mimeType: "application/pdf",
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
        await client.close();
        await session.close();
        await engine.close();
      }
    } finally {
      await google.close();
    }
  });
  function progressiveProjection(
    capletId: string,
    title: string,
    codeMode = false,
  ): ExposureProjection {
    return buildManifestExposureProjection({
      caplets: [
        {
          kind: "caplet",
          name: title,
          title,
          capletId,
          inputSchema: {
            type: "object",
            properties: { operation: { type: "string" } },
            required: ["operation"],
            additionalProperties: false,
          },
          shadowing: "forbid",
        },
      ],
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      completions: [],
      codeModeCaplets: codeMode
        ? [
            {
              kind: "caplet",
              name: title,
              title,
              capletId,
              shadowing: "forbid",
            },
          ]
        : [],
    });
  }

  function directSurfaceProjection(): ExposureProjection {
    return buildManifestExposureProjection({
      caplets: [],
      tools: [],
      resources: [
        {
          kind: "resource",
          capletId: "docs",
          uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
          downstreamUri: "file:///README.md",
          title: "README",
          mimeType: "text/markdown",
          size: 42,
          shadowing: "forbid",
        },
      ],
      resourceTemplates: [
        {
          kind: "resourceTemplate",
          capletId: "docs",
          uriTemplate: "caplets://docs/resources/{encodedUri}",
          downstreamUriTemplate: "file:///{path}",
          title: "File",
          mimeType: "text/plain",
          shadowing: "forbid",
        },
      ],
      prompts: [
        {
          kind: "prompt",
          capletId: "docs",
          name: "docs__review",
          downstreamName: "review",
          title: "Review",
          inputSchema: {
            arguments: [{ name: "topic", description: "Topic to summarize.", required: true }],
          },
          shadowing: "forbid",
        },
      ],
      completions: [
        {
          kind: "completion",
          capletId: "docs",
          name: "docs:complete",
          shadowing: "forbid",
        },
      ],
      codeModeCaplets: [],
    });
  }

  function projectionEngineHarness() {
    let generation = 0;
    const projections: Promise<ResolvedExposureProjection>[] = [];
    const execute = vi.fn(async () => ({ ok: true }));
    const getDirectPrompt = vi.fn(async () => ({ messages: [] }));
    const readDirectResource = vi.fn(async () => ({
      contents: [{ uri: "file:///README.md", text: "README" }],
    }));
    const completeDirectReference = vi.fn(
      async (
        _serverId: string,
        ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string },
      ) => (ref.type === "prompt" ? ["architecture"] : ["README.md"]),
    );
    const engine = {
      currentExposureGeneration: () => generation,
      exposureProjection: async () => {
        const next = projections.shift();
        if (!next) throw new Error("No queued exposure projection");
        return await next;
      },
      onReload: () => () => undefined,
      execute,
      executeDirectTool: vi.fn(),
      getDirectPrompt,
      readDirectResource,
      completeDirectReference,
      captureCodeModeOutcome: vi.fn(),
    } as unknown as CapletsEngine;
    return {
      engine,
      execute,
      getDirectPrompt,
      readDirectResource,
      completeDirectReference,
      enqueue: (projection: Promise<ResolvedExposureProjection>) => projections.push(projection),
      enqueueResolved: (resolvedGeneration: number, projection: ExposureProjection) =>
        projections.push(Promise.resolve({ generation: resolvedGeneration, projection })),
      advanceGeneration: () => {
        generation += 1;
      },
    };
  }

  function toolUpdates(tool: RegisteredTool | undefined): Record<string, unknown>[] {
    if (!tool) throw new Error("Expected registered tool");
    const update = tool.update as unknown as { mock: { calls: unknown[][] } };
    return update.mock.calls.flatMap((call) => (isRecord(call[0]) ? [call[0]] : []));
  }

  function lastToolUpdate(tool: RegisteredTool | undefined): Record<string, unknown> {
    const updates = toolUpdates(tool);
    const update = updates.at(-1);
    if (!update) throw new Error("Expected tool update");
    return update;
  }
});

function tempConfig(config: unknown): {
  dir: string;
  configPath: string;
  projectConfigPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "caplets-session-"));
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeConfig(configPath, config);
  return { dir, configPath, projectConfigPath };
}

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(progressiveTestConfig(config)));
}

function progressiveTestConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (record.options) return config;
  return { options: { exposure: "progressive_and_code_mode" }, ...record };
}

function mockServer() {
  const registered = new Map<string, RegisteredTool>();
  const definitions = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
  const resourceHandlers = new Map<string, (uri?: URL) => Promise<unknown>>();
  const promptHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const resourceTemplates = new Map<string, ResourceTemplate>();
  const promptDefinitions = new Map<string, Record<string, unknown>>();
  return {
    registered,
    definitions,
    handlers,
    resourceHandlers,
    promptHandlers,
    resourceTemplates,
    promptDefinitions,
    registerTool: vi.fn((name: string, ...args: unknown[]) => {
      const definition = args[0];
      const handler = args[1];
      const tool = {
        update: vi.fn(),
        remove: vi.fn(() => registered.delete(name)),
        enable: vi.fn(),
        disable: vi.fn(),
        enabled: true,
        handler: vi.fn(),
      } as unknown as RegisteredTool;
      if (typeof handler === "function") {
        handlers.set(name, async (request) => await Reflect.apply(handler, undefined, [request]));
      }
      registered.set(name, tool);
      if (isRecord(definition)) definitions.set(name, definition);
      return tool;
    }),
    registerResource: vi.fn((name: string, ...args: unknown[]) => {
      const handler = args.at(-1);
      const uriOrTemplate = args[0];
      if (uriOrTemplate instanceof ResourceTemplate) {
        resourceTemplates.set(name, uriOrTemplate);
      }
      if (typeof handler === "function") {
        resourceHandlers.set(
          name,
          async (uri) => await Reflect.apply(handler, undefined, uri ? [uri] : []),
        );
      }
      return {
        remove: vi.fn(() => {
          resourceHandlers.delete(name);
          resourceTemplates.delete(name);
        }),
      } as unknown as RegisteredResource & RegisteredResourceTemplate;
    }),
    registerPrompt: vi.fn((name: string, definition: unknown, handler: unknown) => {
      if (isRecord(definition)) promptDefinitions.set(name, definition);
      if (typeof handler === "function") {
        promptHandlers.set(name, async (args) => await Reflect.apply(handler, undefined, [args]));
      }
      return {
        remove: vi.fn(() => {
          promptHandlers.delete(name);
          promptDefinitions.delete(name);
        }),
      } as unknown as RegisteredPrompt;
    }),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function strictHttpOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "statusText", "headers", "body"],
    properties: {
      status: { type: "number" },
      statusText: { type: "string" },
      headers: {
        type: "object",
        additionalProperties: false,
        required: ["content-type"],
        properties: { "content-type": { type: "string" } },
      },
      body: { type: "object" },
    },
  };
}

async function startPdfServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.setHeader("content-type", "application/pdf");
    response.end(Buffer.from("%PDF-1.7 session"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("session HTTP test server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startGooglePdfServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  let baseUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/discovery.json") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          kind: "discovery#restDescription",
          rootUrl: `${baseUrl}/`,
          servicePath: "",
          schemas: {
            File: {
              id: "File",
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
          resources: {
            files: {
              methods: {
                download: {
                  id: "drive.files.download",
                  path: "report",
                  httpMethod: "GET",
                  supportsMediaDownload: true,
                  response: { $ref: "File" },
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (request.url === "/report" || request.url === "/report?alt=media") {
      response.setHeader("content-type", "application/pdf");
      response.end(Buffer.from("%PDF-1.7 discovery"));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Discovery session test server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
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
