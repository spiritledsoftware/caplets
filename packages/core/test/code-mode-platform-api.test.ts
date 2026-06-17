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
  it("exposes supported globals on top-level bindings and globalThis", async () => {
    const result = await runPlatformCode(`
      return {
        atob: {
          binding: typeof atob,
          globalThis: typeof globalThis.atob,
          same: typeof atob !== "undefined" && globalThis.atob === atob,
        },
        btoa: {
          binding: typeof btoa,
          globalThis: typeof globalThis.btoa,
          same: typeof btoa !== "undefined" && globalThis.btoa === btoa,
        },
        Buffer: {
          binding: typeof Buffer,
          globalThis: typeof globalThis.Buffer,
          same: typeof Buffer !== "undefined" && globalThis.Buffer === Buffer,
        },
        URL: {
          binding: typeof URL,
          globalThis: typeof globalThis.URL,
          same: typeof URL !== "undefined" && globalThis.URL === URL,
        },
        URLSearchParams: {
          binding: typeof URLSearchParams,
          globalThis: typeof globalThis.URLSearchParams,
          same: typeof URLSearchParams !== "undefined" && globalThis.URLSearchParams === URLSearchParams,
        },
        TextEncoder: {
          binding: typeof TextEncoder,
          globalThis: typeof globalThis.TextEncoder,
          same: typeof TextEncoder !== "undefined" && globalThis.TextEncoder === TextEncoder,
        },
        TextDecoder: {
          binding: typeof TextDecoder,
          globalThis: typeof globalThis.TextDecoder,
          same: typeof TextDecoder !== "undefined" && globalThis.TextDecoder === TextDecoder,
        },
        crypto: {
          binding: typeof crypto,
          globalThis: typeof globalThis.crypto,
          same: typeof crypto !== "undefined" && globalThis.crypto === crypto,
        },
        structuredClone: {
          binding: typeof structuredClone,
          globalThis: typeof globalThis.structuredClone,
          same:
            typeof structuredClone !== "undefined" && globalThis.structuredClone === structuredClone,
        },
        Headers: {
          binding: typeof Headers,
          globalThis: typeof globalThis.Headers,
          same: typeof Headers !== "undefined" && globalThis.Headers === Headers,
        },
        Blob: {
          binding: typeof Blob,
          globalThis: typeof globalThis.Blob,
          same: typeof Blob !== "undefined" && globalThis.Blob === Blob,
        },
        File: {
          binding: typeof File,
          globalThis: typeof globalThis.File,
          same: typeof File !== "undefined" && globalThis.File === File,
        },
        FormData: {
          binding: typeof FormData,
          globalThis: typeof globalThis.FormData,
          same: typeof FormData !== "undefined" && globalThis.FormData === FormData,
        },
        ReadableStream: {
          binding: typeof ReadableStream,
          globalThis: typeof globalThis.ReadableStream,
          same:
            typeof ReadableStream !== "undefined" && globalThis.ReadableStream === ReadableStream,
        },
        WritableStream: {
          binding: typeof WritableStream,
          globalThis: typeof globalThis.WritableStream,
          same:
            typeof WritableStream !== "undefined" && globalThis.WritableStream === WritableStream,
        },
        TransformStream: {
          binding: typeof TransformStream,
          globalThis: typeof globalThis.TransformStream,
          same:
            typeof TransformStream !== "undefined" && globalThis.TransformStream === TransformStream,
        },
        AbortController: {
          binding: typeof AbortController,
          globalThis: typeof globalThis.AbortController,
          same:
            typeof AbortController !== "undefined" &&
            globalThis.AbortController === AbortController,
        },
        AbortSignal: {
          binding: typeof AbortSignal,
          globalThis: typeof globalThis.AbortSignal,
          same: typeof AbortSignal !== "undefined" && globalThis.AbortSignal === AbortSignal,
        },
        Request: {
          binding: typeof Request,
          globalThis: typeof globalThis.Request,
          same: typeof Request !== "undefined" && globalThis.Request === Request,
        },
        Response: {
          binding: typeof Response,
          globalThis: typeof globalThis.Response,
          same: typeof Response !== "undefined" && globalThis.Response === Response,
        },
        console: {
          binding: typeof console,
          globalThis: typeof globalThis.console,
          same: typeof console !== "undefined" && globalThis.console === console,
        },
        queueMicrotask: {
          binding: typeof queueMicrotask,
          globalThis: typeof globalThis.queueMicrotask,
          same:
            typeof queueMicrotask !== "undefined" &&
            globalThis.queueMicrotask === queueMicrotask,
        },
        setTimeout: {
          binding: typeof setTimeout,
          globalThis: typeof globalThis.setTimeout,
          same: typeof setTimeout !== "undefined" && globalThis.setTimeout === setTimeout,
        },
        clearTimeout: {
          binding: typeof clearTimeout,
          globalThis: typeof globalThis.clearTimeout,
          same: typeof clearTimeout !== "undefined" && globalThis.clearTimeout === clearTimeout,
        },
        setInterval: {
          binding: typeof setInterval,
          globalThis: typeof globalThis.setInterval,
          same: typeof setInterval !== "undefined" && globalThis.setInterval === setInterval,
        },
        clearInterval: {
          binding: typeof clearInterval,
          globalThis: typeof globalThis.clearInterval,
          same:
            typeof clearInterval !== "undefined" &&
            globalThis.clearInterval === clearInterval,
        },
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        atob: { binding: "function", globalThis: "function", same: true },
        btoa: { binding: "function", globalThis: "function", same: true },
        Buffer: { binding: "function", globalThis: "function", same: true },
        URL: { binding: "function", globalThis: "function", same: true },
        URLSearchParams: { binding: "function", globalThis: "function", same: true },
        TextEncoder: { binding: "function", globalThis: "function", same: true },
        TextDecoder: { binding: "function", globalThis: "function", same: true },
        crypto: { binding: "object", globalThis: "object", same: true },
        structuredClone: { binding: "function", globalThis: "function", same: true },
        Headers: { binding: "function", globalThis: "function", same: true },
        Blob: { binding: "function", globalThis: "function", same: true },
        File: { binding: "function", globalThis: "function", same: true },
        FormData: { binding: "function", globalThis: "function", same: true },
        ReadableStream: { binding: "function", globalThis: "function", same: true },
        WritableStream: { binding: "function", globalThis: "function", same: true },
        TransformStream: { binding: "function", globalThis: "function", same: true },
        AbortController: { binding: "function", globalThis: "function", same: true },
        AbortSignal: { binding: "function", globalThis: "function", same: true },
        Request: { binding: "function", globalThis: "function", same: true },
        Response: { binding: "function", globalThis: "function", same: true },
        console: { binding: "object", globalThis: "object", same: true },
        queueMicrotask: { binding: "function", globalThis: "function", same: true },
        setTimeout: { binding: "function", globalThis: "function", same: true },
        clearTimeout: { binding: "function", globalThis: "function", same: true },
        setInterval: { binding: "function", globalThis: "function", same: true },
        clearInterval: { binding: "function", globalThis: "function", same: true },
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
        sameGlobal: globalThis.crypto === crypto,
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
        sameGlobal: true,
        randomUUID: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual(expect.arrayContaining(["microtask", "timeout"]));
    expect(result.value).toEqual(expect.arrayContaining(["interval-1", "interval-2"]));
    expect(result.value[0]).toBe("microtask");
    expect(result.value.filter((event) => event.startsWith("interval-"))).toEqual([
      "interval-1",
      "interval-2",
    ]);
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
        sameGlobal: globalThis.structuredClone === structuredClone,
        source: source.nested.count,
        clone: clone.nested.count,
        values: clone.values,
      };
    `);

    expect(result).toMatchObject({
      ok: true,
      value: {
        globalThisStructuredClone: "function",
        sameGlobal: true,
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

      const readableStream = new globalThis.ReadableStream({
        start(controller) {
          controller.enqueue("hello");
          controller.close();
        },
      });
      const writableStream = new globalThis.WritableStream({
        write(chunk) {
          writes.push(chunk);
        },
      });
      const transformStream = new globalThis.TransformStream({
        transform(chunk, controller) {
          controller.enqueue(String(chunk).toUpperCase());
        },
      });
      const writes = [];
      const readableFirst = await readableStream.getReader().read();
      const writer = writableStream.getWriter();
      await writer.write("written");
      await writer.close();
      const transformWriter = transformStream.writable.getWriter();
      await transformWriter.write("mixed");
      await transformWriter.close();
      const transformFirst = await transformStream.readable.getReader().read();

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
        globalThisWritableStream: typeof globalThis.WritableStream,
        globalThisTransformStream: typeof globalThis.TransformStream,
        globalThisRequest: typeof globalThis.Request,
        globalThisResponse: typeof globalThis.Response,
        headers: headers.get("x-one"),
        blobSize: blob.size,
        blobType: blob.type,
        fileName: file.name,
        fileType: file.type,
        formEntries: [...formData.entries()],
        readableStreamType: typeof readableStream.getReader,
        writableStreamType: typeof writableStream.getWriter,
        transformStreamType: typeof transformStream.readable,
        readableFirst,
        writes,
        transformFirst,
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
        globalThisWritableStream: "function",
        globalThisTransformStream: "function",
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
        readableStreamType: "function",
        writableStreamType: "function",
        transformStreamType: "object",
        readableFirst: { value: "hello", done: false },
        writes: ["written"],
        transformFirst: { value: "MIXED", done: false },
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
        sameAbortController: globalThis.AbortController === AbortController,
        sameAbortSignal: globalThis.AbortSignal === AbortSignal,
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
        sameAbortController: true,
        sameAbortSignal: true,
        before: false,
        after: true,
        reason: "done",
      },
    });
  });

  it("keeps fetch unavailable for direct calls", async () => {
    const directResult = await runPlatformCode(`
      console.log("fetch sentinel should not run");
      const response = await fetch("data:text/plain,blocked");
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    `);
    const globalResult = await runPlatformCode(`
      console.log("global fetch sentinel should not run");
      const response = await globalThis.fetch("data:text/plain,blocked");
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    `);

    expect(directResult.ok).toBe(false);
    expect(globalResult.ok).toBe(false);
    expect(directResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "FETCH_UNAVAILABLE",
    );
    expect(globalResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "FETCH_UNAVAILABLE",
    );
    expect(directResult.logs.entries).toEqual([]);
    expect(globalResult.logs.entries).toEqual([]);
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
        global: typeof global,
        globalThisGlobal: typeof globalThis.global,
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
        global: "undefined",
        globalThisGlobal: "undefined",
        __dirname: "undefined",
        globalThisDirname: "undefined",
        __filename: "undefined",
        globalThisFilename: "undefined",
      },
    });
  });

  it.each([
    ["node:fs", "filesystem"],
    ["node:child_process", "child process"],
    ["node:http", "direct network"],
    ["left-pad", "arbitrary"],
  ])("blocks %s imports with IMPORT_UNAVAILABLE", async (specifier) => {
    const result = await runPlatformCode(`
      await import(${JSON.stringify(specifier)});
      return { done: true };
    `);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("IMPORT_UNAVAILABLE");
  });
});
