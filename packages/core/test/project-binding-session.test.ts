import { describe, expect, it, vi } from "vitest";
import { RemoteProjectBindingSessionManager } from "../src/project-binding/session";

function sessionResponse() {
  return Response.json({
    binding: { bindingId: "binding_1" },
    sessionId: "session_1",
  });
}

describe("RemoteProjectBindingSessionManager", () => {
  it("starts, heartbeats, and closes a Current Host Project Binding session", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push({
        url: input.toString(),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return String(input).endsWith("/sessions") ? sessionResponse() : Response.json({ ok: true });
    });
    const manager = new RemoteProjectBindingSessionManager({
      origin: new URL("https://host.example"),
      requestInit: { headers: { Authorization: "Bearer access" } },
      fetch,
      projectRoot: "/repo",
      heartbeatIntervalMs: 30_000,
    });

    await expect(manager.start()).resolves.toBe(true);
    await manager.updateAllowedCapletIds();
    await manager.close();

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST https://host.example/api/v1/attach/project-bindings/sessions",
      "POST https://host.example/api/v1/attach/project-bindings/binding_1/heartbeat",
      "DELETE https://host.example/api/v1/attach/project-bindings/binding_1/session",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      sessionId: "session_1",
      terminalReason: { code: "completed", message: "Binding Session completed." },
    });
  });

  it("aborts a timed-out registration and ignores its late response", async () => {
    vi.useFakeTimers();
    try {
      const started = Promise.withResolvers<void>();
      const lateResponse = Promise.withResolvers<Response>();
      let signal: AbortSignal | undefined;
      const manager = new RemoteProjectBindingSessionManager({
        origin: new URL("https://host.example"),
        requestInit: {},
        fetch: (async (_input, init) => {
          signal = init?.signal ?? undefined;
          started.resolve();
          return await lateResponse.promise;
        }) as typeof globalThis.fetch,
        projectRoot: "/repo",
        heartbeatIntervalMs: 30_000,
        mutationTimeoutMs: 100,
      });

      const starting = manager.start();
      const rejected = expect(starting).rejects.toThrow(/timed out/u);
      await started.promise;
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(signal?.aborted).toBe(true);

      lateResponse.resolve(sessionResponse());
      await Promise.resolve();
      await manager.close();
      expect(manager.hasActiveSession()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes an in-flight heartbeat before terminal cleanup", async () => {
    const heartbeatStarted = Promise.withResolvers<void>();
    const releaseHeartbeat = Promise.withResolvers<void>();
    const events: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions")) return sessionResponse();
      if (url.endsWith("/heartbeat")) {
        events.push("heartbeat");
        heartbeatStarted.resolve();
        await releaseHeartbeat.promise;
        return Response.json({ ok: true });
      }
      if (init?.method === "DELETE") events.push("close");
      return Response.json({ ok: true });
    });
    const manager = new RemoteProjectBindingSessionManager({
      origin: new URL("https://host.example"),
      requestInit: {},
      fetch,
      projectRoot: "/repo",
      heartbeatIntervalMs: 30_000,
    });
    await manager.start();

    const heartbeat = manager.updateAllowedCapletIds();
    await heartbeatStarted.promise;
    const closing = manager.close();
    expect(events).toEqual(["heartbeat"]);
    releaseHeartbeat.resolve();
    await Promise.all([heartbeat, closing]);

    expect(events).toEqual(["heartbeat", "close"]);
  });

  it("coalesces timer heartbeats and prevents any heartbeat after close begins", async () => {
    vi.useFakeTimers();
    try {
      const heartbeatStarted = Promise.withResolvers<void>();
      const releaseHeartbeat = Promise.withResolvers<void>();
      let heartbeatCalls = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/sessions")) return sessionResponse();
        if (url.endsWith("/heartbeat")) {
          heartbeatCalls += 1;
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
        }
        return Response.json({ ok: true });
      });
      const manager = new RemoteProjectBindingSessionManager({
        origin: new URL("https://host.example"),
        requestInit: {},
        fetch,
        projectRoot: "/repo",
        heartbeatIntervalMs: 1_000,
      });
      await manager.start();

      vi.advanceTimersByTime(3_000);
      await heartbeatStarted.promise;
      const closing = manager.close();
      releaseHeartbeat.resolve();
      await closing;
      await vi.advanceTimersByTimeAsync(3_000);

      expect(heartbeatCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
