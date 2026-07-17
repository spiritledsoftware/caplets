import { timingSafeEqual } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { CapletsError } from "../../errors";
import {
  artifactCanaryPayload,
  artifactProviderCanaryKey,
  artifactProviderObjectKey,
  sha256Hex,
  validateArtifactRange,
  MAX_ARTIFACT_PART_BYTES,
  type ArtifactObjectHead,
  type ArtifactProvider,
  type ArtifactProviderIdentity,
  type ArtifactPutResult,
} from "./provider";
const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const MAX_CANARY_BYTES = 1024;

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

export type S3ArtifactProviderOptions = {
  bucket: string;
  prefix: string;
  identity: ArtifactProviderIdentity;
};

export class S3ArtifactProvider implements ArtifactProvider {
  readonly identity: ArtifactProviderIdentity;
  readonly #client: S3CommandClient;
  readonly #bucket: string;
  #verified = false;

  constructor(client: S3CommandClient, options: S3ArtifactProviderOptions) {
    if (
      options.identity.kind !== "s3" ||
      options.bucket.length === 0 ||
      options.prefix.length === 0 ||
      options.prefix !== options.identity.namespace ||
      !options.identity.provider.endsWith(`/${options.bucket}`)
    ) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact provider configuration is invalid.");
    }
    this.#client = client;
    this.#bucket = options.bucket;
    this.identity = options.identity;
  }

  async verifyCanary(expectedCanary: string): Promise<void> {
    const payload = artifactCanaryPayload(this.identity, expectedCanary);
    const key = this.#qualifiedKey(artifactProviderCanaryKey(this.identity));
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: payload,
          ContentLength: payload.byteLength,
          IfNoneMatch: "*",
          Metadata: {
            "caplets-identity": this.identity.identityId,
            "caplets-sha256": sha256Hex(payload),
          },
        }),
      );
      assertSuccessfulWriteResponse(response, "put");
    } catch (error) {
      if (!isPreconditionFailed(error)) throw s3Error("S3 artifact canary could not be created.");
      const existing = await this.#getRaw(key, MAX_CANARY_BYTES);
      if (existing.byteLength !== payload.byteLength || !timingSafeEqual(existing, payload)) {
        throw new CapletsError("AUTH_FAILED", "S3 artifact provider canary does not match.");
      }
    }
    this.#verified = true;
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<ArtifactPutResult> {
    this.#assertVerified();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_PART_BYTES) {
      throw new CapletsError("REQUEST_INVALID", "S3 immutable artifact part size is invalid.");
    }
    const objectKey = this.#qualifiedKey(artifactProviderObjectKey(this.identity, key));
    const digest = sha256Hex(bytes);
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          Body: bytes,
          ContentLength: bytes.byteLength,
          IfNoneMatch: "*",
          Metadata: {
            "caplets-identity": this.identity.identityId,
            "caplets-sha256": digest,
          },
        }),
      );
      assertSuccessfulWriteResponse(response, "put");
      return { created: true, size: bytes.byteLength };
    } catch (error) {
      if (!isPreconditionFailed(error)) throw s3Error("S3 immutable artifact put failed.");
      const existing = await this.#headRaw(objectKey);
      if (!existing || existing.size !== bytes.byteLength || existing.sha256 !== digest) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Immutable S3 artifact conflicts with existing bytes.",
        );
      }
      const existingBytes = await this.#getRaw(objectKey, bytes.byteLength);
      if (existingBytes.byteLength !== bytes.byteLength || !timingSafeEqual(existingBytes, bytes)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Immutable S3 artifact conflicts with existing bytes.",
        );
      }
      return { created: false, size: existing.size };
    }
  }

  async head(key: string): Promise<ArtifactObjectHead | undefined> {
    this.#assertVerified();
    return this.#headRaw(this.#qualifiedKey(artifactProviderObjectKey(this.identity, key)));
  }

  async getRange(key: string, start: number, endExclusive: number): Promise<Buffer> {
    this.#assertVerified();
    validateArtifactRange(start, endExclusive);
    if (endExclusive - start > MAX_RANGE_BYTES) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact byte range exceeds the read limit.");
    }
    const objectKey = this.#qualifiedKey(artifactProviderObjectKey(this.identity, key));
    let output: unknown;
    try {
      output = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          Range: `bytes=${start}-${endExclusive - 1}`,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) throw new CapletsError("REQUEST_INVALID", "S3 artifact is absent.");
      throw s3Error("S3 artifact range read failed.");
    }
    const record = asRecord(output);
    const expectedLength = endExclusive - start;
    const expectedRange = `bytes ${start}-${endExclusive - 1}/`;
    if (
      asRecord(record.$metadata).httpStatusCode !== 206 ||
      record.ContentLength !== expectedLength ||
      typeof record.ContentRange !== "string" ||
      !record.ContentRange.startsWith(expectedRange)
    ) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact range response is inconsistent.");
    }
    const bytes = await bodyBytes(output, expectedLength);
    if (bytes.byteLength !== expectedLength) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact range response is incomplete.");
    }
    return bytes;
  }

  async delete(key: string): Promise<void> {
    this.#assertVerified();
    try {
      const response = await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#qualifiedKey(artifactProviderObjectKey(this.identity, key)),
        }),
      );
      assertSuccessfulWriteResponse(response, "delete");
    } catch {
      throw s3Error("S3 artifact delete failed.");
    }
  }

  async #headRaw(key: string): Promise<ArtifactObjectHead | undefined> {
    let output: unknown;
    try {
      output = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw s3Error("S3 artifact metadata read failed.");
    }
    const record = asRecord(output);
    const size = record.ContentLength;
    const metadata = asRecord(record.Metadata);
    const digest = metadata["caplets-sha256"];
    const identityId = metadata["caplets-identity"];
    const status = asRecord(record.$metadata).httpStatusCode;
    const etag = record.ETag;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      identityId !== this.identity.identityId ||
      status !== 200 ||
      typeof etag !== "string" ||
      etag.length === 0
    ) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact metadata is incomplete.");
    }
    return { size, sha256: digest };
  }

  async #getRaw(key: string, maxBytes: number): Promise<Buffer> {
    let output: unknown;
    try {
      output = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch {
      throw s3Error("S3 artifact object could not be read.");
    }
    const record = asRecord(output);
    const contentLength = record.ContentLength;
    if (
      asRecord(record.$metadata).httpStatusCode !== 200 ||
      typeof contentLength !== "number" ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > maxBytes
    ) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact response metadata is inconsistent.");
    }
    const bytes = await bodyBytes(output, maxBytes);
    if (bytes.byteLength !== contentLength) {
      throw new CapletsError("REQUEST_INVALID", "S3 artifact response is incomplete.");
    }
    return bytes;
  }

  #qualifiedKey(objectKey: string): string {
    return objectKey;
  }

  #assertVerified(): void {
    if (!this.#verified) {
      throw new CapletsError("AUTH_FAILED", "S3 artifact provider canary has not been verified.");
    }
  }
}

async function bodyBytes(output: unknown, maxBytes: number): Promise<Buffer> {
  const record = asRecord(output);
  const body = record.Body;
  if (!body || typeof body !== "object") {
    throw new CapletsError("REQUEST_INVALID", "S3 artifact response body is unavailable.");
  }
  if (Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        throw new CapletsError("REQUEST_INVALID", "S3 artifact response exceeds the read limit.");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  }
  if (!("transformToByteArray" in body) || typeof body.transformToByteArray !== "function") {
    throw new CapletsError("REQUEST_INVALID", "S3 artifact response body is unavailable.");
  }
  const bytes = Buffer.from(await body.transformToByteArray());
  if (bytes.byteLength > maxBytes) {
    throw new CapletsError("REQUEST_INVALID", "S3 artifact response exceeds the read limit.");
  }
  return bytes;
}

function assertSuccessfulWriteResponse(output: unknown, operation: "put" | "delete"): void {
  const record = asRecord(output);
  const status = asRecord(record.$metadata).httpStatusCode;
  if (
    (operation === "put" && (status !== 200 || typeof record.ETag !== "string")) ||
    (operation === "delete" && status !== 200 && status !== 204)
  ) {
    throw new CapletsError("REQUEST_INVALID", "S3 write response is inconsistent.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isPreconditionFailed(error: unknown): boolean {
  const record = asRecord(error);
  return record.name === "PreconditionFailed" || asRecord(record.$metadata).httpStatusCode === 412;
}

function isNotFound(error: unknown): boolean {
  const record = asRecord(error);
  return record.name === "NotFound" || asRecord(record.$metadata).httpStatusCode === 404;
}

function s3Error(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}
