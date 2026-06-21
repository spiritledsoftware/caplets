import { Buffer } from "node:buffer";
import { fingerprintProjectRoot } from "../cloud/project-root";
import { CapletsError } from "../errors";
import type { ResolvedCapletsRemote } from "../remote/options";
import type { BindingTerminalReason, ProjectBindingState, ProjectBindingSyncState } from "./types";
import {
  defaultProjectBindingWebSocketFactory,
  PROJECT_BINDING_SOCKET_OPEN,
  type ProjectBindingSocketEvent,
  type ProjectBindingWebSocket,
  type ProjectBindingWebSocketFactory,
} from "./transport";

export type ProjectBindingSessionEvent =
  | { type: "state"; state: ProjectBindingState; message?: string | undefined; requestId?: string }
  | {
      type: "ready";
      bindingId: string;
      sessionId: string;
      projectRoot: string;
      projectFingerprint: string;
      webSocketUrl: string;
      requestId?: string | undefined;
    }
  | {
      type: "reconnecting";
      bindingId: string;
      sessionId: string;
      attempt: number;
      reason: string;
      requestId?: string | undefined;
    }
  | { type: "heartbeat"; bindingId: string; sessionId: string; state: ProjectBindingState }
  | { type: "ended"; bindingId?: string; sessionId?: string; reason: BindingTerminalReason };

export type ProjectBindingSocketServerMessage =
  | {
      type: "state";
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
      requestId?: string | undefined;
    }
  | {
      type: "ready";
      bindingId: string;
      sessionId: string;
      syncState: ProjectBindingSyncState;
      requestId?: string | undefined;
    }
  | { type: "blocked"; reason: BindingTerminalReason }
  | { type: "ended"; reason: BindingTerminalReason };

export type ProjectBindingSocketClientMessage =
  | {
      type: "heartbeat";
      bindingId: string;
      sessionId: string;
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
    }
  | { type: "end"; bindingId: string; sessionId: string; reason: BindingTerminalReason };

export type RunProjectBindingSessionInput = {
  projectRoot: string;
  remote: ResolvedCapletsRemote;
  remoteResolver?: (() => Promise<ResolvedCapletsRemote>) | undefined;
  fetch?: typeof fetch | undefined;
  webSocketFactory?: ProjectBindingWebSocketFactory | undefined;
  signal?: AbortSignal | undefined;
  heartbeatIntervalMs?: number | undefined;
  onEvent?: ((event: ProjectBindingSessionEvent) => void) | undefined;
};

export async function runProjectBindingSession(input: RunProjectBindingSessionInput): Promise<{
  ok: true;
  bindingId: string;
  sessionId: string;
  projectRoot: string;
  projectFingerprint: string;
  webSocketUrl: string;
  ended: true;
}> {
  const webSocketFactory = input.webSocketFactory ?? defaultProjectBindingWebSocketFactory;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  const projectFingerprint = fingerprintProjectRoot(input.projectRoot);
  let remote = input.remote;
  const refreshRemote = async () => {
    remote = input.remoteResolver ? await input.remoteResolver() : remote;
    return remote;
  };
  const fetchFor = (resolvedRemote: ResolvedCapletsRemote) =>
    input.fetch ?? resolvedRemote.fetch ?? fetch;
  input.onEvent?.({ type: "state", state: "attaching" });

  const initialRemote = await refreshRemote();
  const created = await postJson<{
    binding: {
      bindingId: string;
      state?: ProjectBindingState;
      syncState?: ProjectBindingSyncState;
    };
    sessionId: string;
  }>(fetchFor(initialRemote), sessionUrl(initialRemote), initialRemote.requestInit, {
    projectRoot: input.projectRoot,
    projectFingerprint,
    workspaceId: initialRemote.workspace ?? "default",
  });
  const bindingId = created.binding.bindingId;
  const sessionId = created.sessionId;
  let state: ProjectBindingState = created.binding.state ?? "attaching";
  let syncState: ProjectBindingSyncState = created.binding.syncState ?? "pending";
  let ended = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const publicWebSocketUrl = initialRemote.projectBindingWebSocketUrl.toString();

  const emitReady = (requestId?: string | undefined) => {
    input.onEvent?.({
      type: "ready",
      bindingId,
      sessionId,
      projectRoot: input.projectRoot,
      projectFingerprint,
      webSocketUrl: publicWebSocketUrl,
      ...(requestId ? { requestId } : {}),
    });
  };

  const heartbeat = async (socket?: ProjectBindingWebSocket | undefined) => {
    const heartbeatRemote = await refreshRemote();
    const payload: ProjectBindingSocketClientMessage = {
      type: "heartbeat",
      bindingId,
      sessionId,
      state,
      syncState,
    };
    if (socket?.readyState === PROJECT_BINDING_SOCKET_OPEN) {
      socket.send(JSON.stringify(payload));
    }
    await postJson(
      fetchFor(heartbeatRemote),
      heartbeatUrl(heartbeatRemote, bindingId),
      heartbeatRemote.requestInit,
      {
        sessionId,
        state,
        syncState,
      },
    );
    input.onEvent?.({ type: "heartbeat", bindingId, sessionId, state });
  };

  const connect = async (attempt: number): Promise<void> => {
    const socketRemote = await refreshRemote();
    const socketUrl = bindingSocketUrl(socketRemote, bindingId, sessionId, projectFingerprint);
    const socketProtocols = bindingSocketProtocols(socketRemote);
    const socket = webSocketFactory(socketUrl, socketProtocols);
    await waitForOpen(socket, input.signal);
    if (input.signal?.aborted) {
      closeSocket(socket, 1000, "aborted");
      return;
    }

    const closePromise = new Promise<{ reconnect: boolean; reason: string }>((resolve) => {
      listen(socket, "message", (event) => {
        const message = parseSocketMessage(event.data);
        if (!message) return;
        if (message.type === "state") {
          state = message.state;
          syncState = message.syncState;
          input.onEvent?.({
            type: "state",
            state,
            ...(message.requestId ? { requestId: message.requestId } : {}),
          });
          return;
        }
        if (message.type === "ready") {
          state = "ready";
          syncState = message.syncState;
          emitReady(message.requestId);
          return;
        }
        if (message.type === "blocked") {
          state = "blocked";
          input.onEvent?.({ type: "ended", bindingId, sessionId, reason: message.reason });
          resolve({ reconnect: false, reason: message.reason.message });
          return;
        }
        input.onEvent?.({ type: "ended", bindingId, sessionId, reason: message.reason });
        resolve({ reconnect: false, reason: message.reason.message });
      });
      listen(socket, "close", (event) => {
        resolve({
          reconnect: !input.signal?.aborted && attempt < 1,
          reason: event.reason ?? `WebSocket closed${event.code ? ` (${event.code})` : ""}.`,
        });
      });
      listen(socket, "error", () => {
        resolve({ reconnect: !input.signal?.aborted && attempt < 1, reason: "WebSocket error." });
      });
    });

    let heartbeatFailure: unknown;
    heartbeatTimer = setInterval(() => {
      void heartbeat(socket).catch((error) => {
        heartbeatFailure = error;
        closeSocket(socket, 1008, "Project Binding heartbeat failed.");
      });
    }, heartbeatIntervalMs);
    await heartbeat(socket);

    const closed = await Promise.race([closePromise, waitForAbort(input.signal)]);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    closeSocket(socket, 1000, "Binding Session closed.");

    if (closed === "abort") return;
    if (heartbeatFailure) throw heartbeatFailure;
    if (closed.reconnect) {
      input.onEvent?.({
        type: "reconnecting",
        bindingId,
        sessionId,
        attempt: attempt + 1,
        reason: closed.reason,
      });
      await connect(attempt + 1);
    }
  };

  try {
    await connect(0);
  } finally {
    ended = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const reason: BindingTerminalReason = input.signal?.aborted
      ? { code: "interrupted", message: "Binding Session ended." }
      : { code: "completed", message: "Binding Session completed." };
    const endingRemote = await refreshRemote().catch(() => remote);
    await endRemoteSession(
      fetchFor(endingRemote),
      endingRemote,
      endingRemote.requestInit,
      bindingId,
      sessionId,
      reason,
    );
    input.onEvent?.({ type: "ended", bindingId, sessionId, reason });
  }

  return {
    ok: true,
    bindingId,
    sessionId,
    projectRoot: input.projectRoot,
    projectFingerprint,
    webSocketUrl: publicWebSocketUrl,
    ended,
  };
}

async function postJson<T = unknown>(
  fetchImpl: typeof fetch,
  url: URL,
  requestInit: RequestInit,
  body: unknown,
): Promise<T> {
  const headers = new Headers(requestInit.headers);
  headers.set("content-type", "application/json");
  const response = await fetchImpl(url, {
    ...requestInit,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Project Binding request failed (${response.status}).`,
    );
  }
  return (await response.json().catch(() => ({}))) as T;
}

async function endRemoteSession(
  fetchImpl: typeof fetch,
  remote: ResolvedCapletsRemote,
  requestInit: RequestInit,
  bindingId: string,
  sessionId: string,
  reason: BindingTerminalReason,
): Promise<void> {
  const headers = new Headers(requestInit.headers);
  headers.set("content-type", "application/json");
  await fetchImpl(endSessionUrl(remote, bindingId), {
    ...requestInit,
    method: "DELETE",
    headers,
    body: JSON.stringify({ sessionId, terminalReason: reason }),
  }).catch(() => undefined);
}

function sessionUrl(remote: ResolvedCapletsRemote): URL {
  return controlProjectBindingUrl(remote, "sessions");
}

function heartbeatUrl(remote: ResolvedCapletsRemote, bindingId: string): URL {
  return controlProjectBindingUrl(remote, `${encodeURIComponent(bindingId)}/heartbeat`);
}

function endSessionUrl(remote: ResolvedCapletsRemote, bindingId: string): URL {
  return controlProjectBindingUrl(remote, `${encodeURIComponent(bindingId)}/session`);
}

function controlProjectBindingUrl(remote: ResolvedCapletsRemote, suffix: string): URL {
  const url = new URL(remote.projectBindingWebSocketUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = url.pathname.replace(/\/connect$/u, `/${suffix}`);
  url.search = "";
  url.hash = "";
  return url;
}

function bindingSocketUrl(
  remote: ResolvedCapletsRemote,
  bindingId: string,
  sessionId: string,
  projectFingerprint: string,
): string {
  const url = new URL(remote.projectBindingWebSocketUrl);
  url.searchParams.set("bindingId", bindingId);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("projectFingerprint", projectFingerprint);
  return url.toString();
}

function bindingSocketProtocols(remote: ResolvedCapletsRemote): string[] | undefined {
  if (remote.auth.type !== "bearer") return undefined;
  return [
    "caplets.project-binding.v1",
    `caplets.bearer.${Buffer.from(remote.auth.token).toString("base64url")}`,
  ];
}

function parseSocketMessage(data: unknown): ProjectBindingSocketServerMessage | undefined {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : undefined;
  if (!text) return undefined;
  const parsed = JSON.parse(text) as Partial<ProjectBindingSocketServerMessage>;
  return typeof parsed.type === "string"
    ? (parsed as ProjectBindingSocketServerMessage)
    : undefined;
}

async function waitForOpen(
  socket: ProjectBindingWebSocket,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (socket.readyState === PROJECT_BINDING_SOCKET_OPEN) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      listen(socket, "open", () => resolve(), { once: true });
      listen(
        socket,
        "error",
        () =>
          reject(
            new CapletsError("SERVER_UNAVAILABLE", "Project Binding WebSocket failed to open."),
          ),
        {
          once: true,
        },
      );
    }),
    waitForAbort(signal).then(() => undefined),
  ]);
}

function waitForAbort(signal: AbortSignal | undefined): Promise<"abort"> {
  if (signal?.aborted) return Promise.resolve("abort");
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve("abort"), { once: true });
  });
}

function listen(
  socket: ProjectBindingWebSocket,
  type: "open" | "message" | "close" | "error",
  listener: (event: ProjectBindingSocketEvent) => void,
  options?: { once?: boolean },
): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener, options);
    return;
  }
  const key = `on${type}` as const;
  const existing = socket[key];
  const wrapper = (event: ProjectBindingSocketEvent) => {
    existing?.(event);
    listener(event);
    if (options?.once && socket[key] === wrapper) socket[key] = existing ?? null;
  };
  socket[key] = wrapper;
}

function closeSocket(socket: ProjectBindingWebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Best-effort cleanup; the REST lease end is the durable cleanup path.
  }
}
