import { CapletsError } from "../errors";
import { servicePaths } from "../serve/http";
import type { DaemonConfig, DaemonHealthResult } from "./types";
import { serviceCommand } from "./shell";

export async function validateDaemonCommand(
  config: DaemonConfig,
  options: {
    fetch?: typeof fetch;
    successSettleMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<DaemonHealthResult> {
  const bindHost = await validateBindHost(config);
  if (!bindHost.ok) return bindHost;
  const { spawn } = await import("node:child_process");
  const command = validationSpawnCommand(config);
  const child = spawn(command.command, command.args, {
    cwd: config.command.workingDirectory,
    env: config.command.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let processDone = false;
  let processError: string | undefined;
  const processFailure = new Promise<DaemonHealthResult>((resolve) => {
    child.once("error", (error) => {
      processDone = true;
      processError = error.message;
      resolve({ ok: false, url: healthUrl(config), error: processError });
    });
    child.once("exit", (code, signal) => {
      processDone = true;
      processError = `validation process exited${code === null ? "" : ` with code ${code}`}${signal ? ` due to ${signal}` : ""}`;
      resolve({ ok: false, url: healthUrl(config), error: processError });
    });
  });
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    let last: DaemonHealthResult | undefined;
    while (Date.now() < deadline) {
      if (processDone) break;
      last = await Promise.race([
        probeDaemonHealth(config, {
          ...(options.fetch ? { fetch: options.fetch } : {}),
          skipBindHostValidation: true,
          timeoutMs: 750,
        }),
        processFailure,
      ]);
      if (last.ok) {
        const settled = await Promise.race([
          processFailure,
          sleep(options.successSettleMs ?? 1_000).then(() => undefined),
        ]);
        return settled ?? last;
      }
      if (processDone) break;
      await sleep(150);
    }
    return (
      last ?? {
        ok: false,
        url: healthUrl(config),
        error:
          processError ?? (processDone ? "validation process exited" : "health probe timed out"),
      }
    );
  } finally {
    if (!processDone) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([closed, sleep(2_000)]);
    }
  }
}

async function validateBindHost(config: DaemonConfig): Promise<DaemonHealthResult> {
  const { createServer } = await import("node:net");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, config.serve.host, () => resolve());
    });
    return { ok: true, url: healthUrl(config) };
  } catch (error) {
    return {
      ok: false,
      url: healthUrl(config),
      error: `bind host validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

export async function probeDaemonHealth(
  config: DaemonConfig,
  options: {
    fetch?: typeof fetch;
    port?: number;
    skipBindHostValidation?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<DaemonHealthResult> {
  if (options.skipBindHostValidation !== true) {
    const bindHost = await validateBindHost(config);
    if (!bindHost.ok) return bindHost;
  }
  const fetchImpl = options.fetch ?? fetch;
  const url = healthUrl(config, options.port);
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return { ok: response.ok, url, status: response.status };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function assertDaemonHealth(result: DaemonHealthResult, label: string): void {
  if (!result.ok) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `${label} failed for ${result.url}${result.status ? ` with HTTP ${result.status}` : ""}${result.error ? `: ${result.error}` : ""}`,
    );
  }
}

export async function allocateLoopbackPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new CapletsError("SERVER_UNAVAILABLE", "Could not allocate a validation port.");
  }
  return address.port;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function healthUrl(config: DaemonConfig, port = config.serve.port): string {
  return `http://${formatHost(config.serve.host)}:${port}${servicePaths(config.serve.path).health}`;
}

function validationSpawnCommand(config: DaemonConfig): { command: string; args: string[] } {
  const planned = serviceCommand(config);
  return { command: planned.executable, args: planned.args };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
