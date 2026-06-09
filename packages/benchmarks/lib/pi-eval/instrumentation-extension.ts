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

function messages(payload: any): unknown {
  return payload?.messages ?? payload?.body?.messages ?? payload?.request?.messages ?? [];
}

function tools(payload: any): unknown {
  return payload?.tools ?? payload?.body?.tools ?? payload?.request?.tools ?? [];
}

export default function piEvalInstrumentation(pi: any) {
  pi.on?.("before_provider_request", (event: any) => {
    const payload = event?.payload ?? event?.request ?? event;
    const messagePayload = messages(payload);
    const toolPayload = tools(payload);
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
      resultPreview: JSON.stringify(event?.result ?? event).slice(0, 2000),
    }),
  );
}
