import { randomUUID } from "node:crypto";
import type { NativeCapletsService } from "../native/service";
import { createCodeModeCapletsApi, listCodeModeCallableCaplets } from "./api";
import { codeModeDeclarationHash, generateCodeModeDeclarations } from "./declarations";
import { diagnoseCodeModeTypeScript } from "./diagnostics";
import { CodeModeLogStore, redactCodeModeLogText } from "./logs";
import { classifyCodeModeRecovery, CodeModeJournalStore } from "./journal";
import { QuickJsCodeModeSandbox, type CodeModeSandbox, type CodeModeSandboxInput } from "./sandbox";
import { CODE_MODE_SESSION_COMPATIBILITY_VERSION, type CodeModeSessionManager } from "./sessions";
import { CODE_MODE_PLATFORM_RUNTIME_SOURCE } from "./platform-runtime.generated";
import type {
  CodeModeDiagnostic,
  CodeModeLogEntry,
  CodeModeLogs,
  CodeModeRunEnvelope,
  CodeModeRunMeta,
  JsonValue,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_RETURNED_LOG_BYTES = 12 * 1024;

export type RunCodeModeInput = {
  code: string;
  service: NativeCapletsService;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  runtimeScope?: string;
  sessionId?: string;
  logStore?: CodeModeLogStore;
  journalStore?: CodeModeJournalStore;
  sandbox?: CodeModeSandbox;
  sessionManager?: CodeModeSessionManager;
  returnedLogBytes?: number;
};

export async function runCodeMode(input: RunCodeModeInput): Promise<CodeModeRunEnvelope> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = input.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const callable = listCodeModeCallableCaplets(input.service);
  const declaration = generateCodeModeDeclarations({ caplets: callable });
  const declarationHash = codeModeDeclarationHash(declaration);
  const platformRuntimeHash = codeModeDeclarationHash(CODE_MODE_PLATFORM_RUNTIME_SOURCE);
  let invokedCaplet = false;
  const sessionCompatibility = {
    declarationHash,
    platformRuntimeHash,
    runtimeScope: input.runtimeScope ?? "",
    version: CODE_MODE_SESSION_COMPATIBILITY_VERSION,
  };
  const diagnosticsSession =
    input.sessionManager && input.sessionId
      ? input.sessionManager.diagnosticsSession(input.sessionId, sessionCompatibility)
      : undefined;
  const metaBase: Omit<CodeModeRunMeta, "durationMs" | "anyCapletInvoked"> = {
    runId: randomUUID(),
    traceId: randomUUID(),
    declarationHash,
    timeoutMs,
    maxTimeoutMs,
    sessionId: input.sessionManager ? null : (input.sessionId ?? null),
    sessionStatus: null,
    recoveryRef: null,
  };
  const meta = (): CodeModeRunMeta => ({
    ...metaBase,
    durationMs: Date.now() - startedAt,
    anyCapletInvoked: invokedCaplet,
  });

  if (input.sessionId !== undefined && !input.sessionManager) {
    return {
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message:
          "Code Mode session reuse is not available in this runtime. Omit sessionId to run one-shot.",
      },
      diagnostics: [],
      logs: emptyLogs(),
      meta: meta(),
    };
  }

  if (
    input.sessionManager &&
    input.sessionId &&
    input.sessionManager.isBusy(input.sessionId, sessionCompatibility)
  ) {
    return {
      ok: false,
      error: {
        code: "SESSION_BUSY",
        message: `Code Mode session ${input.sessionId} is already running.`,
      },
      diagnostics: [],
      logs: emptyLogs(),
      meta: {
        ...meta(),
        sessionId: input.sessionId,
        sessionStatus: null,
      },
    };
  }

  const diagnostics =
    timeoutMs > maxTimeoutMs
      ? [
          {
            code: "TIMEOUT_POLICY_EXCEEDED",
            severity: "error" as const,
            message: `timeoutMs must be <= ${maxTimeoutMs}.`,
          },
        ]
      : diagnoseCodeModeTypeScript({
          code: input.code,
          declaration,
          ...(diagnosticsSession === undefined ? {} : { session: diagnosticsSession }),
        });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const diagnosticJournalScope =
      input.sessionManager && input.sessionId
        ? input.sessionManager.compatibilityKey(input.sessionId)
        : undefined;
    if (input.sessionManager && input.sessionId && diagnosticJournalScope === undefined) {
      const recoveryRef = await recoveryRefForSession(input, input.sessionId);
      return {
        ok: false,
        error: {
          code: "SESSION_NOT_FOUND",
          message: `Code Mode session ${input.sessionId} was not found.`,
        },
        diagnostics,
        logs: emptyLogs(),
        meta: {
          ...meta(),
          sessionId: input.sessionId,
          sessionStatus: null,
          ...recoveryMeta(recoveryRef),
        },
      };
    }
    const recoveryRef = await journalRun(input, {
      sessionId: input.sessionId ?? null,
      code: input.code,
      declarationHash,
      diagnostics,
      logs: emptyLogs(),
      outcome: {
        ok: false,
        code: "diagnostic_blocked",
        message: "Code Mode diagnostics failed before execution.",
      },
      invokedCaplet: false,
      sessionDisposedAfterRun: false,
      journalScope: diagnosticJournalScope,
    });
    if (input.sessionManager && input.sessionId) {
      metaBase.sessionId = input.sessionId;
      metaBase.sessionStatus = "reused";
    }
    if (recoveryRef && !input.sessionManager) setRecoveryMeta(metaBase, recoveryRef);
    return {
      ok: false,
      error: {
        code: "diagnostic_blocked",
        message: "Code Mode diagnostics failed before execution.",
      },
      diagnostics,
      logs: emptyLogs(),
      meta: meta(),
    };
  }

  const capturedLogs: CodeModeLogEntry[] = [];
  const api = createCodeModeCapletsApi({
    service: input.service,
    readLogs: async (readInput) => input.logStore?.read(readInput) ?? { entries: [] },
    readRecovery: async (readInput) =>
      input.journalStore?.readRecovery(readInput) ?? { entries: [] },
  });
  const sandboxInput: CodeModeSandboxInput = {
    code: input.code,
    capletIds: callable.map((caplet) => caplet.id),
    timeoutMs,
    invoke: async ({ capletId, method, args }) => {
      if (method === "readLogs") {
        return await api.debug.readLogs(args[0] as never);
      }
      if (method === "readRecovery") {
        return await api.debug.readRecovery(args[0] as never);
      }
      invokedCaplet = true;
      const handle = api[capletId];
      if (!handle || !("callTool" in handle)) {
        throw new Error(`Caplet ${capletId} is not available.`);
      }
      if (method === "inspect") return await handle.inspect();
      if (method === "check") return await handle.check();
      if (method === "tools") return await handle.tools(args[0] as never);
      if (method === "searchTools")
        return await handle.searchTools(String(args[0]), args[1] as never);
      if (method === "describeTool") return await handle.describeTool(String(args[0]));
      if (method === "callTool") return await handle.callTool(String(args[0]), args[1]);
      if (method === "resources") return await handle.resources(args[0] as never);
      if (method === "searchResources") {
        return await handle.searchResources(String(args[0]), args[1] as never);
      }
      if (method === "resourceTemplates") return await handle.resourceTemplates(args[0] as never);
      if (method === "readResource") return await handle.readResource(String(args[0]));
      if (method === "prompts") return await handle.prompts(args[0] as never);
      if (method === "searchPrompts") {
        return await handle.searchPrompts(String(args[0]), args[1] as never);
      }
      if (method === "getPrompt") return await handle.getPrompt(String(args[0]), args[1]);
      if (method === "complete") return await handle.complete(args[0]);
      throw new Error(`Unknown Code Mode CapletHandle method: ${method}.`);
    },
  };
  const sessionRun = input.sessionManager
    ? await input.sessionManager.run({
        ...sandboxInput,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        compatibility: sessionCompatibility,
        onExecutedCell: (sessionId, code, settledBindingNames) => {
          input.sessionManager?.recordExecutedCell(
            sessionId,
            code,
            declaration,
            settledBindingNames,
          );
        },
      })
    : undefined;
  if (sessionRun && !sessionRun.ok) {
    const recoveryRef =
      sessionRun.error === "not_found"
        ? await recoveryRefForSession(input, sessionRun.sessionId)
        : undefined;
    const code =
      sessionRun.error === "not_found"
        ? "SESSION_NOT_FOUND"
        : sessionRun.error === "closed"
          ? "SESSION_CLOSED"
          : "SESSION_BUSY";
    const message =
      sessionRun.error === "not_found"
        ? `Code Mode session ${sessionRun.sessionId} was not found.`
        : sessionRun.error === "closed"
          ? "Code Mode session manager is closed."
          : `Code Mode session ${sessionRun.sessionId} is already running.`;
    return {
      ok: false,
      error: {
        code,
        message,
      },
      diagnostics,
      logs: emptyLogs(),
      meta: {
        ...meta(),
        sessionId: sessionRun.sessionId,
        sessionStatus: null,
        ...recoveryMeta(recoveryRef),
      },
    };
  }
  const result =
    sessionRun?.result ?? (await (input.sandbox ?? new QuickJsCodeModeSandbox()).run(sandboxInput));
  const sessionId = sessionRun?.sessionId ?? metaBase.sessionId ?? null;
  const sessionStatus = sessionRun?.sessionStatus ?? metaBase.sessionStatus ?? null;
  const exposeRecoveryRef = !input.sessionManager || sessionStatus === "created";
  metaBase.sessionId = sessionRun?.sessionDisposedAfterRun ? null : sessionId;
  metaBase.sessionStatus = sessionRun?.sessionDisposedAfterRun ? null : sessionStatus;
  capturedLogs.push(...result.logs.map(redactLogEntry));
  const logs = await buildLogs(capturedLogs, input.logStore, input.returnedLogBytes);
  if (!result.ok) {
    const recoveryRef = await journalRun(input, {
      sessionId,
      code: input.code,
      declarationHash,
      diagnostics,
      logs,
      outcome: { ok: false, code: runtimeErrorCode(result.error), message: result.error },
      invokedCaplet,
      sessionDisposedAfterRun: sessionRun?.sessionDisposedAfterRun ?? false,
      journalScope: sessionRun?.compatibilityKey,
    });
    if (recoveryRef && exposeRecoveryRef) setRecoveryMeta(metaBase, recoveryRef);
    return {
      ok: false,
      error: codeModeRuntimeError(result.error, result.stack),
      diagnostics,
      logs,
      meta: meta(),
    };
  }

  const serialized = serializeJsonValue(result.value);
  if (!serialized.ok) {
    const serializationDiagnostic: CodeModeDiagnostic = {
      code: "SERIALIZATION_ERROR",
      severity: "error",
      message: serialized.message,
    };
    const recoveryRef = await journalRun(input, {
      sessionId,
      code: input.code,
      declarationHash,
      diagnostics: [...diagnostics, serializationDiagnostic],
      logs,
      outcome: { ok: false, code: "SERIALIZATION_ERROR", message: serialized.message },
      invokedCaplet,
      sessionDisposedAfterRun: sessionRun?.sessionDisposedAfterRun ?? false,
      journalScope: sessionRun?.compatibilityKey,
    });
    if (recoveryRef && exposeRecoveryRef) setRecoveryMeta(metaBase, recoveryRef);
    return {
      ok: false,
      error: {
        code: "SERIALIZATION_ERROR",
        message: serialized.message,
      },
      diagnostics: [...diagnostics, serializationDiagnostic],
      logs,
      meta: meta(),
    };
  }

  const recoveryRef = await journalRun(input, {
    sessionId,
    code: input.code,
    declarationHash,
    diagnostics,
    logs,
    outcome: { ok: true },
    invokedCaplet,
    sessionDisposedAfterRun: sessionRun?.sessionDisposedAfterRun ?? false,
    journalScope: sessionRun?.compatibilityKey,
  });
  if (recoveryRef && exposeRecoveryRef) setRecoveryMeta(metaBase, recoveryRef);
  return {
    ok: true,
    value: serialized.value,
    diagnostics,
    logs,
    meta: meta(),
  };
}

async function journalRun(
  input: RunCodeModeInput,
  run: {
    sessionId: string | null;
    code: string;
    declarationHash: string;
    diagnostics: CodeModeDiagnostic[];
    logs: CodeModeLogs;
    outcome: { ok: true } | { ok: false; code: string; message: string };
    invokedCaplet: boolean;
    sessionDisposedAfterRun: boolean;
    journalScope: string | undefined;
  },
): Promise<string | undefined> {
  if (!input.journalStore || !run.sessionId) return undefined;
  try {
    const stored = await input.journalStore.store({
      sessionId: run.sessionId,
      ...(run.journalScope === undefined ? {} : { journalScope: run.journalScope }),
      code: run.code,
      declarationHash: run.declarationHash,
      outcome: run.outcome,
      diagnostics: run.diagnostics,
      recoveryClassification: classifyCodeModeRecovery({
        code: run.code,
        invokedCaplet: run.invokedCaplet,
        sessionDisposedAfterRun: run.sessionDisposedAfterRun,
      }),
      ...(run.logs.logRef ? { logRef: run.logs.logRef } : {}),
    });
    return stored.recoveryRef;
  } catch {
    // Journal storage is recovery-only; never replace the primary Code Mode result.
    return undefined;
  }
}

function setRecoveryMeta(
  metaBase: Omit<CodeModeRunMeta, "durationMs" | "anyCapletInvoked">,
  recoveryRef: string,
): void {
  metaBase.recoveryRef = recoveryRef;
}

async function recoveryRefForSession(
  input: RunCodeModeInput,
  sessionId: string,
): Promise<string | undefined> {
  const lookup = await input.journalStore?.lookupSession(sessionId);
  return lookup?.recoveryRef;
}

function recoveryMeta(recoveryRef: string | undefined): Pick<CodeModeRunMeta, "recoveryRef"> {
  if (!recoveryRef) {
    return { recoveryRef: null };
  }
  return { recoveryRef };
}

function codeModeRuntimeError(message: string, stack?: string) {
  const location = userCodeLocation(stack);
  const stackPreview =
    location === undefined
      ? undefined
      : [`at user code line ${location.line} column ${location.column}`];
  const code = runtimeErrorCode(message);
  return {
    code,
    message,
    ...(location === undefined ? {} : { location }),
    ...(stackPreview === undefined ? {} : { stackPreview }),
    ...(code === "sandbox_type_error"
      ? {
          hint: "Check CapletHandle method names: inspect, check, tools, searchTools, describeTool, callTool, resources, searchResources, resourceTemplates, readResource, prompts, searchPrompts, getPrompt, complete.",
        }
      : {}),
  };
}

function runtimeErrorCode(message: string): string {
  if (/timed out|interrupted/iu.test(message)) return "sandbox_timeout";
  if (
    /fetch is disabled|imports? are not available|require is not defined|process is not defined/iu.test(
      message,
    )
  ) {
    return "sandbox_forbidden_global";
  }
  if (/is not a function|Cannot read properties|undefined is not an object/iu.test(message)) {
    return "sandbox_type_error";
  }
  if (/is not defined|ReferenceError/iu.test(message)) return "sandbox_reference_error";
  if (/Unknown Code Mode CapletHandle method/iu.test(message)) return "runtime_bridge_error";
  return "sandbox_error";
}

function userCodeLocation(stack: string | undefined): { line: number; column: number } | undefined {
  if (!stack) return undefined;
  const match = /<anonymous>:(\d+):(\d+)/u.exec(stack) ?? /eval.*?:(\d+):(\d+)/u.exec(stack);
  if (!match) return undefined;
  const line = Number.parseInt(match[1] ?? "0", 10);
  const column = Number.parseInt(match[2] ?? "0", 10);
  return line > 0 && column > 0 ? { line, column } : undefined;
}

function serializeJsonValue(
  value: unknown,
): { ok: true; value: JsonValue } | { ok: false; message: string } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return { ok: false, message: "Code Mode return value must be JSON-serializable." };
    }
    return { ok: true, value: JSON.parse(serialized) as JsonValue };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Return value is not JSON-serializable.",
    };
  }
}

async function buildLogs(
  entries: CodeModeLogEntry[],
  store: CodeModeLogStore | undefined,
  returnedLogBytes = DEFAULT_RETURNED_LOG_BYTES,
): Promise<CodeModeLogs> {
  const bounded: CodeModeLogEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of entries) {
    const nextBytes = Buffer.byteLength(entry.message, "utf8");
    if (bytes + nextBytes > returnedLogBytes) {
      truncated = true;
      break;
    }
    bounded.push(entry);
    bytes += nextBytes;
  }
  if (!store) {
    return { entries: bounded, truncated, stored: false };
  }
  const stored = await store.store(entries);
  return {
    entries: bounded,
    truncated,
    stored: true,
    logRef: stored.logRef,
    expiresAt: stored.expiresAt,
  };
}

function emptyLogs(): CodeModeLogs {
  return { entries: [], truncated: false, stored: false };
}

function redactLogEntry(entry: CodeModeLogEntry): CodeModeLogEntry {
  return { ...entry, message: redactCodeModeLogText(entry.message) };
}
