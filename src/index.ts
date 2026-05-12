import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { version as packageJsonVersion } from "../package.json";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { loadConfig } from "./config.js";
import { DownstreamManager } from "./downstream.js";
import { errorResult } from "./errors.js";
import { OpenApiManager } from "./openapi.js";
import { capabilityDescription, ServerRegistry } from "./registry.js";
import { generatedToolInputSchema, handleServerTool } from "./tools.js";
import { runCli } from "./cli.js";

async function main() {
  if (process.argv[2] && process.argv[2] !== "serve") {
    await runCli(process.argv.slice(2));
    return;
  }

  const config = loadConfig(process.env.CAPLETS_CONFIG);
  const registry = new ServerRegistry(config);
  const downstream = new DownstreamManager(registry);
  const openapi = new OpenApiManager(registry);
  const server = new McpServer({
    name: "caplets",
    version: packageJsonVersion,
  });

  for (const capletServer of registry.enabledServers()) {
    server.registerTool(
      capletServer.server,
      {
        title: capletServer.name,
        description: capabilityDescription(capletServer),
        inputSchema: generatedToolInputSchema,
      },
      async (request) => {
        try {
          return await handleServerTool(capletServer, request, registry, downstream, openapi);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  const shutdown = async () => {
    await downstream.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
