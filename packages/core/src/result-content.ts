import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type TextContentBlock = { type: "text"; text: string };

export function structuredOnlyContent(): [] {
  return [];
}

export function textContent(text: string): TextContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function compactJsonText(value: unknown, maxLength = 600): string {
  return compactText(JSON.stringify(value), maxLength);
}

export function compactText(value: string, maxLength = 600): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}

export function resultKeys(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "scalar result";
  }
  const keys = Object.keys(value).filter((key) => key !== "elapsedMs");
  return keys.length > 0 ? `structured keys: ${keys.join(", ")}` : "empty structured result";
}

export function statusSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return compactJsonText(value);
  }
  const record = value as Record<string, unknown>;
  const status = typeof record.status === "number" ? `status ${record.status}` : undefined;
  const statusText =
    typeof record.statusText === "string" && record.statusText ? record.statusText : undefined;
  const exitCode = typeof record.exitCode === "number" ? `exit ${record.exitCode}` : undefined;
  const body = "body" in record ? "body" : undefined;
  const json = "json" in record ? "json" : undefined;
  const stdout = typeof record.stdout === "string" && record.stdout ? "stdout" : undefined;
  const stderr = typeof record.stderr === "string" && record.stderr ? "stderr" : undefined;
  return (
    [status, statusText, exitCode, body, json, stdout, stderr]
      .filter((part): part is string => Boolean(part))
      .join("; ") || resultKeys(record)
  );
}

export function compactStructuredContent(value: unknown): TextContentBlock[] {
  return textContent(statusSummary(value));
}

export function compactCallToolResultContent(result: CallToolResult): TextContentBlock[] {
  if (result.isError === true) {
    return textContent("downstream tool returned an error");
  }
  return compactStructuredContent(result.structuredContent);
}

export function byteLimitHint(maxBytes: number): string {
  return `response body limit ${maxBytes} bytes`;
}
