import { appendFileSync } from "node:fs";
import { estimateTokens } from "./metrics";

function writeMetric(event: Record<string, unknown>) {
  const path = process.env.CAPLETS_PI_EVAL_METRICS;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function byteLength(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Buffer.byteLength(text ?? "", "utf8");
}

function toolNames(payload: any): string[] {
  const tools = payload?.tools ?? payload?.body?.tools ?? payload?.request?.tools ?? [];
  return Array.isArray(tools) ? tools.map((tool) => tool?.name).filter(Boolean) : [];
}

function tools(payload: any): unknown {
  return payload?.tools ?? payload?.body?.tools ?? payload?.request?.tools ?? [];
}

function messageInput(payload: any): unknown[] {
  const value =
    payload?.messages ??
    payload?.body?.messages ??
    payload?.request?.messages ??
    payload?.input ??
    payload?.body?.input ??
    payload?.request?.input ??
    [];
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function instructionPayload(payload: any): unknown[] {
  const values = [
    payload?.instructions,
    payload?.body?.instructions,
    payload?.request?.instructions,
    payload?.system,
    payload?.body?.system,
    payload?.request?.system,
  ].filter((value) => value != null);
  return values;
}

function messageRole(message: any): string | null {
  const role = message?.role ?? message?.message?.role ?? null;
  return typeof role === "string" ? role : null;
}

function messageType(message: any): string | null {
  const type = message?.type ?? message?.message?.type ?? null;
  return typeof type === "string" ? type : null;
}

function addEstimatedTokenBucket(
  buckets: Record<string, number>,
  bucket: string,
  value: unknown,
): void {
  const tokens = estimateTokens(value);
  if (typeof tokens !== "number") return;
  buckets[bucket] = (buckets[bucket] ?? 0) + tokens;
}

function requestTokenBuckets(payload: any, messagePayload: unknown[], toolPayload: unknown) {
  const requestPayloadEstimatedTokens = estimateTokens(payload);
  const toolSurfaceEstimatedTokens = estimateTokens(toolPayload);
  const messagePayloadEstimatedTokens = estimateTokens(messagePayload);
  const buckets: Record<string, number> = {
    requestPayloadEstimatedTokens: requestPayloadEstimatedTokens ?? 0,
    toolSurfaceEstimatedTokens: toolSurfaceEstimatedTokens ?? 0,
    messagePayloadEstimatedTokens: messagePayloadEstimatedTokens ?? 0,
  };

  for (const instruction of instructionPayload(payload)) {
    addEstimatedTokenBucket(buckets, "instructionEstimatedTokens", instruction);
  }
  for (const message of messagePayload) {
    const role = messageRole(message);
    const type = messageType(message);
    if (role === "system" || role === "developer") {
      addEstimatedTokenBucket(buckets, "instructionMessageEstimatedTokens", message);
    } else if (role === "user") {
      addEstimatedTokenBucket(buckets, "userMessageEstimatedTokens", message);
    } else if (role === "assistant") {
      addEstimatedTokenBucket(buckets, "assistantMessageEstimatedTokens", message);
    } else if (
      role === "tool" ||
      role === "toolResult" ||
      type === "function_call_output" ||
      type === "tool_result"
    ) {
      addEstimatedTokenBucket(buckets, "toolResultMessageEstimatedTokens", message);
    } else if (type === "function_call" || type === "tool_call") {
      addEstimatedTokenBucket(buckets, "toolCallMessageEstimatedTokens", message);
    } else {
      addEstimatedTokenBucket(buckets, "otherMessageEstimatedTokens", message);
    }
  }

  const nonSurfaceEstimatedTokens = Math.max(
    0,
    buckets.requestPayloadEstimatedTokens - buckets.toolSurfaceEstimatedTokens,
  );
  const attributedNonSurfaceEstimatedTokens = [
    buckets.messagePayloadEstimatedTokens,
    buckets.instructionEstimatedTokens,
  ].reduce((total, value) => total + (value ?? 0), 0);
  return {
    ...buckets,
    nonSurfaceEstimatedTokens,
    attributedNonSurfaceEstimatedTokens,
    requestOverheadEstimatedTokens: Math.max(
      0,
      nonSurfaceEstimatedTokens - attributedNonSurfaceEstimatedTokens,
    ),
  };
}

function toolResultPreview(event: any) {
  if (event?.result != null) return JSON.stringify(event.result).slice(0, 2000);
  if (event?.content != null) return JSON.stringify(event.content).slice(0, 2000);
  if (event?.output != null) return JSON.stringify(event.output).slice(0, 2000);
  const { input: _input, arguments: _arguments, args: _args, ...rest } = event ?? {};
  return JSON.stringify(rest).slice(0, 2000);
}

export default function piEvalInstrumentation(pi: any) {
  pi.on?.("before_provider_request", (event: any) => {
    const payload = event?.payload ?? event?.request ?? event;
    const messagePayload = messageInput(payload);
    const toolPayload = tools(payload);
    const tokenBuckets = requestTokenBuckets(payload, messagePayload, toolPayload);
    writeMetric({
      type: "before_provider_request",
      provider: event?.provider ?? payload?.provider ?? null,
      model: event?.model ?? payload?.model ?? null,
      requestPayloadBytes: byteLength(payload),
      requestPayloadEstimatedTokens: estimateTokens(payload),
      messagePayloadBytes: byteLength(messagePayload),
      messagePayloadEstimatedTokens: estimateTokens(messagePayload),
      toolSurfaceBytes: byteLength(toolPayload),
      toolSurfaceEstimatedTokens: estimateTokens(toolPayload),
      requestTokenBuckets: tokenBuckets,
      toolNames: toolNames(payload),
    });
  });
  pi.on?.("after_provider_response", (event: any) =>
    writeMetric({
      type: "after_provider_response",
      status: event?.status ?? event?.response?.status ?? null,
      usage: event?.usage ?? event?.response?.usage ?? null,
    }),
  );
  pi.on?.("tool_execution_start", (event: any) =>
    writeMetric({
      type: "tool_execution_start",
      toolName: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
    }),
  );
  pi.on?.("tool_execution_end", (event: any) =>
    writeMetric({
      type: "tool_execution_end",
      toolName: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
      status: event?.status ?? null,
      error: Boolean(event?.error),
    }),
  );
  pi.on?.("tool_result", (event: any) =>
    writeMetric({
      type: "tool_result",
      toolName: event?.toolName ?? event?.tool_name ?? event?.name ?? null,
      resultPreview: toolResultPreview(event),
    }),
  );
}
