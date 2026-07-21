import { CapletsError } from "../errors";
import type { RemoteCliCommand, RemoteCliRequest } from "../remote-control/types";
import { REMOTE_CLI_COMMAND_DESTINATIONS } from "../remote-control/types";
import { discoverRemoteCliTransport, type RemoteCliTransportDiscovery } from "./discovery";

export type RemoteCliCommandAdapter = {
  request(command: RemoteCliCommand, args: RemoteCliRequest["arguments"]): Promise<unknown>;
};

export type ResolvedRemoteCliConnection = {
  baseUrl: URL;
  attachUrl: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export type MigratingRemoteCliClientOptions = {
  resolve: () => Promise<ResolvedRemoteCliConnection>;
  createAdmin: (
    resolved: ResolvedRemoteCliConnection,
    bearerToken: string,
  ) => RemoteCliCommandAdapter;
  createLegacy: (resolved: ResolvedRemoteCliConnection) => RemoteCliCommandAdapter;
  createAttach: (resolved: ResolvedRemoteCliConnection) => RemoteCliCommandAdapter;
  createPublicAuth: (resolved: ResolvedRemoteCliConnection) => RemoteCliCommandAdapter;
};

type SelectedRemoteCliConnection = {
  resolved: ResolvedRemoteCliConnection;
  discovery: RemoteCliTransportDiscovery;
};

/** Selects one proven transport and keeps command destinations authoritative. */
export class MigratingRemoteCliClient implements RemoteCliCommandAdapter {
  readonly #options: MigratingRemoteCliClientOptions;
  #selection: Promise<SelectedRemoteCliConnection> | undefined;
  #admin: RemoteCliCommandAdapter | undefined;
  #legacy: RemoteCliCommandAdapter | undefined;
  #attach: RemoteCliCommandAdapter | undefined;
  #publicAuth: RemoteCliCommandAdapter | undefined;

  constructor(options: MigratingRemoteCliClientOptions) {
    this.#options = options;
  }

  async request(command: RemoteCliCommand, args: RemoteCliRequest["arguments"]): Promise<unknown> {
    const destination = REMOTE_CLI_COMMAND_DESTINATIONS[command];
    if (destination === "local_only_rejection") {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Remote ${command} is local-only. Run caplets ${command} on the machine whose files should change.`,
      );
    }

    const selected = await this.#select();
    if (destination === "attach") {
      this.#attach ??= this.#options.createAttach(selected.resolved);
      return await this.#attach.request(command, args);
    }

    if (selected.discovery.kind === "legacy-v1") {
      if (
        command === "storage_records_import" ||
        command === "storage_records_update" ||
        command === "storage_records_export"
      ) {
        throw new CapletsError(
          "UNSUPPORTED_CAPABILITY",
          `Remote ${command} requires Admin v2 streaming bundle support.`,
        );
      }
      this.#legacy ??= this.#options.createLegacy(selected.resolved);
      return await this.#legacy.request(command, args);
    }
    if (destination === "public_auth_self_service") {
      this.#publicAuth ??= this.#options.createPublicAuth(selected.resolved);
      return await this.#publicAuth.request(command, args);
    }

    const bearerToken = pairedBearerToken(selected.resolved.requestInit);
    this.#admin ??= this.#options.createAdmin(selected.resolved, bearerToken);
    return await this.#admin.request(command, args);
  }

  #select(): Promise<SelectedRemoteCliConnection> {
    this.#selection ??= this.#options.resolve().then(async (resolved) => ({
      resolved,
      discovery: await discoverRemoteCliTransport({
        baseUrl: resolved.baseUrl,
        ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
      }),
    }));
    return this.#selection;
  }
}

/** Extracts the already-selected and refreshed Remote Profile bearer credential. */
export function pairedBearerToken(requestInit: RequestInit): string {
  const authorization = new Headers(requestInit.headers).get("authorization");
  const matched = /^Bearer ([A-Za-z0-9._~+/-]+={0,})$/iu.exec(authorization ?? "");
  if (!matched?.[1]) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Remote Admin access requires an active paired Remote Profile credential.",
    );
  }
  return matched[1];
}
