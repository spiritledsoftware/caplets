import type { GoogleDiscoverySchema } from "./types";

export function googleDiscoverySchemaToJsonSchema(
  value: GoogleDiscoverySchema | undefined,
  schemas: Record<string, GoogleDiscoverySchema> = {},
  seen = new Set<string>(),
): Record<string, unknown> {
  if (!value) return {};
  if (value.$ref) {
    const target = schemas[value.$ref];
    if (!target || seen.has(value.$ref)) return { type: "object", additionalProperties: true };
    return googleDiscoverySchemaToJsonSchema(target, schemas, new Set([...seen, value.$ref]));
  }

  const type = discoveryTypeToJsonSchemaType(value.type);
  const converted: Record<string, unknown> = {};
  if (value.description) converted.description = collapseWhitespace(value.description);
  if (type) converted.type = type;
  if (value.format) converted.format = value.format;
  if (value.enum) converted.enum = value.enum;
  const defaultValue = convertedDefault(value.default, type);
  if (defaultValue !== undefined) converted.default = defaultValue;

  if (value.repeated) {
    return {
      ...(converted.description ? { description: converted.description } : {}),
      type: "array",
      items: omit(converted, ["description", "default"]),
    };
  }

  if (value.items) converted.items = googleDiscoverySchemaToJsonSchema(value.items, schemas, seen);
  if (value.properties) {
    converted.type = converted.type ?? "object";
    converted.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, schema]) => [
        key,
        googleDiscoverySchemaToJsonSchema(schema, schemas, seen),
      ]),
    );
    converted.additionalProperties = false;
  }
  if (typeof value.additionalProperties === "boolean") {
    converted.additionalProperties = value.additionalProperties;
  } else if (value.additionalProperties) {
    converted.additionalProperties = googleDiscoverySchemaToJsonSchema(
      value.additionalProperties,
      schemas,
      seen,
    );
  }

  return converted;
}

function discoveryTypeToJsonSchemaType(type: string | undefined): string | undefined {
  if (type === "any") return "object";
  return type;
}

function convertedDefault(value: unknown, type: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (type === "boolean" && typeof value === "string") return value === "true";
  if ((type === "integer" || type === "number") && typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function omit(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
