---
title: Docker Image Publishing for Release Pipeline
summary: 'Release workflow should publish GHCR Docker images only after Changesets publishes npm packages, with packages: write permission and Docker build/login steps gated on published releases.'
tags: []
related: [architecture/remote_control/release_workflow.md]
keywords: []
createdAt: '2026-05-21T09:58:44.922Z'
updatedAt: '2026-05-21T09:58:44.922Z'
---
## Reason
Capture approved release workflow direction and implementation intent

## Raw Concept
**Task:**
Document the approved release pipeline change to publish Docker images to GHCR

**Changes:**
- Approved publishing Docker images from the release workflow
- Add packages: write permission to GitHub Actions permissions
- Use Docker login, metadata, and build-push steps after Changesets publishes

**Files:**
- .github/workflows/release.yml

**Flow:**
push to main -> pnpm verify -> changesets action -> if published -> docker login/metadata/build-push -> GHCR publish

**Timestamp:** 2026-05-21T09:58:31.983Z

**Author:** user/assistant discussion

## Narrative
### Structure
This decision belongs with the project plan for release workflow changes and specifically targets the GitHub Actions release pipeline.

### Dependencies
Requires changesets publishing to succeed before Docker image build and push can run. The workflow must also be able to authenticate to GHCR.

### Highlights
Approach 1 was approved: publish Docker images only after npm release publishing, keeping image releases aligned with package releases.

### Rules
Use the release workflow approach gated on successful Changesets publishing.

### Examples
Example tags: ghcr.io/spiritledsoftware/caplets:latest and ghcr.io/spiritledsoftware/caplets:v<version>

## Facts
- **release_workflow_trigger**: The release workflow currently uses changesets/action@v1 on pushes to main. [project]
- **release_workflow_verification_step**: The workflow runs pnpm verify before the release or version PR path. [project]
- **github_permissions**: The workflow currently has contents, pull-requests, and id-token permissions, but not packages: write. [project]
- **docker_publish_gate**: GHCR image publishing should be gated on steps.changesets.outputs.published == true. [project]
- **docker_tags**: The recommended image tags are latest, v<published package version>, and optionally <sha>. [project]
