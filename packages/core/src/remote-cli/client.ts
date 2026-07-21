import { CapletsError } from "../errors";
import {
  REMOTE_CLI_COMMAND_DESTINATIONS,
  type RemoteCliArguments,
  type RemoteCliCommand,
} from "./types";

export type RemoteCliCommandAdapter = {
  request(command: RemoteCliCommand, args: RemoteCliArguments): Promise<unknown>;
};

export type ResolvedRemoteCliConnection = {
  baseUrl: URL;
  attachUrl: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch;
};

export type RemoteCliClientOptions = {
  resolve: () => Promise<ResolvedRemoteCliConnection>;
  createAdmin: (
    resolved: ResolvedRemoteCliConnection,
    bearerToken: string,
  ) => RemoteCliCommandAdapter;
  createAttach: (resolved: ResolvedRemoteCliConnection) => RemoteCliCommandAdapter;
  createPublicAuth: (resolved: ResolvedRemoteCliConnection) => RemoteCliCommandAdapter;
};

/** Routes CLI intents only to canonical Current Host protocol adapters. */
export class RemoteCliClient implements RemoteCliCommandAdapter {
  readonly #options: RemoteCliClientOptions;
  #connection: Promise<ResolvedRemoteCliConnection> | undefined;
  #admin: RemoteCliCommandAdapter | undefined;
  #attach: RemoteCliCommandAdapter | undefined;
  #publicAuth: RemoteCliCommandAdapter | undefined;

  constructor(options: RemoteCliClientOptions) {
    this.#options = options;
  }

  async request(command: RemoteCliCommand, args: RemoteCliArguments): Promise<unknown> {
    const destination = REMOTE_CLI_COMMAND_DESTINATIONS[command];
    if (destination === "local_only_rejection") {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Remote ${command} is local-only. Run caplets ${command} on the machine whose files should change.`,
      );
    }

    const resolved = await this.#resolve();
    if (destination === "attach") {
      this.#attach ??= this.#options.createAttach(resolved);
      return await this.#attach.request(command, args);
    }
    if (destination === "public_auth_self_service") {
      this.#publicAuth ??= this.#options.createPublicAuth(resolved);
      return await this.#publicAuth.request(command, args);
    }

    const bearerToken = pairedBearerToken(resolved.requestInit);
    this.#admin ??= this.#options.createAdmin(resolved, bearerToken);
    return await this.#admin.request(command, args);
  }

  #resolve(): Promise<ResolvedRemoteCliConnection> {
    this.#connection ??= this.#options.resolve();
    return this.#connection;
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
