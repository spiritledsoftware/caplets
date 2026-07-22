import { describe, expect, it, vi } from "vitest";
import {
  adminV2GetCapletRecordBundleStream,
  adminV2GetCapletRecordRevisionBundleStream,
  adminV2PutCapletRecordBundleFormData,
  adminV2PutCapletRecordBundleStream,
  createClient,
  createOrderedBundleFormData,
  createOrderedBundleMultipartBody,
} from "../src";

describe("Caplet Bundle helpers", () => {
  it("returns current and revision response bodies by identity without consuming them", async () => {
    const bodies = ["current", "revision"].map(
      (value) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
          },
        }),
    );
    const responses = bodies.map(
      (body) =>
        new Response(body, {
          headers: { "Content-Type": "multipart/mixed; boundary=caplets" },
        }),
    );
    const consumptionSpies = responses.flatMap((response) => [
      vi.spyOn(response, "arrayBuffer"),
      vi.spyOn(response, "blob"),
      vi.spyOn(response, "formData"),
      vi.spyOn(response, "json"),
      vi.spyOn(response, "text"),
    ]);
    let nextResponse = 0;
    const client = createClient({
      auth: "token",
      baseUrl: "https://download.example",
      fetch: async () => responses[nextResponse++]!,
    });

    const current = await adminV2GetCapletRecordBundleStream({
      client,
      path: { id: "example" },
    });
    const revision = await adminV2GetCapletRecordRevisionBundleStream({
      client,
      path: { id: "example", revisionKey: "revision-1" },
    });

    expect(current.error).toBeUndefined();
    expect(current.data).toBe(bodies[0]);
    expect(revision.error).toBeUndefined();
    expect(revision.data).toBe(bodies[1]);
    for (const spy of consumptionSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("sends manifest-first FormData with repeated files and a Fetch-owned boundary", async () => {
    const firstFile = new Blob(["first"]);
    const secondFile = new Blob(["second"]);
    const firstArrayBuffer = vi.spyOn(firstFile, "arrayBuffer");
    const secondArrayBuffer = vi.spyOn(secondFile, "arrayBuffer");
    const body = createOrderedBundleFormData('{"files":["first","second"]}', [
      firstFile,
      secondFile,
    ]);
    const observed: {
      contentType?: string | null;
      names?: string[];
      values?: string[];
    } = {};
    const client = createClient({
      baseUrl: "https://upload.example",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        observed.contentType = request.headers.get("content-type");
        const decoded = await request.formData();
        observed.names = [...decoded.keys()];
        observed.values = await Promise.all(
          [...decoded.values()].map((value) =>
            typeof value === "string" ? Promise.resolve(value) : value.text(),
          ),
        );
        return Response.json({ id: "example" });
      },
    });

    const result = await adminV2PutCapletRecordBundleFormData({
      body,
      client,
      headers: {
        "Idempotency-Key": "00000000-0000-4000-8000-000000000000",
        "If-None-Match": "*",
      },
      path: { id: "example" },
    });

    expect(result.error).toBeUndefined();
    expect(observed.contentType).toMatch(/^multipart\/form-data; boundary=.+/u);
    expect(observed.names).toEqual(["manifest", "file", "file"]);
    expect(observed.values).toEqual(['{"files":["first","second"]}', "first", "second"]);
    expect(firstArrayBuffer).not.toHaveBeenCalled();
    expect(secondArrayBuffer).not.toHaveBeenCalled();
  });

  it("streams multipart parts in order without copying file chunks", async () => {
    const firstChunk = new Uint8Array([1, 2, 3]);
    const secondChunk = new Uint8Array([4, 5]);
    const { body, contentType } = createOrderedBundleMultipartBody(
      '{"files":["first","second"]}',
      [
        {
          open: async function* () {
            yield firstChunk;
          },
        },
        {
          open: async function* () {
            yield secondChunk;
          },
        },
      ],
      "caplets-boundary",
    );
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => [...chunk])));

    expect(contentType).toBe("multipart/form-data; boundary=caplets-boundary");
    expect(chunks).toContain(firstChunk);
    expect(chunks).toContain(secondChunk);
    expect(text.indexOf('name="manifest"')).toBeLessThan(text.indexOf('name="file"'));
    expect(text.match(/name="file"/gu)).toHaveLength(2);
    expect(text.endsWith("--caplets-boundary--\r\n")).toBe(true);
  });

  it("aborts an active source before returning it and settles while its next chunk is pending", async () => {
    const events: string[] = [];
    let resolveNext: ((result: IteratorResult<Uint8Array>) => void) | undefined;
    let markNextStarted: (() => void) | undefined;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    let markReturned: (() => void) | undefined;
    const returned = new Promise<void>((resolve) => {
      markReturned = resolve;
    });
    const returnSource = vi.fn(async () => {
      events.push("return");
      markReturned?.();
      return { done: true as const, value: undefined };
    });
    const { body } = createOrderedBundleMultipartBody(
      "{}",
      [
        {
          open: (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("abort");
              },
              { once: true },
            );
            const source: AsyncIterableIterator<Uint8Array> = {
              [Symbol.asyncIterator]() {
                return this;
              },
              next: () => {
                markNextStarted?.();
                return new Promise<IteratorResult<Uint8Array>>((resolve) => {
                  resolveNext = resolve;
                });
              },
              return: returnSource,
            };
            return source;
          },
        },
      ],
      "cancel-boundary",
    );
    const reader = body.getReader();

    await reader.read();
    await reader.read();
    const pendingRead = reader.read();
    await nextStarted;

    const reason = new Error("caller stopped upload");
    await expect(reader.cancel(reason)).resolves.toBeUndefined();
    await expect(reader.cancel(reason)).resolves.toBeUndefined();
    expect(events).toEqual(["abort"]);
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });

    resolveNext?.({ done: false, value: new Uint8Array([1]) });
    await returned;
    expect(events).toEqual(["abort", "return"]);
    expect(returnSource).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "record",
      () => ({
        Authorization: "Caller upload-token",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000000",
        "If-Match": '"bundle-etag"',
        "If-None-Match": "*",
        "cOnTeNt-TyPe": "text/plain; boundary=caller-controlled",
      }),
    ],
    [
      "Headers",
      () =>
        new Headers({
          Authorization: "Caller upload-token",
          "Idempotency-Key": "00000000-0000-4000-8000-000000000000",
          "If-Match": '"bundle-etag"',
          "If-None-Match": "*",
          "cOnTeNt-TyPe": "text/plain; boundary=caller-controlled",
        }),
    ],
    [
      "tuple array",
      () => [
        ["Authorization", "Caller upload-token"],
        ["Idempotency-Key", "00000000-0000-4000-8000-000000000000"],
        ["If-Match", '"bundle-etag"'],
        ["If-None-Match", "*"],
        ["cOnTeNt-TyPe", "text/plain; boundary=caller-controlled"],
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, () => HeadersInit]>)(
    "uploads with %s headers while retaining caller headers and owning the multipart boundary",
    async (_label, createHeaders) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed-body"));
          controller.close();
        },
      });
      let request: Request | undefined;
      const client = createClient({
        auth: "configured-token",
        baseUrl: "https://upload.example",
        fetch: async (input, init) => {
          request = input instanceof Request ? input : new Request(input, init);
          return Response.json({ id: "example" });
        },
      });

      const result = await adminV2PutCapletRecordBundleStream({
        body,
        client,
        contentType: "multipart/form-data; boundary=stream-boundary",
        headers: createHeaders(),
        path: { id: "example" },
      });

      expect(result.error).toBeUndefined();
      expect(request?.headers.get("authorization")).toBe("Caller upload-token");
      expect(request?.headers.get("idempotency-key")).toBe("00000000-0000-4000-8000-000000000000");
      expect(request?.headers.get("if-match")).toBe('"bundle-etag"');
      expect(request?.headers.get("content-type")).toBe(
        "multipart/form-data; boundary=stream-boundary",
      );
      expect((request as (Request & { readonly duplex: string }) | undefined)?.duplex).toBe("half");
    },
  );
});
