import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapletsEngine } from "../src/engine";
import { CapletsMcpSession } from "../src/serve/session";
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
  return {
    registered,
    definitions,
    handlers,
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
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
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
