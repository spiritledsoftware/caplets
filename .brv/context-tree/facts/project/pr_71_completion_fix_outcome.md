---
consolidated_at: '2026-05-21T23:23:02.290Z'
consolidated_from: [{date: '2026-05-21T23:23:02.290Z', path: facts/project/pr_71_completion_commands_sync.md, reason: 'These two PR #71 outcome files describe the same completion-related fix and verification cycle, with one focusing on command parity/stderr suppression and the other on the PowerShell sentinel/endpoint normalization issue. They are complementary parts of the same PR outcome and should be merged into a single consolidated PR #71 completion fixes note.'}]
related: [facts/project/pr_65_fixes_and_verification.md, facts/project/remote_control_review_outcome.md, facts/project/greptile_review_comments.md, facts/project/task_6_spec_review_after_envelope_fix.md]
---
# Title: PR 71 Completion Fix Outcome

## Summary
PR #71 resolved completion regressions in two related phases: command parity/stderr suppression and the PowerShell trailing-space sentinel bug. The final state passed targeted completion tests and pnpm verify.

## Combined Outcome
- Synced completion command generation with createProgram() to fix topLevelCommands drift.
- Added a regression test comparing completeCliWords([""]) against registered createProgram() commands, excluding hidden __complete.
- Suppressed stderr in generated shell helpers across Bash, Zsh, Fish, PowerShell, and cmd.
- Replaced the PowerShell empty-string trailing-space sentinel with __CAPLETS_TRAILING_SPACE__.
- Normalized __CAPLETS_TRAILING_SPACE__ inside the hidden __complete endpoint before local or remote completion resolution.
- Added tests for PowerShell script output and hidden completion endpoint normalization.
- Fetched unresolved review threads, including outside-diff comments, and rechecked review status to zero unresolved threads.
- Verification passed with targeted CLI completion tests and pnpm verify.

## Flow
issue report -> fix applied -> regression tests added -> endpoint/script normalization -> targeted tests -> pnpm verify -> review threads cleared

## Preservation Notes
- Preserve shell-specific stderr redirection details: Bash/Zsh/Fish 2>/dev/null, PowerShell 2>$null, cmd 2^>nul.
- Preserve the sentinel name __CAPLETS_TRAILING_SPACE__ and the hidden __complete endpoint normalization behavior.
- Preserve the review-thread fetching requirement that includes outside-diff comments.

## Facts
- topLevelCommands drift was fixed by syncing completion commands.
- PowerShell sentinel behavior was hardened against Windows PowerShell 5.1.
- Targeted completion-related tests and pnpm verify passed.