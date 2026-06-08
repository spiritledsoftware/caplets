import { randomUUID } from "node:crypto";
import type { NativeCapletsService } from "../native/service";
import { createCodeModeCapletsApi, listCodeModeCallableCaplets } from "./api";
import { codeModeDeclarationHash, generateCodeModeDeclarations } from "./declarations";
import { diagnoseCodeModeTypeScript } from "./diagnostics";
import { CodeModeLogStore, redactCodeModeLogText } from "./logs";
import { QuickJsCodeModeSandbox, type CodeModeSandbox } from "./sandbox";
import type {
  CodeModeDiagnostic,
  CodeModeLogEntry,
  CodeModeLogs,
  CodeModeRunEnvelope,
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
  logStore?: CodeModeLogStore;
  sandbox?: CodeModeSandbox;
  returnedLogBytes?: number;
};

export async function runCodeMode(input: RunCodeModeInput): Promise<CodeModeRunEnvelope> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = input.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const callable = listCodeModeCallableCaplets(input.service);
  const declaration = generateCodeModeDeclarations({ caplets: callable });
  const declarationHash = codeModeDeclarationHash(declaration);
  const metaBase = {
    runId: randomUUID(),
    traceId: randomUUID(),
    declarationHash,
    timeoutMs,
    maxTimeoutMs,
  };

  const diagnostics =
    timeoutMs > maxTimeoutMs
      ? [
          {
            code: "TIMEOUT_POLICY_EXCEEDED",
            severity: "error" as const,
            message: `timeoutMs must be <= ${maxTimeoutMs}.`,
          },
        ]
      : diagnoseCodeModeTypeScript({ code: input.code, declaration });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      ok: false,
      error: {
        code: "diagnostic_blocked",
        message: "Code Mode diagnostics failed before execution.",
      },
      diagnostics,
      logs: emptyLogs(),
      meta: { ...metaBase, durationMs: Date.now() - startedAt },
    };
  }

  const capturedLogs: CodeModeLogEntry[] = [];
  const api = createCodeModeCapletsApi({
    service: input.service,
    readLogs: async (readInput) => input.logStore?.read(readInput) ?? { entries: [] },
  });
  const sandbox = input.sandbox ?? new QuickJsCodeModeSandbox();
  const result = await sandbox.run({
    code: input.code,
    capletIds: callable.map((caplet) => caplet.id),
    timeoutMs,
    invoke: async ({ capletId, method, args }) => {
      if (method === "readLogs") {
        return await api.debug.readLogs(args[0] as never);
      }
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
  });
  capturedLogs.push(...result.logs.map(redactLogEntry));
  const logs = await buildLogs(capturedLogs, input.logStore, input.returnedLogBytes);
  if (!result.ok) {
    return {
      ok: false,
      error: codeModeRuntimeError(result.error, result.stack),
      diagnostics,
      logs,
      meta: { ...metaBase, durationMs: Date.now() - startedAt },
    };
  }

  const serialized = serializeJsonValue(result.value);
  if (!serialized.ok) {
    const serializationDiagnostic: CodeModeDiagnostic = {
      code: "SERIALIZATION_ERROR",
      severity: "error",
      message: serialized.message,
    };
    return {
      ok: false,
      error: {
        code: "SERIALIZATION_ERROR",
        message: serialized.message,
      },
      diagnostics: [...diagnostics, serializationDiagnostic],
      logs,
      meta: { ...metaBase, durationMs: Date.now() - startedAt },
    };
  }

  return {
    ok: true,
    value: serialized.value,
    diagnostics,
    logs,
    meta: { ...metaBase, durationMs: Date.now() - startedAt },
  };
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
