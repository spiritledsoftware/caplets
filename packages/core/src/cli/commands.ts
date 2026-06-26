export const completionShells = ["bash", "zsh", "fish", "powershell", "cmd"] as const;
export type CompletionShell = (typeof completionShells)[number];

export const cliCommands = {
  completion: "completion",
  completeHidden: "__complete",
  codeMode: "code-mode",
  daemon: "daemon",
  serve: "serve",
  attach: "attach",
  remote: "remote",
  cloud: "cloud",
  init: "init",
  setup: "setup",
  doctor: "doctor",
  list: "list",
  install: "install",
  update: "update",
  add: "add",
  inspect: "inspect",
  checkBackend: "check-backend",
  listTools: "list-tools",
  searchTools: "search-tools",
  getTool: "get-tool",
  callTool: "call-tool",
  listResources: "list-resources",
  searchResources: "search-resources",
  listResourceTemplates: "list-resource-templates",
  readResource: "read-resource",
  listPrompts: "list-prompts",
  searchPrompts: "search-prompts",
  getPrompt: "get-prompt",
  complete: "complete",
  config: "config",
  auth: "auth",
  vault: "vault",
  telemetry: "telemetry",
} as const;

export const topLevelCommandNames = [
  cliCommands.serve,
  cliCommands.daemon,
  cliCommands.codeMode,
  cliCommands.attach,
  cliCommands.remote,
  cliCommands.cloud,
  cliCommands.init,
  cliCommands.setup,
  cliCommands.doctor,
  cliCommands.list,
  cliCommands.install,
  cliCommands.update,
  cliCommands.add,
  cliCommands.inspect,
  cliCommands.checkBackend,
  cliCommands.listTools,
  cliCommands.searchTools,
  cliCommands.getTool,
  cliCommands.callTool,
  cliCommands.listResources,
  cliCommands.searchResources,
  cliCommands.listResourceTemplates,
  cliCommands.readResource,
  cliCommands.listPrompts,
  cliCommands.searchPrompts,
  cliCommands.getPrompt,
  cliCommands.complete,
  cliCommands.config,
  cliCommands.auth,
  cliCommands.vault,
  cliCommands.telemetry,
  cliCommands.completion,
] as const;

export const cliSubcommands = {
  [cliCommands.add]: ["cli", "mcp", "openapi", "google-discovery", "graphql", "http"],
  [cliCommands.auth]: ["login", "logout", "list", "refresh"],
  [cliCommands.cloud]: ["auth"],
  [cliCommands.remote]: ["login", "status", "logout", "host"],
  [cliCommands.codeMode]: ["types"],
  [cliCommands.completion]: [...completionShells],
  [cliCommands.config]: ["path", "paths"],
  [cliCommands.daemon]: ["install", "uninstall", "start", "restart", "stop", "status", "logs"],
  [cliCommands.setup]: ["codex", "claude-code", "opencode", "pi", "mcp-client"],
  [cliCommands.telemetry]: ["status", "enable", "disable", "delete-id", "rotate-id", "debug"],
  [cliCommands.vault]: ["set", "get", "list", "delete", "access"],
} as const satisfies Record<string, readonly string[]>;

export const cliNestedSubcommands = {
  [cliCommands.remote]: {
    host: ["pair", "clients", "revoke"],
  },
  [cliCommands.vault]: {
    access: ["grant", "list", "revoke"],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export const capletIdCommands = new Set<string>([
  cliCommands.inspect,
  cliCommands.checkBackend,
  cliCommands.listTools,
  cliCommands.searchTools,
  cliCommands.listResources,
  cliCommands.searchResources,
  cliCommands.listResourceTemplates,
  cliCommands.readResource,
  cliCommands.listPrompts,
  cliCommands.searchPrompts,
  cliCommands.complete,
]);

export const qualifiedToolCommands = new Set<string>([cliCommands.getTool, cliCommands.callTool]);

export const qualifiedPromptCommands = new Set<string>([cliCommands.getPrompt]);
