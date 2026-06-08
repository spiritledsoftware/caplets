import { z } from "zod";

export const operations = [
  "inspect",
  "check",
  "tools",
  "search_tools",
  "describe_tool",
  "call_tool",
] as const;

export const mcpOperations = [
  ...operations,
  "resources",
  "search_resources",
  "resource_templates",
  "read_resource",
  "prompts",
  "search_prompts",
  "get_prompt",
  "complete",
] as const;

export type GeneratedOperation = (typeof operations)[number];
export type GeneratedMcpOperation = (typeof mcpOperations)[number];
export type CapletSchemaBackend = { backend: string };
export type GeneratedToolInputSchemaOptions = {
  includeFields?: boolean;
};

export const generatedToolInputDescriptions = {
  operation:
    "Wrapper operation: inspect, check, tools, search_tools, describe_tool, call_tool, resources, search_resources, resource_templates, read_resource, prompts, search_prompts, get_prompt, complete.",
  query: "Required for search operations only.",
  limit: "Optional list/search result limit.",
  cursor: "Opaque pagination cursor returned by list/search operations.",
  name: "Exact downstream tool or prompt name from tools/search_tools/prompts/search_prompts; do not guess.",
  args: "JSON object for call_tool or get_prompt arguments; must match describe_tool inputSchema exactly.",
  fields:
    "Optional call_tool structured output paths. Use only after describe_tool returns fieldSelection.supported true.",
  uri: "Exact downstream resource URI for read_resource.",
  ref: "Completion target reference for complete.",
  argument: "Completion argument object for complete.",
} as const;

export const completionRefSchema = z.union([
  z.object({ type: z.literal("prompt"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("resourceTemplate"), uri: z.string().min(1) }).strict(),
]);

export const completionArgumentSchema = z
  .object({ name: z.string().min(1), value: z.string() })
  .strict();

const baseShape = {
  query: z.string().optional().describe(generatedToolInputDescriptions.query),
  limit: z.number().int().positive().optional().describe(generatedToolInputDescriptions.limit),
  cursor: z.string().optional().describe(generatedToolInputDescriptions.cursor),
  name: z.string().optional().describe(generatedToolInputDescriptions.name),
  args: z.object({}).catchall(z.any()).optional().describe(generatedToolInputDescriptions.args),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(generatedToolInputDescriptions.fields),
};

export function generatedToolInputSchemaForCaplet(
  caplet: CapletSchemaBackend,
  options: GeneratedToolInputSchemaOptions = {},
) {
  const includeFields = options.includeFields ?? true;
  return z
    .object({
      operation: (caplet.backend === "mcp" ? z.enum(mcpOperations) : z.enum(operations)).describe(
        generatedToolInputDescriptions.operation,
      ),
      ...schemaShape(includeFields),
      ...(caplet.backend === "mcp"
        ? {
            uri: z.string().optional().describe(generatedToolInputDescriptions.uri),
            ref: completionRefSchema.optional().describe(generatedToolInputDescriptions.ref),
            argument: completionArgumentSchema
              .optional()
              .describe(generatedToolInputDescriptions.argument),
          }
        : {}),
    })
    .strict();
}

export const generatedToolInputSchema = z
  .object({
    operation: z.enum(operations).describe(generatedToolInputDescriptions.operation),
    ...baseShape,
  })
  .strict();

export function generatedToolInputJsonSchemaForCaplet(
  caplet: CapletSchemaBackend,
  options: GeneratedToolInputSchemaOptions = {},
) {
  const mcp = caplet.backend === "mcp";
  const includeFields = options.includeFields ?? true;
  return {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: mcp ? mcpOperations : operations,
        description: generatedToolInputDescriptions.operation,
      },
      query: { type: "string", description: generatedToolInputDescriptions.query },
      limit: { type: "integer", minimum: 1, description: generatedToolInputDescriptions.limit },
      cursor: { type: "string", description: generatedToolInputDescriptions.cursor },
      name: { type: "string", description: generatedToolInputDescriptions.name },
      args: { type: "object", description: generatedToolInputDescriptions.args },
      ...(includeFields
        ? {
            fields: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              description: generatedToolInputDescriptions.fields,
            },
          }
        : {}),
      ...(mcp
        ? {
            uri: { type: "string", description: generatedToolInputDescriptions.uri },
            ref: {
              oneOf: [
                {
                  type: "object",
                  properties: { type: { const: "prompt" }, name: { type: "string", minLength: 1 } },
                  required: ["type", "name"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "resourceTemplate" },
                    uri: { type: "string", minLength: 1 },
                  },
                  required: ["type", "uri"],
                  additionalProperties: false,
                },
              ],
              description: generatedToolInputDescriptions.ref,
            },
            argument: {
              type: "object",
              properties: { name: { type: "string", minLength: 1 }, value: { type: "string" } },
              required: ["name", "value"],
              additionalProperties: false,
              description: generatedToolInputDescriptions.argument,
            },
          }
        : {}),
    },
    required: ["operation"],
    additionalProperties: false,
  } as const;
}

function schemaShape(includeFields: boolean) {
  return includeFields
    ? baseShape
    : {
        query: baseShape.query,
        limit: baseShape.limit,
        cursor: baseShape.cursor,
        name: baseShape.name,
        args: baseShape.args,
      };
}

export function generatedToolInputJsonSchema() {
  return generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
}
