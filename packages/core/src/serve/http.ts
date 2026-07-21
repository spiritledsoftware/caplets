import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  serve,
  upgradeWebSocket,
  type ServerType,
  type WebSocketServerLike,
} from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";
import {
  defaultCapletsLockfilePath,
  resolveCapletsRoot,
  resolveProjectCapletsRoot,
  vaultStoreForAuthDir,
} from "../config";
import { version as packageJsonVersion } from "../../package.json";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError, type CapletsErrorCode } from "../errors";
import {
  createCurrentHostOperations,
  toCurrentHostSafeError,
  trustedDevelopmentOperatorPrincipal,
  type CurrentHostLogStateOwner,
  type CurrentHostOperatorPrincipal,
  type CurrentHostProjectBindingStateOwner,
  type CurrentHostRuntimeStateOwner,
} from "../current-host/operations";
import { AdminBundleUploadAdmissionController } from "../admin-api/bundle-upload-admission";
import { problemResponse } from "../admin-api/problem";
import {
  AdminV2PrincipalError,
  createAdminV2Router,
  type AdminV2HostContext,
  type AdminV2PrincipalProvider,
} from "../admin-api/router";
import {
  ifNoneMatchIncludes,
  rootOpenApiRepresentation,
} from "../admin-api/openapi-representation";
import { dashboardSessionCookie, expiredDashboardSessionCookie } from "../dashboard/auth";
import { DashboardActivityLog } from "../dashboard/activity-log";
import { dashboardShell, dashboardStaticResponse } from "../dashboard/routes";
import { DashboardSessionStore } from "../dashboard/session-store";
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
  dispatchRemoteCliRequest,
  LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES,
  maximumBase64EncodedBytes,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";
import type { RemoteCliRequest } from "../remote-control/types";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
} from "../storage/caplet-records";
import { remoteClientById, type RemoteSecurityStore } from "../storage/remote-security";
import type { BackendAuthStateStore } from "../storage/backend-auth";
import type { BackendAuthFlowRepository } from "../storage/backend-auth-flows";
import type { HostStorage } from "../storage/database";
import {
  remoteClientRoleSatisfies,
  type RemoteClientRole,
  type ValidatedRemoteClient,
} from "../remote/server-credentials";
import { isLoopbackHost } from "../server/options";
import type { HttpServeOptions } from "./options";
import { CapletsMcpSession } from "./session";
import { readCommandLimitedJsonObject, readLimitedJsonObject } from "./request-body";

type RemoteCredentialStore = RemoteServerCredentialStore | RemoteSecurityStore;

type HttpServeIo = {
  writeErr?: (value: string) => void;
  control?: Omit<RemoteControlDispatchContext, "writeErr" | "backendAuthFlows">;
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
// The ceiling is the exact worst-case padded payload plus the metadata bound enforced by
// semantic import/update decoding for the canonical RemoteHttpClient envelope.
const LEGACY_CAPLET_BUNDLE_BASE64_MAX_BYTES = maximumBase64EncodedBytes(
  MAX_BUNDLE_TOTAL_BYTES + MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_FILES + 1,
);
export const LEGACY_CAPLET_BUNDLE_REQUEST_MAX_BYTES =
  LEGACY_CAPLET_BUNDLE_BASE64_MAX_BYTES + LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES;
const LEGACY_BUNDLE_COMMANDS: Readonly<Record<string, true>> = {
  storage_records_import: true,
  storage_records_update: true,
};

const deprecatedV1Admin: MiddlewareHandler = async (context, next) => {
  context.header("Deprecation", "true");
  context.header("Link", '</v2/admin/host>; rel="successor-version"');
  await next();
};

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
  const paths = servicePaths(options.path);
  const canonicalBaseUrl = canonicalServePathUrl(options, paths.base);
  const canonicalAdminV2Url = canonicalServePathUrl(options, paths.adminV2);
  const adminV2Host: AdminV2HostContext = {
    baseUrl: canonicalBaseUrl,
    dashboardUrl: canonicalServePathUrl(options, paths.dashboard),
    dashboardPath: paths.dashboard,
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
    paths.base,
    undefined,
    retainAuthenticatedRemoteClient,
  );
  const accessRouteAuth = routeAuth(
    options,
    remoteCredentialStore,
    paths.base,
    "access",
    retainAuthenticatedRemoteClient,
  );
  const operatorRouteAuth = routeAuth(
    options,
    remoteCredentialStore,
    paths.base,
    "operator",
    retainAuthenticatedRemoteClient,
  );
  const operatorAdminV2RouteAuth = routeAuth(
    options,
    remoteCredentialStore,
    paths.base,
    "operator",
    retainAuthenticatedRemoteClient,
    adminV2BearerAuthProblemResponse,
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
  const bearerAdminPrincipal: AdminV2PrincipalProvider = (request) => {
    const client = authenticatedRemoteClients.get(request);
    if (client) {
      if (client.role !== "operator") {
        throw new AdminV2PrincipalError(403, "An Operator Client is required.");
      }
      return {
        clientId: client.clientId,
        clientLabel: client.clientLabel,
        hostUrl: client.hostUrl,
        role: "operator",
      };
    }
    if (
      options.auth.type === "development_unauthenticated" &&
      isVerifiedLoopbackDevelopmentRequest(
        options,
        request.url,
        (name) => request.headers.get(name) ?? undefined,
      )
    ) {
      return trustedDevelopmentOperatorPrincipal(
        remoteCredentialHostUrl(
          request.url,
          paths.base,
          options,
          (name) => request.headers.get(name) ?? undefined,
        ),
      );
    }
    throw new AdminV2PrincipalError(401, "A valid Operator Client credential is required.");
  };
  const dashboardAdminPrincipal: AdminV2PrincipalProvider = async (request, context) => {
    const validated = await validateDashboardSession(
      request.headers.get("cookie") ?? undefined,
      {
        requireCsrf: context.mutates,
        csrfToken: request.headers.get("x-caplets-csrf") ?? undefined,
      },
      request.url,
      (name) => request.headers.get(name) ?? undefined,
    );
    if (!validated.ok) {
      const status = validated.response.status === 403 ? 403 : 401;
      throw new AdminV2PrincipalError(
        status,
        status === 403
          ? "A current dashboard CSRF token is required."
          : "A current Operator dashboard session is required.",
      );
    }
    const hostUrl = remoteCredentialHostUrl(
      request.url,
      paths.base,
      options,
      (name) => request.headers.get(name) ?? undefined,
    );
    if (validated.session.operatorClientId === "development_unauthenticated") {
      return trustedDevelopmentOperatorPrincipal(hostUrl);
    }
    return {
      clientId: validated.session.operatorClientId,
      hostUrl,
      role: "operator",
    };
  };

  app.get(paths.base, (c) => {
    const remote = remoteCredentialStore
      ? remoteHostMetadata(c.req.url, paths.base, options, (name) => c.req.header(name))
      : undefined;
    return c.json({
      name: "caplets",
      transport: "http",
      base: paths.base,
      versions: [
        versionDiscovery(paths, { exposeAttach, exposeAttachSessions }, remote),
        adminV2VersionDiscovery(paths),
      ],
      auth: { type: options.auth.type },
      ...(remote ? { remote } : {}),
    });
  });

  app.get(routePath(paths.base, "openapi.json"), (c) => {
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

  app.get(paths.version, (c) => {
    const remote = remoteCredentialStore
      ? remoteHostMetadata(c.req.url, paths.base, options, (name) => c.req.header(name))
      : undefined;
    return c.json(versionDiscovery(paths, { exposeAttach, exposeAttachSessions }, remote));
  });

  app.get(paths.version2, (c) => c.json(adminV2VersionDiscovery(paths)));

  app.get(paths.health, async (c) => {
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
    routePath(paths.base, "_astro/*"),
    (c) =>
      dashboardStaticResponse(
        dashboardStaticRequestPath(new URL(c.req.url).pathname, paths.base),
        io.dashboardDistDir,
      ) ?? c.notFound(),
  );

  app.get(paths.dashboard, (c) => {
    const response = dashboardStaticResponse(
      dashboardStaticRequestPath(new URL(c.req.url).pathname, paths.base),
      io.dashboardDistDir,
    );
    if (response) return response;
    return c.html(dashboardShell(), 200, { "cache-control": "no-store" });
  });

  app.post(paths.dashboardLoginStart, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard login start request",
        AUTH_REQUEST_MAX_BYTES,
      );
      const clientLabel = optionalStringField(parsed, "clientLabel") ?? "Caplets Dashboard";
      const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
      const hostUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
        c.req.header(name),
      );
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

  app.post(paths.dashboardLoginPoll, attachHostProtection, async (c) => {
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

  app.post(paths.dashboardLoginComplete, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await readLimitedJsonObject(
        c.req.raw,
        "Dashboard login complete request",
        AUTH_REQUEST_MAX_BYTES,
      );
      const credentials = await remoteCredentialStore.completePendingLogin({
        hostUrl: remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
          c.req.header(name),
        ),
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
      c.header(
        "set-cookie",
        dashboardSessionCookie(created.cookieValue, {
          path: paths.dashboard,
          secure: requestIsSecure(c.req.url, options, (name) => c.req.header(name)),
        }),
      );
      return c.json({ authenticated: true, session: created.session });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardSession, async (c) => {
    const session = await dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    return c.json({ authenticated: true, session: session.session });
  });

  app.get(paths.adminV2Callback, async (c) => {
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
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  });

  const bearerAdminAdapter = new Hono();
  bearerAdminAdapter.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return await operatorAdminV2RouteAuth(c, next);
  });
  bearerAdminAdapter.route(
    "/",
    createAdminV2Router({
      operations: currentHostOperations,
      principalProvider: bearerAdminPrincipal,
      host: adminV2Host,
      idempotencyStore: idempotency,
      bundleUploadAdmission,
    }),
  );
  app.route(paths.adminV2, bearerAdminAdapter);
  app.route(
    paths.dashboardV2,
    createAdminV2Router({
      operations: currentHostOperations,
      principalProvider: dashboardAdminPrincipal,
      host: adminV2Host,
      idempotencyStore: idempotency,
      bundleUploadAdmission,
      mutationResponseHeaders: async ({ request, outcome }) => {
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
        return { "Set-Cookie": expiredDashboardSessionCookie(paths.dashboard) };
      },
    }),
  );

  app.post(routePath(paths.dashboardPrivate, "vault-reveals"), async (c) => {
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

  app.post(paths.dashboardLogout, async (c) => {
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
    c.header("set-cookie", expiredDashboardSessionCookie(paths.dashboard));
    return c.json({ ok: true });
  });

  app.get(
    routePath(paths.dashboard, "*"),
    (c) =>
      dashboardStaticResponse(
        dashboardStaticRequestPath(new URL(c.req.url).pathname, paths.base),
        io.dashboardDistDir,
      ) ?? c.notFound(),
  );

  if (remoteCredentialStore) {
    app.post(paths.remoteLoginStart, attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login start request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const clientLabel = optionalStringField(parsed, "clientLabel");
        const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
        const hostUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
          c.req.header(name),
        );
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

    app.post(paths.remoteLoginPoll, attachHostProtection, async (c) => {
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

    app.post(paths.remoteLoginRefresh, attachHostProtection, async (c) => {
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

    app.post(paths.remoteLoginComplete, attachHostProtection, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Pending remote login complete request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const credentials = await remoteCredentialStore.completePendingLogin({
          hostUrl: remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
            c.req.header(name),
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

    app.post(paths.pairingExchange, async (_c) => {
      return remoteCredentialErrorResponse(legacyPairingCodeUnsupportedError());
    });

    app.post(paths.remoteRefresh, async (c) => {
      try {
        const parsed = await readLimitedJsonObject(
          c.req.raw,
          "Remote refresh request",
          AUTH_REQUEST_MAX_BYTES,
        );
        const refreshToken = stringField(parsed, "refreshToken");
        const credentials = await remoteCredentialStore.refreshClientCredentials({
          hostUrl: remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
            c.req.header(name),
          ),
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

    app.delete(paths.remoteClient, authenticatedClientRouteAuth, async (c) => {
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

  app.all(paths.mcp, accessRouteAuth, async (c) => {
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
      app.post(paths.attachSessions, attachHostProtection, accessRouteAuth, async (c) => {
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
      });

      app.delete(
        routePath(paths.attachSessions, ":sessionId"),
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

    app.get(paths.attachManifest, attachHostProtection, accessRouteAuth, async (c) => {
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

    app.get(paths.attachEvents, attachHostProtection, accessRouteAuth, async (c) => {
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

    app.post(paths.attachInvoke, attachHostProtection, accessRouteAuth, async (c) => {
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

  app.post(
    paths.control,
    deprecatedV1Admin,
    currentHostDevelopmentGuard(options),
    operatorRouteAuth,
    async (c) => {
      let request: RemoteCliRequest;
      try {
        request = parseRemoteCliRequest(
          await readCommandLimitedJsonObject(
            c.req.raw,
            "Control request",
            CONTROL_REQUEST_MAX_BYTES,
            LEGACY_CAPLET_BUNDLE_REQUEST_MAX_BYTES,
            LEGACY_BUNDLE_COMMANDS,
          ),
        );
      } catch (error) {
        const requestError =
          error instanceof CapletsError
            ? error
            : new CapletsError("REQUEST_INVALID", "Control request body must be valid JSON", error);
        const safe = toSafeError(requestError, "REQUEST_INVALID");
        return c.json({ ok: false, error: { code: safe.code, message: safe.message } });
      }
      const context = controlContext(
        io,
        writeErr,
        backendAuthFlows,
        backendAuthStore,
        authoritativeStorage,
        c.req.url,
        paths.control,
        options.publicOrigin,
        options.trustProxy,
        (name) => c.req.header(name),
      );
      return c.json(
        await dispatchRemoteCliRequest(
          request,
          { ...context, attachEngine: engine },
          {
            operations: currentHostOperations,
            principal: controlOperatorPrincipal(c),
          },
        ),
      );
    },
  );

  app.get(
    routePath(paths.projectBindings, "connect"),
    accessRouteAuth,
    async (c, next) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return c.json({ error: "websocket_upgrade_required" }, 426);
      }
      const validation = projectBindingSocketRecordForRequest(c);
      if (!validation.ok) return validation.response;
      return next();
    },
    upgradeWebSocket((c) => {
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
    routePath(paths.projectBindings, ":bindingId/status"),
    accessRouteAuth,
    async (c) =>
      await projectBindingStatusResponse(
        requiredRouteParam(c.req.param("bindingId")),
        projectBindingOwnerKey(c),
      ),
  );

  app.post(routePath(paths.projectBindings, "sessions"), accessRouteAuth, async (c) => {
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

  app.get(routePath(paths.projectBindings, ":bindingId/session"), accessRouteAuth, (c) => {
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

  app.post(routePath(paths.projectBindings, ":bindingId/heartbeat"), accessRouteAuth, async (c) => {
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

  app.delete(routePath(paths.projectBindings, ":bindingId/session"), accessRouteAuth, async (c) => {
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
    return await validateDashboardSession(c.req.header("cookie"), csrf, c.req.url, (name) =>
      c.req.header(name),
    );
  }

  function controlOperatorPrincipal(
    c: Parameters<MiddlewareHandler>[0],
  ): CurrentHostOperatorPrincipal {
    const client = authenticatedRemoteClients.get(c.req.raw);
    if (client) {
      if (client.role !== "operator") {
        throw new CapletsError(
          "AUTH_FAILED",
          "Current Host administration requires an Operator principal.",
        );
      }
      return {
        clientId: client.clientId,
        clientLabel: client.clientLabel,
        hostUrl: client.hostUrl,
        role: "operator",
      };
    }
    if (
      options.auth.type === "development_unauthenticated" &&
      isVerifiedLoopbackDevelopmentRequest(options, c.req.url, (name) => c.req.header(name))
    ) {
      return trustedDevelopmentOperatorPrincipal(
        remoteCredentialHostUrl(c.req.url, paths.base, options, (name) => c.req.header(name)),
      );
    }
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host administration requires an Operator principal.",
    );
  }

  async function validateDashboardSession(
    cookieHeader: string | undefined,
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined },
    requestUrl: string,
    header: (name: string) => string | undefined,
  ): Promise<{ ok: true; session: DashboardSessionView } | { ok: false; response: Response }> {
    if (!remoteCredentialStore && options.auth.type === "development_unauthenticated") {
      if (!isVerifiedLoopbackDevelopmentRequest(options, requestUrl, header)) {
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
      return {
        ok: true,
        session: await dashboardSessionStore.validate({
          cookieHeader,
          ...csrf,
        }),
      };
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

  app.get(routePath(paths.control, "auth/callback/:flowId"), async (c) => {
    const flowId = c.req.param("flowId");
    const result = await dispatchRemoteCliRequest(
      { command: "auth_login_complete", arguments: { flowId, callbackUrl: c.req.url } },
      controlContext(
        io,
        writeErr,
        backendAuthFlows,
        backendAuthStore,
        authoritativeStorage,
        c.req.url,
        paths.control,
        options.publicOrigin,
        options.trustProxy,
        (name) => c.req.header(name),
      ),
      { operations: currentHostOperations },
    );
    if (!result.ok) {
      writeErr(`Caplets authentication failed for flow ${flowId}: ${result.error.message}\n`);
    }
    return result.ok
      ? c.text("Caplets authentication complete. You can return to your terminal.")
      : c.text("Caplets authentication failed. Check server logs for details.", 400);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

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

function controlContext(
  io: HttpServeIo,
  writeErr: (value: string) => void,
  backendAuthFlows: BackendAuthFlowRepository | undefined,
  backendAuthStore: BackendAuthStateStore | undefined,
  authoritativeStorage: HostStorage | undefined,
  requestUrl: string,
  controlPath: string,
  publicOrigin: string | undefined,
  trustProxy: boolean,
  header: (name: string) => string | undefined,
): RemoteControlDispatchContext {
  return {
    ...io.control,
    projectCapletsRoot: io.control?.projectCapletsRoot ?? resolveProjectCapletsRoot(),
    globalCapletsRoot: io.control?.globalCapletsRoot ?? resolveCapletsRoot(io.control?.configPath),
    globalLockfilePath: io.control?.globalLockfilePath ?? defaultCapletsLockfilePath(),
    ...(backendAuthFlows ? { backendAuthFlows } : {}),
    ...(backendAuthStore ? { backendAuthStore } : {}),
    ...(authoritativeStorage ? { hostStorage: authoritativeStorage } : {}),
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

function dashboardStaticRequestPath(pathname: string, basePath: string): string {
  if (basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
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
  return publicHostUrl(requestUrl, basePath, publicOrigin, options.trustProxy, header);
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
  const audience = remoteCredentialHostUrl(requestUrl, basePath, options, header);
  return { hostIdentity: audience, audience };
}

function versionDiscovery(
  paths: ServicePaths,
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
      dashboard: paths.dashboard,
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

function adminV2VersionDiscovery(paths: ServicePaths) {
  return {
    version: 2,
    path: paths.version2,
    links: { admin: paths.adminV2 },
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
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const engine = await CapletsEngine.create(remoteEngineOptions);
  const app = createHttpServeApp(options, engine, {
    writeErr,
    control: {
      ...remoteEngineOptions,
      projectCapletsRoot: projectCapletsRootForEngineOptions(remoteEngineOptions),
      globalCapletsRoot: resolveCapletsRoot(remoteEngineOptions.configPath),
      globalLockfilePath: defaultCapletsLockfilePath(),
    },
  });
  const paths = servicePaths(options.path);
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = `${origin}${paths.base === "/" ? "" : paths.base}`;
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.host,
      port: options.port,
      websocket: { server: createProjectBindingWebSocketServer() },
    },
    () => {
      writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
      writeErr(`MCP endpoint: ${origin}${paths.mcp}\n`);
      writeErr(`Attach manifest: ${origin}${paths.attachManifest}\n`);
      writeErr(`Control endpoint: ${origin}${paths.control}\n`);
      writeErr(`Health check: ${origin}${paths.health}\n`);
      writeErr(`Auth: ${authDescription(options)}\n`);
    },
  );

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
      projectCapletsRoot: projectCapletsRootForEngineOptions(remoteEngineOptions),
      globalCapletsRoot: resolveCapletsRoot(remoteEngineOptions.configPath),
      globalLockfilePath: defaultCapletsLockfilePath(),
    },
  });
  const paths = servicePaths(options.path);
  const origin = `http://${formatHost(options.host)}:${options.port}`;
  const baseUrl = `${origin}${paths.base === "/" ? "" : paths.base}`;
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.host,
      port: options.port,
      websocket: { server: createProjectBindingWebSocketServer() },
    },
    () => {
      writeErr(`Caplets HTTP service listening on ${baseUrl}\n`);
      writeErr(`MCP endpoint: ${origin}${paths.mcp}\n`);
      writeErr(`Control endpoint: ${origin}${paths.control}\n`);
      writeErr(`Health check: ${origin}${paths.health}\n`);
      writeErr(`Auth: ${authDescription(options)}\n`);
    },
  );

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
function projectCapletsRootForEngineOptions(engineOptions: CapletsEngineOptions): string {
  return engineOptions.projectConfigPath
    ? resolveProjectCapletsRootForConfigPath(engineOptions.projectConfigPath)
    : resolveProjectCapletsRoot();
}

function resolveProjectCapletsRootForConfigPath(projectConfigPath: string): string {
  return dirname(projectConfigPath);
}

function createProjectBindingWebSocketServer(): WebSocketServerLike {
  return new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
}

export function routePath(base: string, path: string): string {
  return base === "/" ? `/${path}` : `${base}/${path}`;
}

export type ServicePaths = {
  base: string;
  version: string;
  version2: string;
  adminV2: string;
  adminV2Callback: string;
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
  dashboard: string;
  dashboardApi: string;
  dashboardV2: string;
  dashboardPrivate: string;
  dashboardLoginStart: string;
  dashboardLoginPoll: string;
  dashboardLoginComplete: string;
  dashboardSession: string;
  dashboardLogout: string;
  health: string;
};

export function servicePaths(base: string): ServicePaths {
  const version = routePath(base, "v1");
  const version2 = routePath(base, "v2");
  const adminV2 = routePath(version2, "admin");
  const attach = routePath(version, "attach");
  const remote = routePath(version, "remote");
  const dashboard = routePath(base, "dashboard");
  const dashboardApi = routePath(dashboard, "api");
  const dashboardV2 = routePath(dashboardApi, "v2");
  const dashboardPrivate = routePath(dashboardApi, "private");
  const dashboardLogin = routePath(dashboardApi, "login");
  return {
    base,
    version,
    version2,
    adminV2,
    adminV2Callback: routePath(adminV2, "backend-auth-flows/:flowId/callback"),
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
    dashboard,
    dashboardApi,
    dashboardV2,
    dashboardPrivate,
    dashboardLoginStart: routePath(dashboardLogin, "start"),
    dashboardLoginPoll: routePath(dashboardLogin, "poll"),
    dashboardLoginComplete: routePath(dashboardLogin, "complete"),
    dashboardSession: routePath(dashboardApi, "session"),
    dashboardLogout: routePath(dashboardApi, "logout"),
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
  remoteCredentialStore: RemoteCredentialStore | undefined,
  basePath: string,
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
        hostUrl: remoteCredentialHostUrl(c.req.url, basePath, options, (name) =>
          c.req.header(name),
        ),
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

function adminV2BearerAuthProblemResponse(status: 401 | 403): Response {
  const response = problemResponse(
    new AdminV2PrincipalError(
      status,
      status === 401
        ? "A valid Operator Client credential is required."
        : "An Operator Client is required.",
    ),
    { status },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function currentHostDevelopmentGuard(options: HttpServeOptions): MiddlewareHandler {
  if (options.auth.type !== "development_unauthenticated") {
    return async (_c, next) => {
      await next();
    };
  }
  return async (c, next) => {
    if (!isVerifiedLoopbackDevelopmentRequest(options, c.req.url, (name) => c.req.header(name))) {
      return c.text("Forbidden", 403);
    }
    await next();
  };
}

function isVerifiedLoopbackDevelopmentRequest(
  options: HttpServeOptions,
  requestUrl: string,
  header: (name: string) => string | undefined,
): boolean {
  if (!options.loopback || !isLoopbackHost(options.host)) return false;
  let requestHost: string;
  try {
    requestHost = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  if (!isLoopbackHost(requestHost)) return false;
  const host = header("host");
  if (!host) return true;
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
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

function parseRemoteCliRequest(value: unknown): RemoteCliRequest {
  if (!isRecord(value) || typeof value.command !== "string" || !isRecord(value.arguments)) {
    throw new CapletsError("REQUEST_INVALID", "Control request JSON must be an object.");
  }
  return { command: value.command, arguments: value.arguments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  server: ServerType,
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
  server: ServerType,
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

function closeAllServerConnections(server: ServerType): void {
  const closeAllConnections = (server as { closeAllConnections?: () => void }).closeAllConnections;
  closeAllConnections?.call(server);
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
