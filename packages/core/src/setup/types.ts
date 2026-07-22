import type { CapletSetupCommandConfig, CapletSetupConfig } from "../config";
import type { RuntimeFeature } from "../config-runtime";

export const setupTargetKinds = ["local_host", "remote_host"] as const;

export type SetupTargetKind = (typeof setupTargetKinds)[number];
export type SetupActor = "cli-interactive" | "cli-yes" | "ui" | "automation";
export type SetupAttemptStatus = "running" | "succeeded" | "failed";

export type SetupApproval = {
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  approvedAt: string;
  actor: SetupActor;
};

export type SetupAttempt = {
  attemptId: string;
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  setupHash?: string | undefined;
  targetKind: SetupTargetKind;
  runtimeFeatures?: RuntimeFeature[] | undefined;
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
  projectFingerprint: string;
  capletId: string;
  name: string;
  contentHash: string;
  targetKind: SetupTargetKind;
  setup: CapletSetupConfig;
  approved: boolean;
  persistenceEligible: boolean;
  commands: CapletSetupCommandConfig[];
  verify: CapletSetupCommandConfig[];
};

export function isSetupTargetKind(value: string): value is SetupTargetKind {
  return value === "local_host" || value === "remote_host";
}
