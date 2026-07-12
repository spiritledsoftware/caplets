import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { S3AuthorityClient } from "../src/storage/s3-authority";
import { createS3Authority } from "../src/storage/s3-authority";
import type { AuthorityGenerationIdentity, SemanticCommandEnvelope } from "../src/storage/types";

class ConformanceClient implements S3AuthorityClient {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>();
  readonly operations: string[] = [];
  private sequence = 0;

  destroy(): void {}

  async send(command: {
    input: Record<string, unknown>;
    constructor: { name: string };
  }): Promise<unknown> {
    const operation = command.constructor.name;
    const input = command.input;
    this.operations.push(operation);
    if (operation === "PutObjectCommand") {
      const key = String(input.Key);
      const existing = this.objects.get(key);
      if (input.IfNoneMatch === "*" && existing) {
        const error = new Error("precondition") as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      if (typeof input.IfMatch === "string" && (!existing || existing.etag !== input.IfMatch)) {
        const error = new Error("precondition") as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const source = input.Body;
      const body = source instanceof Uint8Array ? source : new TextEncoder().encode(String(source));
      const etag = `opaque-${++this.sequence}`;
      this.objects.set(key, { body, etag });
      return { ETag: etag };
    }
    if (operation === "GetObjectCommand") {
      const object = this.objects.get(String(input.Key));
      if (!object) {
        const error = new Error("missing") as Error & { $metadata: { httpStatusCode: number } };
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { ETag: object.etag, Body: { transformToByteArray: async () => object.body } };
    }
    if (operation === "DeleteObjectCommand") {
      this.objects.delete(String(input.Key));
      return {};
    }
    if (operation === "ListObjectsV2Command") {
      const prefix = String(input.Prefix ?? "");
      return {
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((Key) => ({ Key })),
      };
    }
    throw new Error(`unsupported ${operation}`);
  }
}

function envelope(
  expectedGeneration: AuthorityGenerationIdentity | null,
  command: { snapshot: unknown; result?: unknown },
  idempotencyKey: string = randomUUID(),
  authorityId = "conformance-authority",
): SemanticCommandEnvelope<typeof command> {
  return {
    authorityId,
    currentHostId: "host",
    principalId: "operator",
    expectedGeneration,
    idempotencyKey,
    requestDigest: `digest-${idempotencyKey}`,
    command,
  };
}

describe("S3 authority provider-neutral conformance", () => {
  it("publishes semantic state, auxiliary state, and bounded health through one prefix", async () => {
    const client = new ConformanceClient();
    const authority = await createS3Authority({
      authorityId: "conformance-authority",
      namespace: "conformance-prefix",
      path: "/conformance-prefix/",
      bucket: "bucket",
      region: "us-east-1",
      client,
      initialSnapshot: { sessions: {} },
    });
    const first = await authority.commit(
      envelope(
        null,
        { snapshot: { sessions: { session: "active" }, value: 1 }, result: { accepted: true } },
        "first",
      ),
    );
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected first commit");
    expect(await authority.readGeneration(first.generation.id)).toMatchObject({
      snapshot: { value: 1 },
    });
    const replay = await authority.commit(
      envelope(
        { ...first.generation, predecessorId: first.generation.predecessorId },
        { snapshot: { sessions: { session: "active" }, value: 2 } },
        "first",
      ),
    );
    expect(replay.kind).toBe("replayed");
    const stale = await authority.commit(envelope(null, { snapshot: { value: 3 } }, "stale"));
    expect(stale).toMatchObject({ kind: "conflict" });

    const session = await authority.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      expectedRevision: "",
      expectedGeneration: first.generation,
    });
    expect(session.kind).toBe("applied");
    const current = await authority.readAuxiliary({ kind: "session_touch", sessionId: "session" });
    expect(current).toMatchObject({ sessionId: "session", lastUsedAt: "2026-01-01T00:00:00.000Z" });
    const event = await authority.commitAuxiliary({
      kind: "security_event",
      event: { kind: "rejected", occurredAt: "2026-01-01T00:00:00.000Z", code: "DENIED" },
    });
    expect(event.kind).toBe("applied");
    expect(await authority.readAuxiliary({ kind: "security_events", limit: 10 })).toEqual([
      { kind: "rejected", occurredAt: "2026-01-01T00:00:00.000Z", code: "DENIED" },
    ]);

    expect(
      client.operations.filter((operation) => operation === "ListObjectsV2Command"),
    ).toHaveLength(1);
    expect(
      [...client.objects.keys()].every((key) => key.startsWith("conformance-prefix/.caplets/")),
    ).toBe(true);
    expect((await authority.health()).connectivity).toBe("healthy");
    await authority.close();
    expect((await authority.health()).code).toBe("CLOSED");
  });
});

function liveProfile(provider: "aws" | "r2" | "minio") {
  const prefix = provider === "aws" ? "AWS" : provider === "r2" ? "R2" : "MINIO";
  const enabled = process.env[`CAPLETS_STORAGE_LIVE_${prefix}`] === "1";
  const bucket = process.env[`CAPLETS_STORAGE_${prefix}_BUCKET`];
  const region =
    process.env[`CAPLETS_STORAGE_${prefix}_REGION`] ?? (provider === "r2" ? "auto" : "us-east-1");
  const endpoint = process.env[`CAPLETS_STORAGE_${prefix}_ENDPOINT`];
  const accessKeyId = process.env[`CAPLETS_STORAGE_${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`CAPLETS_STORAGE_${prefix}_SECRET_ACCESS_KEY`];
  if (!enabled || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    accessKeyId,
    secretAccessKey,
  };
}

for (const provider of ["aws", "r2", "minio"] as const) {
  const profile = liveProfile(provider);
  describe.skipIf(!profile)(`live S3 protocol (${provider})`, () => {
    it("passes the conditional capability and generation trace", async () => {
      if (!profile) return;
      const authority = await createS3Authority({
        authorityId: `live-${provider}`,
        namespace: `u4-${provider}-${process.pid}-${randomUUID()}`,
        path: `u4-${provider}-${process.pid}-${randomUUID()}`,
        bucket: profile.bucket,
        region: profile.region,
        ...(profile.endpoint
          ? { endpoint: profile.endpoint, forcePathStyle: provider === "minio" }
          : {}),
        credentialProvider: () => ({
          accessKeyId: profile.accessKeyId,
          secretAccessKey: profile.secretAccessKey,
        }),
        initialSnapshot: { value: 0 },
      });
      try {
        await authority.probeCapabilities();
        const result = await authority.commit(
          envelope(null, { snapshot: { value: 1 } }, "live", `live-${provider}`),
        );
        expect(result.kind).toBe("committed");
      } finally {
        await authority.close();
      }
    });
  });
}
