export type ProjectBindingSocketEvent = {
  data?: unknown;
  code?: number | undefined;
  reason?: string | undefined;
};

export type ProjectBindingWebSocket = {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (
    type: "open" | "message" | "close" | "error",
    listener: (event: ProjectBindingSocketEvent) => void,
    options?: { once?: boolean },
  ) => void;
  removeEventListener?: (
    type: "open" | "message" | "close" | "error",
    listener: (event: ProjectBindingSocketEvent) => void,
  ) => void;
  onopen?: ((event: ProjectBindingSocketEvent) => void) | null;
  onmessage?: ((event: ProjectBindingSocketEvent) => void) | null;
  onclose?: ((event: ProjectBindingSocketEvent) => void) | null;
  onerror?: ((event: ProjectBindingSocketEvent) => void) | null;
};

export type ProjectBindingWebSocketFactory = (
  url: string,
  protocols?: string | string[] | undefined,
) => ProjectBindingWebSocket;

export const PROJECT_BINDING_SOCKET_OPEN = 1;

export function defaultProjectBindingWebSocketFactory(
  url: string,
  protocols?: string | string[] | undefined,
): ProjectBindingWebSocket {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime.");
  }
  return new WebSocketCtor(url, protocols) as ProjectBindingWebSocket;
}
