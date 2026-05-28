---
title: post_commit_hook_brv
summary: Post-commit hook auto-commits .brv context and pre-push verifies no uncommitted .brv changes
tags: []
related: []
keywords: []
createdAt: '2026-05-28T16:56:48.398Z'
updatedAt: '2026-05-28T16:56:48.398Z'
---
## Reason
Document design of post-commit hook to commit .brv changes and pre-push check

## Raw Concept
**Task:**
Implement git hooks for automatic .brv context commits and verification before push

**Files:**
- .husky/post-commit
- .husky/pre-push
- scripts/commit-byterover-context.ts

**Flow:**
post-commit -> detect .brv changes -> stage .brv -> commit with docs(agents): byterover context; pre-push -> verify .brv clean before push

**Timestamp:** 2026-05-28T16:56:15.853Z

**Author:** assistant

## Narrative
### Structure
post-commit runs tsx script; script checks git status, stages .brv, makes conventional commit; pre-push runs verify then ensures .brv clean

### Highlights
Avoid recursion via BYTEROVER_CONTEXT_COMMIT env var; fail push if .brv has uncommitted changes

## Facts
- **husky_post_commit**: .husky/post-commit runs pnpm exec tsx ./scripts/commit-byterover-context.ts [project]
- **husky_pre_push**: .husky/pre-push runs pnpm verify [project]
- **script_detection**: commit-byterover-context.ts detects .brv changes via git status --porcelain -- .brv [project]
- **script_commit**: Script stages .brv and creates docs(agents): byterover context commit [project]
- **pre_push_check**: Pre-push check fails if .brv has uncommitted changes [project]
