import { canonicalizeCurrentHostOrigin } from "../current-host-origin";
import type { Auth, Client, Config } from "../generated/client";
import type { ProjectBinding } from "../generated/types.gen";
import type {
  BindingTerminalReason,
  ProjectBindingSocketClientMessage,
  ProjectBindingSocketServerMessage,
  ProjectBindingState,
  ProjectBindingSyncState,
} from "./protocol";
import {
  closeProjectBindingSocket,
  defaultProjectBindingWebSocketFactory,
  listenToProjectBindingSocket,
  PROJECT_BINDING_SOCKET_CLOSED,
  PROJECT_BINDING_SOCKET_CLOSING,
  PROJECT_BINDING_SOCKET_OPEN,
  PROJECT_BINDING_SOCKET_PROTOCOL,
  type ProjectBindingWebSocket,
  type ProjectBindingWebSocketFactory,
} from "./transport";

const HEARTBEAT_INTERVAL_MS = 15_000;
const FINALIZATION_ACK_TIMEOUT_MS = 1_000;
const FINALIZATION_CLEANUP_TIMEOUT_MS = 1_000;
const BEARER_AUTH = { scheme: "bearer", type: "http" } as const satisfies Auth;

const PROJECT_BINDING_STATES = new Set<ProjectBindingState>([
  "not_attached",
  "attaching",
  "syncing",
  "ready",
  "degraded",
  "blocked",
  "offline",
  "cleaning_up",
  "ended",
  "expired",
]);
const PROJECT_BINDING_SYNC_STATES = new Set<ProjectBindingSyncState>([
  "not_started",
  "pending",
  "syncing",
  "idle",
  "failed",
]);
const PROJECT_BINDING_TERMINAL_REASON_CODES = new Set<BindingTerminalReason["code"]>([
  "project_binding_forbidden",
  "endpoint_unavailable",
  "websocket_upgrade_required",
  "sync_required",
  "sync_failed",
  "sync_size_limit_exceeded",
  "lease_conflict",
  "lease_expired",
  "policy_denied",
  "remote_credentials_required",
  "remote_credentials_revoked",
  "remote_auth_failed",
  "interrupted",
  "completed",
]);

export type ProjectBindingSessionEvent =
  | {
      type: "state";
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
      requestId?: string;
    }
  | {
      type: "ready";
      bindingId: string;
      sessionId: string;
      projectRoot: string;
      projectFingerprint: string;
      webSocketUrl: string;
      syncState: ProjectBindingSyncState;
      requestId?: string;
    }
  | {
      type: "reconnecting";
      bindingId: string;
      sessionId: string;
      attempt: 1;
      reason: "socket_closed" | "socket_error";
    }
  | {
      type: "heartbeat";
      bindingId: string;
      sessionId: string;
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
    }
  | {
      type: "ended";
      bindingId: string;
      sessionId: string;
      reason: BindingTerminalReason;
    };

export type ProjectBindingSessionData = {
  bindingId: string;
  sessionId: string;
  projectRoot: string;
  projectFingerprint: string;
  webSocketUrl: string;
  ended: true;
};

export type ProjectBindingSessionErrorKind =
  | "http"
  | "protocol"
  | "socket"
  | "callback"
  | "aborted"
  | "cleanup";

export type ProjectBindingHttpErrorDetail = {
  status?: number;
  code?: string;
};

export type ProjectBindingCleanupError = {
  kind: ProjectBindingSessionErrorKind;
  message: string;
  status?: number;
  code?: string;
};

export class ProjectBindingSessionError extends Error {
  override readonly name = "ProjectBindingSessionError";
  readonly kind: ProjectBindingSessionErrorKind;
  readonly response?: Response;
  readonly http?: ProjectBindingHttpErrorDetail;
  cleanup?: ProjectBindingCleanupError;

  constructor(
    kind: ProjectBindingSessionErrorKind,
    message: string,
    options: { response?: Response; http?: ProjectBindingHttpErrorDetail } = {},
  ) {
    super(message);
    this.kind = kind;
    if (options.response) this.response = options.response;
    if (options.http) this.http = options.http;
  }

  attachCleanup(detail: ProjectBindingCleanupError): void {
    if (!this.cleanup) this.cleanup = detail;
  }
}

export type ProjectBindingSessionResult =
  | { data: ProjectBindingSessionData; error: undefined }
  | { data: undefined; error: ProjectBindingSessionError };

export type RunProjectBindingSessionInput<ThrowOnError extends boolean = false> = {
  client: Client;
  webSocketUrl: string;
  projectRoot: string;
  projectFingerprint: string;
  signal?: AbortSignal;
  onEvent?: (event: ProjectBindingSessionEvent) => void;
  webSocketFactory?: ProjectBindingWebSocketFactory;
  throwOnError?: ThrowOnError;
};

type ProjectBindingTransportUrls = {
  publicWebSocketUrl: string;
  socketUrl: URL;
  sessionsUrl: URL;
  heartbeatUrl(bindingId: string): URL;
  sessionUrl(bindingId: string): URL;
};

type ProjectBindingCreatedIdentity = {
  bindingId: string;
  sessionId: string;
};

type TerminalTrigger = {
  primary?: ProjectBindingSessionError;
  reason: BindingTerminalReason;
  remoteConfirmed: boolean;
};

type SocketConnection = {
  generation: number;
  socket: ProjectBindingWebSocket;
  opened: boolean;
  lifecycleController: AbortController;
  unlinkCallerAbort: () => void;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatPromise?: Promise<void>;
  disposeListeners: () => void;
};

type AcknowledgementOutcome = {
  acknowledged: boolean;
  error?: ProjectBindingSessionError;
};

type AcknowledgementWaiter = {
  promise: Promise<AcknowledgementOutcome>;
  settle: (outcome: AcknowledgementOutcome) => void;
  dispose: () => void;
};

type ProjectBindingSessionModeInput<ThrowOnError extends boolean> = [ThrowOnError] extends [true]
  ? RunProjectBindingSessionInput<ThrowOnError> & { throwOnError: true }
  : [ThrowOnError] extends [false]
    ? RunProjectBindingSessionInput<ThrowOnError> & { throwOnError?: false }
    : RunProjectBindingSessionInput<ThrowOnError> & { throwOnError: ThrowOnError };

export function runProjectBindingSession(
  input: ProjectBindingSessionModeInput<false>,
): Promise<ProjectBindingSessionResult>;
export function runProjectBindingSession(
  input: ProjectBindingSessionModeInput<true>,
): Promise<ProjectBindingSessionData>;
export function runProjectBindingSession<ThrowOnError extends boolean = false>(
  input: ProjectBindingSessionModeInput<ThrowOnError>,
): Promise<ThrowOnError extends true ? ProjectBindingSessionData : ProjectBindingSessionResult>;
export async function runProjectBindingSession(
  input: RunProjectBindingSessionInput<boolean>,
): Promise<ProjectBindingSessionData | ProjectBindingSessionResult> {
  const result = await runProjectBindingSessionFields(input);
  if (input.throwOnError === true) {
    if (result.error) throw result.error;
    return result.data;
  }
  return result;
}

async function runProjectBindingSessionFields(
  input: RunProjectBindingSessionInput<boolean>,
): Promise<ProjectBindingSessionResult> {
  const validated = validateInput(input);
  if (validated instanceof ProjectBindingSessionError) return failure(validated);

  const { projectRoot, projectFingerprint, transportUrls } = validated;
  if (input.signal?.aborted) return failure(abortedError());

  const initialCallbackError = emitEvent(input.onEvent, {
    type: "state",
    state: "attaching",
    syncState: "pending",
  });
  if (initialCallbackError) return failure(initialCallbackError);
  if (input.signal?.aborted) return failure(abortedError());

  const httpAuthOverride: ProjectBindingHttpAuthOverride = {
    auth: async (auth) => {
      const configuredAuth = input.client.getConfig().auth;
      const token =
        typeof configuredAuth === "function"
          ? await resolveBeforeAbort(configuredAuth(auth), input.signal)
          : configuredAuth;
      if (token !== undefined && typeof token !== "string") {
        throw new Error("Invalid authentication token.");
      }
      return token;
    },
  };

  const createdResult = await requestProjectBindingHttp(
    input.client,
    "POST",
    transportUrls.sessionsUrl,
    { projectRoot, projectFingerprint },
    input.signal,
    "Project Binding session request failed.",
    httpAuthOverride,
  );
  if (!createdResult.ok) {
    return failure(input.signal?.aborted ? abortedError() : createdResult.error);
  }

  const createdIdentity = parseCreateIdentity(createdResult.data);
  const created = parseCreateResponse(createdResult.data);
  if (!created || created.binding.projectFingerprint !== projectFingerprint) {
    const error = protocolError("Project Binding create response was invalid.");
    if (createdIdentity) {
      const cleanupIssue = await createProjectBindingDeleteFinalizer(
        input.client,
        transportUrls.sessionUrl(createdIdentity.bindingId),
        createdIdentity.bindingId,
        projectFingerprint,
      )();
      if (cleanupIssue) error.attachCleanup(cleanupIssue);
    }
    return failure(error);
  }

  const bindingId = created.binding.bindingId;
  const sessionId = created.sessionId;
  const socketUrl = new URL(transportUrls.socketUrl);
  socketUrl.searchParams.set("bindingId", bindingId);
  socketUrl.searchParams.set("sessionId", sessionId);
  socketUrl.searchParams.set("projectFingerprint", projectFingerprint);

  let state = created.binding.state;
  let syncState = created.binding.syncState;
  let generation = 0;
  let reconnects = 0;
  let terminalStarted = false;
  let activeConnection: SocketConnection | undefined;
  let acknowledgementWaiter: AcknowledgementWaiter | undefined;
  let cleanupAcknowledged = false;
  let pendingCleanupIssue: ProjectBindingCleanupError | undefined;
  const deleteFinalizer = createProjectBindingDeleteFinalizer(
    input.client,
    transportUrls.sessionUrl(bindingId),
    bindingId,
    projectFingerprint,
  );
  let finalizerPromise: Promise<ProjectBindingCleanupError | undefined> | undefined;

  const terminal = deferred<TerminalTrigger>();
  const webSocketFactory = input.webSocketFactory ?? defaultProjectBindingWebSocketFactory;

  const requestTerminal = (trigger: TerminalTrigger): void => {
    if (terminalStarted) return;
    terminalStarted = true;
    terminal.resolve(trigger);
  };

  const requestFailure = (error: ProjectBindingSessionError): void => {
    requestTerminal({
      primary: error,
      reason: interruptedReason(),
      remoteConfirmed: false,
    });
  };

  const disposeConnection = (connection: SocketConnection, close: boolean): void => {
    if (connection.heartbeatTimer !== undefined) {
      clearInterval(connection.heartbeatTimer);
      delete connection.heartbeatTimer;
    }
    connection.lifecycleController.abort();
    connection.unlinkCallerAbort();
    connection.disposeListeners();
    if (activeConnection === connection) activeConnection = undefined;
    if (close) closeProjectBindingSocket(connection.socket);
  };

  const handleMessage = (connection: SocketConnection, data: unknown): void => {
    if (activeConnection !== connection || connection.generation !== generation) return;
    const message = parseSocketServerMessage(data);
    if (!message) {
      const error = protocolError("Project Binding socket message was invalid.");
      if (terminalStarted) {
        pendingCleanupIssue = cleanupDetail(error);
        acknowledgementWaiter?.settle({ acknowledged: false, error });
      } else {
        requestFailure(error);
      }
      return;
    }

    if (terminalStarted) {
      if (message.type === "ended" || message.type === "blocked") {
        cleanupAcknowledged = true;
        acknowledgementWaiter?.settle({ acknowledged: true });
      }
      return;
    }

    if (message.type === "state") {
      state = message.state;
      syncState = message.syncState;
      const callbackError = emitEvent(input.onEvent, {
        type: "state",
        state,
        syncState,
        ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
      });
      if (callbackError) requestFailure(callbackError);
      return;
    }

    if (message.type === "ready") {
      if (message.bindingId !== bindingId || message.sessionId !== sessionId) {
        requestFailure(protocolError("Project Binding ready message did not match the session."));
        return;
      }
      state = "ready";
      syncState = message.syncState;
      const callbackError = emitEvent(input.onEvent, {
        type: "ready",
        bindingId,
        sessionId,
        projectRoot,
        projectFingerprint,
        webSocketUrl: transportUrls.publicWebSocketUrl,
        syncState,
        ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
      });
      if (callbackError) requestFailure(callbackError);
      return;
    }

    requestTerminal({
      reason: message.reason,
      remoteConfirmed: true,
    });
  };

  const runHeartbeat = async (connection: SocketConnection): Promise<void> => {
    try {
      if (
        terminalStarted ||
        activeConnection !== connection ||
        connection.generation !== generation ||
        !isOpenConnection(connection)
      ) {
        return;
      }

      const socketMessage: ProjectBindingSocketClientMessage = {
        type: "heartbeat",
        bindingId,
        sessionId,
        state,
        syncState,
      };
      connection.socket.send(JSON.stringify(socketMessage));
      if (terminalStarted || activeConnection !== connection) return;

      const heartbeatResult = await requestProjectBindingHttp(
        input.client,
        "POST",
        transportUrls.heartbeatUrl(bindingId),
        { sessionId, state, syncState },
        connection.lifecycleController.signal,
        "Project Binding heartbeat request failed.",
        httpAuthOverride,
      );
      if (terminalStarted || activeConnection !== connection) return;
      if (!heartbeatResult.ok) {
        requestFailure(input.signal?.aborted ? abortedError() : heartbeatResult.error);
        return;
      }

      const heartbeat = parseHeartbeatResponse(heartbeatResult.data);
      if (
        !heartbeat ||
        heartbeat.binding.bindingId !== bindingId ||
        heartbeat.binding.projectFingerprint !== projectFingerprint
      ) {
        requestFailure(protocolError("Project Binding heartbeat response was invalid."));
        return;
      }

      state = heartbeat.binding.state;
      syncState = heartbeat.binding.syncState;
      const callbackError = emitEvent(input.onEvent, {
        type: "heartbeat",
        bindingId,
        sessionId,
        state,
        syncState,
      });
      if (callbackError) requestFailure(callbackError);
    } catch {
      requestFailure(socketError());
    }
  };

  const beginHeartbeat = (connection: SocketConnection): void => {
    const start = (): void => {
      if (connection.heartbeatPromise || terminalStarted) return;
      const heartbeatPromise = runHeartbeat(connection).finally(() => {
        if (connection.heartbeatPromise === heartbeatPromise) {
          delete connection.heartbeatPromise;
        }
      });
      connection.heartbeatPromise = heartbeatPromise;
      void heartbeatPromise;
    };

    start();
    connection.heartbeatTimer = setInterval(start, HEARTBEAT_INTERVAL_MS);
  };

  const handleDisconnect = (
    connection: SocketConnection,
    reason: "socket_closed" | "socket_error",
  ): void => {
    if (activeConnection !== connection || connection.generation !== generation) return;
    if (terminalStarted) {
      acknowledgementWaiter?.settle({ acknowledged: false });
      return;
    }

    disposeConnection(connection, true);
    if (reconnects === 0) {
      reconnects = 1;
      const callbackError = emitEvent(input.onEvent, {
        type: "reconnecting",
        bindingId,
        sessionId,
        attempt: 1,
        reason,
      });
      if (callbackError) {
        requestFailure(callbackError);
        return;
      }
      void connect().catch(() => requestFailure(socketError()));
      return;
    }
    requestFailure(socketError());
  };

  const connect = async (): Promise<void> => {
    let protocols: readonly string[];
    try {
      protocols = await socketProtocols(input.client);
    } catch {
      requestFailure(socketError());
      return;
    }
    if (terminalStarted) return;

    let socket: ProjectBindingWebSocket;
    try {
      socket = webSocketFactory(socketUrl.toString(), protocols);
    } catch {
      requestFailure(socketError());
      return;
    }
    if (terminalStarted) {
      closeProjectBindingSocket(socket);
      return;
    }

    generation += 1;
    const lifecycleController = new AbortController();
    const handleCallerAbort = (): void => lifecycleController.abort();
    input.signal?.addEventListener("abort", handleCallerAbort, { once: true });
    if (input.signal?.aborted) lifecycleController.abort();
    const connection: SocketConnection = {
      generation,
      socket,
      opened: false,
      lifecycleController,
      unlinkCallerAbort: () => input.signal?.removeEventListener("abort", handleCallerAbort),
      disposeListeners: () => {},
    };
    activeConnection = connection;

    const removers = [
      listenToProjectBindingSocket(socket, "open", () => {
        if (
          connection.opened ||
          terminalStarted ||
          activeConnection !== connection ||
          connection.generation !== generation
        ) {
          return;
        }
        connection.opened = true;
        beginHeartbeat(connection);
      }),
      listenToProjectBindingSocket(socket, "message", (event) =>
        handleMessage(connection, event.data),
      ),
      listenToProjectBindingSocket(socket, "close", () =>
        handleDisconnect(connection, "socket_closed"),
      ),
      listenToProjectBindingSocket(socket, "error", () =>
        handleDisconnect(connection, "socket_error"),
      ),
    ];
    let disposed = false;
    connection.disposeListeners = () => {
      if (disposed) return;
      disposed = true;
      for (const remove of removers) remove();
    };

    if (socket.readyState === PROJECT_BINDING_SOCKET_OPEN) {
      connection.opened = true;
      beginHeartbeat(connection);
    } else if (
      socket.readyState === PROJECT_BINDING_SOCKET_CLOSING ||
      socket.readyState === PROJECT_BINDING_SOCKET_CLOSED
    ) {
      handleDisconnect(connection, "socket_closed");
    }
  };

  const abortListener = (): void => requestFailure(abortedError());
  input.signal?.addEventListener("abort", abortListener, { once: true });
  if (input.signal?.aborted) requestFailure(abortedError());

  if (!terminalStarted) {
    const connectionSetup = connect().catch(() => requestFailure(socketError()));
    await Promise.race([connectionSetup, terminal.promise]);
  }
  const terminalTrigger = await terminal.promise;

  const finalize = (): Promise<ProjectBindingCleanupError | undefined> => {
    finalizerPromise ??= (async () => {
      const connection = activeConnection;
      if (connection?.heartbeatTimer !== undefined) {
        clearInterval(connection.heartbeatTimer);
        delete connection.heartbeatTimer;
      }
      const heartbeatPromise = connection?.heartbeatPromise;
      connection?.lifecycleController.abort();
      if (heartbeatPromise) await heartbeatPromise;

      let confirmed = terminalTrigger.remoteConfirmed || cleanupAcknowledged;
      let cleanupIssue = pendingCleanupIssue;

      if (!confirmed && connection && isOpenConnection(connection)) {
        const acknowledgement = acknowledgementDeferred(FINALIZATION_ACK_TIMEOUT_MS);
        acknowledgementWaiter = acknowledgement;
        try {
          const endMessage: ProjectBindingSocketClientMessage = {
            type: "end",
            bindingId,
            sessionId,
            reason: terminalTrigger.reason,
          };
          connection.socket.send(JSON.stringify(endMessage));
          const outcome = cleanupAcknowledged
            ? { acknowledged: true }
            : await acknowledgement.promise;
          confirmed = outcome.acknowledged;
          if (outcome.error) cleanupIssue = cleanupDetail(outcome.error);
        } catch {
          cleanupIssue = cleanupDetail(socketError());
        } finally {
          acknowledgement.dispose();
          if (acknowledgementWaiter === acknowledgement) acknowledgementWaiter = undefined;
        }
      }

      if (activeConnection) disposeConnection(activeConnection, true);

      if (!confirmed) {
        const deleteIssue = await deleteFinalizer();
        if (deleteIssue) cleanupIssue = deleteIssue;
        else confirmed = true;
      }

      if (!confirmed && !cleanupIssue) {
        cleanupIssue = {
          kind: "cleanup",
          message: "Project Binding cleanup was not confirmed.",
        };
      }
      return cleanupIssue;
    })();
    return finalizerPromise;
  };

  const cleanupIssue = await finalize();
  input.signal?.removeEventListener("abort", abortListener);

  let primary = terminalTrigger.primary;
  if (cleanupIssue) {
    if (primary) {
      primary.attachCleanup(cleanupIssue);
    } else {
      primary = cleanupPrimary(cleanupIssue);
    }
  }

  const endedCallbackError = emitEvent(input.onEvent, {
    type: "ended",
    bindingId,
    sessionId,
    reason: terminalTrigger.reason,
  });
  if (endedCallbackError) {
    if (primary) primary.attachCleanup(cleanupDetail(endedCallbackError));
    else primary = endedCallbackError;
  }

  if (primary) return failure(primary);
  return {
    data: {
      bindingId,
      sessionId,
      projectRoot,
      projectFingerprint,
      webSocketUrl: transportUrls.publicWebSocketUrl,
      ended: true,
    },
    error: undefined,
  };
}

function validateInput(input: RunProjectBindingSessionInput<boolean>):
  | {
      projectRoot: string;
      projectFingerprint: string;
      transportUrls: ProjectBindingTransportUrls;
    }
  | ProjectBindingSessionError {
  if (
    !input.client ||
    typeof input.client.request !== "function" ||
    typeof input.client.getConfig !== "function"
  ) {
    return protocolError("Project Binding client was invalid.");
  }
  const projectRoot = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
  const projectFingerprint =
    typeof input.projectFingerprint === "string" ? input.projectFingerprint.trim() : "";
  if (!projectRoot || !projectFingerprint) {
    return protocolError("Project Binding input was invalid.");
  }

  const transportUrls = projectBindingTransportUrls(
    input.webSocketUrl,
    input.client.getConfig().baseUrl,
  );
  if (!transportUrls) return protocolError("Project Binding WebSocket endpoint was invalid.");
  return { projectRoot, projectFingerprint, transportUrls };
}

function projectBindingTransportUrls(
  input: unknown,
  clientBaseUrl: unknown,
): ProjectBindingTransportUrls | undefined {
  if (typeof input !== "string" || typeof clientBaseUrl !== "string") return;
  if (
    /\s/u.test(input) ||
    !/^wss?:\/\/[^/?#\\]+\/api\/v1\/attach\/project-bindings\/connect$/iu.test(input)
  ) {
    return;
  }
  let socketUrl: URL;
  let currentHostOrigin: string;
  try {
    socketUrl = new URL(input);
    currentHostOrigin = canonicalizeCurrentHostOrigin(clientBaseUrl);
  } catch {
    return;
  }
  if (
    (socketUrl.protocol !== "ws:" && socketUrl.protocol !== "wss:") ||
    !socketUrl.hostname ||
    socketUrl.username ||
    socketUrl.password ||
    socketUrl.pathname !== "/api/v1/attach/project-bindings/connect" ||
    socketUrl.search ||
    socketUrl.hash ||
    input.includes("?") ||
    input.includes("#")
  ) {
    return;
  }

  const httpOrigin = new URL(socketUrl.origin);
  httpOrigin.protocol = socketUrl.protocol === "wss:" ? "https:" : "http:";
  if (httpOrigin.origin !== currentHostOrigin) return;

  const root = "/api/v1/attach/project-bindings";
  const httpUrl = (path: string): URL => new URL(`${root}/${path}`, currentHostOrigin);
  return {
    publicWebSocketUrl: socketUrl.toString(),
    socketUrl,
    sessionsUrl: httpUrl("sessions"),
    heartbeatUrl: (bindingId) => httpUrl(`${encodeURIComponent(bindingId)}/heartbeat`),
    sessionUrl: (bindingId) => httpUrl(`${encodeURIComponent(bindingId)}/session`),
  };
}

async function resolveBeforeAbort<T>(
  value: T | PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) throw abortedError();

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const handleAbort = (): void => {
    signal.removeEventListener("abort", handleAbort);
    reject(abortedError());
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  void Promise.resolve(value).then(
    (resolved) => {
      signal.removeEventListener("abort", handleAbort);
      resolve(resolved);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", handleAbort);
      reject(error);
    },
  );
  return promise;
}

async function socketProtocols(client: Client): Promise<readonly string[]> {
  const auth = client.getConfig().auth;
  const token = typeof auth === "function" ? await auth(BEARER_AUTH) : auth;
  if (!token) return [PROJECT_BINDING_SOCKET_PROTOCOL];
  if (typeof token !== "string") throw new Error("Invalid authentication token.");
  return [PROJECT_BINDING_SOCKET_PROTOCOL, `caplets.bearer.${base64UrlUtf8(token)}`];
}

function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 16_384;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

type HttpRequestResult =
  | { ok: true; data: unknown; response: Response }
  | { ok: false; error: ProjectBindingSessionError };

type ProjectBindingHttpAuthOverride = {
  auth: Config["auth"];
};

async function requestProjectBindingHttp(
  client: Client,
  method: "POST" | "DELETE",
  url: URL,
  body: unknown,
  signal: AbortSignal | undefined,
  failureMessage: string,
  authOverride?: ProjectBindingHttpAuthOverride,
): Promise<HttpRequestResult> {
  try {
    const result = await resolveBeforeAbort(
      client.request<{ success: unknown }, unknown, false>({
        method,
        baseUrl: url.origin,
        url: url.pathname,
        body,
        security: [BEARER_AUTH],
        responseStyle: "fields",
        throwOnError: false,
        signal: signal ?? null,
        ...authOverride,
      }),
      signal,
    );
    if (result.error !== undefined) {
      return {
        ok: false,
        error: httpError(failureMessage, result.response, result.error),
      };
    }
    if (!result.response) {
      return { ok: false, error: httpError(failureMessage) };
    }
    return { ok: true, data: result.data, response: result.response };
  } catch {
    return { ok: false, error: httpError(failureMessage) };
  }
}

function createProjectBindingDeleteFinalizer(
  client: Client,
  sessionUrl: URL,
  bindingId: string,
  projectFingerprint: string,
): () => Promise<ProjectBindingCleanupError | undefined> {
  let finalizerPromise: Promise<ProjectBindingCleanupError | undefined> | undefined;
  return () => {
    finalizerPromise ??= (async () => {
      const cleanupController = new AbortController();
      const cleanupDeadline = setTimeout(
        () => cleanupController.abort(),
        FINALIZATION_CLEANUP_TIMEOUT_MS,
      );
      try {
        const deleted = await requestProjectBindingHttp(
          client,
          "DELETE",
          sessionUrl,
          undefined,
          cleanupController.signal,
          "Project Binding cleanup request failed.",
        );
        if (!deleted.ok) {
          return deleted.error.response?.status === 404 ? undefined : cleanupDetail(deleted.error);
        }

        const response = parseDeleteResponse(deleted.data);
        if (
          response &&
          response.binding.bindingId === bindingId &&
          response.binding.projectFingerprint === projectFingerprint
        ) {
          return undefined;
        }
        return cleanupDetail(protocolError("Project Binding cleanup response was invalid."));
      } finally {
        clearTimeout(cleanupDeadline);
      }
    })();
    return finalizerPromise;
  };
}

function parseCreateResponse(
  value: unknown,
): { binding: ProjectBinding; sessionId: string } | undefined {
  const record = exactRecord(value, ["binding", "sessionId"]);
  if (!record || !isNonEmptyString(record.sessionId)) return;
  const binding = parseBinding(record.binding);
  if (!binding) return;
  return { binding, sessionId: record.sessionId };
}

function parseCreateIdentity(value: unknown): ProjectBindingCreatedIdentity | undefined {
  if (!isRecord(value) || !isRecord(value.binding)) return;
  if (!isNonEmptyString(value.binding.bindingId) || !isNonEmptyString(value.sessionId)) {
    return;
  }
  return {
    bindingId: value.binding.bindingId,
    sessionId: value.sessionId,
  };
}

function parseHeartbeatResponse(value: unknown): { ok: true; binding: ProjectBinding } | undefined {
  const record = exactRecord(value, ["ok", "binding"]);
  if (!record || record.ok !== true) return;
  const binding = parseBinding(record.binding);
  if (!binding) return;
  return { ok: true, binding };
}

function parseDeleteResponse(value: unknown): { ok: true; binding: ProjectBinding } | undefined {
  return parseHeartbeatResponse(value);
}

function parseBinding(value: unknown): ProjectBinding | undefined {
  const record = exactRecord(value, [
    "bindingId",
    "state",
    "syncState",
    "projectFingerprint",
    "serverProjectRoot",
    "updatedAt",
    "expiresAt",
  ]);
  if (
    !record ||
    !isNonEmptyString(record.bindingId) ||
    !isProjectBindingState(record.state) ||
    !isProjectBindingSyncState(record.syncState) ||
    !isNonEmptyString(record.projectFingerprint) ||
    !isNonEmptyString(record.serverProjectRoot) ||
    !isIsoDateTime(record.updatedAt) ||
    !isIsoDateTime(record.expiresAt)
  ) {
    return;
  }
  return record as ProjectBinding;
}

function parseSocketServerMessage(data: unknown): ProjectBindingSocketServerMessage | undefined {
  if (typeof data !== "string") return;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(value) || typeof value.type !== "string") return;

  if (value.type === "state") {
    const record = exactRecord(value, ["type", "state", "syncState"], ["requestId"]);
    if (
      !record ||
      !isProjectBindingState(record.state) ||
      !isProjectBindingSyncState(record.syncState) ||
      !isOptionalString(record.requestId)
    ) {
      return;
    }
    return record as ProjectBindingSocketServerMessage;
  }

  if (value.type === "ready") {
    const record = exactRecord(
      value,
      ["type", "bindingId", "sessionId", "syncState"],
      ["requestId"],
    );
    if (
      !record ||
      !isNonEmptyString(record.bindingId) ||
      !isNonEmptyString(record.sessionId) ||
      !isProjectBindingSyncState(record.syncState) ||
      !isOptionalString(record.requestId)
    ) {
      return;
    }
    return record as ProjectBindingSocketServerMessage;
  }

  if (value.type === "blocked" || value.type === "ended") {
    const record = exactRecord(value, ["type", "reason"]);
    if (!record || !parseTerminalReason(record.reason)) return;
    return record as ProjectBindingSocketServerMessage;
  }
  return;
}

function parseTerminalReason(value: unknown): BindingTerminalReason | undefined {
  const record = exactRecord(value, ["code", "message"], ["recoveryCommand", "requestId"]);
  if (
    !record ||
    !PROJECT_BINDING_TERMINAL_REASON_CODES.has(record.code as BindingTerminalReason["code"]) ||
    typeof record.message !== "string" ||
    !isOptionalString(record.recoveryCommand) ||
    !isOptionalString(record.requestId)
  ) {
    return;
  }
  return record as BindingTerminalReason;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))) return;
  if (!Object.keys(value).every((key) => allowed.has(key))) return;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isProjectBindingState(value: unknown): value is ProjectBindingState {
  return PROJECT_BINDING_STATES.has(value as ProjectBindingState);
}

function isProjectBindingSyncState(value: unknown): value is ProjectBindingSyncState {
  return PROJECT_BINDING_SYNC_STATES.has(value as ProjectBindingSyncState);
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isOpenConnection(connection: SocketConnection): boolean {
  return (
    connection.socket.readyState === PROJECT_BINDING_SOCKET_OPEN ||
    (connection.opened && connection.socket.readyState === undefined)
  );
}

function acknowledgementDeferred(timeoutMs: number): AcknowledgementWaiter {
  let settled = false;
  let resolvePromise!: (outcome: AcknowledgementOutcome) => void;
  const promise = new Promise<AcknowledgementOutcome>((resolve) => {
    resolvePromise = resolve;
  });
  const timer = setTimeout(() => settle({ acknowledged: false }), timeoutMs);
  const settle = (outcome: AcknowledgementOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise(outcome);
  };
  return {
    promise,
    settle,
    dispose: () => settle({ acknowledged: false }),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function emitEvent(
  callback: ((event: ProjectBindingSessionEvent) => void) | undefined,
  event: ProjectBindingSessionEvent,
): ProjectBindingSessionError | undefined {
  if (!callback) return;
  try {
    callback(event);
    return;
  } catch {
    return new ProjectBindingSessionError("callback", "Project Binding event callback failed.");
  }
}

function protocolError(message: string): ProjectBindingSessionError {
  return new ProjectBindingSessionError("protocol", message);
}

function socketError(): ProjectBindingSessionError {
  return new ProjectBindingSessionError("socket", "Project Binding socket failed.");
}

function abortedError(): ProjectBindingSessionError {
  return new ProjectBindingSessionError("aborted", "Project Binding session was aborted.");
}

function httpError(
  message: string,
  response?: Response,
  body?: unknown,
): ProjectBindingSessionError {
  const status = response?.status;
  const code = safeHttpErrorCode(body);
  const http: ProjectBindingHttpErrorDetail = {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  };
  return new ProjectBindingSessionError("http", message, {
    ...(response ? { response } : {}),
    ...(status !== undefined || code !== undefined ? { http } : {}),
  });
}

function safeHttpErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || body.ok !== false || !isRecord(body.error)) return;
  return typeof body.error.code === "string" ? body.error.code : undefined;
}

function cleanupDetail(error: ProjectBindingSessionError): ProjectBindingCleanupError {
  return {
    kind: error.kind,
    message: error.message,
    ...(error.http?.status !== undefined ? { status: error.http.status } : {}),
    ...(error.http?.code !== undefined ? { code: error.http.code } : {}),
  };
}

function cleanupPrimary(detail: ProjectBindingCleanupError): ProjectBindingSessionError {
  const options =
    detail.status !== undefined || detail.code !== undefined
      ? {
          http: {
            ...(detail.status !== undefined ? { status: detail.status } : {}),
            ...(detail.code !== undefined ? { code: detail.code } : {}),
          },
        }
      : {};
  return new ProjectBindingSessionError("cleanup", "Project Binding cleanup failed.", options);
}

function interruptedReason(): BindingTerminalReason {
  return { code: "interrupted", message: "Project Binding session ended." };
}

function failure(error: ProjectBindingSessionError): ProjectBindingSessionResult {
  return { data: undefined, error };
}
