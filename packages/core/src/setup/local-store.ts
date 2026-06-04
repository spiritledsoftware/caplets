import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCacheBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import {
  isSetupTargetKind,
  type SetupApproval,
  type SetupAttempt,
  type SetupTargetKind,
} from "./types";

type SetupApprovalInput = Omit<SetupApproval, "projectFingerprint"> & {
  projectFingerprint?: string | undefined;
};

const DEFAULT_PROJECT_FINGERPRINT = "default";

export type LocalSetupStoreOptions = {
  baseDir?: string;
  now?: () => Date;
  maxAttempts?: number;
  retentionDays?: number;
};

export class LocalSetupStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retentionDays: number;

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
