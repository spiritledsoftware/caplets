import type { CapletSetupCommandConfig, CapletSetupConfig } from "../config";

export type SetupTargetKind = "local" | "remote" | "cloud";
export type SetupActor = "cli-interactive" | "cli-yes" | "ui" | "automation";
export type SetupAttemptStatus = "running" | "succeeded" | "failed";

export type SetupApproval = {
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  approvedAt: string;
  actor: SetupActor;
};

export type SetupAttempt = {
  attemptId: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  actor: SetupActor;
  status: SetupAttemptStatus;
  phase: "commands" | "verify";
  commandLabel: string;
  argv: string[];
  exitCode?: number | undefined;
  signal?: string | undefined;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
  redacted: boolean;
  retention: {
    maxAttempts: number;
    days: number;
  };
};

export type SetupPlan = {
  capletId: string;
  name: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  setup: CapletSetupConfig;
  approved: boolean;
  commands: CapletSetupCommandConfig[];
  verify: CapletSetupCommandConfig[];
};
