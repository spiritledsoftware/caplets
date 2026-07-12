import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { loadAuthorityBootstrap } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError } from "../errors";
import {
  assembleCapletsHost,
  type PreparedRuntimeHost,
  type RuntimeEpochCoordinatorOptions,
} from "../storage/coordinator";
import { CapletsMcpSession } from "./session";
export type ServeStdioOptions = CapletsEngineOptions &
  RuntimeEpochCoordinatorOptions & {
    signalHandling?: boolean;
  };

export async function serveStdio(options: ServeStdioOptions = {}): Promise<void> {
  const asyncAuthority = configuredSharedAuthority(options);
  let runtimeHost: PreparedRuntimeHost | undefined;
  let engine: CapletsEngine;
  let session: CapletsMcpSession;
  if (asyncAuthority) {
    runtimeHost = await assembleCapletsHost({
      ...options,
      engineOptions: { ...options, watch: false },
    });
    const lease = runtimeHost.retain();
    engine = lease.view.engine;
    session = new CapletsMcpSession(engine, { runtimeLease: lease });
  } else {
    engine = new CapletsEngine(options);
    session = new CapletsMcpSession(engine);
  }
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await session.close();
    } finally {
      if (runtimeHost) await runtimeHost.close();
      else await engine.close();
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

  const transport = new StdioServerTransport();
  const transportClosed = new Promise<void>((resolve) => {
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      resolve();
    };
  });

  try {
    await session.connect(transport);
    await transportClosed;
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (sigtermHandler) process.off("SIGTERM", sigtermHandler);
    await close();
  }
}

function configuredSharedAuthority(options: ServeStdioOptions): boolean {
  if (options.authority || options.authorityFactory) return true;
  try {
    const loaded = loadAuthorityBootstrap(
      options.configPath,
      process.env,
      undefined,
      options.projectConfigPath === undefined ? {} : { projectPath: options.projectConfigPath },
    );
    return loaded.bootstrap.provider !== "filesystem";
  } catch (error) {
    if (error instanceof CapletsError && error.code === "CONFIG_NOT_FOUND") return false;
    throw error;
  }
}
