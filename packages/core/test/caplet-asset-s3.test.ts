import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, expect, it } from "vitest";
import { createHostStorage } from "../src/storage";

const endpoint = process.env.CAPLETS_TEST_S3_ENDPOINT;
const s3It = endpoint ? it : it.skip;
const directories: string[] = [];
const buckets: string[] = [];
const client = endpoint
  ? new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "caplets", secretAccessKey: "caplets-secret" },
    })
  : undefined;

afterEach(async () => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (!client) return;
  for (const bucket of buckets.splice(0)) {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (listed.Contents?.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })) },
        }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
});

s3It("deduplicates, verifies, and exports S3-compatible Caplet assets", async () => {
  const bucket = `caplets-${randomUUID()}`;
  buckets.push(bucket);
  await client!.send(new CreateBucketCommand({ Bucket: bucket }));
  const directory = mkdtempSync(join(tmpdir(), "caplets-s3-"));
  directories.push(directory);
  const storage = await createHostStorage({
    type: "sqlite",
    path: join(directory, "caplets.sqlite3"),
    assets: {
      type: "s3",
      endpoint,
      region: "us-east-1",
      bucket,
      prefix: "host",
      forcePathStyle: true,
      accessKeyId: "caplets",
      secretAccessKey: "caplets-secret",
    },
  });
  const payload = Buffer.from("shared object payload\n");
  const input = (id: string) => ({
    id,
    operator: { clientId: "operator_import", role: "operator" as const },
    files: [
      {
        path: "CAPLET.md",
        executable: false,
        content: Buffer.from(
          `---
  name: ${id}
  description: Verify S3-compatible asset persistence for ${id}.
  mcpServer:
    command: ${id}-mcp
  ---
  # ${id}
  `.replace(/^ {2}/gmu, ""),
        ),
      },
      { path: "asset.txt", executable: false, content: payload },
    ],
  });

  try {
    await storage.caplets.importBundles([input("first"), input("second")]);
    await expect(storage.caplets.assetStats()).resolves.toEqual({ blobs: 1, entries: 2 });
    const listed = await client!.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(listed.Contents).toHaveLength(1);
    const destination = join(directory, "exported");
    await storage.caplets.exportBundle("first", destination, {
      operator: { clientId: "operator_export", role: "operator" },
    });
    expect(readFileSync(join(destination, "asset.txt"))).toEqual(payload);
    const first = await storage.caplets.get("first");
    const second = await storage.caplets.get("second");
    await storage.caplets.deleteRevision({
      id: "first",
      revisionKey: first!.currentRevision.revisionKey,
      expectedGeneration: 1,
      operator: { clientId: "operator_cleanup", role: "operator" },
    });
    await storage.caplets.deleteRevision({
      id: "second",
      revisionKey: second!.currentRevision.revisionKey,
      expectedGeneration: 1,
      operator: { clientId: "operator_cleanup", role: "operator" },
    });
    await expect(
      storage.maintainAssets({
        ownerNodeId: "node_cleanup",
        graceMs: 0,
        now: new Date(Date.now() + 1_000),
      }),
    ).resolves.toMatchObject({ blobRowsDeleted: 1, objectsDeleted: 1 });
    await expect(
      storage.maintainAssets({
        ownerNodeId: "node_cleanup",
        graceMs: 0,
        now: new Date(Date.now() + 2_000),
      }),
    ).resolves.toMatchObject({ blobRowsDeleted: 0, objectsDeleted: 0 });
    const cleaned = await client!.send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(cleaned.Contents ?? []).toHaveLength(0);
  } finally {
    await storage.close();
  }
});

s3It("gates health on current S3 assets without gating on historical assets", async () => {
  const bucket = `caplets-${randomUUID()}`;
  buckets.push(bucket);
  await client!.send(new CreateBucketCommand({ Bucket: bucket }));
  const directory = mkdtempSync(join(tmpdir(), "caplets-s3-health-"));
  directories.push(directory);
  const storage = await createHostStorage({
    type: "sqlite",
    path: join(directory, "caplets.sqlite3"),
    assets: {
      type: "s3",
      endpoint,
      region: "us-east-1",
      bucket,
      prefix: "host",
      forcePathStyle: true,
      accessKeyId: "caplets",
      secretAccessKey: "caplets-secret",
    },
  });
  const historicalPayload = Buffer.from("historical asset payload\n");
  const currentPayload = Buffer.from("current asset payload\n");
  const input = (payload: Buffer) => ({
    id: "health-check",
    operator: { clientId: "operator_import", role: "operator" as const },
    files: [
      {
        path: "CAPLET.md",
        executable: false,
        content: Buffer.from(
          `---
name: Asset health check
description: Verify current S3-compatible asset health.
mcpServer:
  command: asset-health-mcp
---
# Asset health check
`,
        ),
      },
      { path: "asset.txt", executable: false, content: payload },
    ],
  });

  try {
    await storage.caplets.importBundle(input(historicalPayload));
    await storage.caplets.updateBundle({
      ...input(currentPayload),
      expectedGeneration: 1,
    });
    const listed = await client!.send(new ListObjectsV2Command({ Bucket: bucket }));
    const historicalHash = createHash("sha256").update(historicalPayload).digest("hex");
    const currentHash = createHash("sha256").update(currentPayload).digest("hex");
    const historicalKey = listed.Contents?.find(({ Key }) => Key?.includes(historicalHash))?.Key;
    const currentKey = listed.Contents?.find(({ Key }) => Key?.includes(currentHash))?.Key;
    expect(historicalKey).toBeTruthy();
    expect(currentKey).toBeTruthy();

    await expect(storage.health()).resolves.toMatchObject({
      ready: true,
      assets: { backend: "s3", ready: true },
    });
    await client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: historicalKey }));
    await expect(storage.health()).resolves.toMatchObject({
      ready: true,
      assets: { backend: "s3", ready: true },
    });

    await client!.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: currentKey,
        Body: Buffer.alloc(currentPayload.byteLength, "x"),
        Metadata: { sha256: currentHash },
      }),
    );
    await expect(storage.health()).resolves.toMatchObject({
      ready: false,
      reason: "current_record_assets_unavailable",
      assets: {
        backend: "s3",
        ready: false,
        affectedRecordIds: ["health-check"],
      },
    });
    await expect(
      storage.caplets.readBundle("health-check", {
        operator: { clientId: "operator_read", role: "operator" },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: currentKey }));
    await expect(storage.health()).resolves.toMatchObject({
      ready: false,
      reason: "current_record_assets_unavailable",
      assets: {
        backend: "s3",
        ready: false,
        affectedRecordIds: ["health-check"],
      },
    });
    await expect(
      storage.caplets.readBundle("health-check", {
        operator: { clientId: "operator_read", role: "operator" },
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  } finally {
    await storage.close();
  }
});
