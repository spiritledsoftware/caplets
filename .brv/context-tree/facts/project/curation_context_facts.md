---
title: Curation Context Facts
summary: Project facts and runtime conventions extracted from the curation context, including task metadata and processing guidance.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T19:28:15.751Z'
updatedAt: '2026-05-20T19:28:15.751Z'
---
## Reason
Curate extracted runtime and task metadata facts from the provided context

## Raw Concept
**Task:**
Curate RLM context metadata and runtime guidance

**Changes:**
- Extracted key-value facts from the provided context variable

**Flow:**
context -> line parsing -> fact extraction -> deduplication -> curation

**Timestamp:** 2026-05-20T19:28:10.552Z

**Author:** ByteRover context engineer

## Narrative
### Structure
Captured the current curation task metadata and processing instructions as durable project facts.

### Dependencies
Uses the precomputed recon result and the supplied task/history/metadata variables.

### Highlights
The context is small enough for single-pass processing and the provided recon recommended single-pass mode.

## Facts
- **curate_only_information_with_lasting_value**: Curate only information with lasting value: facts, decisions, technical details, preferences, or notable outcomes. [project]
- **_user_**: [user]: continue [project]
- **_assistant_**: [assistant]: Yes — I checked again more broadly, including PR review threads and top-level review bodies. [project]
- **_warnings_**: - `warnings?: string[]` protocol field is defined but unused/unwired. [project]
