import { CapletsError, toSafeError } from "../errors";
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

    const payload = (await response.json()) as RemoteCliResponse;
    if (!payload.ok) {
      throw new CapletsError(
        payload.error.code,
        payload.error.message,
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
