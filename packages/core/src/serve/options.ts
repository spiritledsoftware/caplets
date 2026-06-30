import { CapletsError } from "../errors";
import { isLoopbackHost, parseServerBaseUrl } from "../server/options";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { join } from "node:path";
import type { ServeConfig } from "../config";

export type ServeTransport = "stdio" | "http";

export type RawServeOptions = {
  transport?: string;
  host?: string;
  port?: string | number;
  path?: string;
  remoteStatePath?: string;
  upstreamUrl?: string;
  allowUnauthenticatedHttp?: boolean;
  trustProxy?: boolean;
};

export type StdioServeOptions = {
  transport: "stdio";
};

export type HttpServeOptions = {
  transport: "http";
  host: string;
  port: number;
  path: string;
  publicOrigin?: string | undefined;
  publicOrigins?: string[] | undefined;
  auth: HttpServeAuthOptions;
  remoteCredentialStateDir?: string | undefined;
  upstreamUrl?: string | undefined;
  allowUnauthenticatedHttp: boolean;
  warnUnauthenticatedNetwork: boolean;
  loopback: boolean;
  trustProxy: boolean;
};

export type HttpServeAuthOptions =
  | { type: "remote_credentials" }
  | { type: "development_unauthenticated" };

export type ServeOptions = StdioServeOptions | HttpServeOptions;

export type ServeEnv = Partial<
  Record<"CAPLETS_SERVER_URL" | "CAPLETS_REMOTE_SERVER_STATE_DIR", string>
>;

export type ServeDefaults = Partial<ServeConfig>;

const HTTP_ONLY_OPTIONS = [
  "host",
  "port",
  "path",
  "remoteStatePath",
  "upstreamUrl",
  "allowUnauthenticatedHttp",
  "trustProxy",
] as const;

const HTTP_ONLY_OPTION_FLAGS = {
  host: "--host",
  port: "--port",
  path: "--path",
  remoteStatePath: "--remote-state-path",
  upstreamUrl: "--upstream-url",
  allowUnauthenticatedHttp: "--allow-unauthenticated-http",
  trustProxy: "--trust-proxy",
} as const satisfies Record<(typeof HTTP_ONLY_OPTIONS)[number], string>;

export function resolveServeOptions(
  raw: RawServeOptions,
  env: ServeEnv = process.env,
  defaults?: ServeDefaults | undefined,
): ServeOptions {
  const transport = parseTransport(raw.transport ?? "stdio");
  if (transport === "stdio") {
    const invalid = HTTP_ONLY_OPTIONS.filter((key) => raw[key] !== undefined);
    if (invalid.length > 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `${invalid.map((key) => HTTP_ONLY_OPTION_FLAGS[key]).join(", ")} ${invalid.length === 1 ? "is" : "are"} only valid with --transport http`,
      );
    }
    return { transport };
  }

  const serverUrl = env.CAPLETS_SERVER_URL
    ? parseServeServerUrl(nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL")!)
    : undefined;
  const publicOrigins = serverUrl ? [serverUrl.origin] : (defaults?.publicOrigins ?? []);
  const publicOrigin = publicOrigins[0];
  const host =
    nonEmpty(raw.host, "--host") ?? serverUrlHost(serverUrl) ?? defaults?.host ?? "127.0.0.1";
  const port = parsePort(
    raw.port ?? (serverUrl?.port ? Number(serverUrl.port) : (defaults?.port ?? 5387)),
  );
  const path = normalizeHttpPath(raw.path ?? serverUrl?.pathname ?? defaults?.path ?? "/");
  const remoteCredentialStateDir =
    nonEmpty(raw.remoteStatePath, "--remote-state-path") ??
    nonEmpty(env.CAPLETS_REMOTE_SERVER_STATE_DIR, "CAPLETS_REMOTE_SERVER_STATE_DIR") ??
    nonEmpty(defaults?.remoteStatePath, "serve.remoteStatePath") ??
    join(DEFAULT_AUTH_DIR, "remote-server");
  const upstreamUrl =
    nonEmpty(raw.upstreamUrl, "--upstream-url") ??
    nonEmpty(defaults?.upstreamUrl, "serve.upstreamUrl");
  if (upstreamUrl) {
    rejectSelfReferentialUpstream(upstreamUrl, {
      ...(publicOrigin ? { origin: publicOrigin } : {}),
      host,
      port,
      path,
    });
  }

  const loopback = isLoopbackHost(host);
  const allowUnauthenticatedHttp =
    raw.allowUnauthenticatedHttp ?? defaults?.allowUnauthenticatedHttp ?? false;
  const auth: HttpServeAuthOptions =
    allowUnauthenticatedHttp === true
      ? { type: "development_unauthenticated" }
      : { type: "remote_credentials" };
  const trustProxy = raw.trustProxy ?? defaults?.trustProxy ?? false;
  return {
    transport,
    host,
    port,
    path,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(publicOrigins.length > 0 ? { publicOrigins } : {}),
    auth,
    ...(auth.type === "remote_credentials" ? { remoteCredentialStateDir } : {}),
    ...(upstreamUrl ? { upstreamUrl } : {}),
    allowUnauthenticatedHttp,
    warnUnauthenticatedNetwork: !loopback && auth.type === "development_unauthenticated",
    loopback,
    trustProxy,
  };
}

function parseServeServerUrl(value: string): URL {
  try {
    return parseServerBaseUrl(value);
  } catch (error) {
    if (
      error instanceof CapletsError &&
      error.message.includes("must use https except loopback development URLs")
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_SERVER_URL must use https except loopback development URLs; use --host, --port, and --path separately for non-loopback HTTP bind addresses.",
      );
    }
    throw error;
  }
}

function parseTransport(value: string): ServeTransport {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected --transport to be stdio or http, got ${value}`,
  );
}

function parsePort(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Expected --port to be a valid TCP port, got ${value}`,
    );
  }
  return parsed;
}

function normalizeHttpPath(value: string): string {
  if (!value.startsWith("/")) {
    throw new CapletsError("REQUEST_INVALID", "HTTP --path must start with /");
  }
  if (value.includes("?") || value.includes("#")) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "HTTP --path must not include a query string or fragment",
    );
  }
  return value === "/" ? value : value.replace(/\/+$/u, "");
}

function serverUrlHost(url: URL | undefined): string | undefined {
  return url?.hostname.replace(/^\[(.*)\]$/u, "$1");
}

function rejectSelfReferentialUpstream(
  upstreamUrl: string,
  local: { origin?: string; host: string; port: number; path: string },
): void {
  const upstream = parseServerBaseUrl(upstreamUrl);
  const localBase = localServeBaseUrl(local);
  if (sameServerBase(upstream, localBase)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--upstream-url must not point back to this runtime.",
    );
  }
}

function localServeBaseUrl(local: { origin?: string; host: string; port: number; path: string }) {
  const origin = local.origin ?? `http://${formatHost(local.host)}:${local.port}`;
  const url = new URL(origin);
  url.pathname = local.path;
  url.search = "";
  url.hash = "";
  return url;
}

function sameServerBase(left: URL, right: URL): boolean {
  return (
    left.protocol === right.protocol &&
    sameHost(left.hostname, right.hostname) &&
    effectivePort(left) === effectivePort(right) &&
    normalizePath(left.pathname) === normalizePath(right.pathname)
  );
}

function sameHost(left: string, right: string): boolean {
  if (left === right) return true;
  const normalizedLeft = normalizeLoopbackHost(left);
  const normalizedRight = normalizeLoopbackHost(right);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function normalizeLoopbackHost(host: string): "loopback" | undefined {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (normalized === "localhost" || normalized === "::1") return "loopback";
  if (normalized === "0.0.0.0" || normalized === "::") return "loopback";
  if (/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return "loopback";
  return undefined;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function normalizePath(path: string): string {
  return path === "/" ? "/" : path.replace(/\/+$/u, "");
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  }
  return trimmed;
}
