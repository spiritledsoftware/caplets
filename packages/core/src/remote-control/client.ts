import { CAPLETS_ERROR_CODES, CapletsError, redactSecrets, toSafeError } from "../errors";
import type { CapletsErrorCode } from "../errors";
import { controlUrlForBase } from "../server/options";
import type { RemoteCliCommand, RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlClientOptions = {
  baseUrl: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export class RemoteControlClient {
  readonly #baseUrl: URL;
  readonly #requestInit: RequestInit;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteControlClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#requestInit = options.requestInit;
    this.#fetch = options.fetch ?? fetch;
  }

  async request(command: RemoteCliCommand, args: RemoteCliRequest["arguments"]): Promise<unknown> {
    const controlUrl = controlUrlForBase(this.#baseUrl);
    let response: Response;
    try {
      response = await this.#fetch(controlUrl, {
        ...this.#requestInit,
        method: "POST",
        headers: mergeJsonHeaders(this.#requestInit.headers),
        body: JSON.stringify({ command, arguments: args }),
      });
    } catch (error) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Could not connect to Caplets server at ${safeBaseUrl(this.#baseUrl)}.`,
        toSafeError(error, "SERVER_UNAVAILABLE"),
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Caplets server authentication failed. Check CAPLETS_SERVER_USER and CAPLETS_SERVER_PASSWORD.",
      );
    }

    if (!response.ok) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Caplets server at ${safeBaseUrl(this.#baseUrl)} returned HTTP ${response.status}.`,
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
