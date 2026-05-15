import { CliToolsManager } from "../cli-tools.js";
import {
  type CapletsConfig,
  loadConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "../config.js";
import { DownstreamManager } from "../downstream.js";
import { errorResult } from "../errors.js";
import { GraphQLManager } from "../graphql.js";
import { HttpActionManager } from "../http-actions.js";
import { OpenApiManager } from "../openapi.js";
import { ServerRegistry } from "../registry.js";
import { handleServerTool } from "../tools.js";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
} from "./tools.js";

export type NativeCapletsServiceOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
};

export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
};

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  close(): Promise<void>;
};

export function createNativeCapletsService(
  options: NativeCapletsServiceOptions = {},
): NativeCapletsService {
  return new DefaultNativeCapletsService(options);
}

class DefaultNativeCapletsService implements NativeCapletsService {
  private readonly config: CapletsConfig;
  private readonly registry: ServerRegistry;
  private readonly downstream: DownstreamManager;
  private readonly openapi: OpenApiManager;
  private readonly graphql: GraphQLManager;
  private readonly http: HttpActionManager;
  private readonly cli: CliToolsManager;

  constructor(options: NativeCapletsServiceOptions) {
    const configPath = resolveConfigPath(options.configPath);
    const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
    this.config = loadConfig(configPath, projectConfigPath);
    this.registry = new ServerRegistry(this.config);
    const authOptions = options.authDir ? { authDir: options.authDir } : undefined;
    this.downstream = new DownstreamManager(this.registry, authOptions);
    this.openapi = new OpenApiManager(this.registry, authOptions);
    this.graphql = new GraphQLManager(this.registry, authOptions);
    this.http = new HttpActionManager(this.registry, authOptions);
    this.cli = new CliToolsManager(this.registry);
  }

  listTools(): NativeCapletTool[] {
    return this.registry.enabledServers().map((caplet) => {
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
    try {
      const caplet = this.registry.require(capletId);
      return await handleServerTool(
        caplet,
        request,
        this.registry,
        this.downstream,
        this.openapi,
        this.graphql,
        this.http,
        this.cli,
      );
    } catch (error) {
      return errorResult(error);
    }
  }

  async close(): Promise<void> {
    await this.downstream.close();
  }
}
