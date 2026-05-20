---
title: Remote Auth Review Findings
summary: Task 8 review found a high-severity premature success message in remote auth login and a medium-severity lack of TTL/cleanup for pending remote auth flows; tests and typecheck passed.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T15:01:08.681Z'
updatedAt: '2026-05-20T15:01:08.681Z'
---

## Reason

Preserve lasting findings from Task 8 remote auth implementation review

## Raw Concept

**Task:**
Document the code review findings for Task 8 remote auth implementation

**Changes:**
- Identified premature success reporting in remote auth login
- Identified missing TTL and pruning for pending remote auth flows
- Recorded passing test and typecheck verification results

**Files:**
- packages/core/src/cli.ts
- packages/core/src/remote-control/auth-flow.ts
- packages/core/src/remote-control/dispatch.ts
- packages/core/test/remote-control-dispatch.test.ts
- packages/core/test/serve-http.test.ts
- packages/core/test/cli-remote.test.ts
- packages/core/test/auth.test.ts

**Flow:**
review scope -> inspect auth login behavior -> inspect remote auth flow cleanup -> verify tests and typecheck

**Timestamp:** 2026-05-20T15:00:51.436Z

**Author:** code quality review

## Narrative

### Structure

This review notes two issues: a high-severity mismatch between remote and local auth completion semantics, and a medium-severity lifecycle cleanup gap in the remote auth flow store.

### Dependencies

The findings depend on remote-control auth flow handling and callback dispatch behavior, plus the existing test suite and typecheck validation.

### Highlights

Existing tests passed, but they do not catch premature remote-login success or stale-flow lifecycle behavior.

### Rules

Return APPROVED or FINDINGS with severity and refs. Do not edit during review.

## Facts

- **remote_auth_login_premature_success**: Remote caplets auth login reports success immediately after auth_login_start before the OAuth callback completes. [project]
- **remote_auth_flow_cleanup**: Pending remote auth flows are stored in an unbounded Map and are deleted only after flow.complete(callbackUrl) succeeds. [project]
- **remote_auth_flow_lifecycle_risk**: Failed callbacks leave the remote auth flow live and abandoned flows can remain indefinitely. [project]
- **verification_tests**: Verification run passed pnpm --filter @caplets/core test for remote-control-dispatch, serve-http, cli-remote, and auth tests: 33 files / 410 tests. [project]
- **verification_typecheck**: pnpm --filter @caplets/core typecheck passed. [project]
