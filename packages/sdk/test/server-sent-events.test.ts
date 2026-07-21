import { describe, expect, it, vi } from "vitest";
import { createSseClient } from "../src/generated/core/serverSentEvents.gen";

const encoder = new TextEncoder();

function responseWithChunks(
  chunks: readonly string[],
  options: {
    close?: boolean;
    cancel?: () => void;
    status?: number;
    statusText?: string;
  } = {},
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (options.close !== false) controller.close();
      },
      cancel() {
        options.cancel?.();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.statusText === undefined ? {} : { statusText: options.statusText }),
    },
  );
}

describe("generated SSE client reliability", () => {
  it("throws terminal 4xx responses without retrying and cancels the body", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      responseWithChunks(["unauthorized"], {
        cancel,
        close: false,
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    const sleep = vi.fn(async () => {});
    const onSseError = vi.fn();
    const { stream } = createSseClient({
      fetch,
      onSseError,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).rejects.toThrow("SSE failed: 401 Unauthorized");
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(onSseError).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the last error when the explicit retry limit is exhausted", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500, statusText: "First" }))
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: "Last" }));
    const sleep = vi.fn(async () => {});
    const onSseError = vi.fn();
    const { stream } = createSseClient({
      fetch,
      onSseError,
      sseMaxRetryAttempts: 2,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).rejects.toThrow("SSE failed: 503 Last");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onSseError).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("cancels every rejected 5xx response body across retries", async () => {
    const cancels = [vi.fn(), vi.fn(), vi.fn()] as const;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        responseWithChunks([], { cancel: cancels[0], close: false, status: 500 }),
      )
      .mockResolvedValueOnce(
        responseWithChunks([], { cancel: cancels[1], close: false, status: 502 }),
      )
      .mockResolvedValueOnce(
        responseWithChunks([], { cancel: cancels[2], close: false, status: 503 }),
      );
    const sleep = vi.fn(async () => {});
    const { stream } = createSseClient({
      fetch,
      sseMaxRetryAttempts: 3,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).rejects.toThrow("SSE failed: 503");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
  });

  it("reconnects after clean EOF with retry policy and Last-Event-ID", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(responseWithChunks(['id: event-1\nretry: 17\ndata: {"step":1}\n\n']))
      .mockResolvedValueOnce(responseWithChunks(['data: {"step":2}\n\n'], { close: false }));
    const sleep = vi.fn(async () => {});
    const onSseError = vi.fn();
    const { stream } = createSseClient<{ event: { step: number } }>({
      fetch,
      onSseError,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).resolves.toMatchObject({ done: false, value: { step: 1 } });
    await expect(stream.next()).resolves.toMatchObject({ done: false, value: { step: 2 } });
    expect(sleep).toHaveBeenCalledWith(17);
    expect(onSseError).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryRequest = fetch.mock.calls[1]![0] as Request;
    expect(retryRequest.headers.get("last-event-id")).toBe("event-1");
    await stream.return();
  });

  it("ignores invalid retry fields instead of reconnecting immediately", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        responseWithChunks([
          "retry: 1.5\nretry: 9007199254740992\nretry: 30001\nretry: -1\ndata: first\n\n",
        ]),
      )
      .mockResolvedValueOnce(responseWithChunks(["data: second\n\n"], { close: false }));
    const sleep = vi.fn(async () => {});
    const { stream } = createSseClient({
      fetch,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).resolves.toMatchObject({ value: "first" });
    await expect(stream.next()).resolves.toMatchObject({ value: "second" });
    expect(sleep).toHaveBeenCalledWith(3_000);
    await stream.return();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 30_001])(
    "falls back to a safe retry delay for invalid caller default %s",
    async (sseDefaultRetryDelay) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(responseWithChunks(["data: first\n\n"]))
        .mockResolvedValueOnce(responseWithChunks(["data: second\n\n"], { close: false }));
      const sleep = vi.fn(async () => {});
      const { stream } = createSseClient({
        fetch,
        sseDefaultRetryDelay,
        sseSleepFn: sleep,
        url: "https://events.invalid/stream",
      });

      await expect(stream.next()).resolves.toMatchObject({ value: "first" });
      await expect(stream.next()).resolves.toMatchObject({ value: "second" });
      expect(sleep).toHaveBeenCalledWith(3_000);
      await stream.return();
    },
  );

  it("preserves multi-line data when every CRLF boundary is split across chunks", async () => {
    const onSseEvent = vi.fn();
    const { stream } = createSseClient({
      fetch: async () =>
        responseWithChunks(["id: event-1\r", "\ndata: first\r", "\ndata: second\r", "\n\r", "\n"]),
      onSseEvent,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: "first\nsecond",
    });
    expect(onSseEvent).toHaveBeenCalledOnce();
    expect(onSseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: "first\nsecond", id: "event-1" }),
    );
    await stream.return();
  });

  it("flushes a trailing carriage return at clean EOF", async () => {
    const { stream } = createSseClient({
      fetch: async () => responseWithChunks(["data: trailing\r\n", "\r"]),
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: "trailing",
    });
    await stream.return();
  });

  it("cancels the active reader when the consumer returns early", async () => {
    const cancel = vi.fn();
    const { stream } = createSseClient<{ event: { ready: boolean } }>({
      fetch: async () => responseWithChunks(['data: {"ready":true}\n\n'], { close: false, cancel }),
      url: "https://events.invalid/stream",
    });

    for await (const event of stream) {
      expect(event).toEqual({ ready: true });
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a quiet connection immediately when the consumer returns", async () => {
    const events: string[] = [];
    const pulling = Promise.withResolvers<void>();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        pull() {
          pulling.resolve();
        },
        cancel() {
          events.push("cancel");
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const { stream } = createSseClient({
      fetch: async () => response,
      sseMaxRetryAttempts: 1,
      url: "https://events.invalid/stream",
    });

    const pending = stream.next();
    await pulling.promise;
    const returned = stream.return();
    const escaped = Promise.withResolvers<void>();
    setImmediate(() => {
      events.push("escape");
      try {
        bodyController.close();
      } catch {
        // The fixed client has already canceled the source.
      }
      escaped.resolve();
    });

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
    await escaped.promise;
    expect(events).toEqual(["cancel", "escape"]);
  });

  it("settles return while an async request hook remains pending", async () => {
    const hookStarted = Promise.withResolvers<void>();
    const hookResult = Promise.withResolvers<Request>();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { stream } = createSseClient({
      fetch,
      onRequest: async () => {
        hookStarted.resolve();
        return await hookResult.promise;
      },
      url: "https://events.invalid/stream",
    });

    let pendingSettled = false;
    const pending = stream.next().finally(() => {
      pendingSettled = true;
    });
    await hookStarted.promise;
    const returned = stream.return();
    const observed = Promise.withResolvers<boolean>();
    setImmediate(() => {
      observed.resolve(pendingSettled);
      hookResult.reject(new Error("late request hook rejection"));
    });

    await expect(observed.promise).resolves.toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("settles caller abort while an async request hook remains pending", async () => {
    const controller = new AbortController();
    const hookStarted = Promise.withResolvers<void>();
    const hookResult = Promise.withResolvers<Request>();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { stream } = createSseClient({
      fetch,
      onRequest: async () => {
        hookStarted.resolve();
        return await hookResult.promise;
      },
      signal: controller.signal,
      url: "https://events.invalid/stream",
    });

    let pendingSettled = false;
    const pending = stream.next().finally(() => {
      pendingSettled = true;
    });
    await hookStarted.promise;
    controller.abort();
    const observed = Promise.withResolvers<boolean>();
    setImmediate(() => {
      observed.resolve(pendingSettled);
      hookResult.reject(new Error("late request hook rejection"));
    });

    await expect(observed.promise).resolves.toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels and throws when pending unterminated event data exceeds 1 MiB", async () => {
    const cancel = vi.fn();
    const onSseError = vi.fn();
    const { stream } = createSseClient({
      fetch: async () =>
        responseWithChunks([`data: ${"x".repeat(1024 * 1024)}`], { close: false, cancel }),
      onSseError,
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).rejects.toThrow("1 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(onSseError).toHaveBeenCalledOnce();
  });

  it("cancels and throws before parsing a completed event over 1 MiB", async () => {
    const cancel = vi.fn();
    const { stream } = createSseClient({
      fetch: async () =>
        responseWithChunks([`data: ${"x".repeat(1024 * 1024)}\n\n`], {
          close: false,
          cancel,
        }),
      url: "https://events.invalid/stream",
    });

    await expect(stream.next()).rejects.toThrow("1 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("clears the default retry timer when the consumer returns during backoff", async () => {
    vi.useFakeTimers();
    const retrying = Promise.withResolvers<void>();
    const { stream } = createSseClient({
      fetch: async () => new Response(null, { status: 503 }),
      onSseError: () => retrying.resolve(),
      url: "https://events.invalid/stream",
    });

    try {
      const pending = stream.next();
      await retrying.promise;
      expect(vi.getTimerCount()).toBe(1);

      const returned = stream.return();
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      await expect(returned).resolves.toEqual({ done: true, value: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the default retry timer when the caller aborts during backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const retrying = Promise.withResolvers<void>();
    const { stream } = createSseClient({
      fetch: async () => new Response(null, { status: 503 }),
      onSseError: () => retrying.resolve(),
      signal: controller.signal,
      url: "https://events.invalid/stream",
    });

    try {
      const pending = stream.next();
      await retrying.promise;
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates and cancels without retry when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const { promise: pulling, resolve: resolvePull } = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            resolvePull();
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const sleep = vi.fn(async () => {});
    const onSseError = vi.fn();
    const { stream } = createSseClient({
      fetch,
      onSseError,
      signal: controller.signal,
      sseSleepFn: sleep,
      url: "https://events.invalid/stream",
    });

    const pending = stream.next();
    await pulling;
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onSseError).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});
