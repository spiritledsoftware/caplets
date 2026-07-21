import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AssetStorageConfig } from "../config";
import { CapletsError } from "../errors";

export interface AssetObjectStore {
  putVerifiedStream(
    hash: string,
    size: number,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string>;
  getVerifiedStream(
    key: string,
    expected: { hash: string; size: number },
  ): Promise<ReadableStream<Uint8Array>>;
  putVerified(hash: string, payload: Buffer): Promise<string>;
  getVerified(key: string, expected: { hash: string; size: number }): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; modifiedAt: Date }>>;
  health(): Promise<boolean>;
  close(): void;
}

export function createAssetObjectStore(
  config: AssetStorageConfig | undefined,
): AssetObjectStore | undefined {
  if (!config || config.type === "sql") return undefined;
  return new S3AssetObjectStore(config);
}

class S3AssetObjectStore implements AssetObjectStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly config: Extract<AssetStorageConfig, { type: "s3" }>) {
    this.prefix = config.prefix?.replace(/^\/+|\/+$/gu, "") ?? "caplets";
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async putVerifiedStream(
    hash: string,
    size: number,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    validateExpectedAsset(hash, size);
    const key = `${this.prefix}/assets/sha256/${hash.slice(0, 2)}/${hash}-${randomUUID()}`;
    const verified = integrityCheckingStream(stream, { hash, size }, `Caplet asset ${hash}`);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: Readable.fromWeb(verified as NodeReadableStream<Uint8Array>),
          ContentLength: size,
          ChecksumSHA256: Buffer.from(hash, "hex").toString("base64"),
          Metadata: { sha256: hash },
        }),
      );
      const check = await this.getVerifiedStream(key, { hash, size });
      await drainStream(check);
      return key;
    } catch (error) {
      await this.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async putVerified(hash: string, payload: Buffer): Promise<string> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
        controller.close();
      },
    });
    return await this.putVerifiedStream(hash, payload.byteLength, stream);
  }

  async getVerifiedStream(
    key: string,
    expected: { hash: string; size: number },
  ): Promise<ReadableStream<Uint8Array>> {
    validateExpectedAsset(expected.hash, expected.size);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    } catch {
      throw new CapletsError("SERVER_UNAVAILABLE", `Caplet asset object ${key} is unavailable.`);
    }
    if (!response.Body) {
      throw new CapletsError("SERVER_UNAVAILABLE", `Caplet asset object ${key} has no payload.`);
    }
    const stream = response.Body.transformToWebStream();
    if (response.ContentLength !== expected.size || response.Metadata?.sha256 !== expected.hash) {
      await stream.cancel().catch(() => undefined);
      throw assetIntegrityError(`Caplet asset object ${key}`);
    }
    return integrityCheckingStream(stream, expected, `Caplet asset object ${key}`);
  }

  async getVerified(key: string, expected: { hash: string; size: number }): Promise<Buffer> {
    const stream = await this.getVerifiedStream(key, expected);
    return await readStream(stream, expected.size);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async list(): Promise<Array<{ key: string; modifiedAt: Date }>> {
    const objects: Array<{ key: string; modifiedAt: Date }> = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: `${this.prefix}/assets/sha256/`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key && object.LastModified) {
          objects.push({ key: object.Key, modifiedAt: object.LastModified });
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: `${this.prefix}/assets/`,
          MaxKeys: 1,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.destroy();
  }
}

function integrityCheckingStream(
  stream: ReadableStream<Uint8Array>,
  expected: { hash: string; size: number },
  label: string,
): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  let size = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) throw assetIntegrityError(label);
        size += chunk.byteLength;
        if (size > expected.size) throw assetIntegrityError(label);
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (size !== expected.size || hash.digest("hex") !== expected.hash) {
          throw assetIntegrityError(label);
        }
      },
    }),
  );
}

async function readStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) throw assetIntegrityError("Caplet asset");
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let complete = false;
  try {
    while (!(await reader.read()).done) {
      // Reading verifies the object incrementally without materializing it.
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateExpectedAsset(hash: string, size: number): void {
  if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isSafeInteger(size) || size < 0) {
    throw new CapletsError("REQUEST_INVALID", "Caplet asset metadata is invalid.");
  }
}

function assetIntegrityError(label: string): CapletsError {
  return new CapletsError("INTERNAL_ERROR", `${label} failed integrity verification.`);
}
