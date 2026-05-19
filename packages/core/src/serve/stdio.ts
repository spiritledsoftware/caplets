import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsMcpSession } from "./session";

export type ServeStdioOptions = CapletsEngineOptions & {
  signalHandling?: boolean;
};

export async function serveStdio(options: ServeStdioOptions = {}): Promise<void> {
  const engine = new CapletsEngine(options);
  const session = new CapletsMcpSession(engine);
  let closing = false;

  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await session.close();
    } finally {
      await engine.close();
    }
  };

  if (options.signalHandling !== false) {
    process.once("SIGINT", () => void close().finally(() => process.exit(130)));
    process.once("SIGTERM", () => void close().finally(() => process.exit(143)));
  }

  await session.connect(new StdioServerTransport());
}
