import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCacheBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../storage/types";
import {
  isSetupTargetKind,
  type SetupActor,
  type SetupApproval,
  type SetupAttempt,
  type SetupTargetKind,
} from "./types";

type SetupApprovalInput = Omit<SetupApproval, "projectFingerprint"> & {
  projectFingerprint?: string | undefined;
};

export type SetupApprovalDecision = "grant" | "deny" | "revoke";

export type StoredSetupApproval = SetupApproval & {
  decision?: SetupApprovalDecision;
  generation?: AuthorityGenerationIdentity;
};

export type SetupApprovalMutation = Omit<SetupApprovalInput, "approvedAt"> & {
  decision?: SetupApprovalDecision;
  approvedAt?: string | undefined;
  expectedGeneration?: AuthorityGenerationIdentity | null | undefined;
  idempotencyKey?: string | undefined;
};

export type SetupAuthoritySnapshot = {
  setupApprovals: Record<string, StoredSetupApproval>;
  setupActivity: SetupActivity[];
  [key: string]: unknown;
};

export type SetupActivity = {
  kind: "setup_approval";
  decision: SetupApprovalDecision;
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  actor: SetupActor;
  occurredAt: string;
  expectedGeneration: AuthorityGenerationIdentity | null;
};

export type SetupApprovalAuthority = Pick<
  WritableAuthority<unknown, unknown>,
  "readHead" | "readGeneration" | "commit"
> & {
  authorityId?: string | undefined;
};

const DEFAULT_PROJECT_FINGERPRINT = "default";
const DEFAULT_AUTHORITY_ID = "setup";
const DEFAULT_HOST_ID = "setup-client";
const DEFAULT_PRINCIPAL_ID = "setup-client";

/** Setup approvals are shared; attempts intentionally remain replica-local. */
export const setupOwnership = {
  approval: "authority",
  activity: "authority",
  attempts: "replica-local",
  cloudAuth: "client-local",
  liveSessions: "replica-local",
  journals: "replica-local",
  logs: "replica-local",
  caches: "replica-local",
  temp: "replica-local",
} as const;

export type LocalSetupStoreOptions = {
  baseDir?: string;
  now?: () => Date;
  maxAttempts?: number;
  retentionDays?: number;
  authority?: SetupApprovalAuthority | undefined;
  authorityId?: string | undefined;
  currentHostId?: string | undefined;
  principalId?: string | undefined;
};

export class LocalSetupStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retentionDays: number;
  private readonly authority: SetupApprovalAuthority | undefined;
  private readonly authorityId: string;
  private readonly currentHostId: string;
  private readonly principalId: string;

  constructor(options: LocalSetupStoreOptions = {}) {
    this.root = options.baseDir ?? join(defaultCacheBaseDir(), "caplets", "setup");
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retentionDays = options.retentionDays ?? 7;
    this.authority = options.authority;
    this.authorityId =
      options.authorityId ?? options.authority?.authorityId ?? DEFAULT_AUTHORITY_ID;
    this.currentHostId = options.currentHostId ?? DEFAULT_HOST_ID;
    this.principalId = options.principalId ?? DEFAULT_PRINCIPAL_ID;
  }

  async getApproval(
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<StoredSetupApproval | undefined>;
  async getApproval(
    projectFingerprint: string,
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<StoredSetupApproval | undefined>;
  async getApproval(
    ...args: [string, string, SetupTargetKind] | [string, string, string, SetupTargetKind]
  ): Promise<StoredSetupApproval | undefined> {
    const [projectFingerprint, capletId, contentHash, targetKind] =
      args.length === 3 ? [DEFAULT_PROJECT_FINGERPRINT, args[0], args[1], args[2]] : args;
    assertSetupTargetKind(targetKind);
    if (this.authority) {
      const generation = await this.readAuthorityGeneration();
      if (!generation) return undefined;
      const snapshot = authoritySnapshot(generation.snapshot);
      const approval =
        snapshot.setupApprovals[approvalKey(projectFingerprint, capletId, contentHash, targetKind)];
      return approval
        ? {
            ...approval,
            decision: approval.decision ?? "grant",
            generation: generationIdentity(generation),
          }
        : undefined;
    }
    return this.approvals().find(
      (approval) =>
        approval.projectFingerprint === projectFingerprint &&
        approval.capletId === capletId &&
        approval.contentHash === contentHash &&
        approval.targetKind === targetKind,
    );
  }

  async approve(input: SetupApprovalInput): Promise<StoredSetupApproval> {
    return await this.mutateApproval({ ...input, decision: "grant" });
  }

  async grant(input: SetupApprovalMutation): Promise<StoredSetupApproval> {
    return await this.mutateApproval({ ...input, decision: "grant" });
  }

  async deny(input: SetupApprovalMutation): Promise<StoredSetupApproval> {
    return await this.mutateApproval({ ...input, decision: "deny" });
  }

  async revoke(input: SetupApprovalMutation): Promise<StoredSetupApproval> {
    return await this.mutateApproval({ ...input, decision: "revoke" });
  }

  async recordAttempt(attempt: SetupAttempt): Promise<void> {
    assertSetupTargetKind(attempt.targetKind);
    const projectFingerprint = attempt.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT;
    const attempts = this.prunedAttempts([
      ...this.attempts(projectFingerprint, attempt.capletId),
      { ...attempt, projectFingerprint },
    ]);
    mkdirSync(this.attemptsDir(projectFingerprint), { recursive: true });
    writeFileSync(
      this.attemptsPath(projectFingerprint, attempt.capletId),
      attempts.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      { mode: 0o600 },
    );
  }

  async listAttempts(capletId: string): Promise<SetupAttempt[]>;
  async listAttempts(projectFingerprint: string, capletId: string): Promise<SetupAttempt[]>;
  async listAttempts(...args: [string] | [string, string]): Promise<SetupAttempt[]> {
    const [projectFingerprint, capletId] =
      args.length === 1 ? [DEFAULT_PROJECT_FINGERPRINT, args[0]] : args;
    return this.attempts(projectFingerprint, capletId);
  }

  retention(): { maxAttempts: number; days: number } {
    return { maxAttempts: this.maxAttempts, days: this.retentionDays };
  }

  private async mutateApproval(input: SetupApprovalMutation): Promise<StoredSetupApproval> {
    const { expectedGeneration, idempotencyKey, decision, ...approvalInput } = input;
    const approval = {
      ...approvalInput,
      projectFingerprint: input.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
      decision: decision ?? "grant",
      approvedAt: input.approvedAt ?? this.now().toISOString(),
    } as StoredSetupApproval;
    assertSetupTargetKind(approval.targetKind);
    if (!this.authority) {
      const approvals = this.approvals().filter(
        (existing) =>
          existing.projectFingerprint !== approval.projectFingerprint ||
          existing.capletId !== approval.capletId ||
          existing.contentHash !== approval.contentHash ||
          existing.targetKind !== approval.targetKind,
      );
      approvals.push(approval);
      mkdirSync(this.root, { recursive: true });
      writeFileSync(this.approvalsPath(), `${JSON.stringify(approvals, null, 2)}\n`, {
        mode: 0o600,
      });
      return approval;
    }

    const active = await this.readAuthorityGeneration();
    const previousSnapshot = authoritySnapshot(active?.snapshot);
    const key = approvalKey(
      approval.projectFingerprint,
      approval.capletId,
      approval.contentHash,
      approval.targetKind,
    );
    const occurredAt = this.now().toISOString();
    const nextApproval: StoredSetupApproval = {
      ...approval,
      ...(expectedGeneration === undefined && !active
        ? {}
        : expectedGeneration === undefined && active
          ? { generation: generationIdentity(active) }
          : expectedGeneration
            ? { generation: expectedGeneration }
            : {}),
    };
    const nextSnapshot: SetupAuthoritySnapshot = {
      ...previousSnapshot,
      setupApprovals: { ...previousSnapshot.setupApprovals, [key]: nextApproval },
      setupActivity: [
        ...previousSnapshot.setupActivity,
        {
          kind: "setup_approval",
          decision: approval.decision ?? "grant",
          projectFingerprint: approval.projectFingerprint,
          capletId: approval.capletId,
          contentHash: approval.contentHash,
          targetKind: approval.targetKind,
          actor: approval.actor,
          expectedGeneration:
            expectedGeneration === undefined && active
              ? generationIdentity(active)
              : (expectedGeneration ?? null),
          occurredAt,
        },
      ],
    };
    const snapshotCommand = {
      ...nextSnapshot,
      caplets: isRecord(previousSnapshot.caplets) ? previousSnapshot.caplets : {},
    };
    const command = { kind: "replace_snapshot", snapshot: snapshotCommand };
    const envelope: SemanticCommandEnvelope<unknown> = {
      authorityId: this.authorityId,
      currentHostId: this.currentHostId,
      principalId: this.principalId,
      expectedGeneration:
        expectedGeneration === undefined && active
          ? generationIdentity(active)
          : (expectedGeneration ?? null),
      idempotencyKey: idempotencyKey ?? randomUUID(),
      requestDigest: digestRequest({
        decision: approval.decision,
        key,
        contentHash: approval.contentHash,
        expectedGeneration:
          expectedGeneration === undefined && active
            ? generationIdentity(active)
            : (expectedGeneration ?? null),
      }),
      command,
    };
    const committed = await this.authority.commit<StoredSetupApproval>(envelope);
    if (committed.kind === "conflict") {
      throw new CapletsError("REQUEST_INVALID", "Setup approval generation is stale", {
        activeGeneration: committed.active,
      });
    }
    if (committed.kind === "rate_limited" || committed.kind === "quota_exhausted") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Setup approval authority is temporarily unavailable",
        {
          retryAfterMs: committed.retryAfterMs,
        },
      );
    }
    if (committed.kind !== "committed" && committed.kind !== "replayed") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Setup approval authority returned an invalid result",
      );
    }
    const generation = committed.generation;
    return { ...nextApproval, generation };
  }

  private async readAuthorityGeneration(): Promise<AuthorityGeneration<unknown> | undefined> {
    if (!this.authority) return undefined;
    const head = await this.authority.readHead();
    if (!head) return undefined;
    return await this.authority.readGeneration(head.id);
  }

  private approvals(): StoredSetupApproval[] {
    const path = this.approvalsPath();
    if (!existsSync(path)) return [];
    const approvals = JSON.parse(readFileSync(path, "utf8")) as SetupApprovalInput[];
    return approvals.map((approval) => ({
      ...approval,
      projectFingerprint: approval.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
      decision: (approval as StoredSetupApproval).decision ?? "grant",
    }));
  }

  private prunedAttempts(attempts: SetupAttempt[]): SetupAttempt[] {
    const cutoffMs = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    return attempts
      .filter((attempt) => new Date(attempt.finishedAt).getTime() >= cutoffMs)
      .slice(-this.maxAttempts);
  }

  private approvalsPath(): string {
    return join(this.root, "approvals.json");
  }

  private attempts(projectFingerprint: string, capletId: string): SetupAttempt[] {
    const path = this.attemptsPath(projectFingerprint, capletId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SetupAttempt);
  }

  private attemptsDir(projectFingerprint: string): string {
    return join(this.root, "projects", safeFileName(projectFingerprint), "attempts");
  }

  private attemptsPath(projectFingerprint: string, capletId: string): string {
    return join(this.attemptsDir(projectFingerprint), `${safeFileName(capletId)}.jsonl`);
  }
}

function authoritySnapshot(value: unknown): SetupAuthoritySnapshot {
  if (!isRecord(value)) return { setupApprovals: {}, setupActivity: [] };
  const setupApprovals = isRecord(value.setupApprovals) ? value.setupApprovals : {};
  const setupActivity = Array.isArray(value.setupActivity) ? value.setupActivity : [];
  return {
    ...value,
    setupApprovals: setupApprovals as Record<string, StoredSetupApproval>,
    setupActivity: setupActivity as SetupActivity[],
  };
}

function approvalKey(
  projectFingerprint: string,
  capletId: string,
  contentHash: string,
  targetKind: SetupTargetKind,
): string {
  return [projectFingerprint, capletId, contentHash, targetKind]
    .map((value) => encodeURIComponent(value))
    .join("/");
}

function generationIdentity(generation: AuthorityGeneration<unknown>): AuthorityGenerationIdentity {
  return {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
}

function digestRequest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function assertSetupTargetKind(value: string): asserts value is SetupTargetKind {
  if (!isSetupTargetKind(value)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host, hosted_sandbox",
    );
  }
}
