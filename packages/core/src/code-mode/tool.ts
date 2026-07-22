import { z } from "zod";
import { ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS } from "./runner";
import type { CodeModeRunMeta } from "./types";

export const CODE_MODE_SESSION_ID_DESCRIPTION =
  "Optional Code Mode session identifier. Omit to create a fresh reusable session; pass a known live session ID from meta.sessionId to reuse existing REPL state. Unknown or unavailable session IDs fail before code execution instead of starting an empty context.";

export const codeModeRunInputSchema = z.object({
  code: z.string().describe("TypeScript Code Mode source to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS)
    .optional()
    .describe("Optional execution timeout in milliseconds."),
  sessionId: z.string().min(1).optional().describe(CODE_MODE_SESSION_ID_DESCRIPTION),
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
        maximum: ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS,
        description: "Optional execution timeout in milliseconds.",
      },
      sessionId: {
        type: "string",
        minLength: 1,
        description: CODE_MODE_SESSION_ID_DESCRIPTION,
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
    anyCapletInvoked: false,
    sessionId: null,
    sessionStatus: null,
    recoveryRef: null,
  };
}
