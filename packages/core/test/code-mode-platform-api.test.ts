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
        queueMicrotask: {
          globalThis: typeof globalThis.queueMicrotask,
          binding: typeof queueMicrotask,
          same: globalThis.queueMicrotask === queueMicrotask,
        },
        setTimeout: {
          globalThis: typeof globalThis.setTimeout,
          binding: typeof setTimeout,
          same: globalThis.setTimeout === setTimeout,
        },
        clearTimeout: {
          globalThis: typeof globalThis.clearTimeout,
          binding: typeof clearTimeout,
          same: globalThis.clearTimeout === clearTimeout,
        },
        setInterval: {
          globalThis: typeof globalThis.setInterval,
          binding: typeof setInterval,
          same: globalThis.setInterval === setInterval,
        },
        clearInterval: {
          globalThis: typeof globalThis.clearInterval,
          binding: typeof clearInterval,
          same: globalThis.clearInterval === clearInterval,
        },
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        queueMicrotask: {
          globalThis: "function",
          binding: "function",
          same: true,
        },
        setTimeout: {
          globalThis: "function",
          binding: "function",
          same: true,
        },
        clearTimeout: {
          globalThis: "function",
          binding: "function",
          same: true,
        },
        setInterval: {
          globalThis: "function",
          binding: "function",
          same: true,
        },
        clearInterval: {
          globalThis: "function",
          binding: "function",
          same: true,
        },
      },
    });
  });

  it("supports base64 and minimal Buffer conversions", async () => {
    const result = await runPlatformCode(`
      return {
        globalThisBtoa: typeof globalThis.btoa,
        globalThisAtob: typeof globalThis.atob,
        globalThisBuffer: typeof globalThis.Buffer,
        btoa: globalThis.btoa("hello"),
        atob: globalThis.atob("aGVsbG8="),
        bufferUtf8: globalThis.Buffer.from("hello", "utf8").toString("utf8"),
        bufferBase64: globalThis.Buffer.from("hello", "utf8").toString("base64"),
        bufferFromBase64: globalThis.Buffer.from("aGVsbG8=", "base64").toString("utf8"),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisBtoa: "function",
        globalThisAtob: "function",
        globalThisBuffer: "function",
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
      const url = new globalThis.URL("https://example.com/path?q=1");
      url.searchParams.set("page", "2");

      return {
        globalThisURL: typeof globalThis.URL,
        globalThisURLSearchParams: typeof globalThis.URLSearchParams,
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
        globalThisURL: "function",
        globalThisURLSearchParams: "function",
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
      const encoder = new globalThis.TextEncoder();
      const decoder = new globalThis.TextDecoder();
      const bytes = encoder.encode("hello");

      return {
        globalThisTextEncoder: typeof globalThis.TextEncoder,
        globalThisTextDecoder: typeof globalThis.TextDecoder,
        encoded: Array.from(bytes),
        decoded: decoder.decode(bytes),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisTextEncoder: "function",
        globalThisTextDecoder: "function",
        encoded: [104, 101, 108, 108, 111],
        decoded: "hello",
      },
    });
  });

  it("supports crypto randomUUID and getRandomValues", async () => {
    const result = await runPlatformCode(`
      const first = new Uint8Array(32);
      const second = new Uint8Array(32);
      globalThis.crypto.getRandomValues(first);
      globalThis.crypto.getRandomValues(second);

      return {
        globalThisCrypto: typeof globalThis.crypto,
        randomUUID: globalThis.crypto.randomUUID(),
        first: Array.from(first),
        second: Array.from(second),
        firstHasNonZero: first.some((value) => value !== 0),
        secondHasNonZero: second.some((value) => value !== 0),
        samplesDiffer: first.some((value, index) => value !== second[index]),
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisCrypto: "object",
        randomUUID: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        ),
        first: expect.any(Array),
        second: expect.any(Array),
        firstHasNonZero: true,
        secondHasNonZero: true,
        samplesDiffer: true,
      },
    });
  });

  it("supports timers, intervals, and microtasks", async () => {
    const result = await runPlatformCode(`
      return await new Promise((resolve) => {
        const events = [];
        let ticks = 0;
        const interval = globalThis.setInterval(() => {
          ticks += 1;
          events.push(\`interval-\${ticks}\`);
          if (ticks === 2) {
            globalThis.clearInterval(interval);
            resolve(events);
          }
        }, 0);

        globalThis.queueMicrotask(() => {
          events.push("microtask");
        });

        globalThis.setTimeout(() => {
          events.push("timeout");
        }, 0);
      });
    `);

    expect(result).toMatchObject({
      ok: true,
      value: expect.arrayContaining(["microtask", "timeout", "interval-1", "interval-2"]),
    });
    expect(result).toMatchObject({
      ok: true,
      value: expect.arrayContaining(["microtask", "timeout"]),
    });
    expect((result as { ok: true; value: string[] }).value[0]).toBe("microtask");
    expect(
      (result as { ok: true; value: string[] }).value.filter((event) =>
        event.startsWith("interval-"),
      ),
    ).toEqual(["interval-1", "interval-2"]);
  });

  it("supports structuredClone", async () => {
    const result = await runPlatformCode(`
      const source = {
        nested: { count: 1 },
        values: [1, 2, 3],
      };
      const clone = globalThis.structuredClone(source);
      clone.nested.count = 2;
      clone.values.push(4);

      return {
        globalThisStructuredClone: typeof globalThis.structuredClone,
        source: source.nested.count,
        clone: clone.nested.count,
        values: clone.values,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisStructuredClone: "function",
        source: 1,
        clone: 2,
        values: [1, 2, 3, 4],
      },
    });
  });

  it("supports Headers, Blob, File, FormData, streams, Request, and Response", async () => {
    const result = await runPlatformCode(`
      const headers = new globalThis.Headers([["x-one", "1"]]);
      const blob = new globalThis.Blob(["hello"], { type: "text/plain" });
      const file = new globalThis.File(["hello"], "hello.txt", { type: "text/plain" });
      const formData = new globalThis.FormData();
      formData.set("name", "caplets");
      formData.set("fileName", file.name);

      const stream = new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue("hello");
          controller.close();
        },
      });

      const request = new globalThis.Request("https://example.com/api", {
        method: "POST",
        headers,
        body: formData,
      });

      const response = new globalThis.Response(blob, {
        status: 201,
        headers,
      });

      return {
        globalThisHeaders: typeof globalThis.Headers,
        globalThisBlob: typeof globalThis.Blob,
        globalThisFile: typeof globalThis.File,
        globalThisFormData: typeof globalThis.FormData,
        globalThisReadableStream: typeof globalThis.ReadableStream,
        globalThisRequest: typeof globalThis.Request,
        globalThisResponse: typeof globalThis.Response,
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
        globalThisHeaders: "function",
        globalThisBlob: "function",
        globalThisFile: "function",
        globalThisFormData: "function",
        globalThisReadableStream: "function",
        globalThisRequest: "function",
        globalThisResponse: "function",
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
      const controller = new globalThis.AbortController();
      const { signal } = controller;
      const before = signal.aborted;
      controller.abort("done");

      return {
        globalThisAbortController: typeof globalThis.AbortController,
        globalThisAbortSignal: typeof globalThis.AbortSignal,
        before,
        after: signal.aborted,
        reason: signal.reason,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisAbortController: "function",
        globalThisAbortSignal: "function",
        before: false,
        after: true,
        reason: "done",
      },
    });
  });

  it("keeps fetch unavailable for direct calls", async () => {
    const directResult = await runPlatformCode(`
      return await fetch("https://example.com");
    `);
    const globalResult = await runPlatformCode(`
      return await globalThis.fetch("https://example.com");
    `);

    expect(directResult.ok).toBe(false);
    expect(globalResult.ok).toBe(false);
    expect(directResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "FETCH_UNAVAILABLE",
    );
    expect(globalResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "FETCH_UNAVAILABLE",
    );
  });

  it("keeps Node globals unavailable", async () => {
    const result = await runPlatformCode(`
      return {
        process: typeof process,
        globalThisProcess: typeof globalThis.process,
        module: typeof module,
        globalThisModule: typeof globalThis.module,
        exports: typeof exports,
        globalThisExports: typeof globalThis.exports,
        require: typeof require,
        globalThisRequire: typeof globalThis.require,
        __dirname: typeof __dirname,
        globalThisDirname: typeof globalThis.__dirname,
        __filename: typeof __filename,
        globalThisFilename: typeof globalThis.__filename,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        process: "undefined",
        globalThisProcess: "undefined",
        module: "undefined",
        globalThisModule: "undefined",
        exports: "undefined",
        globalThisExports: "undefined",
        require: "undefined",
        globalThisRequire: "undefined",
        __dirname: "undefined",
        globalThisDirname: "undefined",
        __filename: "undefined",
        globalThisFilename: "undefined",
      },
    });
  });

  it("blocks dynamic filesystem and child-process imports", async () => {
    const result = await runPlatformCode(`
      await import("node:fs");
      await import("node:child_process");
      return { done: true };
    `);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("IMPORT_UNAVAILABLE");
  });
});
