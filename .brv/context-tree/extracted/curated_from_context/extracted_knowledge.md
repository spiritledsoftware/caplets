---
title: Extracted Knowledge
summary: Extracted rawConcept, narrative, relations, and facts from provided context
tags: []
related: []
keywords: []
createdAt: '2026-05-28T09:57:33.791Z'
updatedAt: '2026-05-28T09:57:33.791Z'
---
## Reason
Curate extracted knowledge from RLM context

## Facts
- **implementation plan**: Create a written implementation plan in docs/plans/ before code changes.
- **landing page**: The landing page changes include narrative, information architecture, hero structure, trust proof, motion system, accessibility fallback, and command affordances.
- **messaging refactor**: Messaging refactor should make trust the primary objective, define “skillify”, make “capability cards” dominant, and demote “map” to supporting metaphor.
- **hero rebuild**: Hero rebuild should replace expressive map hero with realistic GitHub trace, show progressive disclosure path, and include source, status, auth redaction, schema preservation, structured result preservation.
- **trust proof**: Trust proof section should add concrete safety/failure examples, show config source and redacted auth, and show timeout/error/recovery behavior where accurate.
- **interaction hardening**: Interaction hardening includes copy buttons for commands and snippets, no-JS integration fallback, and non-color-only status cues.
- **visual simplification**: Visual simplification should remove pointer tilt, scroll route resolution, route drift, heavy glow, and orchestration, keeping restrained hover/focus transitions.
- **consistency fixes**: Consistency fixes include resolving install command mismatch and adding direct docs/config links if available.
- **hover/focus behavior**: keep restrained hover/focus transitions
- **consistency fixes**: resolve install command mismatch
- **documentation**: add direct docs/config links if available
- **verification**: pnpm --filter apps/landing typecheck
- **verification**: pnpm --filter apps/landing build
- **verification**: maybe full pnpm verify if landing changes interact with repo gates
- **process**: produce a written docs/plans/... implementation plan before touching code
- **pnpm verify**: Running `pnpm verify` may be needed if landing changes interact with repo gates.
- **implementation plan**: A written implementation plan should be produced in docs/plans/... before touching code.
