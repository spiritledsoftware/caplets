import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CapletsError } from "../errors";
import {
  decryptVaultValue,
  encryptVaultValue,
  parseEncryptedRecord,
  type VaultEncryptedRecord,
} from "../vault/crypto";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityCommitResult,
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuxiliaryCommitResult,
  AuxiliaryRead,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../storage/types";

export type AuthorityDomainSnapshot = Record<string, unknown>;

export type AuthorityDomainCodecOptions = {
  authority: WritableAuthority<unknown, unknown>;
  authorityId?: string | undefined;
  currentHostId?: string | undefined;
  principalId?: string | undefined;
  encryptionKey: Buffer | Uint8Array | string;
};

export type AuthorityDomainRead = {
  head: AuthorityHead | null;
  generation: AuthorityGeneration<AuthorityDomainSnapshot> | null;
  snapshot: AuthorityDomainSnapshot;
};

type AuthorityRead = AuthorityDomainRead;

type EncryptedAuthorityResult = {
  kind: "encrypted_result";
  record: VaultEncryptedRecord;
};

type CommitOptions<TCommand extends Record<string, unknown>, TResult> = {
  read: AuthorityRead;
  domain: string;
  command: TCommand;
  snapshot: AuthorityDomainSnapshot;
  result: TResult;
  payload: unknown;
  idempotencyKey?: string | undefined;
  principalId?: string | undefined;
  expectedGeneration?: AuthorityGenerationIdentity | null | undefined;
  authorize?: (read: AuthorityRead) => void | Promise<void>;
  now?: Date | undefined;
};

export class AuthorityDomainCodec {
  readonly authority: WritableAuthority<unknown, unknown>;
  readonly authorityId: string;
  readonly currentHostId: string;
  readonly principalId: string;
  private readonly encryptionKey: Buffer;

  constructor(options: AuthorityDomainCodecOptions) {
    this.authority = options.authority;
    const authorityId = options.authorityId ?? readAuthorityId(options.authority);
    if (!authorityId) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Authority domain codecs require an authority identity.",
      );
    }
    this.authorityId = authorityId;
    this.currentHostId = options.currentHostId ?? authorityId;
    this.principalId = options.principalId ?? "authority-domain";
    this.encryptionKey = normalizeEncryptionKey(options.encryptionKey);
  }

  async read(): Promise<AuthorityRead> {
    const head = await this.authority.readHead();
    if (!head) return { head: null, generation: null, snapshot: {} };
    const generation = (await this.authority.readGeneration(
      head.id,
    )) as AuthorityGeneration<AuthorityDomainSnapshot>;
    if (
      !generation.snapshot ||
      typeof generation.snapshot !== "object" ||
      Array.isArray(generation.snapshot)
    ) {
      throw new CapletsError("CONFIG_INVALID", "Authority generation snapshot is not an object.");
    }
    return { head, generation, snapshot: generation.snapshot };
  }

  domainSnapshot(read: AuthorityRead, domain: string): AuthorityDomainSnapshot {
    const value = read.snapshot[domain];
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as AuthorityDomainSnapshot;
  }

  withDomainSnapshot(
    read: AuthorityRead,
    domain: string,
    value: AuthorityDomainSnapshot,
  ): AuthorityDomainSnapshot {
    return { ...read.snapshot, [domain]: structuredClone(value) };
  }

  async commit<TCommand extends Record<string, unknown>, TResult>(
    options: CommitOptions<TCommand, TResult>,
  ): Promise<{
    kind: "committed" | "replayed";
    generation: AuthorityGenerationIdentity;
    result: TResult;
  }> {
    const read = options.read;
    if (options.authorize) await options.authorize(read);
    const now = options.now ?? new Date();
    const encodedResult: EncryptedAuthorityResult = {
      kind: "encrypted_result",
      record: encryptVaultValue({
        plaintext: JSON.stringify(options.result),
        key: this.encryptionKey,
        now,
      }),
    };
    const command = {
      ...options.command,
      snapshot: options.snapshot,
      result: encodedResult,
      domain: options.domain,
    } as TCommand & {
      snapshot: AuthorityDomainSnapshot;
      result: EncryptedAuthorityResult;
      domain: string;
    };
    const envelope: SemanticCommandEnvelope<unknown> = {
      authorityId: this.authorityId,
      currentHostId: this.currentHostId,
      principalId: options.principalId ?? this.principalId,
      expectedGeneration:
        options.expectedGeneration === undefined
          ? authorityGenerationIdentity(read.head)
          : options.expectedGeneration,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      requestDigest: digestPayload({ domain: options.domain, payload: options.payload }),
      command,
    };
    const committed = (await this.authority.commit(
      envelope,
    )) as AuthorityCommitResult<EncryptedAuthorityResult>;
    if (committed.kind === "conflict") {
      throw new CapletsError("REQUEST_INVALID", "Authority generation conflict.", {
        activeGeneration: committed.active,
      });
    }
    if (committed.kind === "rate_limited" || committed.kind === "quota_exhausted") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authority semantic commit is temporarily unavailable.",
        {
          retryAfterMs: committed.retryAfterMs,
        },
      );
    }
    if (committed.kind !== "committed" && committed.kind !== "replayed") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authority semantic commit did not produce a generation.",
      );
    }
    const resultRecord = committed.receipt?.result ?? encodedResult;
    return {
      kind: committed.kind,
      generation: committed.generation,
      result: decryptAuthorityResult(resultRecord, this.encryptionKey),
    };
  }

  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    return await this.authority.readAuxiliary(request);
  }

  async commitAuxiliary(
    command: Parameters<WritableAuthority["commitAuxiliary"]>[0],
  ): Promise<AuxiliaryCommitResult> {
    return await this.authority.commitAuxiliary(command);
  }

  encrypt(value: unknown, now = new Date()): VaultEncryptedRecord {
    return encryptVaultValue({ plaintext: JSON.stringify(value), key: this.encryptionKey, now });
  }

  decrypt<T>(record: unknown): T {
    return JSON.parse(decryptVaultValue(parseEncryptedRecord(record), this.encryptionKey)) as T;
  }
}

export function digestPayload(value: unknown): string {
  const encoded = stableJsonStringify(value);
  return createHash("sha256")
    .update(encoded ?? "null", "utf8")
    .digest("hex");
}

export function hashAuthoritySecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function safeAuthorityHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function decryptAuthorityResult<T>(value: unknown, key: Buffer): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapletsError("CONFIG_INVALID", "Authority receipt result is malformed.");
  }
  const candidate = value as Partial<EncryptedAuthorityResult>;
  if (candidate.kind !== "encrypted_result" || !candidate.record) {
    throw new CapletsError("CONFIG_INVALID", "Authority receipt result is not encrypted.");
  }
  try {
    return JSON.parse(decryptVaultValue(parseEncryptedRecord(candidate.record), key)) as T;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_INVALID", "Authority receipt result could not be decrypted.");
  }
}

function normalizeEncryptionKey(value: Buffer | Uint8Array | string): Buffer {
  const key = typeof value === "string" ? Buffer.from(value, "base64url") : Buffer.from(value);
  if (key.length !== 32) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Authority domain encryption key must be exactly 32 bytes.",
    );
  }
  return key;
}

function readAuthorityId(authority: WritableAuthority): string | undefined {
  const candidate = authority as unknown as { authorityId?: unknown };
  return typeof candidate.authorityId === "string" && candidate.authorityId.length > 0
    ? candidate.authorityId
    : undefined;
}

function authorityGenerationIdentity(
  head: AuthorityHead | null,
): AuthorityGenerationIdentity | null {
  return head
    ? {
        authorityId: head.authorityId,
        id: head.id,
        sequence: head.sequence,
        predecessorId: head.predecessorId,
      }
    : null;
}
