import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  CAPLETS_ATTACH_SESSION_HEADER,
  invokeAttachExport,
  type AttachManifest,
  type AttachInvokeRequest,
  type AttachSessionMetadata,
} from "../attach/api";
import {
  dispatchRemoteCliRequest,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";
import { RemoteAuthFlowStore } from "../remote-control/auth-flow";
import type { RemoteCliRequest } from "../remote-control/types";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import { isLoopbackHost } from "../server/options";
import type { HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";

type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: Omit<RemoteControlDispatchContext, "writeErr">;
  authFlowStore?: RemoteAuthFlowStore;
  sessionFactory?: HttpMcpSessionFactory;
  attachSessionFactory?: HttpAttachSessionFactory;
  defaultAttachSessionFactory?: HttpAttachSessionFactory;
  exposeAttach?: boolean;
  remoteCredentialStore?: RemoteServerCredentialStore;
};

type HttpMcpSession = {
  connect(transport: StreamableHTTPTransport): Promise<void>;
  close(): Promise<void>;
};

export type HttpMcpSessionFactory = () => HttpMcpSession | Promise<HttpMcpSession>;

export const CAPLETS_STACK_CHAIN_HEADER = "caplets-stack-chain";

export type HttpAttachSession = {
  manifest(): Promise<AttachManifest>;
  invoke(request: AttachInvokeRequest): Promise<unknown>;
  onManifestChanged(listener: () => void): () => void;
  close(): Promise<void>;
};

export type HttpAttachSessionContext = {
  stackChain: string[];
};

export type HttpAttachSessionFactory = (
  metadata: AttachSessionMetadata,
  context: HttpAttachSessionContext,
) => HttpAttachSession | Promise<HttpAttachSession>;

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

type AttachSessionRecord = {
  session: HttpAttachSession;
  lastUsedAt: number;
};

type AttachEventSource = {
  manifestRevision: () => Promise<string>;
  onManifestChanged: (listener: () => void) => () => void;
};

const ATTACH_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ATTACH_SESSION_PRUNE_INTERVAL_MS = 60_000;

export function createHttpServeApp(
  options: HttpServeOptions,
  engine: CapletsEngine,
  io: HttpServeIo = {},
): CapletsHttpApp {
  const app = new Hono() as CapletsHttpApp;
  const sessions = new Map<string, HttpSession>();
  const attachSessions = new Map<string, AttachSessionRecord>();
  const defaultAttachSessions = new Map<string, HttpAttachSession>();
  const defaultAttachSessionPromises = new Map<string, Promise<HttpAttachSession>>();
  const attachEventStreams = new Set<AttachEventStream>();
  const attachSessionPruneTimer = setInterval(
    () => pruneIdleAttachSessions(),
    ATTACH_SESSION_PRUNE_INTERVAL_MS,
  );
  attachSessionPruneTimer.unref?.();
  const writeErr = io.writeErr ?? process.stderr.write.bind(process.stderr);
  const paths = servicePaths(options.path);
  const stackIdentity = httpStackIdentity(options);
  const authFlowStore = io.authFlowStore ?? new RemoteAuthFlowStore();
  const exposeAttach = io.exposeAttach ?? true;
  const exposeAttachSessions = exposeAttach && Boolean(io.attachSessionFactory);
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
  const attachHostProtection = dnsRebindingProtection(options);
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
      versions: [versionDiscovery(paths, { exposeAttach, exposeAttachSessions }, remote)],
      auth: { type: options.auth.type },
      ...(remote ? { remote } : {}),
    });
  });

  app.get(paths.version, (c) => {
    const remote = remoteCredentialStore
      ? remoteHostMetadata(c.req.url, paths.base, options, (name) => c.req.header(name))
      : undefined;
    return c.json(versionDiscovery(paths, { exposeAttach, exposeAttachSessions }, remote));
  });

  app.get(paths.health, (c) =>
    c.json({
      status: "ok",
    }),
  );

  if (remoteCredentialStore) {
    app.post(paths.remoteLoginStart, attachHostProtection, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login start request");
        const clientLabel = optionalStringField(parsed, "clientLabel");
        const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
        const hostUrl = remoteCredentialHostUrl(
          c.req.url,
          paths.base,
          options.publicOrigin,
          options.trustProxy,
          (name) => c.req.header(name),
        );
        const pending = remoteCredentialStore.createPendingLogin({
          hostUrl,
          hostIdentity: hostUrl,
          ...(clientLabel ? { clientLabel } : {}),
          ...remoteCredentialSourceHint(options.trustProxy, (name) => c.req.header(name)),
          ...(clientFingerprint ? { clientFingerprint } : {}),
        });
        return c.json(pending);
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.remoteLoginPoll, attachHostProtection, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login poll request");
        return c.json(
          remoteCredentialStore.pollPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.remoteLoginRefresh, attachHostProtection, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login refresh request");
        return c.json(
          remoteCredentialStore.refreshPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingRefreshSecret: stringField(parsed, "pendingRefreshSecret"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.remoteLoginComplete, attachHostProtection, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login complete request");
        const credentials = remoteCredentialStore.completePendingLogin({
          hostUrl: remoteCredentialHostUrl(
            c.req.url,
            paths.base,
            options.publicOrigin,
            options.trustProxy,
            (name) => c.req.header(name),
          ),
          flowId: stringField(parsed, "flowId"),
          pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
        });
        return c.json(credentials);
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.remoteLoginCancel, attachHostProtection, async (c) => {
      try {
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login cancel request");
        return c.json(
          remoteCredentialStore.cancelPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(paths.pairingExchange, async (_c) => {
      return remoteCredentialErrorResponse(legacyPairingCodeUnsupportedError());
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

  if (exposeAttach) {
    if (io.attachSessionFactory) {
      app.post(paths.attachSessions, attachHostProtection, protectedRouteAuth, async (c) => {
        try {
          const parsed = await parseJsonObject(c.req.json(), "Attach session request");
          const metadata = parseAttachSessionMetadata(parsed, {
            allowProjectContext: allowAttachSessionProjectContext(options, c.req.url, (name) =>
              c.req.header(name),
            ),
          });
          const context = attachSessionContext(c.req.header(CAPLETS_STACK_CHAIN_HEADER));
          const sessionId = randomUUID();
          const session = await io.attachSessionFactory!(metadata, context);
          attachSessions.set(sessionId, { session, lastUsedAt: Date.now() });
          pruneIdleAttachSessions();
          return c.json({ sessionId }, 201);
        } catch (error) {
          const response = attachErrorResponse(error);
          return c.json(response.body, response.status);
        }
      });

      app.delete(
        routePath(paths.attachSessions, ":sessionId"),
        attachHostProtection,
        protectedRouteAuth,
        async (c) => {
          const sessionId = c.req.param("sessionId");
          if (!sessionId) {
            return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 400);
          }
          const record = attachSessions.get(sessionId);
          attachSessions.delete(sessionId);
          await record?.session.close();
          return c.json({ ok: true });
        },
      );
    }

    app.get(paths.attachManifest, attachHostProtection, protectedRouteAuth, async (c) => {
      try {
        const attachSessionId = c.req.header(CAPLETS_ATTACH_SESSION_HEADER);
        const attachSession = attachSessionId
          ? attachSessionForRequest(attachSessionId)
          : await fallbackAttachSession(
              attachSessionContext(c.req.header(CAPLETS_STACK_CHAIN_HEADER)),
            );
        if (attachSession) return c.json(await attachSession.manifest());
        const attachProjection = await buildAttachProjection(engine);
        return c.json(attachProjection.manifest);
      } catch (error) {
        const response = attachErrorResponse(error);
        return c.json(response.body, response.status);
      }
    });

    app.get(paths.attachEvents, attachHostProtection, protectedRouteAuth, async (c) => {
      try {
        const attachSessionId = c.req.header(CAPLETS_ATTACH_SESSION_HEADER);
        const attachSession = attachSessionId
          ? attachSessionForRequest(attachSessionId)
          : await fallbackAttachSession(
              attachSessionContext(c.req.header(CAPLETS_STACK_CHAIN_HEADER)),
            );
        return attachEventsResponse(attachEventSource(engine, attachSession), attachEventStreams, {
          onActivity: () => {
            if (attachSessionId) touchAttachSession(attachSessionId);
          },
        });
      } catch (error) {
        const response = attachErrorResponse(error);
        return c.json(response.body, response.status);
      }
    });

    app.post(paths.attachInvoke, attachHostProtection, protectedRouteAuth, async (c) => {
      try {
        const request = await parseAttachInvokeRequest(c.req.json());
        const attachSessionId = c.req.header(CAPLETS_ATTACH_SESSION_HEADER);
        const attachSession = attachSessionId
          ? attachSessionForRequest(attachSessionId)
          : await fallbackAttachSession(
              attachSessionContext(c.req.header(CAPLETS_STACK_CHAIN_HEADER)),
            );
        if (attachSession) {
          return c.json({ ok: true, data: await attachSession.invoke(request) });
        }
        const attachProjection = await buildAttachProjection(engine);
        const result = await invokeAttachExport(engine, attachProjection, request);
        return c.json({ ok: true, data: result });
      } catch (error) {
        const response = attachErrorResponse(error);
        return c.json(response.body, response.status);
      }
    });
  }

  function attachSessionForRequest(sessionId: string | undefined): HttpAttachSession | undefined {
    pruneIdleAttachSessions();
    if (!sessionId) return undefined;
    const record = attachSessions.get(sessionId);
    if (!record) {
      throw new CapletsError("REQUEST_INVALID", "Attach session was not found.");
    }
    record.lastUsedAt = Date.now();
    return record.session;
  }

  async function fallbackAttachSession(
    context: HttpAttachSessionContext,
  ): Promise<HttpAttachSession | undefined> {
    if (!io.defaultAttachSessionFactory) return undefined;
    const key = context.stackChain.join("\0");
    const existing = defaultAttachSessions.get(key);
    if (existing) return existing;
    let pending = defaultAttachSessionPromises.get(key);
    if (!pending) {
      pending = Promise.resolve(io.defaultAttachSessionFactory({}, context)).then(
        (session) => {
          defaultAttachSessions.set(key, session);
          defaultAttachSessionPromises.delete(key);
          return session;
        },
        (error) => {
          defaultAttachSessionPromises.delete(key);
          throw error;
        },
      );
      defaultAttachSessionPromises.set(key, pending);
    }
    return await pending;
  }

  function attachSessionContext(header: string | undefined): HttpAttachSessionContext {
    const incoming = stackChainFromHeader(header);
    if (incoming.includes(stackIdentity)) {
      throw new CapletsError("REQUEST_INVALID", "Stacked runtime upstream cycle detected.");
    }
    return { stackChain: [...incoming, stackIdentity] };
  }

  function touchAttachSession(sessionId: string): void {
    const record = attachSessions.get(sessionId);
    if (record) record.lastUsedAt = Date.now();
  }

  function pruneIdleAttachSessions(): void {
    const expiresBefore = Date.now() - ATTACH_SESSION_IDLE_TIMEOUT_MS;
    for (const [sessionId, record] of attachSessions) {
      if (record.lastUsedAt >= expiresBefore) continue;
      attachSessions.delete(sessionId);
      void record.session.close().catch((error) => {
        writeErr(`Could not close idle attach session: ${errorMessage(error)}\n`);
      });
    }
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

  app.post(routePath(paths.projectBindings, "sessions"), protectedRouteAuth, (c) =>
    c.json(projectBindingUnsupported(), 501),
  );

  app.post(routePath(paths.projectBindings, ":bindingId/heartbeat"), protectedRouteAuth, (c) =>
    c.json(projectBindingUnsupported(c.req.param("bindingId")), 501),
  );

  app.delete(routePath(paths.projectBindings, ":bindingId/session"), protectedRouteAuth, (c) =>
    c.json(projectBindingUnsupported(c.req.param("bindingId")), 501),
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
    clearInterval(attachSessionPruneTimer);
    for (const stream of attachEventStreams) {
      stream.close();
    }
    await Promise.allSettled(
      [...sessions.values()].map(async (session) => {
        await session.server.close();
      }),
    );
    sessions.clear();
    await Promise.allSettled([...attachSessions.values()].map((record) => record.session.close()));
    attachSessions.clear();
    await Promise.allSettled([...defaultAttachSessions.values()].map((session) => session.close()));
    defaultAttachSessions.clear();
    defaultAttachSessionPromises.clear();
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

function remoteCredentialSourceHint(
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): { sourceHint?: string | undefined } {
  if (!trustProxy) return {};
  const sourceHint =
    firstForwardedValue(header("x-forwarded-for")) ??
    firstForwardedValue(header("x-real-ip")) ??
    firstForwardedValue(header("cf-connecting-ip"));
  return sourceHint ? { sourceHint } : {};
}

function projectBindingUnsupported(bindingId?: string | undefined) {
  return {
    ok: false,
    error: {
      code: "UNSUPPORTED_CAPABILITY",
      message: "Self-hosted Project Binding sessions are not implemented by this runtime.",
    },
    ...(bindingId ? { binding: { bindingId, state: "not_attached" } } : {}),
  };
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStackIdentity(options: HttpServeOptions): string {
  const origin = options.publicOrigin ?? `http://${formatHost(options.host)}:${options.port}`;
  const url = new URL(origin);
  url.pathname = options.path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stackChainFromHeader(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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
  options: { exposeAttach?: boolean; exposeAttachSessions?: boolean } = {},
  remote?: RemoteHostMetadata | undefined,
) {
  const exposeAttach = options.exposeAttach ?? true;
  const exposeAttachSessions = options.exposeAttachSessions ?? false;
  return {
    version: 1,
    path: paths.version,
    ...(remote ? { remote } : {}),
    links: {
      mcp: paths.mcp,
      admin: paths.control,
      ...(exposeAttach
        ? {
            ...(exposeAttachSessions ? { attachSessions: paths.attachSessions } : {}),
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

function parseAttachSessionMetadata(
  input: Record<string, unknown>,
  options: { allowProjectContext: boolean },
): AttachSessionMetadata {
  const rawProjectRoot = optionalStringField(input, "projectRoot");
  const rawProjectConfigPath = optionalStringField(input, "projectConfigPath");
  if (!options.allowProjectContext && (rawProjectRoot || rawProjectConfigPath)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Attach session project context is only accepted by loopback runtimes.",
    );
  }
  const projectRoot = canonicalProjectRoot(rawProjectRoot);
  const projectConfigPath = canonicalProjectConfigPath(rawProjectConfigPath, projectRoot);
  return {
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectConfigPath ? { projectConfigPath } : {}),
  };
}

function canonicalProjectRoot(projectRoot: string | undefined): string | undefined {
  if (!projectRoot) return undefined;
  try {
    const canonical = realpathSync(projectRoot);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("projectRoot is not a directory.");
    }
    return canonical;
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", "projectRoot must be an existing directory.", error);
  }
}

function canonicalProjectConfigPath(
  projectConfigPath: string | undefined,
  projectRoot: string | undefined,
): string | undefined {
  if (!projectRoot) {
    if (!projectConfigPath) return undefined;
    throw new CapletsError("REQUEST_INVALID", "projectConfigPath requires projectRoot.");
  }
  const expectedProjectConfigPath = resolve(projectRoot, ".caplets", "config.json");
  const lexicalConfigPath =
    projectConfigPath === undefined
      ? expectedProjectConfigPath
      : isAbsolute(projectConfigPath)
        ? projectConfigPath
        : resolve(projectRoot, projectConfigPath);
  const canonicalConfigPath =
    projectConfigPath === undefined
      ? expectedProjectConfigPath
      : canonicalizeExistingParentPath(lexicalConfigPath);
  if (resolve(canonicalConfigPath) !== expectedProjectConfigPath) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "projectConfigPath must be <projectRoot>/.caplets/config.json.",
    );
  }
  if (!existsSync(expectedProjectConfigPath)) return expectedProjectConfigPath;
  const expected = realpathSync(expectedProjectConfigPath);
  if (!pathIsInside(expected, projectRoot)) {
    throw new CapletsError("REQUEST_INVALID", "projectConfigPath must resolve inside projectRoot.");
  }
  return expected;
}

function canonicalizeExistingParentPath(path: string): string {
  const parent = dirname(path);
  try {
    return resolve(realpathSync(parent), path.slice(parent.length + 1));
  } catch {
    return resolve(path);
  }
}

function pathIsInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowAttachSessionProjectContext(
  options: HttpServeOptions,
  requestUrl: string,
  header: (name: string) => string | undefined,
): boolean {
  if (!options.loopback) return false;
  const host = attachRequestHost(options, requestUrl, header);
  return isLoopbackHost(host);
}

function attachRequestHost(
  options: HttpServeOptions,
  requestUrl: string,
  header: (name: string) => string | undefined,
): string {
  const fallback = new URL(requestUrl).host;
  const forwardedHost = options.trustProxy
    ? firstForwardedValue(header("x-forwarded-host"))
    : undefined;
  const host = forwardedHost ?? header("host") ?? fallback;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(":")[0] ?? host;
  }
}

function attachEventSource(
  engine: CapletsEngine,
  session: HttpAttachSession | undefined,
): AttachEventSource {
  if (session) {
    return {
      manifestRevision: async () => (await session.manifest()).revision,
      onManifestChanged: (listener) => session.onManifestChanged(listener),
    };
  }
  return {
    manifestRevision: async () => (await buildAttachProjection(engine)).manifest.revision,
    onManifestChanged: (listener) =>
      engine.onReload(() => {
        listener();
      }),
  };
}

function attachEventsResponse(
  source: AttachEventSource,
  activeStreams: Set<AttachEventStream>,
  options: { onActivity?: () => void } = {},
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let activeStream: AttachEventStream | undefined;
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      activeStream = {
        close: () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (keepAliveTimer) clearInterval(keepAliveTimer);
          if (activeStream) activeStreams.delete(activeStream);
          try {
            controller.close();
          } catch {
            // The stream may already have been cancelled by the client.
          }
        },
      };
      activeStreams.add(activeStream);
      options.onActivity?.();
      controller.enqueue(encoder.encode(": connected\n\n"));
      keepAliveTimer = setInterval(() => {
        if (closed) return;
        options.onActivity?.();
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          activeStream?.close();
        }
      }, 30_000);
      keepAliveTimer.unref?.();
      unsubscribe = source.onManifestChanged(() => {
        options.onActivity?.();
        void source
          .manifestRevision()
          .then((revision) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: manifest_changed\ndata: ${JSON.stringify({ revision })}\n\n`),
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
  io: Pick<
    HttpServeIo,
    "attachSessionFactory" | "defaultAttachSessionFactory" | "exposeAttach"
  > = {},
  engineOptions: CapletsEngineOptions = {},
): Promise<void> {
  const resolvedEngineOptions = {
    exposeLocalArtifactPaths: false,
    vaultRecoveryTarget: "remote" as const,
    ...engineOptions,
  };
  const engine = new CapletsEngine(resolvedEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    exposeAttach: io.exposeAttach ?? false,
    sessionFactory: createSession,
    ...(io.attachSessionFactory ? { attachSessionFactory: io.attachSessionFactory } : {}),
    ...(io.defaultAttachSessionFactory
      ? { defaultAttachSessionFactory: io.defaultAttachSessionFactory }
      : {}),
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
  attachSessions: string;
  attachEvents: string;
  attachInvoke: string;
  projectBindings: string;
  pairingExchange: string;
  remoteLoginStart: string;
  remoteLoginPoll: string;
  remoteLoginRefresh: string;
  remoteLoginComplete: string;
  remoteLoginCancel: string;
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
    attachSessions: routePath(attach, "sessions"),
    attachManifest: routePath(attach, "manifest"),
    attachEvents: routePath(attach, "events"),
    attachInvoke: routePath(attach, "invoke"),
    projectBindings: routePath(attach, "project-bindings"),
    pairingExchange: routePath(remote, "pairing/exchange"),
    remoteLoginStart: routePath(remote, "login/start"),
    remoteLoginPoll: routePath(remote, "login/poll"),
    remoteLoginRefresh: routePath(remote, "login/refresh"),
    remoteLoginComplete: routePath(remote, "login/complete"),
    remoteLoginCancel: routePath(remote, "login/cancel"),
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

function legacyPairingCodeUnsupportedError(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "Self-hosted Pairing Code exchange is no longer supported. Run caplets remote login <url> and approve the pending login from the host.",
  );
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
