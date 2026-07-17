import type { CapletsErrorCode } from "../errors";
import type {
  CurrentHostManagementInspectResult,
  CurrentHostManagementListResult,
  CurrentHostManagementMutation,
  CurrentHostManagementMutationResult,
  CurrentHostManagementPreviewResult,
  CurrentHostManagementResource,
  CurrentHostManagementStatusResult,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostPortableOperationOutcome,
} from "../current-host/operations";

export type RemoteCliCommand =
  | "list"
  | "inspect"
  | "check"
  | "tools"
  | "search_tools"
  | "describe_tool"
  | "call_tool"
  | "resources"
  | "search_resources"
  | "resource_templates"
  | "read_resource"
  | "prompts"
  | "search_prompts"
  | "get_prompt"
  | "complete"
  | "init"
  | "add"
  | "install"
  | "update"
  | "complete_cli"
  | "auth_login_start"
  | "auth_login_complete"
  | "auth_logout"
  | "auth_refresh"
  | "auth_list"
  | "vault_set"
  | "vault_list"
  | "vault_get"
  | "vault_delete"
  | "vault_access_grant"
  | "vault_access_revoke"
  | "vault_access_list"
  | "current_host_list"
  | "current_host_inspect"
  | "current_host_preview"
  | "current_host_mutate"
  | "current_host_status"
  | "current_host_operation_lookup"
  | "current_host_portable";

type RemoteManagementBindingSeed = Readonly<{
  operationId: string;
  requestIdentity: string;
}>;

type RemotePortableOutcome =
  | Exclude<CurrentHostPortableOperationOutcome, { kind: "portable_artifact_download_range" }>
  | Readonly<{
      kind: "portable_artifact_download_range";
      status: "ok";
      bytesBase64: string;
      start: number;
      endExclusive: number;
      totalLength: number;
    }>;

export type RemoteCliArgumentsByCommand = Readonly<{
  current_host_list: RemoteManagementBindingSeed &
    Readonly<{ resource: CurrentHostManagementResource }>;
  current_host_inspect: RemoteManagementBindingSeed &
    Readonly<{
      resource: CurrentHostManagementResource;
      id: string;
      selector: "effective" | "underlying-sql";
    }>;
  current_host_preview: RemoteManagementBindingSeed &
    Readonly<{ mutation: CurrentHostManagementMutation }>;
  current_host_mutate: RemoteManagementBindingSeed &
    Readonly<{ mutation: CurrentHostManagementMutation }>;
  current_host_status: RemoteManagementBindingSeed;
  current_host_operation_lookup: Readonly<{ binding: CurrentHostOperationBinding }>;
  current_host_portable: Readonly<{
    operation: Readonly<Record<string, unknown>>;
    operationId?: string | undefined;
  }>;
}>;

export type RemoteCliResultByCommand = Readonly<{
  current_host_list: CurrentHostManagementListResult;
  current_host_inspect: CurrentHostManagementInspectResult;
  current_host_preview: CurrentHostManagementPreviewResult;
  current_host_mutate: CurrentHostManagementMutationResult;
  current_host_status: CurrentHostManagementStatusResult;
  current_host_operation_lookup: CurrentHostOperationLookupOutcome;
  current_host_portable: RemotePortableOutcome;
}>;

export type TypedRemoteCliCommand = keyof RemoteCliArgumentsByCommand;

export type RemoteCliRequestFor<TCommand extends TypedRemoteCliCommand> = Readonly<{
  command: TCommand;
  arguments: RemoteCliArgumentsByCommand[TCommand];
}>;

/**
 * Parsed wire input. `command` stays open so the adapter can safely envelope
 * unknown protocol commands instead of forcing callers to bypass the type system.
 */
export type RemoteCliRequest = {
  command: string;
  arguments: Record<string, unknown>;
};

export type RemoteCliResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: CapletsErrorCode; message: string; nextAction?: string };
    };
