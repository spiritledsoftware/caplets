import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCacheBaseDir } from "../config/paths";
import type { SetupApproval, SetupAttempt, SetupTargetKind } from "./types";

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
  ): Promise<SetupApproval | undefined> {
    return this.approvals().find(
      (approval) =>
        approval.capletId === capletId &&
        approval.contentHash === contentHash &&
        approval.targetKind === targetKind,
    );
  }

  async approve(approval: SetupApproval): Promise<SetupApproval> {
    const approvals = this.approvals().filter(
      (existing) =>
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
    const attempts = this.prunedAttempts([...this.attempts(attempt.capletId), attempt]);
    mkdirSync(join(this.root, "attempts"), { recursive: true });
    writeFileSync(
      this.attemptsPath(attempt.capletId),
      attempts.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      { mode: 0o600 },
    );
  }

  async listAttempts(capletId: string): Promise<SetupAttempt[]> {
    return this.attempts(capletId);
  }

  retention(): { maxAttempts: number; days: number } {
    return { maxAttempts: this.maxAttempts, days: this.retentionDays };
  }

  private approvals(): SetupApproval[] {
    const path = this.approvalsPath();
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8")) as SetupApproval[];
  }

  private attempts(capletId: string): SetupAttempt[] {
    const path = this.attemptsPath(capletId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SetupAttempt);
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

  private attemptsPath(capletId: string): string {
    return join(this.root, "attempts", `${safeFileName(capletId)}.jsonl`);
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}
