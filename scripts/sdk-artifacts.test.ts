import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adminV2GetCapletRecordBundleStream,
  adminV2GetCapletRecordRevisionBundleStream,
  adminV2GetHost,
  adminV2PutCapletRecordBundleFormData,
  createClient,
  createOrderedBundleFormData,
} from "../packages/sdk/src";
import * as generatedSdk from "../packages/sdk/src/generated";
import {
  normalizeGeneratedClientHeaders,
  normalizeGeneratedClientSseSetup,
  normalizeGeneratedServerSentEvents,
} from "./generate-openapi";

const sdkRoot = resolve("packages/sdk/src");
const generatedSdkRoot = join(sdkRoot, "generated");
const canonicalOpenApiPath = resolve("schemas/caplets-http.openapi.json");
const HTTP_METHODS: Record<string, true> = {
  delete: true,
  get: true,
  head: true,
  options: true,
  patch: true,
  post: true,
  put: true,
  trace: true,
};

async function typescriptFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(root, path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative(root, path));
  }
  return files.sort();
}

async function canonicalOperationIds(): Promise<string[]> {
  const document = JSON.parse(await readFile(canonicalOpenApiPath, "utf8")) as {
    paths?: Record<string, Record<string, { operationId?: unknown }>>;
  };
  const operationIds = Object.values(document.paths ?? {}).flatMap((pathItem) =>
    Object.entries(pathItem)
      .filter(([method]) => HTTP_METHODS[method] === true)
      .map(([, operation]) => operation.operationId)
      .filter((operationId): operationId is string => typeof operationId === "string"),
  );
  expect(new Set(operationIds).size).toBe(operationIds.length);
  return operationIds.sort();
}

describe("generated client normalization", () => {
  it("deterministically preserves HeadersInit tuples and explicit Authorization", () => {
    const generated = `  for (const auth of options.security ?? []) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }

    const token = await getAuthToken(auth, options.auth);

    const name = auth.name ?? "Authorization";

    switch (auth.in) {
    }

    const iterator = header instanceof Headers ? headersEntries(header) : Object.entries(header);`;

    const first = normalizeGeneratedClientHeaders(generated);
    const second = normalizeGeneratedClientHeaders(generated);

    expect(first).toBe(second);
    expect(first).toContain(`    const name = auth.name ?? "Authorization";
    if (checkForExistence(options, name))`);
    expect(first).toContain(`        : Array.isArray(header)
          ? header
          : Object.entries(header);`);
    expect(first.match(/const name = auth\.name/gu)).toHaveLength(1);
  });

  it("keeps generated SSE hardening identical to its deterministic postprocessor", async () => {
    const path = join(generatedSdkRoot, "core", "serverSentEvents.gen.ts");
    const source = await readFile(path, "utf8");

    expect(normalizeGeneratedServerSentEvents(source)).toBe(source);
  });

  it("keeps abortable generated client SSE setup identical to its postprocessor", async () => {
    const path = join(generatedSdkRoot, "client", "client.gen.ts");
    const source = await readFile(path, "utf8");

    expect(normalizeGeneratedClientSseSetup(source)).toBe(source);
  });
});

describe("checked SDK artifacts", () => {
  it("exports every canonical operation from the generated root", async () => {
    expect(Object.keys(generatedSdk).sort()).toEqual(await canonicalOperationIds());
  });

  it("keeps the published root browser-safe and instance-configured", async () => {
    const browserSources = [
      ["index.ts", await readFile(join(sdkRoot, "index.ts"), "utf8")] as const,
      ...(await Promise.all(
        (
          await typescriptFiles(generatedSdkRoot)
        ).map(
          async (file) => [file, await readFile(join(generatedSdkRoot, file), "utf8")] as const,
        ),
      )),
    ];
    for (const [file, source] of browserSources) {
      expect(source, file).not.toMatch(/(?:from\s+|import\s*)["']node:/u);
      expect(source, file).not.toMatch(/\b(?:Buffer|process)\b/u);
    }
    await expect(readFile(join(generatedSdkRoot, "client.gen.ts"))).rejects.toThrow();

    const seen: Request[] = [];
    const adapter: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request);
      return new Response(JSON.stringify({ id: "host" }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const first = createClient({
      auth: "first-token",
      baseUrl: "https://first.invalid",
      fetch: adapter,
    });
    const second = createClient({
      auth: "second-token",
      baseUrl: "https://second.invalid",
      fetch: adapter,
    });

    await adminV2GetHost({ client: first });
    await adminV2GetHost({ client: second });

    expect(seen.map((request) => request.url)).toEqual([
      "https://first.invalid/v2/admin/host",
      "https://second.invalid/v2/admin/host",
    ]);
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer first-token",
      "Bearer second-token",
    ]);
  });

  it("returns both original bundle ReadableStreams without response buffering", async () => {
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
      baseUrl: "https://stream.invalid",
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
    expect(current.data).toBeInstanceOf(ReadableStream);
    expect(revision.error).toBeUndefined();
    expect(revision.data).toBe(bodies[1]);
    expect(revision.data).toBeInstanceOf(ReadableStream);
    for (const spy of consumptionSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("sends manifest-first caller FormData with repeated files and a Fetch boundary", async () => {
    const firstFile = new Blob(["first"]);
    const secondFile = new Blob(["second"]);
    const firstArrayBuffer = vi.spyOn(firstFile, "arrayBuffer");
    const secondArrayBuffer = vi.spyOn(secondFile, "arrayBuffer");
    const body = createOrderedBundleFormData('{"files":["first","second"]}', [
      firstFile,
      secondFile,
    ]);
    const observed: {
      contentType: string | null;
      names?: string[];
      values?: string[];
    } = { contentType: null };
    const client = createClient({
      auth: "token",
      baseUrl: "https://upload.invalid",
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
        return new Response(JSON.stringify({ id: "example" }), {
          headers: { "Content-Type": "application/json" },
        });
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
});
