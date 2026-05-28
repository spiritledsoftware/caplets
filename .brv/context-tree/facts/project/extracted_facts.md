---
title: Extracted Facts
summary: Curated factual statements extracted from source context
tags: []
related: []
keywords: []
createdAt: '2026-05-28T16:47:59.662Z'
updatedAt: '2026-05-28T16:47:59.662Z'
---
## Reason
Store extracted factual statements from context

## Raw Concept
**Task:**
Curate extracted factual statements from provided context

**Timestamp:** 2026-05-28T16:47:59.660Z

## Facts
- **changesets**: Changesets supports excluding packages via `.changeset/config.json`.
- **config**: Added "ignore": ["@caplets/landing"] to the config.
- **changeset status**: `pnpm changeset status --since=origin/main` now passes with no changeset needed for landing-only changes.
- **PR**: Pushed to PR #93 in commit `3f21287 chore: ignore landing app in changesets`.
- **changeset status**: `pnpm changeset status --since=origin/main` passed.
- **format check**: `pnpm format:check -- .changeset/config.json` passed.
- **verification**: `pnpm verify` passed.
