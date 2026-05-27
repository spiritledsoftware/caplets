---
title: extracted_facts
summary: Extracted factual statements from provided context
tags: []
related: []
keywords: []
createdAt: '2026-05-27T18:12:54.989Z'
updatedAt: '2026-05-27T18:12:54.989Z'
---
## Reason
Curate extracted factual statements from context

## Raw Concept
**Task:**
Extract factual statements

## Narrative
### Structure
Facts extracted from context

### Highlights
The loader looks at the project root by default and falls back to `.agents/context/` and `docs/` if the root is clean.; `PRODUCT.md` is required.; `DESIGN.md` is optional, strongly recommended.; If PRODUCT.md is missing, empty, or placeholder (`[TODO]` markers, <200 chars): run `{{command_prefix}}impeccable teach`.; If DESIGN.md is missing: nudge once per session.; Every design task is **brand** (marketing, landing, campaign, long-form content, portfolio) or **product** (app UI, admin, dashboard, tool).; Priority for register identification: (1) cue in the task itself, (2) the surface in focus, (3) `register` field in PRODUCT.md.; If PRODUCT.md lacks the `register` field (legacy), infer it once from its "Users" and "Product Purpose" sections, then cache the inferred value for the session.; Use OKLCH for colors.; Never use #000 or #fff; tint every neutral toward the brand hue.; The "one accent ≤10%" rule applies only to the Restrained strategy.; Dark vs. light themes are never a default; choose based on physical context.; Cap body line length at 65–75 characters.; Maintain a hierarchy through scale and weight contrast with at least a 1.25 ratio between steps.; Vary spacing for rhythm; same padding everywhere creates monotony.; Cards should only be used when they are truly the best affordance; nested cards are always wrong.; Do not animate CSS layout properties.; Use ease-out exponential curves (ease-out-quart, quint, expo) for motion; avoid bounce or elastic easing.; Side‑stripe borders greater than 1 px as colored accents are prohibited.; Gradient text using background‑clip: text with a gradient background is prohibited.; Glassmorphism as a default style is prohibited; use only rarely and purposefully.; The hero‑metric template (big number, small label, supporting stats, gradient accent) is prohibited as a SaaS cliché.; Identical card grids with repeated icon + heading + text are prohibited.; Modals should not be the first design choice; consider inline or progressive alternatives first.; Every word in copy must earn its place; avoid restated headings and intros that repeat the title.; Em dashes are prohibited; use commas, colons, semicolons, periods, or parentheses instead.; `craft [feature]` is a Build command that shapes then builds a feature end-to-end.; `shape [feature]` is a Build command that plans UX/UI before writing code.; `teach` is a Build command that sets up PRODUCT.md and DESIGN.md context.; `document` is a Build command that generates DESIGN.md from existing project code.; `extract [target]` is a Build command that pulls reusable tokens and components into a design system.; `critique [target]` is an Evaluate command that performs a UX design review with heuristic scoring.; `audit [target]` is an Evaluate command that conducts technical quality checks such as accessibility, performance, and responsiveness.; `polish [target]` is a Refine command that provides a final quality pass before shipping.; `bolder [target]` is a Refine command that amplifies safe or bland designs.; `quieter [target]` is a Refine command that tones down aggressive or overstimulating designs.; `distill [target]` is a Refine command that strips to essence and removes complexity.; `harden [target]` is a Refine command that makes a product production‑ready, handling errors, i18n, and edge cases.; `onboard [target]` is a Refine command that designs first‑run flows, empty states, and activation experiences.; `animate [target]` is an Enhance command that adds purposeful animations and motion.; `colorize [target]` is an Enhance command that adds strategic color to monochromatic UIs.; `typeset [target]` is an Enhance command that improves typography hierarchy and fonts.; `layout [target]` is an Enhance command that fixes spacing, rhythm, and visual hierarchy.; `delight [target]` is an Enhance command that adds personality and memorable touches.; `overdrive [target]` is an Enhance command that pushes past conventional limits.; `clarify [target]` is a Fix command that improves UX copy, labels, and error messages.; `adapt [target]` is a Fix command that adapts designs for different devices and screen sizes.; `optimize [target]` is a Fix command that diagnoses and fixes UI performance issues.; `live` is an Iterate command that provides a visual variant mode for picking elements in the browser and generating alternatives.; `pin <command>` and `unpin <command>` are management commands for pinning and unpinning other commands.; Pin creates a standalone shortcut so `{{command_prefix}}<command>` invokes `{{command_prefix}}impeccable <command>` directly.; Unpin removes the standalone shortcut created by Pin.; The script `node {{scripts_path}}/pin.mjs <pin|unpin> <command>` writes to every harness directory present in the project.; Valid `<command>` is any command from the table above.; Report the script's result concisely.; Confirm the new shortcut on success, relay stderr verbatim on error.

## Facts
- **loader behavior**: The loader looks at the project root by default and falls back to `.agents/context/` and `docs/` if the root is clean.
- **PRODUCT.md**: `PRODUCT.md` is required.
- **DESIGN.md**: `DESIGN.md` is optional, strongly recommended.
- **missing PRODUCT.md**: If PRODUCT.md is missing, empty, or placeholder (`[TODO]` markers, <200 chars): run `{{command_prefix}}impeccable teach`.
- **missing DESIGN.md**: If DESIGN.md is missing: nudge once per session.
- **design task type**: Every design task is **brand** (marketing, landing, campaign, long-form content, portfolio) or **product** (app UI, admin, dashboard, tool).
- **register priority**: Priority for register identification: (1) cue in the task itself, (2) the surface in focus, (3) `register` field in PRODUCT.md.
- **missing register field**: If PRODUCT.md lacks the `register` field (legacy), infer it once from its "Users" and "Product Purpose" sections, then cache the inferred value for the session.
- **color model**: Use OKLCH for colors.
- **neutral colors**: Never use #000 or #fff; tint every neutral toward the brand hue.
- **accent rule**: The "one accent ≤10%" rule applies only to the Restrained strategy.
- **theme selection**: Dark vs. light themes are never a default; choose based on physical context.
- **line length**: Cap body line length at 65–75 characters.
- **hierarchy**: Maintain a hierarchy through scale and weight contrast with at least a 1.25 ratio between steps.
- **spacing**: Vary spacing for rhythm; same padding everywhere creates monotony.
- **cards usage**: Cards should only be used when they are truly the best affordance; nested cards are always wrong.
- **animation**: Do not animate CSS layout properties.
- **easing**: Use ease-out exponential curves (ease-out-quart, quint, expo) for motion; avoid bounce or elastic easing.
- **side‑stripe borders**: Side‑stripe borders greater than 1 px as colored accents are prohibited.
- **gradient text**: Gradient text using background‑clip: text with a gradient background is prohibited.
- **glassmorphism**: Glassmorphism as a default style is prohibited; use only rarely and purposefully.
- **hero‑metric template**: The hero‑metric template (big number, small label, supporting stats, gradient accent) is prohibited as a SaaS cliché.
- **identical card grids**: Identical card grids with repeated icon + heading + text are prohibited.
- **modals**: Modals should not be the first design choice; consider inline or progressive alternatives first.
- **copy economy**: Every word in copy must earn its place; avoid restated headings and intros that repeat the title.
- **punctuation**: Em dashes are prohibited; use commas, colons, semicolons, periods, or parentheses instead.
- **craft**: `craft [feature]` is a Build command that shapes then builds a feature end-to-end.
- **shape**: `shape [feature]` is a Build command that plans UX/UI before writing code.
- **teach**: `teach` is a Build command that sets up PRODUCT.md and DESIGN.md context.
- **document**: `document` is a Build command that generates DESIGN.md from existing project code.
- **extract**: `extract [target]` is a Build command that pulls reusable tokens and components into a design system.
- **critique**: `critique [target]` is an Evaluate command that performs a UX design review with heuristic scoring.
- **audit**: `audit [target]` is an Evaluate command that conducts technical quality checks such as accessibility, performance, and responsiveness.
- **polish**: `polish [target]` is a Refine command that provides a final quality pass before shipping.
- **bolder**: `bolder [target]` is a Refine command that amplifies safe or bland designs.
- **quieter**: `quieter [target]` is a Refine command that tones down aggressive or overstimulating designs.
- **distill**: `distill [target]` is a Refine command that strips to essence and removes complexity.
- **harden**: `harden [target]` is a Refine command that makes a product production‑ready, handling errors, i18n, and edge cases.
- **onboard**: `onboard [target]` is a Refine command that designs first‑run flows, empty states, and activation experiences.
- **animate**: `animate [target]` is an Enhance command that adds purposeful animations and motion.
- **colorize**: `colorize [target]` is an Enhance command that adds strategic color to monochromatic UIs.
- **typeset**: `typeset [target]` is an Enhance command that improves typography hierarchy and fonts.
- **layout**: `layout [target]` is an Enhance command that fixes spacing, rhythm, and visual hierarchy.
- **delight**: `delight [target]` is an Enhance command that adds personality and memorable touches.
- **overdrive**: `overdrive [target]` is an Enhance command that pushes past conventional limits.
- **clarify**: `clarify [target]` is a Fix command that improves UX copy, labels, and error messages.
- **adapt**: `adapt [target]` is a Fix command that adapts designs for different devices and screen sizes.
- **optimize**: `optimize [target]` is a Fix command that diagnoses and fixes UI performance issues.
- **live**: `live` is an Iterate command that provides a visual variant mode for picking elements in the browser and generating alternatives.
- **pin/unpin**: `pin <command>` and `unpin <command>` are management commands for pinning and unpinning other commands.
- **Pin**: Pin creates a standalone shortcut so `{{command_prefix}}<command>` invokes `{{command_prefix}}impeccable <command>` directly.
- **Unpin**: Unpin removes the standalone shortcut created by Pin.
- **pin.mjs**: The script `node {{scripts_path}}/pin.mjs <pin|unpin> <command>` writes to every harness directory present in the project.
- **Command**: Valid `<command>` is any command from the table above.
- **script**: Report the script's result concisely.
- **shortcut**: Confirm the new shortcut on success, relay stderr verbatim on error.
