---
title: Current Branch Completion Restore
summary: Restored split-target CLI completion support, preserved dotted targets, updated docs and changeset, and verified with full test and lint passes.
tags: []
related: []
keywords: []
createdAt: '2026-05-22T10:07:36.953Z'
updatedAt: '2026-05-22T10:07:36.953Z'
---
## Reason
Document the branch-local reimplementation and verification outcomes for split completion and tool/prompt target handling

## Raw Concept
**Task:**
Document the current-branch restoration of split completion behavior and verification

**Changes:**
- Reimplemented completion in the current branch
- Restored split target handling for get-tool, call-tool, and get-prompt
- Preserved dotted completion compatibility
- Added regression coverage for split and dotted completion paths
- Updated documentation and changelog entry

**Files:**
- pnpm format:check
- pnpm lint
- pnpm verify
- .changeset/local-completion-split-tools.md
- completion spec

**Flow:**
current branch -> restore implementation -> add regression tests -> update docs -> run focused tests -> run formatting/lint/verify

**Timestamp:** 2026-05-22T10:07:13.860Z

**Author:** assistant

## Narrative
### Structure
This entry captures the branch-local completion restoration, the affected CLI target forms, the documentation updates, and the verification results.

### Dependencies
The change depended on the existing CLI completion engine and on tests covering split and dotted forms.

### Highlights
The implementation restored split-target support while keeping legacy dotted targets working, and the full verification gate passed.

### Rules
Only pre-existing unrelated .brv remains dirty alongside the implementation files.

## Facts
- **branch_location**: The work was implemented in the current branch at /home/ianpascoe/code/caplets instead of the previous worktree. [project]
- **completion_implementation**: Local hidden __complete now uses CapletsEngine.completeCliWords. [project]
- **split_target_support**: get-tool, call-tool, and get-prompt accept split targets. [project]
- **dotted_target_support**: Existing dotted targets remain supported. [project]
- **completion_suggestions**: Completion suggests split-form backend IDs and unqualified tool/prompt names while preserving dotted completion. [project]
- **regression_tests**: Regression tests were added for split tool calls, split prompt calls, split/dotted completion, and local OpenAPI completion discovery. [project]
- **documentation_updates**: README, completion spec, and .changeset/local-completion-split-tools.md were updated. [project]
- **focused_test_result**: pnpm --filter @caplets/core test -- test/cli-completion.test.ts test/cli.test.ts passed with 456 tests. [project]
- **format_check**: pnpm format:check passed. [project]
- **lint_check**: pnpm lint passed. [project]
- **verify_result**: pnpm verify passed fully with 39 test files and 536 tests. [project]
- **dirty_worktree_note**: Only pre-existing unrelated .brv remained dirty alongside the implementation files. [project]
