---
confidence: 0.94
sources: [docs/_index.md, facts/_index.md, project/_index.md]
synthesized_at: '2026-05-26T19:23:43.121Z'
type: synthesis
title: Release and completion work is governed by verification, not optimistic success signals
summary: Planning and outcomes both emphasize gating behavior on explicit verification rather than workflow success alone.
tags: [release, completion, verification, fallback, automation]
related: [docs/plans/context.md, docs/plans/active_caplets_planning_documents.md, docs/plans/completion_discovery_refactor_implementation_plan.md, docs/plans/completion_local_discovery_and_split_targets.md, docs/plans/docker_image_publishing_for_release_pipeline.md, docs/plans/pr_71_completion_fix_outcome.md, docs/plans/release-automation-is-gated-by-verified-publish-state-not-just-workflow-success.md]
keywords: [gated, publish, fallback, auth, discovery, candidate, workflow, verification]
createdAt: '2026-05-26T19:23:43.121Z'
updatedAt: '2026-05-26T19:23:43.121Z'
---

# Release and completion work is governed by verification, not optimistic success signals

Across docs and facts/project, the repository repeatedly treats completion and release behavior as verification-gated: completion falls back to safe candidates when discovery/auth is blocked, and release publishing waits for a verified publish state rather than assuming workflow success means it is safe to publish.

## Evidence

- **docs**: The release pipeline publishes GHCR Docker images only after Changesets publishes npm packages, and Docker publication is gated on verified publish state rather than workflow success alone.
- **facts**: Completion must not trigger interactive auth; if discovery is blocked, return stale cached results first, otherwise use static/config fallback only, and completion output remains candidate-only.
- **project**: The completion contract says failures and timeouts must degrade to safe fallbacks, and hidden `__complete` uses `CapletsEngine.completeCliWords`.
