import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const DEFAULT_PROJECT_FINGERPRINT = "default";

export type LocalSetupStoreOptions = {
  baseDir?: string;
  now?: () => Date;
  maxAttempts?: number;
  retentionDays?: number;
};

export type LegacySetupMigrationSnapshot = {
  approvals: SetupApproval[];
  attempts: SetupAttempt[];
  sourcePaths: string[];
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
    assertSetupTargetKind(input.targetKind);
    const approval = parseSetupApproval(input);
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
    const parsedAttempt = parseSetupAttempt(attempt);
    const projectFingerprint = parsedAttempt.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT;
    const attempts = this.prunedAttempts([
      ...this.attempts(projectFingerprint, parsedAttempt.capletId),
      { ...parsedAttempt, projectFingerprint },
    ]);
    mkdirSync(this.attemptsDir(projectFingerprint), { recursive: true });
    writeFileSync(
      this.attemptsPath(projectFingerprint, parsedAttempt.capletId),
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

  exportForMigration(): LegacySetupMigrationSnapshot {
    const approvals = this.approvals();
    const sourcePaths = existsSync(this.approvalsPath()) ? [this.approvalsPath()] : [];
    const attempts: SetupAttempt[] = [];
    const projectsRoot = join(this.root, "projects");
    if (existsSync(projectsRoot)) {
      for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const attemptsRoot = join(projectsRoot, project.name, "attempts");
        if (!existsSync(attemptsRoot)) continue;
        for (const entry of readdirSync(attemptsRoot, { withFileTypes: true })
          .filter((candidate) => candidate.name.endsWith(".jsonl"))
          .sort((left, right) => left.name.localeCompare(right.name))) {
          if (!entry.isFile()) {
            throw invalidPersistedSetupState("attempt artifact");
          }
          const path = join(attemptsRoot, entry.name);
          let lines: string[];
          try {
            lines = readFileSync(path, "utf8")
              .split("\n")
              .filter((line) => line.length > 0);
            attempts.push(...lines.map((line) => parseSetupAttempt(JSON.parse(line) as unknown)));
          } catch {
            throw invalidPersistedSetupState("attempt list");
          }
          sourcePaths.push(path);
        }
      }
    }
    assertUniqueSetupSnapshot(approvals, attempts);
    return { approvals, attempts, sourcePaths: sourcePaths.sort() };
  }

  private approvals(): SetupApproval[] {
    const path = this.approvalsPath();
    if (!existsSync(path)) return [];
    const approvals: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(approvals)) throw invalidPersistedSetupState("approval list");
    return approvals.map(parseSetupApproval);
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
      .map((line) => parseSetupAttempt(JSON.parse(line) as unknown));
  }

  private attemptsDir(projectFingerprint: string): string {
    return join(this.root, "projects", safeFileName(projectFingerprint), "attempts");
  }

  private attemptsPath(projectFingerprint: string, capletId: string): string {
    return join(this.attemptsDir(projectFingerprint), `${safeFileName(capletId)}.jsonl`);
  }
}

function assertUniqueSetupSnapshot(approvals: SetupApproval[], attempts: SetupAttempt[]): void {
  const approvalKeys = new Set<string>();
  for (const approval of approvals) {
    const identity = JSON.stringify([
      approval.projectFingerprint,
      approval.capletId,
      approval.contentHash,
      approval.targetKind,
    ]);
    if (approvalKeys.has(identity) || !Number.isFinite(Date.parse(approval.approvedAt))) {
      throw invalidPersistedSetupState("approval list");
    }
    approvalKeys.add(identity);
  }
  const attemptKeys = new Set<string>();
  for (const attempt of attempts) {
    const identity = JSON.stringify([
      attempt.projectFingerprint,
      attempt.capletId,
      attempt.attemptId,
    ]);
    if (
      attemptKeys.has(identity) ||
      !Number.isFinite(Date.parse(attempt.startedAt)) ||
      !Number.isFinite(Date.parse(attempt.finishedAt))
    ) {
      throw invalidPersistedSetupState("attempt list");
    }
    attemptKeys.add(identity);
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function assertSetupTargetKind(value: string): asserts value is SetupTargetKind {
  if (!isSetupTargetKind(value)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host",
    );
  }
}

export function parseSetupApproval(value: unknown): SetupApproval {
  if (
    !isRecord(value) ||
    typeof value.capletId !== "string" ||
    typeof value.contentHash !== "string" ||
    !isSetupTargetKindValue(value.targetKind) ||
    typeof value.approvedAt !== "string" ||
    !isSetupActor(value.actor) ||
    (value.projectFingerprint !== undefined && typeof value.projectFingerprint !== "string")
  ) {
    throw invalidPersistedSetupState("approval");
  }
  return {
    projectFingerprint: value.projectFingerprint ?? DEFAULT_PROJECT_FINGERPRINT,
    capletId: value.capletId,
    contentHash: value.contentHash,
    targetKind: value.targetKind,
    approvedAt: value.approvedAt,
    actor: value.actor,
  };
}

export function parseSetupAttempt(value: unknown): SetupAttempt {
  if (
    !isRecord(value) ||
    typeof value.attemptId !== "string" ||
    typeof value.projectFingerprint !== "string" ||
    typeof value.capletId !== "string" ||
    typeof value.contentHash !== "string" ||
    (value.setupHash !== undefined && typeof value.setupHash !== "string") ||
    !isSetupTargetKindValue(value.targetKind) ||
    !isRuntimeFeatures(value.runtimeFeatures) ||
    !isSetupActor(value.actor) ||
    !isSetupAttemptStatus(value.status) ||
    (value.phase !== "commands" && value.phase !== "verify") ||
    typeof value.commandLabel !== "string" ||
    !isStringArray(value.argv) ||
    (value.exitCode !== undefined && typeof value.exitCode !== "number") ||
    (value.signal !== undefined && typeof value.signal !== "string") ||
    typeof value.durationMs !== "number" ||
    typeof value.startedAt !== "string" ||
    typeof value.finishedAt !== "string" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.redacted !== "boolean" ||
    !isRetention(value.retention)
  ) {
    throw invalidPersistedSetupState("attempt");
  }
  return {
    attemptId: value.attemptId,
    projectFingerprint: value.projectFingerprint,
    capletId: value.capletId,
    contentHash: value.contentHash,
    ...(value.setupHash === undefined ? {} : { setupHash: value.setupHash }),
    targetKind: value.targetKind,
    ...(value.runtimeFeatures === undefined ? {} : { runtimeFeatures: value.runtimeFeatures }),
    actor: value.actor,
    status: value.status,
    phase: value.phase,
    commandLabel: value.commandLabel,
    argv: value.argv,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    durationMs: value.durationMs,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    stdout: value.stdout,
    stderr: value.stderr,
    redacted: value.redacted,
    retention: value.retention,
  };
}

function isSetupTargetKindValue(value: unknown): value is SetupTargetKind {
  return typeof value === "string" && isSetupTargetKind(value);
}

function isSetupActor(value: unknown): value is SetupApproval["actor"] {
  return (
    value === "cli-interactive" || value === "cli-yes" || value === "ui" || value === "automation"
  );
}

function isSetupAttemptStatus(value: unknown): value is SetupAttempt["status"] {
  return value === "running" || value === "succeeded" || value === "failed";
}

function isRuntimeFeatures(value: unknown): value is SetupAttempt["runtimeFeatures"] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((feature) => feature === "docker" || feature === "browser"))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRetention(value: unknown): value is SetupAttempt["retention"] {
  return isRecord(value) && typeof value.maxAttempts === "number" && typeof value.days === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPersistedSetupState(kind: string): CapletsError {
  return new CapletsError("INTERNAL_ERROR", `Persisted setup ${kind} is invalid.`);
}
