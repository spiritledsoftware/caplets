# Skillify Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `apps/landing` so the Caplets landing page leads with trust, defines the coined product verb “skillify,” proves progressive disclosure through a realistic GitHub trace, and removes visual choreography that conflicts with the Caplets brand.

**Architecture:** Keep the landing app as a focused Astro page with one stylesheet. Refactor content constants in `apps/landing/src/pages/index.astro`, rebuild the hero around an inspectable trace, add trust proof and copy affordances, then simplify `apps/landing/src/styles/global.css` by deleting major motion systems instead of hiding them. Preserve semantic HTML, ARIA tab behavior, keyboard support, reduced-motion behavior, and responsive layout.

**Tech Stack:** Astro 6, TypeScript in Astro inline scripts, Tailwind CSS import, plain CSS, pnpm 11.

---

## Decision Record

These decisions came from the critique and grill-me session:

1. Optimize first for **trust in the architecture**, then conceptual understanding, then install conversion.
2. Replace the expressive map hero with a **proof-first product diagram**.
3. Use a **realistic trace**, not a purely conceptual diagram.
4. Use **GitHub** as the hero trace capability because it has higher trust stakes than docs lookup.
5. Make **capability card** the dominant product concept. Keep “map” only as a supporting metaphor.
6. Coin and define **skillify** as durable product language.
7. Put “Skillify your backends” in the hero subhead and demonstrate it immediately.
8. Use a tight definition in the hero, then a three-part proof framework below.
9. Delete major animation systems, including pointer tilt, scroll-driven route resolution, route drift, heavy glow, and orchestration.
10. Create this written plan before code changes.

## File Structure

### Modify: `apps/landing/src/pages/index.astro`

Responsibilities after this plan:

- Own content constants for capability trace, trust mechanics, proof framework, integration tabs, and install commands.
- Render a trust-first hero with “skillify” defined in public-facing copy.
- Render a realistic GitHub progressive-disclosure trace.
- Render a three-part “What skillify means” proof framework.
- Render trust mechanics with concrete status, source, auth redaction, timeout, error, and lossless-result examples.
- Render copyable install/config snippets with progressive enhancement.
- Keep no-JS integration content accessible.
- Keep accessible tabs when JavaScript runs.

### Modify: `apps/landing/src/styles/global.css`

Responsibilities after this plan:

- Preserve the Caplets warm-light design system.
- Style the new hero trace, skillify framework, trust proof, and copy buttons.
- Remove major choreography and decorative cartography styling.
- Keep only restrained hover, focus, and content-reveal transitions.
- Maintain responsive layouts at desktop, tablet, and phone widths.
- Preserve reduced-motion behavior.

### Optional Modify: `apps/landing/README.md`

Only modify if implementation adds a new local QA note that is useful to future maintainers. This plan does not require it.

## Canonical Copy and Content Decisions

Use these exact product messages unless implementation reveals a factual problem:

- Hero kicker: `Capability cards for coding agents`
- Hero headline: `Skillify your backends.`
- Hero lede: `Caplets turns MCP servers, APIs, and commands into focused agent capabilities: one card first, searchable tools next, inspectable schemas before calls, and preserved results after.`
- Definition line: `To skillify a backend is to wrap it as a capability an agent can discover, inspect, call, and recover from one step at a time.`
- Primary CTA: `Install Caplets`
- Secondary CTA: `Inspect the repo`
- Trust section heading: `Trust is visible before the call.`
- Skillify framework heading: `What skillify means`

Avoid em dashes in all new copy.

## Task 1: Refactor Landing Content Constants

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Replace the current hero capability card constants with trace-oriented constants**

In `apps/landing/src/pages/index.astro`, replace the existing `capabilityCards` constant with the following constants:

```ts
const heroTrace = {
  capability: "github",
  source: ".caplets/config.json",
  status: "ready",
  auth: "token present, redacted",
  steps: [
    {
      label: "get_caplet",
      detail: "Expose one card before any downstream tool list enters context.",
      result: "search_tools · get_tool · call_tool",
    },
    {
      label: 'search_tools("pull request")',
      detail: "Find matching operations inside the selected capability only.",
      result: "create_pull_request · list_pull_requests · request_review",
    },
    {
      label: 'get_tool("create_pull_request")',
      detail: "Inspect the preserved schema before an agent can invoke the operation.",
      result: "title · body · base · head · reviewers?",
    },
    {
      label: "call_tool(arguments)",
      detail: "Forward the call and keep downstream content, structured data, and errors intact.",
      result: "structuredContent + content",
    },
  ],
};

const skillifyFramework = [
  {
    title: "Discoverable as one capability",
    copy: "A backend enters the agent context as a focused card with source, status, and next actions, not a flat wall of operations.",
  },
  {
    title: "Inspectable before invocation",
    copy: "Agents search inside the selected capability, then inspect exact tool schemas before any call is made.",
  },
  {
    title: "Lossless after the call",
    copy: "Caplets preserves structured content, resource links, images, and downstream error state instead of flattening results away.",
  },
];

const trustMechanics = [
  {
    label: "Source",
    value: ".caplets/config.json",
    copy: "Users can see where the capability came from before trusting it.",
  },
  {
    label: "Auth",
    value: "GITHUB_TOKEN: redacted",
    copy: "Secrets stay hidden while auth state remains inspectable.",
  },
  {
    label: "Timeout",
    value: "30s boundary",
    copy: "Slow or stuck backends fail visibly instead of disappearing into agent context.",
  },
  {
    label: "Error",
    value: "safe message + raw detail scoped",
    copy: "Recovery information stays useful without leaking sensitive configuration.",
  },
];
```

Delete any references to the removed `capabilityCards` constant during later tasks.

- [ ] **Step 2: Normalize install command data**

In the existing `agentSetups` array, ensure every generic global package install uses `npm install -g caplets` unless the specific client has a stronger documented install path. Replace the `installSteps` constant with:

```ts
const installSteps = [
  "npm install -g caplets",
  "caplets init",
  "caplets add mcp docs --command npx --arg -y --arg @upstash/context7-mcp",
  "caplets serve",
];
```

- [ ] **Step 3: Run Astro typecheck**

Run:

```bash
pnpm --filter @caplets/landing typecheck
```

Expected: PASS. If references to removed constants fail, continue to Task 2 and remove those references while rebuilding the hero.

## Task 2: Rebuild the Hero Around Skillify and GitHub Trace

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Replace hero copy and visual markup**

In `apps/landing/src/pages/index.astro`, replace the current `<section class="hero" aria-labelledby="hero-title">...</section>` with this structure:

```astro
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-copy">
    <p class="kicker">Capability cards for coding agents</p>
    <h1 id="hero-title">Skillify your backends.</h1>
    <p class="hero-lede">
      Caplets turns MCP servers, APIs, and commands into focused agent capabilities: one card
      first, searchable tools next, inspectable schemas before calls, and preserved results after.
    </p>
    <p class="hero-definition">
      To skillify a backend is to wrap it as a capability an agent can discover, inspect, call,
      and recover from one step at a time.
    </p>
    <div class="hero-actions" aria-label="Primary actions">
      <a class="button primary" href="#install">Install Caplets</a>
      <a class="button secondary" href="https://github.com/spiritledsoftware/caplets">Inspect the repo</a>
    </div>
    <dl class="hero-facts" aria-label="Supported capability sources">
      <div>
        <dt>Backends</dt>
        <dd>{backends.join(" · ")}</dd>
      </div>
      <div>
        <dt>Clients</dt>
        <dd>{integrations.join(" · ")}</dd>
      </div>
    </dl>
  </div>

  <aside class="trace-stage" id="trace" aria-label="GitHub capability trace example">
    <div class="trace-header">
      <span class="trace-status" aria-label={`Capability status: ${heroTrace.status}`}>{heroTrace.status}</span>
      <span>{heroTrace.capability}</span>
    </div>
    <dl class="trace-metadata" aria-label="Capability metadata">
      <div>
        <dt>source</dt>
        <dd>{heroTrace.source}</dd>
      </div>
      <div>
        <dt>auth</dt>
        <dd>{heroTrace.auth}</dd>
      </div>
    </dl>
    <ol class="trace-steps" aria-label="Progressive disclosure trace">
      {heroTrace.steps.map((step) => (
        <li>
          <div>
            <span class="trace-label">{step.label}</span>
            <p>{step.detail}</p>
          </div>
          <code>{step.result}</code>
        </li>
      ))}
    </ol>
  </aside>
</section>
```

- [ ] **Step 2: Remove old hero visual CSS selectors**

In `apps/landing/src/styles/global.css`, delete rules that only support the old map hero:

```css
.map-stage
.map-stage::before
.map-stage::after
.map-toolbar
.status-dot
.route-field
.route
.route-backbone
.map-stage.is-route-active .route-backbone
.route-two
.route-three
.route-draw
.route-draw-two
.route-draw-three
.capability-grid
.capability-card
.capability-card:hover
.card-1
.card-2
.card-3
.cartography-compass
.cartography-compass span
.cartography-compass span:nth-child(1)
.cartography-compass span:nth-child(2)
.cartography-compass span:nth-child(3)
.card-topline
.card-index
.capability-card h2
.capability-card p
.capability-card ul
.capability-card li
.inspect-panel
.inspect-panel code
.inspect-panel p
```

Also delete keyframes used only by the old hero:

```css
@keyframes map-stage-enter
@keyframes route-drift
@keyframes card-enter;
```

- [ ] **Step 3: Add new trace hero CSS**

Add this CSS near the existing hero styles:

```css
.hero-definition {
  max-width: 62ch;
  margin: -12px 0 28px;
  color: var(--charred-ink);
  font-size: clamp(0.98rem, 1.2vw, 1.1rem);
  line-height: 1.55;
}

.trace-stage {
  min-width: 0;
  border: 1px solid var(--ash);
  border-radius: 28px;
  background:
    linear-gradient(180deg, oklch(98% 0.014 82 / 0.98), oklch(96% 0.018 82 / 0.98)), var(--paper);
  overflow: hidden;
  box-shadow: 0 18px 54px oklch(24% 0.018 100 / 0.08);
}

.trace-header {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 18px;
  border-bottom: 1px solid var(--ash);
  color: var(--charred-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  font-weight: 760;
}

.trace-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in oklch, var(--success), var(--ash) 45%);
  border-radius: 999px;
  background: oklch(95% 0.03 145);
  color: oklch(34% 0.07 145);
  padding: 5px 9px;
  text-transform: uppercase;
  letter-spacing: 0.055em;
}

.trace-status::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
}

.trace-metadata {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  background: var(--ash);
}

.trace-metadata div {
  min-width: 0;
  padding: 14px 16px;
  background: var(--linen);
}

.trace-metadata dt,
.trace-label {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 760;
  letter-spacing: 0.055em;
}

.trace-metadata dt {
  margin-bottom: 5px;
  color: var(--ember-deep);
  text-transform: uppercase;
}

.trace-metadata dd {
  font-family: var(--font-mono);
  color: var(--charred-ink);
  overflow-wrap: anywhere;
}

.trace-steps {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: trace;
}

.trace-steps li {
  counter-increment: trace;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.72fr);
  gap: 18px;
  padding: 18px;
  border-top: 1px solid var(--ash);
}

.trace-steps li::before {
  content: counter(trace, decimal-leading-zero);
  grid-row: 1;
  align-self: start;
  width: fit-content;
  border: 1px solid var(--ash);
  border-radius: 999px;
  background: var(--parchment);
  color: var(--ember-deep);
  padding: 4px 7px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 760;
}

.trace-steps li > div {
  min-width: 0;
  display: grid;
  gap: 7px;
}

.trace-label {
  color: var(--charred-ink);
  overflow-wrap: anywhere;
}

.trace-steps p {
  margin: 0;
  color: var(--olive);
  font-size: 0.92rem;
  line-height: 1.45;
}

.trace-steps code {
  min-width: 0;
  align-self: start;
  border: 1px solid var(--ash);
  border-radius: 14px;
  background: var(--linen);
  color: var(--charred-ink);
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Update hero grid sizing**

Replace the current `.hero` grid columns:

```css
grid-template-columns: minmax(0, 0.92fr) minmax(420px, 1.08fr);
```

with:

```css
grid-template-columns: minmax(0, 0.86fr) minmax(460px, 1.14fr);
```

- [ ] **Step 5: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 3: Add the Skillify Proof Framework

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Replace the current proof section with skillify framework copy**

In `apps/landing/src/pages/index.astro`, replace the existing `<section class="proof" id="proof" aria-labelledby="proof-title">...</section>` with:

```astro
<section class="proof" id="proof" aria-labelledby="proof-title">
  <div class="section-heading narrow">
    <p class="kicker">What skillify means</p>
    <h2 id="proof-title">A backend becomes safe for agents when it reveals itself in stages.</h2>
  </div>
  <div class="proof-list">
    {skillifyFramework.map((point, index) => (
      <article class="proof-item">
        <p class="proof-eyebrow">0{index + 1}</p>
        <h3>{point.title}</h3>
        <p>{point.copy}</p>
      </article>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Ensure proof card language avoids generic card-grid slop**

Keep the three proof items because they are a compact framework, but avoid adding icons, decorative gradients, or identical marketing feature cards. The cards should remain text-led and precise.

- [ ] **Step 3: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 4: Add Concrete Trust Mechanics

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Insert a trust mechanics section after the proof section**

In `apps/landing/src/pages/index.astro`, insert this section immediately after the proof section:

```astro
<section class="trust" aria-labelledby="trust-title">
  <div class="section-heading">
    <p class="kicker">Trust before invocation</p>
    <h2 id="trust-title">Trust is visible before the call.</h2>
  </div>
  <div class="trust-grid">
    {trustMechanics.map((item) => (
      <article class="trust-item">
        <span class="agent-setup-label">{item.label}</span>
        <code>{item.value}</code>
        <p>{item.copy}</p>
      </article>
    ))}
  </div>
  <div class="trust-error" role="note" aria-label="Safe error example">
    <span class="agent-setup-label">Safe recovery example</span>
    <p>
      If a backend fails, Caplets keeps the error scoped to the capability, preserves useful
      recovery detail, and redacts sensitive configuration before it reaches the agent.
    </p>
  </div>
</section>
```

- [ ] **Step 2: Add trust section CSS**

Add this CSS near the proof and integrations styles:

```css
.trust {
  width: var(--content);
  margin-inline: auto;
}

.trust-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.trust-item,
.trust-error {
  min-width: 0;
  border: 1px solid var(--ash);
  border-radius: 22px;
  background: var(--paper);
  padding: 18px;
}

.trust-item code {
  display: block;
  margin: 10px 0 12px;
  color: var(--charred-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.trust-item p,
.trust-error p {
  margin: 0;
  color: var(--olive);
}

.trust-error {
  margin-top: 12px;
  background: var(--linen);
}
```

- [ ] **Step 3: Update `main` spacing if needed**

If the new trust section feels too disconnected, reduce the global section gap from:

```css
gap: clamp(74px, 10vw, 142px);
```

to:

```css
gap: clamp(64px, 8vw, 118px);
```

Use the smaller gap only if visual review shows excessive whitespace between proof and trust.

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 5: Add Copy Buttons and Safer Snippet Semantics

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Add copy buttons to integration snippets**

In the integration panel markup, replace each current snippet block:

```astro
<div>
  <span class="agent-setup-label">Install</span>
  <pre><code>{agent.installCommand}</code></pre>
</div>
<div>
  <span class="agent-setup-label">Configuration</span>
  <pre><code>{agent.configSnippet}</code></pre>
</div>
```

with:

```astro
<div class="snippet-block">
  <div class="snippet-heading">
    <span class="agent-setup-label">Install</span>
    <button class="copy-button" type="button" data-copy-value={agent.installCommand}>Copy</button>
  </div>
  <pre><code>{agent.installCommand}</code></pre>
</div>
<div class="snippet-block">
  <div class="snippet-heading">
    <span class="agent-setup-label">Configuration</span>
    <button class="copy-button" type="button" data-copy-value={agent.configSnippet}>Copy</button>
  </div>
  <pre><code>{agent.configSnippet}</code></pre>
</div>
```

- [ ] **Step 2: Add copy buttons to terminal install steps**

Replace terminal list item markup:

```astro
<li><code>{step}</code></li>
```

with:

```astro
<li>
  <code>{step}</code>
  <button class="copy-button terminal-copy" type="button" data-copy-value={step}>Copy</button>
</li>
```

- [ ] **Step 3: Add copy button script**

Inside the existing `<script>` block, after tab setup constants, add:

```ts
const copyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy-value]"));

async function copyValue(button: HTMLButtonElement) {
  const value = button.dataset.copyValue;
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
    button.setAttribute("data-copied", "true");
    window.setTimeout(() => {
      button.textContent = "Copy";
      button.removeAttribute("data-copied");
    }, 1600);
  } catch {
    button.textContent = "Select text";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 2200);
  }
}

for (const button of copyButtons) {
  button.addEventListener("click", () => void copyValue(button));
}
```

- [ ] **Step 4: Add copy button CSS**

Add:

```css
.snippet-block {
  min-width: 0;
}

.snippet-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.snippet-heading .agent-setup-label {
  margin-bottom: 0;
}

.copy-button {
  min-height: 32px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  padding: 0 10px;
  font: inherit;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 780;
  cursor: pointer;
  transition:
    background-color 160ms var(--ease-out),
    color 160ms var(--ease-out),
    transform 160ms var(--ease-out);
}

.copy-button:hover,
.copy-button[data-copied="true"] {
  background: var(--parchment);
  color: var(--night-ink);
  transform: translateY(-1px);
}

.terminal li {
  align-items: center;
  grid-template-columns: 46px minmax(0, 1fr) auto;
}

.terminal-copy {
  color: var(--night-muted);
}
```

- [ ] **Step 5: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 6: Make Integration Tabs No-JS Accessible

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Stop hiding integration panels in initial HTML**

In the integration panel markup, remove the `hidden={index !== 0}` attribute from each `.agent-setup-panel`.

- [ ] **Step 2: Add an enhancement class before hiding panels with JavaScript**

At the start of the existing `<script>` block, add:

```ts
document.documentElement.classList.add("js-enabled");
```

Keep the existing call to `selectAgentTab(agentTabs[0].dataset.agentTab ?? "")`; it will hide inactive panels after JavaScript loads.

- [ ] **Step 3: Scope hidden tab styling to enhanced mode**

Keep the existing CSS rule:

```css
.agent-setup-panel[hidden] {
  display: none;
}
```

No extra rule is needed for no-JS because panels will no longer ship with `hidden`. Confirm no-JS displays all panels stacked in source order.

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 7: Delete Major Motion Systems and Calm the Visual Language

**Files:**

- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Remove scroll and pointer animation script code**

In the `<script>` block, delete variables and functions used only by the old hero motion system:

```ts
const hero = document.querySelector(".hero") as HTMLElement | null;
const mapStage = document.querySelector(".map-stage") as HTMLElement | null;
const canAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function clamp(value: number, min: number, max: number) { ... }

let heroProgressFrame = 0;
let mapStageRect = mapStage?.getBoundingClientRect();
let pointerFrame = 0;
let pendingPointer: PointerEvent | undefined;

function refreshMapStageRect() { ... }
function updateHeroProgress() { ... }
function scheduleHeroProgressUpdate() { ... }

if (canAnimate && hero && mapStage) { ... }
```

Replace it with a smaller reveal setup:

```ts
const canAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canAnimate) {
  const revealTargets = document.querySelectorAll<HTMLElement>(
    ".problem, .proof, .trust, .integrations, .install, .proof-item, .trust-item, .trust-error, .agent-setup-panel, .terminal li",
  );

  if (!("IntersectionObserver" in window)) {
    revealTargets.forEach((target) => target.classList.add("is-visible"));
  } else {
    document.documentElement.classList.add("motion-ready");
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );

    revealTargets.forEach((target, index) => {
      target.style.setProperty("--reveal-index", String(index % 3));
      revealObserver.observe(target);
    });
  }
}
```

- [ ] **Step 2: Remove route progress CSS dependencies**

Delete uses of these variables where they only exist for old route motion:

```css
--scroll-progress
--route-resolve
--pointer-x
--pointer-y
```

Delete these old motion-coupled rules entirely:

```css
.problem {
  margin-top: calc(var(--route-resolve) * -34px);
  transition: margin-top 120ms linear;
}

.problem .section-heading { ... }

.dense-list { ... }

.ordered-flow { ... }
```

Then keep static versions:

```css
.problem .section-heading {
  opacity: 1;
}

.dense-list,
.ordered-flow {
  transform: none;
}
```

- [ ] **Step 3: Calm global decorative backgrounds**

Keep the warm linen grid, but reduce glow intensity by changing:

```css
--page-warmth: oklch(91% 0.05 42 / 0.8);
```

to:

```css
--page-warmth: oklch(91% 0.035 42 / 0.52);
```

Remove `backdrop-filter: blur(16px);` from `.site-header` unless visual review shows it is needed for readability over the page background.

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 8: Responsive Pass for Trace, Trust, and Snippets

**Files:**

- Modify: `apps/landing/src/styles/global.css`

- [ ] **Step 1: Replace old mobile map rules**

In the `@media (max-width: 980px)` block, delete any `.map-stage` rules. Add:

```css
.trace-stage {
  max-width: 100%;
}

.trust-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
```

- [ ] **Step 2: Add phone trace and trust rules**

In the `@media (max-width: 720px)` block, delete old map-specific rules for `.map-stage`, `.capability-grid`, `.capability-card`, `.route-field`, and `.inspect-panel`. Add:

```css
.trace-stage {
  border-radius: 22px;
}

.trace-metadata,
.trace-steps li,
.trust-grid {
  grid-template-columns: 1fr;
}

.trace-steps li {
  gap: 12px;
}

.trace-steps code {
  width: 100%;
}

.trust-item,
.trust-error {
  border-radius: 18px;
}

.terminal li {
  grid-template-columns: 38px minmax(0, 1fr);
}

.terminal-copy {
  grid-column: 2;
  justify-self: start;
}
```

- [ ] **Step 3: Check touch target sizes**

Confirm `.copy-button`, `.button`, `.integration-pill`, `.top-nav a`, and `.header-action` have practical hit targets. If `.copy-button` at 32px feels too small on mobile, add inside the phone media query:

```css
.copy-button {
  min-height: 40px;
  padding-inline: 12px;
}
```

- [ ] **Step 4: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 9: Add Docs and Config Links if They Exist

**Files:**

- Modify: `apps/landing/src/pages/index.astro`

- [ ] **Step 1: Inspect available docs routes or README anchors**

Run:

```bash
find docs apps/landing/src -maxdepth 3 -type f | sort | grep -E '(README|docs|config|usage|getting|index)'
```

Expected: identify whether there is a stable public docs URL or only GitHub README/docs files.

- [ ] **Step 2: Add a docs link only if stable**

If there is a stable docs route or GitHub docs path, add a third header or footer link with concrete text such as `Config docs`. Do not invent a broken public URL.

Acceptable example if the GitHub docs path exists:

```astro
<a href="https://github.com/spiritledsoftware/caplets/tree/main/docs">Docs</a>
```

If no stable docs link exists, skip this step and record that the repo link remains the docs path for now.

- [ ] **Step 3: Run focused checks**

Run:

```bash
pnpm --filter @caplets/landing typecheck
pnpm --filter @caplets/landing build
```

Expected: both PASS.

## Task 10: Final Verification and Critique Recheck

**Files:**

- Verify only unless fixes are needed.

- [ ] **Step 1: Format check**

Run:

```bash
pnpm format:check
```

Expected: PASS. If it fails only on modified files, run `pnpm format` and review the diff.

- [ ] **Step 2: Lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Landing build**

Run:

```bash
pnpm --filter @caplets/landing build
```

Expected: PASS.

- [ ] **Step 5: Detector recheck**

Run:

```bash
npx impeccable --json apps/landing/src/pages/index.astro
```

Expected: `[]` or clearly explainable findings. Any true findings must be fixed before completion.

- [ ] **Step 6: Manual source review checklist**

Review the final diff and confirm:

- Hero leads with “Skillify your backends.”
- Hero defines skillify clearly.
- Hero trace uses GitHub and shows source, status, auth redaction, progressive steps, schema inspection, and preserved result.
- “Capability card” language is dominant over “map.”
- Trust mechanics are concrete, not vague claims.
- Install command inconsistency is resolved.
- Commands and snippets have copy buttons.
- Integration content is accessible without JavaScript.
- Pointer tilt, scroll route resolution, route drift, heavy route glow, and old cartography are removed.
- Reduced-motion support remains.
- No new copy contains em dashes.

- [ ] **Step 7: Full verification if time allows**

Run:

```bash
pnpm verify
```

Expected: PASS. If this is too broad for the implementation session, record focused checks that passed and any unrelated failures separately.

## Self-Review

### Spec Coverage

- Trust-first objective: covered by Tasks 2, 4, and 10.
- Skillify coined term: covered by Tasks 2 and 3.
- Capability cards dominant, map demoted: covered by Tasks 2 and 7.
- Realistic GitHub trace: covered by Task 2.
- Trust mechanics and safe recovery: covered by Task 4.
- Copy buttons: covered by Task 5.
- No-JS integration fallback: covered by Task 6.
- Motion removal: covered by Task 7.
- Responsive fixes: covered by Task 8.
- Install consistency: covered by Task 1.
- Docs/config links: covered by Task 9.
- Verification: covered by Task 10.

### Placeholder Scan

This plan intentionally avoids placeholder instructions. Where conditional behavior exists, such as docs link discovery, it specifies exact commands and acceptable outcomes.

### Type Consistency

New constants are `heroTrace`, `skillifyFramework`, and `trustMechanics`. Markup references those exact names. Copy button data uses `data-copy-value`, and script queries `[data-copy-value]`.
