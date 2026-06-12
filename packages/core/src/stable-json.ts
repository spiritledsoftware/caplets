export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) sorted[key] = stableJsonValue(item);
    }
    return sorted;
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export async function stableJsonSha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJsonStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
