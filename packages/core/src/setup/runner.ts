import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { CapletSetupCommandConfig, CapletSetupConfig } from "../config";
import type { RuntimeFeature } from "../config-runtime";
import { CapletsError } from "../errors";
import { redactSecretText } from "../redaction";
import type { SetupExecutionLease, SetupSnapshotToken, SetupStore } from "./local-store";
import {
  isSetupTargetKind,
  type SetupActor,
  type SetupAttempt,
  type SetupTargetKind,
} from "./types";

export type SpawnResult = {
  exitCode?: number | undefined;
  signal?: string | undefined;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type SetupSpawnOptions = {
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
};

export type SetupSpawn = (
  command: string,
  args: string[],
  options: SetupSpawnOptions,
) => Promise<SpawnResult>;

export type RunCapletSetupOptions = {
  projectFingerprint?: string;
  capletId: string;
  contentHash: string;
  setupHash?: string | undefined;
  targetKind: SetupTargetKind;
  runtimeFeatures?: RuntimeFeature[] | undefined;
  projectBindingRequired?: boolean | undefined;
  projectWorkspacePath?: string | undefined;
  setup: CapletSetupConfig;
  actor: SetupActor;
  approved: boolean;
  snapshotToken?: SetupSnapshotToken | undefined;
  store: Pick<
    SetupStore,
    "recordAttempt" | "releaseExecution" | "renewExecution" | "reserveExecution" | "retention"
  >;
  spawn?: SetupSpawn;
  signal?: AbortSignal | undefined;
  now?: () => Date;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const MAX_LEASE_RENEWAL_INTERVAL_MS = 30_000;
const MIN_LEASE_RENEWAL_INTERVAL_MS = 1_000;
const PROCESS_KILL_GRACE_MS = 2_000;

export async function runCapletSetup(options: RunCapletSetupOptions): Promise<SetupAttempt[]> {
  assertSetupTargetKind(options.targetKind);
  if (!options.approved) {
    throw new CapletsError("REQUEST_INVALID", "Setup approval is required before commands run");
  }
  options.signal?.throwIfAborted();

  const attempts: SetupAttempt[] = [];
  const commands = options.setup.commands ?? [];
  const verify = options.setup.verify ?? [];
  const steps = [
    ...commands.map((command) => ({ phase: "commands" as const, command })),
    ...verify.map((command) => ({ phase: "verify" as const, command })),
  ];
  if (steps.length === 0) return attempts;
  let lease: SetupExecutionLease = await options.store.reserveExecution({
    projectFingerprint: options.projectFingerprint ?? "default",
    capletId: options.capletId,
    contentHash: options.contentHash,
    setupHash: options.setupHash,
    snapshotToken: options.snapshotToken,
    targetKind: options.targetKind,
    ttlMs: setupLeaseTtl(steps[0]!.command),
  });
  let operationFailed = false;
  let operationError: unknown;
  try {
    for (const { phase, command } of steps) {
      const ttlMs = setupLeaseTtl(command);
      lease = await options.store.renewExecution(lease, ttlMs);
      const execution = await runLeasedSetupCommand(options, phase, command, lease, ttlMs);
      lease = execution.lease;
      attempts.push(execution.attempt);
      let finalizeFailed = false;
      let finalizeError: unknown;
      try {
        await options.store.recordAttempt(execution.attempt, lease);
      } catch (error) {
        finalizeFailed = true;
        finalizeError = error;
      }
      if (execution.interruption !== undefined) throw execution.interruption;
      if (finalizeFailed) throw finalizeError;
      if (execution.attempt.status !== "succeeded") break;
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await options.store.releaseExecution(lease);
  } catch (error) {
    if (!operationFailed) {
      operationFailed = true;
      operationError = error;
    }
  }
  if (operationFailed) throw operationError;
  return attempts;
}

type LeasedSetupCommandResult = {
  attempt: SetupAttempt;
  lease: SetupExecutionLease;
  interruption?: unknown;
};

async function runLeasedSetupCommand(
  options: RunCapletSetupOptions,
  phase: "commands" | "verify",
  command: CapletSetupCommandConfig,
  initialLease: SetupExecutionLease,
  ttlMs: number,
): Promise<LeasedSetupCommandResult> {
  const controller = new AbortController();
  let lease = initialLease;
  let interruption: unknown;
  let stopped = false;
  let renewalTimer: NodeJS.Timeout | undefined;
  let renewalInFlight: Promise<void> | undefined;
  const interrupt = (reason: unknown) => {
    if (controller.signal.aborted) return;
    interruption = reason ?? setupInterruptedError();
    clearTimeout(renewalTimer);
    controller.abort(interruption);
  };
  const callerAbort = () => interrupt(options.signal?.reason);
  if (options.signal?.aborted) callerAbort();
  else options.signal?.addEventListener("abort", callerAbort, { once: true });

  const scheduleRenewal = () => {
    renewalTimer = setTimeout(() => {
      if (stopped || controller.signal.aborted) return;
      renewalInFlight = (async () => {
        try {
          lease = await options.store.renewExecution(lease, ttlMs);
          if (!stopped && !controller.signal.aborted) scheduleRenewal();
        } catch (error) {
          interrupt(error);
        }
      })();
    }, setupLeaseRenewalInterval(ttlMs));
    renewalTimer.unref?.();
  };

  const commandPromise = runSetupCommand(options, phase, command, controller.signal);
  if (!controller.signal.aborted) scheduleRenewal();
  let attempt: SetupAttempt;
  try {
    attempt = await commandPromise;
  } finally {
    stopped = true;
    clearTimeout(renewalTimer);
    await renewalInFlight;
    options.signal?.removeEventListener("abort", callerAbort);
  }
  if (controller.signal.aborted) attempt = interruptedSetupAttempt(attempt);
  return {
    attempt,
    lease,
    ...(interruption === undefined ? {} : { interruption }),
  };
}

async function runSetupCommand(
  options: RunCapletSetupOptions,
  phase: "commands" | "verify",
  command: CapletSetupCommandConfig,
  signal: AbortSignal,
): Promise<SetupAttempt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const argv = [command.command, ...(command.args ?? [])].map(() => "[REDACTED]");
  const env = {
    ...process.env,
    ...command.env,
  };
  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cwd = resolveCwd(command.cwd);
  assertProjectWorkspaceSetupAllowed({
    cwd,
    projectBindingRequired: options.projectBindingRequired === true,
    projectWorkspacePath: options.projectWorkspacePath,
  });
  const spawnImpl = options.spawn ?? spawnCommand;
  let result: SpawnResult;
  if (signal.aborted) {
    result = interruptedSpawnResult(now().getTime() - startedAt.getTime());
  } else {
    try {
      result = await spawnImpl(command.command, command.args ?? [], {
        cwd,
        env,
        timeoutMs,
        maxOutputBytes,
        signal,
      });
    } catch (error) {
      if (!signal.aborted) throw error;
      result = interruptedSpawnResult(now().getTime() - startedAt.getTime());
    }
  }
  const finishedAt = now();
  const outputSecrets = [
    ...(command.args ?? []),
    ...Object.values(command.env ?? {}).filter((value) => value.length > 0),
  ];
  const stdout = redactOutput(result.stdout, outputSecrets);
  const stderr = redactOutput(result.stderr, outputSecrets);
  return {
    attemptId: randomUUID(),
    projectFingerprint: options.projectFingerprint ?? "default",
    capletId: options.capletId,
    contentHash: options.contentHash,
    ...(options.setupHash === undefined ? {} : { setupHash: options.setupHash }),
    targetKind: options.targetKind,
    ...(options.runtimeFeatures === undefined ? {} : { runtimeFeatures: options.runtimeFeatures }),
    actor: options.actor,
    status: result.exitCode === 0 && !result.signal ? "succeeded" : "failed",
    phase,
    commandLabel: command.label,
    argv,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    durationMs: result.durationMs,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stdout: capBytes(stdout.text, maxOutputBytes),
    stderr: capBytes(stderr.text, maxOutputBytes),
    redacted: true,
    retention: options.store.retention(),
  };
}

function assertProjectWorkspaceSetupAllowed(input: {
  cwd?: string | undefined;
  projectBindingRequired: boolean;
  projectWorkspacePath?: string | undefined;
}): void {
  if (input.projectBindingRequired || !input.cwd || !input.projectWorkspacePath) return;
  const workspacePath = resolve(input.projectWorkspacePath);
  const cwd = resolve(input.cwd);
  if (cwd === workspacePath || cwd.startsWith(`${workspacePath}/`)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Non-project setup cannot run inside project workspace without projectBinding.required",
    );
  }
}

export async function spawnCommand(
  command: string,
  args: string[],
  options: SetupSpawnOptions,
): Promise<SpawnResult> {
  const startedAt = Date.now();
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<SpawnResult>();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = { stdout: "", stderr: "" };
  let settled = false;
  let graceTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null || graceTimer) return;
    killProcessTree(child, "SIGTERM");
    graceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killProcessTree(child, "SIGKILL");
      }
    }, PROCESS_KILL_GRACE_MS);
    graceTimer.unref?.();
  };
  const timeoutTimer = setTimeout(terminate, options.timeoutMs);
  timeoutTimer.unref?.();
  const cleanup = () => {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    options.signal.removeEventListener("abort", terminate);
  };
  options.signal.addEventListener("abort", terminate, { once: true });
  if (options.signal.aborted) terminate();
  child.on("error", (error) => {
    cleanup();
    if (settled) return;
    settled = true;
    reject(error);
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    chunks.stdout = capBytes(chunks.stdout + chunk, options.maxOutputBytes);
  });
  child.stderr?.on("data", (chunk) => {
    chunks.stderr = capBytes(chunks.stderr + chunk, options.maxOutputBytes);
  });
  child.on("close", (exitCode, signal) => {
    cleanup();
    if (settled) return;
    settled = true;
    resolvePromise({
      exitCode: exitCode ?? undefined,
      signal: signal ?? undefined,
      stdout: chunks.stdout,
      stderr: chunks.stderr,
      durationMs: Date.now() - startedAt,
    });
  });
  return await promise;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => {
      child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function resolveCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (!isAbsolute(cwd)) {
    throw new CapletsError("CONFIG_INVALID", "Setup command cwd must be absolute");
  }
  return resolve(cwd);
}

function setupLeaseTtl(command: CapletSetupCommandConfig): number {
  return Math.min(24 * 60 * 60_000, (command.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000);
}

function setupLeaseRenewalInterval(ttlMs: number): number {
  return Math.min(
    MAX_LEASE_RENEWAL_INTERVAL_MS,
    Math.max(MIN_LEASE_RENEWAL_INTERVAL_MS, Math.floor(ttlMs / 3)),
  );
}

function interruptedSetupAttempt(attempt: SetupAttempt): SetupAttempt {
  return {
    ...attempt,
    status: "failed",
    exitCode: undefined,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    redacted: true,
  };
}

function interruptedSpawnResult(durationMs: number): SpawnResult {
  return {
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    durationMs: Math.max(0, durationMs),
  };
}

function setupInterruptedError(): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", "Setup execution was interrupted.");
}

function redactOutput(output: string, additionalSecrets: readonly string[]) {
  return redactSecretText(output, { additionalSecrets });
}

function capBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return value;
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8");
}

function assertSetupTargetKind(value: string): asserts value is SetupTargetKind {
  if (!isSetupTargetKind(value)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host, hosted_sandbox",
    );
  }
}
