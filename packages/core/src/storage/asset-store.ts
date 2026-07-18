import { createHash, randomUUID } from "node:crypto";
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

  async putVerified(hash: string, payload: Buffer): Promise<string> {
    const actualHash = sha256(payload);
    if (actualHash !== hash) {
      throw new CapletsError("INTERNAL_ERROR", `Caplet asset ${hash} has invalid staged content.`);
    }
    const key = `${this.prefix}/assets/sha256/${hash.slice(0, 2)}/${hash}-${randomUUID()}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: payload,
        ContentLength: payload.byteLength,
        Metadata: { sha256: hash },
      }),
    );
    await this.getVerified(key, { hash, size: payload.byteLength });
    return key;
  }

  async getVerified(key: string, expected: { hash: string; size: number }): Promise<Buffer> {
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
    const payload = Buffer.from(await response.Body.transformToByteArray());
    if (
      response.ContentLength !== expected.size ||
      response.Metadata?.sha256 !== expected.hash ||
      payload.byteLength !== expected.size ||
      sha256(payload) !== expected.hash
    ) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Caplet asset object ${key} failed integrity verification.`,
      );
    }
    return payload;
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

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}
