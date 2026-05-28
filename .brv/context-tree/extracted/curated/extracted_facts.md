---
title: extracted_facts
summary: Aggregated factual statements extracted via RLM extraction
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:15:49.857Z'
updatedAt: '2026-05-28T11:15:49.857Z'
---
## Reason
Curate facts extracted from RLM context

## Raw Concept
**Task:**
Curate extracted facts from provided context

**Flow:**
extract -> dedup -> group -> curate

**Timestamp:** 2026-05-28T11:15:49.856Z

## Narrative
### Structure
Aggregated factual statements extracted from context

### Highlights
audit theming, global.css, index.astro, grep, typecheck, build, impeccable, risks

## Facts
- **audit theming**: Implemented audit theming and polish fixes in apps/landing only.
- **global.css**: Changed file apps/landing/src/styles/global.css: moved direct OKLCH literals into semantic :root tokens.
- **global.css**: Changed file apps/landing/src/styles/global.css: removed unused stale custom properties.
- **global.css**: Changed file apps/landing/src/styles/global.css: removed unused .header-action.muted selector.
- **index.astro**: Changed file apps/landing/src/pages/index.astro: marked decorative terminal chrome with aria-hidden="true".
- **grep**: grep verified removed tokens and selectors are no longer present.
- **grep**: grep verified no em dashes in apps/landing.
- **typecheck**: pnpm --filter @caplets/landing typecheck passed with 0 errors.
- **build**: pnpm --filter @caplets/landing build passed.
- **impeccable**: npx impeccable --json apps/landing/src/pages/index.astro passed with empty result array.
- **risks**: Open risks/questions: None.
