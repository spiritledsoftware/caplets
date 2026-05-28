---
title: pr_preview_deploy_fix
summary: Documented Alchemy fetch compatibility fix and CI workflow updates for PR preview deploy
tags: []
related: []
keywords: []
createdAt: '2026-05-28T11:44:45.781Z'
updatedAt: '2026-05-28T11:44:45.781Z'
---
## Reason
Curate fix details for PR preview deploy failure

## Raw Concept
**Task:**
Document PR preview deploy fix and related changes

**Changes:**
- Fixed InvalidArgumentError in Alchemy fetch compatibility
- Added scripts/alchemy-fetch-compat.mjs and test
- Updated package.json to run Alchemy with import shim
- Enhanced .github/workflows/pr-preview-deploy.yml
- Adjusted alchemy.run.ts for GitHub Actions metadata

**Files:**
- scripts/alchemy-fetch-compat.mjs
- scripts/alchemy-fetch-compat.test.mjs
- package.json
- .github/workflows/pr-preview-deploy.yml
- alchemy.run.ts

**Flow:**
detect error -> implement compatibility shim -> update workflow -> verify tests

**Timestamp:** 2026-05-28T11:44:45.779Z

**Author:** AI Assistant

## Narrative
### Structure
Added compatibility shim scripts and updated CI workflow to fix fetch dispatcher issue.

### Dependencies
Depends on undici@8.3.0 behavior in GitHub Actions.

### Highlights
All lint, typecheck, tests, schema, benchmark, and build passed after fix.

### Examples
Error: InvalidArgumentError: invalid onRequestStart method

## Facts
- **CI**: InvalidArgumentError: invalid onRequestStart method
- **Alchemy integration**: Alchemy passes a userland undici dispatcher into Node 24’s native fetch, and in GitHub Actions it resolves undici@8.3.0, which breaks the dispatcher interface
- **scripts/alchemy-fetch-compat.mjs**: scripts/alchemy-fetch-compat.mjs strips the incompatible dispatcher before native fetch
- **scripts/alchemy-fetch-compat.test.mjs**: scripts/alchemy-fetch-compat.test.mjs adds a regression test
- **package.json**: package.json runs Alchemy via node --import ./scripts/alchemy-fetch-compat.mjs
- **.github/workflows/pr-preview-deploy.yml**: .github/workflows/pr-preview-deploy.yml adds a PR-specific stage, GitHub token/metadata, issue comment permission, and clearer step name
- **alchemy.run.ts**: alchemy.run.ts removes placeholder your-username/your-repo, uses GitHub Actions repo metadata, and fixes comment markdown
- **format check**: pnpm format:check passes
- **lint**: pnpm lint passes
- **typecheck**: pnpm typecheck passes
- **test suite**: pnpm test runs 622 Vitest tests plus a shim regression test, all passed
- **schema check**: pnpm schema:check passes
- **benchmark check**: pnpm benchmark:check passes
- **build**: pnpm build passes
- **Cloudflare API parsing**: Cloudflare API JSON parsing works with the shim under Node 26
