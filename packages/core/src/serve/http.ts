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
  type ConfigSourceKind,
} from "../config";
import { version as packageJsonVersion } from "../../package.json";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError, type CapletsErrorCode } from "../errors";
import { dashboardSessionCookie, expiredDashboardSessionCookie } from "../dashboard/auth";
import {
  dashboardCatalogDetail,
  dashboardCatalogSearch,
  dashboardInstallCatalogCaplet,
  dashboardInstalledCaplets,
  dashboardUpdateCatalogCaplet,
  dashboardUpdateReadiness,
} from "../dashboard/catalog";
import {
  DashboardActivityLog,
  type DashboardActivityAction,
  roleChangeMetadata,
} from "../dashboard/activity-log";
import { dashboardShell, dashboardStaticResponse } from "../dashboard/routes";
import { DashboardSessionStore } from "../dashboard/session-store";
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
import type { RemoteClientRole } from "../remote/server-credentials";
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
  const projectBindingWorkspaceStore =
    io.projectBindingWorkspaceStore ?? new ProjectBindingWorkspaceStore();
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
  const operatorRouteAuth = routeAuth(options, remoteCredentialStore, paths.base, "operator");
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
        flowId: stringField(parsed, "flowId"),
        pendingCompletionSecret: stringField(parsed, "pendingCompletionSecret"),
      });
      if (credentials.role !== "operator") {
        return c.json({ error: "operator_role_required" }, 403);
      }
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
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({ authenticated: true, session: session.session });
  });

  app.get(paths.dashboardSummary, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json(dashboardSummary(c.req.url, (name) => c.req.header(name)));
  });

  app.get(paths.dashboardCaplets, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({
      caplets: dashboardInstalledCaplets(engine.enabledServers(), dashboardCatalogContext()),
    });
  });

  app.get(paths.dashboardCatalogSearch, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    try {
      const query = new URL(c.req.url).searchParams;
      return c.json(
        dashboardCatalogSearch({
          source: requiredQueryParam(query, "source"),
          query: query.get("q") ?? undefined,
          limit: numberQueryParam(query.get("limit")),
        }),
      );
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardCatalogDetail, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    try {
      const query = new URL(c.req.url).searchParams;
      return c.json(
        dashboardCatalogDetail({
          source: requiredQueryParam(query, "source"),
          capletId: requiredQueryParam(query, "id"),
        }),
      );
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardCatalogUpdates, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json(dashboardUpdateReadiness({ context: dashboardCatalogContext() }));
  });

  app.post(paths.dashboardCatalogInstall, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard catalog install request");
      const result = await dashboardInstallCatalogCaplet({
        source: stringField(parsed, "source"),
        capletId: stringField(parsed, "capletId"),
        force: optionalBooleanField(parsed, "force"),
        context: dashboardCatalogContext(),
      });
      for (const installed of result.installed) {
        dashboardActivityLog.append({
          actorClientId: session.session.operatorClientId,
          action: "catalog_installed",
          target: { type: "catalog", id: installed.id },
          metadata: { status: installed.status ?? null, kind: installed.kind },
        });
      }
      return c.json(result);
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(paths.dashboardCatalogUpdate, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard catalog update request");
      const result = await dashboardUpdateCatalogCaplet({
        capletId: stringField(parsed, "capletId"),
        force: optionalBooleanField(parsed, "force"),
        allowRiskIncrease: optionalBooleanField(parsed, "acknowledgeRiskIncrease") ?? false,
        context: dashboardCatalogContext(),
      });
      for (const installed of result.installed) {
        dashboardActivityLog.append({
          actorClientId: session.session.operatorClientId,
          action: "catalog_updated",
          target: { type: "catalog", id: installed.id },
          metadata: {
            status: installed.status ?? null,
            riskAcknowledged: optionalBooleanField(parsed, "acknowledgeRiskIncrease") ?? false,
          },
        });
      }
      return c.json(result);
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardAccessClients, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({ clients: remoteCredentialStore?.listClients() ?? [] });
  });

  app.get(paths.dashboardAccessPendingLogins, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({
      pendingLogins: (remoteCredentialStore?.listPendingLogins() ?? []).filter(
        (login) => login.status === "pending" || login.status === "approved",
      ),
    });
  });

  app.post(routePath(paths.dashboardAccessPendingLogins, ":flowId/approve"), async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(
        c.req.json(),
        "Dashboard pending login approval request",
      );
      const pendingLogin = remoteCredentialStore.approvePendingLoginFlow({
        flowId: requiredRouteParam(c.req.param("flowId")),
        grantedRole: optionalRemoteClientRole(parsed, "grantedRole"),
      });
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "pending_login_approved",
        target: {
          type: "pending_login",
          id: pendingLogin.flowId,
          label: pendingLogin.clientLabel,
        },
        metadata: {
          requestedRole: pendingLogin.requestedRole,
          grantedRole: pendingLogin.grantedRole ?? pendingLogin.requestedRole,
        },
      });
      return c.json({ pendingLogin });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessPendingLogins, ":flowId/deny"), (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const pendingLogin = remoteCredentialStore.denyPendingLoginFlow({
        flowId: requiredRouteParam(c.req.param("flowId")),
      });
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "pending_login_denied",
        target: {
          type: "pending_login",
          id: pendingLogin.flowId,
          label: pendingLogin.clientLabel,
        },
        metadata: { requestedRole: pendingLogin.requestedRole },
      });
      return c.json({ pendingLogin });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardAccessClients, ":clientId/revoke"), (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    const clientId = requiredRouteParam(c.req.param("clientId"));
    const client = remoteCredentialStore
      .listClients()
      .find((candidate) => candidate.clientId === clientId);
    const revoked = remoteCredentialStore.revokeClient(clientId);
    if (revoked) {
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "remote_client_revoked",
        target: {
          type: "remote_client",
          id: clientId,
          ...(client ? { label: client.clientLabel } : {}),
        },
        metadata: { role: client?.role ?? null },
      });
    }
    const sessionEnded = clientId === session.session.operatorClientId && revoked;
    if (sessionEnded) c.header("set-cookie", expiredDashboardSessionCookie(paths.dashboard));
    return c.json({ revoked, clientId, sessionEnded });
  });

  app.post(routePath(paths.dashboardAccessClients, ":clientId/role"), async (c) => {
    if (!remoteCredentialStore) return c.json({ error: "dashboard_auth_unavailable" }, 404);
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const clientId = requiredRouteParam(c.req.param("clientId"));
      const parsed = await parseJsonObject(c.req.json(), "Dashboard remote client role request");
      const role = requiredRemoteClientRole(parsed, "role");
      const before = remoteCredentialStore
        .listClients()
        .find((candidate) => candidate.clientId === clientId);
      const client = remoteCredentialStore.changeClientRole(clientId, role);
      if (!client) return c.json({ error: "client_not_found" }, 404);
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "remote_client_role_changed",
        target: { type: "remote_client", id: client.clientId, label: client.clientLabel },
        metadata: roleChangeMetadata(before?.role ?? client.role, client.role),
      });
      const sessionEnded =
        clientId === session.session.operatorClientId && client.role !== "operator";
      if (sessionEnded) c.header("set-cookie", expiredDashboardSessionCookie(paths.dashboard));
      return c.json({ client, sessionEnded });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardActivity, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    const query = new URL(c.req.url).searchParams;
    return c.json(
      dashboardActivityLog.list({
        limit: numberQueryParam(query.get("limit")),
        after: query.get("after") ?? undefined,
        action: optionalActivityAction(query.get("action") ?? undefined),
      }),
    );
  });

  app.get(paths.dashboardVault, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    const vault = dashboardVaultStore();
    return c.json({
      values: vault.listValues(),
      grants: vault.listAccess().map(redactedVaultGrant),
    });
  });

  app.post(paths.dashboardVaultSet, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault set request");
      const key = stringField(parsed, "key");
      const status = dashboardVaultStore().set(key, stringField(parsed, "value"), {
        force: optionalBooleanField(parsed, "force") ?? false,
      });
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_set",
        target: { type: "vault", id: status.key },
        metadata: { valueBytes: status.valueBytes ?? null },
      });
      return c.json({ status });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(routePath(paths.dashboardVaultValues, ":key/delete"), (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const deleted = dashboardVaultStore().delete(requiredRouteParam(c.req.param("key")));
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_deleted",
        target: { type: "vault", id: deleted.key },
        metadata: { deleted: deleted.deleted, grantsRetained: deleted.grantsRetained },
      });
      return c.json({ deleted });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultGrant, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault grant request");
      const grant = dashboardVaultStore().grantAccess({
        storedKey: stringField(parsed, "storedKey"),
        referenceName: stringField(parsed, "referenceName"),
        capletId: stringField(parsed, "capletId"),
        origin: vaultOriginField(parsed),
      });
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_grant_added",
        target: { type: "vault", id: grant.storedKey },
        metadata: {
          referenceName: grant.referenceName,
          capletId: grant.capletId,
          originKind: grant.origin.kind,
        },
      });
      return c.json({ grant: redactedVaultGrant(grant) });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultRevoke, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    try {
      const parsed = await parseJsonObject(c.req.json(), "Dashboard Vault revoke request");
      const revoked = dashboardVaultStore().revokeAccess({
        storedKey: stringField(parsed, "storedKey"),
        ...optionalStringObjectProp(parsed, "referenceName"),
        ...optionalStringObjectProp(parsed, "capletId"),
      });
      for (const grant of revoked) {
        dashboardActivityLog.append({
          actorClientId: session.session.operatorClientId,
          action: "vault_grant_revoked",
          target: { type: "vault", id: grant.storedKey },
          metadata: {
            referenceName: grant.referenceName,
            capletId: grant.capletId,
            originKind: grant.origin.kind,
          },
        });
      }
      return c.json({ revoked: revoked.map(redactedVaultGrant) });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.post(paths.dashboardVaultReveal, async (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
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
      const value = dashboardVaultStore().resolveValue(key);
      dashboardActivityLog.append({
        actorClientId: session.session.operatorClientId,
        action: "vault_value_revealed",
        target: { type: "vault", id: key },
        metadata: { confirmed: true },
      });
      return c.json({ key, value }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return remoteCredentialErrorResponse(error);
    }
  });

  app.get(paths.dashboardRuntime, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    const baseUrl = remoteCredentialHostUrl(c.req.url, paths.base, options, (name) =>
      c.req.header(name),
    );
    return c.json({
      runtime: {
        status: "ok",
        version: packageJsonVersion,
        bind: `${options.host}:${options.port}`,
        baseUrl,
        publicOrigin: options.publicOrigin ?? null,
      },
      daemon: { restartAvailable: false, stopAvailable: false, uninstallAvailable: false },
    });
  });

  app.post(paths.dashboardRuntimeRestart, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
      requireCsrf: true,
      csrfToken: c.req.header("x-caplets-csrf"),
    });
    if (!session.ok) return session.response;
    return c.json({ restartAvailable: false, reason: "daemon_manager_unavailable" }, 409);
  });

  app.get(paths.dashboardLogs, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    const limit = numberQueryParam(new URL(c.req.url).searchParams.get("limit")) ?? 100;
    return c.json({ entries: [], limit: Math.min(500, Math.max(1, limit)), truncated: false });
  });

  app.get(paths.dashboardDiagnostics, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({
      status: "ok",
      diagnostics: [],
      checks: [
        { id: "runtime", status: "ok" },
        { id: "dashboard", status: "ok" },
      ],
    });
  });

  app.get(paths.dashboardEvents, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    const event = {
      type: "runtime_health",
      runtime: { status: "ok", version: packageJsonVersion },
      projectBinding: { state: "disconnected" },
    };
    return new Response(
      `id: ${Date.now()}\nevent: runtime_health\ndata: ${JSON.stringify(event)}\n\n`,
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  });

  app.get(paths.dashboardProjectBinding, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"));
    if (!session.ok) return session.response;
    return c.json({
      projectBinding: {
        state: "disconnected",
        affectedCaplets: [],
        actions: [
          {
            id: "attach-project",
            label: "Attach project from a client",
            enabled: false,
            reason: "Project Binding sessions are started by Access Clients.",
          },
        ],
      },
    });
  });

  app.post(paths.dashboardLogout, (c) => {
    const session = validateDashboardSession(c.req.header("cookie"), {
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

  function pruneExpiredProjectBindingSessions(): void {
    const now = Date.now();
    for (const [bindingId, record] of projectBindingSessions) {
      if (record.active && Date.parse(record.expiresAt) > now) continue;
      projectBindingSessions.delete(bindingId);
    }
  }

  app.post(paths.control, operatorRouteAuth, async (c) => {
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

  app.get(
    routePath(paths.projectBindings, "connect"),
    protectedRouteAuth,
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
                await updateProjectBindingHeartbeat(validation.record, message);
                return;
              }
              await endProjectBindingRecord(validation.record, message.reason);
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
          void endProjectBindingRecord(validation.record, {
            code: "interrupted",
            message: "Project Binding WebSocket closed.",
          }).catch((error) => {
            writeErr(`Project Binding WebSocket close cleanup failed: ${errorMessage(error)}\n`);
          });
        },
      };
    }),
  );

  app.get(routePath(paths.projectBindings, ":bindingId/status"), protectedRouteAuth, (c) =>
    projectBindingStatusResponse(
      requiredRouteParam(c.req.param("bindingId")),
      projectBindingOwnerKey(c),
    ),
  );

  app.post(routePath(paths.projectBindings, "sessions"), protectedRouteAuth, async (c) => {
    try {
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
      };
      await projectBindingWorkspaceStore.writeLease(projectBindingLease(record));
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

  app.get(routePath(paths.projectBindings, ":bindingId/session"), protectedRouteAuth, (c) => {
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

  app.post(
    routePath(paths.projectBindings, ":bindingId/heartbeat"),
    protectedRouteAuth,
    async (c) => {
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
        await updateProjectBindingHeartbeat(record, {
          type: "heartbeat",
          bindingId,
          sessionId,
          state: projectBindingStateField(parsed, "state", record.state),
          syncState: projectBindingSyncStateField(parsed, "syncState", record.syncState),
        });
        return c.json({ ok: true, binding: projectBindingResponse(record) });
      } catch (error) {
        const safe = toSafeError(
          error,
          error instanceof CapletsError ? error.code : "REQUEST_INVALID",
        );
        return c.json({ ok: false, error: safe }, error instanceof CapletsError ? 400 : 500);
      }
    },
  );

  app.delete(
    routePath(paths.projectBindings, ":bindingId/session"),
    protectedRouteAuth,
    async (c) => {
      const bindingId = requiredRouteParam(c.req.param("bindingId"));
      const record = projectBindingRecordFor(bindingId, projectBindingOwnerKey(c));
      if (!record) return c.json({ ok: false, error: { code: "REQUEST_INVALID" } }, 404);
      await endProjectBindingRecord(record);
      return c.json({ ok: true, binding: projectBindingResponse(record) });
    },
  );

  function projectBindingSocketRecordForRequest(
    c: Parameters<MiddlewareHandler>[0],
  ): { ok: true; record: ProjectBindingHttpRecord } | { ok: false; response: Response } {
    const url = new URL(c.req.url);
    const bindingId = url.searchParams.get("bindingId") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const projectFingerprint = url.searchParams.get("projectFingerprint") ?? "";
    const record = projectBindingRecordFor(bindingId, projectBindingOwnerKey(c));
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
    return { ok: true, record };
  }

  async function updateProjectBindingHeartbeat(
    record: ProjectBindingHttpRecord,
    message: Extract<ProjectBindingSocketClientMessage, { type: "heartbeat" }>,
  ): Promise<void> {
    record.state = message.state;
    record.syncState = message.syncState;
    record.updatedAt = new Date().toISOString();
    record.expiresAt = new Date(
      Date.parse(record.updatedAt) + PROJECT_BINDING_LEASE_TTL_MS,
    ).toISOString();
    record.active = true;
    await projectBindingWorkspaceStore.writeLease(projectBindingLease(record));
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
    _reason?: BindingTerminalReason | undefined,
  ): Promise<void> {
    if (!projectBindingSessions.has(record.bindingId) || !record.active) return;
    record.state = "ended";
    record.syncState = "not_started";
    record.active = false;
    record.updatedAt = new Date().toISOString();
    await projectBindingWorkspaceStore.writeLease(projectBindingLease(record));
    projectBindingSessions.delete(record.bindingId);
  }

  function projectBindingOwnerKey(c: Parameters<MiddlewareHandler>[0]): string {
    if (!remoteCredentialStore) return "development_unauthenticated";
    return validatedRemoteClient(
      authorizationHeaderForRequest(c),
      remoteCredentialStore,
      c.req.url,
      paths.base,
      options,
      (name) => c.req.header(name),
    ).clientId;
  }

  function projectBindingRecordFor(
    bindingId: string,
    ownerKey: string,
  ): ProjectBindingHttpRecord | undefined {
    const record = projectBindingSessions.get(bindingId);
    if (!record || record.ownerKey !== ownerKey) return undefined;
    if (!record.active || Date.parse(record.expiresAt) <= Date.now()) {
      projectBindingSessions.delete(bindingId);
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

  function dashboardCatalogContext() {
    return {
      control: io.control
        ? {
            ...io.control,
            projectCapletsRoot: io.control.projectCapletsRoot,
            globalCapletsRoot: io.control.globalCapletsRoot,
            globalLockfilePath: io.control.globalLockfilePath,
          }
        : undefined,
    };
  }

  function dashboardVaultStore() {
    return vaultStoreForAuthDir(io.control?.authDir);
  }

  function validateDashboardSession(
    cookieHeader: string | undefined,
    csrf: { requireCsrf?: boolean; csrfToken?: string | undefined } = {},
  ):
    | { ok: true; session: ReturnType<DashboardSessionStore["validate"]> }
    | { ok: false; response: Response } {
    if (!remoteCredentialStore && options.auth.type === "development_unauthenticated") {
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
      return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
    }
  }

  function dashboardSummary(requestUrl: string, header: (name: string) => string | undefined) {
    const baseUrl = remoteCredentialHostUrl(requestUrl, paths.base, options, header);
    const dashboardUrl = new URL(
      paths.dashboard,
      publicRequestOrigin(requestUrl, options.trustProxy, header),
    ).toString();
    const pendingLogins = remoteCredentialStore?.listPendingLogins() ?? [];
    const clients = remoteCredentialStore?.listClients() ?? [];
    const caplets = engine.enabledServers();
    const vault = vaultStoreForAuthDir(io.control?.authDir);
    const vaultValues = vault.listValues();
    return {
      host: {
        current: true,
        baseUrl,
        dashboardUrl,
        version: packageJsonVersion,
        roleModel: "current-host",
      },
      attention: pendingLogins
        .filter((login) => login.status === "pending")
        .map((login) => ({
          kind: "pending-login",
          severity: "warning",
          label: `${login.clientLabel} is waiting for ${login.requestedRole} approval`,
          href: "/dashboard#access",
        })),
      sections: {
        caplets: { count: caplets.length, href: "/dashboard#caplets" },
        catalog: { href: "/dashboard#catalog" },
        access: {
          clients: clients.length,
          pending: pendingLogins.filter((login) => login.status === "pending").length,
          href: "/dashboard#access",
        },
        vault: { count: vaultValues.length, href: "/dashboard#vault" },
        projectBinding: { state: "disconnected", href: "/dashboard#project-binding" },
        runtime: { status: "ok", href: "/dashboard#runtime" },
        logs: { href: "/dashboard#logs" },
        diagnostics: { href: "/dashboard#diagnostics" },
        activity: { href: "/dashboard#activity" },
        settings: { href: "/dashboard#settings" },
      },
    };
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
    projectBindingSessions.clear();
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
      globalCapletsRoot: resolveCapletsRoot(resolvedEngineOptions.configPath),
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
      globalCapletsRoot: resolveCapletsRoot(resolvedEngineOptions.configPath),
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

function redactedVaultGrant(grant: {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: { kind: string; path?: string | undefined };
  createdAt: string;
  updatedAt: string;
}) {
  return {
    storedKey: grant.storedKey,
    referenceName: grant.referenceName,
    capletId: grant.capletId,
    origin: { kind: grant.origin.kind },
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

function vaultOriginField(input: Record<string, unknown>) {
  const origin = input.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
    throw new CapletsError("REQUEST_INVALID", "origin is required.");
  }
  const record = origin as Record<string, unknown>;
  const kind = stringField(record, "kind");
  if (
    kind !== "global-config" &&
    kind !== "global-file" &&
    kind !== "project-config" &&
    kind !== "project-file"
  ) {
    throw new CapletsError("REQUEST_INVALID", "origin.kind is invalid.");
  }
  return { kind: kind as ConfigSourceKind, path: stringField(record, "path") };
}

function optionalStringObjectProp(
  input: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = optionalStringField(input, key);
  return value === undefined ? {} : { [key]: value };
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
  requiredRole?: RemoteClientRole | undefined,
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
      if (requiredRole === "operator" && client.role !== "operator") {
        return c.text("Forbidden: operator role required", 403);
      }
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
    hostUrl: remoteCredentialHostUrl(requestUrl, basePath, options, header),
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
