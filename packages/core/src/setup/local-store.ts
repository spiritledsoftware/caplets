import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultCacheBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import {
  isSetupTargetKind,
  type SetupApproval,
  type SetupAttempt,
  type SetupTargetKind,
} from "./types";

export type SetupApprovalInput = Omit<SetupApproval, "projectFingerprint"> & {
  projectFingerprint?: string | undefined;
};

export type SetupSnapshotToken = Readonly<{
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
}>;

export type SetupExecutionRequest = Readonly<{
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  setupHash?: string | undefined;
  targetKind: SetupTargetKind;
  ttlMs: number;
  snapshotToken?: SetupSnapshotToken | undefined;
}>;

export type SetupExecutionLease = Readonly<
  SetupExecutionRequest & {
    executionId: string;
    leaseId: string;
    expiresAt: string;
  }
>;
const DEFAULT_PROJECT_FINGERPRINT = "default";

export type LegacyLocalSetupState = Readonly<{
  root: string;
  approvals: readonly SetupApproval[];
  attempts: readonly SetupAttempt[];
}>;

export function readLegacyLocalSetupState(
  options: {
    root?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {},
): LegacyLocalSetupState | undefined {
  const root = options.root ?? join(defaultCacheBaseDir(options.env), "caplets", "setup");
  if (!existsSync(root)) return undefined;
  const approvalsPath = join(root, "approvals.json");
  const approvals = existsSync(approvalsPath)
    ? (JSON.parse(readFileSync(approvalsPath, "utf8")) as SetupApprovalInput[]).map((approval) => ({
        ...approval,
        projectFingerprint: approval.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
      }))
    : [];
  const attempts: SetupAttempt[] = [];
  const projectsRoot = join(root, "projects");
  if (existsSync(projectsRoot)) {
    for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const attemptsRoot = join(projectsRoot, project.name, "attempts");
      if (!existsSync(attemptsRoot)) continue;
      for (const file of readdirSync(attemptsRoot, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        for (const line of readFileSync(join(attemptsRoot, file.name), "utf8")
          .split("\n")
          .filter(Boolean)) {
          attempts.push(JSON.parse(line) as SetupAttempt);
        }
      }
    }
  }
  for (const approval of approvals) assertSetupTargetKind(approval.targetKind);
  for (const attempt of attempts) assertSetupTargetKind(attempt.targetKind);
  return { root, approvals, attempts };
}

export function removeMigratedLegacyLocalSetupState(state: LegacyLocalSetupState): void {
  rmSync(state.root, { recursive: true, force: true });
}

export type LocalSetupStoreOptions = {
  baseDir?: string;
  now?: () => Date;
  maxAttempts?: number;
  retentionDays?: number;
};
export interface SetupStore {
  getApproval(
    projectFingerprint: string,
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<SetupApproval | undefined>;
  approve(input: SetupApprovalInput): Promise<SetupApproval>;
  reserveExecution(input: SetupExecutionRequest): Promise<SetupExecutionLease>;
  renewExecution(lease: SetupExecutionLease, ttlMs: number): Promise<SetupExecutionLease>;
  releaseExecution(lease: SetupExecutionLease): Promise<void>;
  recordAttempt(attempt: SetupAttempt, lease?: SetupExecutionLease): Promise<void>;
  listAttempts(projectFingerprint: string, capletId: string): Promise<SetupAttempt[]>;
  pruneAttempts(projectFingerprint: string, capletId: string): Promise<void>;
  retention(): { maxAttempts: number; days: number };
}

export class LocalSetupStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retentionDays: number;

  private readonly executions = new Map<string, SetupExecutionLease>();
  constructor(options: LocalSetupStoreOptions = {}) {
    this.root = options.baseDir ?? join(defaultCacheBaseDir(), "caplets", "setup");
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retentionDays = options.retentionDays ?? 7;
  }

  async getApproval(
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<SetupApproval | undefined>;
  async getApproval(
    projectFingerprint: string,
    capletId: string,
    contentHash: string,
    targetKind: SetupTargetKind,
  ): Promise<SetupApproval | undefined>;
  async getApproval(
    ...args: [string, string, SetupTargetKind] | [string, string, string, SetupTargetKind]
  ) {
    const [projectFingerprint, capletId, contentHash, targetKind] =
      args.length === 3 ? [DEFAULT_PROJECT_FINGERPRINT, args[0], args[1], args[2]] : args;
    assertSetupTargetKind(targetKind);
    return this.approvals().find(
      (approval) =>
        approval.projectFingerprint === projectFingerprint &&
        approval.capletId === capletId &&
        approval.contentHash === contentHash &&
        approval.targetKind === targetKind,
    );
  }

  async approve(input: SetupApprovalInput): Promise<SetupApproval> {
    const approval = {
      ...input,
      projectFingerprint: input.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
    };
    assertSetupTargetKind(approval.targetKind);
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

  async reserveExecution(input: SetupExecutionRequest): Promise<SetupExecutionLease> {
    assertSetupLeaseTtl(input.ttlMs);
    const executionId = setupExecutionKey(input);
    const current = this.executions.get(executionId);
    if (current && Date.parse(current.expiresAt) > this.now().getTime()) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Setup execution is already reserved.");
    }
    const lease = {
      ...input,
      executionId,
      leaseId: randomUUID(),
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
    this.executions.set(executionId, lease);
    return lease;
  }

  async renewExecution(lease: SetupExecutionLease, ttlMs: number): Promise<SetupExecutionLease> {
    assertSetupLeaseTtl(ttlMs);
    const current = this.executions.get(lease.executionId);
    if (
      !current ||
      current.leaseId !== lease.leaseId ||
      Date.parse(current.expiresAt) <= this.now().getTime()
    ) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Setup execution reservation is unavailable.");
    }
    const renewed = {
      ...current,
      ttlMs,
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
    };
    this.executions.set(lease.executionId, renewed);
    return renewed;
  }

  async releaseExecution(lease: SetupExecutionLease): Promise<void> {
    const current = this.executions.get(lease.executionId);
    if (current?.leaseId === lease.leaseId) this.executions.delete(lease.executionId);
  }

  async recordAttempt(attempt: SetupAttempt, _lease?: SetupExecutionLease): Promise<void> {
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

  async pruneAttempts(projectFingerprint: string, capletId: string): Promise<void> {
    const attempts = this.prunedAttempts(this.attempts(projectFingerprint, capletId));
    if (attempts.length === 0 && !existsSync(this.attemptsPath(projectFingerprint, capletId)))
      return;
    mkdirSync(this.attemptsDir(projectFingerprint), { recursive: true });
    writeFileSync(
      this.attemptsPath(projectFingerprint, capletId),
      attempts.map((entry) => JSON.stringify(entry)).join("\n") + (attempts.length ? "\n" : ""),
      { mode: 0o600 },
    );
  }

  retention(): { maxAttempts: number; days: number } {
    return { maxAttempts: this.maxAttempts, days: this.retentionDays };
  }

  private approvals(): SetupApproval[] {
    const path = this.approvalsPath();
    if (!existsSync(path)) return [];
    const approvals = JSON.parse(readFileSync(path, "utf8")) as SetupApprovalInput[];
    return approvals.map((approval) => ({
      ...approval,
      projectFingerprint: approval.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
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

function setupExecutionKey(input: SetupExecutionRequest): string {
  return [
    input.projectFingerprint,
    input.capletId,
    input.contentHash,
    input.setupHash ?? "",
    input.targetKind,
  ].join("\u0000");
}

function assertSetupLeaseTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Setup execution lease duration is outside safe bounds.",
    );
  }
}
