import { loadConfigWithSources } from "../config";
import { CapletsError } from "../errors";
import { listCaplets } from "./inspection";

export const completionShells = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof completionShells)[number];

export type CompletionOptions = {
  configPath?: string;
  projectConfigPath?: string;
};

const topLevelCommands = [
  "serve",
  "init",
  "list",
  "install",
  "add",
  "get-caplet",
  "check-backend",
  "list-tools",
  "search-tools",
  "get-tool",
  "call-tool",
  "list-resources",
  "search-resources",
  "list-resource-templates",
  "read-resource",
  "list-prompts",
  "search-prompts",
  "get-prompt",
  "complete",
  "config",
  "auth",
  "completion",
];

const subcommands: Record<string, string[]> = {
  add: ["cli", "mcp", "openapi", "graphql", "http"],
  auth: ["login", "logout", "list"],
  completion: ["bash", "zsh", "fish"],
  config: ["path", "paths"],
};

const optionValueSuggestions: Record<string, Record<string, string[]>> = {
  "*": {
    "--format": ["markdown", "md", "plain", "json"],
  },
  serve: {
    "--transport": ["stdio", "http"],
  },
  "add:mcp": {
    "--transport": ["http", "sse"],
  },
  "add:cli": {
    "--include": ["git", "gh", "package"],
  },
};

const capletIdCommands = new Set([
  "get-caplet",
  "check-backend",
  "list-tools",
  "search-tools",
  "list-resources",
  "search-resources",
  "list-resource-templates",
  "read-resource",
  "list-prompts",
  "search-prompts",
  "complete",
]);

const qualifiedTargetCommands = new Set(["get-tool", "call-tool", "get-prompt"]);

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return bashCompletionScript();
    case "zsh":
      return zshCompletionScript();
    case "fish":
      return fishCompletionScript();
    default:
      throw new CapletsError("REQUEST_INVALID", "completion shell must be bash, zsh, or fish");
  }
}

export function completeCliWords(words: string[], options: CompletionOptions = {}): string[] {
  try {
    const normalized = words.length === 0 ? [""] : words;
    const current = normalized.at(-1) ?? "";
    const previous = normalized.at(-2);
    const command = normalized[0] ?? "";
    const subcommand = normalized[1] ?? "";

    const optionValues = suggestionsForOptionValue(command, subcommand, previous);
    if (optionValues) return prefixFilter(optionValues, current);

    if (normalized.length === 1) return prefixFilter(topLevelCommands, current);

    if (normalized.length === 2 && subcommands[command]) {
      return prefixFilter(subcommands[command], current);
    }

    if (normalized.length === 2 && capletIdCommands.has(command)) {
      return prefixFilter(configuredCapletIds(options), current);
    }

    if (normalized.length === 2 && qualifiedTargetCommands.has(command)) {
      return prefixFilter(
        configuredCapletIds(options).map((id) => `${id}.`),
        current,
      );
    }

    if (command === "auth" && ["login", "logout"].includes(subcommand) && normalized.length === 3) {
      return prefixFilter(configuredCapletIds(options), current);
    }

    return [];
  } catch {
    return [];
  }
}

function suggestionsForOptionValue(
  command: string,
  subcommand: string,
  previous: string | undefined,
): string[] | undefined {
  if (!previous) return undefined;
  return (
    optionValueSuggestions[`${command}:${subcommand}`]?.[previous] ??
    optionValueSuggestions[command]?.[previous] ??
    optionValueSuggestions["*"]?.[previous]
  );
}

function configuredCapletIds(options: CompletionOptions): string[] {
  const loaded = loadConfigWithSources(options.configPath, options.projectConfigPath);
  return listCaplets(loaded, { includeDisabled: false }).map((row) => row.server);
}

function prefixFilter(values: string[], prefix: string): string[] {
  return values.filter((value) => value.startsWith(prefix));
}

function bashCompletionScript(): string {
  return `# caplets bash completion
_caplets_completions() {
  local IFS=$'\n'
  COMPREPLY=( $(caplets __complete --shell bash -- "\${COMP_WORDS[@]:1}") )
}
complete -o default -F _caplets_completions caplets
`;
}

function zshCompletionScript(): string {
  return `#compdef caplets
_caplets() {
  local -a suggestions
  suggestions=("\${(@f)$(caplets __complete --shell zsh -- "\${words[@]:1}")}")
  compadd -- $suggestions
}
_caplets "$@"
`;
}

function fishCompletionScript(): string {
  return `# caplets fish completion
function __caplets_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  caplets __complete --shell fish -- $tokens[2..-1] $current
end
complete -c caplets -f -a '(__caplets_complete)'
`;
}
