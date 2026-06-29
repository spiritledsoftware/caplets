import { tool } from "@opencode-ai/plugin";
import { operations } from "@caplets/core/generated-tool-input-schema";

type OpenCodeSchema = Parameters<typeof tool>[0]["args"][string];

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
    sessionId: tool.schema.string().optional(),
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
    Object.entries(properties).map(([key, value]) => [
      key,
      jsonSchemaPropertyToOpenCode(value, { optional: true }),
    ]),
  );
}

function jsonSchemaPropertyToOpenCode(
  value: unknown,
  options: { optional: boolean },
): OpenCodeSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return tool.schema.unknown();
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string")) {
    return tool.schema.enum(schema.enum as [string, ...string[]]);
  }
  if (schema.type === "string") {
    const stringSchema = tool.schema.string();
    return options.optional ? stringSchema.optional() : stringSchema;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const numberSchema = tool.schema.number().int().positive();
    return options.optional ? numberSchema.optional() : numberSchema;
  }
  if (schema.type === "boolean" && "boolean" in tool.schema) {
    return (tool.schema as typeof tool.schema & { boolean: () => OpenCodeSchema }).boolean();
  }
  if (schema.type === "object") {
    const objectSchema = tool.schema.record(tool.schema.string(), tool.schema.unknown());
    return options.optional ? objectSchema.optional() : objectSchema;
  }
  if (schema.type === "array") {
    const itemSchema =
      schema.items &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items) &&
      Object.keys(schema.items).length > 0
        ? jsonSchemaPropertyToOpenCode(schema.items, { optional: false })
        : tool.schema.string();
    const arraySchema = tool.schema.array(itemSchema).min(1);
    return options.optional ? arraySchema.optional() : arraySchema;
  }
  return tool.schema.unknown();
}
