# Landing page proof-led activation design

## Goal

Revise the Caplets landing page so it matches the product promise: reveal one clear capability story first, then provide deeper evidence and setup details only when useful. The page should drive agent power users and MCP server builders toward installing the right agent plugin, integration, or MCP client setup with Context7 as the first capability source. Preserve the campaign headline: “Caplets: Give your agents capabilities, not giant tool walls”.

## Current problems to fix

1. The page explains progressive disclosure but currently presents many equal-weight sections, cards, tabs, trust details, and install steps.
2. The activation path appears too late for power users who want proof quickly.
3. Numbered nav markers, repeated eyebrow labels, wide shadows, and repeated bordered card patterns create AI-generated landing-page residue.
4. The install path overemphasizes manually running `caplets serve`. The primary activation path should be agent-native: plugin install, integration setup, or MCP client configuration.
5. The hero trace is conceptually strong but visually too close to a polished SaaS card.

## Proposed direction

Use a proof-led activation structure:

1. Hero claim and flattened trace artifact.
2. Compact benchmark proof strip immediately after hero.
3. “Add Caplets to your agent” activation section near the top, using Context7 as the first source.
4. Compressed explanation of problem, capability model, and safety mechanics.
5. Detailed integrations as a supporting section after the primary activation path.

This keeps the page focused on the launch campaign and avoids a full visual reset.

## Detailed design

### 1. Hero

- Keep the primary headline: “Give your agents capabilities, not giant tool walls.”
- Keep the current progressive disclosure trace because it explains the product better than a decorative illustration.
- Remove numbered top navigation markers. Nav labels should be plain section names such as “Trace”, “Proof”, and “Install”.
- Reduce the trace artifact’s wide shadow and overly rounded card feel. It should read as a technical artifact: flatter, sharper, and more inspectable.
- Keep the primary CTA focused on adding Caplets to the user's agent, not on manually running the server. The page must surface a fast Context7 trial path near the top.

### 2. Benchmark proof strip

- Move deterministic proof close to the hero.
- Show the three proof facts compactly:
  - 106 flat tools
  - 3 capability cards
  - 87.8% smaller initial payload
- Link the proof strip to `docs/benchmarks/coding-agent.md` or an equivalent public benchmark URL if available in the site routing.
- Avoid the hero-metric template. The proof should feel like a benchmark note or evidence row, not a celebratory stats block.

### 3. Agent-native Context7 activation section

- Place the activation section before the long explanatory material.
- Lead with agent-native setup choices, not a manual `caplets serve` workflow.
- Recommended primary paths:
  - Claude Code: install the Caplets plugin from the marketplace.
  - Codex: add the Caplets plugin marketplace and install the plugin.
  - OpenCode: install `caplets` and use the native `@caplets/opencode` plugin.
  - Pi: install `caplets` and add `npm:@caplets/pi`.
  - Any MCP client: configure the client to launch `caplets serve` as its MCP server command.
- Use Context7 as the first capability source after the agent integration is in place:
  - `caplets init`
  - `caplets add mcp context7 --command npx --arg -y --arg @upstash/context7-mcp`
- Show expected result inside the agent:
  - The agent starts with a `context7` capability.
  - The next path is `get_caplet`, `search_tools`, `get_tool`, `call_tool`.
- Add a concise troubleshooting line for common activation blockers: Node version, `npx`, plugin installation, and MCP client configuration.
- Preserve copy buttons and keyboard accessibility.

### 4. Compressed explanation

Replace the current repeated middle sections with a tighter explanation. It should cover:

- Flat tool walls force agents to choose before they understand.
- Caplets exposes one capability first, then scoped search and schema inspection.
- Trust is visible before invocation through source, auth state, timeout boundary, and safe error recovery.

The section should not become another identical card grid. Prefer a single structured comparison, a compact checklist, or a source-manifest style artifact.

### 5. Integrations

- Keep integration tabs because they are now part of the primary activation story: where can Caplets run, and what should the user install for their agent?
- Surface the most common integrations near the activation path. The full tabbed setup can remain lower on the page as the expanded reference.
- For MCP clients, present `caplets serve` as the configured command the client launches, not as the main thing the user runs manually.
- Preserve tab semantics, keyboard navigation, copy buttons, and mobile behavior.

## Copy and visual constraints

- No em dashes in prose.
- Avoid `--` in visible body copy except command-line flags inside code.
- No gradient text.
- No side-stripe card accents.
- No glassmorphism.
- Avoid hero-metric styling.
- Avoid repeated numbered section markers.
- Reduce repeated eyebrow cadence. Use labels sparingly where they add orientation.
- Preserve existing OKLCH token system and brand colors unless a local contrast fix is required.
- Keep display heading letter spacing at or above `-0.04em`.
- Keep body copy line length under roughly 75ch.

## Accessibility and interaction requirements

- No horizontal overflow at desktop or mobile widths.
- All buttons and links must remain keyboard reachable.
- Tab controls must retain `role="tablist"`, `role="tab"`, `role="tabpanel"`, selected state, and arrow-key behavior.
- Copy buttons must preserve success feedback and fallback text selection behavior.
- Reveal motion must preserve visible defaults and support `prefers-reduced-motion: reduce`.
- Mobile touch targets should remain at least 44px high.

## Verification plan

Run these checks before claiming completion:

1. Browser inspection on the user dev server at desktop and mobile widths.
2. Confirm no horizontal overflow.
3. Confirm no browser console errors or warnings.
4. Run the campaign copy assertion or equivalent source assertion for the key headline, proof facts, agent integration activation paths, and Context7 source setup.
5. Run `pnpm --filter @caplets/landing typecheck`.
6. Run `pnpm --filter @caplets/landing build`.
7. Run `git diff --check`.

## Out of scope

- Changing package manager versions.
- Modifying unrelated `.brv/` memory files.
- Rebuilding the entire brand identity.
- Adding new dependencies unless the implementation cannot meet the design without them.
