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
import { authorityGenerationDigest, type MaintenanceFence } from "../src/storage/migration";
import {
  createAuthorityBackup,
  decodeAuthorityBackup,
  readAuthorityBackupHeader,
  restoreAuthorityBackup,
  type AuthorityBackup,
} from "../src/storage/backup";

function stateFor(provider: AuthorityHealth["provider"] = "filesystem"): AuthorityExport {
  const generation: AuthorityGeneration = {
    authorityId: "authority",
    id: "generation-1",
    sequence: 1,
    predecessorId: null,
    schemaVersion: 1,
    committedAt: "2026-07-12T00:00:00.000Z",
    provenance: { provider, namespace: "namespace" },
    digest: "",
    snapshot: {
      caplets: {
        one: {
          id: "one",
          config: { mcpServers: {} },
          vault: { ciphertext: "encrypted-secret" },
          provenance: {
            kind: "authority",
            authorityId: "authority",
            recordId: "one",
            generationId: "generation-1",
          },
        },
      },
      oauth: { ciphertext: "encrypted-oauth" },
      sessions: [{ sessionId: "session-1", revoked: true }],
    },
  };
  generation.digest = authorityGenerationDigest(generation);
  return {
    generation,
    auxiliaryWatermark: "42",
    receipts: [
      {
        currentHostId: "host",
        principalId: "operator",
        idempotencyKey: "intent",
        requestDigest: "request",
        generation: {
          authorityId: generation.authorityId,
          id: generation.id,
          sequence: generation.sequence,
          predecessorId: generation.predecessorId,
        },
        result: { accepted: true },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    auxiliary: {
      watermark: "42",
      sessions: {
        "session-1": { revision: "7", lastUsedAt: "2026-07-12T00:00:00.000Z", revoked: false },
      },
      securityEvents: [
        { kind: "rejected", occurredAt: "2026-07-12T00:00:00.000Z", code: "DENIED" },
      ],
    },
  };
}

class BackupAuthority implements WritableAuthority {
  state: AuthorityExport;
  readonly authorityId: string;
  readonly namespace: string;
  readonly provider: AuthorityHealth["provider"];
  readonly schemaVersion = 1;
  selected: boolean;
  interrupted = false;

  constructor(
    state: AuthorityExport,
    options: {
      authorityId?: string;
      namespace?: string;
      provider?: AuthorityHealth["provider"];
      selected?: boolean;
    } = {},
  ) {
    this.state = structuredClone(state);
    this.authorityId = options.authorityId ?? state.generation.authorityId;
    this.namespace = options.namespace ?? state.generation.provenance.namespace;
    this.provider = options.provider ?? state.generation.provenance.provider;
    this.selected = options.selected ?? true;
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
    return structuredClone(this.state);
  }

  async restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult> {
    if (this.interrupted) throw new Error("simulated interruption");
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
}

function restoreFence(): MaintenanceFence & { acquired: number; released: number } {
  return {
    acquired: 0,
    released: 0,
    async acquire() {
      this.acquired += 1;
      return undefined;
    },
    async release() {
      this.released += 1;
    },
  };
}

function bytesOf(backup: AuthorityBackup): Buffer {
  return Buffer.from(backup.bytes);
}

describe("external-key authority backups", () => {
  it("uses an authenticated clear header and encrypted body while preserving durable state", async () => {
    const source = new BackupAuthority(stateFor());
    const key = Buffer.from("external-key-material");
    const backup = await createAuthorityBackup(source, { key });
    const bytes = bytesOf(backup);
    expect(backup.header).toMatchObject({
      magic: "caplets-authority-backup",
      formatVersion: 1,
      algorithm: "aes-256-gcm",
      provider: "filesystem",
      authorityId: "authority",
      namespace: "namespace",
      schemaVersion: 1,
      auxiliaryWatermark: "42",
    });
    expect(bytes.toString("utf8")).not.toContain("external-key-material");
    expect(bytes.toString("utf8")).not.toContain("encrypted-secret");
    expect(bytes.toString("utf8")).not.toContain("/private/source");
    expect(JSON.stringify(readAuthorityBackupHeader(backup))).not.toContain(
      "external-key-material",
    );

    const decoded = await decodeAuthorityBackup(backup, key);
    expect(decoded.state).toEqual(source.state);
    expect(decoded.state.receipts).toHaveLength(1);
    expect(decoded.state.auxiliary?.watermark).toBe("42");
    expect(decoded.state.auxiliary?.securityEvents).toHaveLength(1);
  });

  it("rejects wrong keys and authenticated header/body corruption", async () => {
    const backup = await createAuthorityBackup(new BackupAuthority(stateFor()), {
      key: Buffer.alloc(32, 7),
    });
    await expect(decodeAuthorityBackup(backup, Buffer.alloc(32, 8))).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });

    const bodyCorrupt = bytesOf(backup);
    const bodyCorruptIndex = bodyCorrupt.length - 1;
    bodyCorrupt[bodyCorruptIndex] = (bodyCorrupt[bodyCorruptIndex] ?? 0) ^ 1;
    await expect(decodeAuthorityBackup(bodyCorrupt, Buffer.alloc(32, 7))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    const headerCorrupt = bytesOf(backup);
    const headerStart = Buffer.from("CAPLETS-AUTHORITY-BACKUP\\0").byteLength + 4;
    const headerCorruptIndex = headerStart + 5;
    headerCorrupt[headerCorruptIndex] = (headerCorrupt[headerCorruptIndex] ?? 0) ^ 1;
    await expect(decodeAuthorityBackup(headerCorrupt, Buffer.alloc(32, 7))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects provider/schema mismatches and non-empty restore targets before writes", async () => {
    const backup = await createAuthorityBackup(new BackupAuthority(stateFor()), {
      key: Buffer.alloc(32, 9),
    });
    const fence = restoreFence();
    const providerMismatch = new BackupAuthority(stateFor("s3"), {
      authorityId: "authority",
      namespace: "namespace",
      provider: "s3",
      selected: false,
    });
    await expect(
      restoreAuthorityBackup(providerMismatch, backup, { key: Buffer.alloc(32, 9), fence }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fence.acquired).toBe(0);

    const nonEmpty = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: true,
    });
    await expect(
      restoreAuthorityBackup(nonEmpty, backup, { key: Buffer.alloc(32, 9), fence }),
    ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
    expect(fence.acquired).toBe(0);

    const schemaMismatch = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: false,
    });
    await expect(
      restoreAuthorityBackup(schemaMismatch, backup, {
        key: Buffer.alloc(32, 9),
        fence,
        expectedSchemaVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("requires a destination fence, preserves watermark/receipts, and rejects interruption safely", async () => {
    const source = new BackupAuthority(stateFor());
    const backup = await createAuthorityBackup(source, { key: Buffer.alloc(32, 11) });
    const noFenceTarget = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: false,
    });
    await expect(
      restoreAuthorityBackup(noFenceTarget, backup, { key: Buffer.alloc(32, 11) }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(await noFenceTarget.readHead()).toBeNull();

    const interrupted = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: false,
    });
    interrupted.interrupted = true;
    const fence = restoreFence();
    await expect(
      restoreAuthorityBackup(interrupted, backup, { key: Buffer.alloc(32, 11), fence }),
    ).rejects.toThrow(/interruption/);
    expect(await interrupted.readHead()).toBeNull();
    expect(fence.acquired).toBe(1);
    expect(fence.released).toBe(1);

    const target = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: false,
    });
    const result = await restoreAuthorityBackup(target, backup, {
      key: Buffer.alloc(32, 11),
      fence,
    });
    expect(result.auxiliaryWatermark).toBe("42");
    expect(target.state.receipts).toHaveLength(1);
    expect(target.state.auxiliary?.securityEvents).toHaveLength(1);
  });
  it("returns verified restore success with a cleanup diagnostic when fence release fails", async () => {
    const source = new BackupAuthority(stateFor());
    const backup = await createAuthorityBackup(source, { key: Buffer.alloc(32, 13) });
    const target = new BackupAuthority(stateFor(), {
      authorityId: "authority",
      namespace: "namespace",
      selected: false,
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
      async release() {
        throw new Error("simulated fence release failure");
      },
    };

    const result = await restoreAuthorityBackup(target, backup, {
      key: Buffer.alloc(32, 13),
      fence,
    });
    expect(result).toMatchObject({
      generation: {
        id: "generation-1",
      },
      diagnostics: [
        {
          code: "MAINTENANCE_FENCE_RELEASE_FAILED",
          operation: "restore",
          phase: "cleanup",
          retryable: false,
        },
      ],
    });
    expect(result.diagnostics?.[0]?.message).toContain("do not retry");
    expect(leaseReleases).toEqual(["destination"]);
    expect(await target.readHead()).not.toBeNull();
  });
});
