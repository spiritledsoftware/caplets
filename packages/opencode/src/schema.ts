import { tool } from "@opencode-ai/plugin";
import { operations } from "@caplets/core/generated-tool-input-schema";

export function capletsOpenCodeArgs(operationNames: string[] = [...operations]) {
  const enumValues = operationNames.length > 0 ? operationNames : [...operations];
  return {
    operation: tool.schema.enum(enumValues as [string, ...string[]]),
    query: tool.schema.string().optional(),
    limit: tool.schema.number().int().positive().optional(),
    tool: tool.schema.string().optional(),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    fields: tool.schema.array(tool.schema.string().min(1)).min(1).optional(),
    uri: tool.schema.string().optional(),
    prompt: tool.schema.string().optional(),
    ref: tool.schema
      .union([
        tool.schema
          .object({ type: tool.schema.literal("prompt"), name: tool.schema.string().min(1) })
          .strict(),
        tool.schema
          .object({
            type: tool.schema.literal("resourceTemplate"),
            uri: tool.schema.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    argument: tool.schema
      .object({ name: tool.schema.string().min(1), value: tool.schema.string() })
      .strict()
      .optional(),
  };
}

export function capletsOpenCodeRunArgs() {
  return {
    code: tool.schema.string(),
    timeoutMs: tool.schema.number().int().positive().optional(),
    reuse: tool.schema
      .object({
        sessionId: tool.schema.string().min(1),
      })
      .strict()
      .optional(),
  };
}

export function capletsOpenCodeJsonSchemaArgs(schema: Record<string, unknown> | undefined) {
  const properties =
    schema &&
    typeof schema.properties === "object" &&
    schema.properties &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  if (Object.keys(properties).length === 0) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, jsonSchemaPropertyToOpenCode(value)]),
  );
}

function jsonSchemaPropertyToOpenCode(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return tool.schema.unknown();
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    return tool.schema.enum(schema.enum as [string, ...string[]]);
  }
  if (schema.type === "string") return tool.schema.string().optional();
  if (schema.type === "number" || schema.type === "integer") {
    return tool.schema.number().int().positive().optional();
  }
  if (schema.type === "boolean" && "boolean" in tool.schema) {
    return (tool.schema as typeof tool.schema & { boolean: () => unknown }).boolean();
  }
  if (schema.type === "object") {
    return tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional();
  }
  if (schema.type === "array") {
    return tool.schema.array(tool.schema.unknown()).min(1).optional();
  }
  return tool.schema.unknown();
}
