---
title: Task 6 Spec Review After Envelope Fix
summary: 'Task 6 review approved: CLI and dispatch align on { caplet, request }, config path handling remains local-only, and tests cover remote control behavior.'
tags: []
related: [architecture/remote_control/remote_control_api_shape.md, architecture/remote_control/task_1_spec_compliance_review.md, architecture/remote_control/cli_remote_mode_selection.md, facts/conventions/task_3_spec_review_fix.md, facts/conventions/task_5_regression_test_update.md, facts/conventions/task_6_review_outcome.md, facts/conventions/task_7_review_outcome.md, facts/conventions/task_7_remote_mutation_routing_review.md, facts/conventions/task_9_remote_config_test_fix.md, facts/project/remote_control_review_outcome.md, facts/project/pr_65_fixes_and_verification.md, facts/project/greptile_review_comments.md, facts/project/pr_71_completion_fix_outcome.md]
keywords: []
createdAt: '2026-05-20T14:11:18.102Z'
updatedAt: '2026-05-20T14:11:18.102Z'
---

## Reason

Capture durable verification of CLI and dispatch alignment after envelope fix commit f70d578

## Raw Concept

**Task:**
Document the approved Task 6 spec review after the envelope fix commit f70d578

**Changes:**
- Verified CLI and dispatch alignment on nested { caplet, request } envelopes
- Confirmed config path and config paths remain local-only
- Confirmed test coverage for CLI remote list/call-tool and dispatch nested envelope handling

**Files:**
- packages/core/src/cli.ts
- packages/core/src/remote-control/dispatch.ts
- packages/core/test/cli-remote.test.ts
- packages/core/test/remote-control-dispatch.test.ts

**Flow:**
CLI builds { caplet, request } envelope -> dispatch passes request to engine.execute -> tests verify local-only config paths and remote-control handling

**Timestamp:** 2026-05-20T14:11:05.386Z

**Author:** assistant

## Narrative

### Structure

This note records the approved review result, the envelope contract, local-only config rules, and the test files that validate the behavior.

### Dependencies

Depends on the envelope fix in commit f70d578 and the associated CLI, dispatch, and test updates.

### Highlights

The review returned APPROVED and the verification run passed with 394 tests.

### Examples

Covered tests include CLI remote list and call-tool envelope behavior, local-only config path handling, and dispatch nested envelope handling for get_caplet and search_tools.

## Facts

- **task_6_review_status**: Task 6 spec review after envelope fix commit f70d578 was approved. [project]
- **cli_envelope_shape**: CLI sends direct operation envelope as { caplet, request }. [project]
- **dispatch_envelope_shape**: Dispatch consumes the same nested envelope and passes request to engine.execute. [project]
- **config_path_scope**: config path remains local-only. [project]
- **config_paths_scope**: config paths remains local-only. [project]
- **verification_run**: pnpm --filter @caplets/core test -- test/cli-remote.test.ts test/remote-control-dispatch.test.ts passed with 394 tests. [project]
