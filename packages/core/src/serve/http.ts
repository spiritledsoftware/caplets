import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  serve,
  upgradeWebSocket as upgradeNodeWebSocket,
  type Http2Bindings,
  type HttpBindings,
  type WebSocketServerLike,
} from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createWSMessageEvent,
  defineWebSocketHelper,
  WSContext,
  type UpgradeWebSocket,
  type WSEvents,
} from "hono/ws";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";
import { defaultCapletsLockfilePath, resolveCapletsRoot, vaultStoreForAuthDir } from "../config";
import { version as packageJsonVersion } from "../../package.json";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError, type CapletsErrorCode } from "../errors";
import {
  createCurrentHostOperations,
  toCurrentHostSafeError,
  trustedDevelopmentOperatorPrincipal,
  type CurrentHostControlContext,
  type CurrentHostLogStateOwner,
  type CurrentHostProjectBindingStateOwner,
  type CurrentHostRuntimeStateOwner,
} from "../current-host/operations";
import {
  CURRENT_HOST_DASHBOARD_PATHS,
  CURRENT_HOST_NAMESPACES,
  CURRENT_HOST_PATHS,
  CURRENT_HOST_ROUTE_PATTERNS,
  currentHostAdminPath,
  currentHostV1Path,
} from "../current-host/topology";
import { AdminBundleUploadAdmissionController } from "../admin-api/bundle-upload-admission";
import {
  adminV2CredentialMode,
  hasDashboardSessionCookie,
  isSameOriginDashboardRequest,
} from "../admin-api/auth";
import { createStrongEtag } from "../admin-api/conditional";
import { problemResponse } from "../admin-api/problem";
import {
  AdminV2PrincipalError,
  createAdminV2Router,
  type AdminV2AuthorityProvider,
  type AdminV2HostContext,
} from "../admin-api/router";
import {
  ifNoneMatchIncludes,
  rootOpenApiRepresentation,
} from "../admin-api/openapi-representation";
import { dashboardSessionCookie, expiredDashboardSessionCookie } from "../dashboard/auth";
import { DashboardActivityLog } from "../dashboard/activity-log";
import {
  dashboardShell,
  dashboardStaticResponse,
  dashboardStaticRouteExists,
} from "../dashboard/routes";
import { DashboardSessionStore, parseDashboardCookie } from "../dashboard/session-store";
import type { DashboardSessionView } from "../dashboard/types";
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
  type BindingTerminalReason,
  type ProjectBindingLease,
  type ProjectBindingState,
  type ProjectBindingSyncState,
} from "../project-binding";
import {
  projectBindingSocketProtocolSchema,
  projectBindingConnectQuerySchema,
  projectBindingHeartbeatRequestSchema,
  projectBindingSessionCreateRequestSchema,
  projectBindingSocketClientMessageSchema,
  type ProjectBindingSocketClientMessage,
} from "../project-binding/protocol";
import { ProjectBindingWorkspaceStore } from "../project-binding/workspaces";
import {
  canonicalizeCurrentHostOrigin,
  isLoopbackCurrentHostHostname,
} from "../current-host/origin";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import { remoteClientById, type RemoteSecurityStore } from "../storage/remote-security";
import type { BackendAuthStateStore } from "../storage/backend-auth";
import type { BackendAuthFlowRepository } from "../storage/backend-auth-flows";
import type { HostStorage } from "../storage/database";
import {
  remoteClientRoleSatisfies,
  type RemoteClientRole,
  type ValidatedRemoteClient,
} from "../remote/server-credentials";
import type { HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";
import { readLimitedJsonObject } from "./request-body";

type RemoteCredentialStore = RemoteServerCredentialStore | RemoteSecurityStore;
type HttpServer = {
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
};
type BunRuntimeServer = {
  stop(closeActiveConnections?: boolean): Promise<void>;
};

type BunServeOptions = {
  fetch: CapletsHttpApp["fetch"];
  hostname: string;
  port: number;
  websocket: BunWebSocketHandler;
};

type BunRuntime = {
  serve(options: BunServeOptions): BunRuntimeServer;
};
type BunWebSocketData = {
  events: WSEvents;
  protocol: string;
  url: URL;
};

type BunServerWebSocket = {
  close(code?: number, reason?: string): void;
  data: BunWebSocketData;
  readyState: 0 | 1 | 2 | 3;
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): void;
};

type BunWebSocketHandler = {
  close(socket: BunServerWebSocket, code?: number, reason?: string): void;
  message(socket: BunServerWebSocket, message: string | { buffer: ArrayBufferLike }): void;
  open(socket: BunServerWebSocket): void;
};

type BunWebSocketUpgradeServer = {
  upgrade(request: Request, options: { data: BunWebSocketData }): boolean;
};

const upgradeBunWebSocket = defineWebSocketHelper((context, events) => {
  const server = bunWebSocketUpgradeServer(context.env);
  if (!server) throw new Error("Bun WebSocket upgrade API is unavailable.");
  const upgraded = server.upgrade(context.req.raw, {
    data: {
      events,
      protocol: context.req.header("sec-websocket-protocol")?.split(",")[0]?.trim() ?? "",
      url: new URL(context.req.url),
    },
  });
  return upgraded ? new Response(null) : undefined;
});

const bunWebSocket: BunWebSocketHandler = {
  open(socket) {
    socket.data.events.onOpen?.(new Event("open"), bunWebSocketContext(socket));
  },
  close(socket, code, reason) {
    socket.data.events.onClose?.(
      new CloseEvent("close", {
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      }),
      bunWebSocketContext(socket),
    );
  },
  message(socket, message) {
    socket.data.events.onMessage?.(
      createWSMessageEvent(typeof message === "string" ? message : message.buffer),
      bunWebSocketContext(socket),
    );
  },
};
function bunWebSocketUpgradeServer(env: unknown): BunWebSocketUpgradeServer | undefined {
  let candidate = env;
  if (candidate !== null && typeof candidate === "object" && "server" in candidate) {
    candidate = Reflect.get(candidate, "server");
  }
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof Reflect.get(candidate, "upgrade") !== "function"
  ) {
    return undefined;
  }
  return candidate as BunWebSocketUpgradeServer;
}

function bunWebSocketContext(socket: BunServerWebSocket): WSContext<BunServerWebSocket> {
  return new WSContext({
    close: (code, reason) => socket.close(code, reason),
    protocol: socket.data.protocol,
    raw: socket,
    readyState: socket.readyState,
    send: (source, options) => socket.send(source, options.compress),
    url: socket.data.url,
  });
}

const upgradeProjectBindingWebSocket = (
  process.versions.bun ? upgradeBunWebSocket : upgradeNodeWebSocket
) as UpgradeWebSocket;

type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: CurrentHostControlContext;
  backendAuthFlows?: BackendAuthFlowRepository;
  sessionFactory?: HttpMcpSessionFactory;
  attachSessionFactory?: HttpAttachSessionFactory;
  defaultAttachSessionFactory?: HttpAttachSessionFactory;
  exposeAttach?: boolean;
  remoteCredentialStore?: RemoteCredentialStore;
  backendAuthStore?: BackendAuthStateStore;
  dashboardSessionStore?: DashboardSessionStore;
  authoritativeStorage?: HostStorage;
  dashboardDistDir?: string;
  projectBindingWorkspaceStore?: ProjectBindingWorkspaceStore;
  currentHostLogState?: CurrentHostLogStateOwner;
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

export type CloseCapletsSessionsOptions = {
  activeRequestGraceMs?: number;
};

export type CapletsHttpApp = Hono & {
  closeCapletsSessions: (options?: CloseCapletsSessionsOptions) => Promise<void>;
};

type AttachEventStream = {
  close: () => void;
};

type AttachSessionRecord = {
  session: HttpAttachSession;
  lastUsedAt: number;
};

type ProjectBindingHttpRecord = {
  ownerKey: string;
  sessionId: string;
  bindingId: string;
  projectRoot: string;
  projectFingerprint: string;
  serverWorkspaceFingerprint: string;
  serverProjectRoot: string;
  state: ProjectBindingState;
  syncState: ProjectBindingSyncState;
  updatedAt: string;
  expiresAt: string;
  active: boolean;
  generation: number;
  authoritativeGeneration?: number | undefined;
  mutationTail: Promise<void>;
  terminal: boolean;
  ownerlessCleanup: Promise<boolean> | undefined;
  heartbeatInFlight: Promise<boolean> | undefined;
  pendingHeartbeat:
    | {
        message: Extract<ProjectBindingSocketClientMessage, { type: "heartbeat" }>;
        ownerKey: string;
        promise: Promise<boolean>;
        resolve: (value: boolean) => void;
        reject: (reason?: unknown) => void;
      }
    | undefined;
};

type AttachEventSource = {
  manifestRevision: () => Promise<string>;
  onManifestChanged: (listener: () => void) => () => void;
};

const ATTACH_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ATTACH_SESSION_PRUNE_INTERVAL_MS = 60_000;
const BACKEND_AUTH_FLOW_MAINTENANCE_INTERVAL_MS = 60_000;
const IDEMPOTENCY_MAINTENANCE_INTERVAL_MS = 60_000;
const PROJECT_BINDING_LEASE_TTL_MS = 60_000;
export const PROJECT_BINDING_STATE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HTTP_ACTIVE_REQUEST_GRACE_MS = 30_000;
const MAX_HTTP_ACTIVE_REQUEST_GRACE_MS = 5 * 60_000;
export const AUTH_REQUEST_MAX_BYTES = 64 * 1024;
export const CONTROL_REQUEST_MAX_BYTES = 1024 * 1024;
export const ATTACH_INVOKE_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const WELL_KNOWN_CAPLETS_JSON =
  '{"schemaVersion":1,"links":{"api":"/api","openapi":"/api/openapi.json","mcp":"/mcp","dashboard":"/dashboard"}}\n';
const WELL_KNOWN_CAPLETS_BYTES = new TextEncoder().encode(WELL_KNOWN_CAPLETS_JSON);
const WELL_KNOWN_CAPLETS_ETAG = createStrongEtag("well-known-caplets", WELL_KNOWN_CAPLETS_BYTES);

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
  const projectBindingSessions = new Map<string, ProjectBindingHttpRecord>();
  let projectBindingSessionsClosing = false;
  let httpRequestsClosing = false;
  let projectBindingWorkspaceCleanup: Promise<unknown> | undefined;
  let activeRequestCount = 0;
  let resolveActiveRequestsDrained: (() => void) | undefined;
  let activeRequestsDrained: Promise<void> | undefined;
  const attachEventStreams = new Set<AttachEventStream>();
  const attachSessionPruneTimer = setInterval(() => {
    pruneIdleAttachSessions();
    pruneExpiredProjectBindingSessions();
  }, ATTACH_SESSION_PRUNE_INTERVAL_MS);
  attachSessionPruneTimer.unref?.();
  const writeErr = io.writeErr ?? process.stderr.write.bind(process.stderr);
  const canonicalBaseUrl = canonicalServePathUrl(options, "/");
  const canonicalAdminV2Url = canonicalServePathUrl(options, CURRENT_HOST_PATHS.admin);
  const adminV2Host: AdminV2HostContext = {
    baseUrl: canonicalBaseUrl,
    dashboardUrl: canonicalServePathUrl(options, CURRENT_HOST_NAMESPACES.dashboard),
    dashboardPath: CURRENT_HOST_NAMESPACES.dashboard,
    bind: `${options.host}:${options.port}`,
    publicOrigin: new URL(canonicalBaseUrl).origin,
  };
  const bundleUploadAdmission = new AdminBundleUploadAdmissionController({
    stagingDir: options.adminUploads.stagingDir,
    maxConcurrent: options.adminUploads.maxConcurrent,
    maxStagedBytes: options.adminUploads.maxStagedBytes,
  });
  const stackIdentity = httpStackIdentity(options);
  const exposeAttach = io.exposeAttach ?? true;
  const exposeAttachSessions = exposeAttach && Boolean(io.attachSessionFactory);
  const authoritativeStorage =
    io.authoritativeStorage ??
    (typeof engine.authoritativeStorage === "function" ? engine.authoritativeStorage() : undefined);
  const remoteCredentialStore =
    options.auth.type === "remote_credentials"
      ? (io.remoteCredentialStore ?? authoritativeStorage?.remoteSecurity)
      : undefined;
  const backendAuthStore = io.backendAuthStore ?? authoritativeStorage?.backendAuth;
  const backendAuthFlows = io.backendAuthFlows ?? authoritativeStorage?.backendAuthFlows;
  let backendAuthFlowMaintenance: Promise<void> | undefined;
  const backendAuthFlowMaintenanceTimer = backendAuthFlows
    ? setInterval(maintainBackendAuthFlows, BACKEND_AUTH_FLOW_MAINTENANCE_INTERVAL_MS)
    : undefined;
  backendAuthFlowMaintenanceTimer?.unref?.();
  maintainBackendAuthFlows();
  const idempotency = authoritativeStorage?.idempotency;
  let idempotencyMaintenance: Promise<void> | undefined;
  const idempotencyMaintenanceTimer = idempotency
    ? setInterval(maintainIdempotencyRecords, IDEMPOTENCY_MAINTENANCE_INTERVAL_MS)
    : undefined;
  idempotencyMaintenanceTimer?.unref?.();
  maintainIdempotencyRecords();
  const projectBindingRepository = authoritativeStorage?.projectBindings;
  const hostNodeId =
    typeof engine.hostNodeIdentity === "function" ? engine.hostNodeIdentity() : undefined;
  const dashboardSessionStore =
    io.dashboardSessionStore ??
    (authoritativeStorage && remoteCredentialStore
      ? new DashboardSessionStore({
          repository: authoritativeStorage.dashboardSessions,
          validateOperatorClient: async (clientId) => {
            const client = await remoteClientById(remoteCredentialStore, clientId);
            return (
              client !== undefined && client.role === "operator" && client.revokedAt === undefined
            );
          },
        })
      : undefined);
  const dashboardActivityLog =
    authoritativeStorage?.operatorActivity ??
    new DashboardActivityLog({ dir: options.remoteCredentialStateDir ?? "." });
  const activateCommittedConfig = async (): Promise<void> => {
    if (!(await engine.reload())) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Committed host configuration could not be activated on this Host Node.",
      );
    }
  };
  const projectBindingStateListeners = new Set<() => void>();
  const emitProjectBindingStateChanged = (): void => {
    for (const listener of projectBindingStateListeners) listener();
  };
  let projectBindingStatePollTimer: NodeJS.Timeout | undefined;
  let projectBindingStatePollInFlight: Promise<void> | undefined;
  let projectBindingStatePollPending = false;
  let projectBindingStatePollGeneration = 0;
  let lastPolledProjectBindingActive: boolean | undefined;
  const pollProjectBindingState = (): void => {
    if (!projectBindingRepository || projectBindingStateListeners.size === 0) return;
    projectBindingStatePollPending = true;
    if (projectBindingStatePollInFlight) return;
    const generation = projectBindingStatePollGeneration;
    projectBindingStatePollInFlight = (async () => {
      while (
        projectBindingStatePollPending &&
        generation === projectBindingStatePollGeneration &&
        projectBindingStateListeners.size > 0
      ) {
        projectBindingStatePollPending = false;
        let active: boolean;
        try {
          active = await projectBindingRepository.existsActive(new Date());
        } catch {
          if (
            generation === projectBindingStatePollGeneration &&
            projectBindingStateListeners.size > 0
          ) {
            emitProjectBindingStateChanged();
          }
          return;
        }
        if (
          generation !== projectBindingStatePollGeneration ||
          projectBindingStateListeners.size === 0
        ) {
          return;
        }
        if (
          lastPolledProjectBindingActive === undefined ||
          lastPolledProjectBindingActive !== active
        ) {
          lastPolledProjectBindingActive = active;
          emitProjectBindingStateChanged();
        }
      }
    })().finally(() => {
      projectBindingStatePollInFlight = undefined;
      if (projectBindingStatePollPending && projectBindingStateListeners.size > 0) {
        pollProjectBindingState();
      }
    });
  };
  const startProjectBindingStatePolling = (): void => {
    if (!projectBindingRepository || projectBindingStatePollTimer) return;
    projectBindingStatePollGeneration += 1;
    lastPolledProjectBindingActive = undefined;
    projectBindingStatePollTimer = setInterval(
      pollProjectBindingState,
      PROJECT_BINDING_STATE_POLL_INTERVAL_MS,
    );
    projectBindingStatePollTimer.unref?.();
    pollProjectBindingState();
  };
  const stopProjectBindingStatePolling = (): void => {
    projectBindingStatePollGeneration += 1;
    projectBindingStatePollPending = false;
    lastPolledProjectBindingActive = undefined;
    clearInterval(projectBindingStatePollTimer);
    projectBindingStatePollTimer = undefined;
  };
  const currentHostRuntimeState: CurrentHostRuntimeStateOwner = {
    read: async () => {
      const readiness = await engine.readiness();
      if (readiness.ready) return { status: "ok" };
      return {
        status: "error",
        ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
      };
    },
    subscribe: (listener) => engine.onReload(() => listener()),
  };
  const currentHostProjectBindingState: CurrentHostProjectBindingStateOwner = {
    read: async () => {
      let connected: boolean;
      try {
        const now = new Date();
        if (projectBindingRepository) {
          connected = await projectBindingRepository.existsActive(now);
        } else {
          connected = [...projectBindingSessions.values()].some(
            (binding) =>
              binding.active && !binding.terminal && Date.parse(binding.expiresAt) > now.getTime(),
          );
        }
      } catch {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Authoritative Project Binding state is unavailable.",
        );
      }
      return {
        state: connected ? "connected" : "disconnected",
        affectedCaplets: engine
          .enabledServers()
          .filter((caplet) => caplet.projectBinding?.required === true)
          .map((caplet) => caplet.server)
          .sort(),
        actions: [
          {
            id: "attach-project",
            label: "Attach project from a client",
            enabled: false,
            reason: "Project Binding sessions are started by Access Clients.",
          },
        ],
      };
    },
    subscribe(listener) {
      projectBindingStateListeners.add(listener);
      startProjectBindingStatePolling();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        projectBindingStateListeners.delete(listener);
        if (projectBindingStateListeners.size === 0) stopProjectBindingStatePolling();
      };
    },
  };
  const currentHostOperations = createCurrentHostOperations({
    engine,
    ...(io.control === undefined
      ? {}
      : {
          control: {
            configPath: io.control.configPath,
            projectConfigPath: io.control.projectConfigPath,
            authDir: io.control.authDir,
            globalCapletsRoot: io.control.globalCapletsRoot,
            globalLockfilePath: io.control.globalLockfilePath,
          },
        }),
    activityLog: dashboardActivityLog,
    runtimeState: currentHostRuntimeState,
    ...(io.currentHostLogState === undefined ? {} : { logState: io.currentHostLogState }),
    projectBindingState: currentHostProjectBindingState,
    capletRecords: authoritativeStorage?.caplets,
    capletInstallations: authoritativeStorage?.installations,
    catalogStorage: authoritativeStorage,
    backendAuthStore,
    backendAuthFlows,
    backendAuthCallbackBaseUrl: canonicalAdminV2Url,
    ...(authoritativeStorage
      ? {
          activateConfig: activateCommittedConfig,
          invalidateConfig: async (operatorClientId: string) => {
            await authoritativeStorage.invalidateConfig(operatorClientId);
            await activateCommittedConfig();
          },
        }
      : {}),
    remoteCredentialStore,
    vaultGrants: authoritativeStorage?.vaultGrants,
    vaultValues: authoritativeStorage?.vaultValues,
    vaultState: authoritativeStorage?.vaultState,
    version: packageJsonVersion,
  });
  const authenticatedRemoteClients = new WeakMap<Request, ValidatedRemoteClient>();
  const retainAuthenticatedRemoteClient = (request: Request, client: ValidatedRemoteClient) => {
    authenticatedRemoteClients.set(request, client);
  };
  const projectBindingWorkspaceStore =
    io.projectBindingWorkspaceStore ?? new ProjectBindingWorkspaceStore();
  pruneProjectBindingWorkspaces();
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
  const authenticatedClientRouteAuth = routeAuth(
    options,
    remoteCredentialStore,
    undefined,
    retainAuthenticatedRemoteClient,
  );
  const accessRouteAuth = routeAuth(
    options,
    remoteCredentialStore,
    "access",
    retainAuthenticatedRemoteClient,
  );
  const attachHostProtection = dnsRebindingProtection(options);
  app.use(
    "*",
    logger((message, ...rest) => {
      writeErr(`${[message, ...rest].join(" ")}\n`);
    }),
  );
  app.use("*", async (context, next) => {
    if (httpRequestsClosing) {
      context.header("connection", "close");
      return context.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
    }
    activeRequestCount += 1;
    try {
      await next();
    } finally {
      activeRequestCount -= 1;
      if (activeRequestCount === 0) {
        const resolve = resolveActiveRequestsDrained;
        activeRequestsDrained = undefined;
        resolveActiveRequestsDrained = undefined;
        resolve?.();
      }
    }
  });
  app.use("*", async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    const allow = registeredAllowHeader(app, pathname, io.dashboardDistDir);
    if (allow && !allow.split(", ").includes(context.req.method)) {
      return context.json({ error: "method_not_allowed" }, 405, {
        Allow: allow,
        "Cache-Control": "no-store",
      });
    }
    await next();
  });
  const adminV2AuthorityProvider: AdminV2AuthorityProvider = async (request, context) => {
    const requestHeader = (name: string) => request.headers.get(name) ?? undefined;
    const mode = adminV2CredentialMode(request);
    const hostUrl = remoteCredentialHostUrl(request.url, options, requestHeader);

    if (mode === "bearer") {
      const token = bearerToken(request.headers.get("authorization") ?? "");
      if (!remoteCredentialStore || !token) {
        throw new AdminV2PrincipalError(401, "A valid Operator Client credential is required.");
      }
      let client: ValidatedRemoteClient;
      try {
        client = await remoteCredentialStore.validateAccessToken({
          hostUrl,
          accessToken: token,
        });
      } catch {
        throw new AdminV2PrincipalError(401, "A valid Operator Client credential is required.");
      }
      if (client.role !== "operator") {
        throw new AdminV2PrincipalError(403, "An Operator Client is required.");
      }
      return {
        principal: {
          clientId: client.clientId,
          clientLabel: client.clientLabel,
          hostUrl: client.hostUrl,
          role: "operator",
        },
      };
    }

    if (mode === "dashboard_session") {
      const validated = await validateDashboardSession(
        request.headers.get("cookie") ?? undefined,
        {
          requireCsrf: context.mutates,
          csrfToken: request.headers.get("x-caplets-csrf") ?? undefined,
        },
        request,
      );
      if (!validated.ok) {
        if (validated.response.status === 503) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Dashboard session validation is unavailable.",
          );
        }
        const status = validated.response.status === 403 ? 403 : 401;
        throw new AdminV2PrincipalError(
          status,
          status === 403
            ? "A current dashboard CSRF token is required."
            : "A current Operator dashboard session is required.",
        );
      }
      const principal =
        validated.session.operatorClientId === "development_unauthenticated"
          ? trustedDevelopmentOperatorPrincipal(hostUrl)
          : {
              clientId: validated.session.operatorClientId,
              hostUrl,
              role: "operator" as const,
            };
      return {
        principal,
        finalizeMutation: async ({ outcome }) => {
          if (outcome.sessionEnded !== true) return undefined;
          try {
            await dashboardSessionStore?.delete(request.headers.get("cookie") ?? undefined);
          } catch {
            try {
              writeErr("Could not remove an ended dashboard session.\n");
            } catch {
              // Cleanup reporting must not replace a committed Admin mutation response.
            }
          }
          const headers = new Headers();
          headers.append("Set-Cookie", expiredDashboardSessionCookie("/"));
          headers.append(
            "Set-Cookie",
            expiredDashboardSessionCookie(CURRENT_HOST_NAMESPACES.dashboard),
          );
          return headers;
        },
      };
    }

    if (options.auth.type === "development_unauthenticated") {
      if (!isVerifiedLoopbackDevelopmentRequest(options, request.url, requestHeader)) {
        throw new AdminV2PrincipalError(
          403,
          "Current Host development administration requires verified loopback access.",
        );
      }
      return { principal: trustedDevelopmentOperatorPrincipal(hostUrl) };
    }

    throw new AdminV2PrincipalError(401, "A valid Operator Client credential is required.");
  };

  app.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    return c.redirect(CURRENT_HOST_NAMESPACES.dashboard, 302);
  });

  app.get(CURRENT_HOST_NAMESPACES.wellKnown, (c) => {
    const headers = {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "application/json; charset=utf-8",
      etag: WELL_KNOWN_CAPLETS_ETAG,
    };
    if (ifNoneMatchIncludes(c.req.header("if-none-match"), WELL_KNOWN_CAPLETS_ETAG)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(WELL_KNOWN_CAPLETS_BYTES, { status: 200, headers });
  });

  app.get(CURRENT_HOST_NAMESPACES.api, (c) =>
    c.json(
      {
        name: "caplets",
        protocol: "caplets-http",
        schemaVersion: 1,
        links: {
          self: CURRENT_HOST_NAMESPACES.api,
          openapi: CURRENT_HOST_PATHS.openApi,
          v1: CURRENT_HOST_PATHS.apiV1,
          admin: currentHostAdminPath("/host"),
        },
      },
      200,
      { "cache-control": "no-store" },
    ),
  );

  app.get(CURRENT_HOST_PATHS.openApi, (c) => {
    const representation = rootOpenApiRepresentation();
    const headers = {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "application/vnd.oai.openapi+json;version=3.1",
      etag: representation.etag,
    };
    if (ifNoneMatchIncludes(c.req.header("if-none-match"), representation.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(representation.bytes, { status: 200, headers });
  });

  app.get(CURRENT_HOST_PATHS.apiV1, (c) =>
    c.json(versionDiscovery({ exposeAttach, exposeAttachSessions }), 200, {
      "cache-control": "no-store",
    }),
  );

  app.get(CURRENT_HOST_PATHS.health, async (c) => {
    const readiness = await engine.readiness();
    return c.json(
      {
        status: readiness.ready ? "ok" : "unavailable",
        ...readiness,
      },
      readiness.ready ? 200 : 503,
    );
  });

  app.get(
    CURRENT_HOST_ROUTE_PATTERNS.dashboardAssets,
    (c) =>
      dashboardStaticResponse(new URL(c.req.url).pathname, io.dashboardDistDir) ?? c.notFound(),
  );

  app.get(CURRENT_HOST_NAMESPACES.dashboard, (c) => {
    const response = dashboardStaticResponse(new URL(c.req.url).pathname, io.dashboardDistDir);
    if (response) return response;
    return c.html(dashboardShell(), 200, { "cache-control": "no-store" });
  });

  app.post(CURRENT_HOST_DASHBOARD_PATHS.loginStart, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard login start request",
        AUTH_REQUEST_MAX_BYTES,
      );
      const clientLabel = optionalStringField(parsed, "clientLabel") ?? "Caplets Dashboard";
      const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
      const hostUrl = remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name));
      const pending = await remoteCredentialStore.createPendingLogin({
        hostUrl,
        hostIdentity: hostUrl,
        requestedRole: "operator",
        clientLabel,
        ...remoteCredentialSourceHint(options.trustProxy, (name) => c.req.header(name)),
        ...(clientFingerprint ? { clientFingerprint } : {}),
      });
      return c.json({
        ...pending,
        requestedRole: "operator",
        approvalCommand: pendingLoginApprovalCommand(
          pending.operatorCode,
          remoteCredentialStatePath(remoteCredentialStore),
        ),
      });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(CURRENT_HOST_DASHBOARD_PATHS.loginPoll, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard login poll request",
        AUTH_REQUEST_MAX_BYTES,
      );
      return c.json(
        await remoteCredentialStore.pollPendingLogin({
          flowId: stringField(parsed, "flowId"),
          pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
        }),
      );
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(CURRENT_HOST_DASHBOARD_PATHS.loginComplete, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard login complete request",
        AUTH_REQUEST_MAX_BYTES,
      );
      const credentials = await remoteCredentialStore.completePendingLogin({
        hostUrl: remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name)),
        requiredRole: "operator",
        flowId: stringField(parsed, "flowId"),
        pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
      });
      if (!dashboardSessionStore) {
        return c.json({ error: "dashboard_auth_unavailable" }, 503);
      }
      const created = await dashboardSessionStore.create({
        operatorClientId: credentials.clientId,
      });
      await dashboardActivityLog.append({
        actorClientId: credentials.clientId,
        action: "dashboard_login_completed",
        target: { type: "dashboard_session", id: created.session.sessionId },
      });
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      headers.append(
        "Set-Cookie",
        dashboardSessionCookie(created.cookieValue, {
          secure: requestIsSecure(c.req.url, options, (name) => c.req.header(name)),
        }),
      );
      headers.append(
        "Set-Cookie",
        expiredDashboardSessionCookie(CURRENT_HOST_NAMESPACES.dashboard),
      );
      return new Response(JSON.stringify({ authenticated: true, session: created.session }), {
        status: 200,
        headers,
      });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(CURRENT_HOST_DASHBOARD_PATHS.session, async (c) => {
    const session = await dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    const parsed = parseDashboardCookie(c.req.header("cookie"));
    if (parsed) {
      headers.append(
        "Set-Cookie",
        dashboardSessionCookie(`${parsed.sessionId}.${parsed.secret}`, {
          secure: requestIsSecure(c.req.url, options, (name) => c.req.header(name)),
        }),
      );
      headers.append(
        "Set-Cookie",
        expiredDashboardSessionCookie(CURRENT_HOST_NAMESPACES.dashboard),
      );
    }
    return new Response(JSON.stringify({ authenticated: true, session: session.session }), {
      status: 200,
      headers,
    });
  });

  app.get(CURRENT_HOST_ROUTE_PATTERNS.adminBackendAuthCallback, async (c) => {
    const flowId = requiredRouteParam(c.req.param("flowId"));
    try {
      const outcome = await currentHostOperations.execute(
        { role: "backend_auth_callback", flowId },
        {
          kind: "backend_auth_flow_callback_complete",
          flowId,
          callbackUrl: c.req.url,
        },
      );
      return new Response(
        JSON.stringify({
          server: outcome.server,
          authenticated: outcome.authenticated,
        }),
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        },
      );
    } catch (error) {
      const response = problemResponse(error);
      const problem = (await response.json()) as Record<string, unknown>;
      problem.detail = "Backend authentication callback failed.";
      return new Response(JSON.stringify(problem), {
        status: response.status,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      });
    }
  });

  app.route(
    CURRENT_HOST_PATHS.admin,
    createAdminV2Router({
      operations: currentHostOperations,
      authorityProvider: adminV2AuthorityProvider,
      host: adminV2Host,
      idempotencyStore: idempotency,
      bundleUploadAdmission,
    }),
  );

  app.post(CURRENT_HOST_DASHBOARD_PATHS.vaultReveals, async (c) => {
    c.header("Cache-Control", "no-store");
    const session = await dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard Vault reveal request",
        CONTROL_REQUEST_MAX_BYTES,
      );
      const key = stringField(parsed, "key");
      if (stringField(parsed, "confirmation") !== `reveal ${key}`) {
        throw new CapletsError("REQUEST_INVALID", "Vault reveal confirmation is invalid.");
      }
      const value = authoritativeStorage
        ? await authoritativeStorage.vaultValues.resolveValue(key)
        : vaultStoreForAuthDir(io.control?.authDir).resolveValue(key);
      await dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_value_revealed",
        target: { type: "vault", id: key },
        metadata: { confirmed: true },
      });
      return c.json({ key, value }, 200, { "cache-control": "no-store" });
    } catch (error) {
      const response = currentHostErrorResponse(error);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  });

  app.post(CURRENT_HOST_DASHBOARD_PATHS.logout, async (c) => {
    const session = await dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    await dashboardActivityLog.append({
      actorClientId: session.session.operatorClientId,
      action: "dashboard_logout",
      target: { type: "dashboard_session", id: session.session.sessionId },
    });
    await dashboardSessionStore?.delete(c.req.header("cookie"));
    const headers = new Headers({
      "Content-Type": "application/json",
    });
    headers.append("Set-Cookie", expiredDashboardSessionCookie("/"));
    headers.append("Set-Cookie", expiredDashboardSessionCookie(CURRENT_HOST_NAMESPACES.dashboard));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  });

  app.get(
    CURRENT_HOST_ROUTE_PATTERNS.dashboardPages,
    (c) =>
      dashboardStaticResponse(new URL(c.req.url).pathname, io.dashboardDistDir) ?? c.notFound(),
  );

  if (remoteCredentialStore) {
    app.post(currentHostV1Path("remoteLoginStart"), attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login start request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const clientLabel = optionalStringField(parsed, "clientLabel");
        const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
        const hostUrl = remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name));
        const pending = await remoteCredentialStore.createPendingLogin({
          hostUrl,
          hostIdentity: hostUrl,
          ...(clientLabel ? { clientLabel } : {}),
          ...remoteCredentialSourceHint(options.trustProxy, (name) => c.req.header(name)),
          ...(clientFingerprint ? { clientFingerprint } : {}),
        });
        return c.json({
          ...pending,
          approvalCommand: pendingLoginApprovalCommand(
            pending.operatorCode,
            remoteCredentialStatePath(remoteCredentialStore),
          ),
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(currentHostV1Path("remoteLoginPoll"), attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login poll request",
          AUTH_REQUEST_MAX_BYTES,
        );
        return c.json(
          await remoteCredentialStore.pollPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(currentHostV1Path("remoteLoginRefresh"), attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login refresh request",
          AUTH_REQUEST_MAX_BYTES,
        );
        return c.json(
          await remoteCredentialStore.refreshPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingRefreshSecret: stringField(parsed, "pendingRefreshSecret"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(currentHostV1Path("remoteLoginComplete"), attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login complete request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const credentials = await remoteCredentialStore.completePendingLogin({
          hostUrl: remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name)),
          flowId: stringField(parsed, "flowId"),
          pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
        });
        return c.json(credentials);
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(currentHostV1Path("remoteLoginCancel"), attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login cancel request",
          AUTH_REQUEST_MAX_BYTES,
        );
        return c.json(
          await remoteCredentialStore.cancelPendingLogin({
            flowId: stringField(parsed, "flowId"),
            pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
          }),
        );
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.post(currentHostV1Path("remoteRefresh"), async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Remote refresh request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const refreshToken = stringField(parsed, "refreshToken");
        const credentials = await remoteCredentialStore.refreshClientCredentials({
          hostUrl: remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name)),
          refreshToken,
        });
        return c.json({
          clientId: credentials.clientId,
          clientLabel: credentials.clientLabel,
          role: credentials.role,
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          tokenType: credentials.tokenType,
          expiresAt: credentials.expiresAt,
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });

    app.delete(currentHostV1Path("remoteClient"), authenticatedClientRouteAuth, async (c) => {
      const client = authenticatedRemoteClients.get(c.req.raw);
      if (!client) return c.text("Unauthorized", 401);
      try {
        return c.json({
          revoked:
            remoteCredentialStore instanceof RemoteServerCredentialStore
              ? remoteCredentialStore.revokeClient(client.clientId)
              : await remoteCredentialStore.revokeClient({
                  operatorClientId: client.clientId,
                  clientId: client.clientId,
                }),
          clientId: client.clientId,
        });
      } catch (error) {
        return remoteCredentialErrorResponse(error);
      }
    });
  }

  app.on(["POST", "GET", "DELETE"], CURRENT_HOST_NAMESPACES.mcp, accessRouteAuth, async (c) => {
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
      const response = await existing.transport.handleRequest(c);
      return process.versions.bun && c.req.method === "GET"
        ? prependEventStreamPreamble(response)
        : response;
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
    let retained = false;
    try {
      const response = await session.transport.handleRequest(c);
      if (session.transport.sessionId === nextSessionId) {
        sessions.set(nextSessionId, session);
        retained = true;
      }
      return response;
    } finally {
      if (!retained) {
        await session.server.close();
      }
    }
  });

  if (exposeAttach) {
    if (io.attachSessionFactory) {
      app.post(
        currentHostV1Path("attachSessions"),
        attachHostProtection,
        accessRouteAuth,
        async (c) => {
          try {
            const parsed = await readLimitedJsonObject(
              c.req.raw,
              "Attach session request",
              CONTROL_REQUEST_MAX_BYTES,
            );
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
        },
      );

      app.delete(
        CURRENT_HOST_ROUTE_PATTERNS.attachSession,
        attachHostProtection,
        accessRouteAuth,
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

    app.get(
      currentHostV1Path("attachManifest"),
      attachHostProtection,
      accessRouteAuth,
      async (c) => {
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
      },
    );

    app.get(currentHostV1Path("attachEvents"), attachHostProtection, accessRouteAuth, async (c) => {
      try {
        const attachSessionId = c.req.header(CAPLETS_ATTACH_SESSION_HEADER);
        const attachSession = attachSessionId
          ? attachSessionForRequest(attachSessionId)
          : await fallbackAttachSession(
              attachSessionContext(c.req.header(CAPLETS_STACK_CHAIN_HEADER)),
            );
        if (c.req.method === "HEAD") {
          return new Response(null, { status: 200, headers: attachEventsHeaders() });
        }
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

    app.post(
      currentHostV1Path("attachInvoke"),
      attachHostProtection,
      accessRouteAuth,
      async (c) => {
        try {
          const request = parseAttachInvokeRequest(
            await readLimitedJsonObject(
              c.req.raw,
              "Attach invoke request",
              ATTACH_INVOKE_REQUEST_MAX_BYTES,
            ),
          );
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
      },
    );
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

  function maintainBackendAuthFlows(): void {
    if (!backendAuthFlows || backendAuthFlowMaintenance) return;
    const maintenance = backendAuthFlows.expireDue().then(async () => {
      await backendAuthFlows.prune();
    });
    backendAuthFlowMaintenance = maintenance;
    void maintenance.then(
      () => {
        if (backendAuthFlowMaintenance === maintenance) {
          backendAuthFlowMaintenance = undefined;
        }
      },
      (error) => {
        if (backendAuthFlowMaintenance === maintenance) {
          backendAuthFlowMaintenance = undefined;
        }
        writeErr(`Could not maintain backend OAuth flows: ${errorMessage(error)}\n`);
      },
    );
  }

  function maintainIdempotencyRecords(): void {
    if (!idempotency || idempotencyMaintenance) return;
    const maintenance = idempotency.prune().then(() => undefined);
    idempotencyMaintenance = maintenance;
    void maintenance.then(
      () => {
        if (idempotencyMaintenance === maintenance) {
          idempotencyMaintenance = undefined;
        }
      },
      (error) => {
        if (idempotencyMaintenance === maintenance) {
          idempotencyMaintenance = undefined;
        }
        writeErr(`Could not maintain Admin idempotency records: ${errorMessage(error)}\n`);
      },
    );
  }

  function pruneProjectBindingWorkspaces(): void {
    if (projectBindingWorkspaceCleanup) return;
    const cleanup = projectBindingWorkspaceStore.cleanup();
    projectBindingWorkspaceCleanup = cleanup;
    void cleanup.then(
      () => {
        if (projectBindingWorkspaceCleanup === cleanup) {
          projectBindingWorkspaceCleanup = undefined;
        }
      },
      (error) => {
        if (projectBindingWorkspaceCleanup === cleanup) {
          projectBindingWorkspaceCleanup = undefined;
        }
        writeErr(`Could not prune Project Binding workspaces: ${errorMessage(error)}\n`);
      },
    );
  }

  function pruneExpiredProjectBindingSessions(): void {
    pruneProjectBindingWorkspaces();
    const now = Date.now();
    for (const record of projectBindingSessions.values()) {
      if (!record.terminal && record.active && Date.parse(record.expiresAt) > now) continue;
      void endProjectBindingRecord(record).catch((error) => {
        writeErr(`Could not prune Project Binding session: ${errorMessage(error)}\n`);
      });
    }
  }

  app.get(
    currentHostV1Path("projectBindingConnect"),
    accessRouteAuth,
    async (c, next) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return c.json({ error: "websocket_upgrade_required" }, 426);
      }
      const validation = projectBindingSocketRecordForRequest(c);
      if (!validation.ok) return validation.response;
      return next();
    },
    upgradeProjectBindingWebSocket((c) => {
      const validation = projectBindingSocketRecordForRequest(c);
      let socketAttached = false;
      return {
        onOpen: (_event, ws) => {
          if (!validation.ok) {
            ws.close(1008, "Project Binding session was not found.");
            return;
          }
          socketAttached = true;
          sendProjectBindingReadyWhenOpen(ws, validation.record, () => socketAttached);
        },
        onMessage: (event, ws) => {
          if (!validation.ok) {
            ws.close(1008, "Project Binding session was not found.");
            return;
          }
          void parseProjectBindingSocketClientMessage(event.data)
            .then(async (message) => {
              if (
                message.bindingId !== validation.record.bindingId ||
                message.sessionId !== validation.record.sessionId
              ) {
                if (socketAttached) {
                  ws.close(1008, "Project Binding message does not match this session.");
                }
                return;
              }
              if (message.type === "heartbeat") {
                const updated = await updateProjectBindingHeartbeat(
                  validation.record,
                  message,
                  validation.durableClientId,
                );
                if (!updated && socketAttached) {
                  ws.close(1008, "Project Binding session is no longer authorized.");
                }
                return;
              }
              const ended = await endProjectBindingRecord(
                validation.record,
                validation.durableClientId,
                message.reason,
              );
              if (!ended) {
                if (socketAttached) {
                  ws.close(1008, "Project Binding session is no longer authorized.");
                }
                return;
              }
              if (socketAttached) {
                ws.send(JSON.stringify({ type: "ended", reason: message.reason }));
                ws.close(1000, message.reason.message);
              }
            })
            .catch((error) => {
              if (error instanceof CapletsError && error.code === "REQUEST_INVALID") {
                if (socketAttached) {
                  ws.close(1008, "Project Binding message is invalid.");
                }
                return;
              }
              writeErr(`Project Binding WebSocket message failed: ${errorMessage(error)}\n`);
              if (socketAttached) ws.close(1011, "Project Binding message failed.");
            });
        },
        onError: (event) => {
          writeErr(`Project Binding WebSocket error: ${errorMessage(event)}\n`);
        },
        onClose: () => {
          socketAttached = false;
        },
      };
    }),
  );

  app.get(
    CURRENT_HOST_ROUTE_PATTERNS.projectBindingStatus,
    accessRouteAuth,
    async (c) =>
      await projectBindingStatusResponse(
        requiredRouteParam(c.req.param("bindingId")),
        projectBindingOwnerKey(c),
      ),
  );

  app.post(currentHostV1Path("projectBindingSessions"), accessRouteAuth, async (c) => {
    try {
      if (projectBindingSessionsClosing) {
        return c.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
      }
      const request = projectBindingSessionCreateRequestSchema.safeParse(
        await readLimitedJsonObject(
          c.req.raw,
          "Project Binding session request",
          CONTROL_REQUEST_MAX_BYTES,
        ),
      );
      if (!request.success) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Project Binding session request must contain exactly projectRoot and projectFingerprint.",
          request.error.issues,
        );
      }
      const { projectRoot, projectFingerprint } = request.data;
      const ownerKey = projectBindingOwnerKey(c);
      const serverWorkspaceFingerprint = projectBindingWorkspaceFingerprint(
        ownerKey,
        projectFingerprint,
      );
      const bindingId = `binding_${randomUUID()}`;
      const sessionId = `session_${randomUUID()}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PROJECT_BINDING_LEASE_TTL_MS).toISOString();
      const paths = await projectBindingWorkspaceStore.ensureWorkspace({
        projectFingerprint: serverWorkspaceFingerprint,
        projectRoot,
        lastActiveAt: now.toISOString(),
      });
      if (projectBindingSessionsClosing) {
        return c.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
      }
      const record: ProjectBindingHttpRecord = {
        ownerKey,
        bindingId,
        sessionId,
        projectRoot,
        projectFingerprint,
        serverWorkspaceFingerprint,
        serverProjectRoot: paths.project,
        state: "attaching",
        syncState: "pending",
        updatedAt: now.toISOString(),
        expiresAt,
        active: true,
        generation: 0,
        mutationTail: Promise.resolve(),
        terminal: false,
        ownerlessCleanup: undefined,
        heartbeatInFlight: undefined,
        pendingHeartbeat: undefined,
      };
      if (projectBindingRepository) {
        if (!hostNodeId) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Project Binding requires a registered Host Node identity.",
          );
        }
        const authoritative = await projectBindingRepository.create({
          bindingId,
          sessionId,
          projectFingerprint,
          projectRoot,
          serverProjectRoot: paths.project,
          ownerNodeId: hostNodeId,
          state: record.state,
          syncState: record.syncState,
          leaseTtlMs: PROJECT_BINDING_LEASE_TTL_MS,
        });
        record.authoritativeGeneration = authoritative.generation;
        record.expiresAt = authoritative.expiresAt;
        record.updatedAt = authoritative.updatedAt;
      }
      try {
        await projectBindingWorkspaceStore.writeLease(projectBindingLease(record));
      } catch (error) {
        if (
          projectBindingRepository &&
          hostNodeId &&
          record.authoritativeGeneration !== undefined
        ) {
          await projectBindingRepository.end({
            bindingId,
            ownerNodeId: hostNodeId,
            expectedGeneration: record.authoritativeGeneration,
          });
        }
        throw error;
      }
      projectBindingSessions.set(bindingId, record);
      emitProjectBindingStateChanged();
      if (projectBindingSessionsClosing) {
        await endProjectBindingRecord(record);
        return c.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
      }
      return c.json({ binding: projectBindingResponse(record), sessionId }, 201);
    } catch (error) {
      const safe = toSafeError(
        error,
        error instanceof CapletsError ? error.code : "REQUEST_INVALID",
      );
      return c.json({ ok: false, error: safe }, error instanceof CapletsError ? 400 : 500);
    }
  });

  app.get(CURRENT_HOST_ROUTE_PATTERNS.projectBindingSession, accessRouteAuth, (c) => {
    const record = projectBindingRecordFor(
      requiredRouteParam(c.req.param("bindingId")),
      projectBindingOwnerKey(c),
    );
    if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
    return c.json({
      ok: true,
      binding: projectBindingResponse(record),
      sessionId: record.sessionId,
    });
  });

  app.post(CURRENT_HOST_ROUTE_PATTERNS.projectBindingHeartbeat, accessRouteAuth, async (c) => {
    try {
      const bindingId = requiredRouteParam(c.req.param("bindingId"));
      const ownerKey = projectBindingOwnerKey(c);
      let record = projectBindingRecordFor(bindingId, ownerKey);
      if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
      const request = projectBindingHeartbeatRequestSchema.safeParse(
        await readLimitedJsonObject(
          c.req.raw,
          "Project Binding heartbeat request",
          CONTROL_REQUEST_MAX_BYTES,
        ),
      );
      if (!request.success) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Project Binding heartbeat request must contain exactly sessionId, state, and syncState.",
          request.error.issues,
        );
      }
      const { sessionId, state, syncState } = request.data;
      record = projectBindingRecordFor(bindingId, ownerKey);
      if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
      if (sessionId !== record.sessionId) {
        return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 403);
      }
      const updated = await updateProjectBindingHeartbeat(
        record,
        { type: "heartbeat", bindingId, sessionId, state, syncState },
        ownerKey,
      );
      if (!updated) return c.json({ ok: false, error: { code: "AUTH_FAILED" } }, 403);
      return c.json({ ok: true, binding: projectBindingResponse(record) });
    } catch (error) {
      const safe = toSafeError(
        error,
        error instanceof CapletsError ? error.code : "REQUEST_INVALID",
      );
      return c.json({ ok: false, error: safe }, error instanceof CapletsError ? 400 : 500);
    }
  });

  app.delete(CURRENT_HOST_ROUTE_PATTERNS.projectBindingSession, accessRouteAuth, async (c) => {
    try {
      const bindingId = requiredRouteParam(c.req.param("bindingId"));
      const ownerKey = projectBindingOwnerKey(c);
      const record = projectBindingRecordFor(bindingId, ownerKey);
      if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
      const ended = await endProjectBindingRecord(record, ownerKey);
      if (!ended) return c.json({ ok: false, error: { code: "AUTH_FAILED" } }, 403);
      return c.json({ ok: true, binding: projectBindingResponse(record) });
    } catch (error) {
      const safe = toSafeError(
        error,
        error instanceof CapletsError ? error.code : "REQUEST_INVALID",
      );
      return c.json({ ok: false, error: safe }, error instanceof CapletsError ? 400 : 500);
    }
  });

  function projectBindingSocketRecordForRequest(
    c: Parameters<MiddlewareHandler>[0],
  ):
    | { ok: true; record: ProjectBindingHttpRecord; durableClientId: string }
    | { ok: false; response: Response } {
    const url = new URL(c.req.url);
    const socketProtocols = (c.req.header("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean);
    const queryEntries = [...url.searchParams.entries()];
    const query = projectBindingConnectQuerySchema.safeParse(Object.fromEntries(queryEntries));
    if (
      !projectBindingSocketProtocolSchema.safeParse(socketProtocols[0]).success ||
      !query.success ||
      new Set(queryEntries.map(([key]) => key)).size !== queryEntries.length
    ) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ ok: false, error: { code: "REQUEST_INVALID" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    const { bindingId, sessionId, projectFingerprint } = query.data;
    const durableClientId = projectBindingOwnerKey(c);
    const record = projectBindingRecordFor(bindingId, durableClientId);
    if (!record) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ ok: false, error: { code: "REQUEST_INVALID" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    if (sessionId !== record.sessionId) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ ok: false, error: { code: "REQUEST_INVALID" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    if (projectFingerprint !== record.projectFingerprint) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ ok: false, error: { code: "REQUEST_INVALID" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return { ok: true, record, durableClientId };
  }

  async function updateProjectBindingHeartbeat(
    record: ProjectBindingHttpRecord,
    message: Extract<ProjectBindingSocketClientMessage, { type: "heartbeat" }>,
    ownerKey: string,
  ): Promise<boolean> {
    if (record.heartbeatInFlight) {
      if (record.pendingHeartbeat) {
        record.pendingHeartbeat.message = message;
        record.pendingHeartbeat.ownerKey = ownerKey;
        return await record.pendingHeartbeat.promise;
      }
      const pending = Promise.withResolvers<boolean>();
      record.pendingHeartbeat = {
        message,
        ownerKey,
        promise: pending.promise,
        resolve: pending.resolve,
        reject: pending.reject,
      };
      return await pending.promise;
    }

    const heartbeat = enqueueProjectBindingMutation(record, async () => {
      if (!(await canMutateProjectBindingRecord(record, ownerKey))) {
        await terminalizeProjectBindingRecordInQueue(record);
        return false;
      }

      const generation = record.generation;
      const expiresAt = record.expiresAt;
      const updatedAt = new Date().toISOString();
      const candidate: ProjectBindingHttpRecord = {
        ...record,
        state: message.state,
        syncState: message.syncState,
        updatedAt,
        expiresAt: new Date(Date.parse(updatedAt) + PROJECT_BINDING_LEASE_TTL_MS).toISOString(),
        generation: generation + 1,
      };
      if (projectBindingRepository) {
        if (!hostNodeId || record.authoritativeGeneration === undefined) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Project Binding authoritative ownership is unavailable.",
          );
        }
        const authoritative = await projectBindingRepository.heartbeat({
          bindingId: record.bindingId,
          ownerNodeId: hostNodeId,
          sessionId: record.sessionId,
          expectedGeneration: record.authoritativeGeneration,
          state: candidate.state,
          syncState: candidate.syncState,
          leaseTtlMs: PROJECT_BINDING_LEASE_TTL_MS,
        });
        candidate.authoritativeGeneration = authoritative.generation;
        candidate.expiresAt = authoritative.expiresAt;
        candidate.updatedAt = authoritative.updatedAt;
      }
      try {
        await projectBindingWorkspaceStore.writeLease(projectBindingLease(candidate));
      } catch (error) {
        if (
          projectBindingRepository &&
          hostNodeId &&
          candidate.authoritativeGeneration !== undefined
        ) {
          await projectBindingRepository.quarantineOwnerLoss({
            bindingId: record.bindingId,
            ownerNodeId: hostNodeId,
            expectedGeneration: candidate.authoritativeGeneration,
          });
          emitProjectBindingStateChanged();
        }
        throw error;
      }

      if (!(await canCommitProjectBindingHeartbeat(record, ownerKey, generation, expiresAt))) {
        await terminalizeProjectBindingRecordInQueue(record, candidate);
        return false;
      }

      record.state = candidate.state;
      record.syncState = candidate.syncState;
      record.updatedAt = candidate.updatedAt;
      record.expiresAt = candidate.expiresAt;
      record.generation = candidate.generation;
      record.authoritativeGeneration = candidate.authoritativeGeneration;
      emitProjectBindingStateChanged();
      return true;
    });
    record.heartbeatInFlight = heartbeat;
    void heartbeat.then(
      () => continuePendingProjectBindingHeartbeat(record, heartbeat),
      () => continuePendingProjectBindingHeartbeat(record, heartbeat),
    );
    return await heartbeat;
  }

  function continuePendingProjectBindingHeartbeat(
    record: ProjectBindingHttpRecord,
    completed: Promise<boolean>,
  ): void {
    if (record.heartbeatInFlight !== completed) return;
    record.heartbeatInFlight = undefined;
    const pending = record.pendingHeartbeat;
    record.pendingHeartbeat = undefined;
    if (!pending) return;
    void updateProjectBindingHeartbeat(record, pending.message, pending.ownerKey).then(
      pending.resolve,
      pending.reject,
    );
  }

  function enqueueProjectBindingMutation<T>(
    record: ProjectBindingHttpRecord,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const queued = record.mutationTail.then(mutation, mutation);
    record.mutationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function canMutateProjectBindingRecord(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
  ): Promise<boolean> {
    return (
      !projectBindingSessionsClosing &&
      projectBindingSessions.get(record.bindingId) === record &&
      record.active &&
      !record.terminal &&
      Date.parse(record.expiresAt) > Date.now() &&
      (await isCurrentProjectBindingAccessOwner(record, ownerKey))
    );
  }

  async function canCommitProjectBindingHeartbeat(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
    generation: number,
    expiresAt: string,
  ): Promise<boolean> {
    return (
      (await canMutateProjectBindingRecord(record, ownerKey)) &&
      record.generation === generation &&
      record.expiresAt === expiresAt
    );
  }

  async function isCurrentProjectBindingAccessOwner(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
  ): Promise<boolean> {
    if (record.ownerKey !== ownerKey) return false;
    if (!remoteCredentialStore) return ownerKey === "development_unauthenticated";
    const client = await remoteClientById(remoteCredentialStore, ownerKey);
    return (
      client !== undefined &&
      remoteClientRoleSatisfies(client.role, "access") &&
      client.revokedAt === undefined
    );
  }

  async function terminalizeProjectBindingRecordInQueue(
    record: ProjectBindingHttpRecord,
    candidate?: ProjectBindingHttpRecord,
    removeCurrent = true,
  ): Promise<void> {
    const current = projectBindingSessions.get(record.bindingId) === record;
    const target = current ? record : candidate;
    if (!target) return;
    if (current && !record.terminal && projectBindingRepository) {
      if (!hostNodeId || record.authoritativeGeneration === undefined) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Project Binding authoritative ownership is unavailable.",
        );
      }
      const ended = await projectBindingRepository.end({
        bindingId: record.bindingId,
        ownerNodeId: hostNodeId,
        expectedGeneration: record.authoritativeGeneration,
      });
      record.authoritativeGeneration = ended.generation;
    }
    if (current && !record.terminal) terminalizeProjectBindingRecord(record);
    const terminal = current ? record : terminalProjectBindingCandidate(target);

    emitProjectBindingStateChanged();
    await projectBindingWorkspaceStore.writeLease(projectBindingLease(terminal));
    if (current) {
      if (removeCurrent && projectBindingSessions.get(record.bindingId) === record) {
        projectBindingSessions.delete(record.bindingId);
      }
    }
  }

  function terminalizeProjectBindingRecord(record: ProjectBindingHttpRecord): void {
    record.state = "ended";
    record.syncState = "not_started";
    record.active = false;
    record.updatedAt = new Date().toISOString();
    record.generation += 1;
    record.terminal = true;
  }

  function terminalProjectBindingCandidate(
    record: ProjectBindingHttpRecord,
  ): ProjectBindingHttpRecord {
    const terminal = { ...record };
    terminalizeProjectBindingRecord(terminal);
    return terminal;
  }

  function sendProjectBindingReadyWhenOpen(
    ws: { readyState: number; send: (data: string) => void },
    record: ProjectBindingHttpRecord,
    isAttached: () => boolean,
    attempts = 20,
  ): void {
    setTimeout(() => {
      if (!isAttached()) return;
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "ready",
            bindingId: record.bindingId,
            sessionId: record.sessionId,
            syncState: record.syncState,
          }),
        );
        return;
      }
      if (attempts > 1) {
        sendProjectBindingReadyWhenOpen(ws, record, isAttached, attempts - 1);
      }
    }, 10);
  }

  async function endProjectBindingRecord(
    record: ProjectBindingHttpRecord,
    ownerKey?: string | undefined,
    _reason?: BindingTerminalReason | undefined,
  ): Promise<boolean> {
    if (ownerKey === undefined) {
      if (record.ownerlessCleanup) return await record.ownerlessCleanup;
      if (projectBindingSessions.get(record.bindingId) !== record) return false;
      const cleanup = enqueueProjectBindingMutation(record, async () => {
        if (projectBindingSessions.get(record.bindingId) !== record) return false;
        await terminalizeProjectBindingRecordInQueue(record);
        return true;
      });
      record.ownerlessCleanup = cleanup;
      void cleanup.then(
        () => {
          if (record.ownerlessCleanup === cleanup) record.ownerlessCleanup = undefined;
        },
        () => {
          if (record.ownerlessCleanup === cleanup) record.ownerlessCleanup = undefined;
        },
      );
      return await cleanup;
    }

    return await enqueueProjectBindingMutation(record, async () => {
      const generation = record.generation;
      const expiresAt = record.expiresAt;
      if (!(await canMutateProjectBindingRecord(record, ownerKey))) {
        await terminalizeProjectBindingRecordInQueue(record);
        return false;
      }
      await terminalizeProjectBindingRecordInQueue(record, undefined, false);
      const canAcknowledge =
        !projectBindingSessionsClosing &&
        projectBindingSessions.get(record.bindingId) === record &&
        record.terminal &&
        !record.active &&
        record.generation === generation + 1 &&
        record.expiresAt === expiresAt &&
        Date.parse(expiresAt) > Date.now() &&
        (await isCurrentProjectBindingAccessOwner(record, ownerKey));
      if (projectBindingSessions.get(record.bindingId) === record) {
        projectBindingSessions.delete(record.bindingId);
      }
      return canAcknowledge;
    });
  }

  function projectBindingOwnerKey(c: Parameters<MiddlewareHandler>[0]): string {
    if (!remoteCredentialStore) return "development_unauthenticated";
    const client = authenticatedRemoteClients.get(c.req.raw);
    if (!client) {
      throw new CapletsError("AUTH_FAILED", "Remote client credential is required.");
    }
    return client.clientId;
  }

  function projectBindingRecordFor(
    bindingId: string,
    ownerKey: string,
  ): ProjectBindingHttpRecord | undefined {
    const record = projectBindingSessions.get(bindingId);
    if (!record || record.ownerKey !== ownerKey) return undefined;
    if (
      projectBindingSessionsClosing ||
      record.terminal ||
      !record.active ||
      Date.parse(record.expiresAt) <= Date.now()
    ) {
      void endProjectBindingRecord(record).catch((error) => {
        writeErr(`Could not expire Project Binding session: ${errorMessage(error)}\n`);
      });
      return undefined;
    }
    return record;
  }

  async function projectBindingStatusResponse(
    bindingId: string,
    ownerKey: string,
  ): Promise<Response> {
    const record = projectBindingRecordFor(bindingId, ownerKey);
    if (record) {
      return new Response(JSON.stringify(projectBindingResponse(record)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    let authoritative = await projectBindingRepository?.get(bindingId);
    if (authoritative?.active && Date.parse(authoritative.expiresAt) <= Date.now()) {
      authoritative = await projectBindingRepository!.quarantineOwnerLoss({
        bindingId,
        ownerNodeId: authoritative.ownerNodeId,
        expectedGeneration: authoritative.generation,
      });
    }
    if (authoritative?.active) {
      return new Response(
        JSON.stringify({
          bindingId,
          state: authoritative.state,
          syncState: authoritative.syncState,
          readiness: authoritative.readiness,
          active: true,
          expiresAt: authoritative.expiresAt,
          affinity: {
            ownerNodeId: authoritative.ownerNodeId,
            currentNode: authoritative.ownerNodeId === hostNodeId,
            required: authoritative.ownerNodeId !== hostNodeId,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (authoritative?.readiness === "quarantined") {
      return new Response(
        JSON.stringify({
          bindingId,
          state: authoritative.state,
          syncState: authoritative.syncState,
          readiness: authoritative.readiness,
          active: false,
          requiresOperatorRebind: true,
          ownerNodeId: authoritative.ownerNodeId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ bindingId, state: "not_attached" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function projectBindingResponse(record: ProjectBindingHttpRecord) {
    return {
      bindingId: record.bindingId,
      state: record.state,
      syncState: record.syncState,
      projectFingerprint: record.projectFingerprint,
      serverProjectRoot: record.serverProjectRoot,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    };
  }

  function projectBindingLease(record: ProjectBindingHttpRecord): ProjectBindingLease {
    return {
      bindingId: record.bindingId,
      projectFingerprint: record.serverWorkspaceFingerprint,
      state: record.state,
      active: record.active,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    };
  }

  function projectBindingWorkspaceFingerprint(
    ownerKey: string,
    projectFingerprint: string,
  ): string {
    return `sha256_${createHash("sha256").update(ownerKey).update("\0").update(projectFingerprint).digest("hex")}`;
  }

  async function dashboardSessionForRequest(
    c: Parameters<MiddlewareHandler>[0],
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined } = {},
  ): Promise<{ ok: true; session: DashboardSessionView } | { ok: false; response: Response }> {
    return await validateDashboardSession(c.req.header("cookie"), csrf, c.req.raw);
  }

  async function validateDashboardSession(
    cookieHeader: string | undefined,
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined },
    request: Request,
  ): Promise<{ ok: true; session: DashboardSessionView } | { ok: false; response: Response }> {
    const header = (name: string) => request.headers.get(name) ?? undefined;
    if (
      hasDashboardSessionCookie(cookieHeader) &&
      options.auth.type === "development_unauthenticated"
    ) {
      return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
    }
    if (!remoteCredentialStore && options.auth.type === "development_unauthenticated") {
      if (!isVerifiedLoopbackDevelopmentRequest(options, request.url, header)) {
        return { ok: false, response: new Response("Forbidden", { status: 403 }) };
      }
      if (csrf.requireCsrf && csrf.csrfToken !== "development_unauthenticated") {
        return { ok: false, response: new Response("Forbidden", { status: 403 }) };
      }
      const timestamp = new Date(0).toISOString();
      return {
        ok: true,
        session: {
          sessionId: "development_unauthenticated",
          operatorClientId: "development_unauthenticated",
          role: "operator",
          csrfToken: "development_unauthenticated",
          createdAt: timestamp,
          expiresAt: new Date(8_640_000_000_000_000).toISOString(),
          lastUsedAt: timestamp,
        },
      };
    }
    if (!remoteCredentialStore || !dashboardSessionStore) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      };
    }
    try {
      const session = await dashboardSessionStore.validate({
        cookieHeader,
        ...csrf,
      });
      if (
        !isSameOriginDashboardRequest(
          request,
          new URL(remoteCredentialHostUrl(request.url, options, header)).origin,
        )
      ) {
        return { ok: false, response: new Response("Forbidden", { status: 403 }) };
      }
      return { ok: true, session };
    } catch (error) {
      if (error instanceof CapletsError && error.code === "REQUEST_INVALID") {
        return { ok: false, response: new Response("Forbidden", { status: 403 }) };
      }
      if (error instanceof CapletsError && error.code === "AUTH_FAILED") {
        return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
      }
      if (error instanceof CapletsError && error.code === "SERVER_UNAVAILABLE") {
        return { ok: false, response: new Response("Service Unavailable", { status: 503 }) };
      }
      return { ok: false, response: new Response("Service Unavailable", { status: 503 }) };
    }
  }

  app.notFound(() => strictRouteNotFoundResponse());

  async function waitForActiveRequestsToDrain(graceMs: number): Promise<void> {
    if (activeRequestCount === 0 || graceMs === 0) return;
    activeRequestsDrained ??= new Promise<void>((resolve) => {
      resolveActiveRequestsDrained = resolve;
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        activeRequestsDrained,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, graceMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  app.closeCapletsSessions = async (closeOptions = {}) => {
    const activeRequestGraceMs = checkedActiveRequestGraceMs(
      closeOptions.activeRequestGraceMs ?? DEFAULT_HTTP_ACTIVE_REQUEST_GRACE_MS,
    );
    httpRequestsClosing = true;
    projectBindingSessionsClosing = true;
    clearInterval(attachSessionPruneTimer);
    clearInterval(backendAuthFlowMaintenanceTimer);
    clearInterval(idempotencyMaintenanceTimer);
    currentHostOperations.close();
    for (const stream of attachEventStreams) {
      stream.close();
    }
    await waitForActiveRequestsToDrain(activeRequestGraceMs);
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
    await Promise.all(
      [...projectBindingSessions.values()].map((record) => endProjectBindingRecord(record)),
    );
    if (backendAuthFlowMaintenance) {
      await Promise.allSettled([backendAuthFlowMaintenance]);
    }
    if (idempotencyMaintenance) {
      await Promise.allSettled([idempotencyMaintenance]);
    }
    await bundleUploadAdmission.close();
  };

  if (options.warnUnauthenticatedNetwork) {
    writeErr(
      `Warning: Caplets MCP HTTP server is listening on ${options.host} without authentication.\n`,
    );
  }

  return app;
}
export function createNodeServerFetch(app: CapletsHttpApp) {
  return (request: Request, environment: HttpBindings | Http2Bindings): Promise<Response> => {
    const rawRequestTarget = environment.incoming.url;
    if (
      rawRequestTarget !== undefined &&
      !rawRequestPathMatches(rawRequestTarget, new URL(request.url).pathname)
    ) {
      return Promise.resolve(strictRouteNotFoundResponse());
    }
    return Promise.resolve(app.fetch(request, environment));
  };
}

function rawRequestPathMatches(rawRequestTarget: string, normalizedPathname: string): boolean {
  if (rawRequestTarget.includes("#")) return false;
  let pathAndQuery = rawRequestTarget;
  const schemeSeparator = rawRequestTarget.indexOf("://");
  if (schemeSeparator > 0) {
    const authorityStart = schemeSeparator + 3;
    const targetStart = firstRequestTargetDelimiter(rawRequestTarget, authorityStart);
    if (targetStart === -1 || rawRequestTarget[targetStart] === "?") {
      pathAndQuery = "/";
    } else {
      pathAndQuery = rawRequestTarget.slice(targetStart);
    }
  }
  const queryStart = pathAndQuery.indexOf("?");
  const rawPathname = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  return rawPathname === normalizedPathname;
}

function firstRequestTargetDelimiter(value: string, start: number): number {
  let result = -1;
  for (const delimiter of ["/", "\\", "?", "#"]) {
    const index = value.indexOf(delimiter, start);
    if (index !== -1 && (result === -1 || index < result)) result = index;
  }
  return result;
}

function strictRouteNotFoundResponse(): Response {
  return new Response('{"error":"not_found"}', {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

const ALLOW_METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

function registeredAllowHeader(
  app: CapletsHttpApp,
  pathname: string,
  dashboardDistDir: string | undefined,
): string | undefined {
  const methods = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL" || route.path.includes("*")) continue;
    if (!registeredRoutePatternMatches(route.path, pathname)) continue;
    methods.add(route.method);
  }
  if (dashboardStaticRouteExists(pathname, dashboardDistDir)) methods.add("GET");
  if (methods.size === 0) return undefined;
  if (pathname === CURRENT_HOST_NAMESPACES.mcp) {
    return ["POST", "GET", "DELETE"].filter((method) => methods.has(method)).join(", ");
  }
  if (methods.has("GET")) methods.add("HEAD");
  return ALLOW_METHOD_ORDER.filter((method) => methods.has(method)).join(", ");
}

function registeredRoutePatternMatches(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every((segment, index) => {
      const pathSegment = pathSegments[index];
      if (segment === pathSegment) return true;
      if (!segment.startsWith(":") || !pathSegment) return false;
      try {
        return decodeURIComponent(pathSegment).length > 0;
      } catch {
        return false;
      }
    })
  );
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

function requestIsSecure(
  requestUrl: string,
  options: Pick<HttpServeOptions, "publicOrigin" | "publicOrigins" | "trustProxy">,
  header: (name: string) => string | undefined,
): boolean {
  const publicOrigin = remoteCredentialPublicOrigin(options, header);
  return (publicOrigin ?? publicRequestOrigin(requestUrl, options.trustProxy, header)).startsWith(
    "https://",
  );
}

function pendingLoginApprovalCommand(operatorCode: string, stateDir: string | undefined): string {
  const statePath = stateDir ? ` --state-path ${shellQuoteArg(stateDir)}` : "";
  return `caplets remote host approve ${shellQuoteArg(operatorCode)}${statePath} --yes`;
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function canonicalServePathUrl(options: HttpServeOptions, path: string): string {
  const boundOrigin = `http://${formatHost(options.host)}:${options.port}`;
  return publicHostUrl(
    boundOrigin,
    path,
    remoteCredentialPublicOrigin(options, () => undefined),
    options.trustProxy,
    () => undefined,
  );
}

function publicHostUrl(
  requestUrl: string,
  namespacePath: string,
  publicOrigin: string | undefined,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): string {
  const url = new URL(
    namespacePath,
    publicOrigin ?? publicRequestOrigin(requestUrl, trustProxy, header),
  );
  return namespacePath === "/" ? url.origin : url.toString();
}

function remoteCredentialHostUrl(
  requestUrl: string,
  options: Pick<HttpServeOptions, "publicOrigin" | "publicOrigins" | "trustProxy">,
  header: (name: string) => string | undefined,
): string {
  const publicOrigin = remoteCredentialPublicOrigin(options, header);
  if (options.trustProxy && !publicOrigin) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote credential auth with --trust-proxy requires a configured public origin.",
    );
  }
  return publicHostUrl(requestUrl, "/", publicOrigin, options.trustProxy, header);
}

function remoteCredentialPublicOrigin(
  options: Pick<HttpServeOptions, "publicOrigin" | "publicOrigins" | "trustProxy">,
  header: (name: string) => string | undefined,
): string | undefined {
  const publicOrigins = publicOriginsForOptions(options);
  if (publicOrigins.length === 0) return undefined;
  const host =
    firstForwardedValue(options.trustProxy ? header("x-forwarded-host") : undefined) ??
    header("host");
  const matchingOrigin = host
    ? publicOrigins.find((origin) => publicOriginMatchesHost(origin, host))
    : undefined;
  return matchingOrigin ?? options.publicOrigin ?? publicOrigins[0];
}

function publicOriginMatchesHost(origin: string, host: string): boolean {
  const url = new URL(origin);
  const normalizedHost = normalizeHostHeader(host);
  const originHost = normalizeHostHeader(url.host);
  const originHostWithDefaultPort = normalizeHostHeader(
    `${url.hostname}:${url.protocol === "https:" ? "443" : "80"}`,
  );
  return normalizedHost === originHost || normalizedHost === originHostWithDefaultPort;
}

function normalizeHostHeader(host: string): string {
  return host.trim().toLowerCase();
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

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStackIdentity(options: HttpServeOptions): string {
  return new URL(options.publicOrigin ?? `http://${formatHost(options.host)}:${options.port}`)
    .origin;
}

function stackChainFromHeader(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => canonicalizeCurrentHostOrigin(value));
}

function versionDiscovery(
  options: { exposeAttach?: boolean; exposeAttachSessions?: boolean } = {},
) {
  const exposeAttach = options.exposeAttach ?? true;
  const exposeAttachSessions = options.exposeAttachSessions ?? false;
  return {
    version: 1,
    path: CURRENT_HOST_PATHS.apiV1,
    links: {
      health: CURRENT_HOST_PATHS.health,
      ...(exposeAttach
        ? {
            ...(exposeAttachSessions
              ? { attachSessions: currentHostV1Path("attachSessions") }
              : {}),
            attachManifest: currentHostV1Path("attachManifest"),
            attachEvents: currentHostV1Path("attachEvents"),
            attachInvoke: currentHostV1Path("attachInvoke"),
          }
        : {}),
    },
  };
}

function parseAttachInvokeRequest(parsed: Record<string, unknown>): AttachInvokeRequest {
  const request = parsed;
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
  return isLoopbackCurrentHostHostname(host);
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
  return new Response(readable, { headers: attachEventsHeaders() });
}

function attachEventsHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

export async function serveHttp(
  options: HttpServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const engine = await CapletsEngine.create(remoteEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    control: {
      ...remoteEngineOptions,
      globalCapletsRoot: resolveCapletsRoot(remoteEngineOptions.configPath),
      globalLockfilePath: defaultCapletsLockfilePath(),
    },
  });
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = origin;
  const server = startHttpRuntimeServer(options, app, () => {
    writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
    writeErr(`MCP endpoint: ${origin}${CURRENT_HOST_NAMESPACES.mcp}\n`);
    writeErr(`Attach manifest: ${origin}${currentHostV1Path("attachManifest")}\n`);
    writeErr(`Admin endpoint: ${origin}${CURRENT_HOST_PATHS.admin}\n`);
    writeErr(`Health check: ${origin}${CURRENT_HOST_PATHS.health}\n`);
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
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const engine = await CapletsEngine.create(remoteEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    exposeAttach: io.exposeAttach ?? false,
    sessionFactory: createSession,
    ...(io.attachSessionFactory ? { attachSessionFactory: io.attachSessionFactory } : {}),
    ...(io.defaultAttachSessionFactory
      ? { defaultAttachSessionFactory: io.defaultAttachSessionFactory }
      : {}),
    control: {
      ...remoteEngineOptions,
      globalCapletsRoot: resolveCapletsRoot(remoteEngineOptions.configPath),
      globalLockfilePath: defaultCapletsLockfilePath(),
    },
  });
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = origin;
  const server = startHttpRuntimeServer(options, app, () => {
    writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
    writeErr(`MCP endpoint: ${origin}${CURRENT_HOST_NAMESPACES.mcp}\n`);
    writeErr(`Admin endpoint: ${origin}${CURRENT_HOST_PATHS.admin}\n`);
    writeErr(`Health check: ${origin}${CURRENT_HOST_PATHS.health}\n`);
    writeErr(`Auth: ${authDescription(options)}\n`);
  });

  installHttpSignalHandlers(server, app, engine, writeErr);
}

export function sanitizeRemoteEngineOptions(
  engineOptions: CapletsEngineOptions,
): CapletsEngineOptions {
  return {
    ...engineOptions,
    exposeLocalArtifactPaths: false,
    vaultRecoveryTarget: "remote" as const,
  };
}

function prependEventStreamPreamble(response: Response | undefined): Response | undefined {
  const body = response?.body;
  if (!body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const reader = body.getReader();
  let preamblePending = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (preamblePending) {
        preamblePending = false;
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        return;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function startHttpRuntimeServer(
  options: HttpServeOptions,
  app: CapletsHttpApp,
  onListen: () => void,
): HttpServer {
  if (process.versions.bun) {
    const server = resolveBunRuntime().serve({
      fetch: app.fetch,
      hostname: options.host,
      port: options.port,
      websocket: bunWebSocket,
    });
    onListen();
    return bunHttpServer(server);
  }
  return serve(
    {
      fetch: createNodeServerFetch(app),
      hostname: options.host,
      port: options.port,
      websocket: { server: createProjectBindingWebSocketServer() },
    },
    onListen,
  );
}

function bunHttpServer(server: BunRuntimeServer): HttpServer {
  let callback: ((error?: Error) => void) | undefined;
  let stopped = false;
  const finish = (error?: unknown) => {
    if (stopped) return;
    stopped = true;
    if (error === undefined) {
      callback?.();
    } else {
      callback?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const stop = (closeActiveConnections: boolean) => {
    void server.stop(closeActiveConnections).then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  };
  return {
    close(onStopped) {
      callback = onStopped;
      stop(false);
    },
    closeAllConnections() {
      stop(true);
    },
  };
}

function resolveBunRuntime(): BunRuntime {
  const runtime: unknown = Reflect.get(globalThis, "Bun");
  if (runtime === null || typeof runtime !== "object") {
    throw new Error("Bun runtime API is unavailable.");
  }
  const serve: unknown = Reflect.get(runtime, "serve");
  if (typeof serve !== "function") {
    throw new Error("Bun serve API is unavailable.");
  }
  return {
    serve(options) {
      const server: unknown = Reflect.apply(serve, runtime, [options]);
      if (server === null || typeof server !== "object") {
        throw new Error("Bun serve API returned an invalid server.");
      }
      const stop: unknown = Reflect.get(server, "stop");
      if (typeof stop !== "function") {
        throw new Error("Bun server stop API is unavailable.");
      }
      return {
        stop(closeActiveConnections) {
          return Promise.resolve()
            .then(() => Reflect.apply(stop, server, [closeActiveConnections]))
            .then(() => undefined);
        },
      };
    },
  };
}

function createProjectBindingWebSocketServer(): WebSocketServerLike {
  return new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
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
  remoteCredentialStore: RemoteCredentialStore | undefined,
  requiredRole: RemoteClientRole | undefined,
  retainAuthenticatedClient:
    | ((request: Request, client: ValidatedRemoteClient) => void)
    | undefined,
  authProblemResponse?: ((status: 401 | 403) => Response) | undefined,
): MiddlewareHandler {
  if (options.auth.type === "development_unauthenticated") {
    return async (_c, next) => {
      await next();
    };
  }
  if (!remoteCredentialStore) {
    return async (c) => authProblemResponse?.(401) ?? c.text("Unauthorized", 401);
  }
  return async (c, next) => {
    const header = authorizationHeaderForRequest(c);
    const token = bearerToken(header);
    if (!token) {
      return authProblemResponse?.(401) ?? c.text("Unauthorized", 401);
    }
    try {
      const client = await remoteCredentialStore.validateAccessToken({
        hostUrl: remoteCredentialHostUrl(c.req.url, options, (name) => c.req.header(name)),
        accessToken: token,
      });
      if (requiredRole !== undefined && !remoteClientRoleSatisfies(client.role, requiredRole)) {
        return (
          authProblemResponse?.(403) ?? c.text(`Forbidden: ${requiredRole} role required`, 403)
        );
      }
      retainAuthenticatedClient?.(c.req.raw, client);
    } catch {
      return authProblemResponse?.(401) ?? c.text("Unauthorized", 401);
    }
    await next();
  };
}

function isVerifiedLoopbackDevelopmentRequest(
  options: HttpServeOptions,
  requestUrl: string,
  header: (name: string) => string | undefined,
): boolean {
  if (!options.loopback || !isLoopbackCurrentHostHostname(options.host)) return false;
  let requestHost: string;
  try {
    requestHost = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  if (!isLoopbackCurrentHostHostname(requestHost)) return false;
  const host = header("host");
  if (!host) return true;
  try {
    return isLoopbackCurrentHostHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function remoteCredentialStatePath(store: RemoteCredentialStore): string | undefined {
  return store instanceof RemoteServerCredentialStore ? store.dir : undefined;
}

function bearerToken(header: string): string | undefined {
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function authorizationHeaderForRequest(c: Parameters<MiddlewareHandler>[0]): string {
  const header = c.req.header("authorization");
  if (header) return header;
  const token = bearerTokenFromWebSocketProtocol(c.req.header("sec-websocket-protocol"));
  return token ? `Bearer ${token}` : "";
}

function bearerTokenFromWebSocketProtocol(header: string | undefined): string | undefined {
  const encoded = (header ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("caplets.bearer."))
    ?.slice("caplets.bearer.".length);
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
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

async function parseProjectBindingSocketClientMessage(
  data: unknown,
): Promise<ProjectBindingSocketClientMessage> {
  const text = await socketMessageText(data);
  if (!text) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Project Binding WebSocket messages must contain JSON text.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Project Binding WebSocket messages must contain valid JSON.",
      error,
    );
  }
  const message = projectBindingSocketClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Project Binding WebSocket message does not match protocol v1.",
      message.error.issues,
    );
  }
  return message.data;
}

async function socketMessageText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data instanceof Blob) return await data.text();
  return undefined;
}

function requiredRouteParam(value: string | undefined): string {
  if (!value) {
    throw new CapletsError("REQUEST_INVALID", "Route parameter is required.");
  }
  return value;
}

function remoteCredentialErrorResponse(error: unknown): Response {
  const safe =
    error instanceof CapletsError
      ? toSafeError(error, error.code)
      : toSafeError(error, "AUTH_FAILED");
  return Response.json({ ok: false, error: safe }, { status: httpStatusForSafeError(safe.code) });
}

function currentHostErrorResponse(error: unknown): Response {
  const safe = toCurrentHostSafeError(error);
  return Response.json(
    {
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
      },
    },
    { status: httpStatusForSafeError(safe.code) },
  );
}

function httpStatusForSafeError(code: CapletsErrorCode): number {
  if (code === "REQUEST_INVALID" || code === "CONFIG_INVALID") return 400;
  if (code === "CONFIG_NOT_FOUND" || code === "SERVER_NOT_FOUND") return 404;
  if (code === "CONFIG_EXISTS") return 409;
  if (code === "SERVER_UNAVAILABLE") return 503;
  if (code === "SERVER_START_TIMEOUT" || code === "TOOL_CALL_TIMEOUT") return 504;
  if (
    code === "AUTH_FAILED" ||
    code === "AUTH_REQUIRED" ||
    code === "AUTH_REFRESH_FAILED" ||
    code === "REMOTE_CREDENTIALS_REVOKED"
  ) {
    return 401;
  }
  return 500;
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
  const publicUrls = publicOriginsForOptions(options).map((origin) => new URL(origin));
  const publicHosts =
    publicUrls.length > 0 &&
    (options.auth.type === "remote_credentials" || options.allowUnauthenticatedHttp)
      ? publicUrls.flatMap((url) => [url.hostname, url.host])
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

function publicOriginsForOptions(
  options: Pick<HttpServeOptions, "publicOrigin" | "publicOrigins">,
): string[] {
  if (options.publicOrigins?.length) return options.publicOrigins;
  return options.publicOrigin ? [options.publicOrigin] : [];
}

function authDescription(options: HttpServeOptions): string {
  return options.auth.type === "remote_credentials"
    ? "remote credentials"
    : "development unauthenticated";
}

function checkedActiveRequestGraceMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_HTTP_ACTIVE_REQUEST_GRACE_MS) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `HTTP shutdown active-request grace must be an integer from 0 to ${MAX_HTTP_ACTIVE_REQUEST_GRACE_MS} milliseconds.`,
    );
  }
  return value;
}

export async function shutdownHttpServer(
  server: HttpServer,
  app: CapletsHttpApp,
  engine: CapletsEngine,
  options: CloseCapletsSessionsOptions = {},
): Promise<void> {
  const serverStopped = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  try {
    await app.closeCapletsSessions(options);
  } finally {
    closeAllServerConnections(server);
    await serverStopped;
    await engine.close();
  }
}

function installHttpSignalHandlers(
  server: HttpServer,
  app: CapletsHttpApp,
  engine: CapletsEngine,
  writeErr: (value: string) => void,
): void {
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= shutdownHttpServer(server, app, engine);
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

function closeAllServerConnections(server: HttpServer): void {
  server.closeAllConnections?.();
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
