export const completionShells = ["bash", "zsh", "fish", "powershell", "cmd"] as const;
export type CompletionShell = (typeof completionShells)[number];

export const cliCommands = {
  completion: "completion",
  completeHidden: "__complete",
  serve: "serve",
  init: "init",
  list: "list",
  install: "install",
  add: "add",
  getCaplet: "get-caplet",
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
  cliCommands.init,
  cliCommands.list,
  cliCommands.install,
  cliCommands.add,
  cliCommands.getCaplet,
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
  [cliCommands.completion]: [...completionShells],
  [cliCommands.config]: ["path", "paths"],
} as const satisfies Record<string, readonly string[]>;

export const capletIdCommands = new Set<string>([
  cliCommands.getCaplet,
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
