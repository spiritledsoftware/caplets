import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as sendHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { backendAuthCompletionCorrelation } from "../src/auth";
import { canonicalRootOpenApiJson } from "../src/admin-api/openapi-representation";
import {
  attachManifestRevisionEventSchema,
  createRootOpenApiDocument,
} from "../src/admin-api/openapi";
import { CapletsEngine } from "../src/engine";
import type { CapletsEngineOptions } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import type { ProjectBindingLease } from "../src/project-binding";
import { PROJECT_BINDING_SOCKET_PROTOCOL } from "../src/project-binding/protocol";
import { ProjectBindingWorkspaceStore } from "../src/project-binding/workspaces";
import { createHostStorage } from "../src/storage";
import {
  ATTACH_INVOKE_REQUEST_MAX_BYTES,
  AUTH_REQUEST_MAX_BYTES,
  CAPLETS_STACK_CHAIN_HEADER,
  CONTROL_REQUEST_MAX_BYTES,
  createHttpServeApp,
  createNodeServerFetch,
  PROJECT_BINDING_STATE_POLL_INTERVAL_MS,
  sanitizeRemoteEngineOptions,
  shutdownHttpServer,
} from "../src/serve/http";
import * as serveHttpModule from "../src/serve/http";
import type {
  CapletsHttpApp,
  HttpAttachSessionFactory,
  HttpMcpSessionFactory,
} from "../src/serve/http";
import { readLimitedJsonObject } from "../src/serve/request-body";
import { CAPLETS_ATTACH_SESSION_HEADER, type AttachManifest } from "../src/attach/api";
import { buildManifestExposureProjection } from "../src/exposure/projection";
import type { HttpServeOptions } from "../src/serve/options";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("forces remote artifact paths off after caller engine options", () => {
  const options = sanitizeRemoteEngineOptions({
    artifactDir: "/tmp/caplets-artifacts",
    exposeLocalArtifactPaths: true,
    mediaInlineThresholdBytes: 128,
  });

  expect(options).toMatchObject({
    artifactDir: "/tmp/caplets-artifacts",
    exposeLocalArtifactPaths: false,
    mediaInlineThresholdBytes: 128,
    vaultRecoveryTarget: "remote",
  });
});
describe("readLimitedJsonObject", () => {
  const encoder = new TextEncoder();
  const jsonObjectOverheadBytes = encoder.encode('{"value":""}').byteLength;
  const jsonAtLength = (length: number): string =>
    `{"value":"${"x".repeat(length - jsonObjectOverheadBytes)}"}`;
  const requestWithBody = (
    body: ReadableStream<Uint8Array>,
    headers?: Record<string, string>,
  ): Request =>
    new Request("http://127.0.0.1/request", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

  it("accepts a streamed JSON object exactly at the byte limit", async () => {
    const maxBytes = 32;
    const encoded = encoder.encode(jsonAtLength(maxBytes));
    expect(encoded.byteLength).toBe(maxBytes);

    const parsed = await readLimitedJsonObject(
      requestWithBody(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      ),
      "Test request",
      maxBytes,
    );

    expect(parsed).toEqual({ value: "x".repeat(20) });
  });

  it("cancels on the first byte over the limit without pulling a trailing chunk", async () => {
    const maxBytes = 32;
    const encoded = encoder.encode(jsonAtLength(maxBytes + 1));
    const chunks = [
      encoded.subarray(0, maxBytes),
      encoded.subarray(maxBytes),
      encoder.encode("private trailing sentinel"),
    ];
    let pulls = 0;
    let canceled = false;
    const request = requestWithBody(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[pulls];
            pulls += 1;
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            canceled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );

    await expect(readLimitedJsonObject(request, "Test request", maxBytes)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Test request body is too large.",
    });
    expect(pulls).toBe(2);
    expect(canceled).toBe(true);
  });

  it("rejects a declared oversized body before pulling its stream", async () => {
    let pulls = 0;
    const request = requestWithBody(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(encoder.encode("{}"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      { "content-length": "33" },
    );

    await expect(readLimitedJsonObject(request, "Test request", 32)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Test request body is too large.",
    });
    expect(pulls).toBe(0);
  });

  it("rejects malformed declared lengths before pulling the stream", async () => {
    for (const contentLength of ["-1", "1.5", "not-a-length"]) {
      let pulls = 0;
      const request = requestWithBody(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(encoder.encode("{}"));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { "content-length": contentLength },
      );

      await expect(readLimitedJsonObject(request, "Test request", 32)).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: "Test request content length must be a non-negative integer.",
      });
      expect(pulls).toBe(0);
    }
  });

  it("reports invalid UTF-8 and malformed JSON without reflecting input", async () => {
    const cases = [
      {
        bytes: new Uint8Array([0xc3, 0x28, ...encoder.encode("private utf8 sentinel")]),
        secret: "private utf8 sentinel",
      },
      {
        bytes: encoder.encode('{"secret":"private malformed sentinel"'),
        secret: "private malformed sentinel",
      },
    ];

    for (const { bytes, secret } of cases) {
      const error = await readLimitedJsonObject(
        requestWithBody(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        ),
        "Test request",
        128,
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(CapletsError);
      expect(error).toMatchObject({
        code: "REQUEST_INVALID",
        message: "Test request body must be valid JSON.",
      });
      expect(String(error)).not.toContain(secret);
    }
  });

  it("bounds the materialized-body fallback", async () => {
    const bytes = encoder.encode(jsonAtLength(33));
    const request = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Request;

    await expect(readLimitedJsonObject(request, "Test request", 32)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Test request body is too large.",
    });
  });
});

describe("createHttpServeApp", () => {
  it("keeps the registered public API method/path manifest aligned with OpenAPI", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: remoteCredentialStore(),
      attachSessionFactory: () => ({
        manifest: async () => attachManifest("manifest-route-parity", "parity"),
        invoke: async () => ({ ok: true }),
        onManifestChanged: () => () => {},
        close: async () => {},
      }),
    });
    const runtime = new Set(
      app.routes
        .filter((route) => route.method !== "ALL" && route.path.startsWith("/api"))
        .map(
          (route) =>
            `${route.method.toUpperCase()} ${route.path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}")}`,
        ),
    );
    const document = createRootOpenApiDocument();
    const documented = new Set<string>();
    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        if (pathItem?.[method]) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
    for (const operation of ["GET /api", "GET /api/openapi.json", "GET /api/v1"]) {
      documented.add(operation);
    }

    expect([...runtime].sort()).toEqual([...documented].sort());
    for (const excluded of [
      "/",
      "/.well-known/caplets",
      "/mcp",
      "/dashboard",
      "/api/v1/admin",
      "/api/v1/remote/pairing/exchange",
    ]) {
      expect([...runtime].some((operation) => operation.endsWith(` ${excluded}`))).toBe(false);
      expect(Object.keys(document.paths ?? {})).not.toContain(excluded);
    }

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("serves the fixed public discovery topology and canonical health", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const root = await app.request("http://127.0.0.1:5387/", { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/dashboard");
    expect(root.headers.get("cache-control")).toBe("no-store");

    const wellKnown = await app.request("http://127.0.0.1:5387/.well-known/caplets");
    expect(wellKnown.status).toBe(200);
    expect(wellKnown.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(wellKnown.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await wellKnown.text()).toBe(
      '{"schemaVersion":1,"links":{"api":"/api","openapi":"/api/openapi.json","mcp":"/mcp","dashboard":"/dashboard"}}\n',
    );
    const wellKnownEtag = wellKnown.headers.get("etag");
    expect(wellKnownEtag).toMatch(/^"[A-Za-z0-9_-]+"$/u);

    const wellKnownHead = await app.request("http://127.0.0.1:5387/.well-known/caplets", {
      method: "HEAD",
    });
    expect(wellKnownHead.status).toBe(200);
    expect(wellKnownHead.headers.get("etag")).toBe(wellKnownEtag);
    expect(await wellKnownHead.text()).toBe("");

    const wellKnownConditional = await app.request("http://127.0.0.1:5387/.well-known/caplets", {
      headers: { "If-None-Match": `"other", W/${wellKnownEtag}` },
    });
    expect(wellKnownConditional.status).toBe(304);
    expect(wellKnownConditional.headers.get("etag")).toBe(wellKnownEtag);
    expect(await wellKnownConditional.text()).toBe("");

    const api = await app.request("http://127.0.0.1:5387/api");
    expect(api.status).toBe(200);
    expect(api.headers.get("cache-control")).toBe("no-store");
    await expect(api.json()).resolves.toEqual({
      name: "caplets",
      protocol: "caplets-http",
      schemaVersion: 1,
      links: {
        self: "/api",
        openapi: "/api/openapi.json",
        v1: "/api/v1",
        admin: "/api/v2/admin/host",
      },
    });

    const v1 = await app.request("http://127.0.0.1:5387/api/v1");
    expect(v1.status).toBe(200);
    expect(v1.headers.get("cache-control")).toBe("no-store");
    await expect(v1.json()).resolves.toEqual({
      version: 1,
      path: "/api/v1",
      links: {
        health: "/api/v1/healthz",
        attachManifest: "/api/v1/attach/manifest",
        attachEvents: "/api/v1/attach/events",
        attachInvoke: "/api/v1/attach/invoke",
      },
    });

    const health = await app.request("http://127.0.0.1:5387/api/v1/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", ready: true });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("returns exact 405 only for unsupported canonical methods and exact JSON 404 otherwise", async () => {
    const { engine } = testEngine();
    const dashboardDistDir = tempDir("caplets-dashboard-routes-");
    mkdirSync(join(dashboardDistDir, "activity"), { recursive: true });
    mkdirSync(join(dashboardDistDir, "_astro"), { recursive: true });
    writeFileSync(join(dashboardDistDir, "activity", "index.html"), "<main>activity</main>");
    writeFileSync(join(dashboardDistDir, "_astro", "app.js"), "export {};");
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      dashboardDistDir,
    });

    for (const [path, method, allow] of [
      ["/", "POST", "GET, HEAD"],
      ["/.well-known/caplets", "POST", "GET, HEAD"],
      ["/api", "POST", "GET, HEAD"],
      ["/api/openapi.json", "POST", "GET, HEAD"],
      ["/api/v1", "POST", "GET, HEAD"],
      ["/api/v1/healthz", "POST", "GET, HEAD"],
      ["/api/v1/remote/login/start", "GET", "POST"],
      ["/api/v1/attach/manifest", "POST", "GET, HEAD"],
      ["/api/v1/attach/project-bindings/connect", "POST", "GET, HEAD"],
      ["/api/v2/admin/host", "POST", "GET, HEAD"],
      [
        `/api/v2/admin/catalog/entries/${encodeURIComponent("catalog:https%2F%2Fexample.test")}`,
        "POST",
        "GET, HEAD",
      ],
      ["/dashboard/activity", "POST", "GET, HEAD"],
      ["/dashboard/_astro/app.js", "DELETE", "GET, HEAD"],
    ] as const) {
      const response = await app.request(`http://127.0.0.1:5387${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow"), `${method} ${path}`).toBe(allow);
    }

    for (const path of [
      "/api/",
      "/api/v1/",
      "/mcp/",
      "/v1/healthz",
      "/v1/mcp",
      "/v1/admin",
      "/v2/admin/host",
      "/api/v1/admin",
      "/api/v1/remote/pairing/exchange",
      "/openapi.json",
      "/tenant/tools/api",
    ]) {
      const response = await app.request(`http://127.0.0.1:5387${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("application/json");
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(await response.text(), path).toBe('{"error":"not_found"}');
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("deprecation"), path).toBeNull();
      expect(response.headers.get("link"), path).toBeNull();
    }

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects raw request paths normalized by the Node HTTP adapter", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const server = await startTestHttpServer(app);

    const canonical = await requestRawHttp(server.origin, "/api/v1/healthz");
    expect(canonical.status).toBe(200);

    for (const path of ["/tenant/%2e%2e/api/v1/healthz", "/api/%2e/v1/healthz"]) {
      const response = await requestRawHttp(server.origin, path);
      expect(response.status, path).toBe(404);
      expect(response.headers["content-type"], path).toBe("application/json");
      expect(response.headers["cache-control"], path).toBe("no-store");
      expect(response.body, path).toBe('{"error":"not_found"}');
      expect(response.headers.location, path).toBeUndefined();
    }

    await server.close();
    await app.closeCapletsSessions();
    await engine.close();
  });

  it("mounts the Admin resource surface behind exact Operator bearer or dashboard authority", async () => {
    const credentialStore = remoteCredentialStore();
    const accessCredentials = pairedClient(credentialStore);
    const operatorCredentials = pairedClient(credentialStore, "http://127.0.0.1:5387/", "operator");
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: credentialStore },
    );

    const bearer = await app.request("http://127.0.0.1:5387/api/v2/admin/host", {
      headers: {
        authorization: `Bearer ${operatorCredentials.accessToken}`,
        "x-caplets-csrf": "ignored-by-bearer",
      },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get("cache-control")).toBe("no-store");

    for (const [name, headers, status, code, type] of [
      [
        "missing bearer",
        undefined,
        401,
        "AUTH_REQUIRED",
        "urn:caplets:problem:authentication-required",
      ],
      [
        "malformed bearer",
        { authorization: "Bearer" },
        401,
        "AUTH_REQUIRED",
        "urn:caplets:problem:authentication-required",
      ],
      [
        "Access Client bearer",
        { authorization: `Bearer ${accessCredentials.accessToken}` },
        403,
        "AUTH_FAILED",
        "urn:caplets:problem:forbidden",
      ],
      [
        "invalid dashboard cookie",
        { cookie: "caplets_dashboard_session=not-bearer-authority" },
        401,
        "AUTH_REQUIRED",
        "urn:caplets:problem:authentication-required",
      ],
    ] as const) {
      const response = await app.request(
        "http://127.0.0.1:5387/api/v2/admin/host",
        headers ? { headers } : undefined,
      );
      expect(response.status, name).toBe(status);
      expect(response.headers.get("content-type"), name).toBe("application/problem+json");
      expect(response.headers.get("cache-control"), name).toBe("no-store");
      await expect(response.json(), name).resolves.toMatchObject({ status, code, type });
    }

    expect(
      (await app.request("http://127.0.0.1:5387/tenant/tools/dashboard/api/summary")).status,
    ).toBe(404);
    expect((await app.request("http://127.0.0.1:5387/tenant/tools/v2/admin/host")).status).toBe(
      404,
    );

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("projects authoritative Host runtime, logs, and active Project Binding state", async () => {
    const credentialStore = remoteCredentialStore();
    const operatorCredentials = pairedClient(credentialStore, "http://127.0.0.1:5387/", "operator");
    const { engine } = testEngine();
    vi.spyOn(engine, "readiness").mockResolvedValue({
      ready: false,
      reason: "database_unavailable",
    });
    const listPage = vi.fn().mockResolvedValue({
      items: [
        {
          timestamp: "2026-07-20T12:00:00.000Z",
          level: "error",
          message: "Runtime storage probe failed.",
          source: "runtime",
        },
      ],
    });
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-host-state-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: credentialStore,
        currentHostLogState: { listPage },
        projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
      },
    );
    const authorization = `Bearer ${operatorCredentials.accessToken}`;

    const binding = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot: "/repo",
          projectFingerprint: "sha256_host_state",
        }),
      },
    );
    expect(binding.status).toBe(201);

    const host = await app.request("http://127.0.0.1:5387/api/v2/admin/host", {
      headers: { authorization },
    });
    expect(host.status).toBe(200);
    await expect(host.json()).resolves.toMatchObject({
      sections: {
        runtime: { status: "error" },
        projectBinding: { state: "connected" },
      },
    });

    const runtime = await app.request("http://127.0.0.1:5387/api/v2/admin/runtime", {
      headers: { authorization },
    });
    expect(runtime.status).toBe(200);
    await expect(runtime.json()).resolves.toMatchObject({
      runtime: { status: "error", reason: "database_unavailable" },
    });

    const diagnostics = await app.request("http://127.0.0.1:5387/api/v2/admin/diagnostics", {
      headers: { authorization },
    });
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      status: "error",
      checks: [{ id: "runtime", status: "error", detail: "database_unavailable" }],
    });

    const projectBinding = await app.request("http://127.0.0.1:5387/api/v2/admin/project-binding", {
      headers: { authorization },
    });
    expect(projectBinding.status).toBe(200);
    await expect(projectBinding.json()).resolves.toMatchObject({ state: "connected" });

    const logs = await app.request("http://127.0.0.1:5387/api/v2/admin/logs", {
      headers: { authorization },
    });
    expect(logs.status).toBe(200);
    await expect(logs.json()).resolves.toMatchObject({
      items: [{ message: "Runtime storage probe failed." }],
    });
    expect(listPage).toHaveBeenCalledWith({ sort: "asc" });

    const events = await app.request("http://127.0.0.1:5387/api/v2/admin/events", {
      headers: { authorization },
    });
    expect(events.status).toBe(200);
    const reader = events.body?.getReader();
    const eventChunk = await reader?.read();
    await reader?.cancel();
    const eventBody = new TextDecoder().decode(eventChunk?.value);
    expect(eventBody).toContain('"status":"error"');
    expect(eventBody).toContain('"state":"connected"');

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("answers Current Host Project Binding state with a bounded repository lookup", async () => {
    const context = testContext();
    const storage = await testAuthoritativeHostStorage(context.configPath);
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      hostStorage: storage,
      watch: false,
    });
    const existsActive = vi.spyOn(storage.projectBindings, "existsActive").mockResolvedValue(true);
    const list = vi
      .spyOn(storage.projectBindings, "list")
      .mockRejectedValue(new Error("Current Host state must not scan binding history."));
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      authoritativeStorage: storage,
    });

    try {
      const response = await app.request("http://127.0.0.1:5387/api/v2/admin/project-binding");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ state: "connected" });
      expect(existsActive).toHaveBeenCalledOnce();
      expect(existsActive).toHaveBeenCalledWith(expect.any(Date));
      expect(list).not.toHaveBeenCalled();
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
      await storage.close();
    }
  });

  it("bounds active request drain and rejects work admitted after shutdown starts", async () => {
    const { engine } = testEngine();
    const closeEngine = vi.spyOn(engine, "close");
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const requestStarted = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    app.get("/shutdown-hang", async (c) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      return c.text("completed");
    });
    app.get("/shutdown-late", (c) => c.text("admitted"));
    const server = await startTestHttpServer(app);
    const hangingRequest = fetch(`${server.origin}/shutdown-hang`).then(
      () => "completed",
      () => "closed",
    );
    let shutdown: Promise<void> | undefined;

    try {
      await requestStarted.promise;
      shutdown = shutdownHttpServer(server.server, app, engine, { activeRequestGraceMs: 25 });
      const lateAppResponse = await app.request("http://127.0.0.1/shutdown-late");
      const lateNetwork = fetch(`${server.origin}/shutdown-late`).then(
        () => "admitted",
        () => "rejected",
      );
      // This live-server regression deliberately observes the real shutdown grace deadline.
      const settledWithinGrace = await Promise.race([
        shutdown.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      const lateNetworkResult = await lateNetwork;

      expect(settledWithinGrace).toBe(true);
      expect(lateAppResponse.status).toBe(503);
      expect(lateNetworkResult).toBe("rejected");
      await expect(hangingRequest).resolves.toBe("closed");
      expect(closeEngine).toHaveBeenCalledOnce();
    } finally {
      releaseRequest.resolve();
      await shutdown?.catch(() => undefined);
      if (!shutdown) {
        await server.close();
        await engine.close();
      }
    }
  });

  it("refreshes an initial stream when its first durable poll resolves with newer state", async () => {
    const context = testContext();
    const storage = await testAuthoritativeHostStorage(context.configPath);
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      hostStorage: storage,
      watch: false,
    });
    const pollRead = Promise.withResolvers<boolean>();
    const initialRead = Promise.withResolvers<boolean>();
    vi.spyOn(storage.projectBindings, "existsActive")
      .mockImplementationOnce(() => pollRead.promise)
      .mockImplementationOnce(() => initialRead.promise)
      .mockResolvedValue(true);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      authoritativeStorage: storage,
    });

    try {
      const response = await app.request("http://127.0.0.1:5387/api/v2/admin/events");
      const reader = response.body!.getReader();
      initialRead.resolve(false);
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain(
        '"projectBinding":{"state":"disconnected"}',
      );

      const changed = reader.read();
      pollRead.resolve(true);
      const closing = Promise.withResolvers<void>();
      setImmediate(() => {
        void app.closeCapletsSessions().then(closing.resolve, closing.reject);
      });
      const next = await changed;
      expect(next.done).toBe(false);
      expect(new TextDecoder().decode(next.value)).toContain(
        '"projectBinding":{"state":"connected"}',
      );
      await closing.promise;
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
      await storage.close();
    }
  });

  it("streams cross-Host-Node durable Project Binding changes without duplicate snapshots or orphan polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    const context = testContext();
    const observerStorage = await testAuthoritativeHostStorage(context.configPath);
    const writerStorage = await testAuthoritativeHostStorage(context.configPath);
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      hostStorage: observerStorage,
      watch: false,
    });
    const existsActive = vi.spyOn(observerStorage.projectBindings, "existsActive");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      authoritativeStorage: observerStorage,
    });

    try {
      const response = await app.request("http://127.0.0.1:5387/api/v2/admin/events");
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain(
        '"projectBinding":{"state":"disconnected"}',
      );

      const first = await writerStorage.projectBindings.create({
        bindingId: "binding-cross-node-expiry",
        sessionId: "session-cross-node-expiry",
        projectFingerprint: "sha256:cross-node-expiry",
        projectRoot: "/client/cross-node-expiry",
        serverProjectRoot: "/host/cross-node-expiry",
        ownerNodeId: "writer-node",
        leaseTtlMs: 2_000,
      });
      const connected = reader.read();
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS);
      expect(new TextDecoder().decode((await connected).value)).toContain(
        '"projectBinding":{"state":"connected"}',
      );

      await writerStorage.projectBindings.heartbeat({
        bindingId: first.bindingId,
        ownerNodeId: first.ownerNodeId,
        sessionId: first.sessionId,
        expectedGeneration: first.generation,
        state: "ready",
        syncState: "idle",
        leaseTtlMs: 2_000,
      });
      let unchangedSettled = false;
      const expired = reader.read().finally(() => {
        unchangedSettled = true;
      });
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS);
      expect(unchangedSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS);
      expect(new TextDecoder().decode((await expired).value)).toContain(
        '"projectBinding":{"state":"disconnected"}',
      );

      const second = await writerStorage.projectBindings.create({
        bindingId: "binding-cross-node-end",
        sessionId: "session-cross-node-end",
        projectFingerprint: "sha256:cross-node-end",
        projectRoot: "/client/cross-node-end",
        serverProjectRoot: "/host/cross-node-end",
        ownerNodeId: "writer-node",
        leaseTtlMs: 2_000,
      });
      const reconnected = reader.read();
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS);
      expect(new TextDecoder().decode((await reconnected).value)).toContain(
        '"projectBinding":{"state":"connected"}',
      );

      await writerStorage.projectBindings.end({
        bindingId: second.bindingId,
        ownerNodeId: second.ownerNodeId,
        expectedGeneration: second.generation,
      });
      const ended = reader.read();
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS);
      expect(new TextDecoder().decode((await ended).value)).toContain(
        '"projectBinding":{"state":"disconnected"}',
      );

      await reader.cancel("subscriber disconnected");
      const callsAfterCancel = existsActive.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS * 5);
      expect(existsActive).toHaveBeenCalledTimes(callsAfterCancel);

      const closingResponse = await app.request("http://127.0.0.1:5387/api/v2/admin/events");
      const closingReader = closingResponse.body!.getReader();
      await closingReader.read();
      await app.closeCapletsSessions();
      const callsAfterClose = existsActive.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PROJECT_BINDING_STATE_POLL_INTERVAL_MS * 5);
      expect(existsActive).toHaveBeenCalledTimes(callsAfterClose);
      await expect(closingReader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
      await writerStorage.close();
      await observerStorage.close();
      vi.useRealTimers();
    }
  });

  it("serves the canonical root OpenAPI bytes publicly with conditional caching", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
    });

    const response = await app.request("http://127.0.0.1:5387/api/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.oai.openapi+json;version=3.1",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await response.text()).toBe(canonicalRootOpenApiJson());
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);

    const conditional = await app.request("http://127.0.0.1:5387/api/openapi.json", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect((await app.request("http://127.0.0.1:5387/openapi.json")).status).toBe(404);

    await engine.close();
  });

  it("applies upload admission configuration and drains active requests before clean close", async () => {
    const context = testContext();
    const storage = await testAuthoritativeHostStorage(context.configPath);
    const stagingRoot = tempDir("caplets-admin-upload-serve-");
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      hostStorage: storage,
      watch: false,
    });
    const app = createHttpServeApp(
      httpOptions({
        adminUploads: {
          stagingDir: stagingRoot,
          maxConcurrent: 1,
          maxStagedBytes: 400_000_000,
        },
      }),
      engine,
      { writeErr: () => {}, control: context, authoritativeStorage: storage },
    );

    const requestStarted = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (pulled) return;
          pulled = true;
          requestStarted.resolve();
          await releaseRequest.promise;
          controller.enqueue(new TextEncoder().encode("--empty-upload--\r\n"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const activeRequest = Promise.resolve(
      app.fetch(
        new Request("http://127.0.0.1:5387/api/v2/admin/caplet-records/upload-test/bundle", {
          method: "PUT",
          headers: {
            "content-type": "multipart/form-data; boundary=empty-upload",
            "idempotency-key": "empty-upload",
            "if-none-match": "*",
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      ),
    );
    await requestStarted.promise;
    expect(
      readdirSync(stagingRoot).filter((entry) => entry.startsWith("caplets-admin-upload-")),
    ).toHaveLength(1);
    const concurrentUpload = await app.request(
      "http://127.0.0.1:5387/api/v2/admin/caplet-records/upload-capacity/bundle",
      {
        method: "PUT",
        headers: {
          "content-type": "multipart/form-data; boundary=capacity-upload",
          "idempotency-key": "capacity-upload",
          "if-none-match": "*",
        },
        body: "--capacity-upload--\r\n",
      },
    );
    expect(concurrentUpload.status).toBe(429);
    expect(concurrentUpload.headers.get("retry-after")).toBe("1");
    let closed = false;
    const closing = app.closeCapletsSessions().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseRequest.resolve();
    const upload = await activeRequest;
    expect(upload.status).toBe(400);
    await closing;
    expect(readdirSync(stagingRoot)).toEqual([]);

    await engine.close();
    await storage.close();
  });

  it("applies the named body class to representative auth, dashboard, and attach routes", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });
    const authApp = createHttpServeApp(
      httpOptions({ auth: { type: "remote_credentials" } }),
      engine,
      {
        writeErr: () => {},
        control: context,
        remoteCredentialStore: store,
      },
    );
    const encoder = new TextEncoder();
    const routeCases = [
      {
        name: "auth",
        app: authApp,
        url: "http://127.0.0.1:5387/api/v1/remote/login/start",
        maxBytes: AUTH_REQUEST_MAX_BYTES,
        headers: { "content-type": "application/json" },
        body: { clientLabel: "Bounded Client" },
        status: 200,
        expected: { flowId: expect.any(String) },
      },
      {
        app,
        name: "dashboard",
        url: "http://127.0.0.1:5387/dashboard/api/private/vault-reveals",
        maxBytes: CONTROL_REQUEST_MAX_BYTES,
        headers: {
          "content-type": "application/json",
          "x-caplets-csrf": "development_unauthenticated",
        },
        body: {},
        status: 400,
        expected: {
          ok: false,
          error: { code: "REQUEST_INVALID", message: "key must be a non-empty string." },
        },
      },
      {
        app,
        name: "attach",
        url: "http://127.0.0.1:5387/api/v1/attach/invoke",
        maxBytes: ATTACH_INVOKE_REQUEST_MAX_BYTES,
        headers: { "content-type": "application/json" },
        body: {},
        status: 400,
        expected: {
          ok: false,
          error: {
            code: "REQUEST_INVALID",
            message: "Attach invoke request requires revision, kind, and exportId.",
          },
        },
      },
    ] as const;

    for (const routeCase of routeCases) {
      const inLimit = await routeCase.app.request(routeCase.url, {
        method: "POST",
        headers: routeCase.headers,
        body: JSON.stringify(routeCase.body),
      });
      expect(inLimit.status, `${routeCase.name} in-limit status`).toBe(routeCase.status);
      await expect(inLimit.json()).resolves.toMatchObject(routeCase.expected);

      let pulls = 0;
      const declaredOversize = await routeCase.app.request(routeCase.url, {
        method: "POST",
        headers: {
          ...routeCase.headers,
          "content-length": String(routeCase.maxBytes + 1),
        },
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(encoder.encode("{}"));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      expect(declaredOversize.status, `${routeCase.name} declared-oversize status`).toBe(400);
      await expect(declaredOversize.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "REQUEST_INVALID", message: expect.stringContaining("too large") },
      });
      expect(pulls, `${routeCase.name} declared-oversize pulls`).toBe(0);
    }

    await authApp.closeCapletsSessions();
    await app.closeCapletsSessions();
    await engine.close();
  });

  it("logs basic HTTP requests to stderr", async () => {
    const { engine } = testEngine();
    const logs: string[] = [];
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: (value) => logs.push(value),
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/healthz");

    expect(response.status).toBe(200);
    expect(logs.join("")).toContain("<-- GET /api/v1/healthz");
    const plainLogs = logs.join("").replaceAll(String.fromCharCode(27), "");
    expect(plainLogs).toContain("--> GET /api/v1/healthz");
    expect(plainLogs).toContain("200");

    await engine.close();
  });

  it("rejects Basic Auth on MCP path when remote credentials are required", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        remoteCredentialStateDir: tempDir("caplets-http-remote-credentials-"),
      }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    const wrong = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("caplets:password").toString("base64")}`,
      },
    });
    expect(wrong.status).toBe(401);

    await engine.close();
  });

  it("treats operator credentials as a superset of access credentials", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const operatorCredentials = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });

    const basic = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: {
        authorization: `Basic ${Buffer.from("caplets:password").toString("base64")}`,
      },
    });
    expect(basic.status).toBe(401);
    expect(basic.headers.get("www-authenticate")).toBeNull();

    const attach = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(200);

    const project = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/bind_123/status",
      { headers: { authorization: `Bearer ${credentials.accessToken}` } },
    );
    expect(project.status).toBe(200);

    const admin = await app.request("http://127.0.0.1:5387/api/v2/admin/host", {
      headers: {
        authorization: `Bearer ${operatorCredentials.accessToken}`,
      },
    });
    expect(admin.status).toBe(200);

    const mcp = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(mcp.status).toBe(200);

    const operatorAttach = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { authorization: `Bearer ${operatorCredentials.accessToken}` },
    });
    expect(operatorAttach.status).toBe(200);

    const operatorProjectBinding = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/bind_123/status",
      { headers: { authorization: `Bearer ${operatorCredentials.accessToken}` } },
    );
    expect(operatorProjectBinding.status).toBe(200);

    const operatorMcp = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorCredentials.accessToken}`,
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "operator", version: "1.0.0" },
        },
      }),
    });
    expect(operatorMcp.status).toBe(200);
    await engine.close();
  });

  it("does not collapse HTTP pending login starts into an eight-flow empty-source quota", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    for (let index = 0; index < 9; index += 1) {
      const started = await app.request("http://127.0.0.1:5387/api/v1/remote/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientLabel: `Client ${index}` }),
      });
      expect(started.status).toBe(200);
    }

    await engine.close();
  });

  it("applies pending login quotas per trusted forwarded source", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        publicOrigin: "https://caplets.example.com",
        trustProxy: true,
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
      },
    );
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    };

    for (let index = 0; index < 8; index += 1) {
      const started = await app.request("http://10.0.0.5:5387/api/v1/remote/login/start", {
        method: "POST",
        headers,
        body: JSON.stringify({ clientLabel: `Client ${index}` }),
      });
      expect(started.status).toBe(200);
    }

    const blocked = await app.request("http://10.0.0.5:5387/api/v1/remote/login/start", {
      method: "POST",
      headers,
      body: JSON.stringify({ clientLabel: "Blocked client" }),
    });
    expect(blocked.status).toBe(401);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { message: "Too many active pending logins for this source." },
    });

    const otherSource = await app.request("http://10.0.0.5:5387/api/v1/remote/login/start", {
      method: "POST",
      headers: { ...headers, "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ clientLabel: "Other source" }),
    });
    expect(otherSource.status).toBe(200);

    await engine.close();
  });

  it("applies loopback host protection before pending login starts mutate state", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const started = await app.request("http://127.0.0.1:5387/api/v1/remote/login/start", {
      method: "POST",
      headers: { host: "attacker.example.com", "content-type": "application/json" },
      body: JSON.stringify({ clientLabel: "Blocked client" }),
    });

    expect(started.status).toBe(403);
    expect(store.listPendingLogins()).toHaveLength(0);
    await engine.close();
  });

  it("starts, polls, and completes pending remote login over HTTP without remote approval routes", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const started = await app.request("http://127.0.0.1:5387/api/v1/remote/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientLabel: "Test Client",
        clientFingerprint: "fp_test",
      }),
    });
    expect(started.status).toBe(200);
    const pending = (await started.json()) as {
      flowId: string;
      operatorCode: string;
      approvalCommand: string;
      pendingRefreshSecret: string;
      pendingCompletionSecret: string;
      codeExpiresAt: string;
      flowExpiresAt: string;
      intervalSeconds: number;
    };
    expect(pending.operatorCode).toMatch(/^cap_login_/u);
    expect(pending.approvalCommand).toContain(
      `caplets remote host approve ${pending.operatorCode}`,
    );
    expect(pending.approvalCommand).toContain(`--state-path ${store.dir}`);
    expect(pending.approvalCommand).toContain("--yes");
    expect(pending.pendingRefreshSecret).toMatch(/^cap_pending_refresh_/u);
    expect(pending.pendingCompletionSecret).toMatch(/^cap_pending_complete_/u);

    const waiting = await app.request("http://127.0.0.1:5387/api/v1/remote/login/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(waiting.status).toBe(200);
    await expect(waiting.json()).resolves.toMatchObject({ status: "pending" });

    expect(await app.request("http://127.0.0.1:5387/api/v1/remote/login/approve")).toMatchObject({
      status: 404,
    });
    store.approvePendingLogin({ operatorCode: pending.operatorCode });

    const approved = await app.request("http://127.0.0.1:5387/api/v1/remote/login/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ status: "approved" });

    const completed = await app.request("http://127.0.0.1:5387/api/v1/remote/login/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    });
    expect(completed.status).toBe(200);
    const credentials = (await completed.json()) as {
      accessToken: string;
      refreshToken: string;
      clientId: string;
    };
    expect(credentials.accessToken).not.toBe(pending.pendingRefreshSecret);
    expect(credentials.refreshToken).not.toBe(pending.pendingCompletionSecret);

    const attach = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(200);

    await engine.close();
  });

  it("returns a retryable status when remote credential refresh state is unavailable", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: {
        refreshClientCredentials: () => {
          throw new CapletsError("SERVER_UNAVAILABLE", "Remote credential state is locked.");
        },
      } as unknown as RemoteServerCredentialStore,
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SERVER_UNAVAILABLE" },
    });

    await engine.close();
  });

  it("returns a structured revoked status for stale remote credential refreshes", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: {
        refreshClientCredentials: () => {
          throw new CapletsError(
            "REMOTE_CREDENTIALS_REVOKED",
            "Remote refresh credential is stale.",
          );
        },
      } as unknown as RemoteServerCredentialStore,
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/remote/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "refresh-token" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REMOTE_CREDENTIALS_REVOKED" },
    });

    await engine.close();
  });

  it("revokes the authenticated self-hosted remote client", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const revoked = await app.request("http://127.0.0.1:5387/api/v1/remote/client", {
      method: "DELETE",
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });

    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      revoked: true,
      clientId: credentials.clientId,
    });
    const attach = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(attach.status).toBe(401);

    await engine.close();
  });

  it("allows both credential roles to revoke only their own remote client", async () => {
    const context = testContext();
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const store = remoteCredentialStore();
    const access = pairedClient(store);
    const otherAccess = pairedClient(store);
    const operator = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const otherOperator = pairedClient(store, "http://127.0.0.1:5387/", "operator");
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      control: context,
      remoteCredentialStore: store,
    });

    const revokedAccess = await app.request("http://127.0.0.1:5387/api/v1/remote/client", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${access.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: otherAccess.clientId }),
    });
    expect(revokedAccess.status).toBe(200);
    await expect(revokedAccess.json()).resolves.toEqual({
      revoked: true,
      clientId: access.clientId,
    });
    expect(
      await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
        headers: { authorization: `Bearer ${access.accessToken}` },
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
        headers: { authorization: `Bearer ${otherAccess.accessToken}` },
      }),
    ).toHaveProperty("status", 200);

    const revokedOperator = await app.request("http://127.0.0.1:5387/api/v1/remote/client", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${operator.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: otherOperator.clientId }),
    });
    expect(revokedOperator.status).toBe(200);
    await expect(revokedOperator.json()).resolves.toEqual({
      revoked: true,
      clientId: operator.clientId,
    });
    expect(
      await app.request("http://127.0.0.1:5387/api/v2/admin/host", {
        headers: {
          authorization: `Bearer ${operator.accessToken}`,
        },
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request("http://127.0.0.1:5387/api/v2/admin/host", {
        headers: {
          authorization: `Bearer ${otherOperator.accessToken}`,
        },
      }),
    ).toHaveProperty("status", 200);
    await engine.close();
  });

  it("requires explicit public origin before trusted proxy headers select remote credential audiences", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    try {
      expect(() =>
        createHttpServeApp(
          httpOptions({ auth: { type: "remote_credentials" }, trustProxy: true }),
          engine,
          {
            writeErr: () => {},
            remoteCredentialStore: store,
          },
        ),
      ).toThrow(
        expect.objectContaining({
          code: "REQUEST_INVALID",
          message: "Remote credential auth with --trust-proxy requires CAPLETS_SERVER_URL.",
        }) as CapletsError,
      );
    } finally {
      await engine.close();
    }
  });

  it("uses explicit public origin for remote credential audiences behind trusted proxies", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const issued = store.createPairingCode({ hostUrl: "https://caplets.example.com/" });
    const credentials = store.exchangePairingCode({
      hostUrl: "https://caplets.example.com/",
      code: issued.code,
    });
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        publicOrigin: "https://caplets.example.com",
        trustProxy: true,
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
      },
    );

    const refreshed = await app.request("http://10.0.0.5:5387/api/v1/remote/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.com",
      },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const nextCredentials = (await refreshed.json()) as { accessToken: string };

    const attach = await app.request("http://10.0.0.5:5387/api/v1/attach/manifest", {
      headers: {
        authorization: `Bearer ${nextCredentials.accessToken}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.com",
      },
    });
    expect(attach.status).toBe(200);
    await engine.close();
  });

  it("rejects Basic Auth on attach manifest when remote credentials are required", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        auth: { type: "remote_credentials" },
        remoteCredentialStateDir: tempDir("caplets-http-remote-credentials-"),
      }),
      engine,
      { writeErr: () => {} },
    );

    const missing = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();

    await engine.close();
  });

  it("exposes authenticated Project Binding status under the attach namespace", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
    });

    const missing = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/bind_123/status",
    );
    expect(missing.status).toBe(401);

    const response = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/bind_123/status",
      {
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
        },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bindingId: "bind_123",
      state: "not_attached",
    });

    await engine.close();
  });

  it("exposes the Project Binding WebSocket upgrade route at its fixed path", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
    });

    const response = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/connect",
    );

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: "websocket_upgrade_required",
    });

    await engine.close();
  });

  it("mounts Project Binding session routes under the attach namespace", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const events = await app.request("http://127.0.0.1:5387/api/v2/admin/events");
    expect(events.status).toBe(200);
    const eventReader = events.body!.getReader();
    const initialEvent = await eventReader.read();
    expect(new TextDecoder().decode(initialEvent.value)).toContain(
      '"projectBinding":{"state":"disconnected"}',
    );

    const session = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      },
    );
    expect(session.status).toBe(201);
    const created = (await session.json()) as {
      binding: {
        bindingId: string;
        projectFingerprint: string;
        state: string;
        syncState: string;
        serverProjectRoot: string;
      };
      sessionId: string;
    };
    expect(created).toMatchObject({
      binding: {
        projectFingerprint: "sha256_repo",
        state: "attaching",
        syncState: "pending",
        serverProjectRoot: expect.stringContaining(workspaceRoot),
      },
      sessionId: expect.any(String),
    });
    const connectedEvent = await eventReader.read();
    expect(new TextDecoder().decode(connectedEvent.value)).toContain(
      '"projectBinding":{"state":"connected"}',
    );
    let nextEventSettled = false;
    const nextEvent = eventReader.read().finally(() => {
      nextEventSettled = true;
    });

    const heartbeat = await app.request(
      `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: created.sessionId,
          state: "ready",
          syncState: "idle",
        }),
      },
    );
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({
      ok: true,
      binding: { bindingId: created.binding.bindingId, state: "ready", syncState: "idle" },
    });
    await Promise.resolve();
    expect(nextEventSettled).toBe(false);

    const status = await app.request(
      `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      bindingId: created.binding.bindingId,
      state: "ready",
      syncState: "idle",
    });

    const ended = await app.request(
      `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/session`,
      { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toMatchObject({
      ok: true,
      binding: { bindingId: created.binding.bindingId, state: "ended", syncState: "not_started" },
    });
    const disconnectedEvent = await nextEvent;
    expect(new TextDecoder().decode(disconnectedEvent.value)).toContain(
      '"projectBinding":{"state":"disconnected"}',
    );
    await eventReader.cancel("test complete");

    await engine.close();
  });

  it("scopes Project Binding server workspaces by Remote Credential owner", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const first = pairedClient(store);
    const second = pairedClient(store);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });

    async function createSession(accessToken: string): Promise<{
      binding: { projectFingerprint: string; serverProjectRoot: string };
    }> {
      const response = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as {
        binding: { projectFingerprint: string; serverProjectRoot: string };
      };
    }

    const firstSession = await createSession(first.accessToken);
    const secondSession = await createSession(second.accessToken);

    expect(firstSession.binding.projectFingerprint).toBe("sha256_repo");
    expect(secondSession.binding.projectFingerprint).toBe("sha256_repo");
    expect(firstSession.binding.serverProjectRoot).not.toBe(
      secondSession.binding.serverProjectRoot,
    );
    expect(firstSession.binding.serverProjectRoot).toContain(workspaceRoot);
    expect(secondSession.binding.serverProjectRoot).toContain(workspaceRoot);

    await engine.close();
  });

  it("does not retain Project Binding sessions when lease persistence fails", async () => {
    const { engine } = testEngine();
    let attemptedBindingId: string | undefined;
    class FailingWorkspaceStore extends ProjectBindingWorkspaceStore {
      override async writeLease(lease: ProjectBindingLease): Promise<void> {
        attemptedBindingId = lease.bindingId;
        throw new Error("disk full");
      }
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new FailingWorkspaceStore({ root: workspaceRoot }),
    });

    const response = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      },
    );

    expect(response.status).toBe(500);
    expect(attemptedBindingId).toBeTruthy();
    const status = await app.request(
      `http://127.0.0.1:5387/api/v1/attach/project-bindings/${attemptedBindingId}/status`,
    );
    await expect(status.json()).resolves.toMatchObject({
      bindingId: attemptedBindingId,
      state: "not_attached",
    });

    await engine.close();
  });

  it("prunes an expired active Project Binding restart lease when HTTP starts", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const workspaces = new ProjectBindingWorkspaceStore({
      root: workspaceRoot,
      now: () => now,
      inactiveWorkspaceTtlMs: 0,
    });
    await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-restart-expired",
      projectRoot: "/repo",
      lastActiveAt: now.toISOString(),
    });
    await workspaces.writeLease({
      bindingId: "bind_restart_expired",
      projectFingerprint: "sha256-restart-expired",
      state: "ready",
      active: true,
      updatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
    });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      await withTimeout(
        waitFor(async () => {
          await expect(workspaces.listLeases("sha256-restart-expired")).resolves.toEqual([]);
        }),
        "prune restart lease at HTTP startup",
      );
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("maintains durable backend OAuth flows until the HTTP lifecycle closes", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-maintenance-"));
    dirs.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "host-state.sqlite3"),
    });
    const expireDue = vi.spyOn(storage.backendAuthFlows, "expireDue");
    const prune = vi.spyOn(storage.backendAuthFlows, "prune");
    const { engine } = testEngine();
    let app: CapletsHttpApp | undefined;
    try {
      app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        backendAuthFlows: storage.backendAuthFlows,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(expireDue).toHaveBeenCalledOnce();
      expect(prune).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(expireDue).toHaveBeenCalledTimes(2);
      expect(prune).toHaveBeenCalledTimes(2);

      await app.closeCapletsSessions();
      app = undefined;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(expireDue).toHaveBeenCalledTimes(2);
      expect(prune).toHaveBeenCalledTimes(2);
    } finally {
      await app?.closeCapletsSessions();
      await engine.close();
      await storage.close();
      vi.useRealTimers();
    }
  });

  it("maintains durable Admin idempotency records until the HTTP lifecycle closes", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "caplets-idempotency-maintenance-"));
    dirs.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "host-state.sqlite3"),
    });
    const prune = vi.spyOn(storage.idempotency, "prune");
    const { engine } = testEngine();
    let app: CapletsHttpApp | undefined;
    try {
      app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        authoritativeStorage: storage,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(prune).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(prune).toHaveBeenCalledTimes(2);

      await app.closeCapletsSessions();
      app = undefined;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prune).toHaveBeenCalledTimes(2);
    } finally {
      await app?.closeCapletsSessions();
      await engine.close();
      await storage.close();
      vi.useRealTimers();
    }
  });

  it("bounds workspace cleanup to one startup-or-prune run while cleanup is pending", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredWorkspaceCleanupStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        workspaces.releaseCleanup.resolve();
        await app.closeCapletsSessions();
        await engine.close();
      };

      expect(workspaces.cleanupCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(workspaces.cleanupCalls).toBe(1);
      workspaces.releaseCleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("expires inactive Project Binding sessions from in-memory lookups", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      await vi.advanceTimersByTimeAsync(60_000);

      const heartbeat = await app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      expect(heartbeat.status).toBe(404);
      const status = await app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
      );
      await expect(status.json()).resolves.toMatchObject({
        bindingId: created.binding.bindingId,
        state: "not_attached",
      });

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("terminalizes a post-TTL heartbeat before the next Project Binding prune tick", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      vi.setSystemTime(new Date("2026-06-25T12:01:00.001Z"));

      const heartbeat = await app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      expect(heartbeat.status).toBe(404);
      await vi.advanceTimersByTimeAsync(0);

      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("keeps prune racing a deferred heartbeat terminal rather than reviving its lease", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      workspaces.deferNextWrite();
      const heartbeat = app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      await workspaces.nextWriteStarted;
      await vi.advanceTimersByTimeAsync(60_000);
      workspaces.releaseNextWrite();

      expect((await heartbeat).status).toBe(403);
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
      const status = await app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
      );
      await expect(status.json()).resolves.toMatchObject({
        bindingId: created.binding.bindingId,
        state: "not_attached",
      });

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("deduplicates ownerless terminal cleanup while a prune write is pending and retries after failure", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      const statusUrl = `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`;
      workspaces.deferNextWrite();
      workspaces.failNextWrite();
      await vi.advanceTimersByTimeAsync(60_000);
      await workspaces.nextWriteStarted;
      await app.request(statusUrl);
      await app.request(statusUrl);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(workspaces.writeLeases).toHaveLength(1);

      workspaces.releaseNextWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaces.writeLeases).toHaveLength(2);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([]);

      await app.request(statusUrl);
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaces.writeLeases).toHaveLength(3);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          active: false,
          state: "ended",
        }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("bounds concurrent HTTP heartbeats to the in-flight write and the latest pending state", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const heartbeatUrl = `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`;
      workspaces.deferNextWrite();
      const first = app.request(heartbeatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
      });
      await workspaces.nextWriteStarted;
      const pending = [
        app.request(heartbeatUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: created.sessionId,
            state: "offline",
            syncState: "failed",
          }),
        }),
        app.request(heartbeatUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: created.sessionId,
            state: "degraded",
            syncState: "failed",
          }),
        }),
      ];
      await new Promise<void>((resolve) => setImmediate(resolve));
      workspaces.releaseNextWrite();

      expect((await first).status).toBe(200);
      await expect(Promise.all(pending)).resolves.toEqual([
        expect.objectContaining({ status: 200 }),
        expect.objectContaining({ status: 200 }),
      ]);
      expect(workspaces.writeLeases).toHaveLength(3);
      expect(workspaces.writeLeases.at(-1)).toMatchObject({
        bindingId: created.binding.bindingId,
        state: "degraded",
      });
    } finally {
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("makes shutdown terminal when a Project Binding heartbeat write is in flight", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      workspaces.deferNextWrite();
      const heartbeat = app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
        },
      );
      await workspaces.nextWriteStarted;
      const closing = app.closeCapletsSessions();
      workspaces.releaseNextWrite();

      expect((await heartbeat).status).toBe(403);
      await closing;
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("does not acknowledge an HTTP Project Binding end when terminal lease persistence fails", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new FailingProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
      };
      workspaces.failNextWrite();

      const ended = await app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
      );
      expect(ended.status).toBe(500);
      await app.closeCapletsSessions();
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("rejects failed shutdown cleanup and lets a later shutdown retry terminal persistence", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new FailingProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
      };
      workspaces.failNextWrite();

      await expect(app.closeCapletsSessions()).rejects.toThrow("terminal lease write failed");
      await app.closeCapletsSessions();
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("terminalizes a staged session lease when shutdown wins creation", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      workspaces.deferNextWrite();
      const creating = app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      await workspaces.nextWriteStarted;
      const closing = app.closeCapletsSessions();
      workspaces.releaseNextWrite();

      expect((await creating).status).toBe(503);
      await closing;
      const rejectedAfterShutdown = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectRoot: "/repo",
            projectFingerprint: "sha256_after_shutdown",
          }),
        },
      );
      expect(rejectedAfterShutdown.status).toBe(503);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([expect.objectContaining({ active: false, state: "ended" })]);
    } finally {
      await engine.close();
    }
  });

  it("retries durable cleanup when a just-admitted create races shutdown", async () => {
    const { engine } = testEngine();
    vi.spyOn(engine, "hostNodeIdentity").mockReturnValue("node-race");
    const storageRoot = mkdtempSync(join(tmpdir(), "caplets-binding-state-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(storageRoot, workspaceRoot);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(storageRoot, "host-state.sqlite3"),
    });
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const endDurableBinding = storage.projectBindings.end.bind(storage.projectBindings);
    let endAttempts = 0;
    let successfulEnds = 0;
    vi.spyOn(storage.projectBindings, "end").mockImplementation(async (input) => {
      endAttempts += 1;
      if (endAttempts === 1) {
        throw new Error("transient durable end failure");
      }
      const ended = await endDurableBinding(input);
      successfulEnds += 1;
      return ended;
    });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      authoritativeStorage: storage,
      projectBindingWorkspaceStore: workspaces,
    });

    try {
      workspaces.deferNextWrite();
      const creating = app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_race" }),
        },
      );
      await workspaces.nextWriteStarted;
      const closing = app.closeCapletsSessions();
      workspaces.releaseNextWrite();

      expect((await creating).status).not.toBe(201);
      await closing;
      await expect(storage.projectBindings.list()).resolves.toEqual([
        expect.objectContaining({ active: false, generation: 2, state: "ended" }),
      ]);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_race"),
        ),
      ).resolves.toEqual([expect.objectContaining({ active: false, state: "ended" })]);

      await app.closeCapletsSessions();
      expect(successfulEnds).toBe(1);
    } finally {
      await app.closeCapletsSessions().catch(() => undefined);
      await engine.close();
      await storage.close();
    }
  });

  it("accepts Project Binding WebSocket connections for owned sessions", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string; state: string; syncState: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created);
      try {
        await withTimeout(waitForSocketOpen(socket), "open Project Binding WebSocket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await expect(
          withTimeout(nextSocketJson(socket), "receive Project Binding ready"),
        ).resolves.toMatchObject({
          type: "ready",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
          syncState: "pending",
        });
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(
          waitFor(async () => {
            const status = await fetch(
              `${server.origin}/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
            );
            const payload = (await status.json()) as { state: string; syncState: string };
            expect(payload).toMatchObject({ state: "ready", syncState: "idle" });
          }),
          "observe Project Binding heartbeat",
        );
      } finally {
        socket.terminate();
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("retains an unexpectedly closed socket for one reconnect and terminalizes explicit end once", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);
    try {
      const session = await withTimeout(
        fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            projectRoot: "/repo",
            projectFingerprint: TEST_PROJECT_FINGERPRINT,
          }),
        }),
        "create authenticated Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
        sessionId: string;
      };
      const socketOptions = {
        projectFingerprint: TEST_PROJECT_FINGERPRINT,
        accessToken: credentials.accessToken,
      };
      const first = openProjectBindingSocket(server.origin, created, socketOptions);
      try {
        await withTimeout(waitForSocketOpen(first), "open first Project Binding socket");
        expect(first.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(first), "receive first Project Binding ready");
        const closed = waitForSocketClose(first);
        first.terminate();
        await withTimeout(closed, "observe unexpected first socket close");
      } finally {
        first.terminate();
      }
      const retained = await fetch(
        `${server.origin}/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
        { headers: { authorization: `Bearer ${credentials.accessToken}` } },
      );
      await expect(retained.json()).resolves.toMatchObject({
        bindingId: created.binding.bindingId,
        state: "attaching",
        expiresAt: created.binding.expiresAt,
      });
      expect(Date.now()).toBeLessThan(Date.parse(created.binding.expiresAt));
      const second = openProjectBindingSocket(server.origin, created, socketOptions);
      try {
        await withTimeout(waitForSocketOpen(second), "open reconnected Project Binding socket");
        expect(second.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await expect(
          withTimeout(nextSocketJson(second), "receive reconnected Project Binding ready"),
        ).resolves.toMatchObject({
          type: "ready",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
        });
        const ended = nextSocketJson(second);
        const closed = waitForSocketClose(second);
        second.send(
          JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          }),
        );
        await expect(withTimeout(ended, "receive explicit Project Binding end")).resolves.toEqual({
          type: "ended",
          reason: { code: "completed", message: "Project Binding completed." },
        });
        await expect(
          withTimeout(closed, "close explicitly ended Project Binding socket"),
        ).resolves.toMatchObject({ code: 1000 });
      } finally {
        second.terminate();
      }
      expect(
        workspaces.writeLeases.filter(
          (lease) => lease.bindingId === created.binding.bindingId && !lease.active,
        ),
      ).toHaveLength(1);
      const status = await fetch(
        `${server.origin}/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
        { headers: { authorization: `Bearer ${credentials.accessToken}` } },
      );
      await expect(status.json()).resolves.toEqual({
        bindingId: created.binding.bindingId,
        state: "not_attached",
      });
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("keeps two-socket heartbeat and end races terminal in either ordering", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      for (const heartbeatFirst of [true, false]) {
        const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        });
        const created = (await session.json()) as {
          binding: { bindingId: string };
          sessionId: string;
        };
        const first = openProjectBindingSocket(server.origin, created);
        const second = openProjectBindingSocket(server.origin, created);
        const firstReady = nextSocketJson(first);
        const secondReady = nextSocketJson(second);
        try {
          await withTimeout(waitForSocketOpen(first), "open first Project Binding socket");
          await withTimeout(waitForSocketOpen(second), "open second Project Binding socket");
          expect(first.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
          expect(second.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
          await withTimeout(firstReady, "receive first Project Binding ready");
          await withTimeout(secondReady, "receive second Project Binding ready");

          const heartbeatSocket = heartbeatFirst ? first : second;
          const endingSocket = heartbeatFirst ? second : first;
          const heartbeatMessages: unknown[] = [];
          heartbeatSocket.on("message", (data) => {
            heartbeatMessages.push(JSON.parse(data.toString()) as unknown);
          });
          const heartbeat = JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          });
          const end = JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          });

          workspaces.deferNextWrite();
          if (heartbeatFirst) {
            heartbeatSocket.send(heartbeat);
            await withTimeout(workspaces.nextWriteStarted, "start deferred first heartbeat");
            const ended = nextSocketJson(endingSocket);
            endingSocket.send(end);
            workspaces.releaseNextWrite();
            await expect(withTimeout(ended, "receive Project Binding end")).resolves.toMatchObject({
              type: "ended",
            });
            const staleClose = waitForSocketClose(heartbeatSocket);
            heartbeatSocket.send(heartbeat);
            await expect(
              withTimeout(staleClose, "close stale first Project Binding socket"),
            ).resolves.toMatchObject({ code: 1008 });
          } else {
            const ended = nextSocketJson(endingSocket);
            endingSocket.send(end);
            await withTimeout(workspaces.nextWriteStarted, "start deferred Project Binding end");
            const staleClose = waitForSocketClose(heartbeatSocket);
            heartbeatSocket.send(heartbeat);
            workspaces.releaseNextWrite();
            await expect(withTimeout(ended, "receive Project Binding end")).resolves.toMatchObject({
              type: "ended",
            });
            await expect(
              withTimeout(staleClose, "close stale second Project Binding socket"),
            ).resolves.toMatchObject({ code: 1008 });
          }

          expect(heartbeatMessages).toEqual([]);
          const status = await app.request(
            `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
          );
          await expect(status.json()).resolves.toMatchObject({
            bindingId: created.binding.bindingId,
            state: "not_attached",
          });
          await expect(
            workspaces.listLeases(
              projectBindingWorkspaceFingerprintForTest(
                "development_unauthenticated",
                "sha256_repo",
              ),
            ),
          ).resolves.toContainEqual(
            expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
          );
        } finally {
          first.terminate();
          second.terminate();
        }
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  }, 30_000);

  it("keeps a queued heartbeat authoritative when its peer socket closes", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot: "/repo",
          projectFingerprint: TEST_PROJECT_FINGERPRINT,
        }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const heartbeatSocket = openProjectBindingSocket(server.origin, created);
      const peer = openProjectBindingSocket(server.origin, created);
      try {
        await withTimeout(waitForSocketOpen(heartbeatSocket), "open heartbeat socket");
        await withTimeout(waitForSocketOpen(peer), "open peer socket");
        expect(heartbeatSocket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        expect(peer.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(heartbeatSocket), "receive heartbeat socket ready");
        await withTimeout(nextSocketJson(peer), "receive peer socket ready");
        workspaces.deferNextWrite();
        heartbeatSocket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start deferred heartbeat");
        const peerClosed = waitForSocketClose(peer);
        peer.terminate();
        await withTimeout(peerClosed, "close peer socket unexpectedly");
        workspaces.releaseNextWrite();
        await withTimeout(
          waitFor(async () => {
            const status = await app.request(
              `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
            );
            await expect(status.json()).resolves.toMatchObject({
              bindingId: created.binding.bindingId,
              state: "ready",
              syncState: "idle",
            });
          }),
          "observe heartbeat retained after peer close",
        );
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(
              "development_unauthenticated",
              TEST_PROJECT_FINGERPRINT,
            ),
          ),
        ).resolves.toContainEqual(
          expect.objectContaining({
            bindingId: created.binding.bindingId,
            state: "ready",
            active: true,
          }),
        );
        heartbeatSocket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "degraded",
            syncState: "failed",
          }),
        );
        await withTimeout(
          waitFor(async () => {
            const status = await app.request(
              `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
            );
            await expect(status.json()).resolves.toMatchObject({
              state: "degraded",
              syncState: "failed",
            });
          }),
          "observe surviving socket heartbeat",
        );
        const ended = nextSocketJson(heartbeatSocket);
        heartbeatSocket.send(
          JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          }),
        );
        await expect(withTimeout(ended, "receive surviving socket end")).resolves.toMatchObject({
          type: "ended",
        });
      } finally {
        heartbeatSocket.terminate();
        peer.terminate();
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  }, 30_000);

  it("authenticates Project Binding WebSocket connections with bearer subprotocols", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create authenticated Project Binding session",
      );
      expect(session.status).toBe(201);
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open authenticated Project Binding socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await expect(
          withTimeout(nextSocketJson(socket), "receive authenticated Project Binding ready"),
        ).resolves.toMatchObject({
          type: "ready",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
        });
      } finally {
        socket.terminate();
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rejects missing or wrong Project Binding versions and malformed strict messages", async () => {
    const { engine } = testEngine();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");

    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot: "/repo",
          projectFingerprint: TEST_PROJECT_FINGERPRINT,
        }),
      });
      expect(session.status).toBe(201);
      const created = (await session.json()) as ProjectBindingSocketSession;

      for (const protocols of [[], ["caplets.project-binding.v2"]]) {
        const rejected = openProjectBindingSocket(server.origin, created, { protocols });
        await expect(
          withTimeout(rejectedSocketUpgradeStatus(rejected), "reject Project Binding version"),
        ).resolves.toBe(400);
      }

      const invalidMessages = [
        "{",
        JSON.stringify({
          type: "heartbeat",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
          state: "ready",
        }),
        JSON.stringify({
          type: "heartbeat",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
          state: "ready",
          syncState: "idle",
          unexpected: true,
        }),
        JSON.stringify({
          type: "unknown",
          bindingId: created.binding.bindingId,
          sessionId: created.sessionId,
        }),
      ];
      for (const invalidMessage of invalidMessages) {
        const socket = openProjectBindingSocket(server.origin, created);
        try {
          await withTimeout(waitForSocketOpen(socket), "open strict Project Binding socket");
          expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
          await withTimeout(nextSocketJson(socket), "receive strict Project Binding ready");
          const closed = waitForSocketClose(socket);
          socket.send(invalidMessage);
          await expect(
            withTimeout(closed, "reject malformed Project Binding message"),
          ).resolves.toMatchObject({
            code: 1008,
            reason: "Project Binding message is invalid.",
          });
        } finally {
          socket.terminate();
        }
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("keeps a socket authorized across token rotation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await withTimeout(
        fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        }),
        "create authenticated Project Binding session",
      );
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open authenticated Project Binding socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");

        const rotated = store.refreshClientCredentials({
          hostUrl: `${server.origin}/`,
          refreshToken: credentials.refreshToken,
        });
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(
          waitFor(async () => {
            const status = await fetch(
              `${server.origin}/api/v1/attach/project-bindings/${created.binding.bindingId}/status`,
              { headers: { authorization: `Bearer ${rotated.accessToken}` } },
            );
            await expect(status.json()).resolves.toMatchObject({
              state: "ready",
              syncState: "idle",
            });
          }),
          "observe heartbeat after token rotation",
        );
      } finally {
        socket.terminate();
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rechecks credential revocation after a queued first heartbeat commits but before the next mutation starts", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open queued authorization socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        workspaces.deferNextWrite();
        workspaces.runAfterNextWritePostCommit(() => {
          store.revokeClient(credentials.clientId);
        });
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start queued first heartbeat");
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "syncing",
            syncState: "syncing",
          }),
        );
        const firstNodeIoTurn = Promise.withResolvers<void>();
        setImmediate(firstNodeIoTurn.resolve);
        await firstNodeIoTurn.promise;
        expect(workspaces.writeLeases).toHaveLength(1);
        const secondNodeIoTurn = Promise.withResolvers<void>();
        setImmediate(secondNodeIoTurn.resolve);
        await secondNodeIoTurn.promise;
        expect(workspaces.writeLeases).toHaveLength(1);
        workspaces.releaseNextWrite();

        await expect(withTimeout(closed, "close demoted queued socket")).resolves.toMatchObject({
          code: 1008,
        });
        expect(workspaces.writeLeases).toHaveLength(3);
        expect(workspaces.writeLeases[1]).toMatchObject({
          bindingId: created.binding.bindingId,
          state: "ready",
          active: true,
        });
        expect(workspaces.writeLeases).not.toContainEqual(
          expect.objectContaining({ bindingId: created.binding.bindingId, state: "syncing" }),
        );
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({
            bindingId: created.binding.bindingId,
            state: "ended",
            active: false,
            expiresAt: workspaces.writeLeases[1]!.expiresAt,
          }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await app.closeCapletsSessions();
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rejects in-flight heartbeat state after post-write credential revocation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open post-write authorization socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        workspaces.deferNextWrite();
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "syncing",
            syncState: "syncing",
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start in-flight candidate lease write");
        store.revokeClient(credentials.clientId);
        workspaces.releaseNextWrite();

        await expect(withTimeout(closed, "close post-write demoted socket")).resolves.toMatchObject(
          {
            code: 1008,
          },
        );
        expect(workspaces.writeLeases).toHaveLength(3);
        expect(workspaces.writeLeases[1]).toMatchObject({
          bindingId: created.binding.bindingId,
          state: "syncing",
          active: true,
        });
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({
            bindingId: created.binding.bindingId,
            state: "ended",
            active: false,
            expiresAt: created.binding.expiresAt,
          }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("does not return a successful HTTP end after post-write credential revocation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const credentials = pairedClient(store);

    try {
      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      workspaces.deferNextWrite();
      const ending = app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credentials.accessToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      await workspaces.nextWriteStarted;
      store.revokeClient(credentials.clientId);
      workspaces.releaseNextWrite();

      expect((await ending).status).toBe(403);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          state: "ended",
          active: false,
          expiresAt: created.binding.expiresAt,
        }),
      ]);
    } finally {
      await engine.close();
    }
  });

  it("does not return a successful deferred end after its captured lease expires", async () => {
    vi.useFakeTimers();
    let cleanup: (() => Promise<void>) | undefined;
    try {
      vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
      const { engine } = testEngine();
      const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
      dirs.push(workspaceRoot);
      const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
      const app = createHttpServeApp(httpOptions(), engine, {
        writeErr: () => {},
        projectBindingWorkspaceStore: workspaces,
      });
      cleanup = async () => {
        await app.closeCapletsSessions();
        await engine.close();
      };

      const session = await app.request(
        "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
        },
      );
      const created = (await session.json()) as {
        binding: { bindingId: string; expiresAt: string };
      };
      workspaces.deferNextWrite();
      const ending = app.request(
        `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/session`,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await workspaces.nextWriteStarted;
      await vi.advanceTimersByTimeAsync(60_000);
      workspaces.releaseNextWrite();

      expect((await ending).status).toBe(403);
      await expect(
        workspaces.listLeases(
          projectBindingWorkspaceFingerprintForTest("development_unauthenticated", "sha256_repo"),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          bindingId: created.binding.bindingId,
          state: "ended",
          active: false,
          expiresAt: created.binding.expiresAt,
        }),
      ]);

      await cleanup();
      cleanup = undefined;
    } finally {
      await cleanup?.();
      vi.useRealTimers();
    }
  });

  it("does not acknowledge a socket end after post-write credential revocation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new DeferredProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open end authorization socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        const messages: unknown[] = [];
        socket.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as unknown);
        });
        workspaces.deferNextWrite();
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "end",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            reason: { code: "completed", message: "Project Binding completed." },
          }),
        );
        await withTimeout(workspaces.nextWriteStarted, "start in-flight terminal lease write");
        store.revokeClient(credentials.clientId);
        workspaces.releaseNextWrite();

        await expect(
          withTimeout(closed, "close post-write demoted end socket"),
        ).resolves.toMatchObject({
          code: 1008,
        });
        expect(messages).toEqual([]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("terminalizes an active Project Binding socket after durable client revocation", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: workspaceRoot });
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: workspaces,
    });
    const server = await withTimeout(startTestHttpServer(app), "start test HTTP server");
    const credentials = pairedClient(store, `${server.origin}/`);

    try {
      const session = await fetch(`${server.origin}/api/v1/attach/project-bindings/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      });
      const created = (await session.json()) as {
        binding: { bindingId: string };
        sessionId: string;
      };
      const socket = openProjectBindingSocket(server.origin, created, {
        accessToken: credentials.accessToken,
      });
      try {
        await withTimeout(waitForSocketOpen(socket), "open revocable Project Binding socket");
        expect(socket.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
        await withTimeout(nextSocketJson(socket), "receive Project Binding ready");
        store.revokeClient(credentials.clientId);
        const closed = waitForSocketClose(socket);
        socket.send(
          JSON.stringify({
            type: "heartbeat",
            bindingId: created.binding.bindingId,
            sessionId: created.sessionId,
            state: "ready",
            syncState: "idle",
          }),
        );

        await expect(
          withTimeout(closed, "close revoked Project Binding socket"),
        ).resolves.toMatchObject({
          code: 1008,
        });
        await expect(
          workspaces.listLeases(
            projectBindingWorkspaceFingerprintForTest(credentials.clientId, "sha256_repo"),
          ),
        ).resolves.toEqual([
          expect.objectContaining({ bindingId: created.binding.bindingId, active: false }),
        ]);
      } finally {
        socket.terminate();
      }
    } finally {
      await withTimeout(server.close(), "close test HTTP server");
      await engine.close();
    }
  });

  it("rejects Project Binding heartbeats from a different Remote Credential client", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const owner = pairedClient(store);
    const other = pairedClient(store);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "caplets-binding-workspaces-"));
    dirs.push(workspaceRoot);
    const app = createHttpServeApp(httpOptions({ auth: { type: "remote_credentials" } }), engine, {
      writeErr: () => {},
      remoteCredentialStore: store,
      projectBindingWorkspaceStore: new ProjectBindingWorkspaceStore({ root: workspaceRoot }),
    });

    const session = await app.request(
      "http://127.0.0.1:5387/api/v1/attach/project-bindings/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.accessToken}`,
        },
        body: JSON.stringify({ projectRoot: "/repo", projectFingerprint: "sha256_repo" }),
      },
    );
    const created = (await session.json()) as {
      binding: { bindingId: string };
      sessionId: string;
    };

    const heartbeat = await app.request(
      `http://127.0.0.1:5387/api/v1/attach/project-bindings/${created.binding.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${other.accessToken}`,
        },
        body: JSON.stringify({ sessionId: created.sessionId, state: "ready", syncState: "idle" }),
      },
    );

    expect(heartbeat.status).toBe(404);

    await engine.close();
  });

  it("ignores configured-prefix aliases and serves only the fixed health path", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
    });

    const prefixedHealth = await app.request("http://127.0.0.1:5387/caplets/v1/healthz");
    expect(prefixedHealth.status).toBe(404);

    const health = await app.request("http://127.0.0.1:5387/api/v1/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", ready: true });

    await engine.close();
  });

  it("completes durable backend OAuth through the unauthenticated canonical v2 callback", async () => {
    const context = testContext({ oauth: true });
    const firstStorage = await testAuthoritativeHostStorage(context.configPath);
    const secondStorage = await testAuthoritativeHostStorage(context.configPath);
    const firstEngine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
      hostStorage: firstStorage,
    });
    const secondEngine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
      hostStorage: secondStorage,
    });
    const firstApp = createHttpServeApp(httpOptions(), firstEngine, {
      writeErr: () => {},
      control: context,
    });
    const secondApp = createHttpServeApp(httpOptions(), secondEngine, {
      writeErr: () => {},
      control: context,
    });
    const [firstServer, secondServer] = await Promise.all([
      startTestHttpServer(firstApp),
      startTestHttpServer(secondApp),
    ]);
    const networkFetch = globalThis.fetch;
    let tokenExchanges = 0;
    const atomicCompletion = vi.spyOn(secondStorage.backendAuthFlows, "completeClaim");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (fetchInputUrl(input) === "https://auth.example/token") {
        tokenExchanges += 1;
        return Promise.resolve(testOAuthTokenResponse());
      }
      return networkFetch(input, init);
    });

    try {
      const started = await startBackendOAuthV2OverHttp(firstServer.origin);
      const authorizationUrl = new URL(started.authorizationUrl);
      expect(new URL(authorizationUrl.searchParams.get("redirect_uri")!).pathname).toBe(
        `/api/v2/admin/backend-auth-flows/${started.flowId}/callback`,
      );
      const state = authorizationUrl.searchParams.get("state");
      if (!state) throw new Error("Expected OAuth authorization state.");
      const callbackCode = "cross-node-provider-code";
      const callbackUrl = backendOAuthCallbackUrl(secondServer.origin, authorizationUrl, {
        code: callbackCode,
        state,
      });

      const completed = await fetch(callbackUrl);

      expect(completed.status).toBe(200);
      expect(completed.headers.get("cache-control")).toBe("no-store");
      const completedText = await completed.text();
      expect(JSON.parse(completedText)).toEqual({
        server: "remote",
        authenticated: true,
      });
      for (const secret of [callbackCode, state, "remote-access-token", "remote-refresh-token"]) {
        expect(completedText).not.toContain(secret);
      }
      expect(tokenExchanges).toBe(1);
      expect(atomicCompletion).toHaveBeenCalledTimes(1);
      await expect(firstStorage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
        flowId: started.flowId,
        server: "remote",
        status: "completed",
      });
      await expect(firstStorage.backendAuth.readTokenBundle("remote")).resolves.toMatchObject({
        generation: 1,
        bundle: {
          accessToken: "remote-access-token",
          refreshToken: "remote-refresh-token",
        },
      });

      const replayUrl = new URL(callbackUrl.pathname, `${firstServer.origin}/`);
      replayUrl.search = callbackUrl.search;
      const replay = await fetch(replayUrl);

      expect(replay.status).toBe(401);
      expect(replay.headers.get("cache-control")).toBe("no-store");
      const replayText = await replay.text();
      expect(JSON.parse(replayText)).toMatchObject({
        status: 401,
        code: expect.any(String),
      });
      for (const secret of [callbackCode, state, "remote-access-token", "remote-refresh-token"]) {
        expect(replayText).not.toContain(secret);
      }
      expect(tokenExchanges).toBe(1);
      expect(atomicCompletion).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      atomicCompletion.mockRestore();
      await Promise.all([firstServer.close(), secondServer.close()]);
      await Promise.all([firstEngine.close(), secondEngine.close()]);
    }
  });

  it("keeps provider error, state mismatch, and expiry callback envelopes safe", async () => {
    const context = testContext({ oauth: true });
    const storage = await testAuthoritativeHostStorage(context.configPath);
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
      hostStorage: storage,
    });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      control: context,
    });
    const server = await startTestHttpServer(app);
    const networkFetch = globalThis.fetch;
    let tokenExchanges = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (fetchInputUrl(input) === "https://auth.example/token") {
        tokenExchanges += 1;
        return Promise.resolve(testOAuthTokenResponse());
      }
      return networkFetch(input, init);
    });
    const safeFailure = async (url: URL, secrets: string[]): Promise<void> => {
      const response = await fetch(url);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        status: 401,
        code: "AUTH_FAILED",
        detail: "Backend authentication callback failed.",
      });
      for (const secret of secrets) expect(text).not.toContain(secret);
    };

    try {
      const providerFlow = await startBackendOAuthV2OverHttp(server.origin);
      const providerAuthorizationUrl = new URL(providerFlow.authorizationUrl);
      const providerState = providerAuthorizationUrl.searchParams.get("state");
      if (!providerState) throw new Error("Expected provider-error OAuth state.");
      const providerDescription = "private provider denial detail";
      await safeFailure(
        backendOAuthCallbackUrl(server.origin, providerAuthorizationUrl, {
          error: "access_denied",
          error_description: providerDescription,
          state: providerState,
        }),
        [providerDescription, providerState],
      );
      await expect(storage.backendAuthFlows.get(providerFlow.flowId)).resolves.toMatchObject({
        status: "failed",
      });

      const mismatchFlow = await startBackendOAuthV2OverHttp(server.origin);
      const mismatchAuthorizationUrl = new URL(mismatchFlow.authorizationUrl);
      const wrongState = "private-wrong-state";
      await safeFailure(
        backendOAuthCallbackUrl(server.origin, mismatchAuthorizationUrl, {
          code: "private-mismatch-code",
          state: wrongState,
        }),
        ["private-mismatch-code", wrongState],
      );
      await expect(storage.backendAuthFlows.get(mismatchFlow.flowId)).resolves.toMatchObject({
        status: "failed",
      });

      const expiredFlow = await startBackendOAuthV2OverHttp(server.origin);
      const expiredAuthorizationUrl = new URL(expiredFlow.authorizationUrl);
      const expiredState = expiredAuthorizationUrl.searchParams.get("state");
      if (!expiredState) throw new Error("Expected expiring OAuth state.");
      const flow = await storage.backendAuthFlows.get(expiredFlow.flowId);
      if (!flow) throw new Error("Expected a durable backend auth flow.");
      await storage.backendAuthFlows.expire(expiredFlow.flowId, new Date(flow.expiresAt));
      await safeFailure(
        backendOAuthCallbackUrl(server.origin, expiredAuthorizationUrl, {
          code: "private-expired-code",
          state: expiredState,
        }),
        ["private-expired-code", expiredState],
      );
      await expect(storage.backendAuthFlows.get(expiredFlow.flowId)).resolves.toMatchObject({
        status: "expired",
      });
      expect(tokenExchanges).toBe(0);
    } finally {
      fetchMock.mockRestore();
      await server.close();
      await engine.close();
    }
  });

  it("continues correlated OAuth persistence and finalization after callback disconnect", async () => {
    const context = testContext({ oauth: true });
    const storage = await testAuthoritativeHostStorage(context.configPath);
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
      hostStorage: storage,
    });
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      control: context,
    });
    const server = await startTestHttpServer(app);
    const networkFetch = globalThis.fetch;
    const exchangeStarted = Promise.withResolvers<void>();
    const tokenExchange = Promise.withResolvers<Response>();
    let tokenExchanges = 0;
    const atomicCompletion = vi.spyOn(storage.backendAuthFlows, "completeClaim");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (fetchInputUrl(input) === "https://auth.example/token") {
        tokenExchanges += 1;
        exchangeStarted.resolve();
        return tokenExchange.promise;
      }
      return networkFetch(input, init);
    });

    try {
      const started = await startBackendOAuthV2OverHttp(server.origin);
      const authorizationUrl = new URL(started.authorizationUrl);
      const state = authorizationUrl.searchParams.get("state");
      if (!state) throw new Error("Expected OAuth authorization state.");
      const callbackUrl = backendOAuthCallbackUrl(server.origin, authorizationUrl, {
        code: "disconnect-provider-code",
        state,
      });
      const controller = new AbortController();
      const callback = fetch(callbackUrl, { signal: controller.signal });
      await withTimeout(exchangeStarted.promise, "acquire durable OAuth completion");

      controller.abort();
      await expect(callback).rejects.toMatchObject({ name: "AbortError" });
      expect(atomicCompletion).not.toHaveBeenCalled();
      tokenExchange.resolve(testOAuthTokenResponse());

      await withTimeout(
        waitFor(async () => {
          await expect(storage.backendAuthFlows.get(started.flowId)).resolves.toMatchObject({
            status: "completed",
          });
        }),
        "finalize disconnected OAuth completion",
      );
      const stored = await storage.backendAuth.readTokenBundle("remote");
      if (!stored) throw new Error("Expected correlated OAuth credentials.");
      const correlation = backendAuthCompletionCorrelation(stored.bundle);
      if (!correlation) throw new Error("Expected backend auth completion correlation.");
      expect(correlation).toMatchObject({ flowId: started.flowId });
      expect(tokenExchanges).toBe(1);
      expect(atomicCompletion).toHaveBeenCalledTimes(1);
      expect(atomicCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: started.flowId,
          completionCorrelation: correlation.completionCorrelation,
          expectedGeneration: 0,
        }),
      );
    } finally {
      tokenExchange.resolve(testOAuthTokenResponse());
      fetchMock.mockRestore();
      atomicCompletion.mockRestore();
      await server.close();
      await engine.close();
    }
  });

  it("returns 404 for nested MCP paths", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/mcp/extra");
    expect(response.status).toBe(404);

    await engine.close();
  });
  it("preserves exact MCP session errors and method contract at the fixed endpoint", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.request("http://127.0.0.1:5387/mcp", { method });
      expect(response.status, method).toBe(400);
      await expect(response.json(), method).resolves.toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Mcp-Session-Id header is required",
        },
        id: null,
      });
    }

    const unknown = await app.request("http://127.0.0.1:5387/mcp", {
      headers: { "mcp-session-id": "missing-session" },
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });

    const unsupported = await app.request("http://127.0.0.1:5387/mcp", { method: "PUT" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("POST, GET, DELETE");

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("does not retain a server for a non-initialize MCP POST without a session", async () => {
    const { engine } = testEngine();
    const close = vi.fn(async () => undefined);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      sessionFactory: () => ({
        connect: async () => undefined,
        close,
      }),
    });

    const response = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5387",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(400);
    expect(close).toHaveBeenCalledOnce();
    await app.closeCapletsSessions();
    expect(close).toHaveBeenCalledOnce();
    await engine.close();
  });

  it("initializes an MCP HTTP session and lists Caplet tools", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const tools = await listMcpTools(app, "/mcp");

    expect(tools.map((tool) => tool.name)).toEqual(["code_mode"]);

    await engine.close();
  });

  it("returns an attach manifest instead of serving MCP on attach", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifestResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json();

    expect(manifest).toMatchObject({
      version: 1,
      revision: expect.any(String),
      generatedAt: expect.any(String),
      caplets: [],
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      completions: [],
      codeModeCaplets: [
        expect.objectContaining({
          stableId: "code_mode:status",
          kind: "caplet",
          capletId: "status",
          name: "Status",
          shadowing: "forbid",
        }),
      ],
      diagnostics: [],
    });

    await engine.close();
  });

  it("keeps the HTTP Attach revision stable after a README-only reload", async () => {
    const context = testContext();
    const capletDir = join(dirname(context.configPath), "status");
    const capletPath = join(capletDir, "CAPLET.md");
    mkdirSync(capletDir, { recursive: true });
    writeFileSync(capletPath, httpReadmeCaplet("Initial operator notes."));
    const engine = new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    });
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const initialResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    const initial = (await initialResponse.json()) as AttachManifest;

    writeFileSync(capletPath, httpReadmeCaplet("Updated troubleshooting notes."));

    await expect(engine.reload()).resolves.toBe(true);
    const nextResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    const next = (await nextResponse.json()) as AttachManifest;
    expect(next.revision).toBe(initial.revision);
    expect({ ...next, generatedAt: initial.generatedAt }).toEqual(initial);
    await engine.close();
  });

  it("rejects an old HTTP Attach export after reload hides its Caplet", async () => {
    const config = {
      options: { exposure: "direct" },
      httpApis: {
        status: {
          name: "Status",
          description: "Read status.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    };
    const { engine, configPath } = testEngine(config);
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });
    const manifestResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    const previous = (await manifestResponse.json()) as AttachManifest;
    const previousTool = previous.tools[0];
    expect(previousTool).toBeDefined();

    writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        httpApis: {
          status: {
            ...config.httpApis.status,
            disabled: true,
          },
        },
      }),
    );
    await engine.reload();

    const nextResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    const next = (await nextResponse.json()) as AttachManifest;
    expect(next.revision).not.toBe(previous.revision);
    expect(next.tools).toEqual([]);
    expect(next.diagnostics).toEqual([
      expect.objectContaining({ code: "ATTACH_CAPLET_DISABLED", capletId: "status" }),
    ]);

    const invoked = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: previous.revision,
        kind: "tool",
        exportId: previousTool?.exportId,
        input: {},
      }),
    });
    expect(invoked.status).toBe(409);
    await expect(invoked.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
    });

    await engine.close();
  });

  it("does not advertise attach routes when an HTTP app bridges an attached session", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      exposeAttach: false,
      sessionFactory: () => ({
        connect: async () => undefined,
        close: async () => undefined,
      }),
    });

    const discovery = (await (await app.request("http://127.0.0.1:5387/api/v1")).json()) as {
      links: Record<string, string>;
    };
    expect(discovery.links).not.toHaveProperty("attachManifest");
    expect(await app.request("http://127.0.0.1:5387/api/v1/attach/manifest")).toHaveProperty(
      "status",
      404,
    );

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("only advertises attach sessions when the session route is mounted", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const discovery = (await (await app.request("http://127.0.0.1:5387/api/v1")).json()) as {
      links: Record<string, string>;
    };

    expect(discovery.links).toMatchObject({
      attachManifest: "/api/v1/attach/manifest",
      attachEvents: "/api/v1/attach/events",
      attachInvoke: "/api/v1/attach/invoke",
    });
    expect(discovery.links).not.toHaveProperty("attachSessions");

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("routes attach manifest, invoke, and events through an attach session", async () => {
    const { engine } = testEngine();
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
    const projectConfigPath = join(projectRoot, ".caplets", "config.json");
    const closed: string[] = [];
    let eventListener: (() => void) | undefined;
    const manifest = attachManifest("session-rev", "session-tool");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (metadata) => ({
        manifest: async () => ({
          ...manifest,
          diagnostics: [
            {
              code: "SESSION_METADATA",
              message: JSON.stringify(metadata),
            },
          ],
        }),
        invoke: async (request) => ({ invoked: request.exportId }),
        onManifestChanged: (listener) => {
          eventListener = listener;
          return () => {
            eventListener = undefined;
          };
        },
        close: async () => {
          closed.push(metadata.projectRoot ?? "<none>");
        },
      }),
    });

    const created = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        projectConfigPath,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { sessionId: string };

    const sessionHeaders = { [CAPLETS_ATTACH_SESSION_HEADER]: body.sessionId };
    const manifestResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: sessionHeaders,
    });
    expect(manifestResponse.status).toBe(200);
    await expect(manifestResponse.json()).resolves.toMatchObject({
      revision: "session-rev",
      caplets: [expect.objectContaining({ capletId: "session-tool" })],
      diagnostics: [
        expect.objectContaining({
          code: "SESSION_METADATA",
          message: JSON.stringify({
            projectRoot,
            projectConfigPath,
          }),
        }),
      ],
    });

    const invoked = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { ...sessionHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        revision: "session-rev",
        kind: "caplet",
        exportId: "session-export",
        input: {},
      }),
    });
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toEqual({
      ok: true,
      data: { invoked: "session-export" },
    });

    const events = await app.request("http://127.0.0.1:5387/api/v1/attach/events", {
      headers: sessionHeaders,
    });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    eventListener?.();
    const changed = await reader.read();
    const changedText = new TextDecoder().decode(changed.value);
    expect(changedText).toContain("session-rev");
    const dataLine = changedText.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("Expected Attach manifest event data.");
    expect(attachManifestRevisionEventSchema.parse(JSON.parse(dataLine.slice(6)))).toEqual({
      revision: "session-rev",
    });
    expect(
      attachManifestRevisionEventSchema.safeParse({
        revision: "session-rev",
        unexpected: true,
      }).success,
    ).toBe(false);
    await reader.cancel();

    await app.closeCapletsSessions();
    expect(closed).toEqual([projectRoot]);
    await engine.close();
  });

  it("routes attach manifest and invoke through the default attach session without a session header", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      defaultAttachSessionFactory: () => ({
        manifest: async () => attachManifest("default-rev", "default-tool"),
        invoke: async (request) => ({ invoked: request.exportId }),
        onManifestChanged: () => () => undefined,
        close: async () => undefined,
      }),
    });

    const manifestResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest");
    expect(manifestResponse.status).toBe(200);
    const manifest = (await manifestResponse.json()) as AttachManifest;
    expect(manifest.revision).toBe("default-rev");

    const invoked = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: "default-rev",
        kind: "caplet",
        exportId: "session-export",
        input: {},
      }),
    });
    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toEqual({
      ok: true,
      data: { invoked: "session-export" },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("keeps caller-enabled artifact paths out of stacked MCP and Attach results", async () => {
    const downstream = await startPdfServer();
    const upstreamContext = testContext();
    const upstreamEngine = new CapletsEngine({
      configPath: upstreamContext.configPath,
      projectConfigPath: upstreamContext.projectConfigPath,
      watch: false,
    });
    const upstreamApp = createHttpServeApp(httpOptions(), upstreamEngine, { writeErr: () => {} });
    const upstream = await startTestHttpServer(upstreamApp);
    let captured: CapturedUpstreamServe | undefined;
    const captureSessionFactory = async (
      _options: HttpServeOptions,
      sessionFactory: HttpMcpSessionFactory,
      _writeErr: ((value: string) => void) | undefined,
      io: {
        attachSessionFactory?: HttpAttachSessionFactory;
        defaultAttachSessionFactory?: HttpAttachSessionFactory;
        exposeAttach?: boolean;
      },
      engineOptions: CapletsEngineOptions,
    ): Promise<void> => {
      captured = {
        sessionFactory,
        ...(io.attachSessionFactory ? { attachSessionFactory: io.attachSessionFactory } : {}),
        ...(io.defaultAttachSessionFactory
          ? { defaultAttachSessionFactory: io.defaultAttachSessionFactory }
          : {}),
        ...(io.exposeAttach === undefined ? {} : { exposeAttach: io.exposeAttach }),
        engineOptions,
      };
    };

    vi.resetModules();
    vi.doMock("../src/serve/http", () => ({
      ...serveHttpModule,
      serveHttpWithSessionFactory: captureSessionFactory,
    }));
    try {
      const wrapperContext = testContext();
      const authDir = tempDir("caplets-stacked-auth-");
      await new FileRemoteProfileStore({
        root: join(authDir, "remote-profiles"),
      }).saveRemoteProfile({
        origin: upstream.origin,
        clientId: "stacked_test_client",
        clientLabel: "Stacked Test",
        credentials: {
          accessToken: "stacked-access-token",
          refreshToken: "stacked-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      });
      const artifactDir = tempDir("caplets-stacked-artifacts-");
      writeFileSync(
        wrapperContext.configPath,
        JSON.stringify({
          options: { exposure: "direct" },
          httpApis: {
            overlay: {
              name: "Overlay HTTP",
              description: "Download a stacked runtime report.",
              exposure: "direct",
              baseUrl: downstream.baseUrl,
              auth: { type: "none" },
              actions: { download: { method: "GET", path: "/report" } },
            },
          },
        }),
      );

      // The module must load after the mock so the public upstream entrypoint builds its closures.
      const { serveResolvedCaplets } = await import("../src/serve");
      await serveResolvedCaplets(
        httpOptions({ port: 5399, upstreamUrl: upstream.origin }),
        {
          configPath: wrapperContext.configPath,
          projectConfigPath: wrapperContext.projectConfigPath,
          authDir,
          artifactDir,
          exposeLocalArtifactPaths: true,
          watch: false,
        },
        () => {},
      );
      if (!captured) throw new Error("expected stacked serve wiring to capture session factories");

      const wrapperEngine = new CapletsEngine(captured.engineOptions);
      const wrapperApp = createHttpServeApp(httpOptions({ loopback: false }), wrapperEngine, {
        writeErr: () => {},
        ...(captured.exposeAttach === undefined ? {} : { exposeAttach: captured.exposeAttach }),
        sessionFactory: captured.sessionFactory,
        ...(captured.attachSessionFactory
          ? { attachSessionFactory: captured.attachSessionFactory }
          : {}),
        ...(captured.defaultAttachSessionFactory
          ? { defaultAttachSessionFactory: captured.defaultAttachSessionFactory }
          : {}),
      });
      const wrapper = await startTestHttpServer(wrapperApp);
      try {
        expectRemoteArtifactResult(await callMcpTool(wrapper.origin, "overlay__download", {}));

        expectRemoteArtifactResult(await invokeAttachTool(wrapper.origin));

        const created = await fetch(`${wrapper.origin}/api/v1/attach/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(created.status).toBe(201);
        const sessionId = attachSessionId(await created.json());
        expectRemoteArtifactResult(
          await invokeAttachTool(wrapper.origin, {
            [CAPLETS_ATTACH_SESSION_HEADER]: sessionId,
          }),
        );
      } finally {
        await wrapperApp.closeCapletsSessions();
        await withTimeout(wrapper.close(), "close stacked HTTP server");
        await wrapperEngine.close();
      }
    } finally {
      vi.doUnmock("../src/serve/http");
      vi.resetModules();
      await upstreamApp.closeCapletsSessions();
      await withTimeout(upstream.close(), "close upstream HTTP server");
      await upstreamEngine.close();
      await downstream.close();
    }
  });

  it("rejects attach requests that would cycle through the same stacked runtime", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      defaultAttachSessionFactory: () => {
        throw new Error("default attach session should not be created");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { [CAPLETS_STACK_CHAIN_HEADER]: "http://127.0.0.1:5387/" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Stacked runtime upstream cycle detected.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("defaults attach session project config path from project root", async () => {
    const { engine } = testEngine();
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
    const projectConfigPath = join(projectRoot, ".caplets", "config.json");
    let captured: unknown;
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (metadata) => {
        captured = metadata;
        return {
          manifest: async () => attachManifest("session-rev", "session-tool"),
          invoke: async () => ({ ok: true }),
          onManifestChanged: () => () => undefined,
          close: async () => undefined,
        };
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(201);
    expect(captured).toEqual({ projectRoot, projectConfigPath });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project config paths outside the project root", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot, projectConfigPath: "/tmp/outside-config.json" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectConfigPath must be <projectRoot>/.caplets/config.json.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project config symlinks that resolve outside the project root", async () => {
    const { engine } = testEngine();
    const projectRoot = realpathSync(tempDir("caplets-attach-session-project-"));
    const outsideDir = tempDir("caplets-attach-session-outside-");
    const outsideConfig = join(outsideDir, "config.json");
    writeFileSync(outsideConfig, "{}", "utf8");
    mkdirSync(join(projectRoot, ".caplets"), { recursive: true });
    symlinkSync(outsideConfig, join(projectRoot, ".caplets", "config.json"));
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectConfigPath must resolve inside projectRoot.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project roots that are not directories", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const filePath = join(projectRoot, "not-a-directory");
    writeFileSync(filePath, "content", "utf8");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: filePath }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectRoot must be an existing directory.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project config paths that are not the standard project path", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        projectConfigPath: "other-config.json",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "projectConfigPath must be <projectRoot>/.caplets/config.json.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project context on non-loopback runtimes", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(httpOptions({ loopback: false }), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Attach session project context is only accepted by loopback runtimes.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("rejects attach session project context through a configured public origin", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const projectRoot = tempDir("caplets-attach-session-project-");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      {
        writeErr: () => {},
        remoteCredentialStore: store,
        attachSessionFactory: () => {
          throw new Error("session factory should not run");
        },
      },
    );

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify({ projectRoot }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Attach session project context is only accepted by loopback runtimes.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("canonicalizes symlinked attach session project config paths", async () => {
    const { engine } = testEngine();
    const projectRoot = tempDir("caplets-attach-session-project-");
    const canonicalProjectRoot = realpathSync(projectRoot);
    const projectConfigPath = join(canonicalProjectRoot, ".caplets", "config.json");
    mkdirSync(join(canonicalProjectRoot, ".caplets"), { recursive: true });
    writeFileSync(projectConfigPath, "{}", "utf8");
    const symlinkedProjectRoot = tempDir("caplets-attach-session-link-parent-");
    rmSync(symlinkedProjectRoot, { recursive: true, force: true });
    symlinkSync(projectRoot, symlinkedProjectRoot, "dir");
    dirs.push(symlinkedProjectRoot);
    let metadata: unknown;
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: (sessionMetadata) => {
        metadata = sessionMetadata;
        return {
          manifest: async () => attachManifest("session-rev", "session-tool"),
          invoke: async () => ({ ok: true }),
          onManifestChanged: () => () => undefined,
          close: async () => undefined,
        };
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: symlinkedProjectRoot,
        projectConfigPath: join(symlinkedProjectRoot, ".caplets", "config.json"),
      }),
    });

    expect(response.status).toBe(201);
    expect(metadata).toEqual({
      projectRoot: canonicalProjectRoot,
      projectConfigPath,
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("returns structured errors for unknown attach session headers", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => {
        throw new Error("session factory should not run");
      },
    });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { [CAPLETS_ATTACH_SESSION_HEADER]: "missing-session" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Attach session was not found.",
      },
    });

    await app.closeCapletsSessions();
    await engine.close();
  });

  it("keeps attach sessions active while events are connected", async () => {
    vi.useFakeTimers();
    const { engine } = testEngine();
    const manifest = attachManifest("session-rev", "session-tool");
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => ({
        manifest: async () => manifest,
        invoke: async () => ({ ok: true }),
        onManifestChanged: () => () => undefined,
        close: async () => undefined,
      }),
    });
    try {
      const created = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await created.json()) as { sessionId: string };
      const sessionHeaders = { [CAPLETS_ATTACH_SESSION_HEADER]: body.sessionId };
      const events = await app.request("http://127.0.0.1:5387/api/v1/attach/events", {
        headers: sessionHeaders,
      });
      const reader = events.body!.getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      const manifestResponse = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
        headers: sessionHeaders,
      });
      expect(manifestResponse.status).toBe(200);
      await reader.cancel();
    } finally {
      vi.useRealTimers();
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("prunes idle attach sessions without waiting for another request", async () => {
    vi.useFakeTimers();
    const { engine } = testEngine();
    const close = vi.fn(async () => undefined);
    const app = createHttpServeApp(httpOptions(), engine, {
      writeErr: () => {},
      attachSessionFactory: () => ({
        manifest: async () => attachManifest("session-rev", "session-tool"),
        invoke: async () => ({ ok: true }),
        onManifestChanged: () => () => undefined,
        close,
      }),
    });
    try {
      const created = await app.request("http://127.0.0.1:5387/api/v1/attach/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(created.status).toBe(201);

      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await app.closeCapletsSessions();
      await engine.close();
    }
  });

  it("invokes exported attach entries by revision-scoped export ID", async () => {
    const { engine } = testEngine({
      options: { exposure: "progressive" },
    });
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifest = (await (
      await app.request("http://127.0.0.1:5387/api/v1/attach/manifest")
    ).json()) as {
      revision: string;
      caplets: Array<{ exportId: string; kind: string; stableId: string; schemaHash: string }>;
    };
    expect(manifest.caplets).toHaveLength(1);

    const invoked = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: manifest.revision,
        kind: "caplet",
        exportId: manifest.caplets[0]!.exportId,
        input: { operation: "inspect" },
      }),
    });

    expect(invoked.status).toBe(200);
    await expect(invoked.json()).resolves.toMatchObject({
      ok: true,
      data: {
        structuredContent: {
          result: expect.objectContaining({ id: "status" }),
        },
      },
    });

    const stale = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: "old",
        kind: "caplet",
        exportId: manifest.caplets[0]!.exportId,
        input: { operation: "inspect" },
      }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
    });

    const malformed = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"revision":',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });

    await engine.close();
  });

  it("recomputes attach projections before invokes so stale downstream surfaces are rejected", async () => {
    let downstreamToolName = "read";
    const engine = {
      onReload: () => () => undefined,
      currentExposureGeneration: () => 0,
      exposureProjection: async () => ({
        generation: 0,
        projection: buildManifestExposureProjection({
          caplets: [],
          tools: [
            {
              kind: "tool",
              capletId: "docs",
              downstreamName: downstreamToolName,
              name: `docs__${downstreamToolName}`,
              inputSchema: { type: "object" },
              shadowing: "forbid",
            },
          ],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          completions: [],
        }),
      }),
      execute: async () => ({ called: true }),
    } as unknown as CapletsEngine;
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const manifest = (await (
      await app.request("http://127.0.0.1:5387/api/v1/attach/manifest")
    ).json()) as {
      revision: string;
      tools: Array<{ exportId: string; kind: string }>;
    };
    downstreamToolName = "search";

    const stale = await app.request("http://127.0.0.1:5387/api/v1/attach/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: manifest.revision,
        kind: "tool",
        exportId: manifest.tools[0]!.exportId,
        input: {},
      }),
    });

    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "ATTACH_MANIFEST_STALE" },
    });
  });

  it("returns Attach event headers for HEAD without subscribing to events", async () => {
    const { engine } = testEngine();
    const onReload = vi.spyOn(engine, "onReload");
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/events", {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.text()).toBe("");
    expect(onReload).not.toHaveBeenCalled();
    await app.closeCapletsSessions();
    await engine.close();
  });

  it("serves attach events as an unbuffered keep-alive SSE stream", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/events");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
    await engine.close();
  });

  it("closes active attach event streams during app shutdown", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/events");
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    await app.closeCapletsSessions();

    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await engine.close();
  });

  it("rejects unauthenticated attach requests through public origin host by default", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({ publicOrigin: "https://caplets.tail7ff085.ts.net" }),
      engine,
      { writeErr: () => {} },
    );

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { host: "caplets.tail7ff085.ts.net" },
    });

    expect(response.status).toBe(403);
    await engine.close();
  });

  it("allows attach requests through additional configured public origin hosts", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://primary.example.com",
        publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        allowUnauthenticatedHttp: true,
      }),
      engine,
      { writeErr: () => {} },
    );

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: { host: "secondary.example.com" },
    });

    expect(response.status).toBe(200);
    await engine.close();
  });

  it("allows authenticated attach requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: {
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await engine.close();
  });

  it("does not expose unversioned service routes", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(httpOptions(), engine, { writeErr: () => {} });

    for (const path of ["/v1/mcp", "/control", "/attach", "/healthz"]) {
      const response = await app.request(`http://127.0.0.1:5387${path}`, { method: "POST" });
      expect(response.status).toBe(404);
    }

    await engine.close();
  });

  it("allows authenticated attach requests through additional configured public origin hosts", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://secondary.example.com/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://primary.example.com",
        publicOrigins: ["https://primary.example.com", "https://secondary.example.com"],
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const response = await app.request("http://127.0.0.1:5387/api/v1/attach/manifest", {
      headers: {
        host: "secondary.example.com",
        authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    expect(response.status).toBe(200);
    await engine.close();
  });

  it("rejects unauthenticated MCP requests through public origin host by default", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({ publicOrigin: "https://caplets.tail7ff085.ts.net" }),
      engine,
      { writeErr: () => {} },
    );

    const init = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    expect(init.status).toBe(403);

    await engine.close();
  });

  it("allows authenticated MCP requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const store = remoteCredentialStore();
    const credentials = pairedClient(store, "https://caplets.tail7ff085.ts.net/");
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        auth: { type: "remote_credentials" },
      }),
      engine,
      { writeErr: () => {}, remoteCredentialStore: store },
    );

    const init = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
        authorization: `Bearer ${credentials.accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();

    await engine.close();
  });

  it("allows explicitly unauthenticated MCP requests through the configured public origin host", async () => {
    const { engine } = testEngine();
    const app = createHttpServeApp(
      httpOptions({
        publicOrigin: "https://caplets.tail7ff085.ts.net",
        allowUnauthenticatedHttp: true,
      }),
      engine,
      { writeErr: () => {} },
    );

    const init = await app.request("http://127.0.0.1:5387/mcp", {
      method: "POST",
      headers: {
        host: "caplets.tail7ff085.ts.net",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();

    await engine.close();
  });
});

async function listMcpTools(
  app: ReturnType<typeof createHttpServeApp>,
  path: "/mcp",
): Promise<Array<{ name: string; inputSchema?: unknown }>> {
  const init = await app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:5387",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  });

  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  await app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:5387",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const response = await app.request(`http://127.0.0.1:5387${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:5387",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });

  expect(response.status).toBe(200);
  const payload = parseMcpResponse(await response.text());

  const deleted = await app.request(`http://127.0.0.1:5387${path}`, {
    method: "DELETE",
    headers: {
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2025-03-26",
      host: "127.0.0.1:5387",
    },
  });
  expect(deleted.status).toBe(200);

  return payload.result.tools;
}

async function requestRawHttp(
  origin: string,
  path: string,
): Promise<{
  status: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const request = sendHttpRequest(origin, { method: "GET", path }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function startTestHttpServer(app: ReturnType<typeof createHttpServeApp>): Promise<{
  origin: string;
  close: () => Promise<void>;
  server: ServerType;
}> {
  return await new Promise((resolve) => {
    const websocketServer = new WebSocketServer({ noServer: true });
    const server = serve(
      {
        fetch: createNodeServerFetch(app),
        hostname: "127.0.0.1",
        port: 0,
        websocket: {
          server: websocketServer as unknown as WebSocketServerLike,
        },
      },
      (info) => {
        resolve({
          origin: `http://127.0.0.1:${info.port}`,
          server,
          close: async () => {
            for (const client of websocketServer.clients) {
              client.terminate();
            }
            await new Promise<void>((closed) => server.close(() => closed()));
          },
        });
      },
    );
  });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function startBackendOAuthV2OverHttp(
  origin: string,
): Promise<{ flowId: string; authorizationUrl: string }> {
  const response = await fetch(`${origin}/api/v2/admin/backend-auth-flows`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `backend-oauth-v2-${randomUUID()}`,
      "if-none-match": "*",
    },
    body: JSON.stringify({ serverId: "remote" }),
  });
  const body = (await response.json()) as {
    server: string;
    flowId: string;
    authorizationUrl: string;
  };
  expect(body).toEqual({
    server: "remote",
    flowId: expect.any(String),
    authorizationUrl: expect.any(String),
  });
  return body;
}

function backendOAuthCallbackUrl(
  origin: string,
  authorizationUrl: URL,
  parameters: Record<string, string>,
): URL {
  const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
  if (!redirectUri) throw new Error("Expected OAuth redirect URI.");
  const redirectUrl = new URL(redirectUri);
  const callbackUrl = new URL(redirectUrl.pathname, `${origin}/`);
  callbackUrl.search = redirectUrl.search;
  for (const [name, value] of Object.entries(parameters)) {
    callbackUrl.searchParams.set(name, value);
  }
  return callbackUrl;
}

function testOAuthTokenResponse(): Response {
  return Response.json({
    access_token: "remote-access-token",
    refresh_token: "remote-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
  });
}

const TEST_PROJECT_FINGERPRINT = "sha256_repo";

type ProjectBindingSocketSession = {
  binding: { bindingId: string };
  sessionId: string;
};

function projectBindingSocketUrl(
  origin: string,
  session: ProjectBindingSocketSession,
  projectFingerprint = TEST_PROJECT_FINGERPRINT,
): URL {
  const url = new URL("/api/v1/attach/project-bindings/connect", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("bindingId", session.binding.bindingId);
  url.searchParams.set("sessionId", session.sessionId);
  url.searchParams.set("projectFingerprint", projectFingerprint);
  return url;
}

function openProjectBindingSocket(
  origin: string,
  session: ProjectBindingSocketSession,
  options: {
    projectFingerprint?: string;
    accessToken?: string;
    protocols?: string[];
  } = {},
): WebSocket {
  const protocols = options.protocols ?? [
    PROJECT_BINDING_SOCKET_PROTOCOL,
    ...(options.accessToken
      ? [`caplets.bearer.${Buffer.from(options.accessToken).toString("base64url")}`]
      : []),
  ];
  const url = projectBindingSocketUrl(
    origin,
    session,
    options.projectFingerprint ?? TEST_PROJECT_FINGERPRINT,
  );
  return protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
}

async function rejectedSocketUpgradeStatus(socket: WebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let rejected = false;
    socket.on("error", (error) => {
      if (!rejected) reject(error);
    });
    socket.once("open", () => reject(new Error("Project Binding socket unexpectedly opened.")));
    socket.once("unexpected-response", (_request, response) => {
      rejected = true;
      const status = response.statusCode ?? 0;
      response.resume();
      response.once("end", () => {
        socket.terminate();
        resolve(status);
      });
    });
  });
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function nextSocketJson(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; reason: string }>();
  socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  socket.once("error", reject);
  return await promise;
}

async function waitFor(assertion: () => Promise<void>, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseMcpResponse(text: string): {
  result: { tools: Array<{ name: string; inputSchema?: unknown }> };
} {
  if (text.trimStart().startsWith("{")) {
    return JSON.parse(text) as {
      result: { tools: Array<{ name: string; inputSchema?: unknown }> };
    };
  }
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`Could not parse MCP response: ${text}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim()) as {
    result: { tools: Array<{ name: string; inputSchema?: unknown }> };
  };
}

function httpOptions(overrides: Partial<HttpServeOptions> = {}): HttpServeOptions {
  return {
    transport: "http",
    host: "127.0.0.1",
    port: 5387,
    publicOrigin: undefined,
    auth: { type: "development_unauthenticated" },
    allowUnauthenticatedHttp: false,
    warnUnauthenticatedNetwork: false,
    loopback: true,
    trustProxy: false,
    adminUploads: {
      stagingDir: join(tmpdir(), "caplets-uploads"),
      maxConcurrent: 1,
      maxStagedBytes: 400_000_000,
    },
    ...overrides,
  };
}

function attachManifest(revision: string, capletId: string): AttachManifest {
  return {
    version: 1,
    revision,
    generatedAt: "2026-06-23T00:00:00.000Z",
    caplets: [
      {
        stableId: `progressive:${capletId}`,
        exportId: "session-export",
        kind: "caplet",
        name: capletId,
        title: capletId,
        description: "Session tool.",
        inputSchema: { type: "object" },
        schemaHash: null,
        capletId,
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

function remoteCredentialStore(): RemoteServerCredentialStore {
  return new RemoteServerCredentialStore({ dir: tempDir("caplets-http-remote-credentials-") });
}

class DeferredProjectBindingWorkspaceStore extends ProjectBindingWorkspaceStore {
  nextWriteStarted: Promise<void> = Promise.resolve();
  writeLeases: ProjectBindingLease[] = [];
  private afterNextWritePostCommit: (() => void) | undefined;
  private failedWrites = 0;
  private deferredWrite:
    | {
        started: PromiseWithResolvers<void>;
        release: PromiseWithResolvers<void>;
      }
    | undefined;

  deferNextWrite(): void {
    this.deferredWrite = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.nextWriteStarted = this.deferredWrite.started.promise;
  }

  releaseNextWrite(): void {
    this.deferredWrite?.release.resolve();
  }

  failNextWrite(): void {
    this.failedWrites += 1;
  }

  runAfterNextWritePostCommit(action: () => void): void {
    this.afterNextWritePostCommit = action;
  }

  override async writeLease(lease: ProjectBindingLease): Promise<void> {
    const deferred = this.deferredWrite;
    if (deferred) {
      deferred.started.resolve();
      await deferred.release.promise;
      if (this.deferredWrite === deferred) this.deferredWrite = undefined;
    }
    this.writeLeases.push(lease);
    if (this.failedWrites > 0) {
      this.failedWrites -= 1;
      throw new Error("terminal lease write failed");
    }
    await super.writeLease(lease);
    const afterNextWritePostCommit = this.afterNextWritePostCommit;
    this.afterNextWritePostCommit = undefined;
    if (afterNextWritePostCommit) {
      queueMicrotask(() => queueMicrotask(afterNextWritePostCommit));
    }
  }
}

class DeferredWorkspaceCleanupStore extends ProjectBindingWorkspaceStore {
  cleanupCalls = 0;
  readonly releaseCleanup = Promise.withResolvers<void>();

  override async cleanup() {
    this.cleanupCalls += 1;
    await this.releaseCleanup.promise;
    return await super.cleanup();
  }
}

class FailingProjectBindingWorkspaceStore extends ProjectBindingWorkspaceStore {
  private failedWrites = 0;

  failNextWrite(): void {
    this.failedWrites += 1;
  }

  override async writeLease(lease: ProjectBindingLease): Promise<void> {
    if (this.failedWrites > 0) {
      this.failedWrites -= 1;
      throw new Error("terminal lease write failed");
    }
    await super.writeLease(lease);
  }
}

function projectBindingWorkspaceFingerprintForTest(
  ownerKey: string,
  projectFingerprint: string,
): string {
  return `sha256_${createHash("sha256").update(ownerKey).update("\0").update(projectFingerprint).digest("hex")}`;
}

function pairedClient(
  store: RemoteServerCredentialStore,
  hostUrl = "http://127.0.0.1:5387/",
  role: "access" | "operator" = "access",
): {
  clientId: string;
  accessToken: string;
  refreshToken: string;
} {
  if (role === "access") {
    const issued = store.createPairingCode({ hostUrl });
    return store.exchangePairingCode({
      hostUrl,
      code: issued.code,
    });
  }
  const pending = store.createPendingLogin({ hostUrl, requestedRole: role });
  store.approvePendingLogin({ operatorCode: pending.operatorCode });
  return store.completePendingLogin({
    hostUrl,
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
  });
}

function httpReadmeCaplet(readme: string): string {
  return [
    "---",
    "name: Status",
    "description: Read service status.",
    "httpApi:",
    "  baseUrl: http://127.0.0.1:1",
    "  auth: { type: none }",
    "  actions:",
    "    check: { method: GET, path: /check }",
    "---",
    readme,
    "",
  ].join("\n");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function testAuthoritativeHostStorage(configPath: string) {
  const root = dirname(dirname(configPath));
  return await createHostStorage(
    { type: "sqlite", path: join(root, "host-state.sqlite3") },
    { vaultRoot: join(root, "host-vault") },
  );
}

function testEngine(config: Record<string, unknown> = {}): {
  engine: CapletsEngine;
  configPath: string;
  projectConfigPath: string;
} {
  const context = testContext(config);
  return {
    engine: new CapletsEngine({
      configPath: context.configPath,
      projectConfigPath: context.projectConfigPath,
      watch: false,
    }),
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
  };
}

function testContext(options: { oauth?: boolean } & Record<string, unknown> = {}): {
  configPath: string;
  projectConfigPath: string;
  projectCapletsRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "caplets-http-"));
  dirs.push(dir);
  const userRoot = join(dir, "user");
  const projectRoot = join(dir, "project", ".caplets");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      options.oauth
        ? {
            ...(options.options ? { options: options.options } : {}),
            httpApis: {
              remote: {
                name: "Remote",
                description: "Remote OAuth API.",
                baseUrl: "http://127.0.0.1:1",
                auth: {
                  type: "oauth2",
                  clientId: "client",
                  authorizationUrl: "https://auth.example/authorize",
                  tokenUrl: "https://auth.example/token",
                },
                actions: { check: { method: "GET", path: "/check" } },
              },
            },
          }
        : {
            ...(options.options ? { options: options.options } : {}),
            httpApis: {
              status: {
                name: "Status",
                description: "Status API.",
                baseUrl: "http://127.0.0.1:1",
                auth: { type: "none" },
                actions: { check: { method: "GET", path: "/check" } },
              },
            },
          },
    ),
  );
  return { configPath, projectConfigPath, projectCapletsRoot: projectRoot };
}

type CapturedUpstreamServe = {
  sessionFactory: HttpMcpSessionFactory;
  attachSessionFactory?: HttpAttachSessionFactory;
  defaultAttachSessionFactory?: HttpAttachSessionFactory;
  exposeAttach?: boolean;
  engineOptions: CapletsEngineOptions;
};

async function startPdfServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/pdf");
    response.end(Buffer.from("%PDF-1.7 stacked"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("stacked HTTP artifact server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function callMcpTool(
  origin: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const initialized = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "host-boundary-test", version: "1.0.0" },
      },
    }),
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("expected MCP session ID");
  try {
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return mcpToolCallResult(await response.text());
  } finally {
    const deleted = await fetch(`${origin}/mcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
    });
    expect(deleted.status).toBe(200);
  }
}

function mcpToolCallResult(text: string): unknown {
  const payloadText = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
  if (!payloadText) throw new Error(`Could not parse MCP response: ${text}`);
  const payload: unknown = JSON.parse(payloadText);
  if (!isRecord(payload) || !("result" in payload)) {
    throw new Error("MCP tool call did not return a result");
  }
  return payload.result;
}

function attachToolInvocation(
  manifest: unknown,
  name: string,
): { revision: string; exportId: string } {
  if (
    !isRecord(manifest) ||
    typeof manifest.revision !== "string" ||
    !Array.isArray(manifest.tools)
  ) {
    throw new Error("expected Attach manifest");
  }
  const tool = manifest.tools.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.name === name && typeof candidate.exportId === "string",
  );
  if (!tool) throw new Error(`expected Attach export ${name}`);
  const exportId = tool.exportId;
  if (typeof exportId !== "string") throw new Error(`expected Attach export ID for ${name}`);
  return { revision: manifest.revision, exportId };
}

function attachResponseData(response: unknown): unknown {
  if (!isRecord(response) || response.ok !== true || !("data" in response)) {
    throw new Error("expected successful Attach response");
  }
  return response.data;
}

async function invokeAttachTool(
  origin: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const manifestResponse = await fetch(`${origin}/api/v1/attach/manifest`, { headers });
  expect(manifestResponse.status).toBe(200);
  const attachExport = attachToolInvocation(await manifestResponse.json(), "overlay__download");
  const invokeResponse = await fetch(`${origin}/api/v1/attach/invoke`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      revision: attachExport.revision,
      kind: "tool",
      exportId: attachExport.exportId,
      input: {},
    }),
  });
  expect(invokeResponse.status).toBe(200);
  return attachResponseData(await invokeResponse.json());
}

function attachSessionId(response: unknown): string {
  if (!isRecord(response) || typeof response.sessionId !== "string") {
    throw new Error("expected Attach session ID");
  }
  return response.sessionId;
}

function expectRemoteArtifactResult(result: unknown): void {
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
