import type { ProcessResult } from "./live-agent.mjs";

export declare const DEFAULT_VALIDATION_TIMEOUT_MS: number;

export interface BenchmarkTask {
  id?: string;
  validationCommand?: string;
  hiddenValidator?: string;
  hiddenValidationCommand?: string;
}

export interface ValidationResult {
  success: boolean;
  skipped?: boolean;
  command?: string;
  args?: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface TranscriptMetrics {
  transcriptBytes: number;
  approxTokenProxy: number;
  toolCallCount: number;
  failedCallCount: number;
  irrelevantCallCount: number;
}

export function createTempWorkspaceFromFixture(fixtureWorkspaceRoot: string): Promise<string>;

export function resolveInside(root: string, relativePath: string): string;

export function scoreTaskRun(options: {
  task: BenchmarkTask;
  candidateWorkspace: string;
  fixtureRoot?: string;
  agentResult?: Partial<ProcessResult>;
  validationTimeoutMs?: number;
}): Promise<{
  taskId?: string;
  success: boolean;
  validation: ValidationResult;
  hiddenValidation: ValidationResult;
  process?: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    durationMs?: number;
    command?: string;
    args?: string[];
    envKeys?: string[];
    skipped?: boolean;
    unavailable?: boolean;
    configConflict?: boolean;
  };
  finalStateValid: boolean;
  processSuccess: boolean;
  metrics: TranscriptMetrics;
}>;

export function transcriptMetrics(options?: {
  transcript?: string;
  transcriptBytes?: number;
  events?: unknown[];
}): TranscriptMetrics;

export function countToolCalls(events?: unknown[]): number;
export function countFailedCalls(events?: unknown[]): number;
export function countIrrelevantCalls(events?: unknown[]): number;
