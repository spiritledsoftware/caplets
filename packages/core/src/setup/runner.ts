import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { CapletSetupCommandConfig, CapletSetupConfig } from "../config";
import type { RuntimeFeature } from "../config-runtime";
import { CapletsError } from "../errors";
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

export type SetupSpawn = (
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<SpawnResult>;

export type SetupAttemptStore = {
  recordAttempt(
    attempt: SetupAttempt,
    options?: { operatorClientId?: string | undefined },
  ): Promise<void>;
  retention(): { maxAttempts: number; days: number };
};

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
  store: SetupAttemptStore;
  operatorClientId?: string | undefined;
  spawn?: SetupSpawn;
  now?: () => Date;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

export async function runCapletSetup(options: RunCapletSetupOptions): Promise<SetupAttempt[]> {
  assertSetupTargetKind(options.targetKind);
  if (!options.approved) {
    throw new CapletsError("REQUEST_INVALID", "Setup approval is required before commands run");
  }

  const attempts: SetupAttempt[] = [];
  const commands = options.setup.commands ?? [];
  const verify = options.setup.verify ?? [];
  for (const phase of ["commands", "verify"] as const) {
    for (const command of phase === "commands" ? commands : verify) {
      const attempt = await runSetupCommand(options, phase, command);
      attempts.push(attempt);
      await options.store.recordAttempt(
        attempt,
        options.operatorClientId === undefined
          ? {}
          : { operatorClientId: options.operatorClientId },
      );
      if (attempt.status !== "succeeded") {
        return attempts;
      }
    }
  }
  return attempts;
}

async function runSetupCommand(
  options: RunCapletSetupOptions,
  phase: "commands" | "verify",
  command: CapletSetupCommandConfig,
): Promise<SetupAttempt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const argv = [command.command, ...(command.args ?? [])];
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
  const result = await spawnImpl(command.command, command.args ?? [], {
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
  });
  const finishedAt = now();
  const redacted = redactsSecrets(command.env);
  const stdout = redactOutput(result.stdout, command.env);
  const stderr = redactOutput(result.stderr, command.env);
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
    stdout: capBytes(stdout, maxOutputBytes),
    stderr: capBytes(stderr, maxOutputBytes),
    redacted,
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
  options: {
    cwd?: string | undefined;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<SpawnResult> {
  const startedAt = Date.now();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: "", stderr: "" };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
        stdout: chunks.stdout,
        stderr: chunks.stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function resolveCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (!isAbsolute(cwd)) {
    throw new CapletsError("CONFIG_INVALID", "Setup command cwd must be absolute");
  }
  return resolve(cwd);
}

function redactsSecrets(env: Record<string, string> | undefined): boolean {
  return Object.entries(env ?? {}).some(([key, value]) => isSecretKey(key) && value.length > 0);
}

function redactOutput(output: string, env: Record<string, string> | undefined): string {
  let redacted = output;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isSecretKey(key) || !value) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function isSecretKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|KEY|AUTH/iu.test(key);
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
      "setup target must be one of: local_host, remote_host",
    );
  }
}
