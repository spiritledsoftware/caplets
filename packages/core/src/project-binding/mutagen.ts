import { spawn } from "node:child_process";
import { redactSecretText } from "../redaction";
import type { ProjectBindingQuarantineRecord } from "./types";
import type { ProjectSyncExclusionSummary, ProjectSyncManifest } from "./sync-filter";
import type { ProjectSyncSizeResult } from "./sync-size";

export type ManagedSyncState = "idle" | "starting" | "syncing" | "ready" | "blocked" | "stopped";

export type ManagedSyncDiagnosticCode =
  | "project_sync_binary_missing"
  | "project_sync_auth_failed"
  | "project_sync_conflict"
  | "project_sync_policy_denied"
  | "project_sync_process_exit"
  | "project_sync_status_unavailable";

export type MutagenCommandPlan = {
  command: string;
  args: string[];
};

export type MutagenProcessResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type MutagenProcessRunner = (
  command: string,
  args: string[],
) => Promise<MutagenProcessResult>;

export type MutagenLastCommandStatus = MutagenCommandPlan & {
  stdout: string;
  stderr: string;
  exitCode?: number;
};

export type ManagedSyncStateSnapshot = {
  state: ManagedSyncState;
  publicMessage: string;
  bindingId?: string;
  diagnosticCode?: ManagedSyncDiagnosticCode;
  mutagenBinary?: string;
  mutagenVersion?: string;
  lastCommand?: MutagenLastCommandStatus;
};

export type MutagenProjectSyncDoctorData = {
  state: ManagedSyncState;
  diagnosticCode?: ManagedSyncDiagnosticCode;
  mutagenBinary?: string;
  mutagenVersion?: string;
  lastCommand?: MutagenLastCommandStatus;
};

export type StartMutagenProjectSyncInput = {
  bindingId: string;
  localProjectRoot: string;
  serverProjectRoot: string;
  syncPolicy?: MutagenSyncPolicy | undefined;
};

export type MutagenProjectSyncBindingInput = {
  bindingId: string;
};

export type ManagedMutagenProjectSyncOptions = {
  mutagenBinary?: string;
  runner?: MutagenProcessRunner;
};

export type MutagenSyncPolicy =
  | {
      ok: true;
      ignore: string[];
      exclusionSummary: ProjectSyncExclusionSummary[];
      totalBytes: number;
      maxSingleFileBytes: number;
      maxProjectBytes: number;
    }
  | {
      ok: false;
      diagnosticCode: ManagedSyncDiagnosticCode;
      publicMessage: string;
      recoveryCommand: string;
      exclusionSummary: ProjectSyncExclusionSummary[];
      totalBytes?: number | undefined;
      maxSingleFileBytes?: number | undefined;
      maxProjectBytes?: number | undefined;
    };

type MutagenVersionInfo = {
  version: string;
};

type ManagedSyncStateUpdate = {
  state: ManagedSyncState;
  publicMessage: string;
  bindingId?: string | undefined;
  diagnosticCode?: ManagedSyncDiagnosticCode | undefined;
};

const readyStatuses = new Set(["watching", "ready", "ok"]);
const syncingStatuses = new Set([
  "connecting",
  "halted on root",
  "reconciling",
  "scanning",
  "staging",
  "syncing",
  "transitioning",
  "watching for changes",
]);

export function planMutagenVersionCommand(mutagenBinary = "mutagen"): MutagenCommandPlan {
  return { command: mutagenBinary, args: ["version"] };
}

export function planMutagenSyncCreateCommand(
  input: StartMutagenProjectSyncInput,
  mutagenBinary = "mutagen",
): MutagenCommandPlan {
  const policyArgs =
    input.syncPolicy?.ok === true
      ? ["--ignore-vcs", ...input.syncPolicy.ignore.flatMap((pattern) => ["--ignore", pattern])]
      : [];
  return {
    command: mutagenBinary,
    args: [
      "sync",
      "create",
      input.localProjectRoot,
      input.serverProjectRoot,
      "--name",
      mutagenSyncName(input.bindingId),
      ...policyArgs,
    ],
  };
}

export function planMutagenSyncListCommand(mutagenBinary = "mutagen"): MutagenCommandPlan {
  return { command: mutagenBinary, args: ["sync", "list", "--template", "json"] };
}

export function planMutagenSyncTerminateCommand(
  bindingId: string,
  mutagenBinary = "mutagen",
): MutagenCommandPlan {
  return { command: mutagenBinary, args: ["sync", "terminate", mutagenSyncName(bindingId)] };
}

export function mutagenSyncName(bindingId: string): string {
  return `caplets-${bindingId}`;
}

export function buildMutagenSyncPolicy(input: {
  manifest: ProjectSyncManifest;
  size: ProjectSyncSizeResult;
}): MutagenSyncPolicy {
  if (!input.size.ok) {
    return {
      ok: false,
      diagnosticCode: "project_sync_policy_denied",
      publicMessage: "Project sync policy cannot be enforced.",
      recoveryCommand: input.size.recoveryCommand,
      exclusionSummary: input.manifest.exclusionSummary,
      totalBytes: input.size.totalBytes,
      maxSingleFileBytes: input.size.maxSingleFileBytes,
      maxProjectBytes: input.size.maxProjectBytes,
    };
  }
  return {
    ok: true,
    ignore: uniqueSorted(input.manifest.exclusionSummary.map((entry) => entry.pattern)),
    exclusionSummary: input.manifest.exclusionSummary,
    totalBytes: input.size.totalBytes,
    maxSingleFileBytes: input.size.maxSingleFileBytes,
    maxProjectBytes: input.size.maxProjectBytes,
  };
}

export class ManagedMutagenProjectSync {
  readonly mutagenBinary: string;

  #runner: MutagenProcessRunner;
  #snapshot: ManagedSyncStateSnapshot;

  constructor(options: ManagedMutagenProjectSyncOptions = {}) {
    this.mutagenBinary = options.mutagenBinary ?? "mutagen";
    this.#runner = options.runner ?? defaultMutagenProcessRunner;
    this.#snapshot = {
      state: "idle",
      publicMessage: "Project sync is idle.",
      mutagenBinary: this.mutagenBinary,
    };
  }

  async start(input: StartMutagenProjectSyncInput): Promise<ManagedSyncStateSnapshot> {
    this.#setState({
      state: "starting",
      bindingId: input.bindingId,
      publicMessage: "Project sync is starting.",
    });
    if (input.syncPolicy?.ok === false) {
      this.#block(input.bindingId, input.syncPolicy.diagnosticCode, input.syncPolicy.publicMessage);
      return this.snapshot();
    }
    const versionResult = await this.#run(planMutagenVersionCommand(this.mutagenBinary));
    if (versionResult.blocked) {
      return this.snapshot();
    }
    this.#snapshot.mutagenVersion = parseMutagenVersionOutput(
      versionResult.result.stdout ?? "",
    ).version;

    const createResult = await this.#run(planMutagenSyncCreateCommand(input, this.mutagenBinary));
    if (createResult.blocked) {
      return this.snapshot();
    }
    this.#setState({
      state: "syncing",
      bindingId: input.bindingId,
      publicMessage: "Project sync is starting.",
    });
    return this.snapshot();
  }

  async refresh(input: MutagenProjectSyncBindingInput): Promise<ManagedSyncStateSnapshot> {
    const listResult = await this.#run(
      planMutagenSyncListCommand(this.mutagenBinary),
      input.bindingId,
    );
    if (listResult.blocked) {
      return this.snapshot();
    }

    let session: { name: string; status: string } | undefined;
    try {
      session = findMutagenSyncSession(listResult.result.stdout, mutagenSyncName(input.bindingId));
    } catch {
      this.#block(input.bindingId, "project_sync_status_unavailable");
      return this.snapshot();
    }
    if (!session) {
      this.#block(input.bindingId, "project_sync_status_unavailable");
      return this.snapshot();
    }

    const normalizedStatus = session.status.toLocaleLowerCase();
    if (readyStatuses.has(normalizedStatus)) {
      this.#setState({
        state: "ready",
        bindingId: input.bindingId,
        publicMessage: "Project sync is ready.",
      });
      return this.snapshot();
    }
    if (syncingStatuses.has(normalizedStatus)) {
      this.#setState({
        state: "syncing",
        bindingId: input.bindingId,
        publicMessage: "Project sync is catching up.",
      });
      return this.snapshot();
    }

    this.#block(input.bindingId, mapTextToDiagnosticCode(session.status));
    return this.snapshot();
  }

  async stop(input: MutagenProjectSyncBindingInput): Promise<ManagedSyncStateSnapshot> {
    const stopResult = await this.#run(
      planMutagenSyncTerminateCommand(input.bindingId, this.mutagenBinary),
      input.bindingId,
    );
    if (stopResult.blocked) {
      return this.snapshot();
    }
    this.#setState({
      state: "stopped",
      bindingId: input.bindingId,
      publicMessage: "Project sync has stopped.",
    });
    return this.snapshot();
  }

  snapshot(): ManagedSyncStateSnapshot {
    const snapshot: ManagedSyncStateSnapshot = {
      ...this.#snapshot,
    };
    if (this.#snapshot.lastCommand) {
      snapshot.lastCommand = {
        ...this.#snapshot.lastCommand,
        args: [...this.#snapshot.lastCommand.args],
      };
    }
    return snapshot;
  }

  async #run(
    plan: MutagenCommandPlan,
    bindingId = this.#snapshot.bindingId,
  ): Promise<{ blocked: false; result: Required<MutagenProcessResult> } | { blocked: true }> {
    try {
      const result = normalizeProcessResult(await this.#runner(plan.command, [...plan.args]));
      this.#snapshot.lastCommand = { ...plan, ...result, args: [...plan.args] };
      if (result.exitCode !== 0) {
        this.#block(bindingId, "project_sync_process_exit");
        return { blocked: true };
      }
      return { blocked: false, result };
    } catch (error) {
      const errorResult: MutagenProcessResult = {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
      const exitCode = errorExitCode(error);
      if (exitCode !== undefined) {
        errorResult.exitCode = exitCode;
      }
      this.#snapshot.lastCommand = commandStatus(plan, errorResult);
      this.#block(bindingId, mapErrorToDiagnosticCode(error));
      return { blocked: true };
    }
  }

  #block(
    bindingId: string | undefined,
    diagnosticCode: ManagedSyncDiagnosticCode,
    publicMessage = "Project sync is blocked.",
  ): void {
    this.#setState({
      state: "blocked",
      bindingId,
      diagnosticCode,
      publicMessage,
    });
  }

  #setState(next: ManagedSyncStateUpdate): void {
    const snapshot: ManagedSyncStateSnapshot = {
      ...this.#snapshot,
      state: next.state,
      publicMessage: next.publicMessage,
      mutagenBinary: this.mutagenBinary,
    };
    if (next.bindingId !== undefined) {
      snapshot.bindingId = next.bindingId;
    }
    if (next.diagnosticCode !== undefined) {
      snapshot.diagnosticCode = next.diagnosticCode;
    } else {
      delete snapshot.diagnosticCode;
    }
    this.#snapshot = snapshot;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function mutagenProjectSyncDoctorData(
  snapshot: ManagedSyncStateSnapshot,
): MutagenProjectSyncDoctorData {
  const doctorData: MutagenProjectSyncDoctorData = {
    state: snapshot.state,
  };
  if (snapshot.diagnosticCode !== undefined) {
    doctorData.diagnosticCode = snapshot.diagnosticCode;
  }
  if (snapshot.mutagenBinary !== undefined) {
    doctorData.mutagenBinary = snapshot.mutagenBinary;
  }
  if (snapshot.mutagenVersion !== undefined) {
    doctorData.mutagenVersion = snapshot.mutagenVersion;
  }
  if (snapshot.lastCommand !== undefined) {
    doctorData.lastCommand = snapshot.lastCommand;
  }
  return doctorData;
}

export function managedSyncQuarantineRecord(input: {
  capletId: string;
  snapshot: ManagedSyncStateSnapshot;
  recordedAt?: string | undefined;
}): ProjectBindingQuarantineRecord {
  const record: ProjectBindingQuarantineRecord = {
    capletId: input.capletId,
    reason: input.snapshot.state === "blocked" ? "sync_failed" : "quarantined",
    message: input.snapshot.publicMessage,
    sync: projectBindingManagedSyncSnapshot(input.snapshot),
  };
  if (input.snapshot.diagnosticCode !== undefined) {
    record.code = input.snapshot.diagnosticCode;
  }
  if (input.recordedAt !== undefined) {
    record.recordedAt = input.recordedAt;
  }
  return record;
}

function projectBindingManagedSyncSnapshot(
  snapshot: ManagedSyncStateSnapshot,
): NonNullable<ProjectBindingQuarantineRecord["sync"]> {
  const sync: NonNullable<ProjectBindingQuarantineRecord["sync"]> = {
    state: snapshot.state,
  };
  if (snapshot.diagnosticCode !== undefined) {
    sync.diagnosticCode = snapshot.diagnosticCode;
  }
  if (snapshot.mutagenBinary !== undefined) {
    sync.mutagenBinary = snapshot.mutagenBinary;
  }
  if (snapshot.mutagenVersion !== undefined) {
    sync.mutagenVersion = snapshot.mutagenVersion;
  }
  if (snapshot.lastCommand !== undefined) {
    sync.lastCommand = {
      command: snapshot.lastCommand.command,
      args: [...snapshot.lastCommand.args],
      stdout: redactSecretText(snapshot.lastCommand.stdout).text,
      stderr: redactSecretText(snapshot.lastCommand.stderr).text,
      ...(snapshot.lastCommand.exitCode === undefined
        ? {}
        : { exitCode: snapshot.lastCommand.exitCode }),
    };
  }
  return sync;
}

export function parseMutagenVersionOutput(output: string): MutagenVersionInfo {
  return { version: output.match(/Mutagen version\s+([^\s]+)/u)?.[1] ?? "unknown" };
}

async function defaultMutagenProcessRunner(
  command: string,
  args: string[],
): Promise<MutagenProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve(exitCode === null ? { stdout, stderr } : { stdout, stderr, exitCode });
    });
  });
}

function normalizeProcessResult(result: MutagenProcessResult): Required<MutagenProcessResult> {
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

function commandStatus(
  plan: MutagenCommandPlan,
  result: MutagenProcessResult,
): MutagenLastCommandStatus {
  const status: MutagenLastCommandStatus = {
    ...plan,
    args: [...plan.args],
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (result.exitCode !== undefined) {
    status.exitCode = result.exitCode;
  }
  return status;
}

function mapErrorToDiagnosticCode(error: unknown): ManagedSyncDiagnosticCode {
  const text = errorText(error);
  if (errorCode(error) === "ENOENT" || /\bnot found\b|enoent|no such file/u.test(text)) {
    return "project_sync_binary_missing";
  }
  return mapTextToDiagnosticCode(text, errorExitCode(error));
}

function mapTextToDiagnosticCode(text: string, exitCode?: number): ManagedSyncDiagnosticCode {
  const normalized = text.toLocaleLowerCase();
  if (/auth|credential|permission denied|unauthorized|forbidden/u.test(normalized)) {
    return "project_sync_auth_failed";
  }
  if (/already exists|conflict|duplicate|in use/u.test(normalized)) {
    return "project_sync_conflict";
  }
  if (exitCode !== undefined || /exit|failed|terminated/u.test(normalized)) {
    return "project_sync_process_exit";
  }
  return "project_sync_status_unavailable";
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.toLocaleLowerCase()
    : String(error).toLocaleLowerCase();
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function errorExitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "exitCode" in error
    ? (error as { exitCode?: number }).exitCode
    : undefined;
}

function findMutagenSyncSession(
  stdout: string,
  name: string,
): { name: string; status: string } | undefined {
  const parsed = JSON.parse(stdout) as unknown;
  for (const entry of collectCandidateSessions(parsed)) {
    if (entry.name === name) {
      return entry;
    }
  }
  return undefined;
}

function collectCandidateSessions(value: unknown): Array<{ name: string; status: string }> {
  if (Array.isArray(value)) {
    return value.flatMap(collectCandidateSessions);
  }
  if (!isRecord(value)) {
    return [];
  }

  const ownSession = sessionFromRecord(value);
  const nested = ["synchronizations", "sessions", "syncs"].flatMap((key) =>
    collectCandidateSessions(value[key]),
  );
  return ownSession ? [ownSession, ...nested] : nested;
}

function sessionFromRecord(
  value: Record<string, unknown>,
): { name: string; status: string } | undefined {
  const name = stringProperty(value, "name") ?? stringProperty(value, "Name");
  const status =
    stringProperty(value, "status") ??
    stringProperty(value, "Status") ??
    stringProperty(value, "sessionStatus") ??
    stringProperty(value, "SessionStatus");
  return name && status ? { name, status } : undefined;
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
