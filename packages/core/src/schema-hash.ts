import { createHash } from "node:crypto";

export function schemaHash(schema: unknown | undefined): string | null {
  if (schema === undefined || schema === null) {
    return null;
  }
  const json = JSON.stringify(stableJsonValue(schema));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = stableJsonValue(item);
      }
    }
    return sorted;
  }
  return value;
}
