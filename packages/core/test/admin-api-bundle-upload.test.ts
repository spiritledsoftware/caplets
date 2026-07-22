import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdminBundleUploadAdmissionController,
  AdminBundleUploadCapacityError,
} from "../src/admin-api/bundle-upload-admission";
import {
  DEFAULT_ADMIN_BUNDLE_MULTIPART_OVERHEAD_BYTES,
  DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES,
  DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
  type AdminBundleUploadLimits,
} from "../src/admin-api/bundle-contract";
import {
  AdminBundleUploadMediaTypeError,
  parseAdminBundleUpload,
} from "../src/admin-api/bundle-upload-parser";
import { problemDetailsFromError } from "../src/admin-api/problem";

const directories: string[] = [];
const limits: AdminBundleUploadLimits = {
  maxManifestBytes: 1024,
  maxFiles: 2,
  maxDocumentBytes: 16,
  maxFileBytes: 16,
  maxTotalFileBytes: 24,
  maxRequestBytes: 2048,
  maxHeaderBytes: 256,
  maxHeaderPairs: 8,
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Admin Bundle upload admission", () => {
  it("bounds active uploads and aggregate staged-byte reservations", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 2,
      maxStagedBytes: 10,
      limits,
    });
    const first = await controller.acquire();
    const second = await controller.acquire();

    expect(() => first.reserveStagedBytes(7)).not.toThrow();
    expect(() => second.reserveStagedBytes(4)).toThrow(AdminBundleUploadCapacityError);
    await expect(controller.acquire()).rejects.toMatchObject({
      code: "UPLOAD_CAPACITY_EXCEEDED",
      status: 429,
    });

    await first.cleanup();
    expect(() => second.reserveStagedBytes(4)).not.toThrow();
    const replacement = await controller.acquire();
    await replacement.cleanup();
    await second.cleanup();
    await controller.close();
  });

  it("uses one process-unique root and removes it on close", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      limits,
    });

    await Promise.all([controller.initialize(), controller.initialize()]);
    const roots = (await readdir(stagingRoot)).filter((entry) =>
      entry.startsWith("caplets-admin-upload-"),
    );
    expect(roots).toHaveLength(1);
    const [processRoot] = roots;
    expect(processRoot).toMatch(/^caplets-admin-upload-/u);
    const lease = await controller.acquire();
    const requestRoot = await lease.createRequestDirectory();
    expect(requestRoot.startsWith(join(stagingRoot, processRoot!))).toBe(true);
    await lease.cleanup();
    await lease.cleanup();
    await controller.close();

    await expect(access(join(stagingRoot, processRoot!))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Admin Bundle multipart parser", () => {
  it("budgets document, auxiliary, manifest, and bounded multipart bytes separately", () => {
    expect(DEFAULT_ADMIN_BUNDLE_MULTIPART_OVERHEAD_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES).toBe(
      DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxManifestBytes +
        DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxDocumentBytes +
        DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxTotalFileBytes +
        DEFAULT_ADMIN_BUNDLE_MULTIPART_OVERHEAD_BYTES,
    );
  });

  it("stages a legal manifest-first upload as manifest-ordered reopenable sources", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      limits,
    });
    const first = Buffer.from("alpha");
    const second = Buffer.from("bravo!");
    const bundleManifest = {
      ...makeManifest([
        { path: "assets/a.txt", content: first, executable: false },
        { path: "bin/run", content: second, executable: true },
      ]),
      installation: {
        sourceKind: "git",
        sourceIdentity: "https://example.com/demo.git",
        channel: "stable",
      },
    };
    const upload = multipart([
      fieldPart("manifest", JSON.stringify(bundleManifest)),
      filePart("file", first, "ignored-first-name"),
      filePart("file", second, "../../ignored-second-name"),
    ]);

    const parsed = await parseAdminBundleUpload({
      input: Readable.from(chunk(upload.body, 7)),
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
      admission: controller,
      signal: new AbortController().signal,
    });

    expect(parsed.manifest).toEqual(bundleManifest);
    expect(
      parsed.files.map(({ path, size, sha256, executable }) => ({
        path,
        size,
        sha256,
        executable,
      })),
    ).toEqual(bundleManifest.files);
    await expect(readSource(parsed.files[0]!.open())).resolves.toEqual(first);
    await expect(readSource(parsed.files[0]!.open())).resolves.toEqual(first);
    await expect(readSource(parsed.files[1]!.open())).resolves.toEqual(second);
    const [processRoot] = (await readdir(stagingRoot)).filter((entry) =>
      entry.startsWith("caplets-admin-upload-"),
    );
    const processPath = join(stagingRoot, processRoot!);
    const requestRoot = (await readdir(processPath)).find((entry) => entry.startsWith("request-"));
    const requestPath = join(processPath, requestRoot!);
    expect((await stat(processPath)).mode & 0o777).toBe(0o700);
    expect((await stat(requestPath)).mode & 0o777).toBe(0o700);
    for (const stagedFile of await readdir(requestPath)) {
      expect((await stat(join(requestPath, stagedFile))).mode & 0o777).toBe(0o600);
    }
    await parsed.cleanup();
    await parsed.cleanup();
    await expectNoRequestDirectories(stagingRoot);
    await controller.close();
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it.each([
    { installation: { sourceKind: "git" } },
    { installation: { sourceIdentity: "https://example.com/demo.git" } },
    {
      installation: {
        sourceKind: "git",
        sourceIdentity: "https://example.com/demo.git",
        unexpected: true,
      },
    },
    {
      installation: {
        sourceKind: "",
        sourceIdentity: "https://example.com/demo.git",
      },
    },
  ])("rejects partial or invalid installation metadata %#", async ({ installation }) => {
    const content = Buffer.from("alpha");
    const upload = multipart([
      fieldPart(
        "manifest",
        JSON.stringify({
          ...makeManifest([{ path: "a.txt", content, executable: false }]),
          installation,
        }),
      ),
      filePart("file", content),
    ]);

    await expect(
      rejectUpload(upload.body, {
        contentType: upload.contentType,
        contentLength: String(upload.body.byteLength),
      }),
    ).resolves.toMatchObject({ code: "REQUEST_INVALID", status: 400 });
  });

  it("admits the maximum document plus the full auxiliary allowance", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      limits,
    });
    const document = Buffer.alloc(limits.maxDocumentBytes, 0x64);
    const first = Buffer.alloc(12, 0x61);
    const second = Buffer.alloc(12, 0x62);
    const manifest = makeManifest([
      { path: "CAPLET.md", content: document, executable: false },
      { path: "assets/a", content: first, executable: false },
      { path: "assets/b", content: second, executable: false },
    ]);
    const upload = multipart([
      fieldPart("manifest", JSON.stringify(manifest)),
      filePart("file", document),
      filePart("file", first),
      filePart("file", second),
    ]);

    const parsed = await parseAdminBundleUpload({
      input: Readable.from(chunk(upload.body, 13)),
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
      admission: controller,
      signal: new AbortController().signal,
    });

    expect(parsed.files.map(({ path, size }) => ({ path, size }))).toEqual(
      manifest.files.map(({ path, size }) => ({ path, size })),
    );
    await parsed.cleanup();
    await controller.close();
  });

  it.each([
    {
      name: "a document one byte over its separate allowance",
      files: [
        { path: "CAPLET.md", content: Buffer.alloc(17), executable: false },
        { path: "asset", content: Buffer.alloc(1), executable: false },
      ],
    },
    {
      name: "auxiliary bytes one byte over their aggregate allowance",
      files: [
        { path: "CAPLET.md", content: Buffer.alloc(16), executable: false },
        { path: "asset-a", content: Buffer.alloc(16), executable: false },
        { path: "asset-b", content: Buffer.alloc(9), executable: false },
      ],
    },
    {
      name: "one auxiliary file over the separate file-count allowance",
      files: [
        { path: "CAPLET.md", content: Buffer.alloc(1), executable: false },
        { path: "asset-a", content: Buffer.alloc(1), executable: false },
        { path: "asset-b", content: Buffer.alloc(1), executable: false },
        { path: "asset-c", content: Buffer.alloc(1), executable: false },
      ],
    },
  ])("rejects $name", async ({ files }) => {
    const manifest = makeManifest(files);
    const upload = multipart([
      fieldPart("manifest", JSON.stringify(manifest)),
      ...files.map((file) => filePart("file", file.content)),
    ]);
    const error = await rejectUpload(upload.body, {
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
    });

    expect(error).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });
  });

  it("accepts a pre-acquired lease and releases it only through result cleanup", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      limits,
    });
    const lease = await controller.acquire();
    const upload = legalSingleFileUpload();
    const firstBoundaryBytes = Buffer.byteLength("--caplets-test-boundary");
    const parsed = await parseAdminBundleUpload({
      input: Readable.from([
        upload.body.subarray(0, firstBoundaryBytes),
        upload.body.subarray(firstBoundaryBytes),
      ]),
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
      admission: lease,
      signal: new AbortController().signal,
    });

    await expect(controller.acquire()).rejects.toBeInstanceOf(AdminBundleUploadCapacityError);
    await parsed.cleanup();
    const replacement = await controller.acquire();
    await replacement.cleanup();
    await controller.close();
  });

  it("rejects a parser-skipped malformed part before an otherwise legal upload", async () => {
    const boundary = "caplets-test-boundary";
    const legal = legalSingleFileUpload();
    const malformedFirstPart = Buffer.from(`--${boundary}\r\nx-ignored: yes\r\n\r\nskipped\r\n`);
    const body = Buffer.concat([malformedFirstPart, legal.body]);
    const error = await rejectUpload(body, {
      contentType: legal.contentType,
      contentLength: String(body.byteLength),
    });
    expect(error).toMatchObject({ code: "REQUEST_INVALID", status: 400 });
  });

  it("rejects a declared content length over the whole-request limit before parsing", async () => {
    const upload = legalSingleFileUpload();
    const error = await rejectUpload(upload.body, {
      contentType: upload.contentType,
      contentLength: String(limits.maxRequestBytes + 1),
    });
    expect(error).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });
  });

  it("counts chunked request bytes and rejects overflow beyond the whole-request limit", async () => {
    const upload = legalSingleFileUpload();
    const body = Buffer.concat([upload.body, Buffer.alloc(1_000, 0x20)]);
    const error = await rejectUpload(body, {
      contentType: upload.contentType,
      contentLength: undefined,
      limits: {
        ...limits,
        maxManifestBytes: Math.min(256, upload.body.byteLength),
        maxRequestBytes: upload.body.byteLength + 20,
      },
      chunkBytes: 11,
    });
    expect(error).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });
  });

  it("rejects non-multipart media as a stable 415-capable typed error", async () => {
    const error = await rejectUpload(Buffer.from("{}"), {
      contentType: "application/json",
      contentLength: "2",
    });
    expect(error).toBeInstanceOf(AdminBundleUploadMediaTypeError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
  });

  it.each([
    {
      label: "malformed JSON",
      manifest: "{not-json",
      code: "REQUEST_INVALID",
      status: 400,
      detail: "The Caplet Bundle manifest is malformed JSON.",
    },
    {
      label: "schema-invalid JSON",
      manifest: JSON.stringify({ version: 1, files: [] }),
      code: "REQUEST_INVALID",
      status: 400,
      detail: "The Caplet Bundle manifest is invalid.",
    },
    {
      label: "path traversal",
      manifest: JSON.stringify(
        makeManifest([{ path: "../escape", content: Buffer.alloc(0), executable: false }]),
      ),
      code: "CONFIG_INVALID",
      status: 422,
      detail: "Invalid Caplet bundle path ../escape.",
    },
    {
      label: "canonical path collision",
      manifest: JSON.stringify(
        makeManifest([
          { path: "dir/../same", content: Buffer.alloc(0), executable: false },
          { path: "same", content: Buffer.alloc(0), executable: false },
        ]),
      ),
      code: "CONFIG_INVALID",
      status: 422,
      detail: "Duplicate Caplet bundle path same.",
    },
  ])(
    "maps a $label manifest to $status without losing its validation detail",
    async ({ manifest, code, status, detail }) => {
      const upload = multipart([fieldPart("manifest", manifest)]);
      const error = await rejectUpload(upload.body, {
        contentType: upload.contentType,
        contentLength: String(upload.body.byteLength),
      });

      expect(error).toMatchObject({ code, message: detail });
      expect(problemDetailsFromError(error)).toMatchObject({ code, status, detail });
    },
  );

  it.each([
    ["an unknown first field", [fieldPart("metadata", "{}")]],
    [
      "a file before the manifest",
      [filePart("file", Buffer.from("alpha")), fieldPart("manifest", "{}")],
    ],
    [
      "a duplicate manifest",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.alloc(0), executable: false }]),
          ),
        ),
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.alloc(0), executable: false }]),
          ),
        ),
      ],
    ],
    ["malformed manifest JSON", [fieldPart("manifest", "{not-json")]],
    [
      "an invalid manifest shape",
      [fieldPart("manifest", JSON.stringify({ version: 1, files: [], unknown: true }))],
    ],
    [
      "invalid executable metadata and special-file intent",
      [
        fieldPart(
          "manifest",
          JSON.stringify({
            version: 1,
            files: [
              { path: "link", size: 0, sha256: emptyHash, executable: "yes", type: "symlink" },
            ],
          }),
        ),
      ],
    ],
    [
      "too many declared files",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([
              { path: "a", content: Buffer.alloc(0), executable: false },
              { path: "b", content: Buffer.alloc(0), executable: false },
              { path: "c", content: Buffer.alloc(0), executable: false },
            ]),
          ),
        ),
      ],
    ],
    [
      "an oversized declared file",
      [
        fieldPart(
          "manifest",
          JSON.stringify({
            version: 1,
            files: [{ path: "large", size: 17, sha256: emptyHash, executable: false }],
          }),
        ),
      ],
    ],
    [
      "an oversized declared file total",
      [
        fieldPart(
          "manifest",
          JSON.stringify({
            version: 1,
            files: [
              { path: "a", size: 13, sha256: emptyHash, executable: false },
              { path: "b", size: 13, sha256: emptyHash, executable: false },
            ],
          }),
        ),
      ],
    ],
    [
      "a streamed file size mismatch",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("file", Buffer.from("alph")),
      ],
    ],
    [
      "a streamed file larger than declared",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("file", Buffer.from("alphabet")),
      ],
    ],
    [
      "a streamed file hash mismatch",
      [
        fieldPart(
          "manifest",
          JSON.stringify({
            version: 1,
            files: [{ path: "a", size: 5, sha256: emptyHash, executable: false }],
          }),
        ),
        filePart("file", Buffer.from("alpha")),
      ],
    ],
    [
      "a missing declared file",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
      ],
    ],
    [
      "an extra file",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("file", Buffer.from("alpha")),
        filePart("file", Buffer.from("extra")),
      ],
    ],
    [
      "a multipart part-count overflow",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("file", Buffer.from("alpha")),
        filePart("file", Buffer.from("extra")),
        filePart("file", Buffer.from("overflow")),
      ],
    ],
    [
      "an unknown trailing field",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("file", Buffer.from("alpha")),
        fieldPart("trailing", "no"),
      ],
    ],
    [
      "a wrong file field name",
      [
        fieldPart(
          "manifest",
          JSON.stringify(
            makeManifest([{ path: "a", content: Buffer.from("alpha"), executable: false }]),
          ),
        ),
        filePart("files", Buffer.from("alpha")),
      ],
    ],
  ])("rejects %s and removes every request path", async (_label, parts) => {
    const upload = multipart(parts);
    const error = await rejectUpload(upload.body, {
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
    });
    expect(error).toMatchObject({ status: expect.any(Number) });
    let code: unknown;
    if (error && typeof error === "object" && "code" in error) code = error.code;
    expect(["REQUEST_INVALID", "CONTENT_TOO_LARGE"]).toContain(code);
  });

  it("enforces manifest, header-pair, and header-byte parser limits", async () => {
    const manifestUpload = legalSingleFileUpload();
    const oversizedManifest = await rejectUpload(manifestUpload.body, {
      contentType: manifestUpload.contentType,
      contentLength: String(manifestUpload.body.byteLength),
      limits: { ...limits, maxManifestBytes: 32 },
    });
    expect(oversizedManifest).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });

    const pairUpload = multipart([
      fieldPart("manifest", JSON.stringify(makeManifest([])), {
        "x-one": "1",
        "x-two": "2",
        "x-three": "3",
      }),
    ]);
    const tooManyHeaders = await rejectUpload(pairUpload.body, {
      contentType: pairUpload.contentType,
      contentLength: String(pairUpload.body.byteLength),
      limits: { ...limits, maxHeaderPairs: 2 },
    });
    expect(tooManyHeaders).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });

    const headerUpload = multipart([
      fieldPart("manifest", JSON.stringify(makeManifest([])), { "x-long": "x".repeat(200) }),
    ]);
    const oversizedHeaders = await rejectUpload(headerUpload.body, {
      contentType: headerUpload.contentType,
      contentLength: String(headerUpload.body.byteLength),
      limits: { ...limits, maxHeaderBytes: 80 },
    });
    expect(oversizedHeaders).toMatchObject({ code: "CONTENT_TOO_LARGE", status: 413 });
  });

  it("rejects admission quota exhaustion and removes the request directory", async () => {
    const upload = legalSingleFileUpload();
    const error = await rejectUpload(upload.body, {
      contentType: upload.contentType,
      contentLength: String(upload.body.byteLength),
      maxStagedBytes: 4,
    });
    expect(error).toBeInstanceOf(AdminBundleUploadCapacityError);
    expect(error).toMatchObject({ code: "UPLOAD_CAPACITY_EXCEEDED", status: 429 });
  });

  it("cancels an active upload from AbortSignal without leaving staged paths", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      limits,
    });
    const input = new PassThrough();
    const abort = new AbortController();
    const parsed = parseAdminBundleUpload({
      input,
      contentType: "multipart/form-data; boundary=waiting",
      contentLength: undefined,
      admission: controller,
      signal: abort.signal,
    });
    abort.abort();

    await expect(parsed).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expectNoRequestDirectories(stagingRoot);
    await controller.close();
  });

  it("rejects an aborted request stream without leaving staged paths", async () => {
    const upload = legalSingleFileUpload();
    const input = Readable.from(
      (async function* () {
        yield upload.body.subarray(0, Math.floor(upload.body.byteLength / 2));
        throw new Error("request aborted");
      })(),
    );
    const error = await rejectUpload(input, {
      contentType: upload.contentType,
      contentLength: undefined,
    });
    expect(error).toMatchObject({ code: "REQUEST_INVALID" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "caplets-admin-upload-test-"));
  directories.push(directory);
  return directory;
}

type ManifestInputFile = {
  path: string;
  content: Buffer;
  executable: boolean;
};

type MultipartPart = {
  name: string;
  content: Buffer;
  filename?: string;
  headers: Record<string, string>;
};

type RejectionOptions = {
  contentType: string;
  contentLength: string | undefined;
  limits?: AdminBundleUploadLimits;
  maxStagedBytes?: number;
  chunkBytes?: number;
};

const emptyHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function makeManifest(files: ManifestInputFile[]) {
  return {
    version: 1 as const,
    files: files.map((file) => ({
      path: file.path,
      size: file.content.byteLength,
      sha256: createHash("sha256").update(file.content).digest("hex"),
      executable: file.executable,
    })),
  };
}

function fieldPart(
  name: string,
  value: string,
  headers: Record<string, string> = {},
): MultipartPart {
  return { name, content: Buffer.from(value), headers };
}

function filePart(name: string, content: Buffer, filename = "ignored"): MultipartPart {
  return {
    name,
    content,
    filename,
    headers: { "content-type": "application/octet-stream" },
  };
}

function multipart(parts: MultipartPart[], boundary = "caplets-test-boundary") {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = [
      `form-data; name="${part.name}"`,
      ...(part.filename === undefined ? [] : [`filename="${part.filename}"`]),
    ].join("; ");
    const headers = {
      "content-disposition": disposition,
      ...part.headers,
    };
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    for (const [name, value] of Object.entries(headers)) {
      chunks.push(Buffer.from(`${name}: ${value}\r\n`));
    }
    chunks.push(Buffer.from("\r\n"), part.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function legalSingleFileUpload() {
  const content = Buffer.from("alpha");
  return multipart([
    fieldPart(
      "manifest",
      JSON.stringify(makeManifest([{ path: "a.txt", content, executable: false }])),
    ),
    filePart("file", content),
  ]);
}

function chunk(buffer: Buffer, bytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += bytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + bytes, buffer.byteLength)));
  }
  return chunks;
}

async function rejectUpload(body: Buffer | Readable, options: RejectionOptions): Promise<unknown> {
  const stagingRoot = await temporaryDirectory();
  const controller = new AdminBundleUploadAdmissionController({
    stagingDir: stagingRoot,
    limits: options.limits ?? limits,
    ...(options.maxStagedBytes === undefined ? {} : { maxStagedBytes: options.maxStagedBytes }),
  });
  let error: unknown;
  try {
    const parsed = await parseAdminBundleUpload({
      input:
        body instanceof Readable
          ? body
          : Readable.from(chunk(body, options.chunkBytes ?? body.byteLength)),
      contentType: options.contentType,
      contentLength: options.contentLength,
      admission: controller,
      signal: new AbortController().signal,
    });
    await parsed.cleanup();
    error = new Error("Expected upload parsing to reject.");
  } catch (caught) {
    error = caught;
  }
  await expectNoRequestDirectories(stagingRoot);
  await controller.close();
  expect(await readdir(stagingRoot)).toEqual([]);
  return error;
}

async function expectNoRequestDirectories(stagingRoot: string): Promise<void> {
  for (const processRoot of (await readdir(stagingRoot)).filter((entry) =>
    entry.startsWith("caplets-admin-upload-"),
  )) {
    expect(await readdir(join(stagingRoot, processRoot))).toEqual([]);
  }
}

async function readSource(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}
