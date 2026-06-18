import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapletsError } from "../src/errors";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { CapletsEngine } from "../src/engine";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClient,
  type RemoteCapletsTool,
} from "../src/native/remote";
import {
  createNativeCapletsService,
  type NativeCapletsService,
  resetNativeProjectBindingFallbackWarningForTests,
} from "../src/native/service";
import { createHttpServeApp } from "../src/serve/http";
import type { HttpServeOptions } from "../src/serve/options";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

function client(
  tools: RemoteCapletsTool[] = [{ name: "alpha", title: "Alpha", description: "Remote alpha" }],
) {
  const listeners = new Set<() => void>();
  return {
    api: {
      listTools: vi.fn(async () => tools),
      callTool: vi.fn(async (name: string, args: unknown) => ({ name, args })),
      onToolsChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      close: vi.fn(async () => undefined),
    } satisfies RemoteCapletsClient,
    emit: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    setTools: (next: RemoteCapletsTool[]) => {
      tools = next;
    },
  };
}

function attachManifest(revision: string, exportId: string) {
  return {
    version: 1,
    revision,
    generatedAt: new Date(0).toISOString(),
    caplets: [
      {
        stableId: "progressive:remote",
        exportId,
        kind: "caplet",
        name: "remote",
        title: "Remote",
        description: "Remote Caplet.",
        inputSchema: { type: "object" },
        schemaHash: "sha256:same",
        capletId: "remote",
        shadowing: "forbid",
      },
    ],
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    completions: [],
    codeModeCaplets: [],
    diagnostics: [],
  };
}

function attachManifestWithDirectTool(revision: string, exportId: string) {
  return {
    ...attachManifest(revision, exportId),
    caplets: [],
    tools: [
      {
        stableId: "tool:shared:ping",
        exportId,
        kind: "tool",
        name: "shared__ping",
        downstreamName: "ping",
        title: "Ping",
        description: "Ping direct tool.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        schemaHash: "sha256:tool",
        capletId: "shared",
        shadowing: "forbid",
      },
    ],
  };
}

function attachManifestWithDirectMcpPrimitives(revision: string) {
  return {
    ...attachManifest(revision, "export-unused"),
    caplets: [],
    resources: [
      {
        stableId: "resource:docs:file:///README.md",
        exportId: "export-resource",
        kind: "resource",
        uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
        downstreamUri: "file:///README.md",
        title: "README",
        description: "README resource.",
        mimeType: "text/markdown",
        size: 42,
        schemaHash: null,
        capletId: "docs",
        shadowing: "forbid",
      },
    ],
    resourceTemplates: [
      {
        stableId: "resourceTemplate:docs:file:///{path}",
        exportId: "export-resource-template",
        kind: "resourceTemplate",
        uriTemplate: "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
        downstreamUriTemplate: "file:///{path}",
        title: "File",
        description: "File resource.",
        mimeType: "text/plain",
        schemaHash: null,
        capletId: "docs",
        shadowing: "forbid",
      },
    ],
    prompts: [
      {
        stableId: "prompt:docs:explain",
        exportId: "export-prompt",
        kind: "prompt",
        name: "docs__explain",
        downstreamName: "explain",
        title: "Explain",
        description: "Explain prompt.",
        inputSchema: {
          arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
        },
        schemaHash: "sha256:prompt",
        capletId: "docs",
        shadowing: "forbid",
      },
    ],
    completions: [
      {
        stableId: "completion:docs",
        exportId: "export-completion",
        kind: "completion",
        name: "docs:complete",
        title: "Complete",
        description: "Complete docs.",
        schemaHash: null,
        capletId: "docs",
        shadowing: "forbid",
      },
    ],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("RemoteNativeCapletsService", () => {
  it("refetches and retries once when attach invoke reports a stale manifest", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/manifest")) {
        const revision = requests.filter((request) => request.url.endsWith("/manifest")).length;
        return Response.json(attachManifest(`rev-${revision}`, `export-${revision}`));
      }
      if (
        url.endsWith("/invoke") &&
        requests.filter((request) => request.url.endsWith("/invoke")).length === 1
      ) {
        return Response.json(
          { ok: false, error: { code: "ATTACH_MANIFEST_STALE", message: "stale" } },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, data: { retried: true } });
    });
    const client = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await client.listTools();
    await expect(client.callTool("remote", { ok: true })).resolves.toEqual({ retried: true });

    expect(requests.map((request) => request.url)).toEqual([
      "https://caplets.example.com/v1/attach/manifest",
      "https://caplets.example.com/v1/attach/invoke",
      "https://caplets.example.com/v1/attach/manifest",
      "https://caplets.example.com/v1/attach/invoke",
    ]);
    expect(requests[1]?.body).toMatchObject({ revision: "rev-1", exportId: "export-1" });
    expect(requests[3]?.body).toMatchObject({ revision: "rev-2", exportId: "export-2" });

    await client.close();
  });

  it("throws a non-stale error when a refreshed manifest no longer has a compatible export", async () => {
    const fetchStub: typeof fetch = vi.fn(async (input, _init) => {
      const url = String(input);
      if (url.endsWith("/manifest")) {
        const manifestFetches = (fetchStub as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([call]) => String(call).endsWith("/manifest"),
        ).length;
        return Response.json(
          manifestFetches === 1
            ? attachManifest("rev-1", "export-1")
            : { ...attachManifest("rev-2", "export-2"), caplets: [] },
        );
      }
      if (url.endsWith("/invoke")) {
        return Response.json(
          { ok: false, error: { code: "ATTACH_MANIFEST_STALE", message: "stale" } },
          { status: 409 },
        );
      }
      return Response.json({ ok: true });
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("remote", {})).rejects.toMatchObject({
      code: "ATTACH_EXPORT_NOT_FOUND",
    });
    await remote.close();
  });

  it("keeps progressive caplet lookups from being overwritten by same-caplet direct exports", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/manifest")) {
        return Response.json({
          ...attachManifest("rev-1", "export-caplet"),
          tools: [
            {
              stableId: "tool:remote:ping",
              exportId: "export-tool",
              kind: "tool",
              name: "remote__ping",
              downstreamName: "ping",
              title: "Ping",
              description: "Ping direct tool.",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              schemaHash: "sha256:tool",
              capletId: "remote",
              shadowing: "forbid",
            },
          ],
        });
      }
      return Response.json({ ok: true, data: { invoked: true } });
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("remote", { operation: "inspect" })).resolves.toEqual({
      invoked: true,
    });

    expect(requests.at(-1)?.body).toMatchObject({
      kind: "caplet",
      exportId: "export-caplet",
      input: { operation: "inspect" },
    });
    await remote.close();
  });

  it("invokes code-mode-only caplets through exported attach IDs", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/manifest")) {
        return Response.json({
          ...attachManifest("rev-1", "export-caplet"),
          caplets: [],
          tools: [],
          codeModeCaplets: [
            {
              stableId: "code_mode:remote",
              exportId: "export-code-mode",
              kind: "caplet",
              name: "Remote",
              title: "Remote",
              description: "Remote Code Mode handle.",
              inputSchema: { type: "object", additionalProperties: true },
              schemaHash: "hash-code-mode",
              capletId: "remote",
              shadowing: "forbid",
            },
          ],
        });
      }
      return Response.json({ ok: true, data: { invoked: true } });
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("remote", { operation: "inspect" })).resolves.toEqual({
      invoked: true,
    });

    expect(requests.at(-1)?.body).toMatchObject({
      kind: "caplet",
      exportId: "export-code-mode",
      input: { operation: "inspect" },
    });
    await remote.close();
  });

  it("loads older attach manifests without Code Mode caplet entries", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          const { codeModeCaplets: _codeModeCaplets, ...manifest } = attachManifest(
            "rev-1",
            "export-caplet",
          );
          return Response.json(manifest);
        }
        return Response.json({ ok: true, data: { invoked: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await expect(remote.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "remote",
        codeModeCaplets: [],
      }),
    ]);
    await expect(remote.callTool("remote", { operation: "inspect" })).resolves.toEqual({
      invoked: true,
    });
    await remote.close();
  });

  it("notifies listeners when the attach events stream reports a manifest change", async () => {
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetchStub: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventController = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ ok: true });
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const listener = vi.fn();

    remote.onToolsChanged(listener);
    await vi.waitFor(() => expect(eventController).toBeDefined());
    eventController!.enqueue(
      encoder.encode('event: manifest_changed\ndata: {"revision":"rev-2"}\n\n'),
    );

    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await remote.close();
  });

  it("reconnects the attach events stream after a server-side close", async () => {
    vi.useFakeTimers();
    try {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const fetchStub: typeof fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
        if (url.endsWith("/events")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ ok: true });
      });
      const remote = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: fetchStub,
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
      });

      remote.onToolsChanged(vi.fn());
      await vi.waitFor(() => expect(controllers).toHaveLength(1));
      controllers[0]!.close();
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => expect(controllers).toHaveLength(2));
      await remote.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect the attach events stream after an HTTP error response", async () => {
    vi.useFakeTimers();
    try {
      const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
        if (url.endsWith("/events")) {
          return Response.json({ ok: false, error: { code: "UNAUTHORIZED" } }, { status: 401 });
        }
        return Response.json({ ok: true });
      });
      const remote = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: fetchStub as typeof fetch,
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
      });
      const eventRequestCount = () =>
        fetchStub.mock.calls.filter(([input]) => String(input).endsWith("/events")).length;

      remote.onToolsChanged(vi.fn());
      await vi.waitFor(() => expect(eventRequestCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(eventRequestCount()).toBe(1);
      await remote.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect the attach events stream after an empty success response", async () => {
    vi.useFakeTimers();
    try {
      const fetchStub = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
        if (url.endsWith("/events")) {
          return new Response(null, { status: 200 });
        }
        return Response.json({ ok: true });
      });
      const remote = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: fetchStub as typeof fetch,
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
      });
      const eventRequestCount = () =>
        fetchStub.mock.calls.filter(([input]) => String(input).endsWith("/events")).length;

      remote.onToolsChanged(vi.fn());
      await vi.waitFor(() => expect(eventRequestCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(eventRequestCount()).toBe(1);
      await remote.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-attach errors that merely mention stale data", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/manifest")) {
        return Response.json(attachManifest("rev-1", "export-1"));
      }
      return Response.json(
        { ok: false, error: { code: "BACKEND_STALE_DATA", message: "data is stale" } },
        { status: 500 },
      );
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("remote", {})).rejects.toMatchObject({
      code: "BACKEND_STALE_DATA",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://caplets.example.com/v1/attach/manifest",
      "https://caplets.example.com/v1/attach/invoke",
    ]);
    await remote.close();
  });

  it("preserves the source Caplet ID for remote direct-tool shadowing", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifestWithDirectTool("rev-1", "export-1"));
        }
        return Response.json({ ok: true, data: { pong: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await expect(remote.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "shared__ping",
        capletId: "shared",
      }),
    ]);
    await remote.close();
  });

  it("uses attached direct tool schemas instead of progressive operation args", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifestWithDirectTool("rev-1", "export-1"));
        }
        return Response.json({ ok: true, data: { pong: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const service = new RemoteNativeCapletsService({ client: remote, pollIntervalMs: 60_000 });

    await service.reload();

    expect(service.listTools()).toEqual([
      expect.objectContaining({
        caplet: "shared__ping",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        annotations: { readOnlyHint: true },
      }),
    ]);
    expect(service.listTools()[0]).not.toHaveProperty("operationNames");
    await service.close();
  });

  it("surfaces direct MCP resources and prompts as native primitive tools", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifestWithDirectMcpPrimitives("rev-1"));
        }
        return Response.json({ ok: true, data: { invoked: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const service = new RemoteNativeCapletsService({ client: remote, pollIntervalMs: 60_000 });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(
      expect.arrayContaining([
        "docs__list_resources",
        "docs__read_resource",
        "docs__list_resource_templates",
        "docs__list_prompts",
        "docs__get_prompt",
        "docs__complete",
      ]),
    );
    await expect(
      service.execute("docs__read_resource", { uri: "file:///README.md" }),
    ).resolves.toEqual({ invoked: true });
    await service.close();
  });

  it("passes prompt argument metadata through attached prompt lists", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifestWithDirectMcpPrimitives("rev-1"));
        }
        return Response.json({ ok: true, data: {} });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("docs__list_prompts", {})).resolves.toEqual({
      items: [
        {
          name: "docs__explain",
          title: "Explain",
          description: "Explain prompt.",
          arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
        },
      ],
    });
    await remote.close();
  });

  it("passes resource metadata through attached primitive lists", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifestWithDirectMcpPrimitives("rev-1"));
        }
        return Response.json({ ok: true, data: {} });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("docs__list_resources", {})).resolves.toEqual({
      items: [
        {
          uri: "caplets://docs/resources/file%3A%2F%2F%2FREADME.md",
          name: "README",
          description: "README resource.",
          mimeType: "text/markdown",
          size: 42,
        },
      ],
    });
    await expect(remote.callTool("docs__list_resource_templates", {})).resolves.toEqual({
      items: [
        {
          uriTemplate: "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2F%7Bpath%7D",
          name: "File",
          description: "File resource.",
          mimeType: "text/plain",
        },
      ],
    });
    await remote.close();
  });

  it("falls back to exact direct tool exports when names end with primitive suffixes", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.endsWith("/manifest")) {
          return Response.json({
            ...attachManifest("rev-1", "unused"),
            caplets: [],
            tools: [
              {
                stableId: "tool:docs:read_resource",
                exportId: "export-tool",
                kind: "tool",
                name: "docs__read_resource",
                downstreamName: "read_resource",
                title: "Read Resource Tool",
                description: "A real downstream tool.",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
                schemaHash: "sha256:tool",
                capletId: "docs",
                shadowing: "forbid",
              },
            ],
          });
        }
        return Response.json({ ok: true, data: { directTool: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(
      remote.callTool("docs__read_resource", { uri: "file:///README.md" }),
    ).resolves.toEqual({ directTool: true });

    expect(requests.at(-1)?.body).toMatchObject({
      kind: "tool",
      exportId: "export-tool",
      input: { uri: "file:///README.md" },
    });
    await remote.close();
  });

  it("does not overwrite real direct tools with generated primitive tools", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json({
            ...attachManifestWithDirectMcpPrimitives("rev-1"),
            tools: [
              {
                stableId: "tool:docs:read_resource",
                exportId: "export-tool",
                kind: "tool",
                name: "docs__read_resource",
                downstreamName: "read_resource",
                title: "Read Resource Tool",
                description: "A real downstream tool.",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
                outputSchema: { type: "object" },
                schemaHash: "sha256:tool",
                capletId: "docs",
                shadowing: "forbid",
              },
            ],
          });
        }
        return Response.json({ ok: true, data: { directTool: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const service = new RemoteNativeCapletsService({ client: remote, pollIntervalMs: 60_000 });

    await service.reload();

    const readResourceTools = service
      .listTools()
      .filter((tool) => tool.caplet === "docs__read_resource");
    expect(readResourceTools).toEqual([
      expect.objectContaining({
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ]);
    await service.close();
  });

  it("invokes the direct resource template matching the requested resource URI", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.endsWith("/manifest")) {
          return Response.json({
            ...attachManifestWithDirectMcpPrimitives("rev-1"),
            resources: [],
            resourceTemplates: [
              {
                stableId: "resourceTemplate:docs:file:///docs/{path}",
                exportId: "export-doc-resource-template",
                kind: "resourceTemplate",
                uriTemplate:
                  "caplets://docs/resources/{encodedUri}?template=file%3A%2F%2F%2Fdocs%2F%7Bpath%7D",
                downstreamUriTemplate: "file:///docs/{path}",
                title: "Docs",
                description: "Docs resource.",
                schemaHash: null,
                capletId: "docs",
                shadowing: "forbid",
              },
              {
                stableId: "resourceTemplate:docs:db:///{id}",
                exportId: "export-db-resource-template",
                kind: "resourceTemplate",
                uriTemplate:
                  "caplets://docs/resources/{encodedUri}?template=db%3A%2F%2F%2F%7Bid%7D",
                downstreamUriTemplate: "db:///{id}",
                title: "Database",
                description: "Database resource.",
                schemaHash: null,
                capletId: "docs",
                shadowing: "forbid",
              },
            ],
          });
        }
        return Response.json({ ok: true, data: { template: true } });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(remote.callTool("docs__read_resource", { uri: "db:///123" })).resolves.toEqual({
      template: true,
    });

    expect(requests.at(-1)?.body).toMatchObject({
      kind: "resourceTemplate",
      exportId: "export-db-resource-template",
      input: { uri: "db:///123" },
    });
    await remote.close();
  });

  it("retries stale manifests for primitive attached invokes", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/manifest")) {
        const manifestFetches = requests.filter((request) =>
          request.url.endsWith("/manifest"),
        ).length;
        return Response.json(
          manifestFetches === 1
            ? attachManifestWithDirectMcpPrimitives("rev-1")
            : {
                ...attachManifestWithDirectMcpPrimitives("rev-2"),
                resources: [
                  {
                    ...attachManifestWithDirectMcpPrimitives("rev-2").resources[0]!,
                    exportId: "export-resource-2",
                  },
                ],
              },
        );
      }
      if (
        url.endsWith("/invoke") &&
        requests.filter((request) => request.url.endsWith("/invoke")).length === 1
      ) {
        return Response.json(
          { ok: false, error: { code: "ATTACH_MANIFEST_STALE", message: "stale" } },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, data: { retried: true } });
    });
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });

    await remote.listTools();
    await expect(
      remote.callTool("docs__read_resource", { uri: "file:///README.md" }),
    ).resolves.toEqual({
      retried: true,
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://caplets.example.com/v1/attach/manifest",
      "https://caplets.example.com/v1/attach/invoke",
      "https://caplets.example.com/v1/attach/manifest",
      "https://caplets.example.com/v1/attach/invoke",
    ]);
    expect(requests.at(-1)?.body).toMatchObject({
      revision: "rev-2",
      exportId: "export-resource-2",
    });
    await remote.close();
  });

  it("advertises the Code Mode run input schema for attached Code Mode", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json({
            ...attachManifest("rev-1", "unused"),
            caplets: [],
            codeModeCaplets: [
              {
                stableId: "code_mode:remote-only",
                exportId: "export-remote-only",
                kind: "caplet",
                name: "Remote Only",
                description: "Remote-only handle.",
                schemaHash: null,
                capletId: "remote-only",
                shadowing: "forbid",
              },
            ],
          });
        }
        return Response.json({ ok: true, data: {} });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const service = new RemoteNativeCapletsService({ client: remote, pollIntervalMs: 60_000 });

    await service.reload();

    expect(service.listTools()).toContainEqual(
      expect.objectContaining({
        caplet: "code_mode",
        codeModeRun: true,
        description: expect.stringContaining("`meta.sessionId`"),
        promptGuidance: expect.arrayContaining([
          expect.stringContaining("omit sessionId to start fresh"),
          expect.stringContaining("returned meta.sessionId"),
          expect.stringContaining("meta.recoveryRef"),
        ]),
        inputSchema: expect.objectContaining({
          required: ["code"],
          properties: expect.objectContaining({
            code: expect.any(Object),
            sessionId: expect.objectContaining({
              description: expect.stringContaining("Omit to create a fresh reusable session"),
            }),
          }),
        }),
      }),
    );
    await service.close();
  });

  it("preserves non-JSON attach invoke HTTP status for auth classification", async () => {
    const remote = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: vi.fn(async (input) => {
        if (String(input).endsWith("/manifest")) {
          return Response.json(attachManifest("rev-1", "export-1"));
        }
        return new Response("gateway error", { status: 401 });
      }),
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
    });
    const service = new RemoteNativeCapletsService({
      client: remote,
      pollIntervalMs: 60_000,
      authKind: "hosted_cloud",
    });

    await service.reload();

    await expect(service.execute("remote", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Caplets Cloud authentication failed; run caplets cloud auth login.",
    });
    await service.close();
  });

  it("runs advertised remote Code Mode handles from standalone remote services", async () => {
    const fixture = client([
      {
        name: "code_mode",
        capletId: "code_mode",
        title: "Code Mode",
        codeModeRun: true,
        codeModeCaplets: [
          {
            stableId: "code_mode:remote-only",
            exportId: "export-remote-only",
            kind: "caplet",
            name: "Remote Only",
            description: "Remote-only handle.",
            schemaHash: null,
            capletId: "remote-only",
            shadowing: "forbid",
          },
        ],
      },
    ]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });
    await service.reload();

    await expect(
      service.execute("code_mode", {
        code: "return { keys: Object.keys(caplets).sort() };",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { keys: ["debug", "remote-only"] },
    });
    expect(fixture.api.callTool).not.toHaveBeenCalled();
    await service.close();
  });

  it("maps remote MCP tools to native Caplet tools", async () => {
    const fixture = client([{ name: "git-hub", title: undefined, description: "GitHub tools" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await service.reload();

    expect(service.listTools()).toEqual([
      expect.objectContaining({
        caplet: "git-hub",
        toolName: "caplets__git-hub",
        title: "git-hub",
      }),
    ]);
    expect(service.listTools()[0]?.description).toContain("GitHub tools");
    expect(service.listTools()[0]?.description).toContain("Native tool name: caplets__git-hub");
    expect(service.listTools()[0]?.description).toContain("Remote Caplet ID: git-hub");
    expect(service.listTools()[0]?.promptGuidance.join("\n")).toContain("remote Caplets service");

    await service.close();
  });

  it("executes by remote Caplet ID", async () => {
    const fixture = client();
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await expect(service.execute("alpha", { input: true })).resolves.toEqual({
      name: "alpha",
      args: { input: true },
    });
    expect(fixture.api.callTool).toHaveBeenCalledWith("alpha", { input: true });

    await service.close();
  });

  it("reconnects once and retries executions after session-like failures", async () => {
    const first = client();
    const second = client();
    first.api.callTool = vi.fn(async () => {
      throw new Error("transport connection closed");
    });
    second.api.callTool = vi.fn(async (name: string, args: unknown) => ({
      name,
      args,
      client: "second",
    }));
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
    });

    await expect(service.execute("alpha", { input: true })).resolves.toEqual({
      name: "alpha",
      args: { input: true },
      client: "second",
    });

    expect(first.api.callTool).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.api.close).toHaveBeenCalledTimes(1);
    expect(second.api.callTool).toHaveBeenCalledWith("alpha", { input: true });

    await service.close();
  });

  it("does not reconnect and retry application errors that mention invalid inputs", async () => {
    const first = client();
    const second = client();
    first.api.callTool = vi.fn(async () => {
      throw new Error("REQUEST_INVALID: invalid argument");
    });
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
    });

    await expect(service.execute("alpha", { input: true })).rejects.toThrow(
      /REQUEST_INVALID: invalid argument/u,
    );

    expect(first.api.callTool).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
    expect(second.api.callTool).not.toHaveBeenCalled();

    await service.close();
  });

  it("notifies listeners when remote tool list changes", async () => {
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    fixture.setTools([{ name: "beta", title: "Beta", description: "Beta" }]);

    fixture.emit();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());

    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ caplet: "beta", toolName: "caplets__beta" }),
    ]);
    await service.close();
  });

  it("keeps last known-good tools and warns when reload fails", async () => {
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const writeErr = vi.fn();
    const service = new RemoteNativeCapletsService({
      client: fixture.api,
      pollIntervalMs: 60_000,
      writeErr,
    });
    await service.reload();
    fixture.api.listTools = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "alpha" })]);
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Could not reload remote Caplets tools"),
    );
    await service.close();
  });

  it("reconnects once for invalid remote sessions and keeps last known-good tools if retry fails", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const writeErr = vi.fn();
    second.api.listTools = vi.fn(async () => {
      throw new Error("still closed connection");
    });
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
      writeErr,
    });
    await service.reload();
    first.api.listTools = vi.fn(async () => {
      throw new Error("invalid session");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.api.close).toHaveBeenCalledTimes(1);
    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "alpha" })]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("still closed connection"));
    await service.close();
  });

  it("does not create or retain a new client when closed during failed reconnect", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const firstClose = deferred();
    const writeErr = vi.fn();
    first.api.close = vi.fn(async (): Promise<undefined> => {
      await firstClose.promise;
      return undefined;
    });
    first.api.listTools = vi.fn(async () => {
      throw new Error("transport connection closed");
    });
    const factory = vi.fn(() => second.api);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: factory,
      pollIntervalMs: 60_000,
      writeErr,
    });

    const reload = service.reload();
    await vi.waitFor(() => expect(first.api.close).toHaveBeenCalledTimes(1));
    const closing = service.close();
    firstClose.resolve();

    await expect(reload).resolves.toBe(false);
    await closing;

    expect(factory).not.toHaveBeenCalled();
    expect(second.api.onToolsChanged).not.toHaveBeenCalled();
    expect(second.listenerCount()).toBe(0);
    expect(second.api.close).not.toHaveBeenCalled();
    expect(writeErr).not.toHaveBeenCalled();
  });

  it("reconnects once for invalid remote sessions and reloads from the new client", async () => {
    const first = client([{ name: "alpha", description: "Alpha" }]);
    const second = client([{ name: "beta", description: "Beta" }]);
    const service = new RemoteNativeCapletsService({
      client: first.api,
      clientFactory: vi.fn(() => second.api),
      pollIntervalMs: 60_000,
    });
    await service.reload();
    first.api.listTools = vi.fn(async () => {
      throw new Error("transport connection closed");
    });

    await expect(service.reload()).resolves.toBe(true);

    expect(service.listTools()).toEqual([expect.objectContaining({ caplet: "beta" })]);
    await service.close();
  });

  it("classifies remote auth failures with credential guidance", async () => {
    const fixture = client();
    fixture.api.callTool = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });

    await expect(service.execute("alpha", {})).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("CAPLETS_REMOTE_TOKEN"),
    } satisfies Partial<CapletsError>);

    await service.close();
  });

  it("polls the remote service as a fallback for tool changes", async () => {
    vi.useFakeTimers();
    const fixture = client([{ name: "alpha", description: "Alpha" }]);
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 1_000 });

    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() => expect(fixture.api.listTools).toHaveBeenCalledTimes(1));

    await service.close();
    vi.useRealTimers();
  });

  it("cleans up subscriptions, polling, listeners, and client close idempotently", async () => {
    vi.useFakeTimers();
    const fixture = client();
    const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 1_000 });
    service.onToolsChanged(vi.fn());
    expect(fixture.listenerCount()).toBe(1);

    await service.close();
    await service.close();
    vi.advanceTimersByTime(1_000);

    expect(fixture.listenerCount()).toBe(0);
    expect(fixture.api.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("createNativeCapletsService remote mode", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetNativeProjectBindingFallbackWarningForTests();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a composite service using the factory seam", async () => {
    const fixture = client();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
    });

    expect(service).not.toBeInstanceOf(RemoteNativeCapletsService);
    await service.close();
  });

  it("does not create the remote service when local overlay construction fails", () => {
    const fixture = client();
    const remoteClientFactory = vi.fn(() => fixture.api);
    const localServiceFactory = vi.fn(() => {
      throw new Error("local construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        remoteClientFactory,
        localServiceFactory,
      }),
    ).toThrow("local construction failed");

    expect(localServiceFactory).toHaveBeenCalledTimes(1);
    expect(remoteClientFactory).not.toHaveBeenCalled();
    expect(fixture.api.close).not.toHaveBeenCalled();
  });

  it("closes the local service when remote construction fails after local starts", () => {
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const remoteClientFactory = vi.fn(() => {
      throw new Error("remote construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory,
      }),
    ).toThrow("remote construction failed");

    expect(remoteClientFactory).toHaveBeenCalledTimes(1);
    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("reports local close failures when remote construction fails after local starts", async () => {
    const writeErr = vi.fn();
    const localClose = vi.fn(async () => {
      throw new Error("close failed");
    });
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const remoteClientFactory = vi.fn(() => {
      throw new Error("remote construction failed");
    });

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory,
        writeErr,
      }),
    ).toThrow("remote construction failed");

    expect(localClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(writeErr).toHaveBeenCalledWith(
        expect.stringContaining("Could not close local overlay Caplets service: close failed"),
      ),
    );
  });

  it("fails hard when explicit remote mode cannot create the remote Project Binding service", () => {
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };

    expect(() =>
      createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        localServiceFactory: vi.fn(() => localService),
        remoteClientFactory: vi.fn(() => {
          throw new Error("Project Binding unavailable");
        }),
      }),
    ).toThrow("Project Binding unavailable");

    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("falls back to local overlay once when configured remote Project Binding is unavailable", async () => {
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => {
        throw new Error("Project Binding unavailable");
      }),
      configPath,
      projectConfigPath,
      writeErr,
    });
    const secondService = createNativeCapletsService({
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => {
        throw new Error("Project Binding unavailable");
      }),
      configPath,
      projectConfigPath,
      writeErr,
    });

    expect(configuredCapletIds(service.listTools())).toEqual(["local"]);
    expect(writeErr).toHaveBeenCalledTimes(1);
    expect(writeErr).toHaveBeenCalledWith(
      "Remote project binding unavailable; using local Caplets only. Run caplets doctor for details.\n",
    );
    await service.close();
    await secondService.close();
  });

  it("keeps remote Caplets and suppresses matching local overlays by default", async () => {
    const fixture = client([
      { name: "shared", title: "Remote Shared" },
      { name: "remote-only", title: "Remote Only" },
    ]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        shared: { name: "Local Shared", description: "Local wins.", command: process.execPath },
        "local-only": { name: "Local Only", description: "Local only.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });

    await service.reload();

    expect(configuredCapletTitles(service.listTools())).toEqual([
      ["shared", "Remote Shared"],
      ["remote-only", "Remote Only"],
      ["local-only", "Local Only"],
    ]);
    expect(writeErr).toHaveBeenCalledWith(
      "Local Caplet 'shared' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n",
    );
    await service.close();
  });

  it("keeps local overlays visible when remote attach manifest allows shadowing", async () => {
    const fixture = client([
      { name: "shared", title: "Remote Shared", shadowing: "allow" },
      { name: "remote-only", title: "Remote Only" },
    ]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        shared: { name: "Local Shared", description: "Local wins.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });

    await service.reload();

    expect(configuredCapletTitles(service.listTools())).toEqual([
      ["shared", "Remote Shared"],
      ["remote-only", "Remote Only"],
      ["shared", "Local Shared"],
    ]);
    await expect(service.execute("shared", { operation: "inspect" })).resolves.toEqual(
      expect.objectContaining({ content: expect.any(Array) }),
    );
    expect(fixture.api.callTool).not.toHaveBeenCalled();
    expect(writeErr).not.toHaveBeenCalledWith(
      "Local Caplet 'shared' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n",
    );
    await service.close();
  });

  it("suppresses local direct tools by source Caplet ID when remote forbids shadowing", async () => {
    const fixture = client([{ name: "shared", title: "Remote Shared" }]);
    const writeErr = vi.fn();
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "shared__ping",
          sourceCaplet: "shared",
          toolName: "caplets__shared__ping",
          title: "Ping",
          description: "Local direct tool.",
          promptGuidance: [],
        },
      ]),
      execute: vi.fn(async () => ({ local: true })),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
      writeErr,
    });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(["shared"]);
    expect(service.listTools().map((tool) => tool.caplet)).not.toContain("shared__ping");
    await service.execute("shared__ping", { message: "hi" });
    expect(localService.execute).not.toHaveBeenCalled();
    expect(fixture.api.callTool).toHaveBeenCalledWith("shared__ping", { message: "hi" });
    expect(writeErr).toHaveBeenCalledWith(
      "Local Caplet 'shared' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n",
    );
    await service.close();
  });

  it("executes local direct tool overlays when remote direct exports allow shadowing", async () => {
    const fixture = client([
      {
        name: "shared__ping",
        sourceCapletId: "shared",
        title: "Remote Ping",
        description: "Remote direct tool.",
        shadowing: "allow",
      },
    ]);
    const localExecute = vi.fn(async () => ({ local: true }));
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "shared__ping",
          sourceCaplet: "shared",
          toolName: "caplets__shared__ping",
          title: "Ping",
          description: "Local direct tool.",
          promptGuidance: [],
        },
      ]),
      execute: localExecute,
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies NativeCapletsService;
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
    });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(["shared__ping", "shared__ping"]);
    await expect(service.execute("shared__ping", { message: "hi" })).resolves.toEqual({
      local: true,
    });
    expect(localExecute).toHaveBeenCalledWith("shared__ping", { message: "hi" });
    expect(fixture.api.callTool).not.toHaveBeenCalled();
    await service.close();
  });

  it("marks generated local direct tools with their source Caplet ID", async () => {
    const { dir, configPath, projectConfigPath } = tempConfig({
      options: { exposure: "direct" },
      httpApis: {
        shared: {
          name: "Local Shared",
          description: "Local direct HTTP tools.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      configPath,
      projectConfigPath,
    });

    try {
      expect(service.listTools()).toContainEqual(
        expect.objectContaining({
          caplet: "shared__ping",
          sourceCaplet: "shared",
        }),
      );
    } finally {
      await service.close();
    }
  });

  it("warns when a local Code Mode-only Caplet is suppressed by remote Code Mode", async () => {
    const fixture = client([
      {
        name: "code_mode",
        capletId: "code_mode",
        title: "Code Mode",
        codeModeRun: true,
        codeModeCaplets: [
          {
            stableId: "code_mode:shared",
            exportId: "export-shared",
            kind: "caplet",
            name: "Remote Shared",
            description: "Remote shared handle.",
            schemaHash: null,
            capletId: "shared",
            shadowing: "forbid",
          },
        ],
      },
    ]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      options: { exposure: "code_mode" },
      mcpServers: {
        shared: {
          name: "Local Shared",
          description: "Local shared handle.",
          command: process.execPath,
        },
      },
    });
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });

    await service.reload();

    expect(writeErr).toHaveBeenCalledWith(
      "Local Caplet 'shared' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n",
    );
    await service.close();
  });

  it("does not execute local Code Mode handles shadowed by remote direct tools", async () => {
    const fixture = client([
      {
        name: "shared__ping",
        sourceCapletId: "shared",
        title: "Ping",
        description: "Remote direct tool.",
      },
    ]);
    const localExecute = vi.fn(async () => ({ local: true }));
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "code_mode",
          toolName: "caplets__code_mode",
          title: "Local Code",
          description: "Local Code Mode handle.",
          codeModeRun: true,
          codeModeCaplets: [
            {
              id: "shared",
              name: "Shared",
              description: "Local shared Code Mode handle.",
            },
          ],
          promptGuidance: [],
        },
      ]),
      execute: localExecute,
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies NativeCapletsService;
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
    });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(["shared__ping"]);
    await service.execute("shared", { operation: "check" });

    expect(localExecute).not.toHaveBeenCalled();
    expect(fixture.api.callTool).toHaveBeenCalledWith("shared", { operation: "check" });
    await service.close();
  });

  it("keeps visible local Code Mode handles in composite Code Mode declarations", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await service.reload();

    const tools = service.listTools();
    expect(configuredCapletIds(tools)).toEqual(["remote-only", "local"]);
    expect(tools.find((tool) => tool.caplet === "code_mode")).toEqual(
      expect.objectContaining({
        codeModeRun: true,
        description: expect.stringContaining("`meta.sessionId`"),
        promptGuidance: expect.arrayContaining([
          expect.stringContaining("omit sessionId to start fresh"),
        ]),
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            sessionId: expect.objectContaining({
              type: "string",
              description: expect.stringContaining("Unknown or unavailable session IDs fail"),
            }),
          }),
        }),
        codeModeCaplets: expect.arrayContaining([
          expect.objectContaining({ id: "remote-only" }),
          expect.objectContaining({ id: "local" }),
        ]),
      }),
    );
    await service.close();
  });

  it("executes local overlay Code Mode handles locally", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const localExecute = vi.fn(async (capletId: string, request: unknown) => ({
      capletId,
      request,
      status: "available",
    }));
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "code_mode",
          toolName: "caplets__code_mode",
          title: "Local Code",
          description: "Local Code Mode handle.",
          codeModeRun: true,
          codeModeCaplets: [
            {
              id: "local-code",
              name: "Local Code",
              description: "Local Code Mode handle.",
            },
          ],
          promptGuidance: [],
        },
      ]),
      execute: localExecute,
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies NativeCapletsService;
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
    });

    await service.reload();

    await expect(
      service.execute("code_mode", {
        code: 'return await caplets["local-code"].check();',
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        ok: true,
        data: {
          capletId: "local-code",
          request: { operation: "check" },
          status: "available",
        },
      },
    });
    expect(localExecute).toHaveBeenCalledWith("local-code", { operation: "check" });
    expect(fixture.api.callTool).not.toHaveBeenCalledWith("local-code", {
      operation: "check",
    });
    await service.close();
  });

  it("does not make attach-visible remote tools callable from Code Mode when the manifest is explicit empty", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only", codeModeCaplets: [] }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      options: { exposure: "code_mode" },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(["remote-only"]);
    expect(service.listTools().some((tool) => tool.caplet === "code_mode")).toBe(false);
    await service.close();
  });

  it("executes local overlay Caplets locally and remote-only Caplets remotely", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();

    await expect(service.execute("local", { operation: "inspect" })).resolves.toEqual(
      expect.objectContaining({ content: expect.any(Array) }),
    );
    await expect(service.execute("remote-only", { input: true })).resolves.toEqual({
      name: "remote-only",
      args: { input: true },
    });

    expect(fixture.api.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.api.callTool).toHaveBeenCalledWith("remote-only", { input: true });
    await service.close();
  });

  it("returns structured errors for invalid composite Code Mode payloads", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const localExecute = vi.fn(async () => {
      throw new Error("local should not receive invalid code mode");
    });
    const localService = {
      listTools: vi.fn(() => []),
      execute: localExecute,
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
    });

    await expect(service.execute("code_mode", { timeoutMs: 1_000 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Code Mode run input is invalid.",
      },
      diagnostics: [],
    });
    const result = (await service.execute("code_mode", { timeoutMs: 1_000 })) as {
      meta: Record<string, unknown>;
    };
    expect(result.meta).toMatchObject({
      sessionId: null,
      sessionStatus: null,
      recoveryRef: null,
    });
    expect(localExecute).not.toHaveBeenCalled();
    expect(fixture.api.callTool).not.toHaveBeenCalled();
    await service.close();
  });

  it("keeps composite Code Mode scoped to code-mode-callable Caplets", async () => {
    const fixture = client([{ name: "remote-only", title: "Remote Only" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        "local-progressive": {
          name: "Local Progressive",
          description: "Visible locally, but not callable from Code Mode.",
          exposure: "progressive",
          command: process.execPath,
        },
      },
      httpApis: {
        "local-code": {
          name: "Local Code",
          description: "Callable from Code Mode.",
          exposure: "code_mode",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    try {
      await service.reload();

      const first = (await service.execute("code_mode", {
        code: "var counter = 1;\nreturn { keys: Object.keys(caplets).sort(), counter };",
      })) as { meta: { sessionId: string } };
      await expect(
        service.execute("code_mode", {
          code: "counter += 1;\nreturn { keys: Object.keys(caplets).sort(), counter };",
          sessionId: first.meta.sessionId,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          counter: 2,
          keys: ["debug", "local-code", "remote-only"],
        },
        meta: {
          sessionId: first.meta.sessionId,
          sessionStatus: "reused",
          recoveryRef: null,
        },
      });
    } finally {
      await service.close();
    }
  });

  it("loads code-mode-default remote Caplets from the attach endpoint", async () => {
    const remoteConfig = tempConfig({
      options: { exposure: "code_mode" },
      httpApis: {
        "stealth-browser-use": {
          name: "Stealth Browser Use",
          description: "Remote browser tools.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { ping: { method: "GET", path: "/ping" } },
        },
      },
    });
    const localConfig = tempConfig({ options: { exposure: "code_mode" } });
    dirs.push(remoteConfig.dir, localConfig.dir);
    const remoteEngine = new CapletsEngine({
      configPath: remoteConfig.configPath,
      projectConfigPath: remoteConfig.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions(), remoteEngine, { writeErr: () => {} });
    const fetchFromApp: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(request.url).host);
      return app.fetch(new Request(request, { headers }));
    };
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387", fetch: fetchFromApp },
      configPath: localConfig.configPath,
      projectConfigPath: localConfig.projectConfigPath,
    });

    try {
      await service.reload();

      expect(configuredCapletIds(service.listTools())).toEqual([]);
      await expect(
        service.execute("code_mode", {
          code: "return { keys: Object.keys(caplets).sort() };",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          keys: ["debug", "stealth-browser-use"],
        },
      });
    } finally {
      await service.close();
      await remoteEngine.close();
    }
  });

  it("emits one merged tools-changed event only when the merged set changes", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);

    fixture.setTools([{ name: "beta", title: "Beta" }]);
    fixture.emit();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    expect(configuredCapletIds(listener.mock.calls[0]?.[0] ?? [])).toEqual(["beta", "local"]);
    await expect(service.reload()).resolves.toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("emits one merged tools-changed event when both children change during explicit reload", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    fixture.setTools([{ name: "beta", title: "Beta" }]);
    writeFileSync(
      configPath,
      JSON.stringify(
        progressiveTestConfig({
          mcpServers: {
            local: {
              name: "Local Renamed",
              description: "Local Caplet.",
              command: process.execPath,
            },
          },
        }),
      ),
      "utf8",
    );

    await expect(service.reload()).resolves.toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(configuredCapletTitles(listener.mock.calls[0]?.[0] ?? [])).toEqual([
      ["beta", "Beta"],
      ["local", "Local Renamed"],
    ]);
    await service.close();
  });

  it("isolates listener failures while continuing notifications during reload", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    service.onToolsChanged(() => {
      throw new Error("listener exploded");
    });
    const secondListener = vi.fn();
    service.onToolsChanged(secondListener);
    fixture.setTools([{ name: "beta", title: "Beta" }]);

    await expect(service.reload()).resolves.toBe(true);

    expect(configuredCapletIds(secondListener.mock.calls[0]?.[0] ?? [])).toEqual(["beta", "local"]);
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Caplets tools-changed listener failed"),
    );
    await service.close();
  });

  it("keeps last known-good merged tools and warns when a child reload rejects unexpectedly", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    const listener = vi.fn();
    service.onToolsChanged(listener);
    const remote = (service as unknown as { remote: { reload: () => Promise<boolean> } }).remote;
    remote.reload = vi.fn(async () => {
      fixture.setTools([{ name: "beta", title: "Beta" }]);
      throw new Error("remote exploded");
    });

    await expect(service.reload()).resolves.toBe(false);

    expect(configuredCapletTitles(service.listTools())).toEqual([
      ["alpha", "Alpha"],
      ["local", "Local"],
    ]);
    expect(listener).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledWith(
      expect.stringContaining("Could not reload composite Caplets tools"),
    );
    await service.close();
  });

  it("keeps the last known-good merged tools when local overlay reload only warns", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();
    writeFileSync(configPath, "{ invalid json", "utf8");

    await expect(service.reload()).resolves.toBe(true);

    expect(configuredCapletIds(service.listTools())).toEqual(["remote", "local"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("Caplets local overlay warning"));
    await service.close();
  });

  it("starts with remote tools when initial local overlay loading warns", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    writeFileSync(configPath, "{ invalid json", "utf8");

    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });

    await service.reload();

    expect(configuredCapletIds(service.listTools())).toEqual(["remote"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("Caplets local overlay warning"));
    await service.close();
  });

  it("starts Cloud Project Binding when native service runs in cloud mode", async () => {
    const path = tempCloudAuthPath();
    vi.stubEnv("CAPLETS_CLOUD_AUTH_PATH", path);
    await new CloudAuthStore({ path }).save(hostedCredentials({ accessToken: "cloud-access" }));
    const factory = vi.fn(() => client([{ name: "remote", description: "Remote" }]).api);
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      mode: "cloud",
      remote: { url: "https://cloud.caplets.dev/v1/ws/personal/mcp" },
      remoteClientFactory: factory,
      configPath,
      projectConfigPath,
    });

    await service.reload();
    expect(service.listTools().map((tool) => tool.caplet)).toContain("remote");
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL("https://cloud.caplets.dev/v1/ws/personal/attach"),
        requestInit: { headers: { Authorization: "Bearer cloud-access" } },
      }),
    );
    await service.close();
  });

  it("picks up valid local overlay additions when existing warnings are unchanged", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const { dir, configPath, projectConfigPath } = tempConfig({});
    const badCapletPath = join(dirname(configPath), "bad.md");
    dirs.push(dir);
    writeFileSync(
      badCapletPath,
      ["---", "name: Bad", "description: Missing backend config.", "---", "# Bad"].join("\n"),
      "utf8",
    );
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      writeErr,
    });
    await service.reload();

    writeFileSync(
      join(dirname(configPath), "local.md"),
      [
        "---",
        "name: Local",
        "description: Local Caplet.",
        "exposure: progressive_and_code_mode",
        "mcpServer:",
        `  command: ${JSON.stringify(process.execPath)}`,
        "---",
        "# Local",
      ].join("\n"),
      "utf8",
    );

    await expect(service.reload()).resolves.toBe(true);

    expect(configuredCapletIds(service.listTools())).toEqual(["remote", "local"]);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(badCapletPath));
    await service.close();
  });

  it("closes remote and local overlay services idempotently", async () => {
    vi.useFakeTimers();
    const fixture = client();
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387", pollIntervalMs: 1_000 },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await service.close();
    await service.close();
    vi.advanceTimersByTime(1_000);

    expect(fixture.api.close).toHaveBeenCalledTimes(1);
    expect(fixture.api.listTools).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("registers and tears down local presence in cloud remote mode", async () => {
    const fixture = client();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/api/project-bindings") && init?.method === "POST") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        if (url.pathname.endsWith("/api/project-bindings/presence_1") && init?.method === "PATCH") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
        cloud: {
          url: "https://cloud.caplets.dev",
          accessToken: "token",
          workspaceId: "ws_1",
          projectRoot: dirname(projectConfigPath),
          heartbeatIntervalMs: 60_000,
        },
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.anything()));
    await service.close();

    const projectBindingBodies = fetch.mock.calls
      .map(([, init]) => init?.body)
      .filter((body): body is string => typeof body === "string")
      .map(
        (body) => JSON.parse(body) as { projectFiles?: Array<{ path: string; content: string }> },
      );
    expect(projectBindingBodies[0]?.projectFiles).toEqual([{ path: "config.json", content: "{}" }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings/presence_1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "offline" }),
      }),
    );
  });

  it("updates local presence after local overlay reload changes the Caplet set", async () => {
    const fixture = client();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/api/project-bindings") && init?.method === "POST") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        if (url.pathname.endsWith("/api/project-bindings/presence_1") && init?.method === "PATCH") {
          return Response.json({
            binding: { bindingId: "presence_1" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
        cloud: {
          url: "https://cloud.caplets.dev",
          accessToken: "token",
          workspaceId: "ws_1",
          projectRoot: dirname(projectConfigPath),
        },
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.anything()));

    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { name: "Local", description: "Local Caplet.", command: process.execPath },
        },
      }),
      "utf8",
    );
    await service.reload();

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings"),
      expect.objectContaining({ method: "POST" }),
    );
    await service.close();
  });

  it("fails fast for invalid remote config", () => {
    expect(() =>
      createNativeCapletsService({ mode: "remote", remote: { url: "http://example.com" } }),
    ).toThrow(/https/u);
  });
});

function tempConfig(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-native-remote-"));
  const userDir = join(dir, "user");
  const projectDir = join(dir, "project", ".caplets");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const configPath = join(userDir, "config.json");
  const projectConfigPath = join(projectDir, "config.json");
  writeFileSync(configPath, JSON.stringify(progressiveTestConfig(config)), "utf8");
  writeFileSync(projectConfigPath, JSON.stringify({}), "utf8");
  return { dir, configPath, projectConfigPath };
}

function progressiveTestConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (record.options) return config;
  return { options: { exposure: "progressive_and_code_mode" }, ...record };
}

function configuredCapletIds(tools: Array<{ caplet: string }>): string[] {
  return tools.map((tool) => tool.caplet).filter((caplet) => caplet !== "code_mode");
}

function configuredCapletTitles(tools: Array<{ caplet: string; title: string }>): string[][] {
  return tools
    .filter((tool) => tool.caplet !== "code_mode")
    .map((tool) => [tool.caplet, tool.title]);
}

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    path: "/",
    publicOrigin: undefined,
    auth: { enabled: false, user: "caplets" },
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    ...overrides,
  };
}
