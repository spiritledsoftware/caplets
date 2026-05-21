---
title: Caplets Runtime and Caplet Files
summary: Runtime and repository facts for caplets, including caplet entry files, GitHub/Linear/repo-cli modules, and the Context7 reference file.
tags: []
related: []
keywords: []
createdAt: '2026-05-21T10:20:40.242Z'
updatedAt: '2026-05-21T10:20:40.242Z'
---
## Reason
Capture runtime and file-layout facts from the curated caplets context

## Raw Concept
**Task:**
Document the caplets repository structure and runtime-related file footprint

**Changes:**
- Identified caplet modules and their key files
- Captured the Context7 reference file as part of the caplets knowledge set

**Files:**
- caplets/github/CAPLET.md
- caplets/github/README.md
- caplets/github-cli/CAPLET.md
- caplets/linear/CAPLET.md
- caplets/linear/workflows.md
- caplets/repo-cli/CAPLET.md
- caplets/context7.md

**Flow:**
caplet module files -> repository context references -> curated runtime facts

**Timestamp:** 2026-05-21T10:20:29.575Z

## Narrative
### Structure
The repository organizes caplet entry points by integration area, with dedicated folders for GitHub, GitHub CLI, Linear, and repo CLI. A separate Context7 reference file sits alongside the caplet folders.

### Dependencies
These notes are tied to the repository file layout rather than executable runtime dependencies.

### Highlights
Useful for quickly locating the caplet implementation and documentation files that define the repository’s integration surface.

## Facts
- **caplets_modules**: Caplets includes caplet files under caplets/github, caplets/github-cli, caplets/linear, and caplets/repo-cli. [project]
- **github_caplet_files**: The GitHub caplet has both a CAPLET.md and a README.md. [project]
- **linear_caplet_files**: The Linear caplet includes a CAPLET.md and a workflows.md file. [project]
- **context7_reference**: The repository includes a caplets/context7.md reference file. [project]
