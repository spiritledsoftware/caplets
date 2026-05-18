import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runCommandLine, runProcess } from "./live-agent";

export const DEFAULT_VALIDATION_TIMEOUT_MS = 60_000;

export async function createTempWorkspaceFromFixture(fixtureWorkspaceRoot) {
  if (!fixtureWorkspaceRoot) {
    throw new TypeError("createTempWorkspaceFromFixture requires fixtureWorkspaceRoot.");
  }
  const workspace = await mkdtemp(join(tmpdir(), "caplets-benchmark-workspace-"));
  await cp(fixtureWorkspaceRoot, workspace, { recursive: true });
  return workspace;
}

export async function scoreTaskRun({
  task,
  candidateWorkspace,
  fixtureRoot,
  agentResult,
  validationTimeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS,
}: any = {}): Promise<any> {
  if (!task) {
    throw new TypeError("scoreTaskRun requires a task.");
  }
  if (!candidateWorkspace) {
    throw new TypeError("scoreTaskRun requires a candidateWorkspace.");
  }

  const validation = await runValidationCommand(task.validationCommand, candidateWorkspace, {
    timeoutMs: validationTimeoutMs,
  });
  const hiddenValidation = await runHiddenValidator(task, candidateWorkspace, fixtureRoot, {
    timeoutMs: validationTimeoutMs,
  });
  const transcript = `${agentResult?.stdout ?? ""}${agentResult?.stderr ?? ""}`;
  const transcriptBytes = Buffer.byteLength(transcript, "utf8");
  const events = agentResult?.jsonEvents ?? [];

  const finalStateValid = validation.success && hiddenValidation.success;
  const processFailureReason = agentResult ? agentProcessFailureReason(agentResult) : undefined;
  const processSuccess = !processFailureReason;

  return {
    taskId: task.id,
    success: finalStateValid && processSuccess,
    finalStateValid,
    processSuccess,
    processFailureReason,
    validation,
    hiddenValidation,
    process: agentResult
      ? {
          exitCode: agentResult.exitCode,
          signal: agentResult.signal,
          timedOut: agentResult.timedOut,
          durationMs: agentResult.durationMs,
          command: agentResult.command,
          args: agentResult.args,
          envKeys: agentResult.envKeys,
          skipped: agentResult.skipped,
          unavailable: agentResult.unavailable,
          configConflict: agentResult.configConflict,
        }
      : undefined,
    metrics: transcriptMetrics({ transcriptBytes, events }),
  };
}

function agentProcessFailureReason(agentResult) {
  if (agentResult.timedOut) {
    return "agent timed out";
  }
  if (agentResult.signal) {
    return `agent exited with signal ${agentResult.signal}`;
  }
  if (agentResult.skipped || agentResult.unavailable) {
    return agentResult.reason ?? "agent unavailable";
  }
  if (agentResult.configConflict) {
    return agentResult.reason ?? "agent config conflict";
  }
  if (agentResult.benchmarkHarnessCapturedError) {
    return agentResult.stderr || "agent runner threw before scoring";
  }
  const errorEvent = (agentResult.jsonEvents ?? []).find(isAgentErrorEvent);
  if (errorEvent) {
    return formatAgentErrorEvent(errorEvent);
  }
  if (agentResult.exitCode != null && agentResult.exitCode !== 0) {
    return `agent exited with code ${agentResult.exitCode}`;
  }
  return undefined;
}

function isAgentErrorEvent(event) {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event.type === "error" || event.event === "error" || event.error),
  );
}

function formatAgentErrorEvent(event) {
  const error = event.error && typeof event.error === "object" ? event.error : event;
  const name = typeof error.name === "string" ? error.name : "agent error";
  const data = error.data && typeof error.data === "object" ? error.data : undefined;
  const message =
    typeof error.message === "string"
      ? error.message
      : typeof data?.message === "string"
        ? data.message
        : undefined;
  const status = typeof data?.statusCode === "number" ? ` (${data.statusCode})` : "";
  return message ? `${name}${status}: ${message}` : `${name}${status}`;
}

export function transcriptMetrics({ transcript = "", transcriptBytes, events = [] }: any = {}) {
  const bytes = transcriptBytes ?? Buffer.byteLength(transcript, "utf8");
  return {
    transcriptBytes: bytes,
    approxTokenProxy: Math.ceil(bytes / 4),
    toolCallCount: countToolCalls(events),
    failedCallCount: countFailedCalls(events),
    irrelevantCallCount: countIrrelevantCalls(events),
  };
}

export function countToolCalls(events = []) {
  return events.reduce((count, event) => count + toolCallsFromEvent(event).length, 0);
}

export function countFailedCalls(events = []) {
  return events.reduce(
    (count, event) => count + toolCallsFromEvent(event).filter(isFailedToolCall).length,
    0,
  );
}

export function countIrrelevantCalls(events = []) {
  return events.reduce(
    (count, event) => count + toolCallsFromEvent(event).filter(isIrrelevantToolCall).length,
    0,
  );
}

async function runValidationCommand(commandLine, cwd, { timeoutMs }) {
  if (!commandLine) {
    return { success: true, skipped: true, command: undefined };
  }
  const result = await runCommandLine(commandLine, { cwd, timeoutMs });
  return validationResult(result);
}

async function runHiddenValidator(task, candidateWorkspace, fixtureRoot, { timeoutMs }) {
  if (task.hiddenValidator) {
    if (!fixtureRoot) {
      throw new TypeError(`Task ${task.id} has hiddenValidator but fixtureRoot was not provided.`);
    }
    const validatorPath = resolveInside(fixtureRoot, task.hiddenValidator);
    const result = await runProcess({
      command: process.execPath,
      args: ["--test", validatorPath],
      cwd: candidateWorkspace,
      timeoutMs,
    });
    return validationResult(result);
  }
  if (task.hiddenValidationCommand) {
    const result = await runCommandLine(task.hiddenValidationCommand, {
      cwd: candidateWorkspace,
      timeoutMs,
    });
    return validationResult(result);
  }
  return { success: true, skipped: true, command: undefined };
}

function validationResult(result) {
  return {
    success: result.exitCode === 0 && !result.timedOut,
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

export function resolveInside(root, relativePath) {
  const rootPath = resolve(root);
  const candidate = isAbsolute(relativePath)
    ? resolve(relativePath)
    : resolve(rootPath, relativePath);
  const relativePathFromRoot = relative(rootPath, candidate);
  if (
    relativePathFromRoot === "" ||
    relativePathFromRoot.startsWith("..") ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error(`Hidden validator must resolve inside fixture root: ${relativePath}`);
  }
  return candidate;
}

function toolCallsFromEvent(event) {
  if (!event || typeof event !== "object") {
    return [];
  }
  const calls = [];
  if (Array.isArray(event.toolCalls)) {
    calls.push(...event.toolCalls);
  }
  if (Array.isArray(event.tool_calls)) {
    calls.push(...event.tool_calls);
  }
  if (Array.isArray(event.tools)) {
    calls.push(...event.tools.filter((tool) => looksLikeToolCall(tool)));
  }
  if (looksLikeToolCall(event)) {
    calls.push(event);
  }
  return calls;
}

function looksLikeToolCall(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const type = String(value.type ?? value.kind ?? value.event ?? "").toLowerCase();
  return (
    type.includes("tool") ||
    typeof value.toolName === "string" ||
    typeof value.tool_name === "string" ||
    (typeof value.name === "string" &&
      ("arguments" in value || "input" in value || "result" in value))
  );
}

function isFailedToolCall(call) {
  const status = String(call.status ?? call.state ?? call.outcome ?? "").toLowerCase();
  return Boolean(
    call.error || call.isError || call.failed || status === "failed" || status === "error",
  );
}

function isIrrelevantToolCall(call) {
  if (call.irrelevant === true || call.relevance === "irrelevant") {
    return true;
  }
  const name = String(call.toolName ?? call.tool_name ?? call.name ?? "").toLowerCase();
  return name.includes("irrelevant") || name.includes("distractor");
}
