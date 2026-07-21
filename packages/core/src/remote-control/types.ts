import type { CapletsErrorCode } from "../errors";

export const REMOTE_CLI_COMMANDS = [
  "list",
  "inspect",
  "check",
  "tools",
  "search_tools",
  "describe_tool",
  "call_tool",
  "resources",
  "search_resources",
  "resource_templates",
  "read_resource",
  "prompts",
  "search_prompts",
  "get_prompt",
  "complete",
  "init",
  "add",
  "install",
  "update",
  "complete_cli",
  "auth_login_start",
  "auth_login_complete",
  "auth_logout",
  "auth_refresh",
  "auth_list",
  "vault_set",
  "vault_list",
  "vault_get",
  "vault_delete",
  "vault_access_grant",
  "vault_access_revoke",
  "vault_access_list",
  "storage_records_list",
  "storage_records_get",
  "storage_records_import",
  "storage_records_update",
  "storage_records_export",
  "storage_records_revisions",
  "storage_records_restore",
  "storage_records_delete_revision",
  "storage_records_retention",
  "storage_records_rename",
  "storage_records_delete",
  "storage_records_installation_status",
  "storage_records_installation_detach",
  "storage_records_installation_observe",
  "storage_records_installation_replace",
] as const;

export type RemoteCliCommand = (typeof REMOTE_CLI_COMMANDS)[number];

export type RemoteCliCommandDestination =
  | "v2_resource"
  | "attach"
  | "local_only_rejection"
  | "frozen_v1_compatibility"
  | "public_auth_self_service";

export const REMOTE_CLI_COMMAND_DESTINATIONS = {
  list: "attach",
  inspect: "attach",
  check: "attach",
  tools: "attach",
  search_tools: "attach",
  describe_tool: "attach",
  call_tool: "attach",
  resources: "attach",
  search_resources: "attach",
  resource_templates: "attach",
  read_resource: "attach",
  prompts: "attach",
  search_prompts: "attach",
  get_prompt: "attach",
  complete: "attach",
  init: "local_only_rejection",
  add: "local_only_rejection",
  install: "v2_resource",
  update: "v2_resource",
  complete_cli: "attach",
  auth_login_start: "v2_resource",
  auth_login_complete: "public_auth_self_service",
  auth_logout: "v2_resource",
  auth_refresh: "v2_resource",
  auth_list: "v2_resource",
  vault_set: "v2_resource",
  vault_list: "v2_resource",
  vault_get: "v2_resource",
  vault_delete: "v2_resource",
  vault_access_grant: "v2_resource",
  vault_access_revoke: "v2_resource",
  vault_access_list: "v2_resource",
  storage_records_list: "v2_resource",
  storage_records_get: "v2_resource",
  storage_records_import: "v2_resource",
  storage_records_update: "v2_resource",
  storage_records_export: "v2_resource",
  storage_records_revisions: "v2_resource",
  storage_records_restore: "v2_resource",
  storage_records_delete_revision: "v2_resource",
  storage_records_retention: "v2_resource",
  storage_records_rename: "v2_resource",
  storage_records_delete: "v2_resource",
  storage_records_installation_status: "v2_resource",
  storage_records_installation_detach: "v2_resource",
  storage_records_installation_observe: "v2_resource",
  storage_records_installation_replace: "v2_resource",
} as const satisfies Record<RemoteCliCommand, RemoteCliCommandDestination>;

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
