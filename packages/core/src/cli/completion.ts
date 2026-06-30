import {
  loadConfigWithSources,
  type CapletConfig,
  type CapletsConfig,
  type CompletionConfig,
} from "../config";
import { CapletsError } from "../errors";
import { listSupportedAddMcpClients } from "./add-mcp-adapter";
import { listCaplets } from "./inspection";
import {
  capletIdCommands,
  cliCommands,
  cliNestedSubcommands,
  cliSubcommands,
  qualifiedPromptCommands,
  qualifiedToolCommands,
  topLevelCommandNames,
  type CompletionShell,
} from "./commands";
import {
  discoverCompletionCandidates,
  type CompletionDiscoveryManagers,
} from "./completion-discovery";

export { completionShells, type CompletionShell } from "./commands";

export const trailingSpaceCompletionToken = "__CAPLETS_TRAILING_SPACE__";

export type CompletionOptions = {
  configPath?: string;
  projectConfigPath?: string;
  config?: CapletsConfig;
  completion?: CompletionConfig;
  cacheDir?: string;
  managers?: CompletionDiscoveryManagers;
};

const optionValueSuggestions: Record<string, Record<string, string[]>> = {
  "*": { "--format": ["markdown", "md", "plain", "json"] },
  serve: { "--transport": ["stdio", "http"] },
  setup: { "--format": ["plain", "json"], "--client": setupMcpClientIds() },
  "add:mcp": { "--transport": ["http", "sse"] },
  "add:cli": { "--include": ["git", "gh", "package"] },
};

function setupMcpClientIds(): string[] {
  return listSupportedAddMcpClients()
    .filter((client) => client.supportsStdio)
    .map((client) => client.id);
}

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return bashCompletionScript();
    case "zsh":
      return zshCompletionScript();
    case "fish":
      return fishCompletionScript();
    case "powershell":
      return powershellCompletionScript();
    case "cmd":
      return cmdCompletionScript();
    default:
      throw new CapletsError(
        "REQUEST_INVALID",
        "completion shell must be bash, zsh, fish, powershell, or cmd",
      );
  }
}

export async function completeCliWords(
  words: string[],
  options: CompletionOptions = {},
): Promise<string[]> {
  try {
    const normalized = words.length === 0 ? [""] : words;
    const current = normalized.at(-1) ?? "";
    const previous = normalized.at(-2);
    const command = normalized[0] ?? "";
    const subcommand = normalized[1] ?? "";

    if (command === cliCommands.complete && previous === "--prompt" && subcommand) {
      return prefixFilter(
        (await discoverCompletionCandidates(subcommand, "prompts", discoveryOptions(options))).map(
          (candidate) => candidate.value.replace(`${subcommand}.`, ""),
        ),
        current,
      );
    }

    if (command === cliCommands.complete && previous === "--resource-template" && subcommand) {
      return prefixFilter(
        (
          await discoverCompletionCandidates(
            subcommand,
            "resourceTemplates",
            discoveryOptions(options),
          )
        ).map((candidate) => candidate.value),
        current,
      );
    }

    const optionValues = suggestionsForOptionValue(command, subcommand, previous);
    if (optionValues) return prefixFilter(optionValues, current);

    if (normalized.length === 1) return prefixFilter([...topLevelCommandNames], current);

    if (normalized.length === 2 && command in cliSubcommands) {
      return prefixFilter(cliSubcommands[command as keyof typeof cliSubcommands], current);
    }

    const nestedStaticSubcommands = nestedSubcommandsFor(command, subcommand);
    if (normalized.length === 3 && nestedStaticSubcommands) {
      return prefixFilter(nestedStaticSubcommands, current);
    }

    if (normalized.length === 2 && capletIdCommands.has(command)) {
      const ids = promptResourceCommands.has(command)
        ? configuredCapletIds(options, { backend: "mcp" })
        : configuredCapletIds(options);
      return prefixFilter(ids, current);
    }

    if (qualifiedToolCommands.has(command) || qualifiedPromptCommands.has(command)) {
      const kind = qualifiedToolCommands.has(command) ? "tools" : "prompts";
      const idFilter = qualifiedPromptCommands.has(command)
        ? { backend: "mcp" as const }
        : undefined;

      if (normalized.length === 2) {
        if (current.includes(".")) {
          const serverId = current.slice(0, current.indexOf("."));
          return prefixFilter(
            (await discoverCompletionCandidates(serverId, kind, discoveryOptions(options))).map(
              (candidate) => candidate.value,
            ),
            current,
          );
        }
        return prefixFilter(configuredCapletIds(options, idFilter), current);
      }

      if (normalized.length === 3 && subcommand && !subcommand.includes(".")) {
        if (current.startsWith("-")) return [];
        return prefixFilter(
          (await discoverCompletionCandidates(subcommand, kind, discoveryOptions(options))).map(
            (candidate) => candidate.value.replace(`${subcommand}.`, ""),
          ),
          current,
        );
      }
    }

    if (command === cliCommands.readResource && normalized.length === 3) {
      return prefixFilter(
        (
          await discoverCompletionCandidates(subcommand, "resources", discoveryOptions(options))
        ).map((candidate) => candidate.value),
        current,
      );
    }

    if (
      command === cliCommands.auth &&
      ["login", "logout"].includes(subcommand) &&
      normalized.length === 3
    ) {
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

function nestedSubcommandsFor(command: string, subcommand: string): readonly string[] | undefined {
  if (command !== cliCommands.remote || subcommand !== "host") return undefined;
  return cliNestedSubcommands.remote.host;
}

const promptResourceCommands = new Set<string>([
  cliCommands.getPrompt,
  cliCommands.readResource,
  cliCommands.complete,
]);

function configuredCapletIds(
  options: CompletionOptions,
  filter: { backend?: CapletConfig["backend"] } = {},
): string[] {
  const loaded = options.config
    ? { config: options.config, sources: {}, shadows: {} }
    : loadConfigWithSources(options.configPath, options.projectConfigPath);
  return listCaplets(loaded, { includeDisabled: false })
    .filter((row) => !filter.backend || row.backend === filter.backend)
    .map((row) => row.server);
}

function discoveryOptions(options: CompletionOptions) {
  const config =
    options.config ?? loadConfigWithSources(options.configPath, options.projectConfigPath).config;
  return {
    config,
    completion: options.completion,
    cacheDir: options.cacheDir,
    managers: options.managers,
  };
}

function prefixFilter(values: readonly string[], prefix: string): string[] {
  return values.filter((value) => value.startsWith(prefix));
}

function bashCompletionScript(): string {
  return `# caplets bash completion
_caplets_completions() {
  local IFS=$'\n'
  COMPREPLY=( $(caplets __complete --shell bash -- "\${COMP_WORDS[@]:1}" 2>/dev/null) )
}
complete -o default -F _caplets_completions caplets
`;
}

function zshCompletionScript(): string {
  return `#compdef caplets
_caplets() {
  local -a suggestions
  suggestions=("\${(@f)$(caplets __complete --shell zsh -- "\${words[@]:1}" 2>/dev/null)}")
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
  caplets __complete --shell fish -- $tokens[2..-1] $current 2>/dev/null
end
complete -c caplets -f -a '(__caplets_complete)'
`;
}

function powershellCompletionScript(): string {
  return `# caplets PowerShell completion
Register-ArgumentCompleter -Native -CommandName caplets -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($tokens.Count -eq 0 -or $commandAst.Extent.Text.EndsWith(' ')) { $tokens += '${trailingSpaceCompletionToken}' }
  caplets __complete --shell powershell -- @tokens 2>$null | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

function cmdCompletionScript(): string {
  return `@echo off
REM caplets cmd completion helper
REM cmd.exe has no native programmable completion API. This doskey macro prints suggestions for the current words.
doskey caplets-complete=caplets __complete --shell cmd -- $* 2^>nul
REM Usage: caplets-complete inspect
`;
}
