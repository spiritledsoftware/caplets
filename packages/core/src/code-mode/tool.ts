import { z } from "zod";

export const codeModeRunInputSchema = z.object({
  code: z.string().describe("TypeScript Code Mode source to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional execution timeout in milliseconds."),
});

export const codeModeRunParamsSchema = codeModeRunInputSchema.shape;

export function codeModeRunInputJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "TypeScript Code Mode source to execute.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        description: "Optional execution timeout in milliseconds.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  };
}

export function isCodeModeRunRequest(value: unknown): boolean {
  return codeModeRunInputSchema.safeParse(value).success;
}
