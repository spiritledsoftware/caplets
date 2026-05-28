---
title: reveal animation fix
summary: 'Landing page fix: reveal animation'
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:24:30.748Z'
updatedAt: '2026-05-28T11:24:30.748Z'
---
## Reason
Curate landing page audit fixes

## Raw Concept
**Task:**
Document landing page fix: reveal animation

**Changes:**
- Added reveal animation fail‑safe: reduced‑motion safe, no‑IntersectionObserver safe, and a timeout fallback to reveal content if observer setup stalls.

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
Added reveal animation fail‑safe: reduced‑motion safe, no‑IntersectionObserver safe, and a timeout fallback to reveal content if observer setup stalls.

## Facts
- **reveal animation**: Added reveal animation fail‑safe: reduced‑motion safe, no‑IntersectionObserver safe, and a timeout fallback to reveal content if observer setup stalls.
