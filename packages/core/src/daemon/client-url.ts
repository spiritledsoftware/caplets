import { CapletsError } from "../errors";
import { isLoopbackHost, parseServerBaseUrl } from "../server/options";
import type { DaemonConfig } from "./types";

export function daemonClientBaseUrl(config: Pick<DaemonConfig, "serve">): URL {
  const host = daemonClientHost(config.serve.host);
  return parseServerBaseUrl(
    `http://${formatDaemonClientHost(host)}:${config.serve.port}${config.serve.path}`,
  );
}

export function isWildcardBindHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function daemonClientHost(host: string): string {
  if (isWildcardBindHost(host)) return "127.0.0.1";
  if (isLoopbackHost(host)) return host;
  throw new CapletsError(
    "REQUEST_INVALID",
    `Default Caplets daemon client URL must use a loopback host; daemon is configured for ${host}.`,
  );
}

function formatDaemonClientHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
