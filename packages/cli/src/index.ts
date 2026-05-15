import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { CapletsRuntime, runCli } from "@caplets/core";

async function main() {
  if (process.argv[2] && process.argv[2] !== "serve") {
    await runCli(process.argv.slice(2));
    return;
  }

  const runtime = process.env.CAPLETS_CONFIG
    ? new CapletsRuntime({ configPath: process.env.CAPLETS_CONFIG })
    : new CapletsRuntime();

  const shutdown = async () => {
    await runtime.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  const transport = new StdioServerTransport();
  await runtime.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
