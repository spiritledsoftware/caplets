import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { resolveProjectCapletsRoot } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import {
  attachErrorResponse,
  buildAttachProjection,
  invokeAttachExport,
  type AttachInvokeRequest,
} from "../attach/api";
import {
  dispatchRemoteCliRequest,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";
import { RemoteAuthFlowStore } from "../remote-control/auth-flow";
import type { RemoteCliRequest } from "../remote-control/types";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import type { HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";

type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: Omit<RemoteControlDispatchContext, "writeErr">;
  authFlowStore?: RemoteAuthFlowStore;
  sessionFactory?: HttpMcpSessionFactory;
  exposeAttach?: boolean;
  remoteCredentialStore?: RemoteServerCredentialStore;
};

type HttpMcpSession = {
  connect(transport: StreamableHTTPTransport): Promise<void>;
  close(): Promise<void>;
};

export type HttpMcpSessionFactory = () => HttpMcpSession | Promise<HttpMcpSession>;

type HttpSession = {
  server: HttpMcpSession;
  transport: StreamableHTTPTransport;
};

export type CapletsHttpApp = Hono & {
  closeCapletsSessions: () => Promise<void>;
};

type AttachEventStream = {
  close: () => void;
};

export function createHttpServeApp(
  options: HttpServeOptions,
  engine: CapletsEngine,
  io: HttpServeIo = {},
): CapletsHttpApp {
  const app = new Hono() as CapletsHttpApp;
  const sessions = new Map<string, HttpSession>();
  const attachEventStreams = new Set<AttachEventStream>();
  const writeErr = io.writeErr ?? process.stderr.write.bind(process.stderr);
  const paths = servicePaths(options.path);
  const authFlowStore = io.authFlowStore ?? new RemoteAuthFlowStore();
  const exposeAttach = io.exposeAttach ?? true;
  const remoteCredentialStore = remoteCredentialStoreForOptions(options, io.remoteCredentialStore);
  if (
    options.auth.type === "remote_credentials" &&
    options.trustProxy === true &&
    options.publicOrigin === undefined
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote credential auth with --trust-proxy requires CAPLETS_SERVER_URL.",
    );
  }
  const protectedRouteAuth = routeAuth(options, remoteCredentialStore, paths.base);
  app.use(
    "*",
    logger((message, ...rest) => {
      writeErr(`${[message, ...rest].join(" ")}\n`);
    }),
  );

  app.get(paths.base, (c) => {
    const remote = remoteCredentialStore
      ? remoteHostMetadata(c.req.url, paths.base, options, (name) => c.req.header(name))
      : undefined;
    return c.json({
      name: "caplets",
      transport: "http",
      base: paths.base,
      versions: [versionDiscovery(paths, exposeAttach, remote)],
      auth: { type: options.auth.type },
      ...(remote ? { remote } : {}),
    });
  });

  app.get(paths.version, (c) => {
    const remote = remoteCredentialStore
      ? remoteHostMetadata(c.req.url, paths.base, options, (name) => c.req.header(name))
      : undefined;
    return c.json(versionDiscovery(paths, exposeAttach, remote));
  });

  app.get(paths.health, (c) =>
    c.json({
      status: "ok",
    }),
  );

  if (remoteCredentialStore) {
    app.post(paths.pairingExchange, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pairing exchange request");
        const code = stringField(parsed, "code");
        const clientLabel = optionalStringField(parsed, "clientLabel");
        const credentials = remoteCredentialStore.exchangePairingCode({
          hostUrl: remoteCredentialHostUrl(
            c.req.url,
            paths.base,
            options.publicOrigin,
            options.trustProxy,
            (name) => c.req.header(name),
          ),
          code,
          ...(clientLabel ? { clientLabel } : {}),
        });
        return c.json({
          clientId: credentials.clientId,
          clientLabel: credentials.clientLabel,
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          tokenType: credentials.tokenType,
          expiresAt: credentials.expiresAt,
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.remoteRefresh, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Remote refresh request");
        const refreshToken = stringField(parsed, "refreshToken");
        const credentials = remoteCredentialStore.refreshClientCredentials({
          hostUrl: remoteCredentialHostUrl(
            c.req.url,
            paths.base,
            options.publicOrigin,
            options.trustProxy,
            (name) => c.req.header(name),
          ),
          refreshToken,
        });
        return c.json({
          clientId: credentials.clientId,
          clientLabel: credentials.clientLabel,
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          tokenType: credentials.tokenType,
          expiresAt: credentials.expiresAt,
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.delete(paths.remoteClient, protectedRouteAuth, (c) => {
      try {
        const client = validatedRemoteClient(
          c.req.header("authorization") ?? "",
          remoteCredentialStore,
          c.req.url,
          paths.base,
          options,
          (name) => c.req.header(name),
        );
        return c.json({
          revoked: remoteCredentialStore.revokeClient(client.clientId),
          clientId: client.clientId,
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });
  }

  app.all(paths.mcp, protectedRouteAuth, async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          404,
        );
      }
      return existing.transport.handleRequest(c);
    }

    if (c.req.method !== "POST") {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
          id: null,
        },
        400,
      );
    }

    const nextSessionId = randomUUID();
    const session = await createHttpSession(
      io.sessionFactory ?? (() => new CapletsMcpSession(engine)),
      nextSessionId,
      options,
      async (closedSessionId) => {
        const closed = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        if (closed) {
          await closed.server.close();
        }
      },
    );
    sessions.set(nextSessionId, session);
    return session.transport.handleRequest(c);
  });

  const attachHostProtection = dnsRebindingProtection(options);

  if (exposeAttach) {
    app.get(paths.attachManifest, attachHostProtection, protectedRouteAuth, async (c) => {
      const attachProjection = await buildAttachProjection(engine);
      return c.json(attachProjection.manifest);
    });

    app.get(paths.attachEvents, attachHostProtection, protectedRouteAuth, () =>
      attachEventsResponse(engine, attachEventStreams),
    );

    app.post(paths.attachInvoke, attachHostProtection, protectedRouteAuth, async (c) => {
      try {
        const request = await parseAttachInvokeRequest(c.req.json());
        const attachProjection = await buildAttachProjection(engine);
        const result = await invokeAttachExport(engine, attachProjection, request);
        return c.json({ ok: true, data: result });
      } catch (error) {
        const response = attachErrorResponse(error);
        return c.json(response.body, response.status);
      }
    });
  }

  app.post(paths.control, protectedRouteAuth, async (c) => {
    let request: RemoteCliRequest;
    try {
      const parsed = await c.req.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CapletsError("REQUEST_INVALID", "Control request JSON must be an object");
      }
      request = parsed as RemoteCliRequest;
    } catch (error) {
      const requestError =
        error instanceof CapletsError
          ? error
          : new CapletsError("REQUEST_INVALID", "Control request body must be valid JSON", error);
      const safe = toSafeError(requestError, "REQUEST_INVALID");
      return c.json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
    return c.json(
      await dispatchRemoteCliRequest(
        request,
        controlContext(
          io,
          writeErr,
          authFlowStore,
          c.req.url,
          paths.control,
          options.publicOrigin,
          options.trustProxy,
          (name) => c.req.header(name),
        ),
      ),
    );
  });

  app.get(routePath(paths.projectBindings, "connect"), protectedRouteAuth, (c) =>
    c.json({ error: "websocket_upgrade_required" }, 426),
  );

  app.get(routePath(paths.projectBindings, ":bindingId/status"), protectedRouteAuth, (c) =>
    c.json({
      bindingId: c.req.param("bindingId"),
      state: "not_attached",
    }),
  );

  app.post(routePath(paths.projectBindings, "sessions"), protectedRouteAuth, (c) => {
    const bindingId = randomUUID();
    return c.json(
      {
        binding: { bindingId, state: "attaching", syncState: "pending" },
        sessionId: randomUUID(),
      },
      201,
    );
  });

  app.post(routePath(paths.projectBindings, ":bindingId/heartbeat"), protectedRouteAuth, (c) =>
    c.json({
      ok: true,
      binding: { bindingId: c.req.param("bindingId"), state: "ready" },
    }),
  );

  app.delete(routePath(paths.projectBindings, ":bindingId/session"), protectedRouteAuth, (c) =>
    c.json({
      ok: true,
      binding: { bindingId: c.req.param("bindingId"), state: "ended" },
    }),
  );

  app.get(routePath(paths.control, "auth/callback/:flowId"), async (c) => {
    const flowId = c.req.param("flowId");
    const result = await dispatchRemoteCliRequest(
      { command: "auth_login_complete", arguments: { flowId, callbackUrl: c.req.url } },
      controlContext(
        io,
        writeErr,
        authFlowStore,
        c.req.url,
        paths.control,
        options.publicOrigin,
        options.trustProxy,
        (name) => c.req.header(name),
      ),
    );
    if (!result.ok) {
      writeErr(`Caplets authentication failed for flow ${flowId}: ${result.error.message}\n`);
    }
    return result.ok
      ? c.text("Caplets authentication complete. You can return to your terminal.")
      : c.text("Caplets authentication failed. Check server logs for details.", 400);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.closeCapletsSessions = async () => {
    for (const stream of attachEventStreams) {
      stream.close();
    }
    await Promise.allSettled(
      [...sessions.values()].map(async (session) => {
        await session.server.close();
      }),
    );
    sessions.clear();
  };

  if (options.warnUnauthenticatedNetwork) {
    writeErr(
      `Warning: Caplets MCP HTTP server is listening on ${options.host} without authentication.\n`,
    );
  }

  return app;
}

function controlContext(
  io: HttpServeIo,
  writeErr: (value: string) => void,
  authFlowStore: RemoteAuthFlowStore,
  requestUrl: string,
  controlPath: string,
  publicOrigin: string | undefined,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): RemoteControlDispatchContext {
  return {
    ...io.control,
    projectCapletsRoot: io.control?.projectCapletsRoot ?? resolveProjectCapletsRoot(),
    authFlowStore,
    controlCallbackBaseUrl: new URL(
      controlPath,
      publicOrigin ?? publicRequestOrigin(requestUrl, trustProxy, header),
    ).toString(),
    writeErr,
  };
}

function publicRequestOrigin(
  requestUrl: string,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): string {
  const url = new URL(requestUrl);
  if (!trustProxy) {
    return `${url.protocol.slice(0, -1)}://${url.host}`;
  }
  const forwardedProto = firstForwardedValue(header("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(header("x-forwarded-host"));
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : url.protocol.slice(0, -1);
  const host = forwardedHost ?? header("host") ?? url.host;
  return `${proto}://${host}`;
}

function publicHostUrl(
  requestUrl: string,
  basePath: string,
  publicOrigin: string | undefined,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): string {
  return new URL(
    basePath,
    publicOrigin ?? publicRequestOrigin(requestUrl, trustProxy, header),
  ).toString();
}

function remoteCredentialHostUrl(
  requestUrl: string,
  basePath: string,
  publicOrigin: string | undefined,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): string {
  if (trustProxy && !publicOrigin) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote credential auth with --trust-proxy requires CAPLETS_SERVER_URL.",
    );
  }
  return publicHostUrl(requestUrl, basePath, publicOrigin, trustProxy, header);
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

type RemoteHostMetadata = {
  hostIdentity: string;
  audience: string;
};

function remoteHostMetadata(
  requestUrl: string,
  basePath: string,
  options: HttpServeOptions,
  header: (name: string) => string | undefined,
): RemoteHostMetadata {
  const audience = remoteCredentialHostUrl(
    requestUrl,
    basePath,
    options.publicOrigin,
    options.trustProxy,
    header,
  );
  return { hostIdentity: audience, audience };
}

function versionDiscovery(
  paths: ReturnType<typeof servicePaths>,
  exposeAttach = true,
  remote?: RemoteHostMetadata | undefined,
) {
  return {
    version: 1,
    path: paths.version,
    ...(remote ? { remote } : {}),
    links: {
      mcp: paths.mcp,
      admin: paths.control,
      ...(exposeAttach
        ? {
            attachManifest: paths.attachManifest,
            attachEvents: paths.attachEvents,
            attachInvoke: paths.attachInvoke,
          }
        : {}),
      health: paths.health,
    },
  };
}

async function parseAttachInvokeRequest(input: Promise<unknown>): Promise<AttachInvokeRequest> {
  let parsed: unknown;
  try {
    parsed = await input;
  } catch (error) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Attach invoke request body must be valid JSON.",
      error,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError("REQUEST_INVALID", "Attach invoke request JSON must be an object.");
  }
  const request = parsed as Record<string, unknown>;
  if (
    typeof request.revision !== "string" ||
    typeof request.kind !== "string" ||
    typeof request.exportId !== "string"
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Attach invoke request requires revision, kind, and exportId.",
    );
  }
  if (!isAttachExportKind(request.kind)) {
    throw new CapletsError("REQUEST_INVALID", "Attach invoke kind is invalid.");
  }
  return {
    revision: request.revision,
    kind: request.kind,
    exportId: request.exportId,
    input: request.input,
  };
}

function isAttachExportKind(value: string): value is AttachInvokeRequest["kind"] {
  return (
    value === "caplet" ||
    value === "tool" ||
    value === "resource" ||
    value === "resourceTemplate" ||
    value === "prompt" ||
    value === "completion"
  );
}

function attachEventsResponse(
  engine: CapletsEngine,
  activeStreams: Set<AttachEventStream>,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let activeStream: AttachEventStream | undefined;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      activeStream = {
        close: () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (activeStream) activeStreams.delete(activeStream);
          try {
            controller.close();
          } catch {
            // The stream may already have been cancelled by the client.
          }
        },
      };
      activeStreams.add(activeStream);
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = engine.onReload(() => {
        void buildAttachProjection(engine)
          .then((projection) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(
                `event: manifest_changed\ndata: ${JSON.stringify({ revision: projection.manifest.revision })}\n\n`,
              ),
            );
          })
          .catch(() => undefined);
      });
    },
    cancel() {
      activeStream?.close();
    },
  });
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function serveHttp(
  options: HttpServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  const resolvedEngineOptions = {
    exposeLocalArtifactPaths: false,
    vaultRecoveryTarget: "remote" as const,
    ...engineOptions,
  };
  const engine = new CapletsEngine(resolvedEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    control: {
      ...resolvedEngineOptions,
      projectCapletsRoot: projectCapletsRootForEngineOptions(resolvedEngineOptions),
    },
  });
  const paths = servicePaths(options.path);
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = `${origin}${paths.base === "/" ? "" : paths.base}`;
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () => {
    writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
    writeErr(`MCP endpoint: ${origin}${paths.mcp}\n`);
    writeErr(`Attach manifest: ${origin}${paths.attachManifest}\n`);
    writeErr(`Control endpoint: ${origin}${paths.control}\n`);
    writeErr(`Health check: ${origin}${paths.health}\n`);
    writeErr(`Auth: ${authDescription(options)}\n`);
  });

  installHttpSignalHandlers(server, app, engine, writeErr);
}

export async function serveHttpWithSessionFactory(
  options: HttpServeOptions,
  createSession: HttpMcpSessionFactory,
  writeErr: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  const resolvedEngineOptions = { exposeLocalArtifactPaths: false };
  const engine = new CapletsEngine(resolvedEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    exposeAttach: false,
    sessionFactory: createSession,
    control: {
      ...resolvedEngineOptions,
      projectCapletsRoot: resolveProjectCapletsRoot(),
    },
  });
  const paths = servicePaths(options.path);
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = `${origin}${paths.base === "/" ? "" : paths.base}`;
  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () => {
    writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
    writeErr(`MCP endpoint: ${origin}${paths.mcp}\n`);
    writeErr(`Control endpoint: ${origin}${paths.control}\n`);
    writeErr(`Health check: ${origin}${paths.health}\n`);
    writeErr(`Auth: ${authDescription(options)}\n`);
  });

  installHttpSignalHandlers(server, app, engine, writeErr);
}

function projectCapletsRootForEngineOptions(engineOptions: CapletsEngineOptions): string {
  return engineOptions.projectConfigPath
    ? resolveProjectCapletsRootForConfigPath(engineOptions.projectConfigPath)
    : resolveProjectCapletsRoot();
}

function resolveProjectCapletsRootForConfigPath(projectConfigPath: string): string {
  return dirname(projectConfigPath);
}

export function routePath(base: string, path: string): string {
  return base === "/" ? `/${path}` : `${base}/${path}`;
}

export function servicePaths(base: string): {
  base: string;
  version: string;
  mcp: string;
  control: string;
  attachManifest: string;
  attachEvents: string;
  attachInvoke: string;
  projectBindings: string;
  pairingExchange: string;
  remoteRefresh: string;
  remoteClient: string;
  health: string;
} {
  const version = routePath(base, "v1");
  const attach = routePath(version, "attach");
  const remote = routePath(version, "remote");
  return {
    base,
    version,
    mcp: routePath(version, "mcp"),
    control: routePath(version, "admin"),
    attachManifest: routePath(attach, "manifest"),
    attachEvents: routePath(attach, "events"),
    attachInvoke: routePath(attach, "invoke"),
    projectBindings: routePath(attach, "project-bindings"),
    pairingExchange: routePath(remote, "pairing/exchange"),
    remoteRefresh: routePath(remote, "refresh"),
    remoteClient: routePath(remote, "client"),
    health: routePath(version, "healthz"),
  };
}

async function createHttpSession(
  createServer: HttpMcpSessionFactory,
  sessionId: string,
  options: HttpServeOptions,
  onClose: (sessionId: string) => Promise<void>,
): Promise<HttpSession> {
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => sessionId,
    onsessionclosed: onClose,
    ...(options.loopback ? dnsRebindingOptions(options) : {}),
  });
  const server = await createServer();
  await server.connect(transport);
  return { server, transport };
}

function routeAuth(
  options: HttpServeOptions,
  remoteCredentialStore: RemoteServerCredentialStore | undefined,
  basePath: string,
): MiddlewareHandler {
  if (options.auth.type === "development_unauthenticated") {
    return async (_c, next) => {
      await next();
    };
  }
  if (!remoteCredentialStore) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote credential auth requires a server credential store.",
    );
  }
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = bearerToken(header);
    if (!token) {
      return c.text("Unauthorized", 401);
    }
    try {
      remoteCredentialStore.validateAccessToken({
        hostUrl: remoteCredentialHostUrl(
          c.req.url,
          basePath,
          options.publicOrigin,
          options.trustProxy,
          (name) => c.req.header(name),
        ),
        accessToken: token,
      });
    } catch {
      return c.text("Unauthorized", 401);
    }
    await next();
  };
}

function validatedRemoteClient(
  authorizationHeader: string,
  remoteCredentialStore: RemoteServerCredentialStore,
  requestUrl: string,
  basePath: string,
  options: HttpServeOptions,
  header: (name: string) => string | undefined,
) {
  const token = bearerToken(authorizationHeader);
  if (!token) {
    throw new CapletsError("AUTH_FAILED", "Remote client credential is required.");
  }
  return remoteCredentialStore.validateAccessToken({
    hostUrl: remoteCredentialHostUrl(
      requestUrl,
      basePath,
      options.publicOrigin,
      options.trustProxy,
      header,
    ),
    accessToken: token,
  });
}

function remoteCredentialStoreForOptions(
  options: HttpServeOptions,
  store: RemoteServerCredentialStore | undefined,
): RemoteServerCredentialStore | undefined {
  if (options.auth.type !== "remote_credentials") return undefined;
  if (store) return store;
  if (!options.remoteCredentialStateDir) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote credential auth requires a server credential state directory.",
    );
  }
  return new RemoteServerCredentialStore({ dir: options.remoteCredentialStateDir });
}

function bearerToken(header: string): string | undefined {
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

async function parseJsonObject(
  input: Promise<unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await input;
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", `${label} body must be valid JSON.`, error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} JSON must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function remoteCredentialErrorResponse(error: unknown): Response {
  const safe =
    error instanceof CapletsError
      ? toSafeError(error, error.code)
      : toSafeError(error, "AUTH_FAILED");
  const status =
    safe.code === "REQUEST_INVALID" ? 400 : safe.code === "SERVER_UNAVAILABLE" ? 503 : 401;
  return Response.json({ ok: false, error: safe }, { status });
}

function dnsRebindingProtection(options: HttpServeOptions): MiddlewareHandler {
  if (!options.loopback) {
    return async (_c, next) => {
      await next();
    };
  }
  const allowedHosts = new Set(dnsRebindingOptions(options).allowedHosts);
  return async (c, next) => {
    const host = c.req.header("host");
    if (host && !allowedHosts.has(host)) {
      return c.text("Forbidden", 403);
    }
    await next();
  };
}

type DnsRebindingOptions = {
  enableDnsRebindingProtection: true;
  allowedHosts: string[];
};

function dnsRebindingOptions(options: HttpServeOptions): DnsRebindingOptions {
  const hostForHeader = options.host === "::1" ? "[::1]" : options.host;
  const publicUrl = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  const publicHosts =
    publicUrl && (options.auth.type === "remote_credentials" || options.allowUnauthenticatedHttp)
      ? [publicUrl.hostname, publicUrl.host]
      : [];
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [
      options.host,
      hostForHeader,
      `${hostForHeader}:${options.port}`,
      `localhost:${options.port}`,
      ...publicHosts,
    ],
  };
}

function authDescription(options: HttpServeOptions): string {
  return options.auth.type === "remote_credentials"
    ? "remote credentials"
    : "development unauthenticated";
}

function installHttpSignalHandlers(
  server: ServerType,
  app: CapletsHttpApp,
  engine: CapletsEngine,
  writeErr: (value: string) => void,
): void {
  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= (async () => {
      await app.closeCapletsSessions();
      closeAllServerConnections(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.close();
    })();
    return closing;
  };
  process.once(
    "SIGINT",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(130)),
  );
  process.once(
    "SIGTERM",
    () =>
      void close()
        .catch((error) => writeErr(`${String(error)}\n`))
        .finally(() => process.exit(143)),
  );
}

function closeAllServerConnections(server: ServerType): void {
  const closeAllConnections = (server as { closeAllConnections?: () => void }).closeAllConnections;
  closeAllConnections?.call(server);
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
