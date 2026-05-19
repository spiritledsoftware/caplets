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

  let sigintHandler: (() => void) | undefined;
  let sigtermHandler: (() => void) | undefined;

  if (options.signalHandling !== false) {
    sigintHandler = () => void close().finally(() => process.exit(130));
    sigtermHandler = () => void close().finally(() => process.exit(143));
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);
  }

  try {
    await session.connect(new StdioServerTransport());
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (sigtermHandler) process.off("SIGTERM", sigtermHandler);
    await close();
  }
}
