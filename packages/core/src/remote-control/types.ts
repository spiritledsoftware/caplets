import type { CapletsErrorCode } from "../errors";

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
  | "storage_records_list"
  | "storage_records_get"
  | "storage_records_import"
  | "storage_records_update"
  | "storage_records_export"
  | "storage_records_revisions"
  | "storage_records_restore"
  | "storage_records_delete_revision"
  | "storage_records_retention"
  | "storage_records_rename"
  | "storage_records_delete"
  | "storage_records_installation_status"
  | "storage_records_installation_detach"
  | "storage_records_installation_observe"
  | "storage_records_installation_replace";

export type RemoteCapletBundleFile = {
  path: string;
  contentBase64: string;
  executable: boolean;
};

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
