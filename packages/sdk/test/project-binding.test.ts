import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../schemas/caplets-project-binding-v1.fixtures.json";
import { createClient, type Auth } from "../src";
import {
  PROJECT_BINDING_SOCKET_PROTOCOL,
  ProjectBindingSessionError,
  runProjectBindingSession,
  type ProjectBinding,
  type ProjectBindingSessionEvent,
  type ProjectBindingSessionResult,
  type ProjectBindingSocketClientMessage,
  type ProjectBindingSocketEvent,
  type ProjectBindingSocketEventType,
  type ProjectBindingSocketListener,
  type ProjectBindingWebSocket,
  type ProjectBindingWebSocketFactory,
} from "../src/project-binding";

const NOW = "2026-07-20T12:00:00.000Z";
const LATER = "2026-07-20T12:01:00.000Z";
const BINDING_ID = "binding-1";
const SESSION_ID = "session-1";
const FINGERPRINT = "fingerprint-1";
const ROOT = "/workspace/project";
const ENDED_REASON = { code: "completed", message: "Session completed." } as const;
const BEARER_AUTH = { scheme: "bearer", type: "http" } as const satisfies Auth;
const FIXTURE_ENDED_MESSAGE = fixtures.server.valid.find(
  ({ message }) => message.type === "ended",
)?.message;
if (!FIXTURE_ENDED_MESSAGE) throw new Error("Project Binding fixture is missing ended.");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runProjectBindingSession", () => {
  it("creates, becomes ready, sends an immediate dual heartbeat, and succeeds on ended", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const events: ProjectBindingSessionEvent[] = [];
    const promise = runSession(http, sockets.factory, { onEvent: (event) => events.push(event) });

    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.open();
    await until(() => events.some((event) => event.type === "heartbeat"));
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => http.heartbeatRequests.length === 2);

    expect(socket.sent[0]).toEqual({
      type: "heartbeat",
      bindingId: BINDING_ID,
      sessionId: SESSION_ID,
      state: "attaching",
      syncState: "pending",
    });
    expect(socket.sent.filter((message) => message.type === "heartbeat")).toHaveLength(2);
    socket.receive({
      type: "ready",
      bindingId: BINDING_ID,
      sessionId: SESSION_ID,
      syncState: "idle",
      requestId: "request-1",
    });
    socket.receive({ type: "ended", reason: ENDED_REASON });

    await expect(promise).resolves.toEqual({
      data: {
        bindingId: BINDING_ID,
        sessionId: SESSION_ID,
        projectRoot: ROOT,
        projectFingerprint: FINGERPRINT,
        webSocketUrl: "wss://host.example/v1/attach/project-bindings/connect",
        ended: true,
      },
      error: undefined,
    });
    expect(events.filter((event) => event.type === "ready")).toHaveLength(1);
    expect(events.filter((event) => event.type === "heartbeat")).toHaveLength(2);
    expect(events.filter((event) => event.type === "ended")).toEqual([
      { type: "ended", bindingId: BINDING_ID, sessionId: SESSION_ID, reason: ENDED_REASON },
    ]);
    expect(http.deleteRequests).toHaveLength(0);
    expect(socket.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a never-settling heartbeat before settling a remote-confirmed end", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    let pendingHeartbeats = 0;
    http.heartbeatResponder = (request) => {
      pendingHeartbeats += 1;
      return new Promise<Response>((_resolve, reject) => {
        const handleAbort = (): void => {
          pendingHeartbeats -= 1;
          reject(request.signal.reason);
        };
        if (request.signal.aborted) {
          handleAbort();
          return;
        }
        request.signal.addEventListener("abort", handleAbort, { once: true });
      });
    };
    const sockets = new SocketHarness();
    const caller = new AbortController();
    const promise = runSession(http, sockets.factory, { signal: caller.signal });

    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.open();
    await until(() => http.heartbeatRequests.length === 1);
    expect(pendingHeartbeats).toBe(1);
    expect(http.heartbeatRequests[0]!.signal.aborted).toBe(false);

    socket.receive({ type: "ended", reason: ENDED_REASON });

    await expect(promise).resolves.toMatchObject({ data: { ended: true }, error: undefined });
    expect(http.heartbeatRequests[0]!.signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(pendingHeartbeats).toBe(0);
    expect(http.deleteRequests).toHaveLength(0);
    expect(socket.closeCalls).toBe(1);
    expect(socket.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "https://host.example/v1/attach/project-bindings/connect",
    "wss://host.example/v1/attach/project-bindings/not-connect",
    "/v1/attach/project-bindings/connect",
    "wss://host.example/v1/attach/project-bindings/connect?workspace=other",
    "wss://host.example/v1/attach/project-bindings/connect#other",
    "wss://host.example/v1/attach/project-bindings/connect?",
    "wss://host.example/v1/attach/project-bindings/connect#",
  ])("rejects invalid connect URL %s before network activity", async (webSocketUrl) => {
    const http = new HttpHarness();
    const client = createClient({ baseUrl: "https://unused.example", fetch: http.fetch });
    const result = await runProjectBindingSession({
      client,
      webSocketUrl,
      projectRoot: ROOT,
      projectFingerprint: FINGERPRINT,
    });
    expect(result.error?.kind).toBe("protocol");
    expect(http.requests).toHaveLength(0);
  });
  it("rejects blank project identity before network activity", async () => {
    const http = new HttpHarness();
    const client = createClient({ baseUrl: "https://unused.example", fetch: http.fetch });
    const result = await runProjectBindingSession({
      client,
      webSocketUrl: "wss://host.example/v1/attach/project-bindings/connect",
      projectRoot: " ",
      projectFingerprint: "",
    });
    expect(result.error?.kind).toBe("protocol");
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    [
      "a mismatched project fingerprint",
      { binding: binding({ projectFingerprint: "other-fingerprint" }), sessionId: SESSION_ID },
    ],
    [
      "an otherwise identifiable response that fails strict validation",
      { binding: { ...binding(), extra: true }, sessionId: SESSION_ID },
    ],
    [
      "only trustworthy binding and session IDs",
      { binding: { bindingId: BINDING_ID }, sessionId: SESSION_ID },
    ],
  ])("cleans exactly once after create returns %s", async (_name, createData) => {
    const http = new HttpHarness();
    http.createData = createData;
    const sockets = new SocketHarness();

    const result = await runSession(http, sockets.factory);

    expect(result.error?.kind).toBe("protocol");
    expect(result.error?.message).toBe("Project Binding create response was invalid.");
    expect(http.deleteRequests).toHaveLength(1);
    expect(result.error?.cleanup).toBeUndefined();
    expect(sockets.sockets).toHaveLength(0);
  });

  it("negotiates only the version protocol without auth", async () => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory);
    await until(() => sockets.sockets.length === 1);

    expect(sockets.protocols[0]).toEqual([PROJECT_BINDING_SOCKET_PROTOCOL]);
    sockets.sockets[0]!.receive({ type: "ended", reason: ENDED_REASON });
    await expect(promise).resolves.toMatchObject({ error: undefined });
    expect(http.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  });

  it("uses static auth for HTTP and a UTF-8 base64url bearer socket protocol", async () => {
    // Latin-1 is valid in a Fetch header while still exercising UTF-8 socket encoding.
    const token = "pässword/+/é";
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory, { auth: token });
    await until(() => sockets.sockets.length === 1);

    expect(sockets.protocols[0]).toEqual([
      PROJECT_BINDING_SOCKET_PROTOCOL,
      `caplets.bearer.${encodeBearer(token)}`,
    ]);
    expect(http.createRequests[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    sockets.sockets[0]!.receive({ type: "ended", reason: ENDED_REASON });
    await promise;
  });

  it("resolves async auth freshly for the initial socket and the one reconnect", async () => {
    let tokenGeneration = 0;
    const auth = vi.fn(async () => `fresh-token-${++tokenGeneration}`);
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory, { auth });
    await until(() => sockets.sockets.length === 1);

    sockets.sockets[0]!.unexpectedClose("first raw close reason");
    await until(() => sockets.sockets.length === 2);

    const initialBearer = sockets.protocols[0]![1];
    const reconnectBearer = sockets.protocols[1]![1];
    expect(initialBearer).toMatch(/^caplets\.bearer\./u);
    expect(reconnectBearer).toMatch(/^caplets\.bearer\./u);
    expect(reconnectBearer).not.toBe(initialBearer);
    expect(auth).toHaveBeenCalledWith(BEARER_AUTH);

    sockets.sockets[1]!.receive({ type: "ended", reason: ENDED_REASON });
    await expect(promise).resolves.toMatchObject({ error: undefined });
  });

  it("resolves async auth freshly for DELETE fallback cleanup", async () => {
    let tokenGeneration = 0;
    const auth = vi.fn(async () => `fresh-token-${++tokenGeneration}`);
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { auth, signal: abort.signal });
    await until(() => sockets.sockets.length === 1);

    abort.abort();

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(http.deleteRequests).toHaveLength(1);
    expect(http.deleteRequests[0]!.headers.get("authorization")).toBe("Bearer fresh-token-3");
    expect(auth).toHaveBeenCalledTimes(3);
  });

  it("aborts initial async HTTP authentication promptly without creating a session", async () => {
    vi.useFakeTimers();
    const httpAuthStarted = deferred<void>();
    const httpAuth = deferred<string | undefined>();
    const auth = vi.fn(() => {
      httpAuthStarted.resolve();
      return httpAuth.promise;
    });
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { auth, signal: abort.signal });
    const timeout = Promise.withResolvers<{ kind: "still-pending" }>();
    setTimeout(() => timeout.resolve({ kind: "still-pending" }), 1);
    const observedPromise = Promise.race([
      promise.then((result) => ({ kind: "settled" as const, result })),
      timeout.promise,
    ]);
    await httpAuthStarted.promise;

    abort.abort();
    await vi.advanceTimersByTimeAsync(1);
    const observed = await observedPromise;

    expect(observed).toMatchObject({
      kind: "settled",
      result: { error: { kind: "aborted" } },
    });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(http.requests).toHaveLength(0);
    expect(sockets.sockets).toHaveLength(0);

    httpAuth.resolve("late-secret");
    await vi.runAllTimersAsync();
    await promise;
    expect(http.requests).toHaveLength(0);
  });

  it("aborts pending async socket authentication and cleans the created session", async () => {
    const socketAuthStarted = deferred<void>();
    const socketAuth = deferred<string | undefined>();
    let authCall = 0;
    const auth = vi.fn(() => {
      authCall += 1;
      if (authCall === 1) return "http-token";
      if (authCall === 2) {
        socketAuthStarted.resolve();
        return socketAuth.promise;
      }
      return "cleanup-token";
    });
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { auth, signal: abort.signal });
    await socketAuthStarted.promise;

    abort.abort();

    await until(() => http.deleteRequests.length === 1);
    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(http.deleteRequests).toHaveLength(1);
    expect(sockets.sockets).toHaveLength(0);
    expect(http.deleteRequests[0]!.headers.get("authorization")).toBe("Bearer cleanup-token");
    expect(auth).toHaveBeenCalledTimes(3);
    socketAuth.resolve("late-token");
  });

  it("never exposes a token or raw close text in URLs, events, or errors", async () => {
    const token = "credential-do-not-leak";
    const rawReason = "raw-close-do-not-leak";
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const events: ProjectBindingSessionEvent[] = [];
    const promise = runSession(http, sockets.factory, {
      auth: token,
      webSocketUrl: "wss://host.example/v1/attach/project-bindings/connect",
      onEvent: (event) => events.push(event),
    });
    await until(() => sockets.sockets.length === 1);
    sockets.sockets[0]!.unexpectedClose(rawReason);
    await until(() => sockets.sockets.length === 2);
    sockets.sockets[1]!.unexpectedClose(rawReason);

    const result = await promise;
    expect(result.error?.kind).toBe("socket");
    const exposed = JSON.stringify({
      urls: sockets.urls,
      events,
      message: result.error?.message,
      cleanup: result.error?.cleanup,
    });
    expect(exposed).not.toContain(token);
    expect(exposed).not.toContain(rawReason);
  });

  it.each([
    {
      name: "a prefixed self-hosted route",
      webSocketUrl: "ws://self.example:8080/caplets/v1/attach/project-bindings/connect",
      sessionsUrl: "http://self.example:8080/caplets/v1/attach/project-bindings/sessions",
      heartbeatUrl:
        "http://self.example:8080/caplets/v1/attach/project-bindings/binding-1/heartbeat",
    },
    {
      name: "a Cloud workspace route",
      webSocketUrl: "wss://cloud.example/workspaces/workspace-7/v1/attach/project-bindings/connect",
      sessionsUrl:
        "https://cloud.example/workspaces/workspace-7/v1/attach/project-bindings/sessions",
      heartbeatUrl:
        "https://cloud.example/workspaces/workspace-7/v1/attach/project-bindings/binding-1/heartbeat",
    },
  ])(
    "derives sibling HTTP paths for $name",
    async ({ webSocketUrl, sessionsUrl, heartbeatUrl }) => {
      const http = new HttpHarness();
      const sockets = new SocketHarness();
      const promise = runSession(http, sockets.factory, { webSocketUrl });
      await until(() => sockets.sockets.length === 1);
      sockets.sockets[0]!.open();
      await until(() => http.heartbeatRequests.length === 1);

      expect(http.createRequests[0]!.url).toBe(sessionsUrl);
      expect(http.heartbeatRequests[0]!.url).toBe(heartbeatUrl);
      expect(new URL(sockets.urls[0]!).pathname).toMatch(/\/connect$/u);
      expect(new URL(sockets.urls[0]!).searchParams.get("bindingId")).toBe(BINDING_ID);
      sockets.sockets[0]!.receive({ type: "ended", reason: ENDED_REASON });
      await promise;
    },
  );

  it("emits every client message union member named by the shared fixture", async () => {
    expect(fixtures.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { signal: abort.signal });
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive(FIXTURE_ENDED_MESSAGE);
    };
    socket.open();
    await until(() => socket.sent.some((message) => message.type === "heartbeat"));
    abort.abort();

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(socket.sent.map(({ type }) => type)).toEqual(
      fixtures.client.valid.map(({ message }) => message.type),
    );
  });

  it.each(fixtures.server.valid)(
    "accepts shared valid server message: $name",
    async ({ message }) => {
      const http = new HttpHarness();
      const sockets = new SocketHarness();
      const events: ProjectBindingSessionEvent[] = [];
      const promise = runSession(http, sockets.factory, {
        onEvent: (event) => events.push(event),
      });
      await until(() => sockets.sockets.length === 1);
      const socket = sockets.sockets[0]!;
      socket.open();
      socket.receive(message);

      if (message.type === "state" || message.type === "ready") {
        await until(() => events.some((event) => event.type === message.type));
        socket.receive(FIXTURE_ENDED_MESSAGE);
      }

      await expect(promise).resolves.toMatchObject({ error: undefined });
    },
  );

  it.each(fixtures.server.invalid)(
    "rejects shared invalid server message: $name",
    async ({ message }) => {
      const http = new HttpHarness();
      const sockets = new SocketHarness();
      const promise = runSession(http, sockets.factory);
      await until(() => sockets.sockets.length === 1);
      const socket = sockets.sockets[0]!;
      socket.onSend = (sent) => {
        if (sent.type === "end") socket.receive(FIXTURE_ENDED_MESSAGE);
      };
      socket.open();
      socket.receive(message);

      const result = await promise;
      expect(result.error).toBeInstanceOf(ProjectBindingSessionError);
      expect(result.error?.kind).toBe("protocol");
      expect(http.deleteRequests).toHaveLength(0);
    },
  );

  it.each([
    ["malformed JSON", "{"],
    [
      "mismatched ready IDs",
      JSON.stringify({
        type: "ready",
        bindingId: "other-binding",
        sessionId: SESSION_ID,
        syncState: "idle",
      }),
    ],
  ])("rejects %s", async (_name, data) => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory);
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive(FIXTURE_ENDED_MESSAGE);
    };
    socket.open();
    socket.receiveRaw(data);

    const result = await promise;
    expect(result.error).toBeInstanceOf(ProjectBindingSessionError);
    expect(result.error?.kind).toBe("protocol");
    expect(http.deleteRequests).toHaveLength(0);
  });

  it("reconnects exactly once and reports a second close as a socket failure", async () => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const events: ProjectBindingSessionEvent[] = [];
    const promise = runSession(http, sockets.factory, { onEvent: (event) => events.push(event) });
    await until(() => sockets.sockets.length === 1);
    sockets.sockets[0]!.unexpectedClose("first");
    await until(() => sockets.sockets.length === 2);
    sockets.sockets[1]!.unexpectedClose("second");

    const result = await promise;
    expect(result.error?.kind).toBe("socket");
    expect(sockets.sockets).toHaveLength(2);
    expect(events.filter((event) => event.type === "reconnecting")).toEqual([
      {
        type: "reconnecting",
        bindingId: BINDING_ID,
        sessionId: SESSION_ID,
        attempt: 1,
        reason: "socket_closed",
      },
    ]);
    expect(http.deleteRequests).toHaveLength(1);
  });

  it("preserves a callback exception as the primary failure and sanitizes it", async () => {
    const callbackText = "callback-secret-text";
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory, {
      onEvent: (event) => {
        if (event.type === "ready") throw new Error(callbackText);
      },
    });
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();
    socket.receive({
      type: "ready",
      bindingId: BINDING_ID,
      sessionId: SESSION_ID,
      syncState: "idle",
    });

    const result = await promise;
    expect(result.error?.kind).toBe("callback");
    expect(result.error?.message).not.toContain(callbackText);
    expect(http.deleteRequests).toHaveLength(0);
  });

  it("returns aborted only after an acknowledged WebSocket finalization and emits ended once", async () => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const events: ProjectBindingSessionEvent[] = [];
    const promise = runSession(http, sockets.factory, {
      signal: abort.signal,
      onEvent: (event) => events.push(event),
    });
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();
    abort.abort("signal-secret-text");

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(result.error?.message).not.toContain("signal-secret-text");
    expect(socket.sent.filter((message) => message.type === "end")).toHaveLength(1);
    expect(http.deleteRequests).toHaveLength(0);
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
    expect(socket.listenerCount).toBe(0);
  });

  it("reports heartbeat HTTP failure and disposes the active interval and listeners", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    http.heartbeatStatus = 503;
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory);
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();

    const result = await promise;
    expect(result.error?.kind).toBe("http");
    expect(result.error?.http?.status).toBe(503);
    expect(socket.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs one finalizer during simultaneous abort, close, and heartbeat failure", async () => {
    const http = new HttpHarness();
    const heartbeat = deferred<Response>();
    http.heartbeatResponder = () => heartbeat.promise;
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const events: ProjectBindingSessionEvent[] = [];
    const promise = runSession(http, sockets.factory, {
      signal: abort.signal,
      onEvent: (event) => events.push(event),
    });
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();
    await until(() => http.heartbeatRequests.length === 1);

    abort.abort();
    socket.unexpectedClose("simultaneous close");
    heartbeat.resolve(jsonResponse(legacyError("SERVER_UNAVAILABLE"), 503));

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(socket.sent.filter((message) => message.type === "end")).toHaveLength(0);
    expect(http.deleteRequests).toHaveLength(1);
    expect(events.filter((event) => event.type === "ended")).toHaveLength(1);
  });

  it("bounds a DELETE fallback that never responds", async () => {
    vi.useFakeTimers();
    const deleteStarted = deferred<void>();
    const http = new HttpHarness();
    http.deleteResponder = () => {
      deleteStarted.resolve();
      return new Promise<Response>(() => {});
    };
    const sockets = new SocketHarness();
    const abort = new AbortController();
    let result: ProjectBindingSessionResult | undefined;
    const promise = runSession(http, sockets.factory, { signal: abort.signal }).then((value) => {
      result = value;
      return value;
    });
    await until(() => sockets.sockets.length === 1);

    abort.abort();
    await deleteStarted.promise;

    expect(http.deleteRequests).toHaveLength(1);
    expect(http.deleteRequests[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({
      error: {
        kind: "aborted",
        cleanup: { kind: "http", message: "Project Binding cleanup request failed." },
      },
    });
    expect(http.deleteRequests[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await promise;
  });

  it("accepts a missing DELETE fallback as finalized", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    http.deleteStatus = 404;
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { signal: abort.signal });
    await until(() => sockets.sockets.length === 1);
    sockets.sockets[0]!.open();
    abort.abort();
    await until(() => sockets.sockets[0]!.sent.some((message) => message.type === "end"));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(result.error?.cleanup).toBeUndefined();
    expect(http.deleteRequests).toHaveLength(1);
  });

  it.each([401, 500])(
    "retains DELETE fallback status %s as safe secondary cleanup",
    async (status) => {
      vi.useFakeTimers();
      const http = new HttpHarness();
      http.deleteStatus = status;
      const sockets = new SocketHarness();
      const abort = new AbortController();
      const promise = runSession(http, sockets.factory, { signal: abort.signal });
      await until(() => sockets.sockets.length === 1);
      sockets.sockets[0]!.open();
      abort.abort();
      await until(() => sockets.sockets[0]!.sent.some((message) => message.type === "end"));
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.error?.kind).toBe("aborted");
      expect(result.error?.cleanup).toMatchObject({ kind: "http", status });
    },
  );

  it("never masks a callback primary failure with a cleanup 5xx", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    http.deleteStatus = 500;
    const sockets = new SocketHarness();
    const promise = runSession(http, sockets.factory, {
      onEvent: (event) => {
        if (event.type === "ready") throw new Error("private callback body");
      },
    });
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.open();
    socket.receive({
      type: "ready",
      bindingId: BINDING_ID,
      sessionId: SESSION_ID,
      syncState: "idle",
    });
    await until(() => socket.sent.some((message) => message.type === "end"));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await promise;
    expect(result.error?.kind).toBe("callback");
    expect(result.error?.cleanup).toMatchObject({ kind: "http", status: 500 });
    expect(result.error?.message).not.toContain("private callback body");
  });

  it("rejects a typed error in throw mode", async () => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSessionThrowing(http, sockets.factory, abort.signal);
    await until(() => sockets.sockets.length === 1);
    const socket = sockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();
    abort.abort();

    await expect(promise).rejects.toMatchObject({
      name: "ProjectBindingSessionError",
      kind: "aborted",
    });
  });

  it("does not resolve successful data before a validated remote terminal message", async () => {
    const http = new HttpHarness();
    const sockets = new SocketHarness();
    let settled = false;
    const promise = runSession(http, sockets.factory).finally(() => {
      settled = true;
    });
    await until(() => sockets.sockets.length === 1);
    sockets.sockets[0]!.receive({
      type: "ready",
      bindingId: BINDING_ID,
      sessionId: SESSION_ID,
      syncState: "idle",
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    sockets.sockets[0]!.receive({ type: "ended", reason: ENDED_REASON });
    await expect(promise).resolves.toMatchObject({ data: { ended: true }, error: undefined });
  });

  it("strictly rejects malformed create and heartbeat responses", async () => {
    const malformedCreate = new HttpHarness();
    malformedCreate.createData = {
      binding: { ...binding(), unexpected: true },
      sessionId: SESSION_ID,
    };
    const createSockets = new SocketHarness();
    const createResult = await runSession(malformedCreate, createSockets.factory);
    expect(createResult.error?.kind).toBe("protocol");
    expect(createSockets.sockets).toHaveLength(0);

    const malformedHeartbeat = new HttpHarness();
    malformedHeartbeat.heartbeatData = { ok: true, binding: binding(), unexpected: true };
    const heartbeatSockets = new SocketHarness();
    const heartbeatPromise = runSession(malformedHeartbeat, heartbeatSockets.factory);
    await until(() => heartbeatSockets.sockets.length === 1);
    const socket = heartbeatSockets.sockets[0]!;
    socket.onSend = (message) => {
      if (message.type === "end") socket.receive({ type: "ended", reason: ENDED_REASON });
    };
    socket.open();
    const heartbeatResult = await heartbeatPromise;
    expect(heartbeatResult.error?.kind).toBe("protocol");
  });

  it("strictly rejects a malformed DELETE success as secondary cleanup", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    http.deleteData = { ok: true, binding: { ...binding({ state: "ended" }), extra: true } };
    const sockets = new SocketHarness();
    const abort = new AbortController();
    const promise = runSession(http, sockets.factory, { signal: abort.signal });
    await until(() => sockets.sockets.length === 1);
    sockets.sockets[0]!.open();
    abort.abort();
    await until(() => sockets.sockets[0]!.sent.some((message) => message.type === "end"));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await promise;
    expect(result.error?.kind).toBe("aborted");
    expect(result.error?.cleanup?.kind).toBe("protocol");
  });

  it("removes on-property listeners, intervals, and sockets after terminal success", async () => {
    vi.useFakeTimers();
    const http = new HttpHarness();
    const socket = new OnPropertySocket();
    const factory: ProjectBindingWebSocketFactory = (url, protocols) => {
      socket.url = url;
      socket.protocols = typeof protocols === "string" ? [protocols] : [...protocols];
      return socket;
    };
    const promise = runSession(http, factory);
    await until(() => socket.url !== "");
    socket.open();
    await until(() => http.heartbeatRequests.length === 1);
    socket.receive({ type: "ended", reason: ENDED_REASON });

    await expect(promise).resolves.toMatchObject({ error: undefined });
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

type RunOptions = {
  auth?: string | ((auth: Auth) => string | undefined | Promise<string | undefined>);
  webSocketUrl?: string;
  signal?: AbortSignal;
  onEvent?: (event: ProjectBindingSessionEvent) => void;
};

function runSession(
  http: HttpHarness,
  webSocketFactory: ProjectBindingWebSocketFactory,
  options: RunOptions = {},
) {
  const client = createClient({
    baseUrl: "https://unused.example/service-prefix",
    fetch: http.fetch,
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
  });
  return runProjectBindingSession({
    client,
    webSocketUrl: options.webSocketUrl ?? "wss://host.example/v1/attach/project-bindings/connect",
    projectRoot: ROOT,
    projectFingerprint: FINGERPRINT,
    webSocketFactory,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
}

function runSessionThrowing(
  http: HttpHarness,
  webSocketFactory: ProjectBindingWebSocketFactory,
  signal: AbortSignal,
) {
  const client = createClient({ baseUrl: "https://unused.example", fetch: http.fetch });
  return runProjectBindingSession({
    client,
    webSocketUrl: "wss://host.example/v1/attach/project-bindings/connect",
    projectRoot: ROOT,
    projectFingerprint: FINGERPRINT,
    webSocketFactory,
    signal,
    throwOnError: true,
  });
}

class HttpHarness {
  readonly requests: Request[] = [];
  createData: unknown = { binding: binding(), sessionId: SESSION_ID };
  heartbeatData: unknown = { ok: true, binding: binding() };
  deleteData: unknown = { ok: true, binding: binding({ state: "ended", syncState: "idle" }) };
  heartbeatStatus = 200;
  deleteStatus = 200;
  heartbeatResponder?: (request: Request) => Response | Promise<Response>;
  deleteResponder?: (request: Request) => Response | Promise<Response>;

  readonly fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    this.requests.push(request);
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname.endsWith("/sessions")) {
      return jsonResponse(this.createData);
    }
    if (request.method === "POST" && pathname.endsWith("/heartbeat")) {
      if (this.heartbeatResponder) return this.heartbeatResponder(request);
      return this.heartbeatStatus === 200
        ? jsonResponse(this.heartbeatData)
        : jsonResponse(legacyError("SERVER_UNAVAILABLE"), this.heartbeatStatus);
    }
    if (request.method === "DELETE" && pathname.endsWith("/session")) {
      if (this.deleteResponder) return this.deleteResponder(request);
      return this.deleteStatus === 200
        ? jsonResponse(this.deleteData)
        : jsonResponse(
            legacyError(this.deleteStatus === 401 ? "AUTH_REQUIRED" : "SERVER_UNAVAILABLE"),
            this.deleteStatus,
          );
    }
    return jsonResponse(legacyError("REQUEST_INVALID"), 404);
  };

  get createRequests(): Request[] {
    return this.requests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/sessions"),
    );
  }

  get heartbeatRequests(): Request[] {
    return this.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname.endsWith("/heartbeat"),
    );
  }

  get deleteRequests(): Request[] {
    return this.requests.filter(
      (request) =>
        request.method === "DELETE" && new URL(request.url).pathname.endsWith("/session"),
    );
  }
}

class FakeSocket implements ProjectBindingWebSocket {
  readyState = 0;
  readonly sent: ProjectBindingSocketClientMessage[] = [];
  readonly listeners = new Map<ProjectBindingSocketEventType, Set<ProjectBindingSocketListener>>();
  closeCalls = 0;
  onSend?: (message: ProjectBindingSocketClientMessage) => void;

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  addEventListener(
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<ProjectBindingSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: ProjectBindingSocketEventType,
    listener: ProjectBindingSocketListener,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const message = JSON.parse(data) as ProjectBindingSocketClientMessage;
    this.sent.push(message);
    this.onSend?.(message);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  receive(message: unknown): void {
    this.receiveRaw(JSON.stringify(message));
  }

  receiveRaw(data: unknown): void {
    this.dispatch("message", { data });
  }

  unexpectedClose(reason: string): void {
    this.readyState = 3;
    this.dispatch("close", { code: 1006, reason });
  }

  private dispatch(type: ProjectBindingSocketEventType, event: ProjectBindingSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class SocketHarness {
  readonly sockets: FakeSocket[] = [];
  readonly urls: string[] = [];
  readonly protocols: string[][] = [];

  readonly factory: ProjectBindingWebSocketFactory = (url, protocols) => {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    this.urls.push(url);
    this.protocols.push(typeof protocols === "string" ? [protocols] : [...protocols]);
    return socket;
  };
}

class OnPropertySocket implements ProjectBindingWebSocket {
  readyState = 0;
  url = "";
  protocols: string[] = [];
  closeCalls = 0;
  readonly sent: ProjectBindingSocketClientMessage[] = [];
  onopen: ProjectBindingSocketListener | null = null;
  onmessage: ProjectBindingSocketListener | null = null;
  onclose: ProjectBindingSocketListener | null = null;
  onerror: ProjectBindingSocketListener | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ProjectBindingSocketClientMessage);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function binding(overrides: Partial<ProjectBinding> = {}): ProjectBinding {
  return { ...baseBinding(), ...overrides };
}

function baseBinding(): ProjectBinding {
  return {
    bindingId: BINDING_ID,
    state: "attaching",
    syncState: "pending",
    projectFingerprint: FINGERPRINT,
    serverProjectRoot: "/srv/project",
    updatedAt: NOW,
    expiresAt: LATER,
  };
}

function legacyError(code: string) {
  return { ok: false, error: { code } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodeBearer(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
