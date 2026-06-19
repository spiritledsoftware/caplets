import { CAPLETS_ERROR_CODES, CapletsError, redactSecrets, toSafeError } from "../errors";
import type { CapletsErrorCode } from "../errors";
import { controlUrlForBase } from "../server/options";
import type { RemoteCliCommand, RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlClientOptions = {
  baseUrl: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export type ResolvedRemoteControlClientOptions = RemoteControlClientOptions;

export class RemoteControlClient {
  readonly #resolve: () => Promise<ResolvedRemoteControlClientOptions>;

  constructor(
    options:
      | RemoteControlClientOptions
      | { resolve: () => Promise<ResolvedRemoteControlClientOptions> },
  ) {
    this.#resolve =
      "resolve" in options
        ? options.resolve
        : async () => ({
            baseUrl: options.baseUrl,
            requestInit: options.requestInit,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
  }

  async request(command: RemoteCliCommand, args: RemoteCliRequest["arguments"]): Promise<unknown> {
    const resolved = await this.#resolve();
    const controlUrl = controlUrlForBase(resolved.baseUrl);
    const requestInit = resolved.requestInit;
    const fetchImpl = resolved.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(controlUrl, {
        ...requestInit,
        method: "POST",
        headers: mergeJsonHeaders(requestInit.headers),
        body: JSON.stringify({ command, arguments: args }),
      });
    } catch (error) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Could not connect to Caplets server at ${safeBaseUrl(resolved.baseUrl)}.`,
        toSafeError(error, "SERVER_UNAVAILABLE"),
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new CapletsError(
        "AUTH_FAILED",
        `Caplets remote authentication failed. Run caplets remote login ${safeBaseUrl(resolved.baseUrl)}.`,
      );
    }

    if (!response.ok) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Caplets server at ${safeBaseUrl(resolved.baseUrl)} returned HTTP ${response.status}.`,
      );
    }

    const payload = await parseRemoteCliResponse(response);
    if (!payload.ok) {
      throw new CapletsError(
        payload.error.code,
        redactRemoteMessage(payload.error.message),
        payload.error.nextAction === undefined
          ? undefined
          : { nextAction: payload.error.nextAction },
      );
    }

    return payload.result;
  }
}

function mergeJsonHeaders(headers: ConstructorParameters<typeof Headers>[0] | undefined): Headers {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json");
  return merged;
}

function safeBaseUrl(baseUrl: URL): string {
  const safe = new URL(baseUrl.href);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.toString();
}

async function parseRemoteCliResponse(response: Response): Promise<RemoteCliResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw invalidRemoteControlResponse(error);
  }

  if (!isRecord(payload)) {
    throw invalidRemoteControlResponse();
  }

  if (payload.ok === true) {
    if (!("result" in payload)) {
      throw invalidRemoteControlResponse();
    }
    return { ok: true, result: payload.result };
  }

  if (payload.ok === false) {
    const error = payload.error;
    if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      throw invalidRemoteControlResponse();
    }
    if (
      "nextAction" in error &&
      error.nextAction !== undefined &&
      typeof error.nextAction !== "string"
    ) {
      throw invalidRemoteControlResponse();
    }
    const errorResponse: RemoteCliResponse = {
      ok: false,
      error: {
        code: isCapletsErrorCode(error.code) ? error.code : "DOWNSTREAM_TOOL_ERROR",
        message: error.message,
      },
    };
    if (typeof error.nextAction === "string") {
      errorResponse.error.nextAction = error.nextAction;
    }
    return errorResponse;
  }

  throw invalidRemoteControlResponse();
}

function invalidRemoteControlResponse(cause?: unknown): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    "Caplets server returned an invalid remote control response.",
    cause === undefined ? undefined : toSafeError(cause, "DOWNSTREAM_PROTOCOL_ERROR"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapletsErrorCode(value: string): value is CapletsErrorCode {
  return CAPLETS_ERROR_CODES.includes(value as CapletsErrorCode);
}

function redactRemoteMessage(message: string): string {
  return String(redactSecrets(message))
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b((?:access_)?token=)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:token|secret|authorization|auth|api[-_]?key|password|credential|clientsecret|client_secret|code|refresh(?:_token)?)\s*[=:]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    );
}
