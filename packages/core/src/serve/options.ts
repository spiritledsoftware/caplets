import { CapletsError } from "../errors";
import { parseServerBaseUrl } from "../server/options";

export type ServeTransport = "stdio" | "http";

export type RawServeOptions = {
  transport?: string;
  host?: string;
  port?: string | number;
  path?: string;
  user?: string;
  password?: string;
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
  auth: HttpBasicAuthOptions;
  allowUnauthenticatedHttp: boolean;
  warnUnauthenticatedNetwork: boolean;
  loopback: boolean;
  trustProxy: boolean;
};

export type HttpBasicAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ServeOptions = StdioServeOptions | HttpServeOptions;

export type ServeEnv = Partial<
  Record<"CAPLETS_SERVER_URL" | "CAPLETS_SERVER_USER" | "CAPLETS_SERVER_PASSWORD", string>
>;

const HTTP_ONLY_OPTIONS = [
  "host",
  "port",
  "path",
  "user",
  "password",
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
  const userWasExplicit = raw.user !== undefined || hasEnv(env.CAPLETS_SERVER_USER);
  const user =
    nonEmpty(raw.user, "--user") ??
    nonEmpty(env.CAPLETS_SERVER_USER, "CAPLETS_SERVER_USER") ??
    "caplets";
  const password =
    nonEmpty(raw.password, "--password") ??
    nonEmpty(env.CAPLETS_SERVER_PASSWORD, "CAPLETS_SERVER_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "HTTP Basic Auth requires a password; pass --password or set CAPLETS_SERVER_PASSWORD.",
    );
  }

  const loopback = isLoopbackHost(host);
  const auth =
    password === undefined
      ? { enabled: false as const, user }
      : { enabled: true as const, user, password };
  if (!loopback && !auth.enabled && raw.allowUnauthenticatedHttp !== true) {
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
    allowUnauthenticatedHttp: raw.allowUnauthenticatedHttp === true,
    warnUnauthenticatedNetwork: !loopback && !auth.enabled,
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

function hasEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
