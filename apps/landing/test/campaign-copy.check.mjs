import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(__dirname, "../src/pages/index.astro"), "utf8");
const css = readFileSync(resolve(__dirname, "../src/styles/global.css"), "utf8");
const source = `${page}\n${css}`;

const required = [
  "Give your agent capabilities, not tools",
  "106",
  "3",
  "87.8%",
  "Remote Caplets server",
  "Auth into tools once. Use them from every agent.",
  "Provider tokens and OAuth state stay with that",
  "Without remote Caplets",
  "With remote Caplets",
  "Each agent client needs its own provider tokens",
  "One server holds provider auth",
  "Auth once on the server",
  "CAPLETS_SERVER_URL=https://caplets.example.com/caplets",
  "CAPLETS_SERVER_PASSWORD=...",
  "caplets serve --transport http",
  "CAPLETS_MODE=remote",
  "opencode",
  "/caplets/mcp",
  "/caplets/control",
  "/caplets/healthz",
  "remote server command",
  "remote client command",
  "Claude Code",
  "Codex",
  "OpenCode",
  "Pi",
  "Any MCP client",
  "caplets install spiritledsoftware/caplets github",
  "caplets install spiritledsoftware/caplets sourcegraph",
  "caplets install spiritledsoftware/caplets osv",
  "caplets auth login sourcegraph",
  "Explore more Caplets",
  "https://github.com/spiritledsoftware/caplets/tree/main/caplets",
  'codex "try using the github caplet"',
  'codex "try using the sourcegraph caplet"',
  'codex "try using the osv caplet"',
  "GH_TOKEN",
  "github",
  "sourcegraph",
  "osv",
  "inspect",
  "search_tools",
  "get_tool",
  "call_tool",
  "data-copy-status",
  'aria-live="polite"',
  "data-copy-label",
  "aria-label={`Copy ${step.label}`}",
  "content={lightThemeColor}",
  "content={darkThemeColor}",
  "color-scheme: light dark;",
  "data-theme-toggle",
  'localStorage.getItem("caplets-theme")',
  ':root[data-theme="dark"]',
  'window.matchMedia("(prefers-color-scheme: dark)")',
  'themeToggle.setAttribute("aria-pressed", String(resolvedTheme === "dark"))',
  'aria-label="Use light theme"',
  "/icon-header-light.png",
  "/icon-header-dark.png",
  'href="#remote"',
  'id="remote"',
  "npm-link",
  "trace-reactor",
  "data-reactor-step",
  "data-reactor-mobile-output",
  'role="button"',
  'tabindex="0"',
  'addEventListener("keydown"',
  'addEventListener("focus"',
  "data-reactor-dot",
  "reactor-rail",
  "reactorUserPaused",
  'addEventListener("pointerenter"',
  'addEventListener("pointerleave"',
  "data-caplet-examples",
  "data-example-tab",
  "data-example-panel",
  "--radius-control: 8px",
  "--radius-panel: 12px",
  "--radius-shell: 16px",
  "--radius-pill: 999px",
  "border-radius: var(--radius-shell)",
  "border-radius: var(--radius-panel)",
  "border-radius: var(--radius-control)",
];

const forbiddenVisibleCopy = [
  "01</span>",
  "02</span>",
  "03</span>",
  "Try the aha moment",
  "install-step-4",
  "Before: flat tool wall",
  "After: capability first",
  "Trust before invocation",
  "Expanded setup reference",
  "Context7",
  "context7",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "Docker",
];

const missing = required.filter((needle) => !source.includes(needle));
const forbidden = forbiddenVisibleCopy.filter((needle) => page.includes(needle));

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) console.error("Missing required copy:", missing);
  if (forbidden.length > 0) console.error("Forbidden old copy remains:", forbidden);
  process.exit(1);
}

const hardcodedRadii = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
  .map((match) => match[1].trim())
  .filter((value) => !value.startsWith("var(--radius-") && value !== "50%");

if (hardcodedRadii.length > 0) {
  console.error("Hardcoded non-token border radius remains:", hardcodedRadii);
  process.exit(1);
}
