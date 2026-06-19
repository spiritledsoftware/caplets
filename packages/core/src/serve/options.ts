import { CapletsError } from "../errors";
import { parseServerBaseUrl } from "../server/options";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { join } from "node:path";

export type ServeTransport = "stdio" | "http";

export type RawServeOptions = {
  transport?: string;
  host?: string;
  port?: string | number;
  path?: string;
  remoteStatePath?: string;
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
  auth: HttpServeAuthOptions;
  remoteCredentialStateDir?: string | undefined;
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

const HTTP_ONLY_OPTIONS = [
  "host",
  "port",
  "path",
  "remoteStatePath",
  "allowUnauthenticatedHttp",
  "trustProxy",
] as const;

export function resolveServeOptions(
  raw: RawServeOptions,
  env: ServeEnv = process.env,
): ServeOptions {
  const transport = parseTransport(raw.transport ?? "stdio");
  if (transport === "stdio") {
    const invalid = HTTP_ONLY_OPTIONS.filter((key) => raw[key] !== undefined);
    if (invalid.length > 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `${invalid.map((key) => `--${key}`).join(", ")} ${invalid.length === 1 ? "is" : "are"} only valid with --transport http`,
      );
    }
    return { transport };
  }

  const serverUrl = env.CAPLETS_SERVER_URL
    ? parseServeServerUrl(nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL")!)
    : undefined;
  const host = nonEmpty(raw.host, "--host") ?? serverUrlHost(serverUrl) ?? "127.0.0.1";
  const port = parsePort(raw.port ?? (serverUrl?.port ? Number(serverUrl.port) : 5387));
  const path = normalizeHttpPath(raw.path ?? serverUrl?.pathname ?? "/");
  const remoteCredentialStateDir =
    nonEmpty(raw.remoteStatePath, "--remote-state-path") ??
    nonEmpty(env.CAPLETS_REMOTE_SERVER_STATE_DIR, "CAPLETS_REMOTE_SERVER_STATE_DIR") ??
    join(DEFAULT_AUTH_DIR, "remote-server");

  const loopback = isLoopbackHost(host);
  const auth: HttpServeAuthOptions =
    raw.allowUnauthenticatedHttp === true
      ? { type: "development_unauthenticated" }
      : { type: "remote_credentials" };
  if (
    !loopback &&
    auth.type === "development_unauthenticated" &&
    raw.allowUnauthenticatedHttp !== true
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Unauthenticated HTTP serving on non-loopback hosts requires --allow-unauthenticated-http.",
    );
  }
  return {
    transport,
    host,
    port,
    path,
    ...(serverUrl ? { publicOrigin: serverUrl.origin } : {}),
    auth,
    ...(auth.type === "remote_credentials" ? { remoteCredentialStateDir } : {}),
    allowUnauthenticatedHttp: raw.allowUnauthenticatedHttp === true,
    warnUnauthenticatedNetwork: !loopback && auth.type === "development_unauthenticated",
    loopback,
    trustProxy: raw.trustProxy === true,
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLocaleLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
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
