import { Buffer } from "node:buffer";

import { CapletsError } from "../errors";

export type CapletsMode = "auto" | "local" | "remote";

export type CapletsServerEnv = Partial<
  Record<
    | "CAPLETS_MODE"
    | "CAPLETS_SERVER_URL"
    | "CAPLETS_SERVER_USER"
    | "CAPLETS_SERVER_PASSWORD"
    | "CAPLETS_CLOUD_URL"
    | "CAPLETS_CLOUD_TOKEN"
    | "CAPLETS_CLOUD_WORKSPACE_ID"
    | "CAPLETS_PROJECT_ROOT",
    string
  >
>;

export type CapletsModeInput = {
  mode?: string;
  serverUrl?: string;
};

export type CapletsServerInput = {
  url?: string;
  user?: string;
  password?: string;
  fetch?: typeof fetch;
};

export type CapletsServerAuth =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedCapletsServer = {
  baseUrl: URL;
  mcpUrl: URL;
  controlUrl: URL;
  healthUrl: URL;
  auth: CapletsServerAuth;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

const DEFAULT_SERVER_USER = "caplets";

export function resolveCapletsMode(
  input: CapletsModeInput = {},
  env: CapletsServerEnv = process.env,
): { mode: "local" } | { mode: "remote" } {
  const mode = parseCapletsMode(input.mode ?? env.CAPLETS_MODE ?? "auto");
  if (mode === "local") {
    return { mode: "local" };
  }

  const rawUrl =
    nonEmpty(input.serverUrl, "serverUrl") ??
    nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL");
  if (mode === "remote") {
    if (rawUrl === undefined) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_MODE=remote requires CAPLETS_SERVER_URL or serverUrl.",
      );
    }
    return { mode: "remote" };
  }

  return rawUrl === undefined ? { mode: "local" } : { mode: "remote" };
}

export function resolveCapletsServer(
  input: CapletsServerInput = {},
  env: CapletsServerEnv = process.env,
): ResolvedCapletsServer {
  const rawUrl =
    nonEmpty(input.url, "url") ?? nonEmpty(env.CAPLETS_SERVER_URL, "CAPLETS_SERVER_URL");
  if (rawUrl === undefined) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_SERVER_URL or url is required.");
  }

  const baseUrl = parseServerBaseUrl(rawUrl);
  const userWasExplicit = input.user !== undefined || hasEnv(env.CAPLETS_SERVER_USER);
  const user =
    nonEmpty(input.user, "user") ??
    nonEmpty(env.CAPLETS_SERVER_USER, "CAPLETS_SERVER_USER") ??
    DEFAULT_SERVER_USER;
  const password =
    nonEmpty(input.password, "password") ??
    nonEmpty(env.CAPLETS_SERVER_PASSWORD, "CAPLETS_SERVER_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets server Basic Auth requires a password; set CAPLETS_SERVER_PASSWORD or password.",
    );
  }

  const auth: CapletsServerAuth =
    password === undefined ? { enabled: false, user } : { enabled: true, user, password };
  const requestInit: RequestInit = auth.enabled
    ? { headers: { Authorization: basicAuthHeader(auth.user, auth.password) } }
    : {};

  return {
    baseUrl,
    mcpUrl: mcpUrlForBase(baseUrl),
    controlUrl: controlUrlForBase(baseUrl),
    healthUrl: healthUrlForBase(baseUrl),
    auth,
    requestInit,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function mcpUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "mcp");
}

export function controlUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "control");
}

export function healthUrlForBase(baseUrl: URL): URL {
  return appendBasePath(baseUrl, "healthz");
}

export function appendBasePath(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.href);
  const basePath = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${basePath}/${path}`;
  return url;
}

export function parseServerBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Invalid Caplets server URL.");
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets server URL must not include username, password, query string, or fragment.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets server URL must use https except loopback development URLs.",
    );
  }

  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/u, "");
  return url;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLocaleLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function parseCapletsMode(value: string): CapletsMode {
  if (value === "auto" || value === "local" || value === "remote") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_MODE to be auto, local, or remote, got ${value}`,
  );
}

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
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
