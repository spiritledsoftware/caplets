---
consolidated_at: '2026-05-25T11:38:47.792Z'
consolidated_from: [{date: '2026-05-25T11:38:47.792Z', path: project/rlm_curation_workflow/current_branch_completion_restore.md, reason: 'These two files substantially overlap on the RLM curation workflow and completion behavior guidance. The latter is the richer and more complete source, while the branch restore note includes implementation-specific completion details and verification outcomes that fit naturally into the workflow topic; combining them will reduce duplication and keep one canonical workflow record.'}]
related: [project/pr_78_review_outcome/pr_78_review_outcome.md]
---
# Title: RLM Curation Workflow

## Overview
Covers the curation workflow for this session, the completion behavior contract for caplets commands, and the branch-local restoration of split-target CLI completion support.

## Key Concepts
- single-pass
- chunked extraction
- recon-first analysis
- completion contract
- call-tool
- get-tool
- get-prompt
- safe fallback behavior
- split target support
- dotted target compatibility
- regression tests
- verification via applied file paths

## Workflow / Rules
- Use precomputed recon output to select single-pass mode.
- Proceed directly to extraction when single-pass is suggested.
- Use mapExtract only for chunked extraction when needed.
- Pass taskId as a bare variable, not a string.
- Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself.
- Verify curation via result.applied[].filePath; do not reread files for verification.
- Do not print raw context.
- Completion behavior for call-tool, get-tool, and get-prompt must distinguish backend IDs from tool names based on prefix.
- Failures and timeouts must degrade to safe fallbacks without surfacing errors.
- Local hidden __complete now uses CapletsEngine.completeCliWords.

## Highlights
- For small contexts, single-pass curation is the preferred path after recon.
- For larger contexts, chunked extraction should be followed by dedup and groupBySubject before curation.
- Split targets for get-tool, call-tool, and get-prompt were restored while preserving dotted completion compatibility.
- Regression tests were added for split tool calls, split prompt calls, split/dotted completion, and local OpenAPI completion discovery.
- Verification passed with focused tests, formatting, lint, and full pnpm verify.

## Facts
- **curation_mode**: Single-pass mode should be used when recon suggests single-pass. [convention]
- **mapextract_taskid**: When using mapExtract in curation, the taskId must be passed as a bare variable. [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must use timeout: 300000 on the code_exec tool call itself. [convention]
- **verification_method**: Verification should use result.applied[].filePath and should not call readFile for verification. [convention]
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

## Cross-References
- project/rlm_curation_workflow/context.md
- facts/conventions/task_7_remote_mutation_routing_review.md
- facts/project/rlm_curation_workflow.md
- project/rlm_curation_workflow/current_branch_completion_restore.md