export {};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface CapletHandle<Id extends string> {
  readonly id: Id;
  /** Show this Caplet card, without tool/resource/prompt schemas. */
  inspect(): Promise<CapletCard<Id>>;
  /** Check backend readiness/auth; expected unavailable states return ok:false. */
  check(): Promise<CapletsResult<BackendCheckResult>>;
  /** List tool summaries for the discovery pass; may be empty. */
  tools(input?: PageInput): Promise<Page<ToolSummary>>;
  /** Search tool summaries for the discovery pass; may be empty. */
  searchTools(query: string, input?: PageInput): Promise<Page<ToolSummary>>;
  /** Get schema, callSignature, types, examples; prefer outputSchema/outputTypeScript over observed hints. */
  describeTool(name: string): Promise<CapletsResult<ToolDescriptor>>;
  /** Call one tool; expected failures return ok:false. Filter bulky data in script before returning. */
  callTool(name: string, args?: unknown): Promise<CapletsResult<unknown>>;
  /** List readable resources for the discovery pass; many backends expose none. */
  resources(input?: PageInput): Promise<Page<ResourceSummary>>;
  /** Search readable resources for the discovery pass; many backends expose none. */
  searchResources(query: string, input?: PageInput): Promise<Page<ResourceSummary>>;
  /** List resource templates for the discovery pass; many backends expose none. */
  resourceTemplates(input?: PageInput): Promise<Page<ResourceTemplateSummary>>;
  /** Read one resource by URI; unsupported/missing resources return ok:false. */
  readResource(uri: string): Promise<CapletsResult<ResourceReadResult>>;
  /** List reusable prompts for the discovery pass; many backends expose none. */
  prompts(input?: PageInput): Promise<Page<PromptSummary>>;
  /** Search reusable prompts for the discovery pass; many backends expose none. */
  searchPrompts(query: string, input?: PageInput): Promise<Page<PromptSummary>>;
  /** Get one prompt by name and args; unsupported/missing prompts return ok:false. */
  getPrompt(name: string, args?: unknown): Promise<CapletsResult<PromptResult>>;
  /** Complete a prompt or resource-template argument. */
  complete(input: CompleteInput): Promise<CapletsResult<CompleteResult>>;
}

interface DebugApi {
  readLogs(input: ReadLogsInput): Promise<ReadLogsResult>;
  readRecovery(input: ReadCodeModeRecoveryInput): Promise<ReadCodeModeRecoveryResult>;
}

type CapletCard<Id extends string> = {
  id: Id;
  name: string;
  description: string;
  useWhen?: string;
  avoidWhen?: string;
  tags?: string[];
  backend?: unknown;
};

type PageInput = { limit?: number; cursor?: string };
type Page<T> = { items: T[]; nextCursor?: string; truncated?: boolean };
type CapletsResult<T> =
  | { ok: true; data: T; meta?: CapletsMeta }
  | { ok: false; error: CapletsError; meta?: CapletsMeta };
type CapletsMeta = { [key: string]: unknown };
type CapletsError = { code: string; message: string; details?: unknown };
type BackendCheckResult = unknown;
type ToolSummary = {
  /** Exact downstream tool identifier for describeTool(name) and callTool(name,args). */
  name: string;
  title?: string;
  description?: string;
  /** Optional author-supplied hint for when to prefer this tool. */
  useWhen?: string;
  /** Optional author-supplied hint for when to avoid this tool. */
  avoidWhen?: string;
  /** True when the tool declares that it only reads data. */
  readOnlyHint?: boolean;
  /** True when the tool declares that it may perform destructive writes. */
  destructiveHint?: boolean;
};
type ToolDescriptor = {
  id?: string;
  tool?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  callSignature?: string;
  inputTypeScript?: string;
  outputTypeScript?: string;
  observedOutputShape?: ObservedOutputShape;
  examples?: unknown[];
};

type ObservedOutputShape = {
  version: 1;
  source: "observed";
  observedAt: string;
  sampleCount: number;
  typeScript: string;
  jsonShape: JsonShape;
  truncated: boolean;
};

type JsonShape =
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "unknown" }
  | { kind: "array"; element?: JsonShape; truncated?: boolean }
  | {
      kind: "object";
      fields: Record<string, { optional: boolean; shape: JsonShape }>;
      truncated?: boolean;
    }
  | { kind: "union"; variants: JsonShape[] };
type ResourceSummary = { uri?: string; name?: string; title?: string; description?: string };
type ResourceTemplateSummary = {
  uriTemplate?: string;
  name?: string;
  title?: string;
  description?: string;
};
type ResourceReadResult = unknown;
type PromptSummary = { name?: string; title?: string; description?: string };
type PromptResult = unknown;
type CompleteInput = {
  ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string };
  argument: { name: string; value: string };
};
type CompleteResult = unknown;

type ReadLogsInput = { logRef: string; cursor?: string; limit?: number };
type ReadLogsResult = { entries: CodeModeLogEntry[]; nextCursor?: string };
type ReadCodeModeRecoveryInput = { recoveryRef: string; cursor?: string; limit?: number };
type CodeModeRecoveryClassification = "setup_like" | "side_effecting" | "unknown";
type CodeModeRecoveryEntry = {
  timestamp: string;
  code: string;
  declarationHash: string;
  outcome: { ok: true } | { ok: false; code: string; message: string };
  diagnostics: Array<Pick<CodeModeDiagnostic, "code" | "severity" | "message">>;
  recoveryClassification: CodeModeRecoveryClassification;
  logsStored?: boolean;
  summary?: string;
};
type ReadCodeModeRecoveryResult = { entries: CodeModeRecoveryEntry[]; nextCursor?: string };
type CodeModeLogEntry = {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: string;
};
type CodeModeSessionStatus = "created" | "reused";
type CodeModeRunMeta = {
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

interface Console {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
}
declare const console: Console;
