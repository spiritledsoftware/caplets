---
title: curated_context
summary: Curated factual statements from provided context
tags: []
related: []
keywords: []
createdAt: '2026-05-28T13:45:50.257Z'
updatedAt: '2026-05-28T13:45:50.257Z'
---
## Reason
Curate extracted knowledge from RLM extraction

## Raw Concept
**Task:**
Curate extracted knowledge from provided context

**Flow:**
extraction -> deduplication -> curation

**Timestamp:** 2026-05-28T13:45:50.253Z

## Narrative
### Structure
Organized by subject

### Highlights
Extracted and deduplicated factual statements

### Examples
[
  {
    "statement": "apps/landing/src/pages/index.astro:523-558 now only enables reveal enhancement when canAnimate is true and IntersectionObserver exists.",
    "subject": "apps/landing/src/pages/index.astro"
  },
  {
    "statement": "Content remains visible by default because hidden reveal styles are gated behind .motion-ready, added only after observer setup begins successfully.",
    "subject": ".motion-ready CSS gating"
  },
  {
    "statement": "The former 1.8s fallback is shortened to 100ms at index.astro:553-558.",
    "subject": "apps/landing/src/pages/index.astro"
  },
  {
    "statement": "Reduced-motion behavior is preserved via canAnimate check and CSS override at apps/landing/src/styles/global.css:1261-1285.",
    "subject": "apps/landing/src/styles/global.css"
  },
  {
    "statement": "Reveal transition now uses only opacity and transform at global.css:561-563; the prior border-color transition was removed.",
    "subject": "apps/landing/src/styles/global.css"
  },
  {
    "statement": "No reveal-related content or copy changes were found, and no em dashes were introduced in the reviewed reveal-motion changes.",
    "subject": "reveal-motion changes"
  }
]

## Facts
- **apps/landing/src/pages/index.astro**: apps/landing/src/pages/index.astro:523-558 now only enables reveal enhancement when canAnimate is true and IntersectionObserver exists.
- **.motion-ready CSS gating**: Content remains visible by default because hidden reveal styles are gated behind .motion-ready, added only after observer setup begins successfully.
- **apps/landing/src/pages/index.astro**: The former 1.8s fallback is shortened to 100ms at index.astro:553-558.
- **apps/landing/src/styles/global.css**: Reduced-motion behavior is preserved via canAnimate check and CSS override at apps/landing/src/styles/global.css:1261-1285.
- **apps/landing/src/styles/global.css**: Reveal transition now uses only opacity and transform at global.css:561-563; the prior border-color transition was removed.
- **reveal-motion changes**: No reveal-related content or copy changes were found, and no em dashes were introduced in the reviewed reveal-motion changes.
