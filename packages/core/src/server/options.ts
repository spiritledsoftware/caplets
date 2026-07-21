import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import {
  currentHostAdminUrl,
  currentHostAttachUrl,
  currentHostUrl,
  currentHostV1Url,
} from "../current-host/topology";
import { CapletsError } from "../errors";

export type CapletsMode = "auto" | "local" | "remote";

export type CapletsServerEnv = Partial<
  Record<"CAPLETS_MODE" | "CAPLETS_SERVER_URL" | "CAPLETS_PROJECT_ROOT", string>
>;

export type CapletsModeInput = {
  mode?: string;
  serverUrl?: string;
};

export type CapletsServerInput = {
  url?: string;
  fetch?: typeof fetch;
};

export type CapletsServerAuth = { type: "none" };

export type ResolvedCapletsServer = {
  baseUrl: URL;
  mcpUrl: URL;
  attachUrl: URL;
  adminUrl: URL;
  healthUrl: URL;
  auth: CapletsServerAuth;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

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

  const baseUrl = new URL(canonicalizeCurrentHostOrigin(rawUrl));
  const auth: CapletsServerAuth = { type: "none" };

  return {
    baseUrl,
    mcpUrl: currentHostUrl(baseUrl, "mcp"),
    attachUrl: currentHostAttachUrl(baseUrl),
    adminUrl: currentHostAdminUrl(baseUrl),
    healthUrl: currentHostV1Url(baseUrl, "health"),
    auth,
    requestInit: {},
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
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
