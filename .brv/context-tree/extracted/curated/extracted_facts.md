---
title: extracted_facts
summary: Extracted factual statements from provided context
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:15:49.857Z'
updatedAt: '2026-05-28T13:27:23.975Z'
---
## Reason
Curate extracted factual statements from context

## Raw Concept
**Task:**
Curate extracted facts

**Changes:**
- Extracted facts from provided context

**Flow:**
extract -> dedup -> group -> curate

**Timestamp:** 2026-05-28T13:27:23.971Z

## Narrative
### Structure
Aggregated factual statements

### Highlights
hero layout, trace column, hero text column, headline sizing, trace card width

## Facts
- **hero layout**: Rebalanced the hero layout so the trace card is wider again while keeping the headline to a clean two-line wrap.
- **trace column**: Increased trace column from 576px to about 660px at desktop width in apps/landing/src/styles/global.css.
- **hero text column**: Reduced the hero text column slightly.
- **headline sizing**: Adjusted headline sizing so it still wraps as: “Skillify your” and “backends.”
- **trace card width**: Browser verified at 1440 × 900 that trace card width is 660px.
- **trace card overflow**: No trace card horizontal overflow observed.
- **hero headline**: Hero headline remains two lines.
- **typecheck**: Build check passed: pnpm --filter @caplets/landing typecheck.
- **build**: Build check passed: pnpm --filter @caplets/landing build.
