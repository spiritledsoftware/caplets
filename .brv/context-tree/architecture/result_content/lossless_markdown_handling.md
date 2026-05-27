---
title: Lossless Markdown Handling
summary: Result content renders full markdown losslessly; UI preview collapses with ctrl+o
tags: []
related: []
keywords: []
createdAt: '2026-05-27T13:46:25.141Z'
updatedAt: '2026-05-27T13:46:25.141Z'
---
## Reason
Curate extracted facts from RLM extraction

## Raw Concept
**Task:**
Document lossless markdown result content handling

**Flow:**
Render result content without truncation, UI handles preview

**Timestamp:** 2026-05-27T13:46:25.138Z

## Narrative
### Structure
Result content module retains full markdown; Pi UI shows collapsed preview with ctrl+o to expand

### Dependencies
Pi UI component, result-content renderer

### Highlights
Lossless markdown preserved, UI preview hint added

### Examples
Collapsed view shows "..." and hint, expanded shows full markdown
