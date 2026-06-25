import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectBindingSessionManager } from "../src/cloud/presence";
import { CAPLETS_ATTACH_SESSION_HEADER } from "../src/attach/api";
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
import { recordTelemetryNoticeShown } from "../src/telemetry";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
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
  it("creates an attach session before fetching a session-aware manifest", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const request = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      requests.push(request);
      if (url.endsWith("/sessions")) {
        return Response.json({ sessionId: "attach_session_123" }, { status: 201 });
      }
      if (url.endsWith("/manifest")) {
        return Response.json(attachManifest("rev-1", "export-1"));
      }
      if (url.endsWith("/invoke")) {
        return Response.json({ ok: true, data: { invoked: true } });
      }
      return Response.json({ ok: true });
    });
    const client = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
      attachSessionMetadata: {
        projectRoot: "/repo",
        projectConfigPath: "/repo/.caplets/config.json",
      },
    });

    await client.listTools();
    await expect(client.callTool("remote", {})).resolves.toEqual({ invoked: true });
    await client.close();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://caplets.example.com/v1/attach/sessions",
      "GET https://caplets.example.com/v1/attach/manifest",
      "POST https://caplets.example.com/v1/attach/invoke",
      "DELETE https://caplets.example.com/v1/attach/sessions/attach_session_123",
    ]);
    expect(requests[0]?.body).toEqual({
      projectRoot: "/repo",
      projectConfigPath: "/repo/.caplets/config.json",
    });
    expect(requests[1]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBe("attach_session_123");
    expect(requests[2]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBe("attach_session_123");
  });

  it("retries attach session discovery after an unsupported cooldown", async () => {
    let now = new Date("2026-06-23T00:00:00.000Z").getTime();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let sessionsSupported = false;
      const requests: Array<{ url: string; method: string; headers: Headers }> = [];
      const fetchStub: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        requests.push({ url, method, headers });
        if (url.endsWith("/sessions") && method === "POST") {
          return sessionsSupported
            ? Response.json({ sessionId: "attach_session_123" }, { status: 201 })
            : Response.json({ ok: false }, { status: 404 });
        }
        if (url.endsWith("/manifest")) {
          return Response.json(attachManifest("rev-1", "export-1"));
        }
        return Response.json({ ok: true });
      });
      const client = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: fetchStub,
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
        attachSessionMetadata: { projectRoot: "/repo" },
      });

      await client.listTools();
      await client.listTools();
      sessionsSupported = true;
      now += 60_000;
      await client.listTools();
      await client.close();

      const sessionRequests = requests.filter(
        (request) => request.url.endsWith("/sessions") && request.method === "POST",
      );
      const manifestRequests = requests.filter((request) => request.url.endsWith("/manifest"));
      expect(sessionRequests).toHaveLength(2);
      expect(
        manifestRequests.map((request) => request.headers.get(CAPLETS_ATTACH_SESSION_HEADER)),
      ).toEqual([null, null, "attach_session_123"]);
      expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
        "DELETE https://caplets.example.com/v1/attach/sessions/attach_session_123",
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it("falls back to a plain attach manifest when project-context sessions are rejected", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ url, method, headers });
      if (url.endsWith("/sessions")) {
        return Response.json(
          {
            ok: false,
            error: {
              code: "REQUEST_INVALID",
              message: "Attach session project context is only accepted by loopback runtimes.",
            },
          },
          { status: 400 },
        );
      }
      if (url.endsWith("/manifest")) {
        return Response.json(attachManifest("rev-1", "export-1"));
      }
      return Response.json({ ok: true });
    });
    const client = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
      attachSessionMetadata: { projectRoot: "/repo" },
    });

    await client.listTools();
    await client.close();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://caplets.example.com/v1/attach/sessions",
      "GET https://caplets.example.com/v1/attach/manifest",
    ]);
    expect(requests[1]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBeNull();
  });

  it("falls back to a plain attach manifest when session creation stalls", async () => {
    vi.useFakeTimers();
    try {
      const requests: Array<{ url: string; method: string; headers: Headers }> = [];
      const fetchStub: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        requests.push({ url, method, headers });
        if (url.endsWith("/sessions")) {
          return await new Promise<Response>(() => undefined);
        }
        if (url.endsWith("/manifest")) {
          return Response.json(attachManifest("rev-1", "export-1"));
        }
        return Response.json({ ok: true });
      });
      const client = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: fetchStub,
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
        attachSessionMetadata: { projectRoot: "/repo" },
      });

      const listed = client.listTools();
      await vi.waitFor(() =>
        expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
          "POST https://caplets.example.com/v1/attach/sessions",
        ]),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(listed).resolves.toEqual([
        expect.objectContaining({ name: "remote", capletId: "remote" }),
      ]);
      await client.close();

      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://caplets.example.com/v1/attach/sessions",
        "GET https://caplets.example.com/v1/attach/manifest",
      ]);
      expect(requests[1]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recreates attach sessions when the remote forgets the previous session", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ url, method, headers });
      if (url.endsWith("/sessions")) {
        const count = requests.filter((request) => request.url.endsWith("/sessions")).length;
        return Response.json({ sessionId: `attach_session_${count}` }, { status: 201 });
      }
      if (
        url.endsWith("/manifest") &&
        headers.get(CAPLETS_ATTACH_SESSION_HEADER) === "attach_session_1"
      ) {
        return Response.json(
          {
            ok: false,
            error: { code: "REQUEST_INVALID", message: "Attach session was not found." },
          },
          { status: 400 },
        );
      }
      if (url.endsWith("/manifest")) {
        return Response.json(attachManifest("rev-1", "export-1"));
      }
      return Response.json({ ok: true });
    });
    const client = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
      attachSessionMetadata: { projectRoot: "/repo" },
    });

    await client.listTools();
    await client.close();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://caplets.example.com/v1/attach/sessions",
      "GET https://caplets.example.com/v1/attach/manifest",
      "POST https://caplets.example.com/v1/attach/sessions",
      "GET https://caplets.example.com/v1/attach/manifest",
      "DELETE https://caplets.example.com/v1/attach/sessions/attach_session_2",
    ]);
    expect(requests[1]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBe("attach_session_1");
    expect(requests[3]?.headers.get(CAPLETS_ATTACH_SESSION_HEADER)).toBe("attach_session_2");
  });

  it("closes attach sessions that finish creating during client shutdown", async () => {
    const sessionsStarted = deferred<Response>();
    const requests: Array<{ url: string; method: string }> = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/sessions") && method === "POST") {
        return await sessionsStarted.promise;
      }
      return Response.json({ ok: true });
    });
    const client = createSdkRemoteCapletsClient({
      url: new URL("https://caplets.example.com/v1/attach"),
      requestInit: {},
      fetch: fetchStub,
      auth: { enabled: false, user: "caplets" },
      pollIntervalMs: 60_000,
      attachSessionMetadata: { projectRoot: "/repo" },
    });

    const listTools = client.listTools();
    await vi.waitFor(() =>
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST https://caplets.example.com/v1/attach/sessions",
      ]),
    );
    const close = client.close();
    sessionsStarted.resolve(Response.json({ sessionId: "attach_session_123" }, { status: 201 }));
    await close;
    await expect(listTools).rejects.toThrow();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
      "DELETE https://caplets.example.com/v1/attach/sessions/attach_session_123",
    );
  });

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

  it("uses refreshed runtime options when reconnecting the attach events stream", async () => {
    vi.useFakeTimers();
    try {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const eventAuthHeaders: Array<string | null> = [];
      let token = "token-1";
      const fetchStub: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
        if (url.endsWith("/events")) {
          eventAuthHeaders.push(new Headers(init?.headers).get("authorization"));
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
      const remoteOptions = () => ({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: fetchStub,
        auth: { enabled: false, user: "caplets" } as const,
        pollIntervalMs: 60_000,
      });
      const remote = createSdkRemoteCapletsClient({
        ...remoteOptions(),
        resolveRuntimeOptions: async () => remoteOptions(),
      });

      remote.onToolsChanged(vi.fn());
      await vi.waitFor(() => expect(controllers).toHaveLength(1));
      token = "token-2";
      controllers[0]!.close();
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => expect(controllers).toHaveLength(2));
      expect(eventAuthHeaders).toEqual(["Bearer token-1", "Bearer token-2"]);
      await remote.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect attach events after permanent runtime credential failures", async () => {
    vi.useFakeTimers();
    try {
      const writeErr = vi.fn();
      const resolveRuntimeOptions = vi.fn(async () => {
        const error = new Error("Remote Login required.");
        Object.assign(error, { projectBindingCode: "remote_credentials_revoked" });
        throw error;
      });
      const remote = createSdkRemoteCapletsClient({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: {},
        fetch: vi.fn(async () => Response.json(attachManifest("rev-1", "export-1"))),
        auth: { enabled: false, user: "caplets" },
        pollIntervalMs: 60_000,
        resolveRuntimeOptions,
        writeErr,
      });

      remote.onToolsChanged(vi.fn());
      await vi.waitFor(() => expect(resolveRuntimeOptions).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(resolveRuntimeOptions).toHaveBeenCalledTimes(1);
      expect(writeErr).toHaveBeenCalledWith(
        "Remote Caplets authentication failed; run caplets remote login <url>.\n",
      );
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
      message: "Caplets Cloud authentication failed; run caplets remote login <cloud-url>.",
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
      message: "Remote Caplets authentication failed; run caplets remote login <url>.",
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

  it("uses refreshed runtime options when fallback polling the remote service", async () => {
    vi.useFakeTimers();
    try {
      const manifestAuthHeaders: Array<string | null> = [];
      let token = "token-1";
      const fetchStub: typeof fetch = vi.fn(async (input, init) => {
        if (String(input).endsWith("/manifest")) {
          manifestAuthHeaders.push(new Headers(init?.headers).get("authorization"));
          return Response.json(attachManifest("rev-1", "export-1"));
        }
        return Response.json({ ok: true });
      });
      const remoteOptions = () => ({
        url: new URL("https://caplets.example.com/v1/attach"),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: fetchStub,
        auth: { enabled: false, user: "caplets" } as const,
        pollIntervalMs: 60_000,
      });
      const remote = createSdkRemoteCapletsClient({
        ...remoteOptions(),
        resolveRuntimeOptions: async () => remoteOptions(),
      });
      const service = new RemoteNativeCapletsService({ client: remote, pollIntervalMs: 1_000 });

      await service.reload();
      token = "token-2";
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => expect(manifestAuthHeaders).toContain("Bearer token-2"));
      expect(manifestAuthHeaders[0]).toBe("Bearer token-1");
      await service.close();
    } finally {
      vi.useRealTimers();
    }
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

  it("refreshes composite telemetry config on reload and shuts down the dispatcher", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha", description: "Remote alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const stateDir = join(dir, "state");
    recordTelemetryNoticeShown({ stateDir, surface: "cli" });
    const capture = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      telemetryStateDir: stateDir,
      telemetryEnv: {},
      telemetryDispatcher: { capture, shutdown },
    });

    await service.reload();
    await service.execute("alpha", { operation: "inspect" });
    await expect.poll(() => capture.mock.calls.length).toBe(1);

    writeFileSync(configPath, JSON.stringify(progressiveTestConfig({ telemetry: false })), "utf8");
    await expect(service.reload()).resolves.toBe(true);
    await service.execute("alpha", { operation: "inspect" });
    await expect.poll(() => capture.mock.calls.length).toBe(1);

    await service.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("honors native telemetry opt-out when local overlay config has invalid backends", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha", description: "Remote alpha" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    writeFileSync(
      configPath,
      JSON.stringify({
        telemetry: false,
        mcpServers: {
          invalid: { name: "Invalid", description: "Missing command." },
        },
      }),
      "utf8",
    );
    const stateDir = join(dir, "state");
    recordTelemetryNoticeShown({ stateDir, surface: "cli" });
    const capture = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      telemetryStateDir: stateDir,
      telemetryEnv: {},
      telemetryDispatcher: { capture, shutdown: vi.fn(async () => undefined) },
    });

    await service.reload();
    await service.execute("alpha", { operation: "inspect" });

    expect(capture).not.toHaveBeenCalled();
    await service.close();
  });

  it("loads self-hosted native remote credentials from a saved Remote Profile", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "profile-access-token",
        refreshToken: "profile-refresh-token",
        expiresAt: "2099-06-19T12:00:00.000Z",
      },
    });
    const authorizationHeaders: Array<string | null> = [];
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (_input, init) => {
          authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
          return Response.json(attachManifest("rev-1", "export-1"));
        }) as typeof fetch,
      },
    });

    await service.reload();

    expect(authorizationHeaders).toContain("Bearer profile-access-token");
    expect(configuredCapletIds(service.listTools())).toContain("remote");
    await service.close();
  });

  it("preserves configured Cloud workspace when resolving profile-backed native remotes", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-cloud-auth-"));
    dirs.push(authDir);
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      credentials: {
        accessToken: "cloud-access-token",
        refreshToken: "cloud-refresh-token",
        expiresAt: "2099-06-19T12:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    await store.clearSelectedCloudWorkspace("https://cloud.caplets.dev");
    const manifestUrls: string[] = [];
    const service = createNativeCapletsService({
      mode: "cloud",
      authDir,
      remote: {
        url: "https://cloud.caplets.dev",
        workspace: "team",
        fetch: (async (input, init) => {
          manifestUrls.push(String(input));
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloud-access-token");
          return Response.json(attachManifest("rev-1", "export-1"));
        }) as typeof fetch,
      },
    });

    try {
      await service.reload();

      expect(manifestUrls).toContain("https://cloud.caplets.dev/v1/ws/team/attach/manifest");
      expect(configuredCapletIds(service.listTools())).toContain("remote");
    } finally {
      await service.close();
    }
  });

  it("refreshes saved self-hosted native remote credentials before reloading", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2999-06-19T12:00:00.000Z",
      },
    });
    const authorizationHeaders: Array<string | null> = [];
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (input, init) => {
          if (String(input).endsWith("/v1/remote/refresh")) {
            return Response.json({
              clientId: "client_123",
              clientLabel: "Native Test",
              accessToken: "new-access-token",
              refreshToken: "new-refresh-token",
              expiresAt: "2999-06-19T12:00:00.000Z",
            });
          }
          authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
          return Response.json(attachManifest("rev-1", "export-1"));
        }) as typeof fetch,
      },
    });

    await service.reload();
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });
    await service.reload();

    expect(authorizationHeaders[0]).toBe("Bearer old-access-token");
    expect(authorizationHeaders.at(-1)).toBe("Bearer new-access-token");
    await service.close();
  });

  it("loads refreshed profile-backed remote tools before replacing the active delegate", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2999-06-19T12:00:00.000Z",
      },
    });
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.endsWith("/v1/remote/refresh")) {
            return Response.json({
              clientId: "client_123",
              clientLabel: "Native Test",
              accessToken: "new-access-token",
              refreshToken: "new-refresh-token",
              expiresAt: "2999-06-19T12:00:00.000Z",
            });
          }
          const auth = new Headers(init?.headers).get("authorization");
          const manifest = attachManifest(
            auth === "Bearer new-access-token" ? "rev-2" : "rev-1",
            auth === "Bearer new-access-token" ? "export-2" : "export-1",
          );
          manifest.caplets[0]!.title =
            auth === "Bearer new-access-token" ? "Remote Updated" : "Remote";
          return Response.json(manifest);
        }) as typeof fetch,
      },
    });
    await service.reload();
    const emitted = new Array<string[][]>();
    service.onToolsChanged((tools) => emitted.push(configuredCapletTitles(tools)));
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    await service.reload();

    expect(emitted).toEqual([[["remote", "Remote Updated"]]]);
    await service.close();
  });

  it("does not start replacement presence when closed during remote replacement", async () => {
    const fixture = client([{ name: "alpha", title: "Alpha" }]);
    const previousCloseStarted = deferred();
    const releasePreviousClose = deferred();
    fixture.api.close = vi.fn(async () => {
      previousCloseStarted.resolve();
      await releasePreviousClose.promise;
    });
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
    }) as NativeCapletsService & {
      replaceRemote(
        remote: NativeCapletsService,
        presence?: ProjectBindingSessionManager,
      ): Promise<void>;
    };
    const replacement = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    };
    const replacementPresence = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      updateAllowedCapletIds: vi.fn(async () => undefined),
    } as unknown as ProjectBindingSessionManager;

    const replacing = service.replaceRemote(replacement, replacementPresence);
    await previousCloseStarted.promise;
    const closing = service.close();
    releasePreviousClose.resolve();
    await Promise.all([replacing, closing]);

    expect(replacementPresence.close).toHaveBeenCalledTimes(1);
    expect(replacementPresence.start).not.toHaveBeenCalled();
  });

  it("does not create a profile-backed delegate when closed while resolving credentials", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    const manifestRequests: string[] = [];
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (input) => {
          const url = String(input);
          if (url.endsWith("/v1/remote/refresh")) {
            refreshStarted.resolve();
            await releaseRefresh.promise;
            return Response.json({
              clientId: "client_123",
              clientLabel: "Native Test",
              accessToken: "new-access-token",
              refreshToken: "new-refresh-token",
              expiresAt: "2999-06-19T12:00:00.000Z",
            });
          }
          manifestRequests.push(url);
          return Response.json(attachManifest("rev-1", "export-1"));
        }) as typeof fetch,
      },
      localServiceFactory: vi.fn(() => localService),
    });

    const reload = service.reload();
    await refreshStarted.promise;
    const closing = service.close();
    releaseRefresh.resolve();
    await Promise.all([reload, closing]);

    expect(localClose).toHaveBeenCalledTimes(1);
    expect(manifestRequests).toEqual([]);
  });

  it("refreshes saved self-hosted native remote credentials before executing", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-19T12:00:00.000Z"));
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2026-06-19T12:02:00.000Z",
      },
    });
    const authorizationHeaders: Array<string | null> = [];
    let refreshCalls = 0;
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (input, init) => {
          const url = String(input);
          if (url.endsWith("/v1/remote/refresh")) {
            refreshCalls += 1;
            return Response.json({
              clientId: "client_123",
              clientLabel: "Native Test",
              accessToken: "new-access-token",
              refreshToken: "new-refresh-token",
              expiresAt: "2999-06-19T12:00:00.000Z",
            });
          }
          authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
          if (url.endsWith("/manifest")) return Response.json(attachManifest("rev-1", "export-1"));
          return Response.json({ ok: true, data: { invoked: true } });
        }) as typeof fetch,
      },
    });

    try {
      await service.reload();
      vi.setSystemTime(new Date("2026-06-19T12:01:30.000Z"));

      await expect(service.execute("remote", { ok: true })).resolves.toEqual({ invoked: true });

      expect(refreshCalls).toBe(1);
      expect(authorizationHeaders[0]).toBe("Bearer old-access-token");
      expect(authorizationHeaders.at(-1)).toBe("Bearer new-access-token");
    } finally {
      vi.useRealTimers();
      await service.close();
    }
  });

  it("closes the local overlay when explicit profile-backed remote reload fails", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: { url: "https://caplets.example.com/caplets" },
      localServiceFactory: vi.fn(() => localService),
    });

    await expect(service.reload()).rejects.toThrow(/Remote Login required/u);

    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing explicit profile-backed remote service open after refresh failure", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-remote-auth-"));
    dirs.push(authDir);
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2999-06-19T12:00:00.000Z",
      },
    });
    const localClose = vi.fn(async () => undefined);
    const localService = {
      listTools: vi.fn(() => []),
      execute: vi.fn(async () => undefined),
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: localClose,
    };
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
      remote: {
        url: "https://caplets.example.com/caplets",
        fetch: (async (input) => {
          if (String(input).endsWith("/v1/remote/refresh")) {
            return Response.json({ ok: false }, { status: 401 });
          }
          return Response.json(attachManifest("rev-1", "export-1"));
        }) as typeof fetch,
      },
      localServiceFactory: vi.fn(() => localService),
    });
    await service.reload();
    await store.saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "client_123",
      clientLabel: "Native Test",
      credentials: {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    await expect(service.reload()).rejects.toThrow(/Remote Login required/u);

    expect(localClose).not.toHaveBeenCalled();
    expect(configuredCapletIds(service.listTools())).toContain("remote");
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

  it("qualifies remote and local overlays when remote attach manifest uses namespace shadowing", async () => {
    const fixture = client([
      { name: "shared", title: "Remote Shared", shadowing: "namespace" },
      { name: "remote-only", title: "Remote Only" },
    ]);
    const localExecute = vi.fn(async (capletId: string, request: unknown) => ({
      capletId,
      request,
      local: true,
    }));
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "shared",
          toolName: "caplets__shared",
          title: "Local Shared",
          description: "Local shared Caplet.",
          promptGuidance: [],
        },
      ]),
      execute: localExecute,
      reload: vi.fn(async () => true),
      onToolsChanged: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined),
    } satisfies NativeCapletsService;
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => fixture.api),
      localServiceFactory: vi.fn(() => localService),
      writeErr,
    });

    await service.reload();

    const sharedTools = service.listTools().filter((tool) => tool.title.endsWith("Shared"));
    expect(sharedTools.map((tool) => tool.caplet)).toEqual([
      expect.stringMatching(/^remote-[a-f0-9]{4}__shared$/u),
      expect.stringMatching(/^local-[a-f0-9]{4}__shared$/u),
    ]);
    expect(configuredCapletIds(service.listTools())).not.toContain("shared");
    await expect(
      service.execute(sharedTools[0]!.caplet, { operation: "inspect" }),
    ).resolves.toEqual({ name: "shared", args: { operation: "inspect" } });
    await expect(
      service.execute(sharedTools[1]!.caplet, { operation: "inspect" }),
    ).resolves.toEqual({ capletId: "shared", request: { operation: "inspect" }, local: true });
    await expect(service.execute("shared", { operation: "inspect" })).rejects.toMatchObject({
      code: "CAPLET_NAMESPACE_COLLISION",
      details: expect.objectContaining({
        alternatives: sharedTools.map((tool) => tool.caplet),
      }),
    });
    expect(writeErr).not.toHaveBeenCalledWith(
      "Local Caplet 'shared' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n",
    );
    await service.close();
  });

  it("uses configured namespace aliases for native remote and local overlays", async () => {
    const fixture = client([{ name: "shared", title: "Remote Shared", shadowing: "namespace" }]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      namespaceAliases: {
        local: "mac",
        upstreams: {
          "http://127.0.0.1:5387/v1/attach": "vps",
        },
      },
      mcpServers: {
        shared: { name: "Local Shared", description: "Local wins.", command: process.execPath },
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

    const sharedTools = service.listTools().filter((tool) => tool.title.endsWith("Shared"));
    expect(sharedTools.map((tool) => tool.caplet)).toEqual([
      expect.stringMatching(/^vps-[a-f0-9]{4}__shared$/u),
      expect.stringMatching(/^mac-[a-f0-9]{4}__shared$/u),
    ]);
    await service.close();
  });

  it("keeps namespace collisions fail-closed when qualified IDs collide with bare IDs", async () => {
    const fixture = client([
      { name: "shared", title: "Remote Shared", shadowing: "namespace" },
      { name: "clash-8516__shared", title: "Remote Collision" },
      { name: "clash-85163__shared", title: "Remote Collision 5" },
      { name: "clash-851639__shared", title: "Remote Collision 6" },
      { name: "clash-851639a__shared", title: "Remote Collision 7" },
      { name: "clash-851639a7__shared", title: "Remote Collision 8" },
    ]);
    const { dir, configPath, projectConfigPath } = tempConfig({
      namespaceAliases: {
        upstreams: {
          "http://127.0.0.1:5387/v1/attach": "clash",
        },
      },
      mcpServers: {
        shared: { name: "Local Shared", description: "Local wins.", command: process.execPath },
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

    expect(configuredCapletIds(service.listTools())).not.toContain("shared");
    await expect(service.execute("shared", { operation: "inspect" })).rejects.toMatchObject({
      code: "CAPLET_NAMESPACE_COLLISION",
      details: expect.objectContaining({
        reason: "generated_id_collision",
      }),
    });
    await service.close();
  });

  it("reports rewritten direct-tool alternatives for namespace collisions", async () => {
    const fixture = client([
      {
        name: "shared__ping",
        sourceCapletId: "shared",
        title: "Remote Ping",
        description: "Remote direct tool.",
        shadowing: "namespace",
      },
    ]);
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "shared__ping",
          sourceCaplet: "shared",
          toolName: "caplets__shared__ping",
          title: "Local Ping",
          description: "Local direct tool.",
          promptGuidance: [],
        },
      ]),
      execute: vi.fn(async () => ({ local: true })),
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

    const alternatives = configuredCapletIds(service.listTools()).filter((caplet) =>
      caplet.endsWith("__shared__ping"),
    );
    expect(alternatives).toEqual([
      expect.stringMatching(/^remote-[a-f0-9]{4}__shared__ping$/u),
      expect.stringMatching(/^local-[a-f0-9]{4}__shared__ping$/u),
    ]);
    for (const staleId of ["shared", "shared__ping"]) {
      await expect(service.execute(staleId, { message: "hi" })).rejects.toMatchObject({
        code: "CAPLET_NAMESPACE_COLLISION",
        details: expect.objectContaining({
          alternatives,
        }),
      });
    }
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

  it("executes local Code Mode overlays when remote Code Mode allows shadowing", async () => {
    const fixture = client([
      {
        name: "code_mode",
        title: "Code Mode",
        codeModeRun: true,
        codeModeCaplets: [
          {
            stableId: "code_mode:shared",
            exportId: "remote-shared",
            kind: "caplet",
            name: "Remote Shared",
            description: "Remote shared handle.",
            schemaHash: null,
            capletId: "shared",
            shadowing: "allow",
          },
        ],
      },
    ]);
    const localExecute = vi.fn(async () => ({ local: true }));
    const localService = {
      listTools: vi.fn(() => [
        {
          caplet: "code_mode",
          toolName: "caplets__code_mode",
          title: "Code Mode",
          description: "Local Code Mode.",
          codeModeRun: true,
          codeModeCaplets: [
            {
              id: "shared",
              name: "Local Shared",
              description: "Local shared handle.",
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
    await expect(service.codeModeService!().execute("shared", {})).resolves.toEqual({
      local: true,
    });

    expect(localExecute).toHaveBeenCalledWith("shared", {});
    expect(fixture.api.callTool).not.toHaveBeenCalled();
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
    const authDir = mkdtempSync(join(tmpdir(), "caplets-native-code-mode-auth-"));
    dirs.push(authDir);
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "http://127.0.0.1:5387",
      clientId: "client_123",
      clientLabel: "Native Code Mode Test",
      credentials: {
        accessToken: "profile-access-token",
        refreshToken: "profile-refresh-token",
        expiresAt: "2099-06-19T12:00:00.000Z",
      },
    });
    const service = createNativeCapletsService({
      mode: "remote",
      authDir,
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

  it("starts valid local tools and loudly warns when a sibling Caplet references a missing env var", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const missingEnvName = "CAPLETS_NATIVE_TEST_MISSING_REMOTE_URL";
    const originalMissingEnv = process.env[missingEnvName];
    delete process.env[missingEnvName];
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        broken: {
          name: "Broken Remote",
          description: "References a missing startup URL.",
          transport: "http",
          url: `$env:${missingEnvName}`,
        },
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    let service: NativeCapletsService | undefined;
    try {
      service = createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        remoteClientFactory: vi.fn(() => fixture.api),
        configPath,
        projectConfigPath,
        writeErr,
      });

      await service.reload();

      expect(configuredCapletIds(service.listTools())).toEqual(["remote", "local"]);
      expect(writeErr).toHaveBeenCalledWith(
        expect.stringContaining(`missing environment variable ${missingEnvName}`),
      );
      expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("mcpServers.broken.url"));
    } finally {
      await service?.close();
      if (originalMissingEnv === undefined) {
        delete process.env[missingEnvName];
      } else {
        process.env[missingEnvName] = originalMissingEnv;
      }
    }
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

  it("picks up healthy local overlay edits when reload introduces missing-env warnings", async () => {
    const fixture = client([{ name: "remote", title: "Remote" }]);
    const writeErr = vi.fn();
    const missingEnvName = "CAPLETS_NATIVE_TEST_RELOAD_MISSING_REMOTE_URL";
    const originalMissingEnv = process.env[missingEnvName];
    delete process.env[missingEnvName];
    const { dir, configPath, projectConfigPath } = tempConfig({
      mcpServers: {
        local: { name: "Local", description: "Local Caplet.", command: process.execPath },
      },
    });
    dirs.push(dir);

    let service: NativeCapletsService | undefined;
    try {
      service = createNativeCapletsService({
        mode: "remote",
        remote: { url: "http://127.0.0.1:5387" },
        remoteClientFactory: vi.fn(() => fixture.api),
        configPath,
        projectConfigPath,
        writeErr,
      });
      await service.reload();

      writeFileSync(
        configPath,
        JSON.stringify(
          progressiveTestConfig({
            mcpServers: {
              broken: {
                name: "Broken Remote",
                description: "References a missing startup URL.",
                transport: "http",
                url: `$env:${missingEnvName}`,
              },
              alpha: { name: "Alpha", description: "Alpha Caplet.", command: process.execPath },
              beta: { name: "Beta", description: "Beta Caplet.", command: process.execPath },
            },
          }),
        ),
        "utf8",
      );

      await expect(service.reload()).resolves.toBe(true);

      expect(configuredCapletIds(service.listTools())).toEqual(["remote", "alpha", "beta"]);
      expect(writeErr).toHaveBeenCalledWith(
        expect.stringContaining(`missing environment variable ${missingEnvName}`),
      );
      expect(writeErr).not.toHaveBeenCalledWith(
        expect.stringContaining("reload produced new warnings"),
      );
    } finally {
      await service?.close();
      if (originalMissingEnv === undefined) {
        delete process.env[missingEnvName];
      } else {
        process.env[missingEnvName] = originalMissingEnv;
      }
    }
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
          projectRoot: dirname(dirname(projectConfigPath)),
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
    expect(projectBindingBodies[0]?.projectFiles).toEqual([
      { path: ".caplets/config.json", content: "{}" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://cloud.caplets.dev/api/project-bindings/presence_1"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "offline" }),
      }),
    );
  });

  it("starts and tears down upstream Project Binding for self-hosted remote sessions", async () => {
    const fixture = client();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (
          url.pathname.endsWith("/v1/attach/project-bindings/sessions") &&
          init?.method === "POST"
        ) {
          return Response.json(
            {
              binding: { bindingId: "binding_1", state: "attaching", syncState: "pending" },
              sessionId: "session_1",
            },
            { status: 201 },
          );
        }
        if (
          url.pathname.endsWith("/v1/attach/project-bindings/binding_1/session") &&
          init?.method === "DELETE"
        ) {
          return Response.json({ ok: true });
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
    const projectRoot = dirname(dirname(projectConfigPath));

    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      projectRoot,
    });

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        new URL("http://127.0.0.1:5387/v1/attach/project-bindings/sessions"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await service.close();

    const bodies = fetch.mock.calls
      .map(([, init]) => init?.body)
      .filter((body): body is string => typeof body === "string")
      .map(
        (body) =>
          JSON.parse(body) as {
            projectRoot?: string;
            allowedCapletIds?: string[];
            sessionId?: string;
          },
      );
    expect(bodies[0]).toMatchObject({
      projectRoot,
      allowedCapletIds: ["local", "code_mode"],
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/v1/attach/project-bindings/binding_1/session"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps stacked remote tools available when upstream Project Binding is unavailable", async () => {
    const fixture = client([{ name: "remote", title: "Remote", description: "Remote Caplet." }]);
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      projectRoot: dirname(dirname(projectConfigPath)),
      writeErr,
    });

    await vi.waitFor(() =>
      expect(writeErr).toHaveBeenCalledWith(
        "Could not start upstream Project Binding: Project Binding request failed (404).\n",
      ),
    );
    await service.reload();

    expect(configuredCapletIds(service.listTools())).toContain("remote");
    await service.close();
  });

  it("retries self-hosted Project Binding registration after an initial failure", async () => {
    const fixture = client([{ name: "remote", title: "Remote", description: "Remote Caplet." }]);
    let bindingAvailable = false;
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (
          url.pathname.endsWith("/v1/attach/project-bindings/sessions") &&
          init?.method === "POST"
        ) {
          if (!bindingAvailable) {
            return new Response("temporarily unavailable", { status: 503 });
          }
          return Response.json(
            {
              binding: { bindingId: "binding_1", state: "attaching", syncState: "pending" },
              sessionId: "session_1",
            },
            { status: 201 },
          );
        }
        if (
          url.pathname.endsWith("/v1/attach/project-bindings/binding_1/session") &&
          init?.method === "DELETE"
        ) {
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      projectRoot: dirname(dirname(projectConfigPath)),
      writeErr,
    });

    await vi.waitFor(() =>
      expect(writeErr).toHaveBeenCalledWith(
        "Could not start upstream Project Binding: Project Binding request failed (503).\n",
      ),
    );
    bindingAvailable = true;
    await service.reload();
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([input, init]) =>
            new URL(input.toString()).pathname.endsWith("/v1/attach/project-bindings/sessions") &&
            init?.method === "POST",
        ),
      ).toHaveLength(2),
    );
    await service.close();

    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:5387/v1/attach/project-bindings/binding_1/session"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("stops retrying self-hosted Project Binding when upstream reports unsupported capability", async () => {
    const fixture = client([{ name: "remote", title: "Remote", description: "Remote Caplet." }]);
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input.toString());
        if (
          url.pathname.endsWith("/v1/attach/project-bindings/sessions") &&
          init?.method === "POST"
        ) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "UNSUPPORTED_CAPABILITY",
                message:
                  "Self-hosted Project Binding sessions are not implemented by this runtime.",
              },
            },
            { status: 501 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { dir, configPath, projectConfigPath } = tempConfig({});
    dirs.push(dir);
    const writeErr = vi.fn();
    const service = createNativeCapletsService({
      mode: "remote",
      remote: {
        url: "http://127.0.0.1:5387",
        fetch,
      },
      remoteClientFactory: vi.fn(() => fixture.api),
      configPath,
      projectConfigPath,
      projectRoot: dirname(dirname(projectConfigPath)),
      writeErr,
    });

    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([input, init]) =>
            new URL(input.toString()).pathname.endsWith("/v1/attach/project-bindings/sessions") &&
            init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
    await service.reload();
    await service.reload();

    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          new URL(input.toString()).pathname.endsWith("/v1/attach/project-bindings/sessions") &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(writeErr).not.toHaveBeenCalled();
    await service.close();
  });

  it("re-registers self-hosted Project Binding after heartbeat failure", async () => {
    vi.useFakeTimers();
    try {
      const fixture = client([{ name: "remote", title: "Remote", description: "Remote Caplet." }]);
      let sessionCount = 0;
      let heartbeatCount = 0;
      const fetch = vi.fn(
        async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const url = new URL(input.toString());
          if (
            url.pathname.endsWith("/v1/attach/project-bindings/sessions") &&
            init?.method === "POST"
          ) {
            sessionCount += 1;
            return Response.json(
              {
                binding: { bindingId: `binding_${sessionCount}`, state: "attaching" },
                sessionId: `session_${sessionCount}`,
              },
              { status: 201 },
            );
          }
          if (url.pathname.endsWith("/heartbeat") && init?.method === "POST") {
            heartbeatCount += 1;
            if (heartbeatCount === 1) {
              return new Response("expired", { status: 503 });
            }
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        },
      );
      const { dir, configPath, projectConfigPath } = tempConfig({});
      dirs.push(dir);
      const writeErr = vi.fn();
      const service = createNativeCapletsService({
        mode: "remote",
        remote: {
          url: "http://127.0.0.1:5387",
          fetch,
        },
        remoteClientFactory: vi.fn(() => fixture.api),
        configPath,
        projectConfigPath,
        projectRoot: dirname(dirname(projectConfigPath)),
        writeErr,
      });

      await vi.waitFor(() => expect(sessionCount).toBe(1));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(writeErr).toHaveBeenCalledWith(
          "Remote Project Binding heartbeat failed: Project Binding request failed (503).\n",
        ),
      );
      await service.reload();
      await vi.waitFor(() => expect(sessionCount).toBe(2));
      await service.close();
    } finally {
      vi.useRealTimers();
    }
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
          projectRoot: dirname(dirname(projectConfigPath)),
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
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    ...overrides,
  };
}
