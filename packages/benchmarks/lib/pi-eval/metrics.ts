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

export function summarizePiEvalMetrics(events: any[] = [], jsonEvents: any[] = []) {
  const providerRequests = events.filter((event) => event.type === "before_provider_request");
  const providerResponses = events.filter((event) => event.type === "after_provider_response");
  const toolEvents = [...events, ...jsonEvents].filter((event) =>
    String(event.type ?? event.event ?? "").includes("tool"),
  );
  const toolStartEvents = [...events, ...jsonEvents].filter(
    (event) => String(event.type ?? event.event ?? "") === "tool_execution_start",
  );
  const toolCallNames = toolStartEvents.map(toolNameFromEvent).filter(Boolean) as string[];
  const domainCoverage = computeDomainCoverage([...events, ...jsonEvents]);
  const latestRequest = providerRequests.at(-1) ?? null;
  const requestPayloadEstimatedTokens = sumNullable(
    providerRequests.map((event) => event.requestPayloadEstimatedTokens),
  );
  const toolSurfaceEstimatedTokens = sumNullable(
    providerRequests.map((event) => event.toolSurfaceEstimatedTokens),
  );
  return {
    tokenizer: TOKENIZER_INFO,
    providerRequestCount: providerRequests.length,
    providerResponseCount: providerResponses.length,
    toolCallCount: toolCallNames.length,
    toolEventCount: toolEvents.length,
    toolNames: toolCallNames,
    domainCoverage,
    hybridChoice: classifyHybridChoice(toolCallNames),
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
    providerUsage: mergeUsage(events),
    resolvedModel: latestRequest?.model ?? null,
  };
}

export function computeDomainCoverage(events: any[] = []) {
  const domains = { issues: false, ci: false, docs: false, api: false, codeMap: false };
  const serialized = events
    .map((event) => JSON.stringify(event))
    .join("\n")
    .toLowerCase();
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

export function classifyHybridChoice(toolNames: string[]) {
  const usedCodeMode = toolNames.some(
    (name) => name === "caplets_code_mode" || name.includes("caplets_code_mode"),
  );
  const usedDirect = toolNames.some((name) => name.startsWith("caplets__"));
  const usedProgressive = toolNames.some((name) => /^caplets_(?!code_mode\b)/u.test(name));
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

function mergeUsage(events: any[]) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  let found = false;
  for (const event of events) {
    const value = event.usage ?? event.response?.usage ?? event.message?.usage;
    if (!value || typeof value !== "object") continue;
    found = true;
    usage.inputTokens += numberValue(
      value.inputTokens ?? value.input_tokens ?? value.prompt_tokens,
    );
    usage.outputTokens += numberValue(
      value.outputTokens ?? value.output_tokens ?? value.completion_tokens,
    );
    usage.cacheReadTokens += numberValue(value.cacheReadTokens ?? value.cache_read_tokens);
    usage.cacheWriteTokens += numberValue(value.cacheWriteTokens ?? value.cache_write_tokens);
    usage.totalTokens += numberValue(value.totalTokens ?? value.total_tokens);
  }
  return found ? usage : null;
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
