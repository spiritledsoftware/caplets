import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { z } from "zod";
import { version as packageJsonVersion } from "../../package.json";
import type { NativeCapletTool, NativeCapletsService } from "../native/service";

export type NativeToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

export type NativeCapletsMcpSessionOptions = {
  server?: NativeToolServer;
};

export class NativeCapletsMcpSession {
  readonly server: NativeToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly service: NativeCapletsService,
    options: NativeCapletsMcpSessionOptions = {},
  ) {
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.unsubscribe = service.onToolsChanged((tools) => this.reconcileTools(tools));
    this.reconcileTools(service.listTools());
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.tools.clear();
    await this.server.close();
    await this.service.close();
  }

  private reconcileTools(next: NativeCapletTool[]): void {
    const enabled = new Map(next.map((tool) => [tool.caplet, tool]));
    for (const [id, registered] of this.tools) {
      const tool = enabled.get(id);
      if (!tool) {
        registered.remove();
        this.tools.delete(id);
        continue;
      }
      registered.update(this.definition(tool));
    }
    for (const tool of enabled.values()) {
      if (!this.tools.has(tool.caplet)) {
        this.tools.set(
          tool.caplet,
          this.server.registerTool(
            tool.caplet,
            this.definition(tool),
            async (request: unknown) =>
              nativeToolResult(await this.service.execute(tool.caplet, request)) as never,
          ),
        );
      }
    }
  }

  private definition(tool: NativeCapletTool) {
    return {
      title: tool.title,
      description: tool.description,
      inputSchema: isRecord(tool.inputSchema) ? jsonSchemaToZodShape(tool.inputSchema) : undefined,
      ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
    };
  }
}

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    shape[key] = jsonSchemaPropertyToZod(value);
  }
  return shape;
}

function jsonSchemaPropertyToZod(value: unknown): z.ZodTypeAny {
  if (!isRecord(value)) return z.unknown().optional();
  if (Array.isArray(value.enum) && value.enum.every((item) => typeof item === "string")) {
    const values = value.enum as string[];
    if (values.length > 0) return z.enum(values as [string, ...string[]]).optional();
  }
  switch (value.type) {
    case "string":
      return z.string().optional();
    case "number":
    case "integer":
      return z.number().optional();
    case "boolean":
      return z.boolean().optional();
    case "array":
      return z.array(z.unknown()).optional();
    case "object":
      return z.record(z.string(), z.unknown()).optional();
    default:
      return z.unknown().optional();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: true;
} {
  if (isCallToolResult(result)) {
    return result;
  }
  const isError = isRecord(result) && (result.isError === true || result.ok === false);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

function isCallToolResult(value: unknown): value is {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: true;
} {
  return isRecord(value) && Array.isArray(value.content);
}
