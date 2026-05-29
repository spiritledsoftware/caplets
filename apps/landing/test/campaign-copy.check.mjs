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
  "Claude Code",
  "Codex",
  "OpenCode",
  "Pi",
  "Any MCP client",
  "caplets add mcp context7 --command npx --arg -y --arg @upstash/context7-mcp",
  "context7",
  "inspect",
  "search_tools",
  "get_tool",
  "call_tool",
  "data-copy-status",
  'aria-live="polite"',
  "data-copy-label",
  "aria-label={`Copy ${copyLabel}`}",
  "content={lightThemeColor}",
  "content={darkThemeColor}",
  "@media (prefers-color-scheme: dark)",
  "color-scheme: light dark;",
  "data-theme-toggle",
  'localStorage.getItem("caplets-theme")',
  ':root:not([data-theme="light"])',
  ':root[data-theme="dark"]',
  'aria-label="Use light theme"',
  "/icon-header-light.png",
  "/icon-header-dark.png",
  "trace-reactor",
  "data-reactor-step",
  "data-reactor-dot",
  "reactor-rail",
  "reactorUserPaused",
  'addEventListener("pointerenter"',
  'addEventListener("pointerleave"',
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
];

const missing = required.filter((needle) => !source.includes(needle));
const forbidden = forbiddenVisibleCopy.filter((needle) => page.includes(needle));

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) console.error("Missing required copy:", missing);
  if (forbidden.length > 0) console.error("Forbidden old copy remains:", forbidden);
  process.exit(1);
}
