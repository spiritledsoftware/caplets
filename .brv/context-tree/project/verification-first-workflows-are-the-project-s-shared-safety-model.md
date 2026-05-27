---
confidence: 0.98
sources: [docs/_index.md, facts/_index.md, project/_index.md]
synthesized_at: '2026-05-27T10:03:46.002Z'
type: synthesis
title: Verification-first workflows are the project’s shared safety model
summary: Across planning, curation, and release, changes are only treated as complete after explicit verification, not workflow success alone.
tags: [verification, workflow, release, curation]
related: []
keywords: [verification, tests, pnpm verify, publish-state, applied-file-paths, curation, completion, release-gating]
createdAt: '2026-05-27T10:03:46.002Z'
updatedAt: '2026-05-27T10:03:46.002Z'
---

# Verification-first workflows are the project’s shared safety model

The same verification-first pattern appears in docs, facts, and project: planning docs emphasize explicit checks before completion, the curation workflow requires `result.summary.failed === 0` and applied file-path verification, and release automation waits for verified publish state rather than just successful workflow runs.

## Evidence

- **docs**: Planning and release docs repeatedly frame work as verification-first: completion fixes are validated with focused tests and `pnpm verify`, and release publishing is gated by verified upstream publish state rather than workflow success alone.
- **facts**: The curation/runtime conventions require recon-first analysis, then curate, then verify through `result.applied[].filePath` and `result.summary.failed === 0`, and related review notes preserve explicit test/commit evidence.
- **project**: The RLM curation workflow summary says verification should use `result.summary.failed === 0` and `result.applied[].filePath`, not rereading files, and the PR 78 review outcome preserved a clean verification state.
