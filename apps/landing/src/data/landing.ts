export const heroCommands = [
  {
    label: "Install Caplets",
    command: "npm install -g caplets",
  },
  {
    label: "Wire up your agent through the local daemon",
    command: "caplets setup",
  },
] as const;

export const quickstartCommand = heroCommands.map((item) => item.command).join("\n");

export const manualSetupCommands = {
  install: "npm install -g caplets",
  setup: "caplets setup",
} as const;

export const manualSetupCommand = Object.values(manualSetupCommands).join("\n");

export const agentSetupPrompt = `Read and follow this Caplets bootstrap skill: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/SKILL.md

Set up Caplets for this environment. Detect the environment first. Do not install packages, modify config, start remote login, or write files until you have asked me the setup questions, shown the exact commands and files/config areas you plan to change, and I approve that plan.`;

export const proofStats = [
  {
    value: "10/10",
    label: "tasks completed",
  },
  {
    value: "72.0% fewer",
    label: "request + output tokens",
  },
  {
    value: "7 vs 215",
    label: "initial choices",
  },
] as const;

export const benchmarkProvenance =
  "Run June 2026 with the real-world large MCP suite, openai-codex/gpt-5.5, 10 tasks, 2 runs per task, and a large no-fixture MCP stack.";

export const themeColor = "oklch(18% 0.014 100)";

export const firstCaplet = {
  name: "OSV",
  summary: "Public vulnerability lookups with no token or OAuth setup.",
  steps: [
    { command: "caplets setup", label: "Caplets setup command" },
    {
      command: "caplets install spiritledsoftware/caplets osv",
      label: "OSV caplet install command",
    },
    { command: 'codex "try using the osv caplet"', label: "Codex trial command" },
  ],
} as const;
