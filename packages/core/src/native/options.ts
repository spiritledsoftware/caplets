import { CapletsError } from "../errors";
import {
  resolveCapletsRemote,
  resolveRemoteMode,
  type CapletsRemoteAuth,
  type CapletsRemoteEnv,
} from "../remote/options";

type CapletsMode = "auto" | "local" | "remote" | "daemon";

export type NativeCapletsMode = CapletsMode;

export type NativeRemoteCapletsOptions = {
  url?: string;
  fetch?: typeof fetch;
  requestHeaders?: Record<string, string>;
  pollIntervalMs?: number;
};

export type NativeDaemonCapletsOptions = {
  url?: string;
  fetch?: typeof fetch;
  requestHeaders?: Record<string, string>;
  pollIntervalMs?: number;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  remote?: NativeRemoteCapletsOptions;
  daemon?: NativeDaemonCapletsOptions;
};

export type NativeCapletsEnv = CapletsRemoteEnv &
  Partial<Record<"CAPLETS_MODE" | "CAPLETS_DAEMON_URL", string>>;

const NATIVE_RUNTIME_SELECTION_ENV_KEYS: Array<keyof NativeCapletsEnv> = [
  "CAPLETS_MODE",
  "CAPLETS_REMOTE_URL",
  "CAPLETS_DAEMON_URL",
];

export function hasNativeRuntimeSelectionEnv(env: NativeCapletsEnv = process.env): boolean {
  return NATIVE_RUNTIME_SELECTION_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export type NativeRemoteAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedNativeRemoteOptions = {
  origin: URL;
  auth: NativeRemoteAuthOptions;
  pollIntervalMs: number;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | { mode: "remote"; remote: ResolvedNativeRemoteOptions }
  | { mode: "daemon"; remote: ResolvedNativeRemoteOptions };

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const explicitMode = input.mode ?? env.CAPLETS_MODE;
  const daemonUrl = input.daemon?.url ?? env.CAPLETS_DAEMON_URL;
  if (explicitMode === "daemon") return resolveNativeDaemonOptions(input, env);
  if ((explicitMode === undefined || explicitMode === "auto") && daemonUrl?.trim()) {
    return resolveNativeDaemonOptions(input, env);
  }

  const mode = resolveRemoteMode(
    {
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.remote?.url ? { remoteUrl: input.remote.url } : {}),
    },
    env,
  );
  if (mode.mode === "local") return { mode: "local" };

  const server = resolveCapletsRemote(
    {
      ...(input.remote?.url ? { url: input.remote.url } : {}),
      ...(input.remote?.fetch ? { fetch: input.remote.fetch } : {}),
    },
    env,
  );
  return {
    mode: "remote",
    remote: {
      origin: server.baseUrl,
      auth: nativeAuthFromRemoteAuth(server.auth),
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit: withRequestHeaders(server.requestInit, input.remote?.requestHeaders),
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}

function resolveNativeDaemonOptions(
  input: NativeCapletsServiceResolutionInput,
  env: NativeCapletsEnv,
): ResolvedNativeCapletsServiceOptions {
  const daemonUrl = input.daemon?.url ?? env.CAPLETS_DAEMON_URL;
  if (!daemonUrl) {
    throw new CapletsError("REQUEST_INVALID", "Native daemon mode requires daemon.url.");
  }
  const server = resolveCapletsRemote(
    {
      url: daemonUrl,
      ...(input.daemon?.fetch ? { fetch: input.daemon.fetch } : {}),
    },
    {},
  );
  if (server.baseUrl.protocol !== "http:") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Native daemon mode requires a loopback HTTP daemon URL.",
    );
  }
  return {
    mode: "daemon",
    remote: {
      origin: server.baseUrl,
      auth: nativeAuthFromRemoteAuth(server.auth),
      pollIntervalMs: parsePollInterval(input.daemon?.pollIntervalMs),
      requestInit: withRequestHeaders(server.requestInit, input.daemon?.requestHeaders),
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}

function withRequestHeaders(
  requestInit: RequestInit,
  requestHeaders: Record<string, string> | undefined,
): RequestInit {
  if (!requestHeaders) return requestInit;
  const headers = new Headers(requestInit.headers);
  for (const [name, value] of Object.entries(requestHeaders)) headers.set(name, value);
  return { ...requestInit, headers };
}

function nativeAuthFromRemoteAuth(auth: CapletsRemoteAuth): NativeRemoteAuthOptions {
  if (auth.type === "none") return { enabled: false, user: auth.user };
  return { enabled: false, user: "caplets" };
}

function parsePollInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(value) || value < 1_000) {
    throw new CapletsError("REQUEST_INVALID", "remote.pollIntervalMs must be an integer >= 1000.");
  }
  return value;
}
