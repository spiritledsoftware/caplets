import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { version as packageJsonVersion } from "../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import type { CapletsEngine } from "../engine";
import { capabilityDescription } from "../registry";
import { generatedToolInputSchemaForCaplet } from "../generated-tool-input-schema";
import { listCodeModeCallableCaplets } from "../code-mode/api";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import { runCodeMode } from "../code-mode/runner";
import { codeModeRunInputSchema, codeModeRunParamsSchema } from "../code-mode/tool";
import { CodeModeLogStore } from "../code-mode/logs";
import type { NativeCapletTool, NativeCapletsService } from "../native/service";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
} from "../native/tools";

export type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

export type CapletsMcpSessionOptions = {
  server?: ToolServer;
};

export class CapletsMcpSession {
  readonly server: ToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly codeModeRunTool: RegisteredTool;
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
    this.codeModeRunTool = this.registerCodeModeRunTool();
    this.unsubscribeReload = this.engine.onReload(({ previous, next }) =>
      this.reconcileTools(previous, next),
    );
    this.reconcileTools(undefined, this.engine.currentConfig());
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeReload();
    this.codeModeRunTool.remove();
    this.tools.clear();
    await this.server.close();
  }

  private registerCodeModeRunTool(): RegisteredTool {
    const codeModeService = new EngineNativeCapletsService(this.engine);
    return this.server.registerTool(
      "run",
      {
        title: "Code Mode",
        description: codeModeRunToolDescription(codeModeService),
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
          logStore: new CodeModeLogStore(),
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
          meta: {
            runId: "",
            traceId: "",
            declarationHash: "",
            durationMs: 0,
            timeoutMs: 0,
            maxTimeoutMs: 0,
          },
        };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError: !envelope.ok,
    };
  }

  private reconcileTools(previous: CapletsConfig | undefined, next: CapletsConfig): void {
    if (previous) {
      this.codeModeRunTool.update({
        title: "Code Mode",
        description: codeModeRunToolDescription(new EngineNativeCapletsService(this.engine)),
        paramsSchema: codeModeRunParamsSchema,
        callback: async (request: unknown) => this.handleCodeModeRunTool(request),
        enabled: true,
      });
    }

    const enabled = new Map(nextEnabledServers(next).map((server) => [server.server, server]));

    for (const [serverId, tool] of this.tools) {
      const caplet = enabled.get(serverId);
      if (!caplet) {
        tool.remove();
        this.tools.delete(serverId);
        continue;
      }

      const previousCaplet = previous ? capletById(previous, serverId) : undefined;
      if (!previousCaplet || serializeCaplet(previousCaplet) !== serializeCaplet(caplet)) {
        tool.update({
          title: caplet.name,
          description: capabilityDescription(caplet),
          paramsSchema: generatedToolInputSchemaForCaplet(caplet).shape,
          callback: async (request: unknown) => this.handleTool(serverId, request),
          enabled: true,
        });
      }
    }

    for (const caplet of enabled.values()) {
      if (this.tools.has(caplet.server)) {
        continue;
      }
      this.tools.set(caplet.server, this.registerCapletTool(caplet));
    }
  }

  private registerCapletTool(caplet: CapletConfig): RegisteredTool {
    return this.server.registerTool(
      caplet.server,
      {
        title: caplet.name,
        description: capabilityDescription(caplet),
        inputSchema: generatedToolInputSchemaForCaplet(caplet).shape,
      },
      async (request: unknown) => this.handleTool(caplet.server, request),
    );
  }

  private async handleTool(serverId: string, request: unknown): Promise<any> {
    return await this.engine.execute(serverId, request);
  }
}

function codeModeRunToolDescription(service: NativeCapletsService): string {
  const declaration = generateCodeModeDeclarations({
    caplets: listCodeModeCallableCaplets(service),
  });
  return generateCodeModeRunToolDescription(declaration);
}

class EngineNativeCapletsService implements NativeCapletsService {
  constructor(private readonly engine: CapletsEngine) {}

  listTools(): NativeCapletTool[] {
    return this.engine.enabledServers().map((caplet) => {
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

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ].filter((server) => !server.disabled);
}

function capletById(config: CapletsConfig, serverId: string): CapletConfig | undefined {
  return (
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.graphqlEndpoints[serverId] ??
    config.httpApis[serverId] ??
    config.cliTools[serverId] ??
    config.capletSets[serverId]
  );
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}
