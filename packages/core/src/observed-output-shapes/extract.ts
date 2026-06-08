import {
  OBSERVED_OUTPUT_SHAPE_LIMITS,
  OBSERVED_OUTPUT_SHAPE_VERSION,
  type ExtractObservedOutputShapeInput,
  type JsonShape,
  type ObservedOutputShape,
} from "./types";
import { mergeJsonShapes } from "./merge";
import { hasTruncatedShape, shapeToTypeScript } from "./typescript";

export function observeOutputShape(
  input: ExtractObservedOutputShapeInput,
): ObservedOutputShape | undefined {
  const shape = extractJsonShape(input.value);
  if (!shape) return undefined;
  const merged = input.existing ? mergeJsonShapes(input.existing.jsonShape, shape) : shape;
  const emitted = shapeToTypeScript(merged);
  const observed: ObservedOutputShape = {
    version: OBSERVED_OUTPUT_SHAPE_VERSION,
    source: "observed",
    observedAt: (input.now ?? new Date()).toISOString(),
    sampleCount: (input.existing?.sampleCount ?? 0) + 1,
    typeScript: emitted.typeScript,
    jsonShape: merged,
    truncated: emitted.truncated || hasTruncatedShape(merged),
  };
  return storedBytes(observed) > OBSERVED_OUTPUT_SHAPE_LIMITS.maxStoredJsonBytes
    ? {
        ...observed,
        typeScript: "type ObservedOutput = unknown;",
        jsonShape: { kind: "unknown" },
        truncated: true,
      }
    : observed;
}

export function extractJsonShape(value: unknown): JsonShape | undefined {
  if (!isShapeableJsonRoot(value)) return undefined;
  return shapeFor(value, 0);
}

export function parseShapeableJsonText(value: unknown): unknown | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.content) || value.content.length !== 1) {
    return undefined;
  }
  const [item] = value.content;
  if (!isPlainObject(item) || item.type !== "text" || typeof item.text !== "string") {
    return undefined;
  }
  const text = item.text.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isShapeableJsonRoot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizedObservableValue(result: unknown): unknown | undefined {
  if (isPlainObject(result)) {
    const structured = result.structuredContent;
    if (structured !== undefined) {
      if (isPlainObject(structured) && "caplets" in structured && "result" in structured) {
        return isShapeableJsonRoot(structured.result) ? structured.result : undefined;
      }
      return isShapeableJsonRoot(structured) ? structured : undefined;
    }
  }
  return parseShapeableJsonText(result);
}

function shapeFor(value: unknown, depth: number): JsonShape {
  if (depth >= OBSERVED_OUTPUT_SHAPE_LIMITS.maxDepth) return { kind: "unknown" };
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "string") return { kind: "string" };
  if (Array.isArray(value)) return arrayShape(value, depth);
  if (isPlainObject(value)) return objectShape(value, depth);
  return { kind: "unknown" };
}

function arrayShape(value: unknown[], depth: number): JsonShape {
  const sampled = value.slice(0, OBSERVED_OUTPUT_SHAPE_LIMITS.maxArrayElements);
  let element: JsonShape | undefined;
  for (const item of sampled) {
    const itemShape = shapeFor(item, depth + 1);
    element = element ? mergeJsonShapes(element, itemShape) : itemShape;
  }
  return {
    kind: "array",
    ...(element ? { element } : {}),
    ...(value.length > sampled.length ? { truncated: true } : {}),
  };
}

function objectShape(value: Record<string, unknown>, depth: number): JsonShape {
  const keys = Object.keys(value).sort();
  const selected = keys.slice(0, OBSERVED_OUTPUT_SHAPE_LIMITS.maxObjectFields);
  const fields: Record<string, { optional: boolean; shape: JsonShape }> = {};
  for (const key of selected) {
    fields[key] = { optional: true, shape: shapeFor(value[key], depth + 1) };
  }
  return {
    kind: "object",
    fields,
    ...(keys.length > selected.length ? { truncated: true } : {}),
  };
}

function isShapeableJsonRoot(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
