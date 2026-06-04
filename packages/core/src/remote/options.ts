import { Buffer } from "node:buffer";
import { CapletsError } from "../errors";
import { appendBasePath, parseServerBaseUrl } from "../server/options";

export type CapletsRemoteEnv = Partial<
  Record<
    | "CAPLETS_MODE"
    | "CAPLETS_REMOTE_URL"
    | "CAPLETS_REMOTE_USER"
    | "CAPLETS_REMOTE_PASSWORD"
    | "CAPLETS_REMOTE_TOKEN"
    | "CAPLETS_REMOTE_WORKSPACE"
    | "CAPLETS_SERVER_URL",
    string
  >
>;

export type CapletsRemoteModeInput = {
  mode?: string;
  remoteUrl?: string;
};

export type CapletsRemoteMode = "local" | "remote" | "cloud";

export type CapletsRemoteInput = {
  url?: string;
  user?: string;
  password?: string;
  token?: string;
  workspace?: string;
  fetch?: typeof fetch;
};

export type CapletsRemoteAuth =
  | { type: "none"; user: string }
  | { type: "basic"; user: string; password: string }
  | { type: "bearer"; token: string };

export type ResolvedCapletsRemote = {
  baseUrl: URL;
  mcpUrl: URL;
  controlUrl: URL;
  healthUrl: URL;
  projectBindingWebSocketUrl: URL;
  auth: CapletsRemoteAuth;
  requestInit: RequestInit;
  workspace?: string | undefined;
  fetch?: typeof fetch;
};

const DEFAULT_REMOTE_USER = "caplets";

export function resolveRemoteMode(
  input: CapletsRemoteModeInput = {},
  env: CapletsRemoteEnv = process.env,
): { mode: CapletsRemoteMode } {
  const mode = parseCapletsMode(input.mode ?? env.CAPLETS_MODE ?? "auto");
  if (mode === "local") return { mode: "local" };

  const rawUrl =
    nonEmpty(input.remoteUrl, "remoteUrl") ??
    nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");
  if (mode === "remote") {
    if (rawUrl === undefined) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_MODE=remote requires CAPLETS_REMOTE_URL or remoteUrl.",
      );
    }
    return { mode: "remote" };
  }

  if (mode === "cloud") {
    if (rawUrl === undefined) {
      throw new CapletsError("REQUEST_INVALID", "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL.");
    }
    if (!isCapletsCloudUrl(rawUrl)) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL to point at Caplets Cloud.",
      );
    }
    return { mode: "cloud" };
  }

  if (rawUrl === undefined) return { mode: "local" };
  return isCapletsCloudUrl(rawUrl) ? { mode: "cloud" } : { mode: "remote" };
}

export function resolveCapletsRemote(
  input: CapletsRemoteInput = {},
  env: CapletsRemoteEnv = process.env,
): ResolvedCapletsRemote {
  const rawUrl =
    nonEmpty(input.url, "url") ?? nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");
  if (rawUrl === undefined) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_REMOTE_URL or url is required.");
  }

  const baseUrl = parseServerBaseUrl(rawUrl);
  const token =
    nonEmpty(input.token, "token") ?? nonEmpty(env.CAPLETS_REMOTE_TOKEN, "CAPLETS_REMOTE_TOKEN");
  const userWasExplicit = input.user !== undefined || hasEnv(env.CAPLETS_REMOTE_USER);
  const user =
    nonEmpty(input.user, "user") ??
    nonEmpty(env.CAPLETS_REMOTE_USER, "CAPLETS_REMOTE_USER") ??
    DEFAULT_REMOTE_USER;
  const password =
    nonEmpty(input.password, "password") ??
    nonEmpty(env.CAPLETS_REMOTE_PASSWORD, "CAPLETS_REMOTE_PASSWORD");
  const workspace =
    nonEmpty(input.workspace, "workspace") ??
    nonEmpty(env.CAPLETS_REMOTE_WORKSPACE, "CAPLETS_REMOTE_WORKSPACE");

  if (token && password) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Use either CAPLETS_REMOTE_TOKEN or CAPLETS_REMOTE_PASSWORD, not both.",
    );
  }

  if (!token && userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote Caplets Basic Auth requires a password; set CAPLETS_REMOTE_PASSWORD or password.",
    );
  }

  const auth: CapletsRemoteAuth = token
    ? { type: "bearer", token }
    : password === undefined
      ? { type: "none", user }
      : { type: "basic", user, password };
  const requestInit: RequestInit =
    auth.type === "bearer"
      ? { headers: { Authorization: `Bearer ${auth.token}` } }
      : auth.type === "basic"
        ? { headers: { Authorization: basicAuthHeader(auth.user, auth.password) } }
        : {};

  return {
    baseUrl,
    mcpUrl: appendBasePath(baseUrl, "mcp"),
    controlUrl: appendBasePath(baseUrl, "control"),
    healthUrl: appendBasePath(baseUrl, "healthz"),
    projectBindingWebSocketUrl: projectBindingWebSocketUrlForBase(baseUrl),
    auth,
    requestInit,
    ...(workspace ? { workspace } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function projectBindingWebSocketUrlForBase(baseUrl: URL): URL {
  const url = appendBasePath(baseUrl, "control/project-bindings/connect");
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url;
}

export function isCapletsCloudUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "cloud.caplets.dev" || host.endsWith(".preview.caplets.dev");
}

function parseCapletsMode(value: string): "auto" | CapletsRemoteMode {
  if (value === "auto" || value === "local" || value === "remote" || value === "cloud") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_MODE to be auto, local, remote, or cloud, got ${value}`,
  );
}

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  return trimmed;
}

function hasEnv(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
