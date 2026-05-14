import { CapletsError } from "./errors.js";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
};

type JsonObject = Record<string, unknown>;

export function projectStructuredContent(
  value: unknown,
  outputSchema: unknown,
  fields: string[],
): JsonObject {
  validateFieldSelection(outputSchema, fields);
  if (!isPlainObject(value)) {
    throwInvalid("Field selection requires object structured content");
  }

  const result = createJsonObject();
  for (const field of fields) {
    const path = field.split(".");
    const projected = projectPath(value, outputSchema, path);
    if (projected !== undefined) {
      mergeValue(result, projected);
    }
  }
  return result;
}

export function validateFieldSelection(outputSchema: unknown, fields: string[]): void {
  if (!isPlainObject(outputSchema)) {
    throwInvalid("Field selection requires an output schema");
  }
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) {
    throwInvalid("Field selection requires an array of field paths");
  }
  for (const field of fields) {
    validateSchemaPath(outputSchema, field.split("."), field);
  }
}

function validateSchemaPath(schema: JsonSchema, path: string[], field: string): void {
  let current: JsonSchema | undefined = schema;

  for (const segment of path) {
    if (!isSupportedSegment(segment)) {
      throwInvalid(`Unsupported field selection path: ${field}`);
    }

    if (current?.type === "array") {
      current = Array.isArray(current.items) ? undefined : current.items;
    }

    current = getOwnSchemaProperty(current?.properties, segment);
    if (!current) {
      throwInvalid(`Field is not allowed by output schema: ${field}`);
    }
  }
}

function getOwnSchemaProperty(
  properties: Record<string, JsonSchema> | undefined,
  segment: string,
): JsonSchema | undefined {
  if (!properties || !Object.prototype.hasOwnProperty.call(properties, segment)) {
    return undefined;
  }
  return properties[segment];
}

function projectPath(value: unknown, schema: unknown, path: string[]): unknown {
  if (path.length === 0) {
    return pruneToSchema(value, schema);
  }
  if (Array.isArray(value)) {
    const itemSchema = arrayItemSchema(schema);
    return value.map((item) => projectPath(item, itemSchema, path) ?? {});
  }
  const segment = path[0]!;
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, segment)) {
    return undefined;
  }

  const rest = path.slice(1);
  const propertySchema = getSchemaProperty(schema, segment);
  const projected = projectPath(value[segment], propertySchema, rest);
  if (projected === undefined) {
    return undefined;
  }
  return { [segment]: projected };
}

function pruneToSchema(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) {
    const itemSchema = arrayItemSchema(schema);
    return value.map((item) => pruneToSchema(item, itemSchema));
  }
  if (!isPlainObject(value)) {
    return cloneJsonValue(value);
  }

  const properties = isPlainObject(schema)
    ? (schema.properties as Record<string, unknown> | undefined)
    : undefined;
  if (!isPlainObject(properties)) {
    return cloneJsonValue(value);
  }

  const result = createJsonObject();
  for (const [key, nestedSchema] of Object.entries(properties)) {
    if (isSupportedSegment(key) && Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = pruneToSchema(value[key], nestedSchema);
    }
  }
  return result;
}

function getSchemaProperty(schema: unknown, segment: string): unknown {
  const properties = isPlainObject(schema)
    ? (schema.properties as Record<string, unknown> | undefined)
    : undefined;
  if (!properties || !Object.prototype.hasOwnProperty.call(properties, segment)) {
    return undefined;
  }
  return properties[segment];
}

function arrayItemSchema(schema: unknown): unknown {
  if (!isPlainObject(schema) || Array.isArray(schema.items)) {
    return undefined;
  }
  return schema.items;
}

function mergeValue(target: JsonObject, value: unknown): void {
  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isSupportedSegment(key)) {
      continue;
    }
    target[key] = mergeNested(target[key], nested);
  }
}

function mergeNested(existing: unknown, next: unknown): unknown {
  if (next === undefined) {
    return existing;
  }
  if (Array.isArray(existing) && Array.isArray(next)) {
    return Array.from({ length: Math.max(existing.length, next.length) }, (_, index) =>
      mergeNested(existing[index], next[index]),
    );
  }
  if (isPlainObject(existing) && isPlainObject(next)) {
    const merged = Object.assign(createJsonObject(), existing);
    mergeValue(merged, next);
    return merged;
  }
  return next;
}

function isSupportedSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "*" &&
    segment !== "__proto__" &&
    segment !== "prototype" &&
    segment !== "constructor" &&
    !/^\d+$/.test(segment)
  );
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createJsonObject(): JsonObject {
  return Object.create(null) as JsonObject;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isPlainObject(value)) {
    const result = createJsonObject();
    for (const [key, nested] of Object.entries(value)) {
      if (isSupportedSegment(key)) {
        result[key] = cloneJsonValue(nested);
      }
    }
    return result;
  }
  return value;
}

function throwInvalid(message: string): never {
  throw new CapletsError("REQUEST_INVALID", message);
}
