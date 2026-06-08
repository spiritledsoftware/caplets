import { OBSERVED_OUTPUT_SHAPE_LIMITS, type JsonShape } from "./types";

export function mergeJsonShapes(left: JsonShape, right: JsonShape): JsonShape {
  if (left.kind === "unknown" || right.kind === "unknown") return { kind: "unknown" };
  if (left.kind === right.kind) {
    if (left.kind === "object" && right.kind === "object") return mergeObjects(left, right);
    if (left.kind === "array" && right.kind === "array") return mergeArrays(left, right);
    if (left.kind === "union" && right.kind === "union") {
      return boundedUnion([...left.variants, ...right.variants]);
    }
    return left;
  }
  return boundedUnion([
    ...(left.kind === "union" ? left.variants : [left]),
    ...(right.kind === "union" ? right.variants : [right]),
  ]);
}

function mergeObjects(
  left: Extract<JsonShape, { kind: "object" }>,
  right: Extract<JsonShape, { kind: "object" }>,
): JsonShape {
  const fields: Record<string, { optional: boolean; shape: JsonShape }> = {};
  const keys = [...new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])].sort();
  let truncated = left.truncated === true || right.truncated === true;
  const selected = keys.slice(0, OBSERVED_OUTPUT_SHAPE_LIMITS.maxObjectFields);
  truncated = truncated || keys.length > selected.length;
  for (const key of selected) {
    const leftField = left.fields[key];
    const rightField = right.fields[key];
    if (leftField && rightField) {
      fields[key] = {
        optional: true,
        shape: mergeJsonShapes(leftField.shape, rightField.shape),
      };
    } else {
      fields[key] = {
        optional: true,
        shape: (leftField ?? rightField)!.shape,
      };
    }
  }
  return { kind: "object", fields, ...(truncated ? { truncated: true } : {}) };
}

function mergeArrays(
  left: Extract<JsonShape, { kind: "array" }>,
  right: Extract<JsonShape, { kind: "array" }>,
): JsonShape {
  const element =
    left.element && right.element
      ? mergeJsonShapes(left.element, right.element)
      : (left.element ?? right.element);
  return {
    kind: "array",
    ...(element ? { element } : {}),
    ...(left.truncated === true || right.truncated === true ? { truncated: true } : {}),
  };
}

function boundedUnion(variants: JsonShape[]): JsonShape {
  const flattened = variants.flatMap((variant) =>
    variant.kind === "union" ? variant.variants : [variant],
  );
  const unique: JsonShape[] = [];
  for (const variant of flattened) {
    if (variant.kind === "unknown") return { kind: "unknown" };
    const key = JSON.stringify(variant);
    if (!unique.some((existing) => JSON.stringify(existing) === key)) unique.push(variant);
  }
  if (unique.length === 1) return unique[0]!;
  if (unique.length > OBSERVED_OUTPUT_SHAPE_LIMITS.maxUnionVariants) return { kind: "unknown" };
  return { kind: "union", variants: unique.sort((a, b) => a.kind.localeCompare(b.kind)) };
}
