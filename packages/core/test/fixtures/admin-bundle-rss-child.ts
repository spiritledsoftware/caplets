import { createHash, type Hash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createBundleMultipartStream } from "../../src/admin-api/bundle-export";
import { AdminBundleUploadAdmissionController } from "../../src/admin-api/bundle-upload-admission";
import {
  parseAdminBundleUpload,
  type ParsedAdminBundleUpload,
} from "../../src/admin-api/bundle-upload-parser";
import { createHostStorage } from "../../src/storage";
import type { ReopenableBundleFileSource } from "../../src/storage/bundle-source";

const MiB = 1024 * 1024;
const boundary = "caplets-rss-smoke-boundary";
const exportBoundary = "caplets-rss-export-boundary";
const assetCount = 63;
const assetBytes = 4 * MiB;
const generationChunkBytes = 64 * 1024;

// This allowance covers Busboy's 16 MiB manifest ceiling plus its stream/scanner buffers.
const parserAllowanceBytes = 24 * MiB;
// Native SQLite/allocator variance differs across supported Node releases. The fixed allowance
// covers those transients while the larger generated bundle keeps the ceiling 64 MiB below payload.
const fixedRuntimeAllowanceBytes = 144 * MiB;
const requiredStreamingGapBytes = 64 * MiB;

const operator = { clientId: "operator_bundle_rss", role: "operator" } as const;
const document = Buffer.from(
  "---\nname: RSS Smoke\ndescription: Prove large bundle memory remains bounded.\nmcpServer:\n  command: rss-smoke\n---\n# RSS Smoke\n",
);

type ManifestFile = {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
};

type ChildMessage =
  | { type: "rss"; phase: string; rss: number }
  | {
      type: "report";
      totalBytes: number;
      largestFileBytes: number;
      baselineRss: number;
      peakRss: number;
      thresholdRss: number;
      parserAllowanceBytes: number;
      fixedRuntimeAllowanceBytes: number;
      exportBytes: number;
      stagingEntries: number;
    }
  | { type: "error"; error: string };

function send(message: ChildMessage): void {
  process.send?.(message);
}

function sample(phase: string): number {
  const rss = process.memoryUsage().rss;
  send({ type: "rss", phase, rss });
  return rss;
}

function hashRepeatedByte(value: number, size: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(generationChunkBytes, size), value);
  for (let offset = 0; offset < size; offset += chunk.byteLength) {
    hash.update(chunk.subarray(0, Math.min(chunk.byteLength, size - offset)));
  }
  return hash.digest("hex");
}

function expectedUploadFiles(): ManifestFile[] {
  const files: ManifestFile[] = [
    {
      path: "CAPLET.md",
      size: document.byteLength,
      sha256: createHash("sha256").update(document).digest("hex"),
      executable: false,
    },
  ];
  for (let index = 0; index < assetCount; index += 1) {
    const value = index + 1;
    files.push({
      path: `assets/payload-${String(index).padStart(3, "0")}.bin`,
      size: assetBytes,
      sha256: hashRepeatedByte(value, assetBytes),
      executable: index % 7 === 0,
    });
  }
  return files;
}

function multipartHeader(name: "manifest" | "file", index?: number): Buffer {
  if (name === "manifest") {
    return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n`);
  }
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="part-${index}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
}

async function* multipartChunks(files: readonly ManifestFile[]): AsyncGenerator<Buffer> {
  yield multipartHeader("manifest");
  yield Buffer.from(JSON.stringify({ version: 1, files }));
  yield Buffer.from("\r\n");
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    yield multipartHeader("file", index);
    if (file.path === "CAPLET.md") {
      yield document;
    } else {
      const value = index;
      const chunk = Buffer.alloc(generationChunkBytes, value);
      for (let offset = 0; offset < file.size; offset += chunk.byteLength) {
        yield chunk.subarray(0, Math.min(chunk.byteLength, file.size - offset));
      }
    }
    yield Buffer.from("\r\n");
  }
  yield Buffer.from(`--${boundary}--\r\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readSmallSource(source: ReopenableBundleFileSource): Promise<Buffer> {
  assert(source.size < MiB, "Only the bounded CAPLET.md source may be read by this helper.");
  const reader = source.open().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    size += chunk.value.byteLength;
  }
  return Buffer.concat(chunks, size);
}

function updateExpectedPayload(
  hash: Hash,
  source: ReopenableBundleFileSource,
  index: number,
  capletBytes: Buffer,
): void {
  if (source.path === "CAPLET.md") {
    hash.update(capletBytes);
    return;
  }
  const value = index;
  const chunk = Buffer.alloc(generationChunkBytes, value);
  for (let offset = 0; offset < source.size; offset += chunk.byteLength) {
    hash.update(chunk.subarray(0, Math.min(chunk.byteLength, source.size - offset)));
  }
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "caplets-bundle-rss-"));
  const stagingRoot = join(root, "staging");
  const storage = await createHostStorage({ type: "sqlite", path: join(root, "records.sqlite3") });
  const admission = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
  await admission.initialize();

  const files = expectedUploadFiles();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const largestFileBytes = Math.max(...files.map((file) => file.size));
  const thresholdDelta = parserAllowanceBytes + largestFileBytes + fixedRuntimeAllowanceBytes;
  let baselineRss = 0;
  let peakRss = 0;
  let stagingEntries = -1;
  let exportBytes = 0;
  let parsed: ParsedAdminBundleUpload | undefined;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, sample("interval"));
  }, 20);

  try {
    globalThis.gc?.();
    const { promise: settle, resolve: settled } = Promise.withResolvers<void>();
    setTimeout(settled, 25);
    await settle;
    baselineRss = sample("baseline");
    peakRss = baselineRss;

    parsed = await parseAdminBundleUpload({
      input: Readable.from(multipartChunks(files)),
      contentType: `multipart/form-data; boundary=${boundary}`,
      contentLength: undefined,
      admission,
      signal: new AbortController().signal,
    });
    peakRss = Math.max(peakRss, sample("parsed"));
    assert(
      JSON.stringify(parsed.manifest.files) === JSON.stringify(files),
      "Upload manifest changed.",
    );
    assert(parsed.files.length === files.length, "Upload parser lost a file.");

    await storage.caplets.importBundleSources({
      id: "rss-smoke",
      operator,
      sources: parsed.files,
    });
    peakRss = Math.max(peakRss, sample("imported"));

    await parsed.cleanup();
    parsed = undefined;
    await admission.close();
    stagingEntries = (await readdir(stagingRoot, { recursive: true })).length;
    assert(stagingEntries === 0, `Upload staging retained ${stagingEntries} entries.`);
    peakRss = Math.max(peakRss, sample("staging-clean"));

    const stored = await storage.caplets.readBundleSources("rss-smoke", { operator });
    assert(stored.sources.length === files.length, "Stored bundle file count changed.");
    const capletSource = stored.sources[0]!;
    assert(capletSource.path === "CAPLET.md", "Stored bundle does not begin with CAPLET.md.");
    const capletBytes = await readSmallSource(capletSource);
    assert(
      capletBytes.includes(Buffer.from("name: RSS Smoke")),
      "Stored CAPLET.md content changed.",
    );

    const expectedSources: ManifestFile[] = [
      {
        path: capletSource.path,
        size: capletSource.size,
        sha256: capletSource.sha256,
        executable: capletSource.executable,
      },
      ...files.slice(1),
    ];
    assert(
      JSON.stringify(
        stored.sources.map(({ path, size, sha256, executable }) => ({
          path,
          size,
          sha256,
          executable,
        })),
      ) === JSON.stringify(expectedSources),
      "Stored bundle metadata, hashes, executable bits, or order changed.",
    );

    const exported = createBundleMultipartStream(stored.sources, { boundary: exportBoundary });
    const reader = exported.body.getReader();
    const actualHash = createHash("sha256");
    let firstChunk: Uint8Array | undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstChunk ??= chunk.value;
      actualHash.update(chunk.value);
      exportBytes += chunk.value.byteLength;
    }
    peakRss = Math.max(peakRss, sample("exported"));

    assert(firstChunk, "Export produced no manifest part.");
    const firstText = Buffer.from(firstChunk).toString("utf8");
    const manifestStart = firstText.indexOf("\r\n\r\n");
    assert(manifestStart >= 0 && firstText.endsWith("\r\n"), "Export manifest framing changed.");
    const exportedManifest = JSON.parse(firstText.slice(manifestStart + 4, -2)) as unknown;
    assert(
      JSON.stringify(exportedManifest) === JSON.stringify({ version: 1, files: expectedSources }),
      "Export manifest integrity or order changed.",
    );

    const expectedHash = createHash("sha256");
    let expectedExportBytes = 0;
    const updateExpected = (value: string | Buffer): void => {
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      expectedHash.update(bytes);
      expectedExportBytes += bytes.byteLength;
    };
    updateExpected(
      `--${exportBoundary}\r\nContent-Disposition: inline; name="manifest"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ version: 1, files: expectedSources })}\r\n`,
    );
    for (let index = 0; index < stored.sources.length; index += 1) {
      const source = stored.sources[index]!;
      updateExpected(
        `--${exportBoundary}\r\nContent-Disposition: attachment; name="file"; filename="file-${index + 1}"\r\nContent-Type: application/octet-stream\r\nContent-Length: ${source.size}\r\n\r\n`,
      );
      updateExpectedPayload(expectedHash, source, index, capletBytes);
      expectedExportBytes += source.size;
      updateExpected("\r\n");
    }
    updateExpected(`--${exportBoundary}--\r\n`);
    assert(
      exportBytes === expectedExportBytes,
      "Export byte count changed or used encoded payloads.",
    );
    assert(
      actualHash.digest("hex") === expectedHash.digest("hex"),
      "Export file bytes or order changed.",
    );
    const base64PayloadBytes = expectedSources.reduce(
      (total, source) => total + Math.ceil(source.size / 3) * 4,
      0,
    );
    assert(
      exportBytes < base64PayloadBytes,
      "Export appears to contain base64-expanded file payloads.",
    );

    assert(
      thresholdDelta + requiredStreamingGapBytes <= totalBytes,
      "RSS ceiling does not distinguish streaming from whole-bundle buffering.",
    );
    peakRss = Math.max(peakRss, sample("complete"));
    const thresholdRss = baselineRss + thresholdDelta;
    assert(
      peakRss < thresholdRss,
      `Peak RSS ${peakRss} exceeded baseline ${baselineRss} + ${thresholdDelta}.`,
    );
    send({
      type: "report",
      totalBytes,
      largestFileBytes,
      baselineRss,
      peakRss,
      thresholdRss,
      parserAllowanceBytes,
      fixedRuntimeAllowanceBytes,
      exportBytes,
      stagingEntries,
    });
  } finally {
    clearInterval(sampler);
    await parsed?.cleanup().catch(() => undefined);
    await admission.close().catch(() => undefined);
    await storage.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  send({
    type: "error",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
