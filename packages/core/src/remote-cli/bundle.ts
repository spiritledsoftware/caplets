import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  adminBundleManifestSchema,
  DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
  DEFAULT_ADMIN_BUNDLE_HEADER_BYTES,
  DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES,
  type AdminBundleManifest,
} from "../admin-api/bundle-contract";
import { CapletsError } from "../errors";
import { validateBundlePathSet } from "../storage/bundle-path";

export type RemoteBundleDownload = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
};

export type MaterializeRemoteBundleDownloadOptions = RemoteBundleDownload & {
  destination: string;
  replace?: boolean | undefined;
};

/** Parses the bounded manifest, then streams each declared file into an atomic local staging tree. */
export async function materializeRemoteBundleDownload(
  options: MaterializeRemoteBundleDownloadOptions,
): Promise<void> {
  if (existsSync(options.destination) && !options.replace) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Export destination ${options.destination} already exists.`,
    );
  }
  const boundary = multipartBoundary(options.contentType);
  const reader = new MultipartByteReader(options.body);
  const parent = dirname(options.destination);
  const staging = join(parent, `.${basename(options.destination)}.tmp-${randomUUID()}`);
  const backup = join(parent, `.${basename(options.destination)}.backup-${randomUUID()}`);

  try {
    await reader.expect(encode(`--${boundary}\r\n`));
    const manifestHeaders = parseHeaders(
      decode(await reader.readUntil(encode("\r\n\r\n"), DEFAULT_ADMIN_BUNDLE_HEADER_BYTES)),
    );
    if (
      manifestHeaders.get("content-disposition") !== 'inline; name="manifest"' ||
      !manifestHeaders.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      throw invalidBundle("Remote Caplet Bundle manifest part is malformed.");
    }
    const manifestBytes = await reader.readUntil(
      encode(`\r\n--${boundary}`),
      DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES,
    );
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(decode(manifestBytes)) as unknown;
    } catch (error) {
      throw invalidBundle("Remote Caplet Bundle manifest is not valid JSON.", error);
    }
    const manifest = adminBundleManifestSchema.safeParse(parsedManifest);
    if (!manifest.success) throw invalidBundle("Remote Caplet Bundle manifest is malformed.");
    const normalizedPaths = validateRemoteManifest(manifest.data);
    await reader.expect(encode("\r\n"));
    mkdirSync(parent, { recursive: true });
    mkdirSync(staging, { mode: 0o700 });

    for (let index = 0; index < manifest.data.files.length; index += 1) {
      const metadata = manifest.data.files[index]!;
      const headers = parseHeaders(
        decode(await reader.readUntil(encode("\r\n\r\n"), DEFAULT_ADMIN_BUNDLE_HEADER_BYTES)),
      );
      if (
        headers.get("content-disposition") !==
          `attachment; name="file"; filename="file-${index + 1}"` ||
        headers.get("content-type")?.toLowerCase() !== "application/octet-stream" ||
        headers.get("content-length") !== String(metadata.size)
      ) {
        throw invalidBundle(`Remote Caplet Bundle file part ${index + 1} is malformed.`);
      }
      const path = join(staging, ...normalizedPaths[index]!.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await reader.writeExact(path, metadata.size, metadata.sha256, metadata.executable);
      await reader.expect(encode(`\r\n--${boundary}`));
      const suffix = decode(await reader.readExact(2));
      const last = index === manifest.data.files.length - 1;
      if (last) {
        if (suffix !== "--")
          throw invalidBundle("Remote Caplet Bundle is missing its final boundary.");
        await reader.expect(encode("\r\n"));
        await reader.expectEnd();
      } else if (suffix !== "\r\n") {
        throw invalidBundle("Remote Caplet Bundle part boundary is malformed.");
      }
    }

    if (existsSync(options.destination)) renameSync(options.destination, backup);
    renameSync(staging, options.destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    await reader.cancel(error);
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(options.destination) && existsSync(backup)) {
      renameSync(backup, options.destination);
    }
    throw error;
  }
}

function validateRemoteManifest(manifest: AdminBundleManifest): string[] {
  let normalizedPaths: string[];
  try {
    normalizedPaths = validateBundlePathSet(manifest.files.map((file) => file.path));
  } catch (error) {
    throw invalidBundle(
      "Remote Caplet Bundle manifest contains invalid or colliding paths.",
      error,
    );
  }
  let documentSeen = false;
  let auxiliaryFiles = 0;
  let totalAuxiliaryBytes = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index]!;
    if (normalizedPaths[index] === "CAPLET.md") {
      documentSeen = true;
      if (file.size > DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxDocumentBytes) {
        throw invalidBundle("Remote Caplet Bundle document exceeds its byte limit.");
      }
      continue;
    }
    auxiliaryFiles += 1;
    if (auxiliaryFiles > DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxFiles) {
      throw invalidBundle("Remote Caplet Bundle exceeds its auxiliary file-count limit.");
    }
    if (file.size > DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxFileBytes) {
      throw invalidBundle(`Remote Caplet Bundle file ${file.path} exceeds its byte limit.`);
    }
    totalAuxiliaryBytes += file.size;
    if (
      !Number.isSafeInteger(totalAuxiliaryBytes) ||
      totalAuxiliaryBytes > DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS.maxTotalFileBytes
    ) {
      throw invalidBundle("Remote Caplet Bundle exceeds its auxiliary byte limit.");
    }
  }
  if (!documentSeen) throw invalidBundle("Remote Caplet Bundle must contain CAPLET.md.");
  return normalizedPaths;
}

class MultipartByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array<ArrayBufferLike>[] = [];
  #head = 0;
  #headOffset = 0;
  #bufferedBytes = 0;
  #done = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async readUntil(marker: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
    const prefixTable = markerPrefixTable(marker);
    let chunkIndex = this.#head;
    let chunkOffset = this.#headOffset;
    let scannedBytes = 0;
    let matchedBytes = 0;

    while (true) {
      while (chunkIndex < this.#chunks.length) {
        const chunk = this.#chunks[chunkIndex]!;
        while (chunkOffset < chunk.byteLength) {
          const byte = chunk[chunkOffset++]!;
          scannedBytes += 1;
          while (matchedBytes > 0 && byte !== marker[matchedBytes]) {
            matchedBytes = prefixTable[matchedBytes - 1]!;
          }
          if (byte === marker[matchedBytes]) matchedBytes += 1;
          if (matchedBytes === marker.byteLength) {
            const valueLength = scannedBytes - marker.byteLength;
            if (valueLength > maximumBytes) {
              throw invalidBundle("Remote Caplet Bundle metadata exceeds its byte limit.");
            }
            const value = this.#take(valueLength);
            this.#discard(marker.byteLength);
            return value;
          }
          if (scannedBytes - matchedBytes > maximumBytes) {
            throw invalidBundle("Remote Caplet Bundle metadata exceeds its byte limit.");
          }
        }
        chunkIndex += 1;
        chunkOffset = 0;
      }

      await this.#pull();
      if (this.#done) throw invalidBundle("Remote Caplet Bundle ended before a part boundary.");
    }
  }

  async readExact(length: number): Promise<Uint8Array> {
    while (this.#bufferedBytes < length) {
      await this.#pull();
      if (this.#done) throw invalidBundle("Remote Caplet Bundle ended unexpectedly.");
    }
    return this.#take(length);
  }

  async expect(expected: Uint8Array): Promise<void> {
    const actual = await this.readExact(expected.byteLength);
    if (!bytesEqual(actual, expected))
      throw invalidBundle("Remote Caplet Bundle framing is malformed.");
  }

  async writeExact(
    path: string,
    length: number,
    expectedSha256: string,
    executable: boolean,
  ): Promise<void> {
    const output = createWriteStream(path, { flags: "wx", mode: executable ? 0o700 : 0o600 });
    const hash = createHash("sha256");
    let remaining = length;
    try {
      while (remaining > 0) {
        if (this.#bufferedBytes === 0) {
          await this.#pull();
          if (this.#done) throw invalidBundle("Remote Caplet Bundle file ended unexpectedly.");
        }
        const bufferedChunk = this.#chunks[this.#head]!;
        const size = Math.min(remaining, bufferedChunk.byteLength - this.#headOffset);
        const chunk = bufferedChunk.subarray(this.#headOffset, this.#headOffset + size);
        this.#advance(size);
        hash.update(chunk);
        await new Promise<void>((resolve, reject) => {
          output.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
        remaining -= size;
      }
      await new Promise<void>((resolve, reject) => {
        output.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      output.destroy();
      throw error;
    }
    if (hash.digest("hex") !== expectedSha256) {
      throw invalidBundle("Remote Caplet Bundle file does not match its declared hash.");
    }
    if (executable) chmodSync(path, 0o700);
  }

  async expectEnd(): Promise<void> {
    if (this.#bufferedBytes !== 0) {
      throw invalidBundle("Remote Caplet Bundle contains trailing bytes.");
    }
    await this.#pull();
    if (!this.#done || this.#bufferedBytes !== 0) {
      throw invalidBundle("Remote Caplet Bundle contains trailing bytes.");
    }
    this.#reader.releaseLock();
  }

  async cancel(reason: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => undefined);
  }

  #take(length: number): Uint8Array {
    const value = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.#chunks[this.#head]!;
      const size = Math.min(length - offset, chunk.byteLength - this.#headOffset);
      value.set(chunk.subarray(this.#headOffset, this.#headOffset + size), offset);
      this.#advance(size);
      offset += size;
    }
    return value;
  }

  #discard(length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.#chunks[this.#head]!;
      const size = Math.min(remaining, chunk.byteLength - this.#headOffset);
      this.#advance(size);
      remaining -= size;
    }
  }

  #advance(length: number): void {
    const chunk = this.#chunks[this.#head]!;
    this.#headOffset += length;
    this.#bufferedBytes -= length;
    if (this.#headOffset !== chunk.byteLength) return;
    this.#head += 1;
    this.#headOffset = 0;
    if (
      this.#head === this.#chunks.length ||
      (this.#head >= 64 && this.#head * 2 >= this.#chunks.length)
    ) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  async #pull(): Promise<void> {
    if (this.#done) return;
    while (true) {
      const chunk = await this.#reader.read();
      if (chunk.done) {
        this.#done = true;
        return;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw invalidBundle("Remote Caplet Bundle stream returned a malformed chunk.");
      }
      if (chunk.value.byteLength === 0) continue;
      this.#chunks.push(chunk.value);
      this.#bufferedBytes += chunk.value.byteLength;
      return;
    }
  }
}

function multipartBoundary(contentType: string): string {
  const match =
    /^multipart\/mixed\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]+)"|([A-Za-z0-9'()+_,./:=?-]+))$/iu.exec(
      contentType.trim(),
    );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70) {
    throw new CapletsError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Remote bundle response is not multipart/mixed.",
    );
  }
  return boundary;
}

function parseHeaders(value: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw invalidBundle("Remote Caplet Bundle part headers are malformed.");
    const name = line.slice(0, separator).trim().toLowerCase();
    const headerValue = line.slice(separator + 1).trim();
    if (!name || !headerValue || headers.has(name)) {
      throw invalidBundle("Remote Caplet Bundle part headers are malformed.");
    }
    headers.set(name, headerValue);
  }
  return headers;
}

function markerPrefixTable(marker: Uint8Array): Uint8Array {
  const table = new Uint8Array(marker.byteLength);
  let prefixLength = 0;
  for (let index = 1; index < marker.byteLength; index += 1) {
    while (prefixLength > 0 && marker[index] !== marker[prefixLength]) {
      prefixLength = table[prefixLength - 1]!;
    }
    if (marker[index] === marker[prefixLength]) prefixLength += 1;
    table[index] = prefixLength;
  }
  return table;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encode(value: string): Uint8Array {
  return encoder.encode(value);
}

function decode(value: Uint8Array): string {
  try {
    return decoder.decode(value);
  } catch (error) {
    throw invalidBundle("Remote Caplet Bundle metadata is not valid UTF-8.", error);
  }
}

function invalidBundle(message: string, cause?: unknown): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    message,
    cause === undefined ? undefined : { cause: String(cause) },
  );
}
