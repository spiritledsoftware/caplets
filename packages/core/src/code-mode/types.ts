export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CodeModeCallableCaplet = {
  id: string;
  name: string;
  description: string;
  shadowing?: "forbid" | "allow";
  useWhen?: string;
  avoidWhen?: string;
};

export type CodeModeDeclarationInput = {
  caplets: CodeModeCallableCaplet[];
};

export type CodeModeTypesJson = {
  declaration: string;
  declarationHash: string;
  callableCount: number;
  generatedAt: string;
  runtimeScope: string;
};

export type CodeModeDiagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  line?: number;
  column?: number;
};

export type CodeModeSessionStatus = "created" | "reused";

export type CodeModeRunMeta = {
  runId: string;
  traceId: string;
  declarationHash: string;
  durationMs: number;
  timeoutMs: number;
  maxTimeoutMs: number;
  sessionId?: string | null;
  sessionStatus?: CodeModeSessionStatus | null;
  recoveryRef?: string | null;
  recoveryCommand?: string | null;
};

export type CodeModeRunError = {
  code: string;
  message: string;
  details?: unknown;
  location?: { line: number; column: number };
  hint?: string;
  stackPreview?: string[];
};

export type CodeModeLogEntry = {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: string;
};

export type CodeModeLogs = {
  entries: CodeModeLogEntry[];
  truncated: boolean;
  stored: boolean;
  logRef?: string;
  nextCursor?: string;
  expiresAt?: string;
};

export type CodeModeRunEnvelope =
  | {
      ok: true;
      value: JsonValue;
      diagnostics: CodeModeDiagnostic[];
      logs: CodeModeLogs;
      meta: CodeModeRunMeta;
    }
  | {
      ok: false;
      error: CodeModeRunError;
      diagnostics: CodeModeDiagnostic[];
      logs: CodeModeLogs;
      meta: CodeModeRunMeta;
    };

export type ToolCallMeta = {
  capletId?: string;
  tool?: string;
  durationMs?: number;
  [key: string]: unknown;
};

export type ToolCallError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ToolCallResult =
  | { ok: true; data: unknown; meta?: ToolCallMeta }
  | { ok: false; error: ToolCallError; meta?: ToolCallMeta };

export type CapletsResult<T> =
  | { ok: true; data: T; meta?: ToolCallMeta }
  | { ok: false; error: ToolCallError; meta?: ToolCallMeta };

export type Page<T> = {
  items: T[];
  nextCursor?: string;
  truncated?: boolean;
};

export type PageInput = {
  limit?: number;
  cursor?: string;
};

export type ReadLogsInput = {
  logRef: string;
  cursor?: string;
  limit?: number;
};

export type ReadLogsResult = {
  entries: CodeModeLogEntry[];
  nextCursor?: string;
};

export type ReadCodeModeRecoveryInput = {
  recoveryRef: string;
  cursor?: string;
  limit?: number;
};

export type CodeModeRecoveryClassification = "setup_like" | "side_effecting" | "unknown";

export type CodeModeRecoveryEntry = {
  timestamp: string;
  code: string;
  declarationHash: string;
  outcome:
    | { ok: true }
    | {
        ok: false;
        code: string;
        message: string;
      };
  diagnostics: Array<Pick<CodeModeDiagnostic, "code" | "severity" | "message">>;
  recoveryClassification: CodeModeRecoveryClassification;
  logsStored?: boolean;
  summary?: string;
};

export type ReadCodeModeRecoveryResult = {
  entries: CodeModeRecoveryEntry[];
  nextCursor?: string;
};
