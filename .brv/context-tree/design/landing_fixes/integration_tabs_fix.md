---
title: integration tabs fix
summary: 'Landing page fix: integration tabs'
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:24:30.743Z'
updatedAt: '2026-05-28T11:24:30.743Z'
---
## Reason
Curate landing page audit fixes

## Raw Concept
**Task:**
Document landing page fix: integration tabs

**Changes:**
- Converted integration tabs to true progressive enhancement, removing misleading tab ARIA in static/no-JS HTML and adding ARIA attributes via JavaScript.

**Files:**
- apps/landing/src/pages/index.astro
- apps/landing/src/styles/global.css

**Flow:**
audit -> fix -> verification

**Timestamp:** 2026-05-28T11:24:30.735Z

**Author:** Ian Pascoe

## Narrative
### Structure
Fixes applied to landing page and styles

### Dependencies
Requires build and lint verification

### Highlights
Converted integration tabs to true progressive enhancement, removing misleading tab ARIA in static/no-JS HTML and adding ARIA attributes via JavaScript.

## Facts
- **integration tabs**: Converted integration tabs to true progressive enhancement, removing misleading tab ARIA in static/no-JS HTML and adding ARIA attributes via JavaScript.
