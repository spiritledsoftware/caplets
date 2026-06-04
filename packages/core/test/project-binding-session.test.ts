import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { resolveCapletsRemote } from "../src/remote/options";
import { runProjectBindingSession } from "../src/project-binding/session";
import type {
  ProjectBindingSocketEvent,
  ProjectBindingWebSocket,
} from "../src/project-binding/transport";

describe("runProjectBindingSession", () => {
  it("creates a session, opens WebSocket, sends heartbeats, and ends remotely on abort", async () => {
    const controller = new AbortController();
    const requests: { method: string; url: string; body?: unknown }[] = [];
    const events: unknown[] = [];
    let socketUrl = "";
    let socketProtocols: string | string[] | undefined;
    const socket = new FakeProjectBindingSocket([
      { type: "state", state: "syncing", syncState: "syncing" },
      { type: "ready", bindingId: "binding_1", sessionId: "binding_session_1", syncState: "idle" },
    ]);

    const result = await runProjectBindingSession({
      projectRoot: "/repo",
      remote: resolveCapletsRemote({
        url: "https://cloud.caplets.dev",
        token: "cap_access_secret",
        workspace: "personal",
      }),
      fetch: async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method: init?.method ?? "GET", url: String(url), body });
        if (String(url).endsWith("/control/project-bindings/sessions")) {
          return Response.json(
            {
              binding: { bindingId: "binding_1", state: "attaching", syncState: "pending" },
              sessionId: "binding_session_1",
            },
            { status: 201 },
          );
        }
        return Response.json({ ok: true, binding: { bindingId: "binding_1" } });
      },
      webSocketFactory: (url, protocols) => {
        socketUrl = url;
        socketProtocols = protocols;
        return socket;
      },
      signal: controller.signal,
      heartbeatIntervalMs: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "ready") controller.abort();
      },
    });

    expect(result).toMatchObject({ bindingId: "binding_1", sessionId: "binding_session_1" });
    expect(socketUrl).toContain("bindingId=binding_1");
    expect(socketUrl).toContain("sessionId=binding_session_1");
    expect(socketUrl).not.toContain("accessToken=");
    expect(socketProtocols).toEqual([
      "caplets.project-binding.v1",
      `caplets.bearer.${Buffer.from("cap_access_secret").toString("base64url")}`,
    ]);
    expect(socket.sent.map((item) => item.type)).toContain("heartbeat");
    expect(requests.some((request) => request.url.endsWith("/heartbeat"))).toBe(true);
    expect(
      requests.some((request) => request.method === "DELETE" && request.url.endsWith("/session")),
    ).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "ready" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "ended" }));
  });

  it("emits a reconnecting event after one reconnectable socket close", async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    const sockets = [
      new FakeProjectBindingSocket([], { closeImmediately: true }),
      new FakeProjectBindingSocket([
        {
          type: "ready",
          bindingId: "binding_1",
          sessionId: "binding_session_1",
          syncState: "idle",
        },
      ]),
    ];

    await runProjectBindingSession({
      projectRoot: "/repo",
      remote: resolveCapletsRemote({ url: "https://cloud.caplets.dev", token: "token" }),
      fetch: async (url) => {
        if (String(url).endsWith("/sessions")) {
          return Response.json(
            { binding: { bindingId: "binding_1" }, sessionId: "binding_session_1" },
            { status: 201 },
          );
        }
        return Response.json({ ok: true });
      },
      webSocketFactory: () => sockets.shift() ?? new FakeProjectBindingSocket([]),
      signal: controller.signal,
      heartbeatIntervalMs: 1,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "ready") controller.abort();
      },
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "reconnecting", attempt: 1 }));
  });

  it("cleans up once listeners in the on-event WebSocket fallback path", async () => {
    const controller = new AbortController();
    const socket = new FallbackProjectBindingSocket();

    await runProjectBindingSession({
      projectRoot: "/repo",
      remote: resolveCapletsRemote({ url: "https://cloud.caplets.dev", token: "token" }),
      fetch: async (url) => {
        if (String(url).endsWith("/sessions")) {
          return Response.json(
            { binding: { bindingId: "binding_1" }, sessionId: "binding_session_1" },
            { status: 201 },
          );
        }
        return Response.json({ ok: true });
      },
      webSocketFactory: () => socket,
      signal: controller.signal,
      heartbeatIntervalMs: 1,
      onEvent: (event) => {
        if (event.type === "ready") controller.abort();
      },
    });

    expect(socket.onopen).toBeNull();
  });
});

class FakeProjectBindingSocket implements ProjectBindingWebSocket {
  readonly readyState = 1;
  readonly sent: { type: string }[] = [];
  private readonly listeners = new Map<
    string,
    ((event: { data?: unknown; reason?: string }) => void)[]
  >();

  constructor(
    private readonly messages: unknown[],
    options: { closeImmediately?: boolean } = {},
  ) {
    setTimeout(() => {
      if (options.closeImmediately) {
        this.dispatch("close", { reason: "network reset" });
        return;
      }
      for (const message of this.messages) {
        this.dispatch("message", { data: JSON.stringify(message) });
      }
    }, 0);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string });
  }

  close(): void {}

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; reason?: string }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private dispatch(type: string, event: { data?: unknown; reason?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FallbackProjectBindingSocket implements ProjectBindingWebSocket {
  readyState = 0;
  readonly sent: { type: string }[] = [];
  onopen: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onmessage: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onclose: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onerror: ((event: ProjectBindingSocketEvent) => void) | null = null;

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: "ready",
            bindingId: "binding_1",
            sessionId: "binding_session_1",
            syncState: "idle",
          }),
        });
      }, 0);
    }, 0);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string });
  }

  close(): void {}
}
