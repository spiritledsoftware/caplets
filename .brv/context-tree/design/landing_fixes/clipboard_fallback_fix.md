---
title: clipboard fallback fix
summary: 'Landing page fix: clipboard fallback'
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:24:30.745Z'
updatedAt: '2026-05-28T11:24:30.745Z'
---
## Reason
Curate landing page audit fixes

## Raw Concept
**Task:**
Document landing page fix: clipboard fallback

**Changes:**
- Improved clipboard fallback by associating copy buttons with snippet targets, focusing/selecting snippet text on failed write, and retaining a textarea fallback.

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
Improved clipboard fallback by associating copy buttons with snippet targets, focusing/selecting snippet text on failed write, and retaining a textarea fallback.

## Facts
- **clipboard fallback**: Improved clipboard fallback by associating copy buttons with snippet targets, focusing/selecting snippet text on failed write, and retaining a textarea fallback.
