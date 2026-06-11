import type { NativeCapletsService } from "../native/service";
import type {
  CapletsResult,
  CodeModeCallableCaplet,
  Page,
  PageInput,
  ReadLogsInput,
  ReadLogsResult,
  ToolCallError,
  ToolCallMeta,
  ToolCallResult,
} from "./types";

const MAX_TOOL_TEXT_CHARS = 2_000;
const MAX_ERROR_MESSAGE_CHARS = 1_000;

export type CodeModeCapletHandle = {
  readonly id: string;
  inspect(): Promise<unknown>;
  check(): Promise<CapletsResult<unknown>>;
  tools(input?: PageInput): Promise<Page<unknown>>;
  searchTools(query: string, input?: PageInput): Promise<Page<unknown>>;
  describeTool(name: string): Promise<CapletsResult<unknown>>;
  callTool(name: string, args?: unknown): Promise<ToolCallResult>;
  resources(input?: PageInput): Promise<Page<unknown>>;
  searchResources(query: string, input?: PageInput): Promise<Page<unknown>>;
  resourceTemplates(input?: PageInput): Promise<Page<unknown>>;
  readResource(uri: string): Promise<CapletsResult<unknown>>;
  prompts(input?: PageInput): Promise<Page<unknown>>;
  searchPrompts(query: string, input?: PageInput): Promise<Page<unknown>>;
  getPrompt(name: string, args?: unknown): Promise<CapletsResult<unknown>>;
  complete(input: unknown): Promise<CapletsResult<unknown>>;
};

export type CodeModeDebugApi = {
  readLogs(input: ReadLogsInput): Promise<ReadLogsResult>;
};

export type CodeModeCapletsApi = {
  [capletId: string]:
    | CodeModeCapletHandle
    | CodeModeDebugApi
    | (CodeModeCapletHandle & CodeModeDebugApi);
  debug: CodeModeDebugApi | (CodeModeCapletHandle & CodeModeDebugApi);
};

export type CreateCodeModeCapletsApiInput = {
  service: NativeCapletsService;
  readLogs?: (input: ReadLogsInput) => Promise<ReadLogsResult>;
};

export function listCodeModeCallableCaplets(
  service: NativeCapletsService,
): CodeModeCallableCaplet[] {
  return service
    .listTools()
    .filter((tool) => tool.codeModeRun !== true)
    .map((tool) => ({
      id: tool.caplet,
      name: tool.title,
      description: tool.description,
      ...(tool.useWhen ? { useWhen: tool.useWhen } : {}),
      ...(tool.avoidWhen ? { avoidWhen: tool.avoidWhen } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function createCodeModeCapletsApi(input: CreateCodeModeCapletsApiInput): CodeModeCapletsApi {
  const api: Record<
    string,
    CodeModeCapletHandle | CodeModeDebugApi | (CodeModeCapletHandle & CodeModeDebugApi)
  > = {};
  for (const caplet of listCodeModeCallableCaplets(input.service)) {
    api[caplet.id] = createHandle(input.service, caplet.id);
  }

  const debugApi: CodeModeDebugApi = {
    readLogs: input.readLogs ?? defaultReadLogs,
  };
  api.debug =
    "debug" in api ? Object.assign(api.debug as CodeModeCapletHandle, debugApi) : debugApi;

  return api as CodeModeCapletsApi;
}

function createHandle(service: NativeCapletsService, capletId: string): CodeModeCapletHandle {
  return {
    id: capletId,
    async inspect() {
      return unwrapStructuredResult(await service.execute(capletId, { operation: "inspect" }));
    },
    async check() {
      return await checkResultFromExecution(service, capletId);
    },
    async tools(input?: PageInput) {
      return toolPageFromResult(
        unwrapStructuredResult(await service.execute(capletId, { operation: "tools", ...input })),
      );
    },
    async searchTools(query: string, input?: PageInput) {
      return toolPageFromResult(
        unwrapStructuredResult(
          await service.execute(capletId, { operation: "search_tools", query, ...input }),
        ),
      );
    },
    async describeTool(name: string) {
      const result = await resultFromExecution(service, capletId, {
        operation: "describe_tool",
        name,
      });
      return result.ok ? { ...result, data: normalizeToolDescriptor(result.data, name) } : result;
    },
    async callTool(name: string, args?: unknown) {
      const started = Date.now();
      try {
        const result = await service.execute(capletId, {
          operation: "call_tool",
          name,
          args: args ?? {},
        });
        const meta = toolCallMeta(result, {
          capletId,
          tool: name,
          durationMs: Date.now() - started,
        });
        if (resultIsError(result)) {
          return {
            ok: false,
            error: toolCallError(result),
            meta,
          };
        }
        return { ok: true, data: normalizeToolCallData(result), meta };
      } catch (error) {
        return {
          ok: false,
          error: errorFromCaught(error, "tool_call_failed"),
          meta: { capletId, tool: name, durationMs: Date.now() - started },
        };
      }
    },
    async resources(input?: PageInput) {
      return pageFromResult(
        unwrapStructuredResult(
          await service.execute(capletId, { operation: "resources", ...input }),
        ),
      );
    },
    async searchResources(query: string, input?: PageInput) {
      return pageFromResult(
        unwrapStructuredResult(
          await service.execute(capletId, { operation: "search_resources", query, ...input }),
        ),
      );
    },
    async resourceTemplates(input?: PageInput) {
      return pageFromResult(
        unwrapStructuredResult(
          await service.execute(capletId, { operation: "resource_templates", ...input }),
        ),
      );
    },
    async readResource(uri: string) {
      return await resultFromExecution(service, capletId, { operation: "read_resource", uri });
    },
    async prompts(input?: PageInput) {
      return pageFromResult(
        unwrapStructuredResult(await service.execute(capletId, { operation: "prompts", ...input })),
      );
    },
    async searchPrompts(query: string, input?: PageInput) {
      return pageFromResult(
        unwrapStructuredResult(
          await service.execute(capletId, { operation: "search_prompts", query, ...input }),
        ),
      );
    },
    async getPrompt(name: string, args?: unknown) {
      return await resultFromExecution(service, capletId, {
        operation: "get_prompt",
        name,
        ...(args === undefined ? {} : { args }),
      });
    },
    async complete(input: unknown) {
      return await resultFromExecution(service, capletId, {
        operation: "complete",
        ...(isPlainObject(input) ? input : {}),
      });
    },
  };
}

async function checkResultFromExecution(
  service: NativeCapletsService,
  capletId: string,
): Promise<CapletsResult<unknown>> {
  const result = await resultFromExecution(service, capletId, { operation: "check" });
  if (!result.ok) return result;
  if (!isUnavailableCheckResult(result.data)) return result;
  return {
    ok: false,
    error: {
      code: "backend_not_ready",
      message: unavailableCheckMessage(capletId, result.data),
      details: result.data,
    },
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  };
}

async function resultFromExecution(
  service: NativeCapletsService,
  capletId: string,
  request: Record<string, unknown>,
): Promise<CapletsResult<unknown>> {
  const started = Date.now();
  const targetName = typeof request.name === "string" ? request.name : undefined;
  try {
    const result = await service.execute(capletId, request);
    const meta = toolCallMeta(result, {
      capletId,
      ...(targetName === undefined ? {} : { tool: targetName }),
      durationMs: Date.now() - started,
    });
    if (resultIsError(result)) {
      return { ok: false, error: toolCallError(result), meta };
    }
    return { ok: true, data: unwrapStructuredResult(result), meta };
  } catch (error) {
    return {
      ok: false,
      error: errorFromCaught(error, "caplet_call_failed"),
      meta: {
        capletId,
        ...(targetName === undefined ? {} : { tool: targetName }),
        durationMs: Date.now() - started,
      },
    };
  }
}

function isUnavailableCheckResult(result: unknown): result is Record<string, unknown> {
  if (!isPlainObject(result)) return false;
  return result.status === "unavailable" || result.status === "error";
}

function unavailableCheckMessage(capletId: string, result: Record<string, unknown>): string {
  const error = result.error;
  const reason =
    isPlainObject(error) && typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  return reason
    ? `${capletId} is unavailable: ${truncate(reason, MAX_ERROR_MESSAGE_CHARS)}`
    : `${capletId} is unavailable.`;
}

function errorFromCaught(error: unknown, fallbackCode: string): ToolCallError {
  const code = errorStringProperty(error, "code") ?? fallbackCode;
  const message = truncate(
    error instanceof Error ? error.message : String(error),
    MAX_ERROR_MESSAGE_CHARS,
  );
  const details = errorObjectProperty(error, "details");
  return normalizeCodeModeErrorTerminology({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function errorStringProperty(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function errorObjectProperty(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  return (error as Record<string, unknown>)[key];
}

function pageFromResult(result: unknown): Page<unknown> {
  if (isPlainObject(result) && Array.isArray(result.items)) {
    return {
      items: result.items,
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
      ...(result.truncated === true ? { truncated: true } : {}),
    };
  }
  if (Array.isArray(result)) return { items: result };
  if (isPlainObject(result)) {
    for (const key of ["tools", "resources", "resourceTemplates", "prompts", "matches"] as const) {
      if (Array.isArray(result[key])) return { items: result[key] };
    }
  }
  return { items: [] };
}

function toolPageFromResult(result: unknown): Page<unknown> {
  const page = pageFromResult(result);
  return {
    ...page,
    items: page.items
      .map((item) =>
        isPlainObject(item) ? compactToolSummary(item, { descriptionLimit: 160 }) : undefined,
      )
      .filter((item): item is Record<string, unknown> => item !== undefined),
  };
}

function unwrapStructuredResult(result: unknown): unknown {
  if (!isPlainObject(result)) return result;
  const structuredContent = result.structuredContent;
  if (!isPlainObject(structuredContent) || !("result" in structuredContent)) return result;
  return structuredContent.result;
}

function normalizeToolDescriptor(result: unknown, toolName: string): unknown {
  if (!isPlainObject(result)) return result;
  const rawTool = result.tool;
  if (!isPlainObject(rawTool)) return result;
  const resultWithoutFieldSelection = { ...result };
  delete resultWithoutFieldSelection.fieldSelection;
  const inputSchema = rawTool.inputSchema;
  const outputSchema = rawTool.outputSchema;
  const baseName = toolTypeBaseName(toolName);
  const inputTypeName = `${baseName}Input`;
  const outputTypeName = `${baseName}Output`;
  return {
    ...resultWithoutFieldSelection,
    tool: compactToolSummary(rawTool),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    callSignature: `callTool(name: ${JSON.stringify(toolName)}, args: ${inputTypeName}): Promise<CapletsResult<${outputTypeName}>>`,
    inputTypeScript: schemaToTypeScript(inputSchema, inputTypeName),
    outputTypeScript: schemaToTypeScript(outputSchema, outputTypeName),
    ...(isPlainObject(result.observedOutputShape)
      ? { observedOutputShape: result.observedOutputShape }
      : {}),
    examples: Array.isArray(result.examples) ? result.examples.slice(0, 3) : [],
  };
}

function toolTypeBaseName(toolName: string): string {
  const base = toolName
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
  return base || "Tool";
}

function compactToolSummary(
  tool: Record<string, unknown>,
  options: { descriptionLimit?: number } = {},
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of ["name", "title", "description", "useWhen", "avoidWhen"] as const) {
    if (tool[key] !== undefined) {
      compact[key] =
        key === "description" && typeof tool[key] === "string" && options.descriptionLimit
          ? compactCodeModeSummaryText(tool[key], options.descriptionLimit)
          : tool[key];
    }
  }
  const annotations = isPlainObject(tool.annotations) ? tool.annotations : {};
  const readOnlyHint = tool.readOnlyHint ?? annotations.readOnlyHint;
  const destructiveHint = tool.destructiveHint ?? annotations.destructiveHint;
  if (typeof readOnlyHint === "boolean") compact.readOnlyHint = readOnlyHint;
  if (typeof destructiveHint === "boolean") compact.destructiveHint = destructiveHint;
  return compact;
}

function compactCodeModeSummaryText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  const sentenceEnd = cleaned.lastIndexOf(".", maxLength);
  if (sentenceEnd >= Math.floor(maxLength / 3)) return cleaned.slice(0, sentenceEnd + 1);
  return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function schemaToTypeScript(schema: unknown, fallbackName: string): string {
  return `type ${fallbackName} = ${schemaType(schema)};`;
}

function schemaType(schema: unknown): string {
  if (!isPlainObject(schema)) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "unknown";
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    const variants = type.map((item) => schemaType({ ...schema, type: item }));
    return [...new Set(variants)].join(" | ") || "unknown";
  }
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return `${schemaType(schema.items)}[]`;
  if (type === "object" || isPlainObject(schema.properties)) return objectSchemaType(schema);
  if (Array.isArray(schema.oneOf)) return unionSchemaType(schema.oneOf);
  if (Array.isArray(schema.anyOf)) return unionSchemaType(schema.anyOf);
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map(schemaType).join(" & ") || "Record<string, unknown>";
  }
  return "unknown";
}

function objectSchemaType(schema: Record<string, unknown>): string {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const fields = Object.entries(properties).map(([key, value]) => {
    const optional = required.has(key) ? "" : "?";
    return `${propertySignature(key)}${optional}: ${schemaType(value)};`;
  });
  if (fields.length === 0) {
    return schema.additionalProperties === false ? "{}" : "Record<string, unknown>";
  }
  if (schema.additionalProperties && isPlainObject(schema.additionalProperties)) {
    fields.push(`[key: string]: ${schemaType(schema.additionalProperties)};`);
  } else if (schema.additionalProperties !== false) {
    fields.push("[key: string]: unknown;");
  }
  return `{ ${fields.join(" ")} }`;
}

function unionSchemaType(schemas: unknown[]): string {
  return schemas.map(schemaType).join(" | ") || "unknown";
}

function propertySignature(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key);
}

async function defaultReadLogs(): Promise<ReadLogsResult> {
  return {
    entries: [
      {
        level: "warn",
        message: "Code Mode log storage is not configured for this runtime.",
        timestamp: new Date(0).toISOString(),
      },
    ],
  };
}

function resultIsError(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  if (result.isError === true) return true;
  const capletsMeta = capletsMetaFromResult(result);
  return capletsMeta?.status === "error";
}

function normalizeToolCallData(result: unknown): unknown {
  if (isPlainObject(result)) {
    const structured = result.structuredContent;
    if (structured !== undefined) {
      const httpBody = codeModeHttpBody(structured);
      if (httpBody !== undefined) return httpBody;
      if (isPlainObject(structured) && "caplets" in structured && "result" in structured) {
        return structured.result;
      }
      return structured;
    }
  }

  const parsedText = parseSingleJsonTextBlock(result);
  if (parsedText.ok) return parsedText.value;

  const text = textFromResult(result, MAX_TOOL_TEXT_CHARS);
  if (text !== undefined) return text;

  return result;
}

function codeModeHttpBody(structured: unknown): unknown | undefined {
  if (!isPlainObject(structured)) return undefined;
  if (!("body" in structured)) return undefined;
  const hasHttpMetadata =
    typeof structured.status === "number" ||
    typeof structured.statusText === "string" ||
    isPlainObject(structured.headers);
  return hasHttpMetadata ? structured.body : undefined;
}

function toolCallError(result: unknown): ToolCallError {
  const structuredError = structuredErrorFromResult(result);
  const code = structuredError.code ?? errorCodeFromResult(result) ?? "tool_call_failed";
  const message = truncate(
    structuredError.message ?? textFromResult(result, MAX_ERROR_MESSAGE_CHARS) ?? code,
    MAX_ERROR_MESSAGE_CHARS,
  );
  return normalizeCodeModeErrorTerminology({
    code,
    message,
    ...(structuredError.details === undefined ? {} : { details: structuredError.details }),
  });
}

function normalizeCodeModeErrorTerminology(error: ToolCallError): ToolCallError {
  return {
    ...error,
    message: codeModeMethodText(error.message),
    ...(error.details === undefined
      ? {}
      : { details: normalizeCodeModeErrorDetails(error.details) }),
  };
}

function normalizeCodeModeErrorDetails(value: unknown): unknown {
  if (typeof value === "string") return codeModeMethodText(value);
  if (Array.isArray(value)) return value.map(normalizeCodeModeErrorDetails);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeCodeModeErrorDetails(nested)]),
  );
}

function codeModeMethodText(value: string): string {
  const replacements: Array<[string, string]> = [
    ["search_tools", "searchTools"],
    ["describe_tool", "describeTool"],
    ["call_tool", "callTool"],
    ["search_resources", "searchResources"],
    ["resource_templates", "resourceTemplates"],
    ["read_resource", "readResource"],
    ["search_prompts", "searchPrompts"],
    ["get_prompt", "getPrompt"],
  ];
  return replacements.reduce(
    (text, [from, to]) =>
      text.replace(new RegExp(`(^|[^A-Za-z0-9_])${from}($|[^A-Za-z0-9_])`, "gu"), `$1${to}$2`),
    value,
  );
}

function structuredErrorFromResult(result: unknown): Partial<ToolCallError> {
  if (!isPlainObject(result)) return {};
  const structured = result.structuredContent;
  if (!isPlainObject(structured)) return {};
  const error = structured.error;
  if (!isPlainObject(error)) return {};
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : undefined;
  const details = compactErrorDetails(error);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  };
}

function compactErrorDetails(error: Record<string, unknown>): unknown {
  const entries = Object.entries(error).filter(([key]) => key !== "code" && key !== "message");
  if (entries.length === 0) return undefined;
  if (entries.length === 1 && entries[0]?.[0] === "details") return entries[0][1];
  return Object.fromEntries(entries);
}

function errorCodeFromResult(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined;
  const structured = result.structuredContent;
  if (!isPlainObject(structured)) return undefined;
  const errorCode = structured.errorCode;
  return typeof errorCode === "string" ? errorCode : undefined;
}

function toolCallMeta(result: unknown, base: ToolCallMeta): ToolCallMeta {
  const capletsMeta = capletsMetaFromResult(result);
  if (!capletsMeta) return base;
  return {
    ...base,
    ...(typeof capletsMeta.status === "string" ? { status: capletsMeta.status } : {}),
    ...(typeof capletsMeta.elapsedMs === "number" ? { elapsedMs: capletsMeta.elapsedMs } : {}),
  };
}

function capletsMetaFromResult(result: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(result)) return undefined;
  const meta = result._meta;
  if (!isPlainObject(meta)) return undefined;
  const caplets = meta.caplets;
  return isPlainObject(caplets) ? caplets : undefined;
}

function parseSingleJsonTextBlock(result: unknown): { ok: true; value: unknown } | { ok: false } {
  const textBlocks = textBlocksFromResult(result);
  if (textBlocks.length !== 1) return { ok: false };
  const text = textBlocks[0]?.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function textFromResult(result: unknown, maxChars: number): string | undefined {
  const text = textBlocksFromResult(result).join("\n").trim();
  if (text) return truncate(text, maxChars);
  if (result === undefined) return undefined;
  if (typeof result === "string") return truncate(result, maxChars);
  if (typeof result === "number" || typeof result === "boolean" || result === null) {
    return String(result);
  }
  return undefined;
}

function textBlocksFromResult(result: unknown): string[] {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return [];
  return result.content
    .map((item) =>
      isPlainObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : "",
    )
    .filter(Boolean);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1).trimEnd()}…` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
