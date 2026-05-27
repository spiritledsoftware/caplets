# Agent Card Setup Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the landing page's existing agent pills into tabs that show each agent's install command and configuration snippet.

**Architecture:** Keep the integrations card in `apps/landing/src/pages/index.astro`, move agent data into a structured `agentSetups` array, render pills as accessible tab buttons, and render matching setup panels in the same card. Add small scoped client-side JavaScript to switch tabs and CSS to preserve the current card aesthetic while making commands/configurations readable.

**Tech Stack:** Astro 6, plain TypeScript in Astro script, CSS in `apps/landing/src/styles/global.css`, pnpm repo scripts.

---

## File structure

- Modify `apps/landing/src/pages/index.astro`: replace the current `integrations` string array with structured `agentSetups` data, render the tabbed pills and setup panels, and add scoped tab-switching JavaScript.
- Modify `apps/landing/src/styles/global.css`: style active/inactive agent pills, setup panels, command/configuration code blocks, and responsive behavior.
- No new runtime dependencies.

## Setup data to use

Use these exact agent labels and setup strings unless the implementation discovers a more current repo-local source:

```ts
const agentSetups = [
  {
    id: "claude-code",
    name: "Claude Code",
    installCommand: "npm install -g caplets",
    configSnippet: `{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["serve"]
    }
  }
}`,
    note: "Use the universal MCP server from Claude Code's MCP configuration.",
  },
  {
    id: "codex",
    name: "Codex",
    installCommand: "npm install -g caplets",
    configSnippet: `[mcp_servers.caplets]
command = "caplets"
args = ["serve"]`,
    note: "Register Caplets as a local MCP server in Codex config.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    installCommand: "npm install -g @caplets/opencode",
    configSnippet: `{
  "mcp": {
    "caplets": {
      "type": "local",
      "command": ["caplets", "serve"]
    }
  }
}`,
    note: "Use MCP config or the native @caplets/opencode integration where available.",
  },
  {
    id: "pi",
    name: "Pi",
    installCommand: "pi update && npm install -g @caplets/pi",
    configSnippet: `{
  "caplets": {
    "enabled": true,
    "configPath": "~/.config/caplets/config.json"
  }
}`,
    note: "Use the native @caplets/pi integration with the same Caplets config file.",
  },
  {
    id: "mcp-client",
    name: "Any MCP client",
    installCommand: "npm install -g caplets",
    configSnippet: `{
  "command": "caplets",
  "args": ["serve"]
}`,
    note: "Any MCP-compatible client can launch Caplets over stdio.",
  },
];
```

## Task 1: Centralize agent setup data and render static panels

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Replace the current integrations array with structured data**

In `apps/landing/src/pages/index.astro`, replace:

```ts
const integrations = ["Claude Code", "Codex", "OpenCode", "Pi", "Any MCP client"];
```

with the `agentSetups` array from the "Setup data to use" section, then add:

```ts
const integrations = agentSetups.map((agent) => agent.name);
```

This preserves the hero facts while making the integrations section data-driven.

- [ ] **Step 2: Replace the integrations strip markup**

Replace the current integrations section body:

```astro
<ul class="integration-strip" aria-label="Supported integrations">
  {integrations.map((name) => <li>{name}</li>)}
</ul>
```

with:

```astro
<div class="agent-setup-card" data-agent-tabs>
  <div class="integration-strip" role="tablist" aria-label="Supported integrations">
    {agentSetups.map((agent, index) => (
      <button
        class="integration-pill"
        id={`agent-tab-${agent.id}`}
        type="button"
        role="tab"
        aria-selected={index === 0 ? "true" : "false"}
        aria-controls={`agent-panel-${agent.id}`}
        data-agent-tab={agent.id}
      >
        {agent.name}
      </button>
    ))}
  </div>
  <div class="agent-setup-panels">
    {agentSetups.map((agent, index) => (
      <article
        class="agent-setup-panel"
        id={`agent-panel-${agent.id}`}
        role="tabpanel"
        aria-labelledby={`agent-tab-${agent.id}`}
        data-agent-panel={agent.id}
        hidden={index !== 0}
      >
        <p class="agent-setup-note">{agent.note}</p>
        <div class="agent-setup-grid">
          <div>
            <span class="agent-setup-label">Install</span>
            <pre><code>{agent.installCommand}</code></pre>
          </div>
          <div>
            <span class="agent-setup-label">Configuration</span>
            <pre><code>{agent.configSnippet}</code></pre>
          </div>
        </div>
      </article>
    ))}
  </div>
</div>
```

- [ ] **Step 3: Run the landing typecheck and verify expected initial failure or pass**

Run:

```bash
pnpm --filter @caplets/landing typecheck
```

Expected: PASS. If it fails, fix only syntax/type issues in `index.astro` before continuing.

- [ ] **Step 4: Commit static rendering**

```bash
git add apps/landing/src/pages/index.astro
git commit -m "feat(landing): render agent setup panels"
```

## Task 2: Add tab behavior

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Add the tab switching script**

Inside the existing `<script>` block, after `const canAnimate = ...;`, add:

```ts
const agentTabsRoot = document.querySelector<HTMLElement>("[data-agent-tabs]");
const agentTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-agent-tab]"));
const agentPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-agent-panel]"));

function selectAgentTab(selectedId: string) {
  for (const tab of agentTabs) {
    const isSelected = tab.dataset.agentTab === selectedId;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  }

  for (const panel of agentPanels) {
    panel.hidden = panel.dataset.agentPanel !== selectedId;
  }
}

if (agentTabsRoot && agentTabs.length > 0 && agentPanels.length > 0) {
  selectAgentTab(agentTabs[0].dataset.agentTab ?? "");

  for (const tab of agentTabs) {
    tab.addEventListener("click", () => {
      const selectedId = tab.dataset.agentTab;
      if (selectedId) selectAgentTab(selectedId);
    });

    tab.addEventListener("keydown", (event: KeyboardEvent) => {
      const currentIndex = agentTabs.indexOf(tab);
      const lastIndex = agentTabs.length - 1;
      const nextIndex =
        event.key === "ArrowRight"
          ? currentIndex + 1
          : event.key === "ArrowLeft"
            ? currentIndex - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? lastIndex
                : currentIndex;
      const wrappedIndex = nextIndex < 0 ? lastIndex : nextIndex > lastIndex ? 0 : nextIndex;

      if (wrappedIndex !== currentIndex) {
        event.preventDefault();
        const nextTab = agentTabs[wrappedIndex];
        const selectedId = nextTab.dataset.agentTab;
        nextTab.focus();
        if (selectedId) selectAgentTab(selectedId);
      }
    });
  }
}
```

- [ ] **Step 2: Include panels in reveal targets**

Replace the reveal target selector:

```ts
".problem, .proof, .integrations, .install, .proof-item, .integration-strip li, .terminal li";
```

with:

```ts
".problem, .proof, .integrations, .install, .proof-item, .integration-pill, .agent-setup-panel, .terminal li";
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @caplets/landing typecheck
```

Expected: PASS with 0 errors.

- [ ] **Step 4: Commit behavior**

```bash
git add apps/landing/src/pages/index.astro
git commit -m "feat(landing): switch agent setup tabs"
```

## Task 3: Style pills as tabs and preserve card aesthetics

**Files:**

- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Replace list-item pill styles with button/tab styles**

Replace:

```css
.integration-strip li {
  border: 1px solid var(--night-line);
  border-radius: 999px;
  padding: 10px 12px;
  color: var(--night-text);
  background: oklch(28% 0.018 100);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
}
```

with:

```css
.integration-pill {
  border: 1px solid var(--night-line);
  border-radius: 999px;
  padding: 10px 12px;
  color: var(--night-text);
  background: oklch(28% 0.018 100);
  font: inherit;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  transition:
    background-color 180ms var(--ease-out),
    border-color 180ms var(--ease-out),
    color 180ms var(--ease-out),
    transform 180ms var(--ease-out);
}

.integration-pill:hover,
.integration-pill[aria-selected="true"] {
  border-color: oklch(86% 0.08 35);
  background: var(--parchment);
  color: var(--night-ink);
  transform: translateY(-1px);
}
```

- [ ] **Step 2: Add setup panel styles after the pill styles**

Add:

```css
.agent-setup-card {
  min-width: 0;
  display: grid;
  gap: 18px;
}

.agent-setup-panels {
  min-width: 0;
  border: 1px solid var(--night-line);
  border-radius: 20px;
  background: oklch(25% 0.016 100);
  overflow: hidden;
}

.agent-setup-panel {
  padding: 18px;
}

.agent-setup-panel[hidden] {
  display: none;
}

.agent-setup-note {
  margin: 0 0 14px;
  color: var(--night-muted);
}

.agent-setup-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);
  gap: 12px;
}

.agent-setup-label {
  display: block;
  margin-bottom: 8px;
  color: oklch(86% 0.08 35);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.agent-setup-panel pre {
  min-width: 0;
  min-height: 100%;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--night-line);
  border-radius: 14px;
  background: var(--night-ink);
  color: var(--night-text);
  overflow-x: auto;
}

.agent-setup-panel code {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Update reduced-motion selector**

Replace any remaining `.integration-strip li` selector in animation/reveal CSS with `.integration-pill` so reveal styling still applies to the new buttons.

- [ ] **Step 4: Add responsive stacking**

Inside the existing small-screen media query where `.integration-strip` is adjusted, add:

```css
.agent-setup-grid {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 5: Run formatting and typecheck**

```bash
pnpm format:check
pnpm --filter @caplets/landing typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit styling**

```bash
git add apps/landing/src/styles/global.css
git commit -m "style(landing): polish agent setup tabs"
```

## Task 4: Verify and document final state

**Files:**

- Modify only if verification reveals a bug: `apps/landing/src/pages/index.astro`, `apps/landing/src/styles/global.css`

- [ ] **Step 1: Run focused checks**

```bash
pnpm format:check
pnpm lint
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: all commands PASS.

- [ ] **Step 2: Inspect the rendered output locally**

Run:

```bash
pnpm --filter @caplets/landing build
```

Expected: Astro build completes and generated HTML includes `role="tablist"`, each agent label, install commands, and config snippets.

- [ ] **Step 3: Commit verification fixes if any**

If Step 1 or Step 2 required changes:

```bash
git add apps/landing/src/pages/index.astro apps/landing/src/styles/global.css
git commit -m "fix(landing): verify agent setup tabs"
```

If no changes were required, do not create an empty commit.

- [ ] **Step 4: Final status check**

```bash
git status --short
```

Expected: no unexpected unstaged changes. Existing unrelated user changes may remain and must be called out in the implementation summary.

## Self-review

- Spec coverage: The plan preserves the existing card, turns pills into tabs, shows install/config content per agent, centralizes data, includes accessibility semantics, and defines verification commands.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain.
- Type consistency: The plan consistently uses `agentSetups`, `data-agent-tab`, `data-agent-panel`, `.integration-pill`, and `.agent-setup-panel` across markup, script, and CSS.
