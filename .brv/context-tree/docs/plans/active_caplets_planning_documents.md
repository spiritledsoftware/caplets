---
title: Active Caplets Planning Documents
summary: Active caplets planning notes covering backend, remote control, CLI, HTTP actions, GraphQL, hot reload, XDG paths, and release-related work.
tags: []
related: [architecture/remote_control/context.md, architecture/auth/context.md]
keywords: []
createdAt: '2026-05-21T10:20:40.246Z'
updatedAt: '2026-05-21T10:21:06.053Z'
---
## Reason
Curate the planning notes and active implementation directions from the provided context

## Raw Concept
**Task:**
Document the active caplets planning documents and implementation roadmap

**Changes:**
- Captured planning notes dated 2026-05-12 through 2026-05-19
- Included release and backend architecture planning documents
- Captured multiple dated planning documents as durable knowledge
- Preserved workstreams for backend, remote control, CLI tools, HTTP actions, GraphQL, hot reload, and XDG cross-platform paths
- Included release and Docker publishing planning references

**Files:**
- docs/plans/2026-05-12-cli-inspection-polish.md
- docs/plans/2026-05-12-graphql-backend.md
- docs/plans/2026-05-12-hot-reload.md
- docs/plans/2026-05-12-mcp-backed-caplet-files.md
- docs/plans/2026-05-13-http-actions-backend.md
- docs/plans/2026-05-13-xdg-cross-platform-paths.md
- docs/plans/2026-05-14-cli-tools-backend.md
- docs/plans/2026-05-14-coding-agent-benchmarks.md
- docs/plans/2026-05-14-output-field-selection.md
- docs/plans/2026-05-14-project-first-caplets-add.md
- docs/plans/2026-05-15-native-agent-caplet-extensions.md
- docs/plans/2026-05-15-native-hot-reload.md
- docs/plans/2026-05-19-caplets-interface-ux.md

**Flow:**
planning note authored -> implementation idea captured -> review/iteration -> roadmap preserved for follow-up work

**Timestamp:** 2026-05-21T10:20:57.367Z

## Narrative
### Structure
This topic aggregates active caplets planning documents under docs/plans and treats them as a roadmap collection rather than isolated notes.

### Dependencies
The plans reference CLI behavior, remote control, backend transport choices, hot reload, Docker/release work, and benchmark/UX considerations.

### Highlights
The context shows active documentation work centered on caplets product development and delivery planning.

### Examples
Examples include CLI inspection polish, GraphQL backend, HTTP actions backend, XDG cross-platform paths, and native hot reload planning.

## Facts
- **curated_context_line**: [user]: Task: [Read from: /home/ianpascoe/code/caplets/plan.md, /home/ianpascoe/code/caplets/progress.md] [project]
- **curated_context_line**: Review round 2 after fix worker. Fresh context in /home/ianpascoe/code/caplets. Do not edit files and do not run subagents. Focus maintainability/validation: workflow readability, actionlint/shell compatibility, docs/spec/plan alignment for GHCR release publishing, and whether focused validation is enough. Return blockers, fixes worth doing now, optional improvements, validation evidence. [project]
- **curated_context_line**: - GHCR permission is present: `.github/workflows/release.yml:9-13` includes `packages: write`. [project]
- **curated_context_line**: - Changesets output is available: `.github/workflows/release.yml:50-59` gives the Changesets step `id: changesets`. [project]
- **curated_context_line**: - The round-2 fix is functionally sound: `.github/workflows/release.yml:61-73` checks `steps.changesets.outputs.publishedPackages` and only treats the CLI npm package `caplets` as image-publish-worthy. [project]
- **curated_context_line**: - All Docker/GHCR steps are now gated on both a real Changesets publish and CLI publication: `.github/workflows/release.yml:75-107`. [project]
- **curated_context_line**: - Tags align with the GHCR spec: `.github/workflows/release.yml:99-104` publishes `latest`, raw version, `v` version, and short SHA tags matching `docs/specs/2026-05-21-ghcr-release-publishing-design.md:17-20`. [project]
- **curated_context_line**: - Spec still says Docker publish steps are gated only by `steps.changesets.outputs.published == 'true'`: `docs/specs/2026-05-21-ghcr-release-publishing-design.md:13`. [project]
- **curated_context_line**: - Plan exact insertion snippet omits the CLI-package publication check: `docs/plans/2026-05-21-ghcr-release-publishing.md:100-139`. [project]
- **curated_context_line**: - Plan validation only checks for the broad Changesets publish gate, not the CLI-specific gate: `docs/plans/2026-05-21-ghcr-release-publishing.md:189-200`. [project]
- **curated_context_line**: - The spec asks for workflow syntax sanity at `docs/specs/2026-05-21-ghcr-release-publishing-design.md:30`, but the implementation plan relies mostly on formatting/string checks. `actionlint .github/workflows/release.yml` is the right focused syntax validation. [project]
- **curated_context_line**: - Add a short comment above `.github/workflows/release.yml:61` explaining that GHCR is published only when the CLI package is published to avoid pushing a stale image for core/integration-only releases. [project]
- **curated_context_line**: - `docs/specs/2026-05-21-ghcr-release-publishing-design.md` [project]
- **curated_context_line**: - `docs/plans/2026-05-21-ghcr-release-publishing.md` [project]
- **curated_context_line**: - `pnpm format:check .github/workflows/release.yml` passed. [project]
- **curated_context_line**: - `actionlint .github/workflows/release.yml` passed. [project]
- **curated_context_line**: - `caplets` package => `published=true` [project]
- **curated_context_line**: - `@caplets/core` only => `published=false` [project]
- **curated_context_line**: - `docker build --check .` passed with “Check complete, no warnings found.” [project]
- **curated_context_line**: - I did not run a full `docker build -t ... .` because this was review-only/no-edit and that creates a local image. If no fix worker ran the full Docker build, that remains the one missing validation item relative to the spec’s local verification guidance. [project]
