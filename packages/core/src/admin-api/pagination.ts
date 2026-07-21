import { CapletsError } from "../errors";
import type { z } from "zod";

export type CursorPage<T> = {
  items: T[];
  nextCursor?: string;
};

export type CursorDirection = "asc" | "desc";

export type CursorJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CursorJsonValue[]
  | { readonly [key: string]: CursorJsonValue };

export type CursorCodec<TStableKey> = {
  encode(lastKey: TStableKey): string;
  decode(cursor: string): TStableKey;
};

export type CursorCodecOptions<TStableKeySchema extends z.ZodType> = {
  route: string;
  filters: { readonly [key: string]: CursorJsonValue };
  direction: CursorDirection;
  stableKeySchema: TStableKeySchema;
};

const CURSOR_VERSION = 1;
const INVALID_CURSOR_MESSAGE = "Invalid pagination cursor.";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENVELOPE_KEYS = ["direction", "filters", "lastKey", "route", "version"] as const;

type CursorEnvelope = {
  version: typeof CURSOR_VERSION;
  route: string;
  filters: CursorJsonValue;
  direction: CursorDirection;
  lastKey: CursorJsonValue;
};

export function createCursorCodec<TStableKeySchema extends z.ZodType>(
  options: CursorCodecOptions<TStableKeySchema>,
): CursorCodec<z.output<TStableKeySchema>> {
  const normalizedFilters = canonicalizeJson(options.filters);
  const normalizedFiltersJson = JSON.stringify(normalizedFilters);

  return {
    encode(lastKey) {
      const parsedKey = options.stableKeySchema.safeParse(lastKey);
      if (!parsedKey.success) throw invalidCursor();

      const envelope: CursorEnvelope = {
        version: CURSOR_VERSION,
        route: options.route,
        filters: normalizedFilters,
        direction: options.direction,
        lastKey: canonicalizeJson(parsedKey.data),
      };
      return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    },

    decode(cursor) {
      try {
        if (!BASE64URL_PATTERN.test(cursor)) throw invalidCursor();
        const bytes = Buffer.from(cursor, "base64url");
        if (bytes.toString("base64url") !== cursor) throw invalidCursor();

        const envelope: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isRecord(envelope) || !hasExactEnvelopeKeys(envelope)) throw invalidCursor();
        if (
          envelope.version !== CURSOR_VERSION ||
          envelope.route !== options.route ||
          envelope.direction !== options.direction ||
          JSON.stringify(canonicalizeJson(envelope.filters)) !== normalizedFiltersJson
        ) {
          throw invalidCursor();
        }

        const parsedKey = options.stableKeySchema.safeParse(envelope.lastKey);
        if (!parsedKey.success) throw invalidCursor();
        return parsedKey.data;
      } catch {
        throw invalidCursor();
      }
    },
  };
}

function canonicalizeJson(value: unknown): CursorJsonValue {
  const ancestors = new Set<object>();

  function visit(current: unknown): CursorJsonValue {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) return current;
      throw invalidCursor();
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw invalidCursor();
      ancestors.add(current);
      try {
        return current.map((item) => visit(item));
      } finally {
        ancestors.delete(current);
      }
    }
    if (isRecord(current)) {
      if (ancestors.has(current)) throw invalidCursor();
      ancestors.add(current);
      try {
        const normalized = Object.create(null) as Record<string, CursorJsonValue>;
        for (const key of Object.keys(current).sort()) normalized[key] = visit(current[key]);
        return normalized;
      } finally {
        ancestors.delete(current);
      }
    }
    throw invalidCursor();
  }

  return visit(value);
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === ENVELOPE_KEYS.length && keys.every((key, index) => key === ENVELOPE_KEYS[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCursor(): CapletsError {
  return new CapletsError("REQUEST_INVALID", INVALID_CURSOR_MESSAGE);
}
