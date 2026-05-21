---
title: RLM Curation Runtime Conventions
summary: RLM curation runtime conventions covering single-pass recon guidance, chunked extraction, UPSERT-first curation, verification expectations, and reporting requirements.
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-20T13:23:05.390Z'
updatedAt: '2026-05-21T09:35:02.619Z'
---

## Reason

Persist the runtime conventions and workflow rules for RLM-based curation

## Raw Concept

**Task:**
Document the runtime conventions for RLM-based curation workflows.

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

**Files:**
- .brv/context-tree/
- .brv/context-tree/facts/conventions/

**Flow:**
recon -> choose single-pass or chunked extraction -> curate with UPSERT -> verify applied file paths -> report status

**Timestamp:** 2026-05-21T09:34:56.226Z

**Author:** ByteRover context engineer

**Patterns:**
- `^300000$` - Required timeout value for code_exec calls containing mapExtract

## Narrative

### Structure

This knowledge records the curation workflow conventions used in RLM mode, including extraction, curation, and verification steps.

### Dependencies

Relies on recon metadata, optional mapExtract for chunked contexts, and the curate tool for final persistence.

### Highlights

The workflow explicitly favors single-pass curation for small contexts and UPSERT-based updates for consistency.

### Rules

Do NOT print raw context. Do NOT call tools.curation.recon when recon has already been computed. Proceed directly to extraction.

### Examples

Use single-pass when suggestedMode is single-pass; use mapExtract only when chunking is needed, with timeout 300000 at the code_exec level.

## Facts

- **rlm_curation_mode_selection**: Use recon first to determine whether curation should be single-pass or chunked. [convention]
- **rlm_single_pass_flow**: For small contexts, skip chunking entirely and curate directly after the available recon; when recon is precomputed, do not call recon again. [convention]
- **rlm_chunked_extraction_timeout**: For chunked contexts, use mapExtract with timeout 300000 on the code_exec call itself. [convention]
- **curate_operation_default**: Use UPSERT as the default curation operation. [convention]
- **curation_verification_rule**: After curation, verify result.summary.failed equals 0. [convention]
- **no_raw_context_printing**: Do not print raw context during curation. [convention]
- **precomputed_recon_handling**: Do not call tools.curation.recon when recon has already been pre-computed. [convention]
- **verification_method**: Verify curation using result.applied[].filePath instead of readFile. [convention]
