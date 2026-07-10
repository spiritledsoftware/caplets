import Ajv from "ajv";
import {
  McpServer,
  ResourceTemplate,
  type RegisteredPrompt,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp";
import { completable } from "@modelcontextprotocol/sdk/server/completable";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { z } from "zod";
import { version as packageJsonVersion } from "../../package.json";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import { CodeModeJournalStore } from "../code-mode/journal";
import { CodeModeLogStore } from "../code-mode/logs";
import { runCodeMode } from "../code-mode/runner";
import { CodeModeSessionManager } from "../code-mode/sessions";
import {
  codeModeRunInputSchema,
  codeModeRunParamsSchema,
  emptyCodeModeRunMeta,
} from "../code-mode/tool";
import type { CapletsEngine, ResolvedExposureProjection } from "../engine";
import { CapletsError } from "../errors";
import type {
  ExposureProjection,
  ExposureProjectionCodeModeCaplet,
  ExposureProjectionDirectPrompt,
  ExposureProjectionDirectResource,
  ExposureProjectionDirectResourceTemplate,
  ExposureProjectionDirectTool,
  ExposureProjectionProgressiveCaplet,
  ExposureProjectionPromptArgument,
} from "../exposure/projection";
import { decodeDirectResourceUri } from "../exposure/direct-names";
import type { NativeCapletTool, NativeCapletsService } from "../native/service";
import { nativeCapletToolName } from "../native/tools";

const directToolSchemaAjv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
  validateSchema: false,
});
const directToolSchemaCache = new WeakMap<Record<string, unknown>, z.ZodObject>();

export type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close"> &
  Partial<Pick<McpServer, "registerResource" | "registerPrompt">>;

export type CapletsMcpSessionOptions = {
  server?: ToolServer;
  writeErr?: ((value: string) => void) | undefined;
};

type ToolRegistrationPlan = {
  register(): RegisteredTool;
  update(tool: RegisteredTool): void;
};

type ExposureProjectionBinding = {
  generation: number;
  epoch: number;
};

export class CapletsMcpSession {
  readonly server: ToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, RegisteredResource | RegisteredResourceTemplate>();
  private readonly prompts = new Map<string, RegisteredPrompt>();
  private codeModeTool: RegisteredTool | undefined;
  private readonly codeModeSessions = new CodeModeSessionManager();
  private readonly unsubscribeReload: () => void;
  private resolvedProjection: ResolvedExposureProjection | undefined;
  private refreshSequence = 0;
  private projectionEpoch = 0;
  private reloadRefresh: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly writeErr: (value: string) => void;

  constructor(
    private readonly engine: CapletsEngine,
    options: CapletsMcpSessionOptions = {},
  ) {
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.writeErr =
      options.writeErr ??
      ((value) => {
        process.stderr.write(value);
      });
    this.unsubscribeReload = this.engine.onReload(() => {
      this.reloadRefresh = this.refreshExposure();
      void this.reloadRefresh.catch((error) => {
        this.writeErr(
          `Caplets exposure refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.refreshExposure();
    await this.server.connect(transport);
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  async refreshExposure(): Promise<void> {
    if (this.closed) return;
    const sequence = ++this.refreshSequence;
    const resolved = await this.engine.exposureProjection({
      discoverNonDirectMcpSurfaces: false,
    });
    if (
      this.closed ||
      sequence !== this.refreshSequence ||
      resolved.generation !== this.engine.currentExposureGeneration()
    ) {
      return;
    }
    const binding = {
      generation: resolved.generation,
      epoch: ++this.projectionEpoch,
    };
    try {
      this.reconcileFromProjection(resolved.projection, binding);
      this.resolvedProjection = resolved;
    } catch (error) {
      this.resolvedProjection = undefined;
      this.clearRegistrations();
      throw error;
    }
  }

  async waitForReloadRefresh(): Promise<void> {
    await this.reloadRefresh;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeReload();
    this.codeModeSessions.close();
    this.clearRegistrations();
    await this.server.close();
  }

  private reconcileFromProjection(
    projection: ExposureProjection,
    binding: ExposureProjectionBinding,
  ): void {
    const codeModeCaplets = projection.entries.filter(
      (entry): entry is ExposureProjectionCodeModeCaplet => entry.kind === "code-mode-caplet",
    );
    const completionCapletIds = new Set(
      projection.entries
        .filter((entry) => entry.kind === "completion")
        .map((entry) => entry.route.capletId),
    );
    if (codeModeCaplets.length > 0) {
      const callback = async (request: unknown) =>
        this.handleCodeModeRunTool(request, binding, codeModeCaplets);
      if (this.codeModeTool) {
        this.codeModeTool.update({
          title: "Code Mode",
          description: codeModeRunToolDescription(codeModeCaplets),
          paramsSchema: codeModeRunParamsSchema,
          callback,
          enabled: true,
        });
      } else {
        this.codeModeTool = this.registerCodeModeTool(codeModeCaplets, binding);
      }
    } else if (this.codeModeTool) {
      this.codeModeTool.remove();
      this.codeModeTool = undefined;
    }

    const desiredTools = new Map<string, ToolRegistrationPlan>();
    for (const entry of projection.entries) {
      if (entry.kind === "progressive-caplet") {
        const inputSchema = zodSchemaForDirectTool(entry.inputSchema);
        desiredTools.set(entry.id, {
          register: () => this.registerCapletTool(entry, binding),
          update: (tool) =>
            (tool.update as (updates: Record<string, unknown>) => void)({
              title: entry.title,
              description: entry.description,
              paramsSchema: inputSchema?.shape,
              callback: async (request: unknown) => {
                this.assertProjectionBinding(binding);
                return this.engine.execute(entry.route.capletId, request) as never;
              },
              enabled: true,
            }),
        });
      }
      if (entry.kind === "direct-tool") {
        const inputSchema = zodSchemaForDirectTool(entry.inputSchema);
        const outputSchema = zodSchemaForDirectTool(entry.outputSchema);
        desiredTools.set(entry.id, {
          register: () => this.registerDirectTool(entry, binding),
          update: (tool) =>
            (tool.update as (updates: Record<string, unknown>) => void)({
              title: entry.title,
              description: entry.description,
              paramsSchema: inputSchema,
              outputSchema,
              annotations: entry.annotations,
              _meta: directToolMetadata(entry),
              callback: async (request: unknown) => {
                this.assertProjectionBinding(binding);
                return this.engine.executeDirectTool(
                  entry.route.capletId,
                  entry.route.downstreamName,
                  isRecord(request) ? request : {},
                ) as never;
              },
              enabled: true,
            }),
        });
      }
    }
    for (const [name, tool] of this.tools) {
      const plan = desiredTools.get(name);
      if (!plan) {
        tool.remove();
        this.tools.delete(name);
      } else {
        plan.update(tool);
      }
    }
    for (const [name, plan] of desiredTools) {
      if (!this.tools.has(name)) {
        this.tools.set(name, plan.register());
      }
    }

    for (const resource of this.resources.values()) resource.remove();
    for (const prompt of this.prompts.values()) prompt.remove();
    this.resources.clear();
    this.prompts.clear();
    for (const entry of projection.entries) {
      if (entry.kind === "direct-resource") {
        this.resources.set(entry.id, this.registerDirectResource(entry, binding));
      }
      if (entry.kind === "direct-resource-template") {
        this.resources.set(
          entry.id,
          this.registerDirectResourceTemplate(
            entry,
            binding,
            completionCapletIds.has(entry.route.capletId),
          ),
        );
      }
      if (entry.kind === "direct-prompt") {
        this.prompts.set(
          entry.id,
          this.registerDirectPrompt(entry, binding, completionCapletIds.has(entry.route.capletId)),
        );
      }
    }
  }

  private clearRegistrations(): void {
    this.codeModeTool?.remove();
    this.codeModeTool = undefined;
    for (const tool of this.tools.values()) tool.remove();
    for (const resource of this.resources.values()) resource.remove();
    for (const prompt of this.prompts.values()) prompt.remove();
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
  }

  private registerCodeModeTool(
    codeModeCaplets: ExposureProjectionCodeModeCaplet[],
    binding: ExposureProjectionBinding,
  ): RegisteredTool {
    return this.server.registerTool(
      "code_mode",
      {
        title: "Code Mode",
        description: codeModeRunToolDescription(codeModeCaplets),
        inputSchema: codeModeRunParamsSchema,
      },
      async (request: unknown) => this.handleCodeModeRunTool(request, binding, codeModeCaplets),
    );
  }

  private async handleCodeModeRunTool(
    request: unknown,
    binding: ExposureProjectionBinding,
    codeModeCaplets: ExposureProjectionCodeModeCaplet[],
  ): Promise<any> {
    this.assertProjectionBinding(binding);
    const started = Date.now();
    const parsed = codeModeRunInputSchema.safeParse(request);
    const envelope = parsed.success
      ? await runCodeMode({
          code: parsed.data.code,
          service: new EngineNativeCapletsService(
            this.engine,
            binding.generation,
            codeModeCaplets,
            () => this.isProjectionBindingCurrent(binding),
          ),
          ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
          ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
          logStore: new CodeModeLogStore(),
          journalStore: new CodeModeJournalStore(),
          sessionManager: this.codeModeSessions,
          runtimeScope: "mcp",
        })
      : {
          ok: false as const,
          error: {
            code: "REQUEST_INVALID",
            message: "Code Mode run input is invalid.",
            details: parsed.error.issues,
          },
          diagnostics: [],
          logs: { entries: [], truncated: false, stored: false },
          meta: emptyCodeModeRunMeta(),
        };
    void this.engine
      .captureCodeModeOutcome(envelope, {
        started,
        ...(parsed.success && parsed.data.timeoutMs !== undefined
          ? { timeoutMs: parsed.data.timeoutMs }
          : {}),
      })
      .catch(() => undefined);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  }

  private registerCapletTool(
    entry: ExposureProjectionProgressiveCaplet,
    binding: ExposureProjectionBinding,
  ): RegisteredTool {
    const inputSchema = zodSchemaForDirectTool(entry.inputSchema);
    return this.server.registerTool(
      entry.id,
      {
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(inputSchema ? { inputSchema: inputSchema.shape } : {}),
      },
      async (request: unknown) => {
        this.assertProjectionBinding(binding);
        return this.engine.execute(entry.route.capletId, request) as never;
      },
    );
  }

  private registerDirectTool(
    entry: ExposureProjectionDirectTool,
    binding: ExposureProjectionBinding,
  ): RegisteredTool {
    const inputSchema = zodSchemaForDirectTool(entry.inputSchema);
    const outputSchema = zodSchemaForDirectTool(entry.outputSchema);
    return (this.server.registerTool as (...args: unknown[]) => RegisteredTool)(
      entry.id,
      {
        title: entry.title,
        ...(entry.description ? { description: entry.description } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(entry.annotations ? { annotations: entry.annotations } : {}),
        _meta: directToolMetadata(entry),
      },
      async (request: unknown) => {
        this.assertProjectionBinding(binding);
        return this.engine.executeDirectTool(
          entry.route.capletId,
          entry.route.downstreamName,
          isRecord(request) ? request : {},
        ) as never;
      },
    );
  }

  private registerDirectResource(
    entry: ExposureProjectionDirectResource,
    binding: ExposureProjectionBinding,
  ): RegisteredResource {
    if (!this.server.registerResource) {
      throw new Error("MCP server does not support resource registration");
    }
    return this.server.registerResource(
      entry.title ?? entry.id,
      entry.id,
      resourceMetadata(entry),
      async () =>
        this.directResourceResult(binding, entry.route.capletId, entry.route.downstreamUri),
    );
  }

  private registerDirectResourceTemplate(
    entry: ExposureProjectionDirectResourceTemplate,
    binding: ExposureProjectionBinding,
    completionEnabled: boolean,
  ): RegisteredResourceTemplate {
    if (!this.server.registerResource) {
      throw new Error("MCP server does not support resource registration");
    }
    return this.server.registerResource(
      `${entry.route.capletId}:${entry.title ?? entry.route.downstreamUriTemplate}`,
      new ResourceTemplate(entry.id, {
        list: undefined,
        ...(completionEnabled ? { complete: this.resourceTemplateCompleters(entry, binding) } : {}),
      }),
      resourceTemplateMetadata(entry),
      async (uri) => {
        this.assertProjectionBinding(binding);
        const decoded = decodeDirectResourceUri(uri.toString());
        return this.directResourceResult(binding, entry.route.capletId, decoded.downstreamUri);
      },
    );
  }

  private registerDirectPrompt(
    entry: ExposureProjectionDirectPrompt,
    binding: ExposureProjectionBinding,
    completionEnabled: boolean,
  ): RegisteredPrompt {
    if (!this.server.registerPrompt) {
      throw new Error("MCP server does not support prompt registration");
    }
    return this.server.registerPrompt(
      entry.id,
      {
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        argsSchema: promptArgsSchema(
          entry.arguments,
          completionEnabled
            ? async (name, value, context) => {
                this.assertProjectionBinding(binding);
                return await this.engine.completeDirectReference(
                  entry.route.capletId,
                  { type: "prompt", name: entry.route.downstreamName },
                  { name, value },
                  context,
                );
              }
            : undefined,
        ),
      },
      async (args) => {
        this.assertProjectionBinding(binding);
        return (await this.engine.getDirectPrompt(
          entry.route.capletId,
          entry.route.downstreamName,
          isRecord(args) ? stringifyRecord(args) : {},
        )) as never;
      },
    );
  }

  private resourceTemplateCompleters(
    entry: ExposureProjectionDirectResourceTemplate,
    binding: ExposureProjectionBinding,
  ): Record<
    string,
    (
      value: string,
      context?: { arguments?: Record<string, string> | undefined },
    ) => Promise<string[]>
  > {
    const exposedTemplate = new UriTemplate(entry.id);
    const downstreamTemplate = new UriTemplate(entry.route.downstreamUriTemplate);
    const downstreamVariables = new Set(downstreamTemplate.variableNames);
    return Object.fromEntries(
      exposedTemplate.variableNames.map((variable) => [
        variable,
        async (value: string, context?: { arguments?: Record<string, string> | undefined }) => {
          this.assertProjectionBinding(binding);
          const target = resourceTemplateCompletionTarget(entry.route.downstreamUriTemplate, value);
          if (!target) return [];
          const completionArguments = {
            ...Object.fromEntries(
              Object.entries(context?.arguments ?? {}).filter(([name]) =>
                downstreamVariables.has(name),
              ),
            ),
            ...target.arguments,
          };
          const completions = await this.engine.completeDirectReference(
            entry.route.capletId,
            { type: "resourceTemplate", uri: entry.route.downstreamUriTemplate },
            { name: target.name, value: target.value },
            { arguments: completionArguments },
          );
          return completions.map((completion) =>
            downstreamTemplate.expand({
              ...completionArguments,
              [target.name]: completion,
            }),
          );
        },
      ]),
    );
  }

  private async directResourceResult(
    binding: ExposureProjectionBinding,
    serverId: string,
    downstreamUri: string,
  ): Promise<any> {
    this.assertProjectionBinding(binding);
    const result = await this.engine.readDirectResource(serverId, downstreamUri);
    if (isRecord(result) && "contents" in result) return result;
    return {
      contents: [
        {
          uri: downstreamUri,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private isProjectionBindingCurrent(binding: ExposureProjectionBinding): boolean {
    return (
      this.projectionEpoch === binding.epoch &&
      this.resolvedProjection?.generation === binding.generation &&
      this.engine.currentExposureGeneration() === binding.generation
    );
  }

  private assertProjectionBinding(binding: ExposureProjectionBinding): void {
    if (this.isProjectionBindingCurrent(binding)) return;
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Caplets exposure changed; wait for the current projection to resolve.",
    );
  }
}

function zodSchemaForDirectTool(schema: unknown): z.ZodObject | undefined {
  if (!isRecord(schema)) return undefined;
  const cached = directToolSchemaCache.get(schema);
  if (cached) return cached;

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const shape: Record<string, z.ZodType> = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const jsonPropertySchema = propertySchema as Parameters<typeof z.fromJSONSchema>[0];
    const property = z.fromJSONSchema(jsonPropertySchema, { defaultTarget: "draft-7" });
    shape[name] = required.has(name) ? property : property.optional();
  }

  const base = schema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
  const validate = directToolSchemaAjv.compile(schema);
  const converted = base.superRefine((value, context) => {
    if (validate(value)) return;
    for (const error of validate.errors ?? []) {
      context.addIssue({
        code: "custom",
        message: `${error.instancePath || "value"} ${error.message ?? "is invalid"}`,
      });
    }
  });
  directToolSchemaCache.set(schema, converted);
  return converted;
}

function codeModeRunToolDescription(caplets: ExposureProjectionCodeModeCaplet[]): string {
  const declaration = generateCodeModeDeclarations({
    caplets: caplets.map((entry) => ({
      id: entry.id,
      name: entry.title ?? entry.id,
      description: entry.description ?? "",
      ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
      ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    })),
  });
  return generateCodeModeRunToolDescription(declaration);
}

class EngineNativeCapletsService implements NativeCapletsService {
  constructor(
    private readonly engine: CapletsEngine,
    private readonly generation: number,
    private readonly caplets: ExposureProjectionCodeModeCaplet[],
    private readonly isCurrentProjection: () => boolean,
  ) {}

  listTools(): NativeCapletTool[] {
    if (
      this.engine.currentExposureGeneration() !== this.generation ||
      !this.isCurrentProjection()
    ) {
      return [];
    }
    return this.caplets.map((entry) => ({
      caplet: entry.id,
      ...(entry.sourceCapletId ? { sourceCaplet: entry.sourceCapletId } : {}),
      toolName: nativeCapletToolName(entry.id),
      title: entry.title ?? entry.id,
      description: entry.description ?? "",
      ...(entry.shadowing ? { shadowing: entry.shadowing } : {}),
      ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
      ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
      promptGuidance: [],
    }));
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    this.assertCurrent();
    return await this.engine.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    this.assertCurrent();
    return await this.engine.reload();
  }

  onToolsChanged(listener: (tools: NativeCapletTool[]) => void): () => void {
    return this.engine.onReload(() => listener([]));
  }

  async close(): Promise<void> {
    return;
  }

  private assertCurrent(): void {
    if (this.engine.currentExposureGeneration() === this.generation && this.isCurrentProjection()) {
      return;
    }
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Caplets exposure changed during Code Mode execution.",
    );
  }
}

function directToolMetadata(entry: ExposureProjectionDirectTool) {
  return {
    caplets: {
      capletId: entry.route.capletId,
      downstreamName: entry.route.downstreamName,
      exposure: "direct",
    },
  };
}

function resourceMetadata(resource: ExposureProjectionDirectResource) {
  return {
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
    _meta: {
      caplets: { downstreamUri: resource.route.downstreamUri, exposure: "direct" },
    },
  };
}

function resourceTemplateMetadata(resourceTemplate: ExposureProjectionDirectResourceTemplate) {
  return {
    ...(resourceTemplate.description ? { description: resourceTemplate.description } : {}),
    ...(resourceTemplate.mimeType ? { mimeType: resourceTemplate.mimeType } : {}),
    _meta: {
      caplets: {
        downstreamUriTemplate: resourceTemplate.route.downstreamUriTemplate,
        exposure: "direct",
      },
    },
  };
}

function promptArgsSchema(
  args: ExposureProjectionPromptArgument[],
  complete?:
    | ((
        name: string,
        value: string,
        context?: { arguments?: Record<string, string> | undefined },
      ) => Promise<string[]>)
    | undefined,
) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of args) {
    const described = arg.description ? z.string().describe(arg.description) : z.string();
    const schema = arg.required ? described : described.optional();
    shape[arg.name] = complete
      ? completable(
          schema,
          async (value, context) => await complete(arg.name, String(value ?? ""), context),
        )
      : schema;
  }
  return shape;
}

function resourceTemplateCompletionTarget(
  template: string,
  partialUri: string,
):
  | {
      name: string;
      value: string;
      arguments: Record<string, string>;
    }
  | undefined {
  const slots = resourceTemplateSlots(template);
  if (slots.length === 0) return undefined;
  const namedTarget = namedResourceTemplateCompletionTarget(template, partialUri);
  if (namedTarget) return namedTarget;
  const arguments_: Record<string, string> = {};
  let offset = 0;
  for (const [index, slot] of slots.entries()) {
    const rawFirstVariable = index === 0 && !partialUri.startsWith(slot.prefix);
    if (!rawFirstVariable) {
      if (!partialUri.startsWith(slot.prefix, offset)) return undefined;
      offset += slot.prefix.length;
    }
    const nextPrefix = slots[index + 1]?.prefix;
    const nextOffset = nextPrefix ? partialUri.indexOf(nextPrefix, offset) : -1;
    if (!nextPrefix || nextOffset === -1) {
      return {
        name: slot.name,
        value: decodeCompletionComponent(partialUri.slice(offset)),
        arguments: arguments_,
      };
    }
    arguments_[slot.name] = decodeCompletionComponent(partialUri.slice(offset, nextOffset));
    offset = nextOffset;
  }
  return undefined;
}

function namedResourceTemplateCompletionTarget(
  template: string,
  partialUri: string,
): { name: string; value: string; arguments: Record<string, string> } | undefined {
  const queryIndex = partialUri.indexOf("?");
  if (queryIndex === -1) return undefined;
  const namedVariables = new Set(
    [...template.matchAll(/\{[?&;]([^}]+)\}/gu)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((name) => name.replace(/[:*].*$/u, "").trim())
        .filter(Boolean),
    ),
  );
  const query = partialUri.slice(queryIndex + 1);
  const current = query.split(/[&;]/u).at(-1) ?? "";
  const separator = current.indexOf("=");
  if (separator === -1) return undefined;
  const name = decodeCompletionComponent(current.slice(0, separator));
  if (!namedVariables.has(name)) return undefined;
  const value = decodeCompletionComponent(current.slice(separator + 1));
  const arguments_: Record<string, string> = {};
  for (const [argumentName, argumentValue] of new URLSearchParams(query)) {
    if (argumentName !== name && namedVariables.has(argumentName)) {
      arguments_[argumentName] = argumentValue;
    }
  }
  const positionalTemplate = template.replace(/\{[?&;][^}]+\}/gu, "");
  const matched = new UriTemplate(positionalTemplate).match(partialUri.slice(0, queryIndex));
  for (const [argumentName, argumentValue] of Object.entries(matched ?? {})) {
    if (argumentName !== name && typeof argumentValue === "string") {
      arguments_[argumentName] = decodeCompletionComponent(argumentValue);
    }
  }
  return { name, value, arguments: arguments_ };
}

function resourceTemplateSlots(template: string): Array<{ name: string; prefix: string }> {
  const slots: Array<{ name: string; prefix: string }> = [];
  let pending = "";
  let offset = 0;
  for (const match of template.matchAll(/\{([^}]+)\}/gu)) {
    pending += template.slice(offset, match.index);
    const expression = match[1] ?? "";
    const operator = expression.match(/^[+#./;?&]/u)?.[0] ?? "";
    const names = (operator ? expression.slice(1) : expression)
      .split(",")
      .map((name) => name.replace(/[:*].*$/u, "").trim())
      .filter(Boolean);
    for (const [index, name] of names.entries()) {
      slots.push({
        name,
        prefix: pending + resourceTemplateVariablePrefix(operator, name, index),
      });
      pending = "";
    }
    offset = (match.index ?? 0) + match[0].length;
  }
  return slots;
}

function resourceTemplateVariablePrefix(operator: string, name: string, index: number): string {
  if (operator === "/") return "/";
  if (operator === ".") return ".";
  if (operator === ";") return `;${name}=`;
  if (operator === "?") return `${index === 0 ? "?" : "&"}${name}=`;
  if (operator === "&") return `&${name}=`;
  if (operator === "#") return index === 0 ? "#" : ",";
  return index === 0 ? "" : ",";
}

function decodeCompletionComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, nested === undefined ? "" : String(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
