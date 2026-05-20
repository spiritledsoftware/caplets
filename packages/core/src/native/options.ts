import { CapletsError } from "../errors";
import {
  mcpUrlForBase,
  resolveCapletsMode,
  resolveCapletsServer,
  type CapletsMode,
  type CapletsServerEnv,
  type CapletsServerInput,
} from "../server/options";

export type NativeCapletsMode = CapletsMode;

export type NativeRemoteCapletsOptions = {
  pollIntervalMs?: number;
  fetch?: typeof fetch;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  server?: CapletsServerInput;
  remote?: NativeRemoteCapletsOptions;
};

export type NativeCapletsEnv = CapletsServerEnv;

export type NativeRemoteAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | {
      mode: "remote";
      remote: {
        url: URL;
        auth: NativeRemoteAuthOptions;
        pollIntervalMs: number;
        requestInit: RequestInit;
        fetch?: typeof fetch;
      };
    };

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const mode = resolveCapletsMode(
    {
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.server?.url ? { serverUrl: input.server.url } : {}),
    },
    env,
  );
  if (mode.mode === "local") {
    return { mode: "local" };
  }

  const serverFetch = input.remote?.fetch ?? input.server?.fetch;
  const server = resolveCapletsServer(
    { ...input.server, ...(serverFetch ? { fetch: serverFetch } : {}) },
    env,
  );

  return {
    mode: "remote",
    remote: {
      url: mcpUrlForBase(server.baseUrl),
      auth: server.auth,
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit: server.requestInit,
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}

function parsePollInterval(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (!Number.isInteger(value) || value < 1_000) {
    throw new CapletsError("REQUEST_INVALID", "remote.pollIntervalMs must be an integer >= 1000.");
  }
  return value;
}
