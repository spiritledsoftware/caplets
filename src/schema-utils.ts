export function nestedSchema<T>(value: unknown, key: string): T | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return value[key] as T | undefined;
}

export function schemaPath<T>(value: unknown, path: string[]): T | undefined {
  let current = value;
  for (const segment of path) {
    current = nestedSchema(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
