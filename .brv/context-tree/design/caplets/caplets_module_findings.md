---
title: Caplets Module Findings
summary: Extracted and organized factual statements about the caplets module
tags: []
related: []
keywords: []
createdAt: '2026-05-28T16:45:38.837Z'
updatedAt: '2026-05-28T16:45:38.837Z'
---
## Reason
Curate extracted facts from caplets module context

## Raw Concept
**Task:**
Document caplets module findings

**Timestamp:** 2026-05-28T16:45:38.834Z

## Narrative
### Structure
Aggregated facts from caplets module extraction

### Highlights
PRODUCT.md, DESIGN.md, context loader, IMPECCABLE_CONTEXT_DIR, load-context.mjs, loader output, loader execution, context reload, live.mjs, craft task, design register, register identification, register inference, reference files, shared design laws, color model, hex colors, neutral tinting, design strategy, theme choice, line length, hierarchy, spacing, cards usage, nested cards, containers, animation, easing, side-stripe borders, gradient text, glassmorphism, hero-metric template, identical card grids, modal usage, copy, punctuation, failures, Category-reflex check, First-order reflex, Second-order reflex, `craft` command, `shape` command, `teach` command, `document` command, `extract` command, `critique` command, `audit` command, `polish` command, `bolder` command, `quieter` command, `distill` command, `harden` command, `onboard` command, `animate` command, `colorize` command, `typeset` command, `layout` command, `delight` command, `overdrive` command, `clarify` command, `adapt` command, `optimize` command, `live` command, management commands, Pin command, Unpin command, pin.mjs script, landing page update, index.astro, proof data, build process, pnpm format:check, pnpm typecheck, pnpm build, pnpm verify

## Facts
- **PRODUCT.md**: PRODUCT.md is required and contains users, brand, tone, anti-references, and strategic principles.
- **DESIGN.md**: DESIGN.md is optional but strongly recommended and includes colors, typography, elevation, and components.
- **context loader**: The loader looks at the project root by default and falls back to .agents/context/ and docs/ if the root is clean.
- **IMPECCABLE_CONTEXT_DIR**: The context directory can be overridden with IMPECCABLE_CONTEXT_DIR=path/to/dir (absolute or relative to cwd).
- **load-context.mjs**: Both PRODUCT.md and DESIGN.md can be loaded in one call using node {{scripts_path}}/load-context.mjs.
- **loader output**: The output of the loader must not be piped through head, tail, grep, or jq.
- **loader execution**: If the loader output is already present in the session history, it should not be re-run.
- **context reload**: A fresh load is required after running {{command_prefix}}impeccable teach, {{command_prefix}}impeccable document, or when the user manually edits a file.
- **live.mjs**: If {{command_prefix}}impeccable live has been run, do not also run load-context.mjs in the same session.
- **PRODUCT.md**: If PRODUCT.md is missing, empty, or contains only placeholder [TODO] markers (<200 characters), run {{command_prefix}}impeccable teach and then resume the original task with fresh context.
- **craft task**: If the original task was {{command_prefix}}impeccable craft, resume into {{command_prefix}}impeccable shape before any implementation work after teaching.
- **DESIGN.md**: If DESIGN.md is missing, prompt the user once per session to run {{command_prefix}}impeccable document for more on‑brand output, then continue.
- **design register**: Every design task is classified as either brand (marketing, landing, campaign, long‑form content, portfolio) or product (app UI, admin, dashboard, tool).
- **register identification**: Design registration should be identified before designing, using priority: task cue, surface in focus, then register field in PRODUCT.md.
- **register inference**: If PRODUCT.md lacks a register field, infer it from the Users and Product Purpose sections, cache it for the session, and suggest running {{command_prefix}}impeccable teach to add the field explicitly.
- **reference files**: Load the matching reference file: reference/brand.md for brand tasks or reference/product.md for product tasks.
- **shared design laws**: Shared design laws apply to all designs; match implementation complexity to aesthetic vision—maximalism requires elaborate code, minimalism requires precision.
- **color model**: Use OKLCH.
- **hex colors**: Never use #000 or #fff.
- **neutral tinting**: Tint every neutral toward the brand hue (chroma 0.005–0.01 is enough).
- **design strategy**: Restrained: tinted neutrals + one accent ≤10%.
- **design strategy**: Committed: one saturated color carries 30–60% of the surface.
- **design strategy**: Full palette: 3–4 named roles, each used deliberately.
- **design strategy**: Drenched: the surface IS the color.
- **theme choice**: Dark vs. light is never a default.
- **line length**: Cap body line length at 65–75ch.
- **hierarchy**: Hierarchy through scale + weight contrast (≥1.25 ratio between steps).
- **spacing**: Vary spacing for rhythm.
- **cards usage**: Cards are the lazy answer. Use them only when they're truly the best affordance.
- **nested cards**: Nested cards are always wrong.
- **containers**: Don't wrap everything in a container.
- **animation**: Don't animate CSS layout properties.
- **easing**: Ease out with exponential curves (ease-out-quart / quint / expo). No bounce, no elastic.
- **side-stripe borders**: Side-stripe borders greater than 1px as a colored accent are never intentional.
- **gradient text**: Gradient text using background-clip: text combined with a gradient background is decorative, never meaningful.
- **glassmorphism**: Glassmorphism as default is banned.
- **hero-metric template**: The hero-metric template is a SaaS cliché.
- **identical card grids**: Identical card grids are banned.
- **modal usage**: Modal as first thought is usually laziness.
- **copy**: Every word earns its place.
- **punctuation**: No em dashes; use commas, colons, semicolons, periods, or parentheses.
- **failures**: Register-specific failures live in each reference.
- **Category-reflex check**: Category-reflex check runs at two altitudes; the second one catches what the first one misses.
- **First-order reflex**: First-order reflex occurs if someone could guess the theme and palette from the category alone.
- **Second-order reflex**: Second-order reflex occurs if someone could guess the aesthetic family from category-plus-anti-references.
- **`craft` command**: `craft [feature]` shapes and builds a feature end-to-end.
- **`shape` command**: `shape [feature]` plans UX/UI before writing code.
- **`teach` command**: `teach` sets up PRODUCT.md and DESIGN.md context.
- **`document` command**: `document` generates DESIGN.md from existing project code.
- **`extract` command**: `extract [target]` pulls reusable tokens and components into design system.
- **`critique` command**: `critique [target]` performs UX design review with heuristic scoring.
- **`audit` command**: `audit [target]` conducts technical quality checks such as accessibility, performance, and responsiveness.
- **`polish` command**: `polish [target]` provides a final quality pass before shipping.
- **`bolder` command**: `bolder [target]` amplifies safe or bland designs.
- **`quieter` command**: `quieter [target]` tones down aggressive or overstimulating designs.
- **`distill` command**: `distill [target]` strips to essence and removes complexity.
- **`harden` command**: `harden [target]` makes designs production-ready, handling errors, i18n, and edge cases.
- **`onboard` command**: `onboard [target]` designs first-run flows, empty states, and activation.
- **`animate` command**: `animate [target]` adds purposeful animations and motion.
- **`colorize` command**: `colorize [target]` adds strategic color to monochromatic UIs.
- **`typeset` command**: `typeset [target]` improves typography hierarchy and fonts.
- **`layout` command**: `layout [target]` fixes spacing, rhythm, and visual hierarchy.
- **`delight` command**: `delight [target]` adds personality and memorable touches.
- **`overdrive` command**: `overdrive [target]` pushes past conventional limits.
- **`clarify` command**: `clarify [target]` improves UX copy, labels, and error messages.
- **`adapt` command**: `adapt [target]` adapts designs for different devices and screen sizes.
- **`optimize` command**: `optimize [target]` diagnoses and fixes UI performance issues.
- **`live` command**: `live` enables visual variant mode to pick elements in the browser and generate alternatives.
- **management commands**: Two management commands are `pin <command>` and `unpin <command>`.
- **Pin command**: Pin creates a standalone shortcut so `{{command_prefix}}<command>` invokes `{{command_prefix}}impeccable <command>` directly.
- **Unpin command**: Unpin removes the shortcut created by Pin.
- **pin.mjs script**: The script writes to every harness directory present in the project.
- **landing page update**: Clarified `apps/landing/` copy and pushed it to PR #93.
- **index.astro**: Replaced remaining “backend” phrasing with clearer “tool source” language in `apps/landing/src/pages/index.astro`.
- **proof data**: Renamed the proof data from `skillifyFramework` to `capabilityFramework`.
- **build process**: Verification commands `pnpm format:check`, `pnpm typecheck`, `pnpm build`, and `pnpm verify` all passed.
- **pnpm format:check**: `pnpm format:check -- apps/landing/src/pages/index.astro` passed
- **pnpm typecheck**: `pnpm --filter @caplets/landing typecheck` passed
- **pnpm build**: `pnpm --filter @caplets/landing build` passed
- **pnpm verify**: `pnpm verify` passed
