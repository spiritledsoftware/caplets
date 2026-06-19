import { CapletsError } from "../errors";
import { servicePaths } from "../serve/http";
import type { DaemonConfig, DaemonHealthResult } from "./types";
import { shellQuote } from "./shell";

export async function validateDaemonCommand(
  config: DaemonConfig,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<DaemonHealthResult> {
  const { spawn } = await import("node:child_process");
  const command = validationSpawnCommand(config);
  const child = spawn(command.command, command.args, {
    cwd: config.command.workingDirectory,
    env: { ...process.env, ...config.command.env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    let last: DaemonHealthResult | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      last = await probeDaemonHealth(config, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        timeoutMs: 750,
      });
      if (last.ok) return last;
      await sleep(150);
    }
    return (
      last ?? {
        ok: false,
        url: healthUrl(config),
        error: child.exitCode === null ? "health probe timed out" : "validation process exited",
      }
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

export async function probeDaemonHealth(
  config: DaemonConfig,
  options: {
    fetch?: typeof fetch;
    port?: number;
    timeoutMs?: number;
  } = {},
): Promise<DaemonHealthResult> {
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
  const argv = [config.command.executable, ...config.command.args];
  if (!config.command.shell) return { command: process.execPath, args: argv };
  return {
    command: config.command.shell.executable,
    args: [
      ...config.command.shell.args,
      `${shellQuote(process.execPath)} ${argv.map(shellQuote).join(" ")}`,
    ],
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
