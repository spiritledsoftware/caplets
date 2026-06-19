import { CapletsError } from "../errors";
import { appendBasePath, parseServerBaseUrl } from "../server/options";

export type CapletsRemoteEnv = Partial<
  Record<"CAPLETS_MODE" | "CAPLETS_REMOTE_URL" | "CAPLETS_REMOTE_WORKSPACE", string>
>;

export type CapletsRemoteModeInput = {
  mode?: string;
  remoteUrl?: string;
};

export type CapletsRemoteMode = "local" | "remote" | "cloud";

export type CapletsRemoteInput = {
  url?: string;
  token?: string;
  workspace?: string;
  fetch?: typeof fetch;
};

export type CapletsRemoteAuth = { type: "none"; user: string } | { type: "bearer"; token: string };

export type ResolvedCapletsRemote = {
  baseUrl: URL;
  mcpUrl: URL;
  attachUrl: URL;
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
  const token = nonEmpty(input.token, "token");
  const workspace =
    nonEmpty(input.workspace, "workspace") ??
    nonEmpty(env.CAPLETS_REMOTE_WORKSPACE, "CAPLETS_REMOTE_WORKSPACE");

  const auth: CapletsRemoteAuth = token
    ? { type: "bearer", token }
    : { type: "none", user: DEFAULT_REMOTE_USER };
  const requestInit: RequestInit =
    auth.type === "bearer" ? { headers: { Authorization: `Bearer ${auth.token}` } } : {};

  return {
    baseUrl,
    mcpUrl: appendBasePath(baseUrl, "v1/mcp"),
    attachUrl: appendBasePath(baseUrl, "v1/attach"),
    controlUrl: appendBasePath(baseUrl, "v1/admin"),
    healthUrl: appendBasePath(baseUrl, "v1/healthz"),
    projectBindingWebSocketUrl: projectBindingWebSocketUrlForBase(baseUrl),
    auth,
    requestInit,
    ...(workspace ? { workspace } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function resolveHostedCloudRemote(
  input: CapletsRemoteInput = {},
  env: CapletsRemoteEnv = process.env,
): ResolvedCapletsRemote {
  const rawUrl =
    nonEmpty(input.url, "url") ?? nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");
  if (rawUrl === undefined) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_REMOTE_URL or url is required.");
  }

  const cloud = parseHostedCloudRemoteUrl(rawUrl);
  const workspace =
    cloud.workspace ??
    nonEmpty(input.workspace, "workspace") ??
    nonEmpty(env.CAPLETS_REMOTE_WORKSPACE, "CAPLETS_REMOTE_WORKSPACE");
  if (!workspace) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets Cloud remote URL requires a selected workspace.",
    );
  }

  const token = nonEmpty(input.token, "token");
  const auth: CapletsRemoteAuth = token
    ? { type: "bearer", token }
    : { type: "none", user: DEFAULT_REMOTE_USER };
  const requestInit: RequestInit =
    auth.type === "bearer" ? { headers: { Authorization: `Bearer ${auth.token}` } } : {};
  const workspaceBaseUrl = appendBasePath(cloud.baseUrl, `v1/ws/${encodeURIComponent(workspace)}`);

  return {
    baseUrl: cloud.baseUrl,
    mcpUrl: appendBasePath(workspaceBaseUrl, "mcp"),
    attachUrl: appendBasePath(workspaceBaseUrl, "attach"),
    controlUrl: appendBasePath(cloud.baseUrl, "v1/admin"),
    healthUrl: appendBasePath(cloud.baseUrl, "v1/healthz"),
    projectBindingWebSocketUrl: webSocketUrl(
      appendBasePath(workspaceBaseUrl, "attach/project-bindings/connect"),
    ),
    auth,
    requestInit,
    workspace,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function hostedCloudWorkspaceFromRemoteUrl(value: string): string | undefined {
  try {
    return parseHostedCloudRemoteUrl(value).workspace;
  } catch {
    return undefined;
  }
}

export function normalizeRemoteProfileHostUrl(value: string): string {
  const url = parseServerBaseUrl(value);
  if (isCapletsCloudUrl(url.toString())) {
    return `${url.origin}/`;
  }
  return url.toString();
}

export function projectBindingWebSocketUrlForBase(baseUrl: URL): URL {
  return webSocketUrl(appendBasePath(baseUrl, "v1/attach/project-bindings/connect"));
}

function webSocketUrl(input: URL): URL {
  const url = new URL(input);
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

function parseHostedCloudRemoteUrl(value: string): { baseUrl: URL; workspace?: string } {
  const url = parseServerBaseUrl(value);
  if (!isCapletsCloudUrl(url.toString())) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets Cloud remote URL must point at Caplets Cloud.",
    );
  }

  const baseUrl = new URL(url);
  baseUrl.pathname = "/";
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname === "") return { baseUrl };
  const match = pathname.match(/^(?:\/v1)?\/ws\/([^/]+)(?:\/(?:mcp|attach))?$/u);
  if (!match) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplets Cloud remote URL must be the Cloud origin or /ws/<workspace>/mcp endpoint.",
    );
  }
  return {
    baseUrl,
    workspace: decodeURIComponent(match[1] ?? ""),
  };
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

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  return trimmed;
}
