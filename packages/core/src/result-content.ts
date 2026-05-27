import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type TextContentBlock = { type: "text"; text: string };

export function structuredOnlyContent(): [] {
  return [];
}

export function textContent(text: string): TextContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function compactJsonText(value: unknown, maxLength = 600): string {
  return compactText(JSON.stringify(value) ?? String(value), maxLength);
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
  const body = "body" in record ? valueSummary("body", record.body) : undefined;
  const json = "json" in record ? valueSummary("json", record.json) : undefined;
  const stdout =
    typeof record.stdout === "string" && record.stdout
      ? valueSummary("stdout", record.stdout)
      : undefined;
  const stderr =
    typeof record.stderr === "string" && record.stderr
      ? valueSummary("stderr", record.stderr)
      : undefined;
  return (
    [status, statusText, exitCode, body, json, stdout, stderr]
      .filter((part): part is string => Boolean(part))
      .join("; ") || resultKeys(record)
  );
}

function valueSummary(label: string, value: unknown): string {
  if (typeof value === "string") {
    return value ? `${label} ${compactText(value, 200)}` : label;
  }
  if (value === undefined) {
    return label;
  }
  return `${label} ${compactJsonText(value, 200)}`;
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
