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
    label: "Too many tools",
    before: "Every downstream operation lands in the agent's first view.",
    after: "The agent starts with a named capability and opens only the route it needs.",
  },
  {
    label: "Too much schema",
    before: "Large tool definitions compete with the user's actual task for context.",
    after: "Schemas stay behind inspect, search, and get_tool until they matter.",
  },
  {
    label: "Too much setup",
    before: "Every agent repeats provider wiring, OAuth, secrets, and MCP config.",
    after: "One daemon-backed Caplets surface can be reused locally or from a remote server.",
  },
] as const;

export const remoteCommands = {
  server: `caplets daemon install --start
caplets remote host approve <code> --yes`,
  client: `caplets remote login <url>
caplets attach <url>`,
} as const;

export const remoteEndpoints = [
  { label: "MCP", value: "/caplets/v1/mcp" },
  { label: "Attach", value: "/caplets/v1/attach" },
  { label: "Admin", value: "/caplets/v1/admin" },
  { label: "Health", value: "/caplets/v1/healthz" },
] as const;

export const remoteComparison = [
  {
    label: "Client-by-client auth",
    detail: "Every agent carries its own provider tokens, OAuth dance, and local MCP wiring.",
    points: ["Repeat login flows", "Copy secrets around", "Debug each client separately"],
  },
  {
    label: "Server-held auth",
    detail: "One Caplets server owns provider auth; each agent attaches to the shared surface.",
    points: [
      "Keep tokens server-side",
      "Reuse from Codex, OpenCode, Pi, Claude",
      "Inspect, search, schema, and call from one place",
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
