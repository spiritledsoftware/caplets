import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFilesystemAuthority,
  type FilesystemAuthorityCommand,
  type FilesystemAuthoritySnapshot,
} from "../src/storage/filesystem-authority";
import { authorityExportDigest } from "../src/storage/migration";
import { createAuthorityBackup, restoreAuthorityBackup } from "../src/storage/backup";
import { AuthorityDomainCodec } from "../src/remote/authority-codec";
import type { SemanticCommandEnvelope, WritableAuthority } from "../src/storage/types";

function envelope(
  command: FilesystemAuthorityCommand,
  overrides: Partial<SemanticCommandEnvelope<FilesystemAuthorityCommand>> = {},
): SemanticCommandEnvelope<FilesystemAuthorityCommand> {
  return {
    authorityId: "filesystem",
    currentHostId: "host",
    principalId: "principal",
    expectedGeneration: null,
    idempotencyKey: "intent-1",
    requestDigest: "digest-1",
    command,
    ...overrides,
  };
}

function snapshot(commandId: string): FilesystemAuthoritySnapshot {
  return {
    caplets: {
      [commandId]: { id: commandId, config: { mcpServers: {} } },
    },
  };
}

describe("filesystem authority semantic generations", () => {
  it("reserves staged IDs, commits immutable generations, replays receipts, and conflicts stale writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
    const authority = await createFilesystemAuthority({ root, stagedIds: ["github"] });
    expect(() => authority.assertCapletIdAvailable("github")).toThrow(/reserved by a staged/);

    const firstEnvelope = envelope({ kind: "replace_snapshot", snapshot: snapshot("local") });
    const first = await authority.commit(firstEnvelope);
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected commit");
    expect((await authority.readHead())?.id).toBe(first.generation.id);
    expect((await authority.readGeneration(first.generation.id)).snapshot.caplets.local?.id).toBe(
      "local",
    );

    const replay = await authority.commit(firstEnvelope);
    expect(replay.kind).toBe("replayed");
    if (replay.kind !== "replayed") throw new Error("expected replay");
    expect(replay.generation).toEqual(first.generation);

    const stale = await authority.commit(
      envelope(
        { kind: "create_caplet", record: { id: "other", config: { mcpServers: {} } } },
        { idempotencyKey: "intent-2", requestDigest: "digest-2" },
      ),
    );
    expect(stale).toMatchObject({ kind: "conflict", active: first.generation });

    await expect(
      authority.commit(
        envelope(firstEnvelope.command, {
          expectedGeneration: null,
          requestDigest: "changed-payload",
        }),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
  it("replays the committed receipt result instead of retry-generated data", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
    const authority = await createFilesystemAuthority(root);
    const firstCommand = {
      kind: "replace_snapshot" as const,
      snapshot: snapshot("first"),
      result: { sessionId: "first", secret: "committed-secret" },
    } as unknown as FilesystemAuthorityCommand;
    const firstEnvelope = envelope(firstCommand);
    const first = await authority.commit<{ sessionId: string; secret: string }>(firstEnvelope);
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") throw new Error("expected commit");

    const retryCommand = {
      ...firstCommand,
      result: { sessionId: "retry", secret: "retry-secret" },
    } as unknown as FilesystemAuthorityCommand;
    const replay = await authority.commit<{ sessionId: string; secret: string }>(
      envelope(retryCommand),
    );
    expect(replay.kind).toBe("replayed");
    if (replay.kind !== "replayed") throw new Error("expected replay");
    expect(replay.receipt.result).toEqual({
      sessionId: "first",
      secret: "committed-secret",
    });
  });

  it("keeps the old head when receipt publication fails after generation creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
    const authority = await createFilesystemAuthority(root);
    const seed = await authority.commit(
      envelope({ kind: "replace_snapshot", snapshot: snapshot("stable") }),
    );
    if (seed.kind !== "committed") throw new Error("expected seed commit");
    const oldHead = await authority.readHead();
    if (!oldHead) throw new Error("expected seed head");

    const nextEnvelope = envelope(
      {
        kind: "replace_snapshot",
        snapshot: snapshot("next"),
        result: { accepted: true, attempt: "first" },
      } as unknown as FilesystemAuthorityCommand,
      {
        expectedGeneration: oldHead,
        idempotencyKey: "receipt-failure",
        requestDigest: "receipt-failure",
      },
    );
    const hooks = authority as unknown as {
      writeReceipt(
        envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>,
        receipt: unknown,
      ): Promise<void>;
    };
    const writeReceipt = vi
      .spyOn(hooks, "writeReceipt")
      .mockRejectedValueOnce(new Error("injected receipt failure"));
    await expect(authority.commit(nextEnvelope)).rejects.toThrow("injected receipt failure");
    writeReceipt.mockRestore();
    expect(await authority.readHead()).toEqual(oldHead);

    const retry = await authority.commit(nextEnvelope);
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") throw new Error("expected retry commit");
    expect(retry.receipt.result).toEqual({ accepted: true, attempt: "first" });
  });

  it("serializes cleanup behind the publication lock and gates fresh candidates by age", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
      const authority = await createFilesystemAuthority(root);
      const candidate = join(root, "generations", "candidate.tmp-active");
      await mkdir(candidate, { recursive: true });
      await writeFile(join(candidate, "partial"), "active");

      const freshRemoved = await authority.cleanupGenerations({ now: Date.now() });
      expect(freshRemoved).not.toContain("candidate.tmp-active");
      expect(await readdir(candidate)).toEqual(["partial"]);

      const lockPath = join(root, "HEAD.lock");
      await writeFile(lockPath, "active-owner");
      let cleanupFinished = false;
      const cleanup = authority
        .cleanupGenerations({ now: Date.now() + 120_000 })
        .then((removed) => {
          cleanupFinished = true;
          return removed;
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(cleanupFinished).toBe(false);
      expect(await readdir(candidate)).toEqual(["partial"]);
      await rm(lockPath, { force: true });
      vi.advanceTimersByTime(5);
      await cleanup;
      await expect(readdir(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the prior head when generations or candidate publication are interrupted or corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
    const authority = await createFilesystemAuthority(root);
    const result = await authority.commit(
      envelope({ kind: "replace_snapshot", snapshot: snapshot("stable") }),
    );
    if (result.kind !== "committed") throw new Error("expected commit");
    const head = await authority.readHead();
    if (!head) throw new Error("expected head");

    await writeFile(
      join(root, "generations", `${head.id}.tmp-interrupted`, "partial"),
      "partial",
    ).catch(async () => {
      await mkdir(join(root, "generations", `${head.id}.tmp-interrupted`), { recursive: true });
      await writeFile(
        join(root, "generations", `${head.id}.tmp-interrupted`, "partial"),
        "partial",
      );
    });
    await authority.cleanupGenerations({ now: Date.now() + 120_000 });
    await expect(
      readdir(join(root, "generations", `${head.id}.tmp-interrupted`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await authority.readHead()).toEqual(head);

    const generationPath = join(root, "generations", head.id, "generation.json");
    const generation = JSON.parse(await readFile(generationPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(generationPath, JSON.stringify({ ...generation, digest: "sha256:corrupt" }));
    await expect(authority.readGeneration(head.id)).rejects.toThrow(/digest is invalid/);
    await expect(authority.readHead()).rejects.toThrow(/generation/);
    expect((await authority.health()).connectivity).toBe("degraded");
  });
});

describe("filesystem authority maintenance fence", () => {
  it("enforces cross-instance writes, owner-checked release, and close cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-fence-"));
    const first = await createFilesystemAuthority({
      root,
      maintenanceLeaseMs: 100,
      maintenanceRenewIntervalMs: 20,
    });
    const second = await createFilesystemAuthority({
      root,
      maintenanceLeaseMs: 100,
      maintenanceRenewIntervalMs: 20,
    });
    const context = {
      operation: "migration" as const,
      role: "source" as const,
      authorityId: "filesystem",
      namespace: "default",
      owner: "owner-a",
    };
    const lease = await first.maintenanceFence().acquire(context);
    if (!lease) throw new Error("expected maintenance lease");
    try {
      const own = await first.commit(
        envelope({ kind: "replace_snapshot", snapshot: snapshot("owned") }),
      );
      expect(own.kind).toBe("committed");
      if (own.kind !== "committed") throw new Error("expected owned commit");
      await expect(
        second.commit(envelope({ kind: "replace_snapshot", snapshot: snapshot("foreign") })),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

      await second.maintenanceFence().release?.(lease, { ...context, owner: "owner-b" });
      await expect(
        second.commit(envelope({ kind: "replace_snapshot", snapshot: snapshot("still-foreign") })),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

      const ownAgain = await first.commit(
        envelope(
          { kind: "replace_snapshot", snapshot: snapshot("owned-again") },
          {
            expectedGeneration: own.generation,
            idempotencyKey: "intent-2",
            requestDigest: "digest-2",
          },
        ),
      );
      expect(ownAgain.kind).toBe("committed");
      if (ownAgain.kind !== "committed") throw new Error("expected second owned commit");
    } finally {
      await first.maintenanceFence().release?.(lease, context);
    }

    const head = await second.readHead();
    const takeover = await first.maintenanceFence().acquire({ ...context, owner: "owner-close" });
    await first.close();
    if (!takeover) throw new Error("expected close lease");
    await expect(
      second.commit(
        envelope(
          { kind: "replace_snapshot", snapshot: snapshot("after-close") },
          { expectedGeneration: head, idempotencyKey: "intent-3", requestDigest: "digest-3" },
        ),
      ),
    ).resolves.toMatchObject({ kind: "committed" });
    await second.close();
    await takeover.release?.();
  });
});

describe("filesystem authority auxiliary CAS", () => {
  it("persists security events, filters watermarks, and supports conditional session creation/touch", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-authority-"));
    const authority = await createFilesystemAuthority(root);
    const first = await authority.commitAuxiliary({
      kind: "security_event",
      event: { kind: "rejected", occurredAt: "2026-01-01T00:00:00.000Z", code: "DENIED" },
    });
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("expected auxiliary event");
    const generationResult = await authority.commit({
      authorityId: "filesystem",
      currentHostId: "host",
      principalId: "operator",
      expectedGeneration: null,
      idempotencyKey: "session-create",
      requestDigest: "session-create",
      command: {
        caplets: {},
        dashboardSessions: [{ sessionId: "session-1" }],
      },
    });
    if (generationResult.kind !== "committed" && generationResult.kind !== "replayed") {
      throw new Error("expected semantic generation");
    }
    const head = generationResult.generation;
    const created = await authority.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      expectedRevision: "",
      expectedGeneration: head,
    });
    expect(created.kind).toBe("applied");
    const current = await authority.readAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
    });
    expect(current).toMatchObject({ lastUsedAt: "2026-01-01T00:00:00.000Z" });

    const events = await authority.readAuxiliary({ kind: "security_events", limit: 10 });
    expect(events).toEqual([
      { kind: "rejected", occurredAt: "2026-01-01T00:00:00.000Z", code: "DENIED" },
    ]);
    expect(
      await authority.readAuxiliary({
        kind: "security_events",
        afterWatermark: first.watermark,
        limit: 10,
      }),
    ).toEqual([]);

    const reopened = await createFilesystemAuthority(root);
    expect(await reopened.readAuxiliary({ kind: "security_events", limit: 10 })).toEqual(events);
  });
});
describe("filesystem authority canonical export and restore", () => {
  it("keeps unchanged exports stable and changes the digest for auxiliary and receipt mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-export-"));
    const authority = await createFilesystemAuthority(root);
    const seeded = await authority.commit(
      envelope(
        {
          kind: "replace_snapshot",
          snapshot: { ...snapshot("stable"), dashboardSessions: [{ sessionId: "session-1" }] },
        },
        { idempotencyKey: "seed", requestDigest: "seed" },
      ),
    );
    if (seeded.kind !== "committed") throw new Error("expected seed commit");

    const first = await authority.exportState();
    const second = await authority.exportState();
    expect(second).toEqual(first);
    expect(authorityExportDigest(second)).toBe(authorityExportDigest(first));
    expect(first.auxiliaryWatermark).toBe("1");

    const event = await authority.commitAuxiliary({
      kind: "security_event",
      event: { kind: "rejected", occurredAt: "2026-01-01T00:00:00.000Z", code: "DENIED" },
    });
    expect(event.kind).toBe("applied");
    const afterEvent = await authority.exportState();
    expect(authorityExportDigest(afterEvent)).not.toBe(authorityExportDigest(first));

    const touched = await authority.commitAuxiliary({
      kind: "session_touch",
      sessionId: "session-1",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      expectedRevision: "",
      expectedGeneration: seeded.generation,
    });
    expect(touched.kind).toBe("applied");
    const afterTouch = await authority.exportState();
    expect(authorityExportDigest(afterTouch)).not.toBe(authorityExportDigest(afterEvent));
    expect(afterTouch.auxiliary?.sessions?.["session-1"]).toMatchObject({ revoked: false });

    const head = await authority.readHead();
    const receiptMutation = await authority.commit(
      envelope(
        {
          kind: "replace_snapshot",
          snapshot: { ...snapshot("receipt"), dashboardSessions: [{ sessionId: "session-1" }] },
        },
        { expectedGeneration: head, idempotencyKey: "receipt", requestDigest: "receipt" },
      ),
    );
    expect(receiptMutation.kind).toBe("committed");
    const afterReceipt = await authority.exportState();
    expect(afterReceipt.receipts).toHaveLength(2);
    expect(authorityExportDigest(afterReceipt)).not.toBe(authorityExportDigest(afterTouch));
  });

  it("backup-restores receipts, events, watermark, and revoked session touch state exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-restore-"));
    const source = await createFilesystemAuthority(join(root, "source"));
    const target = await createFilesystemAuthority(join(root, "target"));
    const key = Buffer.from("filesystem-backup-key");
    try {
      const seeded = await source.commit(
        envelope(
          {
            kind: "replace_snapshot",
            snapshot: { ...snapshot("stable"), dashboardSessions: [{ sessionId: "session-1" }] },
          },
          { idempotencyKey: "seed", requestDigest: "seed" },
        ),
      );
      if (seeded.kind !== "committed") throw new Error("expected seed commit");
      const touched = await source.commitAuxiliary({
        kind: "session_touch",
        sessionId: "session-1",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        expectedRevision: "",
        expectedGeneration: seeded.generation,
      });
      expect(touched.kind).toBe("applied");
      const event = await source.commitAuxiliary({
        kind: "security_event",
        event: { kind: "conflicted", occurredAt: "2026-01-01T00:00:01.000Z", code: "CONFLICT" },
      });
      expect(event.kind).toBe("applied");
      const head = await source.readHead();
      const revoked = await source.commit(
        envelope(
          { kind: "replace_snapshot", snapshot: { ...snapshot("revoked"), dashboardSessions: [] } },
          { expectedGeneration: head, idempotencyKey: "revoke", requestDigest: "revoke" },
        ),
      );
      expect(revoked.kind).toBe("committed");

      const sourceState = await source.exportState();
      const backup = await createAuthorityBackup(source, { key });
      const restore = await restoreAuthorityBackup(target, backup, { key });
      expect(restore.auxiliaryWatermark).toBe(sourceState.auxiliaryWatermark);
      expect(await target.exportState()).toEqual(sourceState);
      expect(await target.readAuxiliary({ kind: "security_events", limit: 10 })).toEqual(
        await source.readAuxiliary({ kind: "security_events", limit: 10 }),
      );
      expect(await target.readAuxiliary({ kind: "session_touch", sessionId: "session-1" })).toEqual(
        await source.readAuxiliary({ kind: "session_touch", sessionId: "session-1" }),
      );

      const targetHead = await target.readHead();
      const targetSession = await target.readAuxiliary({
        kind: "session_touch",
        sessionId: "session-1",
      });
      const targetRevocation = await target.commitAuxiliary({
        kind: "session_touch",
        sessionId: "session-1",
        lastUsedAt: "2026-01-01T00:00:02.000Z",
        expectedRevision:
          targetSession &&
          typeof targetSession === "object" &&
          "revision" in targetSession &&
          typeof targetSession.revision === "string"
            ? targetSession.revision
            : "",
        expectedGeneration: targetHead,
      });
      expect(targetRevocation).toEqual({ kind: "revoked" });
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe("filesystem authority migration staging", () => {
  it("keeps staged generation state unreachable until publish and supports invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-stage-"));
    const source = await createFilesystemAuthority(join(root, "source"));
    const target = await createFilesystemAuthority(join(root, "target"));
    try {
      const committed = await source.commit(
        envelope(
          {
            kind: "replace_snapshot",
            snapshot: { ...snapshot("migrated"), sessions: { active: true } },
            result: { accepted: true },
          } as unknown as FilesystemAuthorityCommand,
          { idempotencyKey: "stage-source", requestDigest: "stage-source" },
        ),
      );
      expect(committed.kind).toBe("committed");
      const exported = await source.exportState();

      const stage = await target.stageMigration(exported, { owner: "migration-owner" });
      expect(await target.readHead()).toBeNull();
      expect(await target.readMigrationStage(stage, { owner: "migration-owner" })).toEqual(
        exported,
      );

      await target.invalidateMigrationStage(stage, { owner: "migration-owner" });
      expect(await target.readHead()).toBeNull();

      const retryStage = await target.stageMigration(exported, { owner: "migration-owner" });
      const published = await target.publishMigrationStage(retryStage, {
        owner: "migration-owner",
      });
      expect(published.generation.id).toBe(exported.generation.id);
      expect(await target.exportState()).toEqual(exported);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe("filesystem authority domain codec parity", () => {
  it("accepts generic domain commands carrying a nested snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-filesystem-domain-"));
    const authority = await createFilesystemAuthority(root);
    const codec = new AuthorityDomainCodec({
      authority: authority as unknown as WritableAuthority<unknown, unknown>,
      encryptionKey: new Uint8Array(32),
    });
    const read = await codec.read();

    const committed = await codec.commit({
      read,
      domain: "remoteCredentials",
      command: { kind: "create_pending_login" },
      snapshot: {
        remoteCredentials: {
          pendingLogins: [{ id: "login-1", status: "pending" }],
        },
      },
      result: { ok: true },
      payload: { id: "login-1" },
      idempotencyKey: "domain-1",
    });
    expect(committed.kind).toBe("committed");
    const head = await authority.readHead();
    if (!head) throw new Error("expected domain generation");
    expect((await authority.readGeneration(head.id)).snapshot).toEqual({
      remoteCredentials: {
        pendingLogins: [{ id: "login-1", status: "pending" }],
      },
    });
    const wrappedSnapshot: FilesystemAuthoritySnapshot = {
      caplets: { "setup-caplet": { id: "setup-caplet", config: { mcpServers: {} } } },
      setupApprovals: { approval: { status: "approved" } },
    };
    const wrapped = await authority.commit(
      envelope(
        {
          ...wrappedSnapshot,
          kind: "setup_approval",
          snapshot: wrappedSnapshot,
        } as unknown as FilesystemAuthorityCommand,
        {
          expectedGeneration: committed.generation,
          idempotencyKey: "domain-2",
          requestDigest: "domain-2",
        },
      ),
    );
    expect(wrapped.kind).toBe("committed");
    if (wrapped.kind !== "committed") throw new Error("expected wrapped domain generation");
    expect(wrappedSnapshot).not.toHaveProperty("snapshot");
    expect((await authority.readGeneration(wrapped.generation.id)).snapshot).not.toHaveProperty(
      "snapshot",
    );
    const target = await createFilesystemAuthority(join(root, "restore"));
    try {
      const exported = await authority.exportState();
      await target.restoreState(exported);
      expect((await target.exportState()).generation.snapshot).toEqual(
        exported.generation.snapshot,
      );
    } finally {
      await target.close();
      await authority.close();
    }
  });
});
