import type { CapletsErrorCode } from "../errors";

export type RemoteCliCommand =
  | "list"
  | "get_caplet"
  | "check_backend"
  | "list_tools"
  | "search_tools"
  | "get_tool"
  | "call_tool"
  | "list_resources"
  | "search_resources"
  | "list_resource_templates"
  | "read_resource"
  | "list_prompts"
  | "search_prompts"
  | "get_prompt"
  | "complete"
  | "init"
  | "add"
  | "install"
  | "complete_cli"
  | "auth_login_start"
  | "auth_login_complete"
  | "auth_logout"
  | "auth_list";

export type RemoteCliRequest = {
  command: RemoteCliCommand;
  arguments: Record<string, unknown>;
};

export type RemoteCliResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: CapletsErrorCode; message: string; nextAction?: string };
    };
