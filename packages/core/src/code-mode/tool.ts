import { z } from "zod";
import type { CodeModeRunMeta } from "./types";

export const codeModeRunInputSchema = z.object({
  code: z.string().describe("TypeScript Code Mode source to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional execution timeout in milliseconds."),
  sessionId: z.string().min(1).optional().describe("Optional Code Mode session identifier."),
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
      sessionId: {
        type: "string",
        minLength: 1,
        description: "Optional Code Mode session identifier.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  };
}

export function isCodeModeRunRequest(value: unknown): boolean {
  return codeModeRunInputSchema.safeParse(value).success;
}

export function emptyCodeModeRunMeta(): CodeModeRunMeta {
  return {
    runId: "",
    traceId: "",
    declarationHash: "",
    durationMs: 0,
    timeoutMs: 0,
    maxTimeoutMs: 0,
    sessionId: null,
    sessionStatus: null,
    recoveryRef: null,
    recoveryCommand: null,
  };
}
