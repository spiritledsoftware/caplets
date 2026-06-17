import { describe, expect, it, vi } from "vitest";
import { runCodeMode } from "../src/code-mode/runner";
import type { NativeCapletTool, NativeCapletsService } from "../src/native/service";

function service(): NativeCapletsService {
  const tools: NativeCapletTool[] = [
    {
      caplet: "github",
      toolName: "caplets__github",
      title: "GitHub",
      description: "GitHub repo operations.",
      promptGuidance: [],
    },
  ];

  return {
    listTools: () => tools,
    execute: vi.fn(async (capletId: string, request: unknown) => ({
      ok: true,
      capletId,
      request,
    })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function runPlatformCode(code: string) {
  return runCodeMode({
    code,
    service: service(),
    runtimeScope: "test",
  });
}

describe("Code Mode platform API", () => {
  it("exposes utility globals on globalThis", async () => {
    const result = await runPlatformCode(`
      return {
        hasQueueMicrotask: typeof queueMicrotask,
        hasSetTimeout: typeof setTimeout,
        hasClearTimeout: typeof clearTimeout,
        hasSetInterval: typeof setInterval,
        hasClearInterval: typeof clearInterval,
        hasSetImmediate: typeof setImmediate,
        hasClearImmediate: typeof clearImmediate,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        hasQueueMicrotask: "function",
        hasSetTimeout: "function",
        hasClearTimeout: "function",
        hasSetInterval: "function",
        hasClearInterval: "function",
        hasSetImmediate: "function",
        hasClearImmediate: "function",
      },
    });
  });

  it("supports base64 and minimal Buffer conversions", async () => {
    const result = await runPlatformCode(`
      return {
        btoa: btoa("hello"),
        atob: atob("aGVsbG8="),
        bufferUtf8: Buffer.from("hello", "utf8").toString("utf8"),
        bufferBase64: Buffer.from("hello", "utf8").toString("base64"),
        bufferFromBase64: Buffer.from("aGVsbG8=", "base64").toString("utf8"),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        btoa: "aGVsbG8=",
        atob: "hello",
        bufferUtf8: "hello",
        bufferBase64: "aGVsbG8=",
        bufferFromBase64: "hello",
      },
    });
  });

  it("supports URL and URLSearchParams", async () => {
    const result = await runPlatformCode(`
      const url = new URL("https://example.com/path?q=1");
      url.searchParams.set("page", "2");

      return {
        href: url.href,
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
        params: [...url.searchParams.entries()],
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        href: "https://example.com/path?q=1&page=2",
        origin: "https://example.com",
        pathname: "/path",
        search: "?q=1&page=2",
        params: [
          ["q", "1"],
          ["page", "2"],
        ],
      },
    });
  });

  it("supports text encoding and decoding", async () => {
    const result = await runPlatformCode(`
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const bytes = encoder.encode("hello");

      return {
        encoded: Array.from(bytes),
        decoded: decoder.decode(bytes),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        encoded: [104, 101, 108, 108, 111],
        decoded: "hello",
      },
    });
  });

  it("supports crypto randomUUID and getRandomValues", async () => {
    const result = await runPlatformCode(`
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);

      return {
        randomUUID: crypto.randomUUID(),
        valuesLength: bytes.length,
        valuesPattern: Array.from(bytes).every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        randomUUID: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        ),
        valuesLength: 16,
        valuesPattern: true,
      },
    });
  });

  it("supports timers, intervals, and microtasks", async () => {
    const result = await runPlatformCode(`
      return await new Promise((resolve) => {
        const events = [];
        const timeout = setTimeout(() => {
          events.push("timeout");
          clearInterval(interval);
          resolve(events);
        }, 0);

        const interval = setInterval(() => {
          events.push("interval");
        }, 0);

        queueMicrotask(() => {
          events.push("microtask");
          clearTimeout(timeout);
          setTimeout(() => {
            events.push("timeout");
            clearInterval(interval);
            resolve(events);
          }, 0);
        });
      });
    `);

    expect(result).toMatchObject({
      ok: true,
      value: ["microtask", "timeout"],
    });
  });

  it("supports structuredClone", async () => {
    const result = await runPlatformCode(`
      const source = {
        nested: { count: 1 },
        values: [1, 2, 3],
      };
      const clone = structuredClone(source);
      clone.nested.count = 2;
      clone.values.push(4);

      return {
        source: source.nested.count,
        clone: clone.nested.count,
        values: clone.values,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        source: 1,
        clone: 2,
        values: [1, 2, 3, 4],
      },
    });
  });

  it("supports Headers, Blob, File, FormData, streams, Request, and Response", async () => {
    const result = await runPlatformCode(`
      const headers = new Headers([["x-one", "1"]]);
      const blob = new Blob(["hello"], { type: "text/plain" });
      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      const formData = new FormData();
      formData.set("name", "caplets");
      formData.set("fileName", file.name);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue("hello");
          controller.close();
        },
      });

      const request = new Request("https://example.com/api", {
        method: "POST",
        headers,
        body: formData,
      });

      const response = new Response(blob, {
        status: 201,
        headers,
      });

      return {
        headers: headers.get("x-one"),
        blobSize: blob.size,
        blobType: blob.type,
        fileName: file.name,
        fileType: file.type,
        formEntries: [...formData.entries()],
        streamType: typeof stream.getReader,
        requestMethod: request.method,
        requestUrl: request.url,
        responseStatus: response.status,
        responseHeader: response.headers.get("x-one"),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        headers: "1",
        blobSize: 5,
        blobType: "text/plain",
        fileName: "hello.txt",
        fileType: "text/plain",
        formEntries: [
          ["name", "caplets"],
          ["fileName", "hello.txt"],
        ],
        streamType: "function",
        requestMethod: "POST",
        requestUrl: "https://example.com/api",
        responseStatus: 201,
        responseHeader: "1",
      },
    });
  });

  it("supports AbortController and AbortSignal", async () => {
    const result = await runPlatformCode(`
      const controller = new AbortController();
      const { signal } = controller;
      const before = signal.aborted;
      controller.abort("done");

      return {
        before,
        after: signal.aborted,
        reason: signal.reason,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        before: false,
        after: true,
        reason: "done",
      },
    });
  });

  it("keeps fetch unavailable for direct calls", async () => {
    const result = await runPlatformCode(`
      return typeof fetch;
    `);

    expect(result).toMatchObject({
      ok: true,
      value: "undefined",
    });
  });

  it("keeps Node and module globals unavailable", async () => {
    const result = await runPlatformCode(`
      return {
        process: typeof process,
        module: typeof module,
        exports: typeof exports,
        require: typeof require,
        __dirname: typeof __dirname,
        __filename: typeof __filename,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        process: "undefined",
        module: "undefined",
        exports: "undefined",
        require: "undefined",
        __dirname: "undefined",
        __filename: "undefined",
      },
    });
  });
});
