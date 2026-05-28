---
title: Curated Extraction
summary: Aggregated factual statements extracted via RLM process
tags: []
related: []
keywords: []
createdAt: '2026-05-28T09:25:56.661Z'
updatedAt: '2026-05-28T09:25:56.661Z'
---
## Reason
Store extracted factual statements from source context

## Raw Concept
**Task:**
Curate extracted factual statements from source context

**Changes:**
- Extracted facts via mapExtract

**Timestamp:** 2026-05-28T09:25:56.659Z

## Narrative
### Structure
Aggregated factual statements extracted from source

### Highlights
Subject rAF throttling has 1 facts
Subject route drift has 1 facts
Subject mobile/desktop scroll behavior has 1 facts
Subject SVG decoration has 1 facts
Subject integration tab cue has 1 facts
Subject OKLCH color variables has 1 facts
Subject Impeccable punctuation ban has 1 facts
Subject Claude/Codex install commands has 1 facts

## Facts
- **rAF throttling**: rAF throttling is implemented for scroll/resize-driven hero `getBoundingClientRect()` calls, with `scroll` and `resize` calling `scheduleHeroProgressUpdate()` which gates updates through one `requestAnimationFrame` at a time.
- **route drift**: Route drift is no longer continuous by default; `.route-backbone` is paused unless `.map-stage.is-route-active` is present, and IntersectionObserver toggles that class based on visibility.
- **mobile/desktop scroll behavior**: Mobile avoids the fixed-height nested scroll panel while desktop keeps a bounded setup card, with desktop using `block-size` plus `overflow: auto` and mobile resetting to `block-size: auto` and `overflow: visible`.
- **SVG decoration**: npm/GitHub SVGs are decorative inside already-labeled links, marked with `aria-hidden="true"` and `focusable="false"`.
- **integration tab cue**: Active integration tab has a non-color cue via inset box-shadow.
- **OKLCH color variables**: Repeated one-off OKLCH colors were promoted to variables for the targeted repeated values.
- **Impeccable punctuation ban**: No newly introduced obvious Impeccable punctuation ban issue such as em dashes was found in the committed files.
- **Claude/Codex install commands**: Claude/Codex install commands were changed rather than merely split for readability; the committed command for both was altered, violating the audit requirement.
