---
title: RLM Curation Runtime Conventions
summary: RLM curation uses precomputed recon for small contexts, UPSERT-based curation, and verification via applied file paths; the reviewed fix also pinned QEMU setup before Buildx and verified the build.
tags: []
related: [facts/conventions/context.md, facts/project/context.md, docs/plans/active_caplets_planning_documents.md]
keywords: []
createdAt: '2026-05-20T13:23:05.390Z'
updatedAt: '2026-05-21T11:20:11.122Z'
---
## Reason
Document runtime and workflow conventions from the curation instructions and conversation outcome.

## Raw Concept
**Task:**
Document the curation runtime conventions and the outcome of the PR review fix.

**Changes:**
- Established single-pass curation for the current context.
- Captured the required variable names for context, history, metadata, and task ID.
- Recorded verification guidance to use applied file paths rather than readFile.
- Established recon-first workflow
- Defined single-pass handling for small contexts
- Specified mapExtract timeout and taskId handling
- Defined verification using applied file paths
- Single-pass mode should be used when recon suggests it.
- Reconstruction step is already precomputed and should not be repeated.
- Verification should use applied file paths rather than readFile.
- Established recon-first decision flow
- Defined chunked mapExtract handling for larger contexts
- Standardized UPSERT-based curation and verification
- Specified that recon is mandatory before curation when mode is not already known.
- Defined single-pass handling as a two-call flow.
- Defined chunked handling with mapExtract, deduplication, and grouping.
- Defined verification by applied file paths and zero failed operations.
- Defined single-pass handling for small contexts.
- Recorded chunked extraction requirements for mapExtract.
- Recorded verification and status reporting expectations.
- Use precomputed recon when available
- Skip chunking in single-pass mode
- Pass taskId as a bare variable to mapExtract
- Verify results through applied file paths
- Recorded that recon is precomputed and single-pass is the recommended mode for this context.
- Captured the requirement to avoid printing raw context during curation.
- Captured the taskId and timeout requirements for mapExtract-based extraction.
- Use pre-computed recon when available and proceed directly to extraction.
- Single-pass mode is appropriate for the 1402-character, 31-line context.
- Use mapExtract with taskId only when chunking is required.
- Verify curation via result.applied[].filePath without readFile-based verification.
- Captured single-pass recommendation from precomputed recon
- Recorded context size and message count
- Noted availability of task ID and precomputed recon
- Captured the single-pass vs chunked decision rule
- Captured mapExtract timeout and taskId requirements
- Captured verification and success-check requirements
- Captured the precomputed-recon shortcut rule
- Captured the single-pass versus chunked extraction guidance
- Captured the verification and reporting expectations
- Clarified that single-pass recon is already computed and should not be recomputed.
- Recorded the required timeout for any code_exec call that uses mapExtract.
- Captured the push of commit 843c7dd resolving remaining review threads.
- Captured the QEMU-before-Buildx change for multi-arch GHCR builds.

**Files:**
- .brv/context-tree/
- .brv/context-tree/facts/conventions/
- .brv/context-tree/facts/conventions/context.md
- pnpm verify
- docker compose config
- docker build -t caplets:self-host-review .

**Flow:**
precomputed recon -> extraction/curation -> verify applied file paths; review fix -> push commit -> run verification commands

**Timestamp:** 2026-05-21T11:19:55.626Z

**Author:** ByteRover context engineer

**Patterns:**
- `^300000$` - Required timeout value for code_exec calls containing mapExtract

## Narrative
### Structure
This knowledge captures runtime conventions for the RLM curation workflow plus the specific PR-review fix outcome and verification commands.

### Dependencies
Depends on the curation toolchain conventions and the successful completion of repository verification commands.

### Highlights
The conversation recorded that the unresolved review comments were addressed, commit 843c7dd was pushed, and the multi-arch GHCR build flow now registers QEMU before Buildx.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction.
IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options).
Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples
Use single-pass when suggestedMode is single-pass; use mapExtract only when chunking is needed, with timeout 300000 at the code_exec level.

## Facts
- **rlm_curation_mode**: For small curation contexts, recon is pre-computed and the workflow should proceed directly to extraction when suggestedMode is single-pass. [convention]
- **mapextract_timeout**: When using mapExtract, the code_exec call itself must use timeout: 300000. [convention]
- **verification_method**: Verification should use result.applied[].filePath and should not call readFile for verification. [convention]
- **pr_review_fix_commit**: The fix addressed unresolved PR review comments, including outside-diff comments, and pushed commit 843c7dd fix: resolve remaining review threads. [project]
- **qemu_before_buildx**: The fixes included adding pinned docker/setup-qemu-action before Buildx for multi-arch GHCR builds. [project]
- **verification_commands**: The fixes were verified with pnpm verify, docker compose config, and docker build -t caplets:self-host-review . [project]
