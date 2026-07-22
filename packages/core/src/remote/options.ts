import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import {
  currentHostAdminUrl,
  currentHostAttachUrl,
  currentHostProjectBindingWebSocketUrl,
  currentHostUrl,
  currentHostV1Url,
} from "../current-host/topology";
import { CapletsError } from "../errors";

export type CapletsRemoteEnv = Partial<Record<"CAPLETS_MODE" | "CAPLETS_REMOTE_URL", string>>;

export type CapletsRemoteModeInput = {
  mode?: string;
  remoteUrl?: string;
};

export type CapletsRemoteMode = "local" | "remote";

export type CapletsRemoteInput = {
  url?: string;
  token?: string;
  fetch?: typeof fetch;
};

export type CapletsRemoteAuth = { type: "none"; user: string } | { type: "bearer"; token: string };

export type ResolvedCapletsRemote = {
  baseUrl: URL;
  mcpUrl: URL;
  attachUrl: URL;
  adminUrl: URL;
  healthUrl: URL;
  projectBindingWebSocketUrl: URL;
  auth: CapletsRemoteAuth;
  requestInit: RequestInit;
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

  return { mode: rawUrl === undefined ? "local" : "remote" };
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

  const baseUrl = new URL(canonicalizeCurrentHostOrigin(rawUrl));
  const token = nonEmpty(input.token, "token");

  const auth: CapletsRemoteAuth = token
    ? { type: "bearer", token }
    : { type: "none", user: DEFAULT_REMOTE_USER };
  const requestInit: RequestInit =
    auth.type === "bearer" ? { headers: { Authorization: `Bearer ${auth.token}` } } : {};

  return {
    baseUrl,
    mcpUrl: currentHostUrl(baseUrl, "mcp"),
    attachUrl: currentHostAttachUrl(baseUrl),
    adminUrl: currentHostAdminUrl(baseUrl),
    healthUrl: currentHostV1Url(baseUrl, "health"),
    projectBindingWebSocketUrl: currentHostProjectBindingWebSocketUrl(baseUrl),
    auth,
    requestInit,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

export function normalizeRemoteProfileHostUrl(value: string): string {
  return canonicalizeCurrentHostOrigin(value);
}

function parseCapletsMode(value: string): "auto" | CapletsRemoteMode {
  if (value === "auto" || value === "local" || value === "remote") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_MODE to be auto, local, or remote, got ${value}`,
  );
}

function nonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new CapletsError("REQUEST_INVALID", `${label} must not be empty`);
  return trimmed;
}
