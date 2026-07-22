import { describe, expect, it, vi } from "vitest";
import {
  adminV2CreateRuntimeRestart,
  adminV2GetHost,
  adminV2ListEvents,
  createClient,
} from "../src";

describe("createClient", () => {
  it.each([
    "",
    "/caplets",
    "caplets.example",
    "//caplets.example",
    "ftp://caplets.example",
    "https://caplets.example/service-root",
    "https://caplets.example/service-root/",
    "https://caplets.example//",
    "https://caplets.example/.",
    "https://caplets.example/foo/..",
    "https://caplets.example/%2e",
    "https://caplets.example\\admin",
    "https://caplets.example\n",
    "https://caplets.example ",
  ])("rejects a value that is not a Current Host origin: %j", (baseUrl) => {
    expect(() => createClient({ baseUrl })).toThrow(TypeError);
  });

  it.each([
    "https://operator@caplets.example",
    "https://:secret@caplets.example",
    "https://caplets.example?tenant=operator",
    "https://caplets.example#admin",
    "https://caplets.example?",
    "https://caplets.example#",
  ])("rejects forbidden Current Host origin components: %s", (baseUrl) => {
    expect(() => createClient({ baseUrl })).toThrow(TypeError);
  });

  it.each(["http://caplets.example", "http://192.0.2.10:8787"])(
    "rejects non-loopback plain HTTP Current Host origins: %s",
    (baseUrl) => {
      expect(() => createClient({ baseUrl })).toThrow(TypeError);
    },
  );

  it.each([
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://[::1]:8787/", "http://[::1]:8787"],
    ["https://caplets.example", "https://caplets.example"],
    ["https://caplets.example/", "https://caplets.example"],
  ])("accepts and canonicalizes a Current Host origin: %s", (baseUrl, canonical) => {
    expect(createClient({ baseUrl }).getConfig().baseUrl).toBe(canonical);
  });

  it("resolves generated operations at the canonical API namespace", async () => {
    let request: Request | undefined;
    const client = createClient({
      baseUrl: "https://caplets.example/",
      fetch: async (input, init) => {
        request = input instanceof Request ? input : new Request(input, init);
        return Response.json({ id: "host" });
      },
    });

    const result = await adminV2GetHost({ client });

    expect(result.error).toBeUndefined();
    expect(client.getConfig().baseUrl).toBe("https://caplets.example");
    expect(request?.url).toBe("https://caplets.example/api/v2/admin/host");
  });

  it("uses the non-throwing fields defaults", async () => {
    const requests: Request[] = [];
    const client = createClient({
      baseUrl: "https://caplets.example",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ id: "host" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await adminV2GetHost({ client });

    expect(result.error).toBeUndefined();
    expect(requests[0]?.url).toBe("https://caplets.example/api/v2/admin/host");
    expect(client.getConfig()).toMatchObject({
      baseUrl: "https://caplets.example",
      responseStyle: "fields",
      throwOnError: false,
    });
  });

  it("returns typed error fields instead of throwing by default", async () => {
    const client = createClient({
      baseUrl: "https://caplets.example",
      fetch: async () =>
        Response.json(
          {
            type: "about:blank",
            title: "Unauthorized",
            status: 401,
          },
          { status: 401 },
        ),
    });

    await expect(adminV2GetHost({ client })).resolves.toMatchObject({
      error: {
        title: "Unauthorized",
        status: 401,
      },
      request: expect.any(Request),
      response: expect.any(Response),
    });
  });

  it("applies caller overrides after the SDK defaults", () => {
    const client = createClient({
      baseUrl: "https://caplets.example",
      responseStyle: "data",
      throwOnError: true,
    });

    expect(client.getConfig()).toMatchObject({
      responseStyle: "data",
      throwOnError: true,
    });
  });

  it("allows auth and fetch to be omitted", async () => {
    const fetchAdapter = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: "host" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchAdapter);

    try {
      const client = createClient({ baseUrl: "https://caplets.example" });
      const result = await adminV2GetHost({ client });

      expect(result.error).toBeUndefined();
      expect(fetchAdapter).toHaveBeenCalledOnce();
      const request = fetchAdapter.mock.calls[0]?.[0];
      expect(request).toBeInstanceOf(Request);
      expect((request as Request).headers.has("authorization")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps static and async credentials isolated between clients", async () => {
    const requests: Request[] = [];
    const adapter: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return new Response(JSON.stringify({ id: "host" }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const asyncAuth = vi.fn(async () => "async-token");
    const staticClient = createClient({
      auth: "static-token",
      baseUrl: "https://static.example",
      fetch: adapter,
    });
    const asyncClient = createClient({
      auth: asyncAuth,
      baseUrl: "https://async.example",
      fetch: adapter,
    });

    await adminV2GetHost({ client: staticClient });
    await adminV2GetHost({ client: asyncClient });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://static.example/api/v2/admin/host",
      "https://async.example/api/v2/admin/host",
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer static-token",
      "Bearer async-token",
    ]);
    expect(requests.map((request) => request.headers.get("cookie"))).toEqual([null, null]);
    expect(asyncAuth).toHaveBeenCalledOnce();
    expect(asyncAuth).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "bearer", type: "http" }),
    );
  });

  it("settles aborted SSE setup while an async auth provider remains pending", async () => {
    const controller = new AbortController();
    const authStarted = Promise.withResolvers<void>();
    const authResult = Promise.withResolvers<string>();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createClient({
      auth: async () => {
        authStarted.resolve();
        return await authResult.promise;
      },
      baseUrl: "https://events.invalid",
      fetch,
    });

    const operation = adminV2ListEvents({ client, signal: controller.signal });
    let operationSettled = false;
    void operation.then(
      () => {
        operationSettled = true;
      },
      () => {
        operationSettled = true;
      },
    );
    await authStarted.promise;
    controller.abort();
    const observed = Promise.withResolvers<boolean>();
    setImmediate(() => {
      observed.resolve(operationSettled);
      authResult.reject(new Error("late auth provider rejection"));
    });

    await expect(observed.promise).resolves.toBe(true);
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["record", () => ({ Authorization: "Caller restart-token", "If-Match": '"runtime-etag"' })],
    [
      "Headers",
      () =>
        new Headers({
          Authorization: "Caller restart-token",
          "If-Match": '"runtime-etag"',
        }),
    ],
    [
      "tuple array",
      () => [
        ["Authorization", "Caller restart-token"],
        ["If-Match", '"runtime-etag"'],
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, () => HeadersInit]>)(
    "retains %s client headers with generated request headers and caller auth precedence",
    async (_label, createHeaders) => {
      let request: Request | undefined;
      const client = createClient({
        auth: "configured-token",
        baseUrl: "https://caplets.example",
        headers: createHeaders(),
        fetch: async (input, init) => {
          request = input instanceof Request ? input : new Request(input, init);
          return Response.json({ id: "restart" });
        },
      });

      const result = await adminV2CreateRuntimeRestart({
        body: {},
        client,
        headers: {
          "Idempotency-Key": "00000000-0000-4000-8000-000000000000",
          "If-None-Match": "*",
        },
      });

      expect(result.error).toBeUndefined();
      expect(request?.headers.get("authorization")).toBe("Caller restart-token");
      expect(request?.headers.get("if-match")).toBe('"runtime-etag"');
      expect(request?.headers.get("idempotency-key")).toBe("00000000-0000-4000-8000-000000000000");
      expect(request?.headers.get("content-type")).toBe("application/json");
    },
  );
});
