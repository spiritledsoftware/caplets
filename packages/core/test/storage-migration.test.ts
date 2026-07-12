import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AuthorityCommitResult,
  AuthorityExport,
  AuthorityGeneration,
  AuthorityHead,
  AuthorityHealth,
  AuthorityRestoreResult,
  AuxiliaryCommit,
  AuxiliaryCommitResult,
  AuxiliaryRead,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../src/storage/types";
import { createFilesystemAuthority } from "../src/storage/filesystem-authority";
import { createSqliteAuthority } from "../src/storage/sql/authority";
import { migrateSqliteDatabase } from "../src/storage/sql/migrate";
import {
  authorityExportDigest,
  authorityGenerationDigest,
  inventoryAuthority,
  createWritableAuthorityMigrationAdapter,
  migrateAuthority,
  type MaintenanceFence,
  type MigrationStage,
} from "../src/storage/migration";

function makeGeneration(
  snapshot: Record<string, unknown>,
  overrides: Partial<AuthorityGeneration> = {},
): AuthorityGeneration {
  const generation: AuthorityGeneration = {
    authorityId: "source",
    id: "source-generation",
    sequence: 4,
    predecessorId: "source-previous",
    schemaVersion: 1,
    committedAt: "2026-07-12T00:00:00.000Z",
    provenance: { provider: "filesystem", namespace: "source-ns" },
    digest: "",
    snapshot,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "digest"))
    generation.digest = authorityGenerationDigest(generation);
  return generation;
}

class FakeAuthority implements WritableAuthority {
  state: AuthorityExport;
  selected = false;
  stageCalls = 0;
  publishCalls = 0;
  invalidateCalls = 0;
  staged: AuthorityExport | undefined;
  readonly authorityId: string;
  readonly namespace: string;
  readonly provider: AuthorityHealth["provider"];
  readonly schemaVersion: number;
  raceState: AuthorityExport | undefined;
  exportCalls = 0;

  constructor(
    state: AuthorityExport,
    options: {
      authorityId?: string;
      namespace?: string;
      provider?: AuthorityHealth["provider"];
      schemaVersion?: number;
    } = {},
  ) {
    this.state = state;
    this.selected = options.authorityId === undefined;
    this.authorityId = options.authorityId ?? state.generation.authorityId;
    this.namespace = options.namespace ?? state.generation.provenance.namespace;
    this.provider = options.provider ?? state.generation.provenance.provider;
    this.schemaVersion = options.schemaVersion ?? state.generation.schemaVersion;
  }

  async readHead(): Promise<AuthorityHead | null> {
    if (!this.selected) return null;
    return {
      authorityId: this.state.generation.authorityId,
      id: this.state.generation.id,
      sequence: this.state.generation.sequence,
      predecessorId: this.state.generation.predecessorId,
      digest: this.state.generation.digest,
    };
  }

  async readGeneration(id: string): Promise<AuthorityGeneration> {
    if (id !== this.state.generation.id) throw new Error("missing generation");
    return structuredClone(this.state.generation);
  }

  async commit<TResult = unknown>(
    _envelope: SemanticCommandEnvelope,
  ): Promise<AuthorityCommitResult<TResult>> {
    throw new Error("not used");
  }

  async readAuxiliary(_request: AuxiliaryRead): Promise<unknown> {
    return undefined;
  }

  async commitAuxiliary(_command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    return { kind: "missing" };
  }

  async health(): Promise<AuthorityHealth> {
    return {
      provider: this.provider,
      authorityId: this.authorityId,
      connectivity: "healthy",
      writable: true,
      activeGeneration: this.selected ? this.state.generation : null,
      refresh: "current",
    };
  }

  async exportState(): Promise<AuthorityExport> {
    this.exportCalls += 1;
    if (this.raceState && this.exportCalls > 1) return structuredClone(this.raceState);
    return structuredClone(this.state);
  }

  async restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult> {
    this.state = structuredClone(state);
    this.selected = true;
    return {
      generation: {
        authorityId: state.generation.authorityId,
        id: state.generation.id,
        sequence: state.generation.sequence,
        predecessorId: state.generation.predecessorId,
      },
      auxiliaryWatermark: state.auxiliaryWatermark,
    };
  }

  async close(): Promise<void> {}

  async stageState(state: AuthorityExport): Promise<MigrationStage> {
    this.stageCalls += 1;
    this.staged = structuredClone(state);
    return { token: "candidate", state: structuredClone(state) };
  }

  async readStagedState(_stage: MigrationStage): Promise<AuthorityExport> {
    if (!this.staged) throw new Error("missing candidate");
    return structuredClone(this.staged);
  }

  async publishStagedState(_stage: MigrationStage): Promise<AuthorityRestoreResult> {
    this.publishCalls += 1;
    if (!this.staged) throw new Error("missing candidate");
    this.state = structuredClone(this.staged);
    this.selected = true;
    return {
      generation: {
        authorityId: this.state.generation.authorityId,
        id: this.state.generation.id,
        sequence: this.state.generation.sequence,
        predecessorId: this.state.generation.predecessorId,
      },
      auxiliaryWatermark: this.state.auxiliaryWatermark,
    };
  }

  async invalidateStagedState(_stage: MigrationStage): Promise<void> {
    this.invalidateCalls += 1;
    this.staged = undefined;
  }
}

function sourceState(snapshot: Record<string, unknown>): AuthorityExport {
  const generation = makeGeneration(snapshot);
  return {
    generation,
    auxiliaryWatermark: "17",
    receipts: [],
    auxiliary: { watermark: "17", securityEvents: [] },
  };
}

function sourceFence(): MaintenanceFence & { contexts: string[] } {
  const contexts: string[] = [];
  return {
    contexts,
    async acquire(context) {
      contexts.push(`acquire:${context.role}`);
      return { release: async () => contexts.push(`lease-release:${context.role}`) };
    },
    async assertReadOnly(context) {
      contexts.push(`read-only:${context.role}`);
    },
  };
}

describe("provider-neutral authority migration", () => {
  it("inventories typed domains with redacted digests and explicit exclusions", async () => {
    const authority = new FakeAuthority(
      sourceState({
        config: { mcpServers: {} },
        caplets: {
          github: {
            id: "github",
            provenance: { kind: "global-file", path: "/private/source/caplets/github.md" },
          },
          linear: { id: "linear" },
        },
        settings: { theme: "dark" },
        vault: { grants: { operator: { ciphertext: "encrypted" } } },
        sessions: [{ sessionId: "session-1" }],
        activities: [{ kind: "accepted" }],
        securityEvents: [{ kind: "rejected" }],
        remoteCredentials: {
          version: 1,
          pairingCodes: [
            {
              codeId: "pairing-1",
              hostUrl: "https://remote.example",
              secretHash: "hashed-pairing-secret",
              createdAt: "2026-07-12T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              attempts: 0,
              maxAttempts: 5,
            },
          ],
          pendingLogins: [
            {
              flowId: "flow-1",
              hostUrl: "https://remote.example",
              operatorCodeHash: "hashed-operator-code",
              pendingRefreshHash: "hashed-pending-refresh",
              pendingCompletionHash: "hashed-completion",
              supersededPendingRefreshHashes: [],
              clientLabel: "Remote",
              requestedRole: "access",
              createdAt: "2026-07-12T00:00:00.000Z",
              codeExpiresAt: "2099-01-01T00:00:00.000Z",
              flowExpiresAt: "2099-01-01T00:00:00.000Z",
              status: "pending",
              operatorCodeFingerprint: "hashed",
              pendingRefreshReplay: {
                refreshHash: "hashed-pending-refresh",
                expiresAt: "2099-01-01T00:00:00.000Z",
                encryptedResponse: {
                  version: 1,
                  algorithm: "aes-256-gcm",
                  nonce: "nonce",
                  ciphertext: "ciphertext",
                  authTag: "auth-tag",
                  valueBytes: 1,
                  createdAt: "2026-07-12T00:00:00.000Z",
                  updatedAt: "2026-07-12T00:00:00.000Z",
                },
              },
              completionReplay: {
                expiresAt: "2099-01-01T00:00:00.000Z",
                encryptedCredentials: {
                  version: 1,
                  algorithm: "aes-256-gcm",
                  nonce: "nonce",
                  ciphertext: "ciphertext",
                  authTag: "auth-tag",
                  valueBytes: 1,
                  createdAt: "2026-07-12T00:00:00.000Z",
                  updatedAt: "2026-07-12T00:00:00.000Z",
                },
              },
            },
          ],
          clients: [
            {
              clientId: "client-1",
              clientLabel: "Remote",
              role: "access",
              hostUrl: "https://remote.example",
              accessTokenHash: "hashed-access-token",
              accessExpiresAt: "2099-01-01T00:00:00.000Z",
              refreshTokenHash: "hashed-refresh-token",
              supersededRefreshTokenHashes: [],
              refreshFamilyId: "family-1",
              createdAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
        setupActivity: [
          {
            kind: "setup_approval",
            decision: "grant",
            projectFingerprint: "project",
            capletId: "github",
            contentHash: "content",
            targetKind: "local_host",
            actor: "automation",
            occurredAt: "2026-07-12T00:00:00.000Z",
            expectedGeneration: null,
          },
        ],
        setupApprovals: { approval: { status: "approved" } },
        receipts: { intent: { expiresAt: "2099-01-01T00:00:00.000Z" } },
      }),
    );

    const inventory = await inventoryAuthority(authority);
    expect(inventory.identity).toEqual({
      authorityId: "source",
      provider: "filesystem",
      namespace: "source-ns",
    });
    expect(inventory.head).toMatchObject({ id: "source-generation", sequence: 4 });
    expect(inventory.generation).toMatchObject({ id: "source-generation", sequence: 4 });
    expect(inventory.domains.find((domain) => domain.name === "caplets")).toMatchObject({
      count: 2,
      schemaVersion: 1,
    });
    expect(inventory.domains.find((domain) => domain.name === "remoteCredentials")).toMatchObject({
      count: 3,
      schemaVersion: 1,
    });
    expect(inventory.domains.find((domain) => domain.name === "setupActivity")).toMatchObject({
      count: 1,
      schemaVersion: 1,
    });
    expect(
      inventory.domains.every((domain) => /^sha256:[0-9a-f]{64}$/u.test(domain.redactedDigest)),
    ).toBe(true);
    expect(inventory.exclusions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "provider-credentials",
        "encryption-key-bytes",
        "staged-files",
        "logs-journals-caches",
      ]),
    );
    expect(JSON.stringify(inventory)).not.toContain("/private/source");
  });

  it("blocks unknown and malformed host-owned records instead of guessing", async () => {
    const unknown = new FakeAuthority(sourceState({ unknownHostState: { value: true } }));
    await expect(inventoryAuthority(unknown)).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const malformed = new FakeAuthority(sourceState({ caplets: "not-a-record" }));
    await expect(inventoryAuthority(malformed)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const plaintextRemote = new FakeAuthority(
      sourceState({
        remoteCredentials: {
          version: 1,
          pairingCodes: [
            {
              codeId: "pairing-1",
              hostUrl: "https://remote.example",
              secret: "plain-secret",
              secretHash: "hashed",
              createdAt: "2026-07-12T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              attempts: 0,
              maxAttempts: 5,
            },
          ],
          pendingLogins: [],
          clients: [],
        },
      }),
    );
    await expect(inventoryAuthority(plaintextRemote)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("dry-runs without selecting or staging the destination", async () => {
    const source = new FakeAuthority(sourceState({ caplets: { one: { id: "one" } } }));
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
      provider: "sqlite",
    });
    const fence = sourceFence();

    const result = await migrateAuthority({ source, target, fence, dryRun: true });
    expect(result.kind).toBe("dry-run");
    if (result.kind !== "dry-run") throw new Error("expected dry-run");
    expect(result.target).toEqual({
      authorityId: "target",
      provider: "sqlite",
      namespace: "target-ns",
    });
    expect(target.stageCalls).toBe(0);
    expect(target.publishCalls).toBe(0);
    expect(await target.readHead()).toBeNull();
  });

  it("fences, behaviorally verifies, publishes once, and returns only cutover coordinates", async () => {
    const source = new FakeAuthority(
      sourceState({
        caplets: {
          one: {
            id: "one",
            provenance: { kind: "project-file", path: "/absolute/source/project.md" },
          },
        },
      }),
    );
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
      provider: "sqlite",
    });
    const fence = sourceFence();

    const result = await migrateAuthority({ source, target, fence });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied migration");
    expect(Object.keys(result)).toEqual(["kind", "cutover"]);
    expect(result.cutover).toMatchObject({
      authorityId: "target",
      provider: "sqlite",
      namespace: "target-ns",
      sequence: 1,
    });
    expect(target.stageCalls).toBe(1);
    expect(target.publishCalls).toBe(1);
    expect(target.invalidateCalls).toBe(0);
    const targetGeneration = await target.readGeneration(result.cutover.generationId);
    expect(targetGeneration.snapshot).toMatchObject({
      caplets: {
        one: {
          provenance: {
            kind: "authority",
            authorityId: "target",
            generationId: result.cutover.generationId,
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/absolute/source");
    expect(fence.contexts).toEqual(
      expect.arrayContaining(["read-only:source", "acquire:source", "acquire:destination"]),
    );
  });

  it("invalidates an unselected candidate when the source digest races staging", async () => {
    const source = new FakeAuthority(sourceState({ caplets: { one: { id: "one" } } }));
    source.raceState = sourceState({ caplets: { one: { id: "one" }, raced: { id: "raced" } } });
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
    });

    await expect(migrateAuthority({ source, target, fence: sourceFence() })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(target.invalidateCalls).toBe(1);
    expect(target.publishCalls).toBe(0);
    expect(await target.readHead()).toBeNull();
  });

  it("blocks a migration when only auxiliary security-event state races staging", async () => {
    const source = new FakeAuthority(sourceState({ caplets: {} }));
    source.raceState = structuredClone(source.state);
    source.raceState.auxiliary = {
      watermark: "17",
      securityEvents: [{ kind: "rejected", occurredAt: "2026-07-12T00:00:00.000Z", code: "RACED" }],
      securityEventWatermarks: ["17"],
    };
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
    });

    await expect(migrateAuthority({ source, target, fence: sourceFence() })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(target.invalidateCalls).toBe(1);
    expect(target.publishCalls).toBe(0);
    expect(await target.readHead()).toBeNull();
  });

  it("normalizes legacy auxiliary sessions for canonical SQL migration state", async () => {
    const source = new FakeAuthority(sourceState({ caplets: {} }));
    const legacyAuxiliary = {
      watermark: "17",
      sessions: { legacy: { revision: "1", lastUsedAt: "2026-07-12T00:00:00.000Z" } },
      securityEvents: [],
    } as unknown as NonNullable<AuthorityExport["auxiliary"]>;
    source.state.auxiliary = legacyAuxiliary;
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
      provider: "sqlite",
    });

    const result = await migrateAuthority({ source, target, fence: sourceFence() });
    expect(result.kind).toBe("applied");
    expect(target.state.auxiliary?.sessions?.legacy).toMatchObject({ revoked: false });
  });

  it("fails closed when fences are absent or the destination is non-empty", async () => {
    const source = new FakeAuthority(sourceState({ caplets: {} }));
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
    });
    await expect(migrateAuthority({ source, target })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });

    target.selected = true;
    await expect(migrateAuthority({ source, target, fence: sourceFence() })).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
  });

  it("detects malformed source export/head identity before staging", async () => {
    const source = new FakeAuthority(sourceState({ caplets: {} }));
    source.state.generation.digest = "sha256:wrong";
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
    });
    await expect(inventoryAuthority(source)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(migrateAuthority({ source, target, fence: sourceFence() })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(target.stageCalls).toBe(0);
  });

  it("uses the complete canonical export digest for source race checks", async () => {
    const state = sourceState({ caplets: {} });
    expect(authorityExportDigest(state)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const changed = structuredClone(state);
    changed.auxiliaryWatermark = "18";
    expect(authorityExportDigest(changed)).not.toBe(authorityExportDigest(state));
  });

  it("adapts normal filesystem and SQLite authorities through one restore/read-back publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u8-migration-fs-"));
    const source = await createFilesystemAuthority({
      root: join(root, "source"),
      authorityId: "source",
      namespace: "source-ns",
    });
    const target = await createFilesystemAuthority({
      root: join(root, "target"),
      authorityId: "target",
      namespace: "target-ns",
    });
    try {
      await source.commit({
        authorityId: "source",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: { kind: "replace_snapshot", snapshot: { caplets: { fs: { id: "fs" } } } },
      });
      const result = await migrateAuthority({
        source,
        target,
        fence: sourceFence(),
        targetNamespace: "target-ns",
      });
      expect(result.kind).toBe("applied");
      const head = await target.readHead();
      expect(head).not.toBeNull();
      if (!head) throw new Error("expected filesystem target head");
      expect((await target.readGeneration(head.id)).snapshot).toMatchObject({
        caplets: { fs: { id: "fs" } },
      });
    } finally {
      await source.close();
      await target.close();
    }

    const sqliteSourcePath = join(root, "source.sqlite");
    const sqliteTargetPath = join(root, "target.sqlite");
    await migrateSqliteDatabase({
      databasePath: sqliteSourcePath,
      authorityId: "source",
      namespace: "source-ns",
    });
    await migrateSqliteDatabase({
      databasePath: sqliteTargetPath,
      authorityId: "target",
      namespace: "target-ns",
    });
    const sqliteSource = await createSqliteAuthority<
      Record<string, unknown>,
      { snapshot: Record<string, unknown> }
    >({
      databasePath: sqliteSourcePath,
      authorityId: "source",
      namespace: "source-ns",
      initialSnapshot: { caplets: {} },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
    });
    const sqliteTarget = await createSqliteAuthority<
      Record<string, unknown>,
      { snapshot: Record<string, unknown> }
    >({
      databasePath: sqliteTargetPath,
      authorityId: "target",
      namespace: "target-ns",
      initialSnapshot: { caplets: {} },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
    });
    try {
      await sqliteSource.commit({
        authorityId: "source",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: { snapshot: { caplets: { sql: { id: "sql" } } } },
      });
      const result = await migrateAuthority({
        source: sqliteSource,
        target: sqliteTarget,
        fence: sourceFence(),
        targetNamespace: "target-ns",
      });
      expect(result.kind).toBe("applied");
      const head = await sqliteTarget.readHead();
      expect(head).not.toBeNull();
      if (!head) throw new Error("expected SQLite target head");
      expect((await sqliteTarget.readGeneration(head.id)).snapshot).toMatchObject({
        caplets: { sql: { id: "sql" } },
      });
    } finally {
      await sqliteSource.close();
      await sqliteTarget.close();
    }
  });
  it("invalidates a SQLite candidate after staged read-back failure and retries empty-target publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u8-migration-sql-stage-"));
    const sourceRoot = join(root, "source");
    const targetPath = join(root, "target.sqlite");
    const source = await createFilesystemAuthority({
      root: sourceRoot,
      authorityId: "source",
      namespace: "source-ns",
    });
    await migrateSqliteDatabase({
      databasePath: targetPath,
      authorityId: "target",
      namespace: "target-ns",
    });
    const target = await createSqliteAuthority<
      Record<string, unknown>,
      { snapshot: Record<string, unknown> }
    >({
      databasePath: targetPath,
      authorityId: "target",
      namespace: "target-ns",
      initialSnapshot: { caplets: {} },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
    });
    try {
      await source.commit({
        authorityId: "source",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: { kind: "replace_snapshot", snapshot: { caplets: { sql: { id: "sql" } } } },
      });
      const originalRead = target.readMigrationStage.bind(target);
      let corruptReadback = true;
      target.readMigrationStage = async (stage, context) => {
        const staged = await originalRead(stage, context);
        if (!corruptReadback) return staged;
        corruptReadback = false;
        return {
          ...staged,
          generation: {
            ...staged.generation,
            digest: `sha256:${"0".repeat(64)}`,
          },
        };
      };

      await expect(
        migrateAuthority({
          source,
          target,
          fence: sourceFence(),
          targetNamespace: "target-ns",
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(await target.readHead()).toBeNull();

      const retry = await migrateAuthority({
        source,
        target,
        fence: sourceFence(),
        targetNamespace: "target-ns",
      });
      expect(retry.kind).toBe("applied");
      expect(await target.readHead()).toMatchObject({ id: expect.any(String) });
    } finally {
      await source.close();
      await target.close();
    }
  });
  it("derives the configured target schema for filesystem-to-SQLite and SQLite-to-filesystem cutovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u8-migration-schema-"));
    const filesystemSource = await createFilesystemAuthority({
      root: join(root, "filesystem-source"),
      authorityId: "filesystem-source",
      namespace: "filesystem-source-ns",
    });
    const sqliteTargetPath = join(root, "sqlite-target.sqlite");
    await migrateSqliteDatabase({
      databasePath: sqliteTargetPath,
      authorityId: "sqlite-target",
      namespace: "sqlite-target-ns",
    });
    const sqliteTarget = await createSqliteAuthority<
      Record<string, unknown>,
      { snapshot: Record<string, unknown> }
    >({
      databasePath: sqliteTargetPath,
      authorityId: "sqlite-target",
      namespace: "sqlite-target-ns",
      initialSnapshot: { caplets: {} },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
    });
    const sqliteSourcePath = join(root, "sqlite-source.sqlite");
    await migrateSqliteDatabase({
      databasePath: sqliteSourcePath,
      authorityId: "sqlite-source",
      namespace: "sqlite-source-ns",
    });
    const sqliteSource = await createSqliteAuthority<
      Record<string, unknown>,
      { snapshot: Record<string, unknown> }
    >({
      databasePath: sqliteSourcePath,
      authorityId: "sqlite-source",
      namespace: "sqlite-source-ns",
      initialSnapshot: { caplets: {} },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot }),
    });
    const filesystemTarget = await createFilesystemAuthority({
      root: join(root, "filesystem-target"),
      authorityId: "filesystem-target",
      namespace: "filesystem-target-ns",
    });
    try {
      await filesystemSource.commit({
        authorityId: "filesystem-source",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: { kind: "replace_snapshot", snapshot: { caplets: { source: { id: "source" } } } },
      });
      const toSqlite = await migrateAuthority({
        source: filesystemSource,
        target: sqliteTarget,
        fence: sourceFence(),
        targetNamespace: "sqlite-target-ns",
      });
      expect(toSqlite.kind).toBe("applied");
      if (toSqlite.kind !== "applied") throw new Error("expected filesystem-to-SQLite migration");
      const sqliteGeneration = await sqliteTarget.readGeneration(toSqlite.cutover.generationId);
      expect(sqliteGeneration.schemaVersion).toBe(sqliteTarget.schemaVersion);

      await sqliteSource.commit({
        authorityId: "sqlite-source",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: { snapshot: { caplets: { source: { id: "source" } } } },
      });
      const toFilesystem = await migrateAuthority({
        source: sqliteSource,
        target: filesystemTarget,
        fence: sourceFence(),
        targetNamespace: "filesystem-target-ns",
      });
      expect(toFilesystem.kind).toBe("applied");
      if (toFilesystem.kind !== "applied")
        throw new Error("expected SQLite-to-filesystem migration");
      const filesystemGeneration = await filesystemTarget.readGeneration(
        toFilesystem.cutover.generationId,
      );
      expect(filesystemGeneration.schemaVersion).toBe(filesystemTarget.schemaVersion);
    } finally {
      await filesystemSource.close();
      await sqliteTarget.close();
      await sqliteSource.close();
      await filesystemTarget.close();
    }
  });
  it("returns verified success with cleanup diagnostics when fence release fails", async () => {
    const source = new FakeAuthority(sourceState({ caplets: { one: { id: "one" } } }));
    const target = new FakeAuthority(sourceState({ caplets: {} }), {
      authorityId: "target",
      namespace: "target-ns",
    });
    const leaseReleases: string[] = [];
    const fence: MaintenanceFence = {
      async acquire(context) {
        return {
          release: async () => {
            leaseReleases.push(context.role);
          },
        };
      },
      async assertReadOnly() {},
      async release() {
        throw new Error("simulated fence release failure");
      },
    };

    const result = await migrateAuthority({ source, target, fence });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("expected applied migration");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "MAINTENANCE_FENCE_RELEASE_FAILED",
        operation: "migration",
        phase: "cleanup",
        retryable: false,
      }),
      expect.objectContaining({
        code: "MAINTENANCE_FENCE_RELEASE_FAILED",
        operation: "migration",
        phase: "cleanup",
        retryable: false,
      }),
    ]);
    expect(
      result.diagnostics?.every((diagnostic) => diagnostic.message.includes("do not retry")),
    ).toBe(true);
    expect(leaseReleases).toEqual(["destination", "source"]);
    expect(await target.readHead()).not.toBeNull();
  });

  it("fails closed instead of adapting restoreState as publish-early staging", () => {
    let restoreCalls = 0;
    const authority = {
      restoreState: async () => {
        restoreCalls += 1;
        throw new Error("restore must not be called");
      },
    } as unknown as WritableAuthority;

    expect(() => createWritableAuthorityMigrationAdapter(authority)).toThrow(
      /transactional migration staging/u,
    );
    expect(restoreCalls).toBe(0);
  });
});
