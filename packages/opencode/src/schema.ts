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
    ref: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    argument: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
  };
}
