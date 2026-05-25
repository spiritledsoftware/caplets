---
confidence: 0.93
sources: [docs/_index.md, facts/_index.md]
synthesized_at: '2026-05-21T23:23:26.220Z'
type: synthesis
title: Release automation is gated by verified publish state, not just workflow success
summary: The release pipeline only publishes Docker images after Changesets confirms a real npm publish, with validation checkpoints documented alongside it.
tags: [release, docker, changesets, verification]
related: [docs/plans/context.md, docs/plans/completion_local_discovery_and_split_targets.md, docs/plans/completion_discovery_refactor_implementation_plan.md, docs/plans/active_caplets_planning_documents.md, docs/plans/docker_image_publishing_for_release_pipeline.md, docs/plans/pr_71_completion_fix_outcome.md]
keywords: [publish, changesets, ghcr, docker, gating, workflow, validation, release]
createdAt: '2026-05-21T23:23:26.220Z'
updatedAt: '2026-05-21T23:23:26.220Z'
---

# Release automation is gated by verified publish state, not just workflow success

The docs and facts together show a release policy that ties Docker image publication to an authenticated upstream publish signal, not merely a successful workflow run. The same durable-knowledge practice records which checks passed and which validation remains missing, making the release pipeline explicitly stateful and auditable.

## Evidence

- **docs**: The approved GHCR release flow publishes Docker images only after Changesets publishes npm packages, requires `packages: write`, and gates Docker/GHCR steps on a real publish signal plus CLI package publication.
- **facts**: The project knowledge stores review outcomes and verification patterns, including passing `pnpm format:check`, `actionlint`, and `docker build --check`, while noting that a full `docker build -t ... .` remains the missing validation item in review-only context.
