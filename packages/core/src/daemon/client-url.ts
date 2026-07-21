import { CapletsError } from "../errors";
import {
  canonicalizeCurrentHostOrigin,
  isLoopbackCurrentHostHostname,
} from "../current-host/origin";
import type { DaemonConfig } from "./types";

export function daemonClientBaseUrl(config: Pick<DaemonConfig, "serve">): URL {
  const host = daemonClientHost(config.serve.host);
  return new URL(
    canonicalizeCurrentHostOrigin(`http://${formatDaemonClientHost(host)}:${config.serve.port}`),
  );
}

export function isWildcardBindHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function daemonClientHost(host: string): string {
  if (isWildcardBindHost(host)) return "127.0.0.1";
  if (isLoopbackCurrentHostHostname(host)) return host;
  throw new CapletsError(
    "REQUEST_INVALID",
    `Default Caplets daemon client URL must use a loopback host; daemon is configured for ${host}.`,
  );
}

function formatDaemonClientHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
