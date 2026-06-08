export const completionShells = ["bash", "zsh", "fish", "powershell", "cmd"] as const;
export type CompletionShell = (typeof completionShells)[number];

export const cliCommands = {
  completion: "completion",
  completeHidden: "__complete",
  run: "run",
  codeMode: "code-mode",
  serve: "serve",
  attach: "attach",
  cloud: "cloud",
  init: "init",
  setup: "setup",
  doctor: "doctor",
  list: "list",
  install: "install",
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
} as const;

export const topLevelCommandNames = [
  cliCommands.serve,
  cliCommands.run,
  cliCommands.codeMode,
  cliCommands.attach,
  cliCommands.cloud,
  cliCommands.init,
  cliCommands.setup,
  cliCommands.doctor,
  cliCommands.list,
  cliCommands.install,
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
  cliCommands.completion,
] as const;

export const cliSubcommands = {
  [cliCommands.add]: ["cli", "mcp", "openapi", "graphql", "http"],
  [cliCommands.auth]: ["login", "logout", "list"],
  [cliCommands.cloud]: ["auth"],
  [cliCommands.codeMode]: ["types"],
  [cliCommands.completion]: [...completionShells],
  [cliCommands.config]: ["path", "paths"],
  [cliCommands.serve]: ["start", "stop", "status", "restart", "enable", "disable"],
  [cliCommands.setup]: ["codex", "claude-code", "opencode", "pi", "mcp-client"],
} as const satisfies Record<string, readonly string[]>;

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
