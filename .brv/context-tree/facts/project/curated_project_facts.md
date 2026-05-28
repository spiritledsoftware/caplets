---
title: Curated Project Facts
summary: Aggregated project-related facts extracted via RLM extraction
tags: []
related: []
keywords: []
createdAt: '2026-05-27T18:17:41.215Z'
updatedAt: '2026-05-27T18:17:41.215Z'
---
## Reason
Extracted factual statements from recent context

## Raw Concept
**Task:**
Curate extracted project facts

**Timestamp:** 2026-05-27T18:17:41.212Z

## Narrative
### Highlights
Extracted 74 unique facts across 72 subjects.

## Facts
- **PRODUCT.md**: PRODUCT.md is required.
- **DESIGN.md**: DESIGN.md is optional, strongly recommended.
- **loader**: The loader looks at the project root by default and falls back to .agents/context/ and docs/ if the root is clean.
- **IMPECCABLE_CONTEXT_DIR**: Override with IMPECCABLE_CONTEXT_DIR=path/to/dir (absolute or relative to cwd).
- **load-context.mjs**: Load both files in one call using: node {{scripts_path}}/load-context.mjs
- **loader output**: Never pipe the loader output through head, tail, grep, or jq.
- **PRODUCT.md**: If PRODUCT.md is missing, empty, or contains placeholder [TODO] markers with less than 200 characters, run {{command_prefix}}impeccable teach and then resume the original task.
- **DESIGN.md**: If DESIGN.md is missing, prompt the user once per session to run {{command_prefix}}impeccable document, then proceed.
- **design task**: Every design task is either brand (marketing, landing, campaign, long-form content, portfolio) or product (app UI, admin, dashboard, tool).
- **register identification**: Identify the register before designing, using priority: (1) cue in the task itself, (2) the surface in focus, (3) the register field in PRODUCT.md.
- **Color system**: Use OKLCH for color definitions.
- **Chroma adjustment**: Reduce chroma as lightness approaches 0 or 100 because high chroma at extremes looks garish.
- **Neutral tinting**: Never use #000 or #fff; tint every neutral toward the brand hue with chroma 0.005–0.01.
- **Restrained strategy**: Restrained color strategy uses tinted neutrals plus one accent ≤10% of surface.
- **Committed strategy**: Committed color strategy uses one saturated color for 30–60% of surface.
- **Full palette**: Full palette strategy uses 3–4 named color roles deliberately.
- **Drenched strategy**: Drenched strategy makes the surface itself the color.
- **Theme selection**: Dark vs. light theme should not be chosen by default; it must be justified by physical context.
- **Line length**: Cap body line length at 65–75 characters.
- **Hierarchy**: Maintain a hierarchy through scale and weight contrast with at least a 1.25 ratio between steps.
- **Spacing**: Vary spacing to create rhythm; avoid using the same padding everywhere.
- **Card usage**: Cards should only be used when they are the best affordance; nested cards are always wrong.
- **Animation**: Do not animate CSS layout properties.
- **Easing**: Use ease-out exponential curves (ease-out-quart, quint, expo) for motion; avoid bounce or elastic easing.
- **Side-stripe borders**: Side-stripe borders greater than 1px as colored accents are prohibited; use full borders, background tints, leading numbers/icons, or nothing instead.
- **Gradient text**: Gradient text using background-clip: text with a gradient background is prohibited; use a single solid color instead.
- **Glassmorphism**: Glassmorphism as a default style is prohibited; use blurs and glass cards only rarely and purposefully.
- **Hero-metric template**: The hero-metric template (big number, small label, supporting stats, gradient accent) is prohibited as a SaaS cliché.
- **Identical card grids**: Identical card grids with the same-sized cards repeated endlessly are prohibited.
- **Modals**: Modals should not be the first design thought; explore inline or progressive alternatives first.
- **Copy economy**: Every word in copy must earn its place; avoid restated headings and intros that repeat the title.
- **Punctuation**: Do not use em dashes; use commas, colons, semicolons, periods, or parentheses instead.
- **craft**: `craft [feature]` shapes then builds a feature end-to-end.
- **shape**: `shape [feature]` plans UX/UI before writing code.
- **teach**: `teach` sets up PRODUCT.md and DESIGN.md context.
- **document**: `document` generates DESIGN.md from existing project code.
- **extract**: `extract [target]` pulls reusable tokens and components into the design system.
- **critique**: `critique [target]` performs a UX design review with heuristic scoring.
- **audit**: `audit [target]` conducts technical quality checks for accessibility, performance, and responsiveness.
- **polish**: `polish [target]` provides a final quality pass before shipping.
- **bolder**: `bolder [target]` amplifies safe or bland designs.
- **quieter**: `quieter [target]` tones down aggressive or overstimulating designs.
- **distill**: `distill [target]` strips to essence and removes complexity.
- **harden**: `harden [target]` makes a product production‑ready by handling errors, i18n, and edge cases.
- **onboard**: `onboard [target]` designs first‑run flows, empty states, and activation experiences.
- **animate**: `animate [target]` adds purposeful animations and motion.
- **colorize**: `colorize [target]` adds strategic color to monochromatic UIs.
- **typeset**: `typeset [target]` improves typography hierarchy and fonts.
- **layout**: `layout [target]` fixes spacing, rhythm, and visual hierarchy.
- **delight**: `delight [target]` adds personality and memorable touches.
- **overdrive**: `overdrive [target]` pushes past conventional limits.
- **clarify**: `clarify [target]` improves UX copy, labels, and error messages.
- **adapt**: `adapt [target]` adapts designs for different devices and screen sizes.
- **optimize**: `optimize [target]` diagnoses and fixes UI performance issues.
- **live**: `live` enables visual variant mode to pick elements in the browser and generate alternatives.
- **pin**: `pin <command>` pins a command for quick access.
- **unpin**: `unpin <command>` unpins a previously pinned command.
- **Pin**: Pin creates a standalone shortcut so {{command_prefix}}<command> invokes {{command_prefix}}impeccable <command> directly.
- **Unpin**: Unpin removes the shortcut created by Pin.
- **Pin/Unpin script**: The script writes to every harness directory present in the project.
- **pin.mjs**: The command node {{scripts_path}}/pin.mjs <pin|unpin> <command> is used to pin or unpin commands.
- **Command argument**: Valid <command> is any command from the table above.
- **Visual design system**: Generated the visual design system.
- **Repository**: Changed files: DESIGN.md and .impeccable/design.json.
- **North star**: North star is "The Tool Cartographer".
- **Palette**: Palette includes charred ink, parchment, and rare ember accent.
- **Elevation**: Elevation is tonal layering, flat at rest.
- **Components**: Components are tactile, calm, compact product primitives.
- **Sidecar**: Sidecar includes renderable button, chip, card, input, and nav snippets for the live panel.
- **.impeccable/design.json**: .impeccable/design.json parses as valid JSON.
- **Impeccable context**: Refreshed impeccable context with the new DESIGN.md.
- **r**: r includes renderable button, chip, card, input, and nav snippets for the live panel
- **`.impeccable/design.json`**: `.impeccable/design.json` parses as valid JSON
- **impeccable context**: Refreshed impeccable context with the new `DESIGN.md`
