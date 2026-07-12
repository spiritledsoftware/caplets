import { CAPLETS_ERROR_CODES, CapletsError, redactSecrets, toSafeError } from "../errors";
import type { CapletsErrorCode } from "../errors";
import { controlUrlForBase } from "../server/options";
import type { AuthorityCapletRecord } from "../storage/bundle-cache";
import type { AuthorityGenerationIdentity } from "../storage/types";
import type {
  CurrentHostAuthorityHealth,
  CurrentHostSetupMutation,
} from "../current-host/operations";
import type { CurrentHostSettingsPatch } from "../current-host/settings-operations";
import type { RemoteCliCommand, RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteCurrentHostMutationOptions = {
  expectedGeneration?: AuthorityGenerationIdentity | null | undefined;
  idempotencyKey?: string | undefined;
};

export type RemoteCurrentHostHealth = {
  remote: true;
  status: "ok" | "degraded" | "unavailable";
  health?: CurrentHostAuthorityHealth | undefined;
};

export type RemoteCurrentHostCaplets = {
  remote: true;
  caplets: unknown[];
};

export type RemoteCurrentHostResult = Record<string, unknown> & { remote: true };

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

  /** List server Caplets without creating a per-request engine. */
  async list(args: RemoteCliRequest["arguments"] = {}): Promise<unknown> {
    return await this.request("list", args);
  }

  /** Read redacted Current Host status and storage health. */
  async status(): Promise<unknown> {
    return await this.request("status", {});
  }
  /** Read Current Host caplets through the authenticated Operator control route. */
  async currentHostCaplets(): Promise<RemoteCurrentHostCaplets> {
    return (await this.request("list", {})) as RemoteCurrentHostCaplets;
  }

  /** Read Current Host authority and runtime health through the Operator control route. */
  async currentHostHealth(): Promise<RemoteCurrentHostHealth> {
    return (await this.request("status", {})) as RemoteCurrentHostHealth;
  }

  async currentHostCapletCreate(
    record: AuthorityCapletRecord,
    options: RemoteCurrentHostMutationOptions = {},
  ): Promise<RemoteCurrentHostResult> {
    return (await this.request("caplet_create", {
      record,
      ...currentHostMutationArguments(options),
    })) as RemoteCurrentHostResult;
  }

  async currentHostCapletUpdate(
    id: string,
    record: AuthorityCapletRecord,
    options: RemoteCurrentHostMutationOptions = {},
  ): Promise<RemoteCurrentHostResult> {
    return (await this.request("caplet_update", {
      id,
      record,
      ...currentHostMutationArguments(options),
    })) as RemoteCurrentHostResult;
  }

  async currentHostCapletDelete(
    id: string,
    options: RemoteCurrentHostMutationOptions = {},
  ): Promise<RemoteCurrentHostResult> {
    return (await this.request("caplet_delete", {
      id,
      ...currentHostMutationArguments(options),
    })) as RemoteCurrentHostResult;
  }

  async currentHostSettingsGet(): Promise<RemoteCurrentHostResult> {
    return (await this.request("settings_get", {})) as RemoteCurrentHostResult;
  }

  async currentHostSettingsUpdate(
    settings: CurrentHostSettingsPatch,
    options: RemoteCurrentHostMutationOptions = {},
  ): Promise<RemoteCurrentHostResult> {
    return (await this.request("settings_update", {
      settings,
      ...currentHostMutationArguments(options),
    })) as RemoteCurrentHostResult;
  }

  async currentHostSetup(
    command: "setup_grant" | "setup_revoke",
    mutation: CurrentHostSetupMutation,
    options: RemoteCurrentHostMutationOptions = {},
  ): Promise<RemoteCurrentHostResult> {
    return (await this.request(command, {
      ...mutation,
      ...currentHostMutationArguments(options),
    })) as RemoteCurrentHostResult;
  }

  /** Execute one remote request against the retained server epoch. */
  async execute(caplet: string, request: Record<string, unknown>): Promise<unknown> {
    return await this.request("execute", { caplet, request });
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
        redactRemoteMessage(payload.error.message, sensitiveValues(command, args)),
        payload.error.nextAction === undefined
          ? undefined
          : { nextAction: payload.error.nextAction },
      );
    }

    return payload.result;
  }
}
function currentHostMutationArguments(
  options: RemoteCurrentHostMutationOptions,
): Record<string, unknown> {
  return {
    ...(options.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: options.expectedGeneration }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  };
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

function redactRemoteMessage(message: string, values: string[] = []): string {
  let redacted = String(redactSecrets(message));
  for (const value of values) {
    if (value.length === 0) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b((?:access_)?token=)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:token|secret|authorization|auth|api[-_]?key|password|credential|clientsecret|client_secret|code|refresh(?:_token)?)\s*[=:]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    );
}

function sensitiveValues(command: RemoteCliCommand, args: RemoteCliRequest["arguments"]): string[] {
  if (command === "vault_set" && typeof args.value === "string") return [args.value];
  return [];
}
