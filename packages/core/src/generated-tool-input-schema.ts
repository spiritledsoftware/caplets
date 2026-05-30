import { z } from "zod";

export const operations = [
  "inspect",
  "check_backend",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
] as const;

export const mcpOperations = [
  ...operations,
  "list_resources",
  "search_resources",
  "list_resource_templates",
  "read_resource",
  "list_prompts",
  "search_prompts",
  "get_prompt",
  "complete",
] as const;

export type GeneratedOperation = (typeof operations)[number];
export type GeneratedMcpOperation = (typeof mcpOperations)[number];
export type CapletSchemaBackend = { backend: string };

export const generatedToolInputDescriptions = {
  operation:
    "Wrapper operation: inspect, check_backend, list_tools, search_tools, get_tool, call_tool. MCP Caplets also expose resources, prompts, and completions.",
  query: "Required for search operations only.",
  limit: "Optional list/search result limit.",
  tool: "Exact downstream tool name for get_tool or call_tool.",
  arguments: "JSON object for call_tool arguments/downstream inputs or get_prompt arguments.",
  fields: "Optional call_tool structured output paths when outputSchema allows it.",
  uri: "Exact downstream resource URI for read_resource.",
  prompt: "Exact downstream prompt name for get_prompt.",
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
  tool: z.string().optional().describe(generatedToolInputDescriptions.tool),
  arguments: z
    .object({})
    .catchall(z.any())
    .optional()
    .describe(generatedToolInputDescriptions.arguments),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(generatedToolInputDescriptions.fields),
};

export function generatedToolInputSchemaForCaplet(caplet: CapletSchemaBackend) {
  return z
    .object({
      operation: (caplet.backend === "mcp" ? z.enum(mcpOperations) : z.enum(operations)).describe(
        generatedToolInputDescriptions.operation,
      ),
      ...baseShape,
      ...(caplet.backend === "mcp"
        ? {
            uri: z.string().optional().describe(generatedToolInputDescriptions.uri),
            prompt: z.string().optional().describe(generatedToolInputDescriptions.prompt),
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

export function generatedToolInputJsonSchemaForCaplet(caplet: CapletSchemaBackend) {
  const mcp = caplet.backend === "mcp";
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
      tool: { type: "string", description: generatedToolInputDescriptions.tool },
      arguments: { type: "object", description: generatedToolInputDescriptions.arguments },
      fields: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: generatedToolInputDescriptions.fields,
      },
      ...(mcp
        ? {
            uri: { type: "string", description: generatedToolInputDescriptions.uri },
            prompt: { type: "string", description: generatedToolInputDescriptions.prompt },
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

export function generatedToolInputJsonSchema() {
  return generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
}
