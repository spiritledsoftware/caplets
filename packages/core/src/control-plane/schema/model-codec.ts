import { stableJsonStringify } from "../../stable-json";
const SAFE_SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const SAFE_CAPLETS_INTERNAL_IDENTIFIER = /^__caplets_[a-z0-9_]{1,52}$/u;

export type CanonicalSqlJson =
  | null
  | boolean
  | number
  | string
  | CanonicalSqlJson[]
  | { [key: string]: CanonicalSqlJson };

export function encodeCanonicalJson(value: unknown): string {
  assertCanonicalJson(value);
  return stableJsonStringify(value);
}

export function decodeCanonicalJson(value: string): CanonicalSqlJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored canonical JSON is invalid");
  }
  assertCanonicalJson(parsed);
  if (encodeCanonicalJson(parsed) !== value) {
    throw new Error("Stored JSON is not canonically encoded");
  }
  return parsed;
}

export function encodeCanonicalBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error("Canonical bytes must be a non-empty Uint8Array");
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function decodeCanonicalBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error("Stored canonical bytes are invalid");
  }
  return new Uint8Array(value);
}

export function encodeCanonicalTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Canonical timestamp is invalid");
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new Error("Canonical timestamp must use ISO UTC millisecond form");
  return canonical;
}

export function decodeCanonicalTimestamp(value: string): string {
  return encodeCanonicalTimestamp(value);
}

export function encodeCanonicalVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Canonical version must be a non-negative safe integer");
  }
  return value;
}

export function decodeCanonicalVersion(value: number | bigint): number {
  const decoded = typeof value === "bigint" ? Number(value) : value;
  return encodeCanonicalVersion(decoded);
}

export function assertSafeSqlIdentifier(value: string, label = "SQL identifier"): string {
  const safe = SAFE_SQL_IDENTIFIER.test(value) || SAFE_CAPLETS_INTERNAL_IDENTIFIER.test(value);
  if (!safe || value.startsWith("pg_")) {
    throw new Error(`${label} is unsafe`);
  }
  return value;
}

export function quoteSafeSqlIdentifier(value: string): string {
  return `"${assertSafeSqlIdentifier(value)}"`;
}

export function fixedPostgresSearchPath(schema: string): string {
  return `${quoteSafeSqlIdentifier(schema)}, pg_catalog`;
}

function assertCanonicalJson(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): asserts value is CanonicalSqlJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Canonical JSON number at ${path} is not finite`);
    return;
  }
  if (typeof value !== "object") throw new Error(`Canonical JSON value at ${path} is unsupported`);
  if (seen.has(value)) throw new Error(`Canonical JSON value at ${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      assertCanonicalJson(item, `${path}[${index}]`, seen);
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Canonical JSON object at ${path} is not plain`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined)
        throw new Error(`Canonical JSON value at ${path}.${key} is undefined`);
      assertCanonicalJson(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
