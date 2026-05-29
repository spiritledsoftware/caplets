# Landing Page Proof-Led Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Caplets landing page around proof-led, agent-native activation so users add Caplets to their agent or MCP client before configuring Context7 as the first capability source.

**Architecture:** Keep the implementation inside the existing Astro page and CSS file. Reorder and reshape page sections rather than introducing a new component system. Preserve the current client-side tab and copy-button script, but update the data and markup it operates on.

**Tech Stack:** Astro, TypeScript-in-Astro script, plain CSS with existing OKLCH tokens, pnpm, Astro typecheck/build.

---

## File Structure

- Modify `apps/landing/src/pages/index.astro`
  - Update top navigation labels.
  - Replace the bottom-heavy install flow with an agent-native activation section near the top.
  - Convert benchmark proof into a compact proof strip after the hero.
  - Compress problem, capability, and trust explanation into one structured section.
  - Keep integration tabs as expanded setup reference.
  - Preserve copy-button and tab behavior.
- Modify `apps/landing/src/styles/global.css`
  - Add styles for the compact proof strip, activation section, and compressed explanation.
  - Remove or retire styles only used by deleted repeated sections.
  - Flatten the hero trace visual by reducing wide shadow and excessive roundness.
  - Ensure responsive layout has no horizontal overflow.
- Optionally modify `README.md`
  - Only if implementation changes public activation wording already duplicated in README.
- Do not modify `.brv/` files.
- Do not modify `package.json` package manager metadata.

---

### Task 1: Add Source Assertions for the New Story

**Files:**

- Create: `apps/landing/test/campaign-copy.test.mjs`
- Modify: `apps/landing/package.json`

- [ ] **Step 1: Add a source-level assertion script**

Create `apps/landing/test/campaign-copy.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(__dirname, "../src/pages/index.astro"), "utf8");

const required = [
  "Give your agents capabilities, not giant tool walls.",
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
  "get_caplet",
  "search_tools",
  "get_tool",
  "call_tool",
];

const forbiddenVisibleCopy = [
  "01</span>",
  "02</span>",
  "03</span>",
  "Try the aha moment",
  "caplets serve\",\n];

const missing = required.filter((needle) => !page.includes(needle));
const forbidden = forbiddenVisibleCopy.filter((needle) => page.includes(needle));

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) console.error("Missing required copy:", missing);
  if (forbidden.length > 0) console.error("Forbidden old copy remains:", forbidden);
  process.exit(1);
}
```

- [ ] **Step 2: Add a package script**

In `apps/landing/package.json`, add this script while preserving existing scripts:

```json
"campaign:check": "node test/campaign-copy.test.mjs"
```

If the file currently contains:

```json
{
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "typecheck": "astro check"
  }
}
```

it should become:

```json
{
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "typecheck": "astro check",
    "campaign:check": "node test/campaign-copy.test.mjs"
  }
}
```

- [ ] **Step 3: Run the new assertion and verify it fails before implementation**

Run:

```bash
pnpm --filter @caplets/landing campaign:check
```

Expected: FAIL because the page still contains old activation structure and may still include the old manual `caplets serve` install step.

- [ ] **Step 4: Commit the failing assertion**

```bash
git add apps/landing/test/campaign-copy.test.mjs apps/landing/package.json
git commit -m "test: assert landing activation story"
```

---

### Task 2: Restructure Landing Page Content

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Replace activation data model**

In `apps/landing/src/pages/index.astro`, replace the existing `installSteps` constant with these constants:

```ts
const context7Steps = [
  "caplets init",
  "caplets add mcp context7 --command npx --arg -y --arg @upstash/context7-mcp",
];

const discoveryPath = ["context7", "get_caplet", "search_tools", "get_tool", "call_tool"];

const primaryAgentPaths = [
  {
    name: "Claude Code",
    setup:
      "Install the Caplets plugin from the marketplace, then add Context7 as your first source.",
    command: "claude plugin marketplace add spiritledsoftware/caplets",
  },
  {
    name: "Codex",
    setup:
      "Add the Caplets plugin marketplace, install the plugin, then add Context7 as your first source.",
    command: "codex plugin marketplace add spiritledsoftware/caplets",
  },
  {
    name: "Any MCP client",
    setup: "Configure the client to launch Caplets as its MCP server command, then add Context7.",
    command: '{ "command": "caplets", "args": ["serve"] }',
  },
];
```

Do not delete `agentSetups`; the expanded integration tabs still use it.

- [ ] **Step 2: Update navigation labels**

Replace the current top nav numbered links:

```astro
<a href="#trace"><span>01</span> Trace</a>
<a href="#proof"><span>02</span> Proof</a>
<a href="#install"><span>03</span> Install</a>
```

with plain labels:

```astro
<a href="#trace">Trace</a>
<a href="#proof">Proof</a>
<a href="#install">Add to agent</a>
```

- [ ] **Step 3: Update hero CTA labels**

Replace:

```astro
<a class="button primary" href="#install">Install Caplets</a>
<a class="button secondary" href="https://github.com/spiritledsoftware/caplets">Inspect the repo</a>
```

with:

```astro
<a class="button primary" href="#install">Add Caplets to your agent</a>
<a class="button secondary" href="#proof">See the benchmark</a>
```

- [ ] **Step 4: Move proof strip immediately after hero**

After the closing `</section>` for the hero, insert this new proof strip:

```astro
<section class="proof-strip" id="proof" aria-label="Deterministic benchmark proof">
  <div class="proof-strip-copy">
    <span>Deterministic benchmark</span>
    <p>Direct MCP aggregation exposed 106 flat tools. Caplets started with 3 capability cards and an 87.8% smaller initial payload.</p>
  </div>
  <dl class="proof-strip-stats">
    {proofStats.map((stat) => (
      <div>
        <dt>{stat.label}</dt>
        <dd>{stat.value}</dd>
      </div>
    ))}
  </dl>
  <a href="https://github.com/spiritledsoftware/caplets/blob/main/docs/benchmarks/coding-agent.md">Read benchmark method</a>
</section>
```

- [ ] **Step 5: Add agent-native activation section immediately after proof strip**

Insert this section after `proof-strip`:

```astro
<section class="activation" id="install" aria-labelledby="activation-title">
  <div class="activation-copy">
    <p class="section-note">Add Caplets to your agent</p>
    <h2 id="activation-title">Install the integration, then add Context7 as your first capability.</h2>
    <p>
      Start where you already work. Caplets should be loaded by your agent plugin, native integration,
      or MCP client configuration, with Context7 as the first source to prove the flow.
    </p>
  </div>

  <div class="agent-paths" aria-label="Fast setup paths">
    {primaryAgentPaths.map((path) => (
      <article class="agent-path">
        <h3>{path.name}</h3>
        <p>{path.setup}</p>
        <code>{path.command}</code>
      </article>
    ))}
  </div>

  <div class="context7-setup">
    <div>
      <h3>Add Context7</h3>
      <p>After the integration is installed, add Context7 and look for one `context7` capability inside your agent.</p>
      <div class="discovery-path" aria-label="Expected discovery path">
        {discoveryPath.map((step, index) => index === 0 ? <code>{step}</code> : <span>{step}</span>)}
      </div>
      <p class="setup-help">If setup fails, check Node 22+, `npx`, plugin installation, and your MCP client command configuration.</p>
    </div>
    <div class="terminal" role="region" aria-label="Context7 source commands">
      <div class="terminal-bar" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <ol>
        {context7Steps.map((step, index) => (
          <li>
            <code id={`context7-step-${index + 1}`} tabindex="-1">{step}</code>
            <button
              class="copy-button terminal-copy"
              type="button"
              aria-controls={`context7-step-${index + 1}`}
              data-copy-target={`context7-step-${index + 1}`}
              data-copy-value={step}
            >
              Copy
            </button>
          </li>
        ))}
      </ol>
    </div>
  </div>
</section>
```

- [ ] **Step 6: Replace repeated middle sections with one compressed explanation**

Replace the existing `problem`, `proof`, and `trust` sections with this single section:

```astro
<section class="model" aria-labelledby="model-title">
  <div class="section-heading narrow">
    <p class="section-note">Why it works</p>
    <h2 id="model-title">A capability gives the agent one decision before it sees every operation.</h2>
  </div>
  <div class="model-grid">
    <article>
      <h3>Before: flat tool wall</h3>
      <p>Every downstream operation enters context before the agent knows which domain matters.</p>
    </article>
    <article>
      <h3>After: capability first</h3>
      <p>The agent chooses a source, searches inside that scope, inspects the schema, then calls the tool.</p>
    </article>
    <article>
      <h3>Trust before invocation</h3>
      <p>Source, auth state, timeout boundary, and safe error recovery stay visible before the call.</p>
    </article>
  </div>
</section>
```

Delete the old `proof-asset` inside the problem section because the new `proof-strip` replaces it.

- [ ] **Step 7: Rename integrations heading to expanded setup**

Update the integrations section heading from:

```astro
<p class="section-note">Works where agents work</p>
<h2 id="integrations-title">Run Caplets from the coding agent you already use.</h2>
```

to:

```astro
<p class="section-note">Expanded setup reference</p>
<h2 id="integrations-title">Choose the integration your agent should load.</h2>
```

- [ ] **Step 8: Remove the old install section**

Delete the old bottom `<section class="install" id="install" ...>` because the new `activation` section owns `id="install"`. Keep the footer.

- [ ] **Step 9: Run the source assertion**

Run:

```bash
pnpm --filter @caplets/landing campaign:check
```

Expected: PASS.

- [ ] **Step 10: Commit content restructure**

```bash
git add apps/landing/src/pages/index.astro
git commit -m "feat: restructure landing around agent activation"
```

---

### Task 3: Update CSS for New Section Rhythm

**Files:**

- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Update shared section selectors**

Replace occurrences of shared selectors that list old sections:

```css
.problem,
.proof,
.integrations,
.install,
.site-footer
```

with:

```css
.proof-strip,
.activation,
.model,
.integrations,
.site-footer
```

For motion selectors, use:

```css
.motion-ready .proof-strip,
.motion-ready .activation,
.motion-ready .model,
.motion-ready .integrations,
.motion-ready .agent-path,
.motion-ready .model-grid article,
.motion-ready .agent-setup-panel,
.motion-ready .terminal li
```

and the matching `.is-visible` selector list.

- [ ] **Step 2: Flatten the trace artifact**

Replace the current `.trace-stage` block with:

```css
.trace-stage {
  min-width: 0;
  border: 1px solid var(--ash);
  border-radius: 18px;
  background: var(--paper);
  overflow: hidden;
  box-shadow: 0 6px 0 oklch(24% 0.018 100 / 0.08);
}
```

This removes the wide 54px blur shadow and over-rounded card feel.

- [ ] **Step 3: Add proof strip styles**

Add after the hero styles:

```css
.proof-strip {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: clamp(18px, 3vw, 34px);
  align-items: center;
  border-block: 1px solid var(--ash);
  padding-block: clamp(18px, 3vw, 26px);
}

.proof-strip-copy {
  min-width: 0;
}

.proof-strip-copy span {
  display: block;
  margin-bottom: 6px;
  color: var(--ember-deep);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 800;
}

.proof-strip-copy p {
  max-width: 68ch;
  margin: 0;
  color: var(--charred-ink);
}

.proof-strip-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  margin: 0;
  border: 1px solid var(--ash);
  background: var(--ash);
}

.proof-strip-stats div {
  min-width: 112px;
  padding: 12px 14px;
  background: var(--paper);
}

.proof-strip-stats dt {
  color: var(--olive);
  text-transform: none;
  font-size: 0.82rem;
}

.proof-strip-stats dd {
  color: var(--charred-ink);
  font-family: var(--font-mono);
  font-size: 1rem;
  font-weight: 800;
}

.proof-strip a {
  color: var(--charred-ink);
  font-weight: 760;
  white-space: nowrap;
}
```

- [ ] **Step 4: Add activation styles**

Add after proof strip styles:

```css
.activation {
  display: grid;
  gap: clamp(22px, 4vw, 40px);
  border: 1px solid var(--ash);
  border-radius: 20px;
  background: var(--paper);
  padding: clamp(22px, 4vw, 42px);
}

.activation-copy {
  max-width: 860px;
}

.activation h2 {
  max-width: 13ch;
  margin: 0;
  font-size: clamp(2.1rem, 4.2vw, 4.35rem);
  line-height: 1.02;
  letter-spacing: -0.038em;
  text-wrap: balance;
}

.activation-copy p:last-child {
  max-width: 68ch;
  color: var(--olive);
}

.agent-paths {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--ash);
  background: var(--ash);
}

.agent-path {
  min-width: 0;
  background: var(--linen);
  padding: 18px;
}

.agent-path h3 {
  margin-bottom: 8px;
  font-size: 1.1rem;
}

.agent-path p {
  color: var(--olive);
}

.agent-path code {
  display: block;
  color: var(--charred-ink);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.context7-setup {
  display: grid;
  grid-template-columns: minmax(0, 0.78fr) minmax(320px, 1fr);
  gap: clamp(20px, 4vw, 44px);
  align-items: start;
}

.context7-setup h3 {
  margin-bottom: 10px;
  font-size: 1.35rem;
}

.context7-setup p {
  color: var(--olive);
}

.discovery-path {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0;
}

.discovery-path code,
.discovery-path span {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--ash);
  border-radius: 999px;
  padding: 7px 10px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 760;
}

.discovery-path code {
  background: var(--charred-ink);
  color: var(--parchment);
}

.discovery-path span {
  background: var(--linen);
  color: var(--ember-deep);
}

.setup-help {
  max-width: 62ch;
  margin-bottom: 0;
  font-size: 0.94rem;
}
```

- [ ] **Step 5: Add compressed model styles**

Add after activation styles:

```css
.model {
  display: grid;
  gap: 26px;
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  border: 1px solid var(--ash);
  background: var(--ash);
}

.model-grid article {
  min-width: 0;
  background: var(--paper);
  padding: 22px;
}

.model-grid h3 {
  margin-bottom: 8px;
  font-size: 1.25rem;
}

.model-grid p {
  margin: 0;
  color: var(--olive);
}
```

- [ ] **Step 6: Retire deleted-section styles**

Delete CSS blocks that are only used by removed markup:

```css
.comparison
.dense-list
.ordered-flow
.tool-noise
.proof-asset
.proof-stats
.proof-stat
.proof-list
.proof-item
.proof-eyebrow
.trust
.trust-grid
.trust-item
.trust-error
.aha-path
.install
.install-copy
```

Keep `.terminal`, `.terminal-bar`, `.terminal li`, `.terminal-copy`, `.integrations`, and all tab/copy styles.

- [ ] **Step 7: Update responsive rules**

In `@media (max-width: 980px)`, ensure these selectors collapse to one column:

```css
.proof-strip,
.activation,
.context7-setup,
.agent-paths,
.model-grid,
.integrations {
  grid-template-columns: 1fr;
}

.proof-strip-stats {
  width: 100%;
}
```

In `@media (max-width: 720px)`, ensure terminal rows and cards fit:

```css
.agent-path,
.model-grid article {
  padding: 16px;
}

.proof-strip a {
  white-space: normal;
}
```

- [ ] **Step 8: Run typecheck and campaign assertion**

```bash
pnpm --filter @caplets/landing campaign:check
pnpm --filter @caplets/landing typecheck
```

Expected: both pass.

- [ ] **Step 9: Commit CSS restructure**

```bash
git add apps/landing/src/styles/global.css
git commit -m "style: tighten landing activation layout"
```

---

### Task 4: Update Motion Script Selectors

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Update reveal target selector**

In the script near the bottom of `apps/landing/src/pages/index.astro`, replace the old selector string:

```ts
".problem, .proof, .trust, .integrations, .install, .proof-item, .trust-item, .trust-error, .agent-setup-panel, .terminal li";
```

with:

```ts
".proof-strip, .activation, .model, .integrations, .agent-path, .model-grid article, .agent-setup-panel, .terminal li";
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @caplets/landing typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit motion selector update**

```bash
git add apps/landing/src/pages/index.astro
git commit -m "fix: update landing reveal targets"
```

---

### Task 5: Browser Verification and Polish

**Files:**

- Modify: `apps/landing/src/pages/index.astro` if browser inspection finds copy or structure defects.
- Modify: `apps/landing/src/styles/global.css` if browser inspection finds spacing, contrast, overflow, or responsive defects.

- [ ] **Step 1: Open the user dev server**

Use the running server at:

```text
http://127.0.0.1:4321/
```

If port 4321 is not responding, ask the user before starting another server.

- [ ] **Step 2: Inspect desktop layout**

Use browser automation at `1440x1100`. Evaluate:

```js
(() => {
  const vw = innerWidth;
  const overflow = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > vw + 1 || r.left < -1;
    })
    .map((el) => ({
      tag: el.tagName,
      cls: String(el.className),
      text: el.textContent.trim().slice(0, 80),
    }));

  const sections = [...document.querySelectorAll("main > section")].map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: String(el.className), top: Math.round(r.top), height: Math.round(r.height) };
  });

  return { scrollWidth: document.documentElement.scrollWidth, vw, overflow, sections };
})();
```

Expected:

```json
{
  "scrollWidth": 1440,
  "vw": 1440,
  "overflow": []
}
```

Section heights should show activation near the top, before the compressed model and integrations.

- [ ] **Step 3: Inspect mobile layout**

Resize to `390x844` and run the same overflow script.

Expected:

```json
{
  "scrollWidth": 390,
  "vw": 390,
  "overflow": []
}
```

Confirm the activation section appears before detailed integrations and that terminal code wraps rather than overflowing.

- [ ] **Step 4: Check console messages**

Expected: no browser errors or warnings from the app.

- [ ] **Step 5: Apply minimal polish fixes**

If any of these are observed, apply only the matching fix:

- Horizontal overflow from code: add `overflow-wrap: anywhere` to the specific code selector.
- Activation too visually heavy: reduce padding by one clamp step or remove a redundant border.
- Proof strip feels like metric cards: reduce stat box padding and keep labels subdued.
- Hero trace still looks like SaaS card: reduce border radius to `16px` or remove remaining shadow.

- [ ] **Step 6: Run focused verification**

```bash
pnpm --filter @caplets/landing campaign:check
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
git diff --check
```

Expected: all pass.

- [ ] **Step 7: Commit browser polish**

If Step 5 changed files:

```bash
git add apps/landing/src/pages/index.astro apps/landing/src/styles/global.css
git commit -m "fix: polish landing activation responsiveness"
```

If Step 5 changed nothing, do not create an empty commit.

---

### Task 6: Final Verification and Report

**Files:**

- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run final source assertions**

```bash
pnpm --filter @caplets/landing campaign:check
```

Expected: PASS.

- [ ] **Step 2: Run final typecheck**

```bash
pnpm --filter @caplets/landing typecheck
```

Expected: `0 errors`, `0 warnings`, `0 hints`.

- [ ] **Step 3: Run final build**

```bash
pnpm --filter @caplets/landing build
```

Expected: build completes successfully and reports one page built.

- [ ] **Step 4: Run whitespace check**

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Summarize changed files and verification**

Report:

```text
Changed files:
- apps/landing/src/pages/index.astro
- apps/landing/src/styles/global.css
- apps/landing/package.json
- apps/landing/test/campaign-copy.test.mjs
- docs/specs/2026-05-29-landing-proof-led-activation-design.md
- docs/plans/2026-05-29-landing-proof-led-activation.md

Verification:
- pnpm --filter @caplets/landing campaign:check: passed
- pnpm --filter @caplets/landing typecheck: passed
- pnpm --filter @caplets/landing build: passed
- git diff --check: passed
- Browser desktop/mobile overflow: none
```

Do not claim completion if any verification step fails.
