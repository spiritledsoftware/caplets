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
import { fingerprintProjectRoot } from "../cloud/project-root";
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
  type CurrentHostOperatorPrincipal,
} from "../current-host/operations";
import { dashboardSessionCookie, expiredDashboardSessionCookie } from "../dashboard/auth";
import { DashboardActivityLog, type DashboardActivityAction } from "../dashboard/activity-log";
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
  PROJECT_BINDING_STATES,
  PROJECT_BINDING_SYNC_STATES,
  type ProjectBindingLease,
  type ProjectBindingState,
  type ProjectBindingSyncState,
} from "../project-binding";
import type { ProjectBindingSocketClientMessage } from "../project-binding/session";
import { ProjectBindingWorkspaceStore } from "../project-binding/workspaces";
import {
  dispatchRemoteCliRequest,
  type RemoteControlDispatchContext,
} from "../remote-control/dispatch";
import { RemoteAuthFlowStore } from "../remote-control/auth-flow";
import type { RemoteCliRequest } from "../remote-control/types";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import type { RemoteClientRole, ValidatedRemoteClient } from "../remote/server-credentials";
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
  dashboardSessionStore?: DashboardSessionStore;
  dashboardDistDir?: string;
  projectBindingWorkspaceStore?: ProjectBindingWorkspaceStore;
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
const PROJECT_BINDING_LEASE_TTL_MS = 60_000;

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
  let projectBindingWorkspaceCleanup: Promise<unknown> | undefined;
  const attachEventStreams = new Set<AttachEventStream>();
  const attachSessionPruneTimer = setInterval(() => {
    pruneIdleAttachSessions();
    pruneExpiredProjectBindingSessions();
  }, ATTACH_SESSION_PRUNE_INTERVAL_MS);
  attachSessionPruneTimer.unref?.();
  const writeErr = io.writeErr ?? process.stderr.write.bind(process.stderr);
  const paths = servicePaths(options.path);
  const stackIdentity = httpStackIdentity(options);
  const authFlowStore = io.authFlowStore ?? new RemoteAuthFlowStore();
  const exposeAttach = io.exposeAttach ?? true;
  const exposeAttachSessions = exposeAttach && Boolean(io.attachSessionFactory);
  const remoteCredentialStore = remoteCredentialStoreForOptions(options, io.remoteCredentialStore);
  const dashboardStateDir =
    options.remoteCredentialStateDir ?? io.dashboardSessionStore?.dir ?? ".";
  const dashboardSessionStore = new DashboardSessionStore({
    dir: dashboardStateDir,
  });
  const dashboardActivityLog = new DashboardActivityLog({ dir: dashboardStateDir });
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
    remoteCredentialStore,
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
      const parsed = await parseJsonObject(c.req.json(), "Dashboard login start request");
      const clientLabel = optionalStringField(parsed, "clientLabel") ?? "Caplets Dashboard";
      const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
      const hostUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
        c.req.header(name),
      );
      const pending = remoteCredentialStore.createPendingLogin({
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
          remoteCredentialStore.dir,
        ),
      });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(paths.dashboardLoginPoll, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard login poll request");
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

  app.post(paths.dashboardLoginComplete, attachHostProtection, async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard login complete request");
      const credentials = remoteCredentialStore.completePendingLogin({
        hostUrl: remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
          c.req.header(name),
        ),
        requiredRole: "operator",
        flowId: stringField(parsed, "flowId"),
        pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
      });
      const created = dashboardSessionStore.create({ operatorClientId: credentials.clientId });
      dashboardActivityLog.append({
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

  app.get(paths.dashboardSession, (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    return c.json({ authenticated: true, session: session.session });
  });

  app.get(paths.dashboardSummary, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const baseUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
        c.req.header(name),
      );
      const dashboardUrl = new URL(
        paths.dashboard,
        publicRequestOrigin(c.req.url, options.trustProxy, (name) => c.req.header(name)),
      ).toString();
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "summary", baseUrl, dashboardUrl, dashboardPath: paths.dashboard },
      );

      return c.json(outcome.summary);
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardCaplets, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "caplets_list" },
      );

      return c.json({ caplets: outcome.caplets });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardCatalogSearch, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const query = new URL(c.req.url).searchParams;
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "catalog_search",
          source: requiredQueryParam(query, "source"),
          query: query.get("q") ?? undefined,
          limit: numberQueryParam(query.get("limit")),
        },
      );

      return c.json({ entries: outcome.entries });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardCatalogDetail, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const query = new URL(c.req.url).searchParams;
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "catalog_detail",
          source: requiredQueryParam(query, "source"),
          capletId: requiredQueryParam(query, "id"),
        },
      );

      return c.json({
        entry: outcome.entry,
        setupActions: outcome.setupActions,
        projectScopedInstallAvailable: outcome.projectScopedInstallAvailable,
      });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardCatalogUpdates, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "catalog_updates" },
      );

      return c.json({ updates: outcome.updates });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardCatalogInstall, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard catalog install request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "catalog_install",
          source: stringField(parsed, "source"),
          capletIds: [stringField(parsed, "capletId")],
          force: optionalBooleanField(parsed, "force"),
          disableCatalogIndexing: true,
        },
      );

      return c.json({ installed: outcome.installed, setupActions: outcome.setupActions });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardCatalogUpdate, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard catalog update request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "catalog_update",
          capletIds: [stringField(parsed, "capletId")],
          force: optionalBooleanField(parsed, "force"),
          allowRiskIncrease: optionalBooleanField(parsed, "acknowledgeRiskIncrease") ?? false,
          disableCatalogIndexing: true,
        },
      );

      return c.json({ installed: outcome.installed, setupActions: outcome.setupActions });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardAccessClients, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "clients_list" },
      );

      return c.json({ clients: outcome.clients });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardAccessPendingLogins, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "pending_logins_list" },
      );

      return c.json({ pendingLogins: outcome.pendingLogins });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessPendingLogins, ":flowId/approve"), async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(
        c.req.json(),
        "Dashboard pending login approval request",
      );
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "pending_login_approve",
          flowId: requiredRouteParam(c.req.param("flowId")),
          grantedRole: optionalRemoteClientRole(parsed, "grantedRole"),
        },
      );

      if ("status" in outcome) return c.json({ error: "dashboard_auth_unavailable" }, 404);
      return c.json({ pendingLogin: outcome.pendingLogin });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessPendingLogins, ":flowId/deny"), async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "pending_login_deny", flowId: requiredRouteParam(c.req.param("flowId")) },
      );

      if ("status" in outcome) return c.json({ error: "dashboard_auth_unavailable" }, 404);
      return c.json({ pendingLogin: outcome.pendingLogin });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessClients, ":clientId/revoke"), async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "client_revoke", clientId: requiredRouteParam(c.req.param("clientId")) },
      );

      if ("status" in outcome) return c.json({ error: "dashboard_auth_unavailable" }, 404);
      if (outcome.sessionEnded) {
        dashboardSessionStore.delete(c.req.header("cookie"));
        c.header("set-cookie", expiredDashboardSessionCookie(paths.dashboard));
      }
      return c.json({
        revoked: outcome.revoked,
        clientId: outcome.clientId,
        sessionEnded: outcome.sessionEnded,
      });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessClients, ":clientId/role"), async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard remote client role request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "client_change_role",
          clientId: requiredRouteParam(c.req.param("clientId")),
          role: requiredRemoteClientRole(parsed, "role"),
        },
      );

      if (outcome.status === "credential_store_unavailable") {
        return c.json({ error: "dashboard_auth_unavailable" }, 404);
      }
      if (outcome.status === "not_found") return c.json({ error: "client_not_found" }, 404);
      if (outcome.sessionEnded) {
        dashboardSessionStore.delete(c.req.header("cookie"));
        c.header("set-cookie", expiredDashboardSessionCookie(paths.dashboard));
      }
      return c.json({ client: outcome.client, sessionEnded: outcome.sessionEnded });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardActivity, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const query = new URL(c.req.url).searchParams;
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "activity_list",
          limit: numberQueryParam(query.get("limit")),
          after: query.get("after") ?? undefined,
          action: optionalActivityAction(query.get("action") ?? undefined),
        },
      );

      return c.json(outcome.activity);
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardVault, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "vault_list" },
      );

      return c.json({ values: outcome.values, grants: outcome.grants });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultSet, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault set request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "vault_set",
          name: stringField(parsed, "key"),
          value: opaqueStringField(parsed, "value"),
          force: optionalBooleanField(parsed, "force"),
        },
      );

      return c.json({ status: outcome.status });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardVaultValues, ":key/delete"), async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "vault_delete", name: requiredRouteParam(c.req.param("key")) },
      );

      return c.json({ deleted: outcome.deleted });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultGrant, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault grant request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "vault_access_grant",
          storedKey: stringField(parsed, "storedKey"),
          referenceName: stringField(parsed, "referenceName"),
          capletId: stringField(parsed, "capletId"),
        },
      );

      return c.json({ grant: outcome.grant });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultRevoke, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault revoke request");
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "vault_access_revoke",
          storedKey: stringField(parsed, "storedKey"),
          referenceName: optionalStringField(parsed, "referenceName"),
          capletId: optionalStringField(parsed, "capletId"),
        },
      );

      return c.json({ revoked: outcome.revoked });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultReveal, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault reveal request");
      const key = stringField(parsed, "key");
      if (stringField(parsed, "confirmation") !== `reveal ${key}`) {
        throw new CapletsError("REQUEST_INVALID", "Vault reveal confirmation is invalid.");
      }
      const value = vaultStoreForAuthDir(io.control?.authDir).resolveValue(key);
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_value_revealed",
        target: { type: "vault", id: key },
        metadata: { confirmed: true },
      });
      return c.json({ key, value }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardRuntime, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        {
          kind: "runtime",
          baseUrl: remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
            c.req.header(name),
          ),
          bind: `${options.host}:${options.port}`,
          publicOrigin: options.publicOrigin ?? null,
        },
      );

      return c.json({ runtime: outcome.runtime, daemon: outcome.daemon });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardRuntimeRestart, async (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "runtime_restart" },
      );

      return c.json({ restartAvailable: outcome.restartAvailable, reason: outcome.reason }, 409);
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardLogs, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "logs", limit: numberQueryParam(new URL(c.req.url).searchParams.get("limit")) },
      );

      return c.json({
        entries: outcome.entries,
        limit: outcome.limit,
        truncated: outcome.truncated,
      });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardDiagnostics, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "diagnostics" },
      );

      return c.json({
        status: outcome.status,
        diagnostics: outcome.diagnostics,
        checks: outcome.checks,
      });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardEvents, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "runtime_event" },
      );

      return new Response(
        `id: ${Date.now()}\nevent: runtime_health\ndata: ${JSON.stringify(outcome.event)}\n\n`,
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        },
      );
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.get(paths.dashboardProjectBinding, async (c) => {
    const session = dashboardSessionForRequest(c);
    if (!session.ok) return session.response;
    try {
      const outcome = await currentHostOperations.execute(
        dashboardPrincipalForSession(c, session.session),
        { kind: "project_binding" },
      );

      return c.json({ projectBinding: outcome.projectBinding });
    } catch (error) {
      return currentHostErrorResponse(error);
    }
  });

  app.post(paths.dashboardLogout, (c) => {
    const session = dashboardSessionForRequest(c, {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    dashboardActivityLog.append({
      actorClientId: session.session.operatorClientId,
      action: "dashboard_logout",
      target: { type: "dashboard_session", id: session.session.sessionId },
    });
    dashboardSessionStore.delete(c.req.header("cookie"));
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
        const parsed = await parseJsonObject(c.req.json(), "Pending remote login start request");
        const clientLabel = optionalStringField(parsed, "clientLabel");
        const clientFingerprint = optionalStringField(parsed, "clientFingerprint");
        const hostUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
          c.req.header(name),
        );
        const pending = remoteCredentialStore.createPendingLogin({
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
            remoteCredentialStore.dir,
          ),
        });
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

    app.delete(paths.remoteClient, authenticatedClientRouteAuth, (c) => {
      const client = authenticatedRemoteClients.get(c.req.raw);
      if (!client) return c.text("Unauthorized", 401);
      try {
        return c.json({
          revoked: remoteCredentialStore.revokeClient(client.clientId),
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

  app.post(paths.control, currentHostDevelopmentGuard(options), operatorRouteAuth, async (c) => {
    let request: RemoteCliRequest;
    try {
      request = parseRemoteCliRequest(await c.req.json());
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
      authFlowStore,
      c.req.url,
      paths.control,
      options.publicOrigin,
      options.trustProxy,
      (name) => c.req.header(name),
    );
    return c.json(
      await dispatchRemoteCliRequest(request, context, {
        operations: currentHostOperations,
        principal: controlOperatorPrincipal(c),
      }),
    );
  });

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
      return {
        onOpen: (_event, ws) => {
          if (!validation.ok) {
            ws.close(1008, "Project Binding session was not found.");
            return;
          }
          sendProjectBindingReadyWhenOpen(ws, validation.record);
        },
        onMessage: (event, ws) => {
          if (!validation.ok) {
            ws.close(1008, "Project Binding session was not found.");
            return;
          }
          void parseProjectBindingSocketClientMessage(event.data)
            .then(async (message) => {
              if (!message) return;
              if (
                message.bindingId !== validation.record.bindingId ||
                message.sessionId !== validation.record.sessionId
              ) {
                ws.close(1008, "Project Binding message does not match this session.");
                return;
              }
              if (message.type === "heartbeat") {
                const updated = await updateProjectBindingHeartbeat(
                  validation.record,
                  message,
                  validation.durableClientId,
                );
                if (!updated) ws.close(1008, "Project Binding session is no longer authorized.");
                return;
              }
              const ended = await endProjectBindingRecord(
                validation.record,
                validation.durableClientId,
                message.reason,
              );
              if (!ended) {
                ws.close(1008, "Project Binding session is no longer authorized.");
                return;
              }
              ws.send(JSON.stringify({ type: "ended", reason: message.reason }));
              ws.close(1000, message.reason.message);
            })
            .catch((error) => {
              writeErr(`Project Binding WebSocket message failed: ${errorMessage(error)}\n`);
              ws.close(1011, "Project Binding message failed.");
            });
        },
        onError: (event) => {
          writeErr(`Project Binding WebSocket error: ${errorMessage(event)}\n`);
        },
        onClose: () => {
          if (!validation.ok) return;
          void endProjectBindingRecord(validation.record, undefined, {
            code: "interrupted",
            message: "Project Binding WebSocket closed.",
          }).catch((error) => {
            writeErr(`Project Binding WebSocket close cleanup failed: ${errorMessage(error)}\n`);
          });
        },
      };
    }),
  );

  app.get(routePath(paths.projectBindings, ":bindingId/status"), accessRouteAuth, (c) =>
    projectBindingStatusResponse(
      requiredRouteParam(c.req.param("bindingId")),
      projectBindingOwnerKey(c),
    ),
  );

  app.post(routePath(paths.projectBindings, "sessions"), accessRouteAuth, async (c) => {
    try {
      if (projectBindingSessionsClosing) {
        return c.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
      }
      const parsed = await parseJsonObject(c.req.json(), "Project Binding session request");
      const projectRoot = stringField(parsed, "projectRoot");
      const projectFingerprint =
        optionalStringField(parsed, "projectFingerprint") ?? fingerprintProjectRoot(projectRoot);
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
      await projectBindingWorkspaceStore.writeLease(projectBindingLease(record));
      if (projectBindingSessionsClosing) {
        await projectBindingWorkspaceStore.writeLease(
          projectBindingLease(terminalProjectBindingCandidate(record)),
        );
        return c.json({ ok: false, error: { code: "SERVER_UNAVAILABLE" } }, 503);
      }
      projectBindingSessions.set(bindingId, record);
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
      const parsed = await parseJsonObject(c.req.json(), "Project Binding heartbeat request");
      const sessionId = stringField(parsed, "sessionId");
      record = projectBindingRecordFor(bindingId, ownerKey);
      if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
      if (sessionId !== record.sessionId) {
        return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 403);
      }
      const updated = await updateProjectBindingHeartbeat(
        record,
        {
          type: "heartbeat",
          bindingId,
          sessionId,
          state: projectBindingStateField(parsed, "state", record.state),
          syncState: projectBindingSyncStateField(parsed, "syncState", record.syncState),
        },
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
    const bindingId = url.searchParams.get("bindingId") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const projectFingerprint = url.searchParams.get("projectFingerprint") ?? "";
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
    if (projectFingerprint && projectFingerprint !== record.projectFingerprint) {
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
      if (!canMutateProjectBindingRecord(record, ownerKey)) {
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
      await projectBindingWorkspaceStore.writeLease(projectBindingLease(candidate));

      if (!canCommitProjectBindingHeartbeat(record, ownerKey, generation, expiresAt)) {
        await terminalizeProjectBindingRecordInQueue(record, candidate);
        return false;
      }

      record.state = candidate.state;
      record.syncState = candidate.syncState;
      record.updatedAt = candidate.updatedAt;
      record.expiresAt = candidate.expiresAt;
      record.generation = candidate.generation;
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

  function canMutateProjectBindingRecord(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
  ): boolean {
    return (
      !projectBindingSessionsClosing &&
      projectBindingSessions.get(record.bindingId) === record &&
      record.active &&
      !record.terminal &&
      Date.parse(record.expiresAt) > Date.now() &&
      isCurrentProjectBindingAccessOwner(record, ownerKey)
    );
  }

  function canCommitProjectBindingHeartbeat(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
    generation: number,
    expiresAt: string,
  ): boolean {
    return (
      canMutateProjectBindingRecord(record, ownerKey) &&
      record.generation === generation &&
      record.expiresAt === expiresAt
    );
  }

  function isCurrentProjectBindingAccessOwner(
    record: ProjectBindingHttpRecord,
    ownerKey: string,
  ): boolean {
    if (record.ownerKey !== ownerKey) return false;
    if (!remoteCredentialStore) return ownerKey === "development_unauthenticated";
    const client = remoteCredentialStore
      .listClients()
      .find((candidate) => candidate.clientId === ownerKey);
    return client?.role === "access" && client.revokedAt === undefined;
  }

  async function terminalizeProjectBindingRecordInQueue(
    record: ProjectBindingHttpRecord,
    candidate?: ProjectBindingHttpRecord,
    removeCurrent = true,
  ): Promise<void> {
    const current = projectBindingSessions.get(record.bindingId) === record;
    const target = current ? record : candidate;
    if (!target) return;
    if (current && !record.terminal) terminalizeProjectBindingRecord(record);
    const terminal = current ? record : terminalProjectBindingCandidate(target);

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
    attempts = 20,
  ): void {
    setTimeout(() => {
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
      if (attempts > 1) sendProjectBindingReadyWhenOpen(ws, record, attempts - 1);
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
      if (!canMutateProjectBindingRecord(record, ownerKey)) {
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
        isCurrentProjectBindingAccessOwner(record, ownerKey);
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

  function projectBindingStatusResponse(bindingId: string, ownerKey: string): Response {
    const record = projectBindingRecordFor(bindingId, ownerKey);
    if (!record) {
      return new Response(JSON.stringify({ bindingId, state: "not_attached" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(projectBindingResponse(record)), {
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

  function projectBindingStateField(
    input: Record<string, unknown>,
    key: string,
    fallback: ProjectBindingState,
  ): ProjectBindingState {
    const value = optionalStringField(input, key);
    if (value === undefined) return fallback;
    if (!PROJECT_BINDING_STATES.includes(value as ProjectBindingState)) {
      throw new CapletsError("REQUEST_INVALID", `${key} must be a Project Binding state.`);
    }
    return value as ProjectBindingState;
  }

  function dashboardSessionForRequest(
    c: Parameters<MiddlewareHandler>[0],
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined } = {},
  ): { ok: true; session: DashboardSessionView } | { ok: false; response: Response } {
    return validateDashboardSession(c.req.header("cookie"), csrf, c.req.url, (name) =>
      c.req.header(name),
    );
  }

  function dashboardPrincipalForSession(
    c: Parameters<MiddlewareHandler>[0],
    session: DashboardSessionView,
  ): CurrentHostOperatorPrincipal {
    const hostUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
      c.req.header(name),
    );
    if (session.operatorClientId === "development_unauthenticated") {
      return trustedDevelopmentOperatorPrincipal(hostUrl);
    }
    return {
      clientId: session.operatorClientId,
      hostUrl,
      role: "operator",
    };
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

  function validateDashboardSession(
    cookieHeader: string | undefined,
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined },
    requestUrl: string,
    header: (name: string) => string | undefined,
  ): { ok: true; session: DashboardSessionView } | { ok: false; response: Response } {
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
    if (!remoteCredentialStore) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      };
    }
    try {
      return {
        ok: true,
        session: dashboardSessionStore.validate({
          cookieHeader,
          credentialStore: remoteCredentialStore,
          ...csrf,
        }),
      };
    } catch (error) {
      if (error instanceof CapletsError && error.code === "REQUEST_INVALID") {
        return { ok: false, response: new Response("Forbidden", { status: 403 }) };
      }
      if (error instanceof CapletsError && error.code === "SERVER_UNAVAILABLE") {
        return { ok: false, response: new Response("Service Unavailable", { status: 503 }) };
      }
      return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
    }
  }

  function projectBindingSyncStateField(
    input: Record<string, unknown>,
    key: string,
    fallback: ProjectBindingSyncState,
  ): ProjectBindingSyncState {
    const value = optionalStringField(input, key);
    if (value === undefined) return fallback;
    if (!PROJECT_BINDING_SYNC_STATES.includes(value as ProjectBindingSyncState)) {
      throw new CapletsError("REQUEST_INVALID", `${key} must be a Project Binding sync state.`);
    }
    return value as ProjectBindingSyncState;
  }

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
    projectBindingSessionsClosing = true;
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
    await Promise.all(
      [...projectBindingSessions.values()].map((record) => endProjectBindingRecord(record)),
    );
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
    globalCapletsRoot: io.control?.globalCapletsRoot ?? resolveCapletsRoot(io.control?.configPath),
    globalLockfilePath: io.control?.globalLockfilePath ?? defaultCapletsLockfilePath(),
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
  const remoteEngineOptions = sanitizeRemoteEngineOptions(engineOptions);
  const engine = new CapletsEngine(remoteEngineOptions);
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
  const engine = new CapletsEngine(remoteEngineOptions);
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
  dashboard: string;
  dashboardApi: string;
  dashboardLoginStart: string;
  dashboardLoginPoll: string;
  dashboardLoginComplete: string;
  dashboardSession: string;
  dashboardLogout: string;
  dashboardSummary: string;
  dashboardCaplets: string;
  dashboardCatalogSearch: string;
  dashboardCatalogDetail: string;
  dashboardCatalogInstall: string;
  dashboardCatalogUpdates: string;
  dashboardCatalogUpdate: string;
  dashboardAccessClients: string;
  dashboardAccessPendingLogins: string;
  dashboardVault: string;
  dashboardVaultValues: string;
  dashboardVaultSet: string;
  dashboardVaultGrant: string;
  dashboardVaultRevoke: string;
  dashboardVaultReveal: string;
  dashboardRuntime: string;
  dashboardRuntimeRestart: string;
  dashboardLogs: string;
  dashboardDiagnostics: string;
  dashboardEvents: string;
  dashboardProjectBinding: string;
  dashboardActivity: string;
  health: string;
} {
  const version = routePath(base, "v1");
  const attach = routePath(version, "attach");
  const remote = routePath(version, "remote");
  const dashboard = routePath(base, "dashboard");
  const dashboardApi = routePath(dashboard, "api");
  const dashboardLogin = routePath(dashboardApi, "login");
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
    dashboard,
    dashboardApi,
    dashboardLoginStart: routePath(dashboardLogin, "start"),
    dashboardLoginPoll: routePath(dashboardLogin, "poll"),
    dashboardLoginComplete: routePath(dashboardLogin, "complete"),
    dashboardSession: routePath(dashboardApi, "session"),
    dashboardLogout: routePath(dashboardApi, "logout"),
    dashboardSummary: routePath(dashboardApi, "summary"),
    dashboardCaplets: routePath(dashboardApi, "caplets"),
    dashboardCatalogSearch: routePath(dashboardApi, "catalog/search"),
    dashboardCatalogDetail: routePath(dashboardApi, "catalog/detail"),
    dashboardCatalogInstall: routePath(dashboardApi, "catalog/install"),
    dashboardCatalogUpdates: routePath(dashboardApi, "catalog/updates"),
    dashboardCatalogUpdate: routePath(dashboardApi, "catalog/update"),
    dashboardAccessClients: routePath(dashboardApi, "access/clients"),
    dashboardAccessPendingLogins: routePath(dashboardApi, "access/pending-logins"),
    dashboardVault: routePath(dashboardApi, "vault"),
    dashboardVaultValues: routePath(dashboardApi, "vault/values"),
    dashboardVaultSet: routePath(dashboardApi, "vault/values"),
    dashboardVaultGrant: routePath(dashboardApi, "vault/grants"),
    dashboardVaultRevoke: routePath(dashboardApi, "vault/grants/revoke"),
    dashboardVaultReveal: routePath(dashboardApi, "vault/reveal"),
    dashboardRuntime: routePath(dashboardApi, "runtime"),
    dashboardRuntimeRestart: routePath(dashboardApi, "runtime/restart"),
    dashboardLogs: routePath(dashboardApi, "logs"),
    dashboardDiagnostics: routePath(dashboardApi, "diagnostics"),
    dashboardEvents: routePath(dashboardApi, "events"),
    dashboardProjectBinding: routePath(dashboardApi, "project-binding"),
    dashboardActivity: routePath(dashboardApi, "activity"),
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

function requiredQueryParam(params: URLSearchParams, key: string): string {
  const value = params.get(key);
  if (!value) throw new CapletsError("REQUEST_INVALID", `${key} is required.`);
  return value;
}

function optionalBooleanField(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be a boolean.`);
}

function requiredRemoteClientRole(input: Record<string, unknown>, key: string): RemoteClientRole {
  const value = stringField(input, key);
  if (value === "access" || value === "operator") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be access or operator.`);
}

function optionalRemoteClientRole(
  input: Record<string, unknown>,
  key: string,
): RemoteClientRole | undefined {
  const value = optionalStringField(input, key);
  if (value === undefined) return undefined;
  if (value === "access" || value === "operator") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be access or operator.`);
}

function numberQueryParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalActivityAction(value: string | undefined): DashboardActivityAction | undefined {
  if (value === undefined) return undefined;
  return isDashboardActivityAction(value) ? value : undefined;
}

function isDashboardActivityAction(value: string): value is DashboardActivityAction {
  return (
    value === "dashboard_login_completed" ||
    value === "dashboard_logout" ||
    value === "pending_login_approved" ||
    value === "pending_login_denied" ||
    value === "remote_client_revoked" ||
    value === "remote_client_role_changed" ||
    value === "catalog_installed" ||
    value === "catalog_updated" ||
    value === "vault_set" ||
    value === "vault_deleted" ||
    value === "vault_grant_added" ||
    value === "vault_grant_revoked" ||
    value === "vault_value_revealed" ||
    value === "runtime_restart_requested"
  );
}

function routeAuth(
  options: HttpServeOptions,
  remoteCredentialStore: RemoteServerCredentialStore | undefined,
  basePath: string,
  requiredRole: RemoteClientRole | undefined,
  retainAuthenticatedClient:
    | ((request: Request, client: ValidatedRemoteClient) => void)
    | undefined,
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
    const header = authorizationHeaderForRequest(c);
    const token = bearerToken(header);
    if (!token) {
      return c.text("Unauthorized", 401);
    }
    try {
      const client = remoteCredentialStore.validateAccessToken({
        hostUrl: remoteCredentialHostUrl(c.req.url, basePath, options, (name) =>
          c.req.header(name),
        ),
        accessToken: token,
      });
      if (requiredRole !== undefined && client.role !== requiredRole) {
        return c.text(`Forbidden: ${requiredRole} role required`, 403);
      }
      retainAuthenticatedClient?.(c.req.raw, client);
    } catch {
      return c.text("Unauthorized", 401);
    }
    await next();
  };
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
  if (!isRecord(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} JSON must be an object.`);
  }
  return parsed;
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
function opaqueStringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string.`);
  }
  return value;
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
): Promise<ProjectBindingSocketClientMessage | undefined> {
  const text = await socketMessageText(data);
  if (!text) return undefined;
  const parsed = JSON.parse(text) as Partial<ProjectBindingSocketClientMessage>;
  if (
    parsed.type === "heartbeat" &&
    typeof parsed.bindingId === "string" &&
    typeof parsed.sessionId === "string" &&
    PROJECT_BINDING_STATES.includes(parsed.state as ProjectBindingState) &&
    PROJECT_BINDING_SYNC_STATES.includes(parsed.syncState as ProjectBindingSyncState)
  ) {
    return parsed as ProjectBindingSocketClientMessage;
  }
  if (
    parsed.type === "end" &&
    typeof parsed.bindingId === "string" &&
    typeof parsed.sessionId === "string" &&
    isBindingTerminalReason(parsed.reason)
  ) {
    return parsed as ProjectBindingSocketClientMessage;
  }
  return undefined;
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

function isBindingTerminalReason(value: unknown): value is BindingTerminalReason {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Partial<BindingTerminalReason>).code === "string" &&
    typeof (value as Partial<BindingTerminalReason>).message === "string"
  );
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
