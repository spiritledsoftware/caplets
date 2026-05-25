---
title: Task 5 Regression Test Update
summary: Added regression tests for remote add rejecting server-owned fields; tests passed and commit 089542d was created with a note about unrelated worktree changes.
tags: []
related: [facts/conventions/task_3_spec_review_fix.md, facts/conventions/task_6_review_outcome.md, facts/project/task_6_spec_review_after_envelope_fix.md, facts/conventions/task_7_review_outcome.md, facts/conventions/task_7_remote_mutation_routing_review.md, facts/conventions/task_9_remote_config_test_fix.md]
keywords: []
createdAt: '2026-05-20T13:52:39.382Z'
updatedAt: '2026-05-20T13:52:39.382Z'
---

## Reason

Record durable task outcome, tests, commit, and concerns from the conversation

## Raw Concept

**Task:**
Add regression tests ensuring remote add rejects options.destinationRoot and options.print as server-owned fields

**Changes:**
- Added focused regression coverage for server-owned remote add fields
- Ran remote-control-dispatch and serve-http tests
- Created commit 089542d without amending existing history

**Files:**
- packages/core/test/remote-control-dispatch.test.ts

**Flow:**
Implement rejection tests -> run targeted tests -> commit test-only change -> report outcome

**Timestamp:** 2026-05-20T13:52:25.305Z

## Narrative

### Structure

This update records the regression-testing work for the remote add server-owned field check, along with execution results and commit metadata.

### Dependencies

Relies on existing implementation behavior that already rejects the fields; tests were the only required change unless implementation needed adjustment.

### Highlights

pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/serve-http.test.ts passed: 32 files, 389 tests. Commit sha: 089542d.

### Rules

Return DONE, DONE_WITH_CONCERNS, or BLOCKED and include tests run plus commit sha. The commit should be new and should not amend prior history.

### Examples

Concern noted: unrelated staged/untracked .brv and docs files remained in the worktree, but the commit included only the test file.
