import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactUri,
  createMediaArtifactWriter,
  readMediaInput,
  resolveMediaArtifact,
  writeMediaArtifact,
} from "../src/media";
import { readHttpLikeResponse } from "../src/http/response";
import { httpLikeMediaOutputSchema } from "../src/media/results";
import {
  createPortableArtifactReference,
  parsePortableArtifactReference,
} from "../src/media/artifacts";

describe("media artifacts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("validates the three Media variants without accepting locality leaks", () => {
    const schema = httpLikeMediaOutputSchema({
      type: "object",
      additionalProperties: false,
      required: ["status", "statusText", "headers", "body"],
      properties: {
        status: { type: "number" },
        statusText: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: false,
          required: ["content-type"],
          properties: { "content-type": { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    const validate = new Ajv({ strict: false }).compile(schema);
    const response = {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    };
    const facts = {
      uri: "caplets://artifacts/reports/call-1/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteLength: 9,
      sha256: "a".repeat(64),
    };

    expect(validate({ ...response, kind: "inline", body: { ok: true } })).toBe(true);
    expect(
      validate({ ...response, kind: "local-artifact", ...facts, path: "/tmp/report.pdf" }),
    ).toBe(true);
    expect(validate({ ...response, kind: "remote-reference", ...facts })).toBe(true);

    expect(
      validate({
        ...response,
        kind: "inline",
        body: { ok: true },
        uri: facts.uri,
      }),
    ).toBe(false);
    expect(
      validate({
        ...response,
        kind: "local-artifact",
        ...facts,
        path: "/tmp/report.pdf",
        body: { ok: true },
      }),
    ).toBe(false);
    expect(
      validate({
        ...response,
        kind: "remote-reference",
        ...facts,
        path: "/tmp/report.pdf",
      }),
    ).toBe(false);
  });

  it("round-trips canonical portable references and rejects altered claims", () => {
    const reference = createPortableArtifactReference({
      artifactId: "artifact_123",
      logicalHostId: "host_123",
      storeId: "store_123",
      providerIdentityId: "provider_123",
      actorId: "rcli_abcdefghijklmnop",
      operationId: "operation_123",
      direction: "upload",
      byteLength: 1024,
      sha256: "a".repeat(64),
      mimeType: "application/vnd.caplets.portable+json",
      expiresAt: "2026-07-17T12:15:00.000Z",
    });

    expect(parsePortableArtifactReference(reference.uri)).toEqual(reference);
    expect(reference.uri).not.toMatch(/(?:path|secret|bucket|prefix)=/u);
    expect(() =>
      parsePortableArtifactReference(reference.uri.replace("byteLength=1024", "byteLength=1025")),
    ).not.toThrow();
    expect(() =>
      parsePortableArtifactReference(`${reference.uri}&actorId=rcli_otherotherother1`),
    ).toThrow("claims are invalid");
    expect(() =>
      createPortableArtifactReference({ ...reference, byteLength: 256 * 1024 * 1024 + 1 }),
    ).toThrow("byteLength is invalid");
  });

  it("writes artifact files with stable metadata", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "google-drive",
      suggestedFilename: "report.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf-bytes"),
    });

    expect(artifact).toMatchObject({
      mimeType: "application/pdf",
      byteLength: 9,
      filename: "report.pdf",
    });
    expect(artifact.path).toContain(join(root, "google-drive"));
    expect(artifact.sha256).toHaveLength(64);
    expect(readFileSync(artifact.path!, "utf8")).toBe("pdf-bytes");
  });

  it("can omit local artifact paths from returned metadata", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "google-drive",
      suggestedFilename: "report.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf-bytes"),
      exposeLocalPath: false,
    });

    expect(artifact).toMatchObject({
      uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
      filename: "report.pdf",
      byteLength: 9,
      sha256: expect.any(String),
    });
    expect(artifact).not.toHaveProperty("path");
  });

  it("rejects output paths outside an allowed root", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "..", "escape.bin"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("resolves explicit output paths and rejects unsafe artifact path segments", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputPath = join(root, "drive", "call-1", "report.pdf");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf"),
    });

    expect(resolveMediaArtifact(artifact.uri, { artifactRoot: root })).toMatchObject({
      path: outputPath,
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteLength: 3,
    });

    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "drive", "bad call", "report.pdf"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("clears stale artifact metadata when overwriting without a MIME type", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputPath = join(root, "drive", "call-1", "report.pdf");
    const first = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf"),
    });
    await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      bytes: Buffer.from("plain"),
    });

    expect(resolveMediaArtifact(first.uri, { artifactRoot: root })).toMatchObject({
      filename: "report.pdf",
      byteLength: 5,
    });
    expect(resolveMediaArtifact(first.uri, { artifactRoot: root }).mimeType).toBeUndefined();
  });

  it("does not overwrite explicit output paths with failed forced responses", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputDir = join(root, "drive", "call-1");
    const outputPath = join(outputDir, "report.pdf");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, "previous-pdf");

    const result = await readHttpLikeResponse(
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      }),
      {
        capletId: "drive",
        artifactDir: root,
        outputPath,
        forceArtifact: true,
      },
    );

    expect(result.status).toBe(404);
    expect(result.kind).toBe("local-artifact");
    if (result.kind !== "local-artifact") {
      throw new Error("forced artifact response must retain a local artifact result");
    }
    expect(readFileSync(outputPath, "utf8")).toBe("previous-pdf");
    expect(result.path).not.toBe(outputPath);
  });

  it("restores an orphaned publication backup before a failed retry", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputDir = join(root, "drive", "call-1");
    const outputPath = join(outputDir, "report.pdf");
    const backupPath = join(outputDir, ".report.pdf.crashed.previous");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(backupPath, "previous-pdf");
    writeFileSync(`${backupPath}.caplets.json`, JSON.stringify({ mimeType: "application/pdf" }));

    const writer = await createMediaArtifactWriter({
      rootDir: root,
      capletId: "drive",
      outputPath,
      mimeType: "application/pdf",
    });
    await writer.write(Buffer.from("replacement-pdf"));
    const partialPath = join(
      outputDir,
      readdirSync(outputDir).find((entry) => entry.endsWith(".partial"))!,
    );
    rmSync(partialPath);

    await expect(writer.complete()).rejects.toMatchObject({ code: "ENOENT" });
    expect(readFileSync(outputPath, "utf8")).toBe("previous-pdf");
    expect(JSON.parse(readFileSync(`${outputPath}.caplets.json`, "utf8"))).toEqual({
      mimeType: "application/pdf",
    });
  });

  it("cancels oversized responses rejected by content-length before reading", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readHttpLikeResponse(
        new Response(body, {
          headers: {
            "content-length": "5",
            "content-type": "application/octet-stream",
          },
        }),
        { capletId: "drive", maxBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "DOWNSTREAM_PROTOCOL_ERROR" });

    expect(cancelled).toBe(true);
  });

  it("cancels locked response readers when semantic inspection fails", async () => {
    const root = tempDir("caplets-artifacts-");
    const inspectionFailure = new Error("semantic inspection failed");
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":"streaming"}'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readHttpLikeResponse(
        new Response(body, { headers: { "content-type": "application/json" } }),
        {
          capletId: "drive",
          artifactDir: root,
          maxInlineBytes: 0,
          inspectChunk: () => {
            throw inspectionFailure;
          },
        },
      ),
    ).rejects.toBe(inspectionFailure);

    expect(cancelled).toBe(true);
  });

  it("rejects oversized artifact and data URL inputs before reading decoded bytes", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      suggestedFilename: "large.txt",
      bytes: Buffer.from("large"),
    });

    await expect(
      readMediaInput({ artifact: artifact.uri }, { artifactRoot: root, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,bGFyZ2U=", filename: "large.txt" },
        { artifactRoot: root, maxBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("applies the default size limit to artifact inputs", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifactPath = join(root, "drive", "call-1", "large.txt");
    mkdirSync(join(root, "drive", "call-1"), { recursive: true });
    writeFileSync(artifactPath, "");
    truncateSync(artifactPath, 100 * 1024 * 1024 + 1);
    const artifact = artifactUri("drive", "call-1", "large.txt");

    await expect(readMediaInput({ artifact }, { artifactRoot: root })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("rejects invalid base64 data URL padding", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      readMediaInput({ dataUrl: "data:text/plain;base64,====" }, { artifactRoot: root }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput({ dataUrl: "data:text/plain;base64,a===" }, { artifactRoot: root }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects artifact paths that escape the root through symlinks", async () => {
    const root = tempDir("caplets-artifacts-");
    const outside = tempDir("caplets-artifacts-outside-");
    mkdirSync(join(root, "drive"), { recursive: true });
    symlinkSync(outside, join(root, "drive", "linked"));

    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "drive", "linked", "escape.bin"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects symlinked artifact metadata sidecars", async () => {
    const root = tempDir("caplets-artifacts-");
    const outside = tempDir("caplets-artifacts-outside-");
    const outputPath = join(root, "drive", "call-1", "report.pdf");
    const outsideFile = join(outside, "metadata.json");
    mkdirSync(join(root, "drive", "call-1"), { recursive: true });
    writeFileSync(outsideFile, "outside");
    symlinkSync(outsideFile, `${outputPath}.caplets.json`);

    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath,
        mimeType: "application/pdf",
        bytes: Buffer.from("report"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(readFileSync(outsideFile, "utf8")).toBe("outside");
  });

  it("rejects symlinked artifact roots", async () => {
    const realRoot = tempDir("caplets-artifacts-real-");
    const parent = tempDir("caplets-artifacts-parent-");
    const linkedRoot = join(parent, "linked-root");
    symlinkSync(realRoot, linkedRoot);

    await expect(
      writeMediaArtifact({
        rootDir: linkedRoot,
        capletId: "drive",
        suggestedFilename: "file.bin",
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("reads media input from path, artifact reference, and data URL", async () => {
    const root = tempDir("caplets-artifacts-");
    const file = join(root, "image.png");
    writeFileSync(file, Buffer.from("png"));
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      suggestedFilename: "existing.png",
      mimeType: "image/png",
      bytes: Buffer.from("artifact"),
    });
    expect(resolveMediaArtifact(artifact.uri, { artifactRoot: root })).toMatchObject({
      filename: "existing.png",
      byteLength: 8,
    });
    await expect(readMediaInput({ path: file }, { artifactRoot: root })).resolves.toMatchObject({
      bytes: Buffer.from("png"),
      filename: "image.png",
      mimeType: "image/png",
    });
    await expect(
      readMediaInput({ artifact: artifact.uri }, { artifactRoot: root }),
    ).resolves.toMatchObject({
      bytes: Buffer.from("artifact"),
      filename: "existing.png",
      mimeType: "image/png",
    });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" },
        { artifactRoot: root },
      ),
    ).resolves.toMatchObject({
      bytes: Buffer.from("hello"),
      filename: "hello.txt",
      mimeType: "text/plain",
    });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;charset=utf-8;base64,cGFyYW1z", filename: "params.txt" },
        { artifactRoot: root },
      ),
    ).resolves.toMatchObject({
      bytes: Buffer.from("params"),
      filename: "params.txt",
      mimeType: "text/plain",
    });
    await expect(
      readMediaInput(
        { dataUrl: "data:application/octet-stream;base64,", filename: "empty.bin" },
        { artifactRoot: root },
      ),
    ).resolves.toMatchObject({
      bytes: Buffer.alloc(0),
      filename: "empty.bin",
      mimeType: "application/octet-stream",
    });
  });

  it("can forbid local media file paths for remote runtimes", async () => {
    const root = tempDir("caplets-artifacts-");
    const file = join(root, "local.txt");
    writeFileSync(file, "local");

    await expect(
      readMediaInput({ path: file }, { artifactRoot: root, allowLocalPaths: false }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "media.path is not available in this runtime",
    });

    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,bG9jYWw=", filename: "local.txt" },
        { artifactRoot: root, allowLocalPaths: false },
      ),
    ).resolves.toMatchObject({
      filename: "local.txt",
      bytes: Buffer.from("local"),
    });
  });

  it("returns discriminated local artifacts and remote references without fabricating paths", async () => {
    const root = tempDir("caplets-artifacts-");
    const options = {
      capletId: "drive",
      artifactDir: root,
      maxInlineBytes: 1,
      maxBytes: 16,
    };
    const local = await readHttpLikeResponse(
      new Response(Buffer.from("pdf-bytes"), {
        headers: { "content-type": "application/pdf" },
      }),
      options,
    );
    const remote = await readHttpLikeResponse(
      new Response(Buffer.from("pdf-bytes"), {
        headers: { "content-type": "application/pdf" },
      }),
      { ...options, exposeLocalPath: false },
    );

    expect(local).toMatchObject({
      kind: "local-artifact",
      path: expect.stringContaining(root),
      filename: "response.bin",
      mimeType: "application/pdf",
      byteLength: 9,
      sha256: expect.any(String),
    });
    expect(remote).toMatchObject({
      kind: "remote-reference",
      uri: expect.stringMatching(/^caplets:\/\/artifacts\//u),
      filename: "response.bin",
      mimeType: "application/pdf",
      byteLength: 9,
      sha256: expect.any(String),
    });
    expect(remote).not.toHaveProperty("path");
    expect(remote).not.toHaveProperty("pathResolution");
  });

  it("does not decode artifact bytes without a semantic inspector", async () => {
    const root = tempDir("caplets-artifacts-");
    let decoded = false;
    vi.stubGlobal(
      "TextDecoder",
      class {
        decode(): string {
          decoded = true;
          throw new Error("artifact bytes must not be decoded");
        }
      },
    );

    try {
      const result = await readHttpLikeResponse(
        new Response(Buffer.from([0, 255, 128, 64]), {
          headers: { "content-type": "application/octet-stream" },
        }),
        { capletId: "drive", artifactDir: root },
      );

      expect(result.kind).toBe("local-artifact");
      expect(decoded).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects multiple media input sources and non-base64 data URLs", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      readMediaInput(
        { path: "/tmp/a", dataUrl: "data:text/plain;base64,eA==" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain,hello" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});
