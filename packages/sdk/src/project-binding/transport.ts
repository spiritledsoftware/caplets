export const PROJECT_BINDING_SOCKET_PROTOCOL = "caplets.project-binding.v1";
export const PROJECT_BINDING_SOCKET_CONNECTING = 0;
export const PROJECT_BINDING_SOCKET_OPEN = 1;
export const PROJECT_BINDING_SOCKET_CLOSING = 2;
export const PROJECT_BINDING_SOCKET_CLOSED = 3;

export type ProjectBindingSocketEvent = {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};

export type ProjectBindingSocketEventType = "open" | "message" | "close" | "error";
export type ProjectBindingSocketListener = (event: ProjectBindingSocketEvent) => void;

export type ProjectBindingWebSocket = {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ) => void;
  removeEventListener?: (
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ) => void;
  onopen?: ProjectBindingSocketListener | null;
  onmessage?: ProjectBindingSocketListener | null;
  onclose?: ProjectBindingSocketListener | null;
  onerror?: ProjectBindingSocketListener | null;
};

export type ProjectBindingWebSocketFactory = (
  url: string,
  protocols: string | readonly string[],
) => ProjectBindingWebSocket;

export function defaultProjectBindingWebSocketFactory(
  url: string,
  protocols: string | readonly string[],
): ProjectBindingWebSocket {
  const WebSocketConstructor = globalThis.WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is unavailable.");
  }
  return new WebSocketConstructor(url, protocols as string | string[]) as ProjectBindingWebSocket;
}

export function listenToProjectBindingSocket(
  socket: ProjectBindingWebSocket,
  type: ProjectBindingSocketEventType,
  listener: ProjectBindingSocketListener,
): () => void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }

  const property = `on${type}` as const;
  const previous = socket[property];
  const combined: ProjectBindingSocketListener = (event) => {
    previous?.(event);
    listener(event);
  };
  socket[property] = combined;

  return () => {
    if (socket[property] === combined) {
      socket[property] = previous ?? null;
    }
  };
}

export function closeProjectBindingSocket(
  socket: ProjectBindingWebSocket,
  code = 1000,
  reason = "Project Binding session closed.",
): void {
  if (
    socket.readyState === PROJECT_BINDING_SOCKET_CLOSING ||
    socket.readyState === PROJECT_BINDING_SOCKET_CLOSED
  ) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    // Closing is best-effort after all listeners have been detached.
  }
}
