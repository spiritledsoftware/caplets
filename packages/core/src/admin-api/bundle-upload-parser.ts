import Busboy, { type BusboyFileStream } from "@fastify/busboy";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { CapletsError } from "../errors";
import { stagedBundleFileSource, type ReopenableBundleFileSource } from "../storage/bundle-source";
import { validateBundlePathSet } from "../storage/bundle-path";
import {
  AdminBundleUploadAdmissionController,
  type AdminBundleUploadLease,
} from "./bundle-upload-admission";
import {
  adminBundleManifestSchema,
  DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES,
  type AdminBundleManifest,
  type AdminBundleManifestEntry,
  type AdminBundleUploadLimits,
} from "./bundle-contract";

export type AdminBundleUploadHeader = string | readonly string[] | undefined;

export type ParseAdminBundleUploadOptions = {
  input: Readable;
  contentType: AdminBundleUploadHeader;
  contentLength: AdminBundleUploadHeader;
  admission: AdminBundleUploadAdmissionController | AdminBundleUploadLease;
  signal: AbortSignal;
};

export type ParsedAdminBundleUpload = {
  manifest: AdminBundleManifest;
  files: ReopenableBundleFileSource[];
  cleanup(): Promise<void>;
};

export class AdminBundleUploadMediaTypeError extends CapletsError {
  readonly status = 415;

  constructor() {
    super("UNSUPPORTED_MEDIA_TYPE", "Caplet Bundle uploads require multipart/form-data.");
    this.name = "AdminBundleUploadMediaTypeError";
  }
}

export class AdminBundleUploadParseError extends CapletsError {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(status === 413 ? "CONTENT_TOO_LARGE" : "REQUEST_INVALID", message);
    this.status = status;
    this.name = "AdminBundleUploadParseError";
  }
}

export async function parseAdminBundleUpload(
  options: ParseAdminBundleUploadOptions,
): Promise<ParsedAdminBundleUpload> {
  const limits = options.admission.limits;
  let controller: AdminBundleUploadAdmissionController | undefined;
  let lease: AdminBundleUploadLease | undefined;
  if (options.admission instanceof AdminBundleUploadAdmissionController) {
    controller = options.admission;
  } else {
    lease = options.admission;
  }
  try {
    const contentType = typeof options.contentType === "string" ? options.contentType : undefined;
    if (
      !contentType ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data"
    ) {
      throw new AdminBundleUploadMediaTypeError();
    }
    validateContentLength(options.contentLength, limits.maxRequestBytes);
    if (options.signal.aborted) throw abortedUpload();

    if (!lease) {
      if (!controller) throw new CapletsError("INTERNAL_ERROR", "Upload admission is unavailable.");
      lease = await controller.acquire();
    }
    const activeLease = lease;
    const requestDirectory = await activeLease.createRequestDirectory();
    if (options.signal.aborted) throw abortedUpload();

    return await parseMultipartStream({
      input: options.input,
      contentType,
      lease: activeLease,
      limits,
      requestDirectory,
      signal: options.signal,
    });
  } catch (error) {
    destroyInput(options.input);
    await lease?.cleanup();
    throw uploadError(error);
  }
}

type MultipartParseOptions = {
  input: Readable;
  contentType: string;
  lease: AdminBundleUploadLease;
  limits: Readonly<AdminBundleUploadLimits>;
  requestDirectory: string;
  signal: AbortSignal;
};

async function parseMultipartStream(
  options: MultipartParseOptions,
): Promise<ParsedAdminBundleUpload> {
  const boundary = multipartBoundary(options.contentType);
  if (!boundary) throw invalidUpload("The multipart boundary is invalid.");

  let busboy;
  try {
    busboy = Busboy({
      headers: { "content-type": options.contentType },
      isPartAFile: (fieldName) => fieldName === "file",
      limits: {
        fieldSize: options.limits.maxManifestBytes,
        fields: 1,
        fileSize: Math.max(options.limits.maxFileBytes, options.limits.maxDocumentBytes),
        files: options.limits.maxFiles + 1,
        parts: options.limits.maxFiles + 2,
        headerPairs: options.limits.maxHeaderPairs,
        headerSize: options.limits.maxHeaderBytes,
      },
    });
  } catch {
    throw invalidUpload("The multipart boundary is invalid.");
  }

  const requestLimiter = new MultipartRequestLimitTransform(
    boundary,
    options.limits.maxRequestBytes,
    options.limits.maxHeaderBytes,
    options.limits.maxHeaderPairs,
  );
  const stagedSources: Array<ReopenableBundleFileSource | undefined> = [];
  const fileTasks: Promise<void>[] = [];
  let manifest: AdminBundleManifest | undefined;
  let fileIndex = 0;
  let firstFailure: unknown;

  const fail = (error: unknown): void => {
    if (firstFailure === undefined) firstFailure = uploadError(error);
  };

  busboy.on("field", (fieldName, value, fieldNameTruncated, valueTruncated) => {
    if (firstFailure !== undefined) return;
    try {
      if (fieldNameTruncated || fieldName !== "manifest") {
        throw invalidUpload("The first multipart part must be the manifest field.");
      }
      if (manifest !== undefined || fileIndex !== 0) {
        throw invalidUpload("The Caplet Bundle manifest must occur exactly once and first.");
      }
      if (valueTruncated) {
        throw contentTooLarge("The Caplet Bundle manifest exceeds its byte limit.");
      }
      manifest = parseManifest(value, options.limits);
      options.lease.reserveStagedBytes(
        manifest.files.reduce((total, entry) => total + entry.size, 0),
      );
    } catch (error) {
      fail(error);
    }
  });

  busboy.on("file", (fieldName, fileStream) => {
    if (firstFailure !== undefined) {
      fileStream.resume();
      return;
    }
    try {
      if (fieldName !== "file") {
        throw invalidUpload("Unknown multipart file field.");
      }
      if (!manifest) {
        throw invalidUpload("A multipart file occurred before the manifest.");
      }
      const entry = manifest.files[fileIndex];
      if (!entry) throw invalidUpload("The upload contains an extra file part.");
      const targetIndex = fileIndex;
      fileIndex += 1;
      const task = stageFile({
        fileStream,
        entry,
        stagedPath: join(options.requestDirectory, `file-${targetIndex}`),
      })
        .then((source) => {
          stagedSources[targetIndex] = source;
        })
        .catch((error: unknown) => {
          fail(error);
        });
      fileTasks.push(task);
    } catch (error) {
      fileStream.resume();
      fail(error);
    }
  });

  busboy.on("partsLimit", () => {
    fail(contentTooLarge("The multipart part count exceeds its limit."));
  });
  busboy.on("filesLimit", () => {
    fail(contentTooLarge("The multipart file count exceeds its limit."));
  });
  busboy.on("fieldsLimit", () => {
    fail(invalidUpload("The upload contains a duplicate or trailing field."));
  });
  busboy.on("error", (error: unknown) => {
    fail(error);
  });

  const onAbort = (): void => {
    const error = abortedUpload();
    fail(error);
    destroyInput(options.input);
    requestLimiter.destroy(error);
    busboy.destroy(error);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      await pipeline(options.input, requestLimiter, busboy);
    } catch (error) {
      fail(error);
    }
    await Promise.all(fileTasks);
    if (firstFailure !== undefined) throw firstFailure;
    if (!manifest) throw invalidUpload("The upload is missing its manifest.");
    if (
      requestLimiter.parts !== manifest.files.length + 1 ||
      fileIndex !== manifest.files.length ||
      stagedSources.some((source) => !source)
    ) {
      throw invalidUpload("The upload has missing, extra, or malformed multipart parts.");
    }
    // The completeness check above proves every sparse slot has a staged source.
    const files = stagedSources as ReopenableBundleFileSource[];
    return {
      manifest,
      files,
      cleanup: () => options.lease.cleanup(),
    };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

type StageFileOptions = {
  fileStream: BusboyFileStream;
  entry: AdminBundleManifestEntry;
  stagedPath: string;
};

async function stageFile(options: StageFileOptions): Promise<ReopenableBundleFileSource> {
  const hash = createHash("sha256");
  let bytes = 0;
  let sizeExceeded = false;
  let limitReached = false;
  options.fileStream.once("limit", () => {
    limitReached = true;
  });
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const previousBytes = bytes;
      bytes += chunk.byteLength;
      hash.update(chunk);
      const writableBytes = Math.max(0, options.entry.size - previousBytes);
      if (writableBytes < chunk.byteLength) sizeExceeded = true;
      callback(null, writableBytes === chunk.byteLength ? chunk : chunk.subarray(0, writableBytes));
    },
  });
  const destination = createWriteStream(options.stagedPath, {
    flags: "wx",
    mode: 0o600,
  });
  await pipeline(options.fileStream, verifier, destination);
  if (limitReached) throw contentTooLarge("A staged file exceeds its byte limit.");
  if (sizeExceeded || bytes !== options.entry.size || hash.digest("hex") !== options.entry.sha256) {
    throw invalidUpload("A staged file does not match its declared size or SHA-256 hash.");
  }
  return stagedBundleFileSource({
    path: options.entry.path,
    stagedPath: options.stagedPath,
    size: options.entry.size,
    sha256: options.entry.sha256,
    executable: options.entry.executable,
  });
}

function parseManifest(
  value: string,
  limits: Readonly<AdminBundleUploadLimits>,
): AdminBundleManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalidUpload("The Caplet Bundle manifest is malformed JSON.");
  }
  const parsed = adminBundleManifestSchema.safeParse(decoded);
  if (!parsed.success) throw invalidUpload("The Caplet Bundle manifest is invalid.");
  const paths = validateBundlePathSet(parsed.data.files.map((entry) => entry.path));
  let auxiliaryFiles = 0;
  let totalAuxiliaryBytes = 0;
  for (let index = 0; index < parsed.data.files.length; index += 1) {
    const entry = parsed.data.files[index]!;
    if (paths[index] === "CAPLET.md") {
      if (entry.size > limits.maxDocumentBytes) {
        throw contentTooLarge("The Caplet Bundle manifest declares an oversized document.");
      }
      continue;
    }
    auxiliaryFiles += 1;
    if (auxiliaryFiles > limits.maxFiles) {
      throw contentTooLarge("The Caplet Bundle manifest declares too many auxiliary files.");
    }
    if (entry.size > limits.maxFileBytes) {
      throw contentTooLarge("The Caplet Bundle manifest declares an oversized auxiliary file.");
    }
    totalAuxiliaryBytes += entry.size;
    if (
      !Number.isSafeInteger(totalAuxiliaryBytes) ||
      totalAuxiliaryBytes > limits.maxTotalFileBytes
    ) {
      throw contentTooLarge(
        "The Caplet Bundle manifest declares an oversized auxiliary file total.",
      );
    }
  }
  return {
    ...parsed.data,
    files: parsed.data.files.map((entry, index) => ({ ...entry, path: paths[index]! })),
  };
}

const MULTIPART_SCAN_CHUNK_BYTES = 64 * 1024;

class MultipartRequestLimitTransform extends Transform {
  readonly #boundary: Buffer;
  readonly #bodyBoundary: Buffer;
  readonly #maxRequestBytes: number;
  readonly #maxHeaderBytes: number;
  readonly #maxHeaderPairs: number;
  #requestBytes = 0;
  #scanBuffer = Buffer.alloc(0);
  #state: "first-boundary" | "headers" | "body" | "done" = "first-boundary";
  #parts = 0;
  get parts(): number {
    return this.#parts;
  }

  constructor(
    boundary: string,
    maxRequestBytes: number,
    maxHeaderBytes: number,
    maxHeaderPairs: number,
  ) {
    super();
    this.#boundary = Buffer.from(`--${boundary}`);
    this.#bodyBoundary = Buffer.from(`\r\n--${boundary}`);
    this.#maxRequestBytes = maxRequestBytes;
    this.#maxHeaderBytes = maxHeaderBytes;
    this.#maxHeaderPairs = maxHeaderPairs;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#requestBytes += chunk.byteLength;
    if (this.#requestBytes > this.#maxRequestBytes) {
      callback(contentTooLarge("The multipart request exceeds its byte limit."));
      return;
    }
    try {
      for (let offset = 0; offset < chunk.byteLength; offset += MULTIPART_SCAN_CHUNK_BYTES) {
        this.#scan(
          chunk.subarray(offset, Math.min(offset + MULTIPART_SCAN_CHUNK_BYTES, chunk.byteLength)),
        );
      }
      callback(null, chunk);
    } catch (error) {
      callback(uploadError(error));
    }
  }

  #scan(chunk: Buffer): void {
    if (this.#state === "done") return;
    this.#scanBuffer = Buffer.concat([this.#scanBuffer, chunk]);
    while (true) {
      if (this.#state === "first-boundary") {
        const boundaryIndex = this.#scanBuffer.indexOf(this.#boundary);
        if (boundaryIndex < 0) {
          this.#retainTail(this.#boundary.byteLength);
          return;
        }
        if (this.#scanBuffer.byteLength < boundaryIndex + this.#boundary.byteLength + 2) {
          this.#scanBuffer = this.#scanBuffer.subarray(boundaryIndex);
          return;
        }
        this.#scanBuffer = this.#scanBuffer.subarray(boundaryIndex + this.#boundary.byteLength);
        if (!this.#consumeBoundarySuffix()) return;
        continue;
      }
      if (this.#state === "headers") {
        const headerEnd = this.#scanBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (this.#scanBuffer.byteLength > this.#maxHeaderBytes) {
            throw contentTooLarge("A multipart part header exceeds its byte limit.");
          }
          return;
        }
        if (headerEnd > this.#maxHeaderBytes) {
          throw contentTooLarge("A multipart part header exceeds its byte limit.");
        }
        this.#validateHeaderPairs(this.#scanBuffer.subarray(0, headerEnd));
        this.#parts += 1;
        this.#scanBuffer = this.#scanBuffer.subarray(headerEnd + 4);
        this.#state = "body";
        continue;
      }
      if (this.#state === "body") {
        const boundaryIndex = this.#scanBuffer.indexOf(this.#bodyBoundary);
        if (boundaryIndex < 0) {
          this.#retainTail(this.#bodyBoundary.byteLength + 2);
          return;
        }
        if (this.#scanBuffer.byteLength < boundaryIndex + this.#bodyBoundary.byteLength + 2) {
          this.#scanBuffer = this.#scanBuffer.subarray(boundaryIndex);
          return;
        }
        this.#scanBuffer = this.#scanBuffer.subarray(boundaryIndex + this.#bodyBoundary.byteLength);
        if (!this.#consumeBoundarySuffix()) return;
        continue;
      }
      return;
    }
  }

  #consumeBoundarySuffix(): boolean {
    if (this.#scanBuffer.byteLength < 2) return false;
    if (this.#scanBuffer[0] === 45 && this.#scanBuffer[1] === 45) {
      this.#state = "done";
      this.#scanBuffer = Buffer.alloc(0);
      return true;
    }
    if (this.#scanBuffer[0] !== 13 || this.#scanBuffer[1] !== 10) {
      throw invalidUpload("The multipart boundary framing is invalid.");
    }
    this.#scanBuffer = this.#scanBuffer.subarray(2);
    this.#state = "headers";
    return true;
  }

  #validateHeaderPairs(headerBlock: Buffer): void {
    let pairs = 0;
    for (const line of headerBlock.toString("latin1").split("\r\n")) {
      if (!line.startsWith(" ") && !line.startsWith("\t")) pairs += 1;
    }
    if (pairs > this.#maxHeaderPairs) {
      throw contentTooLarge("A multipart part has too many header pairs.");
    }
  }

  #retainTail(bytes: number): void {
    if (this.#scanBuffer.byteLength > bytes) {
      this.#scanBuffer = this.#scanBuffer.subarray(this.#scanBuffer.byteLength - bytes);
    }
  }
}

function multipartBoundary(contentType: string): string | undefined {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  return boundary && Buffer.byteLength(boundary) <= DEFAULT_ADMIN_BUNDLE_BOUNDARY_BYTES
    ? boundary
    : undefined;
}

function validateContentLength(header: AdminBundleUploadHeader, maxRequestBytes: number): void {
  if (header === undefined) return;
  if (typeof header !== "string" || !/^(?:0|[1-9]\d*)$/u.test(header.trim())) {
    throw invalidUpload("The Content-Length header is invalid.");
  }
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) throw invalidUpload("The Content-Length header is invalid.");
  if (bytes > maxRequestBytes) {
    throw contentTooLarge("The multipart request exceeds its declared byte limit.");
  }
}

function invalidUpload(message: string): AdminBundleUploadParseError {
  return new AdminBundleUploadParseError(400, message);
}

function contentTooLarge(message: string): AdminBundleUploadParseError {
  return new AdminBundleUploadParseError(413, message);
}

function abortedUpload(): AdminBundleUploadParseError {
  return invalidUpload("The multipart upload was aborted.");
}

function uploadError(error: unknown): CapletsError {
  if (error instanceof CapletsError) return error;
  return invalidUpload("The multipart upload could not be parsed or was aborted.");
}

function destroyInput(input: Readable): void {
  if (!input.destroyed) input.destroy();
}
