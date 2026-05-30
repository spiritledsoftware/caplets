# Caplets Growth Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public campaign assets that make Caplets easy to understand, try, and share before wider launch.

**Architecture:** The campaign centers on one message: “Give your agents capabilities, not giant tool walls.” The first implementation slice strengthens activation proof by adding a visible “100+ tools vs 3 capabilities” proof asset and a guided “Try the aha moment” path to the landing page and README. Later slices prepare outreach copy and launch-channel assets without changing product runtime behavior.

**Tech Stack:** Astro landing page in `apps/landing`, project README Markdown, existing Caplets benchmark report in `docs/benchmarks/coding-agent.md`, pnpm 11.0.9, Node >=22.

---

## File Structure

- Modify: `apps/landing/src/pages/index.astro`
  - Owns landing content, proof copy, install/try steps, and inline data arrays for static rendering.
- Modify: `apps/landing/src/styles/global.css`
  - Owns visual treatment for the proof asset and aha section. Keep to existing OKLCH variables and Caplets design laws.
- Modify: `README.md`
  - Mirrors the shortest activation path and proof numbers for GitHub visitors.
- Reference: `docs/benchmarks/coding-agent.md`
  - Source for deterministic proof numbers: 106 direct tools, 3 Caplets capabilities, 97.2% fewer initially visible tools, 87.8% smaller initial payload.
- Create later: `docs/product/caplets-launch-posts.md`
  - Draft HN, Reddit, X/Twitter, and outreach copy.
- Create later: `docs/product/caplets-outreach-list.md`
  - Manual outreach targets, status, and feedback notes.

## Task 1: Add activation proof and aha path

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`
- Modify: `README.md`

- [ ] **Step 1: Add text assertions before editing content**

Create a temporary shell check that fails until the campaign proof copy exists:

```bash
node - <<'NODE'
const fs = require('fs');
const landing = fs.readFileSync('apps/landing/src/pages/index.astro', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const checks = [
  [landing, '106 flat tools'],
  [landing, '3 capability cards'],
  [landing, 'Try the aha moment'],
  [readme, 'Try the aha moment'],
  [readme, '106 flat tools became 3 top-level capabilities'],
];
const missing = checks.filter(([text, needle]) => !text.includes(needle)).map(([, needle]) => needle);
if (missing.length) {
  console.error('Missing campaign copy:', missing.join(', '));
  process.exit(1);
}
NODE
```

Expected before implementation: exits `1` and lists missing strings.

- [ ] **Step 2: Add proof data and aha copy to `index.astro`**

Add static constants near existing hero data:

```ts
const proofStats = [
  {
    value: "106",
    label: "flat tools",
    detail: "Direct MCP aggregation exposes every downstream operation up front.",
  },
  {
    value: "3",
    label: "capability cards",
    detail: "Caplets starts with one focused card per tool source.",
  },
  {
    value: "87.8%",
    label: "smaller initial payload",
    detail: "The deterministic benchmark cuts serialized tool metadata before discovery.",
  },
];

const ahaSteps = [
  "npm install -g caplets",
  "caplets init",
  "caplets add mcp context7 --command npx --arg -y --arg @upstash/context7-mcp",
  "caplets serve",
];
```

Add a proof block in the existing problem section so the before/after comparison has hard numbers. Add an aha section before the install section with copy-paste commands and the expected agent discovery path: `context7 → get_caplet → search_tools → get_tool → call_tool`.

- [ ] **Step 3: Style the proof asset and aha path**

In `apps/landing/src/styles/global.css`, add responsive styles for:

- `.proof-asset`
- `.proof-stat`
- `.aha`
- `.aha-path`
- `.aha-commands`

Use existing tokens: `--paper`, `--parchment`, `--ash`, `--charred-ink`, `--ember`, `--olive`. Do not add gradient text, glassmorphism, side-stripe borders, or decorative motion.

- [ ] **Step 4: Mirror the activation path in README**

Add a `## Try the aha moment` section before `## Quick Start`:

````md
## Try the aha moment

Install Caplets, add Context7, and watch your agent see one capability before it searches downstream tools.

```sh
npm install -g caplets
caplets init
caplets add mcp context7 --command npx --arg -y --arg @upstash/context7-mcp
caplets serve
```
````

In the deterministic benchmark, 106 flat tools became 3 top-level capabilities with an 87.8% smaller initial payload. Your agent starts with `context7`, then drills in through `get_caplet`, `search_tools`, `get_tool`, and `call_tool` only when needed.

````

- [ ] **Step 5: Re-run the text assertions**

Run the same Node assertion from Step 1.

Expected after implementation: exits `0` with no output.

- [ ] **Step 6: Verify landing page**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
````

Expected: Astro check reports 0 errors, 0 warnings, 0 hints; build completes with 1 page built.

- [ ] **Step 7: Commit**

```bash
git add README.md apps/landing/src/pages/index.astro apps/landing/src/styles/global.css docs/plans/2026-05-29-caplets-growth-campaign.md
git commit -m "docs: plan caplets growth campaign"
```

## Task 2: Prepare launch copy drafts

**Files:**

- Create: `docs/product/caplets-launch-posts.md`

- [ ] **Step 1: Draft HN post**

Include title, opening paragraph, benchmark proof, setup command, and repo link. Use the headline: `Show HN: Caplets, give agents capabilities instead of giant tool walls`.

- [ ] **Step 2: Draft X/Twitter thread**

Write 6 to 8 short posts: pain, before visual, after visual, benchmark, Context7/GitHub demo, repo CTA.

- [ ] **Step 3: Draft Reddit post**

Write one technical, transparent post titled `I built Caplets to reduce MCP tool overload for coding agents`. Avoid asking for stars directly.

- [ ] **Step 4: Verify copy constraints**

Search the file for em dashes and replace them with commas, colons, semicolons, or parentheses:

```bash
node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('docs/product/caplets-launch-posts.md', 'utf8');
if (text.includes('—')) {
  console.error('Found em dash in launch copy');
  process.exit(1);
}
NODE
```

## Task 3: Prepare manual outreach tracker

**Files:**

- Create: `docs/product/caplets-outreach-list.md`

- [ ] **Step 1: Create target categories**

Add sections for MCP server authors, agent power users, awesome-list maintainers, AI devtool newsletter writers, and community moderators.

- [ ] **Step 2: Add outreach message templates**

Include a short DM template that asks for feedback on the 60-second demo rather than asking for a star.

- [ ] **Step 3: Add tracking table**

Columns: `Target`, `Channel`, `Why relevant`, `Status`, `Feedback`, `Follow-up`.

## Task 4: Launch readiness review

**Files:**

- Modify: `docs/product/caplets-launch-posts.md`
- Modify: `docs/product/caplets-outreach-list.md`
- Modify as needed: `README.md`, `apps/landing/src/pages/index.astro`, `apps/landing/src/styles/global.css`

- [ ] **Step 1: Run full focused verification**

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
pnpm format:check
```

Expected: all commands exit 0.

- [ ] **Step 2: Review first-screen message**

Confirm the landing page and README both surface the same message: `Give your agents capabilities, not giant tool walls.`

- [ ] **Step 3: Review activation path**

Confirm a fresh visitor can see install commands, a concrete MCP example, and the expected progressive discovery path without scrolling through broad feature lists first.

## Self-Review

- Spec coverage: The plan covers the immediate proof asset and aha section, then launch copy, outreach, and readiness review.
- Placeholder scan: No TBD, TODO, or vague implementation placeholders remain.
- Type consistency: Constants and CSS class names are defined in the same task that uses them.
