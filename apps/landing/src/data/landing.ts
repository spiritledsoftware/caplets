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
    label: "tasks cleared",
    detail:
      "Caplets Code Mode, progressive modes, direct MCP, and Executor.sh all completed the task set.",
  },
  {
    value: "236,803",
    label: "avg tokens",
    detail: "Request plus output estimate for the Code Mode run, averaged across live Pi evals.",
  },
  {
    value: "72.0% fewer",
    label: "vs vanilla",
    detail: "Reduction against direct vanilla MCP without giving up the completed-task result.",
  },
] as const;

export const benchmarkProvenance =
  "Run June 2026 with the real-world large MCP suite, openai-codex/gpt-5.5, 10 tasks, 2 runs per task, and a large no-fixture MCP stack.";

export const benchmarkRows = [
  {
    mode: "Caplets Code Mode",
    passed: "10/10",
    tokens: "236,803",
    surfaceTokens: "31,166",
  },
  {
    mode: "Caplets progressive + Code Mode",
    passed: "10/10",
    tokens: "422,861",
    surfaceTokens: "124,772",
  },
  {
    mode: "Caplets progressive",
    passed: "10/10",
    tokens: "461,171",
    surfaceTokens: "103,776",
  },
  {
    mode: "Executor.sh",
    passed: "10/10",
    tokens: "675,842",
    surfaceTokens: "24,570",
  },
  {
    mode: "Direct vanilla MCP",
    passed: "10/10",
    tokens: "846,048",
    surfaceTokens: "457,818",
  },
] as const;

export const deterministicSurface = [
  { label: "flat tool wall", value: "215" },
  { label: "first screen cards", value: "7" },
  { label: "surface cut", value: "79.9%" },
] as const;

export const whyCapletsProblems = [
  {
    label: "Work stops at the repository",
    before:
      "The agent edits code, then waits while you carry context into issues, dashboards, CI, and deployment tools.",
    after:
      "Expose the capabilities it needs so the agent can keep the task moving across authorized systems.",
  },
  {
    label: "Every agent needs new wiring",
    before:
      "Provider setup, auth, and integration assumptions get repeated across clients and projects.",
    after:
      "Reuse the same Caplet definitions from supported agents while each host keeps access independently authorized.",
  },
  {
    label: "Connected agents get overwhelmed",
    before:
      "A flat wall of tools and schemas competes with the work as soon as more systems are connected.",
    after:
      "Code Mode starts with named handles and opens exact schemas and operations only when the task needs them.",
  },
] as const;

export const remoteCommands = {
  server: `caplets daemon install --start
caplets remote host approve <code> --yes`,
  client: `caplets remote login <url>
caplets attach <url>`,
} as const;

export const portabilitySurfaces = [
  { label: "Native integrations", value: "OpenCode · Pi" },
  { label: "MCP clients", value: "Codex · Claude · compatible clients" },
  { label: "Remote Attach", value: "Supported attach clients" },
  { label: "Capability package", value: "The same Caplet definition" },
] as const;

export const portabilityClaims = [
  {
    label: "Agent portability",
    detail:
      "Reuse one capability definition across supported agent surfaces without pretending every client experience is identical.",
    points: [
      "Native OpenCode and Pi integrations",
      "MCP for Codex, Claude, and compatible clients",
      "Remote Attach for supported clients",
    ],
  },
  {
    label: "Capability sharing",
    detail:
      "Keep a Caplet local, distribute it within a team, or publish it for the community without transferring authenticated authority.",
    points: [
      "Personal reuse across agents and projects",
      "Team-distributed Caplet definitions",
      "Public Caplets through the catalog or another source",
    ],
  },
] as const;

export const themeColor = "oklch(18% 0.014 100)";

export const exampleCaplets = [
  {
    id: "osv",
    name: "OSV",
    summary:
      "Vulnerability lookups by package, purl, commit, or batch query, with no auth ceremony.",
    why: "Best first install: it proves the Caplet flow before OAuth or provider secrets enter the picture.",
    path: ["osv", "inspect", "search_tools", "get_tool", "call_tool"],
    steps: [
      { command: "caplets setup", label: "Caplets setup command" },
      {
        command: "caplets install spiritledsoftware/caplets osv",
        label: "OSV caplet install command",
      },
      { command: 'codex "try using the osv caplet"', label: "Codex trial command" },
    ],
    help: ["OSV is public. If the trial fails, check Node 22+ and rerun ", "caplets setup", "."],
  },
  {
    id: "github",
    name: "GitHub",
    summary:
      "Repositories, issues, pull requests, branches, commits, and reviews behind one capability card.",
    why: "This is the stress case: a valuable MCP server that is painful when every operation is exposed at once.",
    path: ["github", "inspect", "search_tools", "get_tool", "call_tool"],
    steps: [
      { command: "export GH_TOKEN=github_pat_...", label: "GitHub token export" },
      { command: "caplets setup", label: "Caplets setup command" },
      {
        command: "caplets install spiritledsoftware/caplets github",
        label: "GitHub caplet install command",
      },
      { command: 'codex "try using the github caplet"', label: "Codex trial command" },
    ],
    help: [
      "If setup fails, check Node 22+, rerun ",
      "caplets setup",
      ", and confirm ",
      "GH_TOKEN",
      ".",
    ],
  },
  {
    id: "sourcegraph",
    name: "Sourcegraph",
    summary:
      "Hosted code search for examples, references, and implementation patterns across repositories.",
    why: "Good for search-first work: the agent asks for matches, then opens only the operations it needs.",
    path: ["sourcegraph", "inspect", "search_tools", "get_tool", "call_tool"],
    steps: [
      { command: "caplets setup", label: "Caplets setup command" },
      {
        command: "caplets install spiritledsoftware/caplets sourcegraph",
        label: "Sourcegraph caplet install command",
      },
      { command: "caplets auth login sourcegraph", label: "Sourcegraph auth command" },
      { command: 'codex "try using the sourcegraph caplet"', label: "Codex trial command" },
    ],
    help: [
      "If setup fails, check Node 22+, rerun ",
      "caplets setup",
      ", and finish Sourcegraph OAuth login.",
    ],
  },
] as const;
