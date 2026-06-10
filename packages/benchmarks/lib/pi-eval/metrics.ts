import { readFile } from "node:fs/promises";
import { getEncoding } from "js-tiktoken";

const encoding = getEncoding("cl100k_base");

export const TOKENIZER_INFO = Object.freeze({ package: "js-tiktoken", encoding: "cl100k_base" });

export function estimateTokens(value: unknown): number | null {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return encoding.encode(text ?? "").length;
  } catch {
    return null;
  }
}

export function byteTokenProxy(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(Buffer.byteLength(text ?? "", "utf8") / 4);
}

export async function readMetricsJsonl(path: string | null | undefined): Promise<any[]> {
  if (!path) return [];
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

export function summarizePiEvalMetrics(
  events: any[] = [],
  jsonEvents: any[] = [],
  options: { mode?: string; adapterExposure?: string | null } = {},
) {
  const providerRequests = events.filter((event) => event.type === "before_provider_request");
  const providerResponses = events.filter((event) => event.type === "after_provider_response");
  const instrumentedToolEvents = events.filter((event) =>
    String(event.type ?? event.event ?? "").includes("tool"),
  );
  const jsonToolEvents = jsonEvents.filter((event) =>
    String(event.type ?? event.event ?? "").includes("tool"),
  );
  const toolEvents = instrumentedToolEvents.length ? instrumentedToolEvents : jsonToolEvents;
  const instrumentedToolStartEvents = events.filter(
    (event) => String(event.type ?? event.event ?? "") === "tool_execution_start",
  );
  const jsonToolStartEvents = jsonEvents.filter(
    (event) => String(event.type ?? event.event ?? "") === "tool_execution_start",
  );
  const toolStartEvents = instrumentedToolStartEvents.length
    ? instrumentedToolStartEvents
    : jsonToolStartEvents;
  const toolCallNames = toolStartEvents.map(toolNameFromEvent).filter(Boolean) as string[];
  const hybridChoice = classifyHybridChoice(toolCallNames, options);
  const directToolsPrewarmFailure =
    options.adapterExposure === "direct-tools" && toolCallNames.includes("mcp");
  const domainCoverage = computeDomainCoverage([...events, ...jsonEvents]);
  const latestRequest = providerRequests.at(-1) ?? null;
  const requestPayloadEstimatedTokens = sumNullable(
    providerRequests.map((event) => event.requestPayloadEstimatedTokens),
  );
  const toolSurfaceEstimatedTokens = sumNullable(
    providerRequests.map((event) => event.toolSurfaceEstimatedTokens),
  );
  const requestTokenBuckets = summarizeRequestTokenBuckets(providerRequests);
  return {
    tokenizer: TOKENIZER_INFO,
    providerRequestCount: providerRequests.length,
    providerResponseCount: providerResponses.length,
    toolCallCount: toolCallNames.length,
    toolCallEventSource: instrumentedToolStartEvents.length ? "metrics-jsonl" : "agent-json-events",
    toolEventCount: toolEvents.length,
    toolNames: toolCallNames,
    domainCoverage,
    hybridChoice,
    directToolsPrewarmFailure,
    requestPayloadBytes: sum(providerRequests.map((event) => event.requestPayloadBytes)),
    requestPayloadEstimatedTokens,
    toolSurfaceBytes: sum(providerRequests.map((event) => event.toolSurfaceBytes)),
    toolSurfaceEstimatedTokens,
    nonSurfaceEstimatedTokens:
      requestPayloadEstimatedTokens == null || toolSurfaceEstimatedTokens == null
        ? null
        : Math.max(0, requestPayloadEstimatedTokens - toolSurfaceEstimatedTokens),
    messagePayloadBytes: sum(providerRequests.map((event) => event.messagePayloadBytes)),
    messagePayloadEstimatedTokens: sumNullable(
      providerRequests.map((event) => event.messagePayloadEstimatedTokens),
    ),
    requestTokenBuckets,
    providerUsage: mergeUsage(events, jsonEvents),
    resolvedModel: latestRequest?.model ?? null,
  };
}

export function summarizeRequestTokenBuckets(providerRequests: any[] = []) {
  const buckets = [
    "requestPayloadEstimatedTokens",
    "toolSurfaceEstimatedTokens",
    "nonSurfaceEstimatedTokens",
    "messagePayloadEstimatedTokens",
    "instructionEstimatedTokens",
    "instructionMessageEstimatedTokens",
    "userMessageEstimatedTokens",
    "assistantMessageEstimatedTokens",
    "toolCallMessageEstimatedTokens",
    "toolResultMessageEstimatedTokens",
    "otherMessageEstimatedTokens",
    "attributedNonSurfaceEstimatedTokens",
    "requestOverheadEstimatedTokens",
  ];
  const totals: Record<string, number> = Object.fromEntries(buckets.map((bucket) => [bucket, 0]));
  const perRequest = providerRequests.map((event, index) => {
    const eventBuckets = legacyRequestTokenBuckets(event);
    for (const bucket of buckets) totals[bucket] += numberValue(eventBuckets[bucket]);
    return { index: index + 1, ...eventBuckets };
  });
  const requestCount = providerRequests.length;
  const averagesPerRequest = Object.fromEntries(
    buckets.map((bucket) => [bucket, requestCount ? totals[bucket] / requestCount : 0]),
  );
  const requestPayload = totals.requestPayloadEstimatedTokens;
  const sharesOfRequest = Object.fromEntries(
    buckets.map((bucket) => [bucket, requestPayload ? totals[bucket] / requestPayload : 0]),
  );
  return { requestCount, totals, averagesPerRequest, sharesOfRequest, perRequest };
}

function legacyRequestTokenBuckets(event: any): Record<string, number> {
  const buckets = event?.requestTokenBuckets;
  if (buckets && typeof buckets === "object") {
    return Object.fromEntries(
      Object.entries(buckets).map(([key, value]) => [key, numberValue(value)]),
    );
  }
  const requestPayloadEstimatedTokens = numberValue(event?.requestPayloadEstimatedTokens);
  const toolSurfaceEstimatedTokens = numberValue(event?.toolSurfaceEstimatedTokens);
  const messagePayloadEstimatedTokens = numberValue(event?.messagePayloadEstimatedTokens);
  const nonSurfaceEstimatedTokens = Math.max(
    0,
    requestPayloadEstimatedTokens - toolSurfaceEstimatedTokens,
  );
  return {
    requestPayloadEstimatedTokens,
    toolSurfaceEstimatedTokens,
    nonSurfaceEstimatedTokens,
    messagePayloadEstimatedTokens,
    attributedNonSurfaceEstimatedTokens: messagePayloadEstimatedTokens,
    requestOverheadEstimatedTokens: Math.max(
      0,
      nonSurfaceEstimatedTokens - messagePayloadEstimatedTokens,
    ),
  };
}

export function computeDomainCoverage(events: any[] = []) {
  const domains = { issues: false, ci: false, docs: false, api: false, codeMap: false };
  const serialized = events.map(coverageTextFromEvent).join("\n").toLowerCase();
  domains.issues = /bench-451|caplets_issues|caplets__issues|\bissues\b/u.test(serialized);
  domains.ci = /ci-9182|caplets_ci|caplets__ci|\bci\b|failingtests/u.test(serialized);
  domains.docs = /runbook|idempotency guidance|caplets_docs|caplets__docs|\bdocs\b/u.test(
    serialized,
  );
  domains.api = /checkout\/authorize|caplets_api|caplets__api|\bapi\b/u.test(serialized);
  domains.codeMap = /code-map|code_map|caplets_code_map|targetfiles/u.test(serialized);
  return {
    ...domains,
    requiredComplete: domains.issues && domains.ci && domains.docs && domains.api,
  };
}

function coverageTextFromEvent(event: any): string {
  if (!event || typeof event !== "object") return String(event ?? "");
  if (typeof event.text === "string") return event.text;
  if (event.type === "tool_result") {
    return [event.resultPreview, event.content, event.result, event.output]
      .filter((value) => value != null)
      .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
      .join("\n");
  }
  if (event.message?.role === "toolResult") {
    return (event.message.content ?? [])
      .map((part: any) => part?.text ?? part)
      .map((value: any) => (typeof value === "string" ? value : JSON.stringify(value)))
      .join("\n");
  }
  return "";
}

export function requiredEvidenceScore(metrics: any, task: any) {
  if (task?.id !== "checkout-incident-retry-hardening") {
    return {
      required: false,
      success: true,
      missingDomains: [],
      coverage: metrics?.domainCoverage ?? {},
    };
  }
  const coverage = metrics?.domainCoverage ?? {};
  const missingDomains = ["issues", "ci", "docs", "api"].filter((domain) => !coverage[domain]);
  return { required: true, success: missingDomains.length === 0, missingDomains, coverage };
}

export function classifyHybridChoice(
  toolNames: string[],
  options: { mode?: string; adapterExposure?: string | null } = {},
) {
  const usedCodeMode = toolNames.some(
    (name) => name === "caplets_code_mode" || name.includes("caplets_code_mode"),
  );
  const usedDirect = toolNames.some((name) => name.startsWith("caplets__"));
  const usedProgressive = toolNames.some((name) => /^caplets_(?!_|code_mode\b)/u.test(name));
  const usedExecutorDirect = toolNames.some((name) => name.startsWith("executor_"));
  const usedMcpProxy = toolNames.includes("mcp");
  const usedVanillaMcpDirect = toolNames.some((name) =>
    /^(issues|ci|docs|api|code_map)_/u.test(name),
  );
  const usedExecutor = usedExecutorDirect || options.mode === "executor-mcp";
  const usedVanillaMcp = usedVanillaMcpDirect || options.mode === "vanilla-mcp";
  const usedCaplets = usedDirect || usedCodeMode || usedProgressive;
  if (usedExecutorDirect && usedCaplets) return "mixed-executor-caplets";
  if (usedVanillaMcpDirect && usedCaplets) return "mixed-vanilla-mcp-caplets";
  if (usedExecutorDirect) return "executor-only";
  if (usedVanillaMcpDirect) return "vanilla-mcp-only";
  if (options.mode === "executor-mcp" && usedMcpProxy) return "executor-proxy-fallback";
  if (options.mode === "vanilla-mcp" && usedMcpProxy) return "vanilla-mcp-proxy-fallback";
  if (usedExecutor && usedCaplets) return "mixed-executor-caplets";
  if (usedVanillaMcp && usedCaplets) return "mixed-vanilla-mcp-caplets";
  if (usedDirect && usedCodeMode && usedProgressive) return "mixed-direct-progressive-code-mode";
  if (usedDirect && usedCodeMode) return "direct-and-code-mode";
  if (usedDirect && usedProgressive) return "mixed-direct-progressive";
  if (usedDirect) return "direct-only";
  if (usedCodeMode && usedProgressive) return "mixed";
  if (usedCodeMode) return "code-mode-only";
  if (usedProgressive) return "progressive-only";
  return "unused";
}

export function toolNameFromEvent(event: any): string | null {
  return (
    event?.toolName ??
    event?.tool_name ??
    event?.name ??
    event?.tool?.name ??
    event?.params?.name ??
    null
  );
}

function mergeUsage(events: any[], jsonEvents: any[] = []) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  let found = false;
  const metricUsages = events
    .filter((event) => event.type === "after_provider_response")
    .map((event) => event.usage ?? event.response?.usage)
    .filter(isRecord);
  const jsonUsages = jsonEvents
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message?.usage)
    .filter(isRecord);
  for (const value of metricUsages.length ? metricUsages : jsonUsages) {
    found = true;
    usage.inputTokens += numberValue(value.inputTokens ?? value.input_tokens ?? value.input);
    usage.outputTokens += numberValue(value.outputTokens ?? value.output_tokens ?? value.output);
    usage.cacheReadTokens += numberValue(
      value.cacheReadTokens ?? value.cache_read_tokens ?? value.cacheRead,
    );
    usage.cacheWriteTokens += numberValue(
      value.cacheWriteTokens ?? value.cache_write_tokens ?? value.cacheWrite,
    );
    usage.totalTokens += numberValue(value.totalTokens ?? value.total_tokens);
  }
  return found ? usage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sum(values: unknown[]): number {
  return values.map(numberValue).reduce((total: number, value: number) => total + value, 0);
}

function sumNullable(values: unknown[]): number | null {
  const nums = values.filter((value) => typeof value === "number") as number[];
  return nums.length === 0 ? null : nums.reduce((total: number, value: number) => total + value, 0);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
