---
title: curated_facts
summary: Curated factual statements extracted from raw context
tags: []
related: []
keywords: []
createdAt: '2026-05-28T09:46:02.466Z'
updatedAt: '2026-05-28T09:46:02.466Z'
---
## Reason
Store extracted factual statements from context

## Raw Concept
**Task:**
Curate extracted factual statements from provided context

**Changes:**
- Extracted factual statements

**Timestamp:** 2026-05-28T09:46:02.465Z

## Narrative
### Highlights
Extracted factual statements organized by subject

### Examples
[
  {
    "statement": "The CLI detector `npx impeccable --json apps/landing/src/pages/index.astro` returned an empty JSON array `[]`.",
    "subject": "CLI detector output"
  },
  {
    "statement": "The detector reported no findings.",
    "subject": "detector summary"
  },
  {
    "statement": "The detector likely misses CSS-driven brand and motion violations because most visual issues live in `global.css`.",
    "subject": "detector blind spot"
  },
  {
    "statement": "The detector likely does not compare implementation against `PRODUCT.md` and `DESIGN.md`.",
    "subject": "detector blind spot"
  },
  {
    "statement": "The detector likely does not reason about responsive layout quality, especially the mobile hero and map height.",
    "subject": "detector blind spot"
  },
  {
    "statement": "The detector likely does not inspect interaction fallback behavior, such as tab content when JavaScript is unavailable.",
    "subject": "detector blind spot"
  },
  {
    "statement": "The detector likely does not flag content credibility issues, such as inconsistent install commands.",
    "subject": "detector blind spot"
  },
  {
    "statement": "`DESIGN.md` specifies a quiet confidence brand with no decorative gradients, orchestrated page-load choreography, or glassmorphism.",
    "subject": "DESIGN.md"
  },
  {
    "statement": "The CSS uses radial gradients, perspective tilt, route glow/drop-shadow, sticky blurred header, large entrance animations, pointer-reactive map transforms, and animated route drift.",
    "subject": "global.css"
  },
  {
    "statement": "The hero `<h1>` has a font size of 9.5rem, line-height of 0.82, and letter-spacing of -0.085em.",
    "subject": "hero typography"
  },
  {
    "statement": "Under a viewport width of 720px, `.map-stage` has a minimum height of 770px.",
    "subject": "mobile layout"
  },
  {
    "statement": "Reduced-motion handling exists in the page.",
    "subject": "motion policy"
  },
  {
    "statement": "`PRODUCT.md` advises avoiding neon/devtool dark and terminal theatrics.",
    "subject": "PRODUCT.md"
  },
  {
    "statement": "The page includes a dark integrations block and a dark terminal install section.",
    "subject": "page content"
  },
  {
    "statement": "The hero/install flow uses the command `pnpm add -g caplets`.",
    "subject": "install command"
  },
  {
    "statement": "Agent setup cards use the command `npm install -g caplets` for OpenCode, Pi, and generic MCP.",
    "subject": "install command"
  },
  {
    "statement": "Tabs after the first are rendered with `hidden={index !== 0}` causing them to be inaccessible without JavaScript.",
    "subject": "tab markup"
  },
  {
    "statement": "The `.status-dot` element is green and has `aria-hidden` attribute, providing only a color cue for status.",
    "subject": "status indicator"
  }
]

## Facts
- **CLI detector output**: The CLI detector `npx impeccable --json apps/landing/src/pages/index.astro` returned an empty JSON array `[]`.
- **detector summary**: The detector reported no findings.
- **detector blind spot**: The detector likely misses CSS-driven brand and motion violations because most visual issues live in `global.css`.
- **detector blind spot**: The detector likely does not compare implementation against `PRODUCT.md` and `DESIGN.md`.
- **detector blind spot**: The detector likely does not reason about responsive layout quality, especially the mobile hero and map height.
- **detector blind spot**: The detector likely does not inspect interaction fallback behavior, such as tab content when JavaScript is unavailable.
- **detector blind spot**: The detector likely does not flag content credibility issues, such as inconsistent install commands.
- **DESIGN.md**: `DESIGN.md` specifies a quiet confidence brand with no decorative gradients, orchestrated page-load choreography, or glassmorphism.
- **global.css**: The CSS uses radial gradients, perspective tilt, route glow/drop-shadow, sticky blurred header, large entrance animations, pointer-reactive map transforms, and animated route drift.
- **hero typography**: The hero `<h1>` has a font size of 9.5rem, line-height of 0.82, and letter-spacing of -0.085em.
- **mobile layout**: Under a viewport width of 720px, `.map-stage` has a minimum height of 770px.
- **motion policy**: Reduced-motion handling exists in the page.
- **PRODUCT.md**: `PRODUCT.md` advises avoiding neon/devtool dark and terminal theatrics.
- **page content**: The page includes a dark integrations block and a dark terminal install section.
- **install command**: The hero/install flow uses the command `pnpm add -g caplets`.
- **install command**: Agent setup cards use the command `npm install -g caplets` for OpenCode, Pi, and generic MCP.
- **tab markup**: Tabs after the first are rendered with `hidden={index !== 0}` causing them to be inaccessible without JavaScript.
- **status indicator**: The `.status-dot` element is green and has `aria-hidden` attribute, providing only a color cue for status.
