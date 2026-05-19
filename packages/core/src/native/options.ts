import { Buffer } from "node:buffer";

import { CapletsError } from "../errors";

export type NativeCapletsMode = "auto" | "local" | "remote";

export type NativeRemoteCapletsOptions = {
  url?: string;
  user?: string;
  password?: string;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  remote?: NativeRemoteCapletsOptions;
};

export type NativeCapletsEnv = Partial<
  Record<
    | "CAPLETS_NATIVE_MODE"
    | "CAPLETS_REMOTE_URL"
    | "CAPLETS_REMOTE_USER"
    | "CAPLETS_REMOTE_PASSWORD",
    string
  >
>;

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

const DEFAULT_REMOTE_USER = "caplets";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const mode = parseMode(input.mode ?? env.CAPLETS_NATIVE_MODE ?? "auto");
  if (mode === "local") {
    return { mode: "local" };
  }

  const rawUrl =
    nonEmpty(input.remote?.url, "remote.url") ??
    nonEmpty(env.CAPLETS_REMOTE_URL, "CAPLETS_REMOTE_URL");
  if (mode === "remote" && rawUrl === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_NATIVE_MODE=remote requires CAPLETS_REMOTE_URL or remote.url.",
    );
  }
  if (rawUrl === undefined) {
    return { mode: "local" };
  }

  const url = parseRemoteUrl(rawUrl);
  const userWasExplicit = input.remote?.user !== undefined || hasEnv(env.CAPLETS_REMOTE_USER);
  const user =
    nonEmpty(input.remote?.user, "remote.user") ??
    nonEmpty(env.CAPLETS_REMOTE_USER, "CAPLETS_REMOTE_USER") ??
    DEFAULT_REMOTE_USER;
  const password =
    nonEmpty(input.remote?.password, "remote.password") ??
    nonEmpty(env.CAPLETS_REMOTE_PASSWORD, "CAPLETS_REMOTE_PASSWORD");

  if (userWasExplicit && password === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote Caplets Basic Auth requires a password; set CAPLETS_REMOTE_PASSWORD or remote.password.",
    );
  }

  const auth: NativeRemoteAuthOptions =
    password === undefined ? { enabled: false, user } : { enabled: true, user, password };
  const requestInit: RequestInit = auth.enabled
    ? { headers: { Authorization: basicAuthHeader(auth.user, auth.password) } }
    : {};

  return {
    mode: "remote",
    remote: {
      url,
      auth,
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit,
      ...(input.remote?.fetch ? { fetch: input.remote.fetch } : {}),
    },
  };
}

function parseMode(value: string): NativeCapletsMode {
  if (value === "auto" || value === "local" || value === "remote") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Expected CAPLETS_NATIVE_MODE to be auto, local, or remote, got ${value}`,
  );
}

function parseRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapletsError("REQUEST_INVALID", `Invalid remote Caplets URL: ${value}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return url;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    "Remote Caplets URL must use https except loopback development URLs.",
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
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
