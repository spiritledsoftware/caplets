import {
  McpServer,
  ResourceTemplate,
  type RegisteredPrompt,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { z } from "zod";
import { version as packageJsonVersion } from "../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import { CodeModeLogStore } from "../code-mode/logs";
import { runCodeMode } from "../code-mode/runner";
import { CodeModeSessionManager } from "../code-mode/sessions";
import {
  codeModeRunInputSchema,
  codeModeRunParamsSchema,
  emptyCodeModeRunMeta,
} from "../code-mode/tool";
import type { CapletsEngine } from "../engine";
import type {
  CallableCaplet,
  DirectPromptRegistration,
  DirectResourceRegistration,
  DirectResourceTemplateRegistration,
  DirectToolRegistration,
  ExposureSnapshot,
} from "../exposure/discovery";
import { decodeDirectResourceUri } from "../exposure/direct-names";
import { resolveExposure } from "../exposure/policy";
import { generatedToolInputSchemaForCaplet } from "../generated-tool-input-schema";
import type { NativeCapletTool, NativeCapletsService } from "../native/service";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
} from "../native/tools";
import { capabilityDescription } from "../registry";

export type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close"> &
  Partial<Pick<McpServer, "registerResource" | "registerPrompt">>;

export type CapletsMcpSessionOptions = {
  server?: ToolServer;
};

type ToolRegistrationPlan = {
  register(): RegisteredTool;
  update(tool: RegisteredTool): void;
};

export class CapletsMcpSession {
  readonly server: ToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, RegisteredResource | RegisteredResourceTemplate>();
  private readonly prompts = new Map<string, RegisteredPrompt>();
  private codeModeTool: RegisteredTool | undefined;
  private readonly codeModeSessions = new CodeModeSessionManager();
  private readonly unsubscribeReload: () => void;
  private closed = false;

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
    this.unsubscribeReload = this.engine.onReload(({ previous, next }) => {
      this.reconcileFromSnapshot(staticExposureSnapshot(next, this.engine.enabledServers()));
      void this.refreshExposure(previous, next);
    });
    this.reconcileFromSnapshot(
      staticExposureSnapshot(this.engine.currentConfig(), this.engine.enabledServers()),
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.refreshExposure(undefined, this.engine.currentConfig());
    await this.server.connect(transport);
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  async refreshExposure(
    _previous: CapletsConfig | undefined = undefined,
    _next: CapletsConfig = this.engine.currentConfig(),
  ): Promise<void> {
    if (this.closed) return;
    this.reconcileFromSnapshot(await this.engine.exposureSnapshot());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeReload();
    this.codeModeSessions.close();
    this.clearRegistrations();
    await this.server.close();
  }

  private reconcileFromSnapshot(snapshot: ExposureSnapshot): void {
    if (snapshot.codeModeCaplets.length > 0) {
      if (this.codeModeTool) {
        this.codeModeTool.update({
          title: "Code Mode",
          description: codeModeRunToolDescription(snapshot.codeModeCaplets),
          paramsSchema: codeModeRunParamsSchema,
          callback: async (request: unknown) => this.handleCodeModeRunTool(request),
          enabled: true,
        });
      } else {
        this.codeModeTool = this.registerCodeModeTool(snapshot);
      }
    } else if (this.codeModeTool) {
      this.codeModeTool.remove();
      this.codeModeTool = undefined;
    }

    const desiredTools = new Map<string, ToolRegistrationPlan>();
    for (const entry of snapshot.progressiveCaplets) {
      desiredTools.set(entry.caplet.server, {
        register: () => this.registerCapletTool(entry.caplet),
        update: (tool) =>
          (tool.update as (updates: Record<string, unknown>) => void)({
            title: entry.caplet.name,
            description: capabilityDescription(entry.caplet),
            paramsSchema: generatedToolInputSchemaForCaplet(entry.caplet).shape,
            callback: async (request: unknown) =>
              this.engine.execute(entry.caplet.server, request) as never,
            enabled: true,
          }),
      });
    }
    for (const entry of snapshot.directTools) {
      desiredTools.set(entry.name, {
        register: () => this.registerDirectTool(entry),
        update: (tool) =>
          (tool.update as (updates: Record<string, unknown>) => void)({
            title: entry.tool.name,
            description: entry.tool.description,
            paramsSchema: entry.tool.inputSchema as never,
            outputSchema: entry.tool.outputSchema as never,
            annotations: entry.tool.annotations,
            _meta: {
              caplets: {
                capletId: entry.caplet.server,
                downstreamName: entry.downstreamName,
                exposure: "direct",
              },
            },
            callback: async (request: unknown) =>
              this.engine.executeDirectTool(
                entry.caplet.server,
                entry.downstreamName,
                isRecord(request) ? request : {},
              ) as never,
            enabled: true,
          }),
      });
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
    for (const entry of snapshot.directResources) {
      this.resources.set(entry.uri, this.registerDirectResource(entry));
    }
    for (const entry of snapshot.directResourceTemplates) {
      this.resources.set(entry.uriTemplate, this.registerDirectResourceTemplate(entry));
    }
    for (const entry of snapshot.directPrompts) {
      this.prompts.set(entry.name, this.registerDirectPrompt(entry));
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

  private registerCodeModeTool(snapshot: ExposureSnapshot): RegisteredTool {
    return this.server.registerTool(
      "code_mode",
      {
        title: "Code Mode",
        description: codeModeRunToolDescription(snapshot.codeModeCaplets),
        inputSchema: codeModeRunParamsSchema,
      },
      async (request: unknown) => this.handleCodeModeRunTool(request),
    );
  }

  private async handleCodeModeRunTool(request: unknown): Promise<any> {
    const parsed = codeModeRunInputSchema.safeParse(request);
    const envelope = parsed.success
      ? await runCodeMode({
          code: parsed.data.code,
          service: new EngineNativeCapletsService(this.engine),
          ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
          ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
          logStore: new CodeModeLogStore(),
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
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  }

  private registerCapletTool(caplet: CapletConfig): RegisteredTool {
    return this.server.registerTool(
      caplet.server,
      {
        title: caplet.name,
        description: capabilityDescription(caplet),
        inputSchema: generatedToolInputSchemaForCaplet(caplet).shape,
      },
      async (request: unknown) => this.engine.execute(caplet.server, request) as never,
    );
  }

  private registerDirectTool(entry: DirectToolRegistration): RegisteredTool {
    return (this.server.registerTool as (...args: unknown[]) => RegisteredTool)(
      entry.name,
      {
        title: entry.tool.name,
        ...(entry.tool.description ? { description: entry.tool.description } : {}),
        ...(entry.tool.inputSchema ? { inputSchema: entry.tool.inputSchema as never } : {}),
        ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema as never } : {}),
        ...(entry.tool.annotations ? { annotations: entry.tool.annotations } : {}),
        _meta: {
          caplets: {
            capletId: entry.caplet.server,
            downstreamName: entry.downstreamName,
            exposure: "direct",
          },
        },
      },
      async (request: unknown) =>
        this.engine.executeDirectTool(
          entry.caplet.server,
          entry.downstreamName,
          isRecord(request) ? request : {},
        ) as never,
    );
  }

  private registerDirectResource(entry: DirectResourceRegistration): RegisteredResource {
    if (!this.server.registerResource) {
      throw new Error("MCP server does not support resource registration");
    }
    return this.server.registerResource(
      entry.resource.name ?? entry.uri,
      entry.uri,
      resourceMetadata(entry.resource),
      async () => this.directResourceResult(entry.caplet.server, entry.downstreamUri),
    );
  }

  private registerDirectResourceTemplate(
    entry: DirectResourceTemplateRegistration,
  ): RegisteredResourceTemplate {
    if (!this.server.registerResource) {
      throw new Error("MCP server does not support resource registration");
    }
    return this.server.registerResource(
      `${entry.caplet.server}:${entry.resourceTemplate.name ?? entry.downstreamUriTemplate}`,
      new ResourceTemplate(entry.uriTemplate, { list: undefined }),
      resourceTemplateMetadata(entry.resourceTemplate),
      async (uri) => {
        const decoded = decodeDirectResourceUri(uri.toString());
        return this.directResourceResult(decoded.capletId, decoded.downstreamUri);
      },
    );
  }

  private registerDirectPrompt(entry: DirectPromptRegistration): RegisteredPrompt {
    if (!this.server.registerPrompt) {
      throw new Error("MCP server does not support prompt registration");
    }
    return this.server.registerPrompt(
      entry.name,
      {
        title: entry.prompt.name,
        ...(entry.prompt.description ? { description: entry.prompt.description } : {}),
        argsSchema: promptArgsSchema(entry.prompt.arguments),
      },
      async (args) =>
        (await this.engine.getDirectPrompt(
          entry.caplet.server,
          entry.downstreamName,
          isRecord(args) ? stringifyRecord(args) : {},
        )) as never,
    );
  }

  private async directResourceResult(serverId: string, downstreamUri: string): Promise<any> {
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
}

function codeModeRunToolDescription(caplets: CallableCaplet[]): string {
  const declaration = generateCodeModeDeclarations({
    caplets: caplets.map((entry) => ({
      id: entry.caplet.server,
      name: entry.caplet.name,
      description: capabilityDescription(entry.caplet),
      ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
      ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    })),
  });
  return generateCodeModeRunToolDescription(declaration);
}

class EngineNativeCapletsService implements NativeCapletsService {
  constructor(private readonly engine: CapletsEngine) {}

  listTools(): NativeCapletTool[] {
    const snapshot = this.engine.currentExposureSnapshot();
    const caplets =
      snapshot?.codeModeCaplets.map((entry) => entry.caplet) ?? this.engine.enabledServers();
    return caplets.map((caplet) => {
      const toolName = nativeCapletToolName(caplet.server);
      return {
        caplet: caplet.server,
        toolName,
        title: caplet.name,
        description: nativeCapletToolDescription(toolName, caplet),
        promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
      };
    });
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    return await this.engine.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  onToolsChanged(listener: (tools: NativeCapletTool[]) => void): () => void {
    return this.engine.onReload(() => listener(this.listTools()));
  }

  async close(): Promise<void> {
    return;
  }
}

function resourceMetadata(resource: DirectResourceRegistration["resource"]) {
  return {
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
    _meta: { caplets: { downstreamUri: resource.uri, exposure: "direct" } },
  };
}

function resourceTemplateMetadata(
  resourceTemplate: DirectResourceTemplateRegistration["resourceTemplate"],
) {
  return {
    ...(resourceTemplate.description ? { description: resourceTemplate.description } : {}),
    ...(resourceTemplate.mimeType ? { mimeType: resourceTemplate.mimeType } : {}),
    _meta: {
      caplets: { downstreamUriTemplate: resourceTemplate.uriTemplate, exposure: "direct" },
    },
  };
}

function promptArgsSchema(args: DirectPromptRegistration["prompt"]["arguments"]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of args ?? []) {
    shape[arg.name] = z.string().optional();
  }
  return shape;
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, nested === undefined ? "" : String(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function staticExposureSnapshot(config: CapletsConfig, caplets: CapletConfig[]): ExposureSnapshot {
  const callableCaplets = caplets
    .filter((caplet) => !caplet.disabled && !caplet.setup && !caplet.projectBinding?.required)
    .map((caplet) => ({
      caplet,
      exposure: resolveExposure(caplet.exposure, config.options.exposure),
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      discoveredAt: Date.now(),
    }));
  return {
    callableCaplets,
    progressiveCaplets: callableCaplets.filter((entry) => entry.exposure.progressive),
    codeModeCaplets: callableCaplets.filter((entry) => entry.exposure.codeMode),
    directTools: [],
    directResources: [],
    directResourceTemplates: [],
    directPrompts: [],
    hiddenCaplets: caplets
      .filter((caplet) => caplet.disabled || caplet.setup || caplet.projectBinding?.required)
      .map((caplet) => ({
        capletId: caplet.server,
        reason: caplet.disabled
          ? ("disabled" as const)
          : caplet.setup
            ? ("setup_required" as const)
            : ("project_binding_required" as const),
      })),
  };
}
