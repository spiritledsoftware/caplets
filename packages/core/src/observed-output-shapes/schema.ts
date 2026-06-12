export function usefulOutputSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (Object.keys(schema).length === 0) return false;
  if ("const" in schema || Array.isArray(schema.enum)) return true;
  const type = schema.type;
  if (Array.isArray(type))
    return type.some((item) => usefulOutputSchema({ ...schema, type: item }));
  if (type === "object" || isPlainObject(schema.properties)) {
    if (isPlainObject(schema.properties) && Object.keys(schema.properties).length > 0) return true;
    if (schema.additionalProperties === false) return true;
    if (isPlainObject(schema.additionalProperties)) return true;
    return false;
  }
  if (type === "array") return usefulOutputSchema(schema.items);
  if (typeof type === "string") return true;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
