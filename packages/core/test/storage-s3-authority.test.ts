import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUTHORITY_GENERATION_BYTES,
  type AuthorityGenerationIdentity,
  type SemanticCommandEnvelope,
} from "../src/storage/types";
import { authorityExportDigest } from "../src/storage/migration";
import { createAuthorityBackup, restoreAuthorityBackup } from "../src/storage/backup";
import {
  S3Authority,
  createS3Authority,
  type S3AuthorityClient,
  type S3CredentialIdentity,
} from "../src/storage/s3-authority";
import { runProviderContract } from "./storage-provider-contract";

type StoredObject = { body: Uint8Array; etag: string; metadata: Record<string, string> };
type Fault = { status?: number; name?: string; message?: string; key?: string };

function fault(input: Fault): Error & { $metadata?: { httpStatusCode?: number } } {
  const error = new Error(input.message ?? input.name ?? "fault") as Error & {
    $metadata?: { httpStatusCode?: number };
  };
  if (input.name) error.name = input.name;
  if (input.status) error.$metadata = { httpStatusCode: input.status };
  return error;
}

async function bytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (
    body &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return body.transformToByteArray() as Promise<Uint8Array>;
  }
  throw new Error("unsupported body");
}

class MemoryS3Client implements S3AuthorityClient {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: Array<{ operation: string; input: Record<string, unknown> }> = [];
  destroy = vi.fn();
  etagCounter = 0;
  ignoreConditions = false;
  blockKey: string | undefined = undefined;
  blockStarted: (() => void) | undefined = undefined;
  blockSignal: AbortSignal | undefined = undefined;
  blockReject: (() => void) | undefined = undefined;
  faults: Array<{ operation: string; fault: Fault; after?: boolean; key?: string }> = [];

  async send(
    command: {
      input: Record<string, unknown>;
      constructor: { name: string };
    },
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown> {
    const operation = command.constructor.name;
    const input = command.input;
    this.requests.push({ operation, input });
    const queued = this.faults.find(
      (candidate) =>
        candidate.operation === operation &&
        (!candidate.key || String(input.Key ?? "").includes(candidate.key)),
    );
    if (queued && !queued.after) {
      this.faults.splice(this.faults.indexOf(queued), 1);
      throw fault(queued.fault);
    }
    if (operation === "PutObjectCommand") {
      const key = String(input.Key);
      const body = await bytes(input.Body);
      const existing = this.objects.get(key);
      if (!this.ignoreConditions && input.IfNoneMatch === "*" && existing)
        throw fault({ status: 412, name: "PreconditionFailed" });
      if (
        !this.ignoreConditions &&
        typeof input.IfMatch === "string" &&
        (!existing || existing.etag !== input.IfMatch)
      )
        throw fault({ status: 412, name: "PreconditionFailed" });
      const etag = `opaque-${++this.etagCounter}`;
      this.objects.set(key, {
        body,
        etag,
        metadata: (input.Metadata ?? {}) as Record<string, string>,
      });
      const output = { ETag: etag };
      if (queued?.after) {
        this.faults.splice(this.faults.indexOf(queued), 1);
        throw fault(queued.fault);
      }
      return output;
    }
    if (operation === "GetObjectCommand") {
      if (this.blockKey === String(input.Key)) {
        this.blockSignal = options?.abortSignal;
        this.blockStarted?.();
        await new Promise<never>((_resolve, reject) => {
          if (this.blockSignal?.aborted) {
            reject(fault({ name: "AbortError" }));
            return;
          }
          this.blockReject = () => reject(fault({ name: "AbortError" }));
          this.blockSignal?.addEventListener("abort", this.blockReject, { once: true });
        });
      }
      const object = this.objects.get(String(input.Key));
      if (!object) throw fault({ status: 404, name: "NoSuchKey" });
      return {
        ETag: object.etag,
        ContentLength: object.body.byteLength,
        Metadata: object.metadata,
        Body: { transformToByteArray: async () => object.body },
      };
    }
    if (operation === "DeleteObjectCommand") {
      const key = String(input.Key);
      const object = this.objects.get(key);
      if (
        !this.ignoreConditions &&
        typeof input.IfMatch === "string" &&
        (!object || object.etag !== input.IfMatch)
      )
        throw fault({ status: 412, name: "PreconditionFailed" });
      this.objects.delete(key);
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
    throw new Error(`unexpected operation ${operation}`);
  }
}

function envelope(
  expectedGeneration: AuthorityGenerationIdentity | null = null,
  overrides: Partial<SemanticCommandEnvelope<{ snapshot: unknown; result?: unknown }>> = {},
): SemanticCommandEnvelope<{ snapshot: unknown; result?: unknown }> {
  return {
    authorityId: "authority-test",
    currentHostId: "host",
    principalId: "operator",
    expectedGeneration,
    idempotencyKey: `key-${Math.random()}`,
    requestDigest: "digest",
    command: { snapshot: { value: 1 }, result: { accepted: true } },
    ...overrides,
  };
}

function options(client: S3AuthorityClient, extra: Record<string, unknown> = {}) {
  return {
    authorityId: "authority-test",
    namespace: "tenant-a",
    bucket: "bucket",
    region: "us-east-1",
    client,
    initialSnapshot: { value: 0 },
    ...extra,
  };
}

describe("S3 authority bounded protocol", () => {
  it("uses immutable candidates and exact conditional create/replace semantics", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client));
    const first = await authority.commit(envelope(null, { idempotencyKey: "first" }));
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected first commit");
    const second = await authority.commit(
      envelope(first.generation, { idempotencyKey: "second", command: { snapshot: { value: 2 } } }),
    );
    expect(second.kind).toBe("committed");
    const headPuts = client.requests.filter(
      ({ operation, input }) =>
        operation === "PutObjectCommand" && String(input.Key).endsWith("/head.json"),
    );
    expect(headPuts[0]?.input.IfNoneMatch).toBe("*");
    expect(headPuts[1]?.input.IfMatch).toMatch(/^opaque-/);
    const stale = await authority.commit(
      envelope(null, { idempotencyKey: "stale", command: { snapshot: { value: 3 } } }),
    );
    expect(stale).toMatchObject({ kind: "conflict" });
    expect(client.requests.some(({ operation }) => operation === "ListObjectsV2Command")).toBe(
      false,
    );
    await authority.close();
  });

  it("fails capability readiness when conditions are ignored or ETags are missing", async () => {
    const ignored = new MemoryS3Client();
    ignored.ignoreConditions = true;
    const authority = new S3Authority(options(ignored));
    await expect(authority.probeCapabilities()).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    await authority.close();

    const missing = new MemoryS3Client();
    const originalSend = missing.send.bind(missing);
    missing.send = async (command) => {
      const result = await originalSend(command);
      return command.constructor.name === "PutObjectCommand" ? {} : result;
    };
    const missingAuthority = new S3Authority(options(missing));
    await expect(missingAuthority.probeCapabilities()).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    await missingAuthority.close();
  });

  it("re-reads after ambiguous 409/404 and replays a lost successful response", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client));
    const first = envelope(null, { idempotencyKey: "lost" });
    client.faults.push({
      operation: "PutObjectCommand",
      fault: { status: 409, name: "Conflict" },
      after: true,
    });
    const committed = await authority.commit(first);
    expect(committed.kind).toBe("committed");
    const replay = await authority.commit(first);
    expect(replay.kind).toBe("replayed");
    const other = envelope(committed.kind === "committed" ? committed.generation : null, {
      idempotencyKey: "ambiguous",
    });
    client.faults.push({
      operation: "PutObjectCommand",
      fault: { status: 404, name: "NoSuchKey" },
    });
    await expect(authority.commit(other)).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await authority.close();
  });

  it("reconstructs and replays a head-published commit when receipt publication fails", async () => {
    const client = new MemoryS3Client();
    const applyCommand = vi.fn(
      ({ command }: { command: { snapshot: unknown; result?: unknown } }) => ({
        snapshot: command.snapshot,
        result: command.result,
      }),
    );
    const authority = await createS3Authority(options(client, { applyCommand }));
    const pending = envelope(null, {
      idempotencyKey: "receipt-recovery",
      requestDigest: "receipt-recovery-digest",
      command: { snapshot: { value: 7 }, result: { accepted: true } },
    });
    client.faults.push({
      operation: "PutObjectCommand",
      key: "/receipts/host/operator/receipt-recovery.json",
      fault: { status: 500, name: "InternalError" },
    });

    await expect(authority.commit(pending)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(applyCommand).toHaveBeenCalledOnce();
    const head = await authority.readHead();
    expect(head).not.toBeNull();

    const replay = await authority.commit(pending);
    expect(replay.kind).toBe("replayed");
    if (replay.kind !== "replayed") throw new Error("expected recovered replay");
    expect(replay.generation).toMatchObject({
      authorityId: head?.authorityId,
      id: head?.id,
      sequence: head?.sequence,
      predecessorId: head?.predecessorId,
    });
    expect(replay.receipt?.result).toEqual({ accepted: true });
    expect(applyCommand).toHaveBeenCalledOnce();
    await authority.close();
  });

  it("keeps a candidate alive until its deadline and never requests over-limit payloads", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const client = new MemoryS3Client();
    const authority = await createS3Authority(
      options(client, { clock: () => new Date(now), candidateTtlMs: 1000 }),
    );
    const pending = envelope(null, { idempotencyKey: "deadline" });
    const result = await authority.commit(pending);
    expect(result.kind).toBe("committed");
    const candidate = [...client.objects.keys()].find((key) => key.includes("/generations/"));
    expect(candidate).toBeDefined();
    now += 500;
    expect(await authority.cleanupExpiredCandidates()).toEqual([]);
    now += 700;
    expect((await authority.cleanupExpiredCandidates()).length).toBe(0);

    const before = client.requests.length;
    const tooLarge = "x".repeat(MAX_AUTHORITY_GENERATION_BYTES + 1);
    await expect(
      authority.commit(
        envelope(null, { idempotencyKey: "too-large", command: { snapshot: tooLarge } }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(client.requests.length).toBe(before);
    await authority.close();
  });

  it("accepts an exact-limit generation PUT and rejects a larger snapshot before any request", async () => {
    const clock = () => new Date("2026-01-01T00:00:00.000Z");
    const probeClient = new MemoryS3Client();
    const probeAuthority = await createS3Authority(options(probeClient, { clock }));
    const boundaryEnvelope = envelope(null, {
      idempotencyKey: "boundary-exact",
      requestDigest: "boundary-digest",
      command: { snapshot: "probe", result: { accepted: true } },
    });
    try {
      const probe = await probeAuthority.commit(boundaryEnvelope);
      expect(probe.kind).toBe("committed");
    } finally {
      await probeAuthority.close();
    }
    const probePut = probeClient.requests.find(
      ({ operation, input }) =>
        operation === "PutObjectCommand" && String(input.Key).includes("/generations/"),
    );
    if (!probePut) throw new Error("missing probe generation PUT");
    const probeSnapshotBytes = Buffer.byteLength(JSON.stringify("probe"), "utf8");
    const candidateOverhead = Number(probePut.input.ContentLength) - probeSnapshotBytes;
    expect(candidateOverhead).toBeGreaterThan(0);

    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client, { clock }));
    try {
      const exactSnapshot = "x".repeat(MAX_AUTHORITY_GENERATION_BYTES - candidateOverhead - 2);
      const exact = await authority.commit(
        envelope(null, {
          idempotencyKey: "boundary-exact",
          requestDigest: "boundary-digest",
          command: { snapshot: exactSnapshot, result: { accepted: true } },
        }),
      );
      expect(exact.kind).toBe("committed");
      if (exact.kind !== "committed") throw new Error("expected exact-limit commit");
      const exactPut = client.requests.find(
        ({ operation, input }) =>
          operation === "PutObjectCommand" && String(input.Key).includes("/generations/"),
      );
      if (!exactPut) throw new Error("missing exact-limit generation PUT");
      expect(exactPut.input.ContentLength).toBe(MAX_AUTHORITY_GENERATION_BYTES);
      expect((await bytes(exactPut.input.Body)).byteLength).toBe(MAX_AUTHORITY_GENERATION_BYTES);

      const beforeTooLarge = client.requests.length;
      const tooLarge = "x".repeat(MAX_AUTHORITY_GENERATION_BYTES + 1);
      await expect(
        authority.commit(
          envelope(exact.generation, {
            idempotencyKey: "boundary-over",
            command: { snapshot: tooLarge, result: { accepted: true } },
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(client.requests.length).toBe(beforeTooLarge);
    } finally {
      await authority.close();
    }
  });

  it("verifies canonical SHA-256 instead of trusting opaque ETags", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client));
    const committed = await authority.commit(envelope(null, { idempotencyKey: "integrity" }));
    if (committed.kind !== "committed") throw new Error("expected commit");
    const generationKey = [...client.objects.keys()].find((key) => key.includes("/generations/"));
    if (!generationKey) throw new Error("missing candidate");
    const object = client.objects.get(generationKey);
    if (!object) throw new Error("missing object");
    object.body = new TextEncoder().encode(JSON.stringify({ corrupted: true }));
    await expect(authority.readGeneration(committed.generation.id)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(createHash("sha256").update("opaque-1").digest("hex")).not.toBe(committed.generation.id);
    await authority.close();
  });

  it("uses request-time credentials, finite redacted failures, and shutdown abort", async () => {
    const client = new MemoryS3Client();
    const credentials: S3CredentialIdentity[] = [];
    const { client: _injectedClient, ...baseOptions } = options(client);
    const authority = await createS3Authority({
      ...baseOptions,
      credentialProvider: () => {
        const current = {
          accessKeyId: `key-${credentials.length + 1}`,
          secretAccessKey: `secret-${credentials.length + 1}`,
        };
        credentials.push(current);
        return current;
      },
      clientFactory: () => client,
    });
    await authority.readHead();
    await authority.readHead();
    expect(credentials).toHaveLength(2);
    client.faults.push({
      operation: "GetObjectCommand",
      fault: { status: 500, name: "InternalError", message: "https://bucket.example/secret-token" },
    });
    await expect(authority.readHead()).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await authority.close();
    expect(client.destroy).toHaveBeenCalled();
    await expect(authority.readHead()).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  });
  it("tears down active work and clients when lease release fails", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(
      options(client, {
        maintenanceLeaseMs: 100,
        maintenanceRenewIntervalMs: 20,
      }),
    );
    const committed = await authority.commit(envelope(null, { idempotencyKey: "close-release" }));
    expect(committed.kind).toBe("committed");
    const context = {
      operation: "migration" as const,
      role: "source" as const,
      authorityId: "authority-test",
      namespace: "tenant-a",
      owner: "close-owner",
    };
    const lease = await authority.maintenanceFence().acquire(context);
    if (!lease) throw new Error("expected maintenance lease");
    const started = Promise.withResolvers<void>();
    client.blockKey = "tenant-a/head.json";
    client.blockStarted = () => started.resolve();
    const pendingRead = authority.readHead();
    await started.promise;
    client.faults.push({
      operation: "DeleteObjectCommand",
      key: "tenant-a/maintenance/lease.json",
      fault: { status: 500, name: "InternalError" },
    });

    await expect(authority.close()).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    if (!client.blockSignal?.aborted) client.blockReject?.();
    await expect(pendingRead).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(client.blockSignal?.aborted).toBe(true);
    expect(client.destroy).toHaveBeenCalled();
    await expect(authority.readHead()).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
  });
  it("uses conditional provider leases for cross-instance exclusion and owner-scoped release", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const client = new MemoryS3Client();
    const first = await createS3Authority(
      options(client, {
        clock: () => new Date(now),
        maintenanceLeaseMs: 100,
        maintenanceRenewIntervalMs: 20,
      }),
    );
    const second = await createS3Authority(
      options(client, {
        clock: () => new Date(now),
        maintenanceLeaseMs: 100,
        maintenanceRenewIntervalMs: 20,
      }),
    );
    const context = {
      operation: "migration" as const,
      role: "source" as const,
      authorityId: "authority-test",
      namespace: "tenant-a",
      owner: "owner-a",
    };
    const lease = await first.maintenanceFence().acquire(context);
    if (!lease) throw new Error("expected maintenance lease");
    try {
      const own = await first.commit(envelope(null, { idempotencyKey: "fence-own" }));
      expect(own.kind).toBe("committed");
      if (own.kind !== "committed") throw new Error("expected owned commit");
      await expect(
        second.commit(envelope(null, { idempotencyKey: "fence-foreign" })),
      ).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
      await second.maintenanceFence().release?.(lease, { ...context, owner: "owner-b" });
      await expect(
        second.commit(envelope(null, { idempotencyKey: "fence-still-foreign" })),
      ).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
      await lease.release?.();
      await expect(
        second.commit(envelope(own.generation, { idempotencyKey: "fence-after-release" })),
      ).resolves.toMatchObject({ kind: "committed" });
    } finally {
      await first.close();
      await second.close();
    }
    now += 1;
    expect([...client.objects.keys()].some((key) => key.includes("/maintenance/"))).toBe(false);
  });
  it("keeps canonical receipts and auxiliary manifests stable without LIST", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client));
    const first = await authority.commit(
      envelope(null, {
        idempotencyKey: "canonical-receipt",
        requestDigest: "canonical-digest",
        command: {
          snapshot: { value: 1, dashboardSessions: [{ sessionId: "session-1" }] },
          result: { accepted: true },
        },
      }),
    );
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected initial commit");
    const stableA = await authority.exportState();
    const stableB = await authority.exportState();
    expect(authorityExportDigest(stableA)).toBe(authorityExportDigest(stableB));
    expect(stableA.receipts?.map((receipt) => receipt.idempotencyKey)).toEqual([
      "canonical-receipt",
    ]);

    const touch = await authority.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
      lastUsedAt: "2026-01-01T00:00:01.000Z",
      expectedRevision: "",
      expectedGeneration: first.generation,
    });
    expect(touch.kind).toBe("applied");
    if (touch.kind !== "applied") throw new Error("expected session touch");
    const session = await authority.readAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
    });
    expect(session).toMatchObject({
      sessionId: "session-1",
      lastUsedAt: "2026-01-01T00:00:01.000Z",
    });
    const afterTouch = await authority.exportState();
    expect(afterTouch.generation.digest).toBe(stableA.generation.digest);
    expect(authorityExportDigest(afterTouch)).not.toBe(authorityExportDigest(stableA));

    const event = await authority.commitAuxiliary({
      kind: "security_event",
      event: {
        kind: "rejected",
        occurredAt: "2026-01-01T00:00:02.000Z",
        code: "DENIED",
        secret: "do-not-persist",
      } as unknown as { kind: "rejected"; occurredAt: string; code: string },
    });
    expect(event.kind).toBe("applied");
    if (event.kind !== "applied") throw new Error("expected security event");
    expect(
      await authority.readAuxiliary({
        kind: "security_events",
        afterWatermark: event.watermark,
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await authority.readAuxiliary({ kind: "security_events", afterWatermark: "0", limit: 10 }),
    ).toEqual([{ kind: "rejected", occurredAt: "2026-01-01T00:00:02.000Z", code: "DENIED" }]);
    expect(JSON.stringify(await authority.exportState())).not.toContain("do-not-persist");
    expect(client.requests.some(({ operation }) => operation === "ListObjectsV2Command")).toBe(
      false,
    );
    expect(
      await authority.commit(
        envelope(first.generation, {
          idempotencyKey: "canonical-receipt",
          requestDigest: "canonical-digest",
          command: { snapshot: { value: 99 } },
        }),
      ),
    ).toMatchObject({ kind: "replayed" });
    await authority.close();
  });

  it("restores receipts, sessions, cursors, and event redaction to an empty S3 target", async () => {
    const sourceClient = new MemoryS3Client();
    const source = await createS3Authority(options(sourceClient));
    const first = await source.commit(
      envelope(null, {
        idempotencyKey: "restore-receipt",
        requestDigest: "restore-digest",
        command: {
          snapshot: { value: 1, sessions: { "session-1": {} } },
          result: { accepted: true },
        },
      }),
    );
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected restore source commit");
    const touch = await source.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
      lastUsedAt: "2026-01-01T00:00:01.000Z",
      expectedRevision: "",
      expectedGeneration: first.generation,
    });
    expect(touch.kind).toBe("applied");
    await source.commitAuxiliary({
      kind: "security_event",
      event: { kind: "conflicted", occurredAt: "2026-01-01T00:00:02.000Z", code: "CONFLICTED" },
    });
    const backup = await createAuthorityBackup(source, { key: Buffer.alloc(32, 5) });

    const targetClient = new MemoryS3Client();
    const target = await createS3Authority(options(targetClient));
    const restored = await restoreAuthorityBackup(target, backup, {
      key: Buffer.alloc(32, 5),
      fence: target.maintenanceFence(),
    });
    expect(restored.generation.id).toBe(first.kind === "committed" ? first.generation.id : "");
    expect(authorityExportDigest(await target.exportState())).toBe(
      authorityExportDigest(await source.exportState()),
    );
    await expect(target.restoreState(await source.exportState())).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    await source.close();
    await target.close();
  });
  it("keeps migration stages isolated until publish and retries after invalidation", async () => {
    const sourceClient = new MemoryS3Client();
    const source = await createS3Authority(options(sourceClient));
    const targetClient = new MemoryS3Client();
    const target = await createS3Authority(options(targetClient));
    try {
      const committed = await source.commit(
        envelope(null, {
          idempotencyKey: "migration-stage",
          requestDigest: "migration-stage-digest",
          command: {
            snapshot: { value: 9, sessions: { "session-1": {} } },
            result: { accepted: true },
          },
        }),
      );
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("expected source commit");
      const exported = await source.exportState();
      const context = { owner: "migration-stage-owner" };
      const stage = await target.stageMigration(exported, context);
      expect(await target.readHead()).toBeNull();
      expect([...targetClient.objects.keys()].some((key) => key.endsWith("/head.json"))).toBe(
        false,
      );
      expect(authorityExportDigest(await target.readMigrationStage(stage, context))).toBe(
        authorityExportDigest(exported),
      );

      const stagedGenerationKey = [...targetClient.objects.keys()].find(
        (key) => key.includes("/staging/") && key.endsWith("/generation.json"),
      );
      if (!stagedGenerationKey) throw new Error("missing migration stage candidate");
      const stagedGeneration = targetClient.objects.get(stagedGenerationKey);
      if (!stagedGeneration) throw new Error("missing migration stage object");
      stagedGeneration.body = new TextEncoder().encode(JSON.stringify({ corrupted: true }));
      await expect(target.readMigrationStage(stage, context)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await target.invalidateMigrationStage(stage, context);
      expect([...targetClient.objects.keys()].some((key) => key.includes("/staging/"))).toBe(false);
      expect(await target.readHead()).toBeNull();

      const retryStage = await target.stageMigration(exported, context);
      expect(authorityExportDigest(await target.readMigrationStage(retryStage, context))).toBe(
        authorityExportDigest(exported),
      );
      const published = await target.publishMigrationStage(retryStage, context);
      expect(published.generation.id).toBe(exported.generation.id);
      expect(await target.readHead()).toMatchObject({ id: exported.generation.id });
      expect(authorityExportDigest(await target.exportState())).toBe(
        authorityExportDigest(exported),
      );
    } finally {
      await source.close();
      await target.close();
    }
  });
  it("destroys factory-created clients after streamed GET completion", async () => {
    const client = new MemoryS3Client();
    const { client: _injectedClient, ...base } = options(client);
    const authority = await createS3Authority({ ...base, clientFactory: () => client });
    await authority.readHead();
    expect(client.destroy).toHaveBeenCalledOnce();
    await authority.close();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
  it("executes the provider-neutral contract against memory S3", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(
      options(client, {
        authorityId: "matrix-s3",
        namespace: "matrix-s3",
      }),
    );
    const result = await runProviderContract({
      authority,
      authorityId: "matrix-s3",
      namespace: "matrix-s3",
      provider: "s3",
      makeReplica: async () =>
        await createS3Authority(
          options(client, {
            authorityId: "matrix-s3",
            namespace: "matrix-s3",
          }),
        ),
      makeRestoreTarget: async () =>
        await createS3Authority(
          options(new MemoryS3Client(), {
            authorityId: "matrix-s3",
            namespace: "matrix-s3",
          }),
        ),
    });
    expect(result.steps).toEqual(
      expect.arrayContaining([
        "conflict-receipt-replay",
        "auxiliary-session-security-events",
        "migration-backup-restore-wrong-key",
      ]),
    );
    await authority.close();
  }, 120_000);
  it("keeps receipt replay and auxiliary touch bounded as retained history grows", async () => {
    const client = new MemoryS3Client();
    const authority = await createS3Authority(options(client));
    let expected: AuthorityGenerationIdentity | null = null;
    let last = envelope(null, { idempotencyKey: "scale-0" });
    for (let index = 0; index < 96; index += 1) {
      last = envelope(expected, {
        idempotencyKey: `scale-${index}`,
        requestDigest: `scale-digest-${index}`,
        command: { snapshot: { value: index }, result: { index } },
      });
      const committed = await authority.commit(last);
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("expected scale commit");
      expected = committed.generation;
    }
    const beforeReplay = client.requests.length;
    await expect(authority.commit(last)).resolves.toMatchObject({ kind: "replayed" });
    const replayRequests = client.requests.slice(beforeReplay);
    expect(replayRequests.length).toBeLessThanOrEqual(4);
    expect(
      replayRequests.some(
        ({ operation, input }) =>
          operation === "ListObjectsV2Command" || String(input.Key).includes("/manifest.json"),
      ),
    ).toBe(false);

    const sessions = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`session-${index}`, {}]),
    );
    const seeded = await authority.commit(
      envelope(expected, {
        idempotencyKey: "scale-sessions",
        requestDigest: "scale-sessions-digest",
        command: { snapshot: { value: 97, sessions } },
      }),
    );
    expect(seeded.kind).toBe("committed");
    if (seeded.kind !== "committed") throw new Error("expected session seed commit");
    const beforeTouch = client.requests.length;
    const touched = await authority.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session-1000",
      lastUsedAt: "2026-01-01T00:00:01.000Z",
      expectedRevision: "",
      expectedGeneration: seeded.generation,
    });
    expect(touched.kind).toBe("applied");
    const touchRequests = client.requests.slice(beforeTouch);
    expect(touchRequests.length).toBeLessThanOrEqual(20);
    expect(
      touchRequests.some(
        ({ operation, input }) =>
          operation === "ListObjectsV2Command" || String(input.Key).endsWith("/aux/state.json"),
      ),
    ).toBe(false);
    await authority.close();
  });

  it("serializes multi-replica session creation and removes stale touches without LIST", async () => {
    const client = new MemoryS3Client();
    const first = await createS3Authority(options(client));
    const initial = await first.commit(
      envelope(null, {
        idempotencyKey: "replica-seed",
        requestDigest: "replica-seed-digest",
        command: { snapshot: { sessions: { "replica-session": {} } } },
      }),
    );
    expect(initial.kind).toBe("committed");
    if (initial.kind !== "committed") throw new Error("expected replica seed");
    const second = await createS3Authority(options(client));
    const results = await Promise.all([
      first.commitAuxiliary({
        kind: "session_touch",
        sessionId: "replica-session",
        lastUsedAt: "2026-01-01T00:00:01.000Z",
        expectedRevision: "",
        expectedGeneration: initial.generation,
      }),
      second.commitAuxiliary({
        kind: "session_touch",
        sessionId: "replica-session",
        lastUsedAt: "2026-01-01T00:00:01.000Z",
        expectedRevision: "",
        expectedGeneration: initial.generation,
      }),
    ]);
    expect(results.filter((result) => result.kind === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
    const beforeRemove = client.requests.length;
    await expect(
      first.commitAuxiliary({ kind: "remove_session_touch", sessionId: "replica-session" }),
    ).resolves.toMatchObject({ kind: "applied" });
    await expect(
      first.readAuxiliary({ kind: "session_touch", sessionId: "replica-session" }),
    ).resolves.toBeUndefined();
    const removeRequests = client.requests.slice(beforeRemove);
    expect(removeRequests.some(({ operation }) => operation === "ListObjectsV2Command")).toBe(
      false,
    );
    await first.close();
    await second.close();
  });

  it("cleans expired immutable receipts through shard heads", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const client = new MemoryS3Client();
    const authority = await createS3Authority(
      options(client, { clock: () => new Date(now), receiptTtlMs: 10 }),
    );
    const committed = await authority.commit(
      envelope(null, { idempotencyKey: "cleanup-receipt", requestDigest: "cleanup-digest" }),
    );
    expect(committed.kind).toBe("committed");
    const receiptKey = [...client.objects.keys()].find((key) =>
      key.includes("/receipts/host/operator/cleanup-receipt.json"),
    );
    expect(receiptKey).toBeDefined();
    now += 20;
    const beforeCleanup = client.requests.length;
    await expect(authority.cleanupExpiredReceipts()).resolves.toEqual([
      "host\u0000operator\u0000cleanup-receipt",
    ]);
    expect(client.objects.has(receiptKey ?? "")).toBe(false);
    expect(
      client.requests
        .slice(beforeCleanup)
        .some(({ operation }) => operation === "ListObjectsV2Command"),
    ).toBe(false);
    await authority.close();
  });
});
