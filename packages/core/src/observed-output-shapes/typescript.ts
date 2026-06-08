import { OBSERVED_OUTPUT_SHAPE_LIMITS, type JsonShape } from "./types";

export function shapeToTypeScript(
  shape: JsonShape,
  typeName: string = "ObservedOutput",
  maxChars: number = OBSERVED_OUTPUT_SHAPE_LIMITS.maxTypeScriptChars,
): { typeScript: string; truncated: boolean } {
  const body = shapeType(shape);
  const typeScript = `type ${typeName} = ${body};`;
  if (typeScript.length <= maxChars) {
    return { typeScript, truncated: hasTruncatedShape(shape) };
  }
  return { typeScript: `type ${typeName} = unknown;`, truncated: true };
}

export function shapeType(shape: JsonShape): string {
  switch (shape.kind) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "unknown":
      return "unknown";
    case "array":
      return `${shape.element ? wrapArrayElement(shapeType(shape.element)) : "unknown"}[]`;
    case "object":
      return objectType(shape);
    case "union":
      return unionType(shape.variants);
  }
}

export function hasTruncatedShape(shape: JsonShape): boolean {
  if ("truncated" in shape && shape.truncated === true) return true;
  if (shape.kind === "array") return shape.element ? hasTruncatedShape(shape.element) : false;
  if (shape.kind === "object") {
    return Object.values(shape.fields).some((field) => hasTruncatedShape(field.shape));
  }
  if (shape.kind === "union") return shape.variants.some((variant) => hasTruncatedShape(variant));
  return false;
}

function objectType(shape: Extract<JsonShape, { kind: "object" }>): string {
  const entries = Object.entries(shape.fields);
  if (entries.length === 0) return "Record<string, unknown>";
  return `{ ${entries
    .map(([key, field]) => `${propertyName(key)}?: ${shapeType(field.shape)};`)
    .join(" ")} }`;
}

function unionType(variants: JsonShape[]): string {
  const rendered = [...new Set(variants.map((variant) => shapeType(variant)))];
  return rendered.length === 0 ? "unknown" : rendered.join(" | ");
}

function wrapArrayElement(value: string): string {
  return value.includes(" | ") ? `(${value})` : value;
}

function propertyName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key);
}
