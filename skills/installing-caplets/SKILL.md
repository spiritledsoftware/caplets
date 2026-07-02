---
name: installing-caplets
description: Use when a user wants to install, set up, bootstrap, configure, wire, or troubleshoot Caplets for an agent, MCP client, Pi, OpenCode, Codex, Claude Code, self-hosted remote runtime, or local daemon-first setup.
---

# Installing Caplets

## Bootstrap promise

Run a never-surprise install. Detect first, ask before mutating, show one exact plan, then execute only after the user approves that plan.

This skill may be loaded from a raw GitHub URL. When a troubleshooting branch says to read a reference, fetch the absolute URL shown in that branch.

## Immediate read-only probe

Run broad read-only detection immediately. Do not install packages, edit config, start login, or write files in this phase.

Use the relevant safe probes for the current OS and shell:

```sh
pwd
uname -a 2>/dev/null || true
command -v node npm pnpm bun npx caplets pi opencode codex claude 2>/dev/null || true
node --version 2>/dev/null || true
npm --version 2>/dev/null || true
pnpm --version 2>/dev/null || true
bun --version 2>/dev/null || true
caplets --version 2>/dev/null || true
caplets doctor --format json 2>/dev/null || caplets doctor 2>/dev/null || true
```

Also inspect only relevant sections of existing agent config files when present. Look for Caplets entries, MCP server entries, native plugin/package entries, and top-level `caplets` settings. Redact secrets in summaries. Do not dump full config files into chat.

Completion criterion: you can state whether the Caplets CLI exists, which package managers exist, which agent/client appears active or installed, whether a Caplets config/daemon already exists, and whether the current directory appears project-specific (`.caplets/` or project config present).

## Ask setup questions

Ask after detection and before mutation. Recommend the detected answer, but let the user choose.

Ask only what is needed:

1. **Target agent/client.** Include detected current agent first. Name first-class targets: Pi, OpenCode, Codex, Claude Code, and generic MCP clients. You may mention popular MCP clients as generic clients when detection suggests them, but do not invent unsupported client IDs.
2. **Runtime shape.** Offer local daemon-first setup and self-hosted remote setup. Hide Caplets Cloud until Cloud is actually available.
3. **Package manager/install method** if `caplets` is missing. Detect available package managers, then ask whether to use a global install such as `npm install -g caplets`, an equivalent preferred package manager, or temporary `npx` use.
4. **Scope.** Default to user/global setup. Ask about project-local setup only when `.caplets/`, `CAPLETS_PROJECT_CONFIG`, or the user’s request indicates repo-specific Caplets.
5. **Remote URL** only for self-hosted remote setup. Do not ask for secrets, tokens, passwords, API keys, or credential values in chat.

Completion criterion: every mutating choice in the plan has an explicit user answer or a clearly accepted default from the question flow.

## Build the exact plan

Prefer explicit non-interactive commands. Use interactive `caplets setup` only as a fallback when explicit setup cannot represent the chosen target.

Before executing, show a plan with:

- commands to run, in order;
- files or config areas expected to change;
- whether the command is local daemon-first or self-hosted remote;
- restart/reload steps for the agent;
- rollback notes for changed config when practical.

Use dry runs when the CLI is already available:

```sh
caplets setup <target> --dry-run --format json
```

Common explicit setup commands after approval:

```sh
caplets setup pi --yes --format json
caplets setup opencode --yes --format json
caplets setup codex --yes --format json
caplets setup claude-code --yes --format json
caplets setup mcp-client --client <client-id> --yes --format json
```

For self-hosted remote setup, establish trust first, then configure attach:

```sh
caplets remote login <url>
caplets setup <target> --remote-url <url> --yes --format json
```

For generic remote MCP clients, the CLI may require writing an output config rather than guessing the client’s storage:

```sh
caplets setup mcp-client --remote-url <url> --output ./caplets.mcp.json --yes --format json
```

Completion criterion: the user approves the exact plan after seeing the commands and expected mutations. If they change any choice, update the plan and ask for approval again.

## Execute and verify

Run the approved commands. If a command prompts interactively despite the plan, pause and ask unless the prompt is already answered by the approved plan and is not asking for secrets.

Verify both CLI/runtime and agent wiring:

```sh
caplets --version
caplets doctor --format json 2>/dev/null || caplets doctor
```

Then verify the selected target:

- **Pi:** confirm `@caplets/pi` is installed/configured or `caplets setup pi` reported success; tell the user to restart/reload Pi if needed and look for Caplets native tools such as `caplets__code_mode` or the status widget when applicable.
- **OpenCode:** confirm `@caplets/opencode` plugin/defaults or setup output; tell the user to restart OpenCode if plugin tools were newly added.
- **Codex/Claude Code/generic MCP:** confirm the Caplets MCP server entry exists and runs `caplets attach <url>`; tell the user to restart/reload the client and confirm the MCP server connects.
- **Self-hosted remote:** confirm `caplets remote status` or `caplets doctor` shows a saved remote profile for the URL before claiming remote setup is usable.

Success requires CLI + agent check. Do not report completion from package installation alone.

After setup succeeds, offer optional starter Caplets as a follow-up, not as part of first install. Example no-auth starter:

```sh
caplets install spiritledsoftware/caplets osv
```

## Troubleshooting branches

On failure, read only the matching reference by URL, then run focused diagnostics and propose one fix plan.

- CLI missing, package-manager failure, Node version, or PATH issue: `https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/references/troubleshooting-cli.md`
- Daemon start, health, port, logs, or `caplets doctor` daemon failure: `https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/references/troubleshooting-daemon.md`
- Agent/MCP/native config, add-mcp, restart, or tool visibility failure: `https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/references/troubleshooting-agent-config.md`
- Self-hosted remote login, attach URL, approval, or remote profile failure: `https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/references/troubleshooting-remote.md`

Safe auto-fixes without a second approval are limited to reversible/no-user-data changes inside Caplets-owned state: retry a daemon start, rerun the already-approved `caplets setup <target> --yes` after a transient failure, refresh detection, or correct a Caplets-owned generated config entry that the approved plan already covered.

Return to an exact plan for approval before installing packages, editing third-party agent config beyond the approved plan, changing shell profile/PATH files, logging into remotes, deleting files, overwriting existing config, or handling secrets.

## Secret handling

Never ask the user to paste secrets, tokens, API keys, passwords, OAuth codes, or credential values into chat. Route credentials through Caplets-owned flows such as Remote Login, provider OAuth/device flows, Vault, or environment setup. It is fine to ask for non-secret URLs, package-manager preferences, target agents, and scope choices.

## Landing-page prompt

Use this copyable prompt for raw bootstrap distribution:

```text
Read and follow this Caplets bootstrap skill: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/SKILL.md

Set up Caplets for this environment. Detect the environment first. Do not install packages, modify config, start remote login, or write files until you have asked me the setup questions, shown the exact commands and files/config areas you plan to change, and I approve that plan.
```
