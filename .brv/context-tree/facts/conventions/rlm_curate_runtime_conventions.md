---
title: RLM Curate Runtime Conventions
summary: RLM curation runtime conventions for single-pass processing, extraction, verification, and history recording.
tags: []
related: [facts/conventions/context.md, facts/project/context.md]
keywords: []
createdAt: '2026-05-20T14:24:21.257Z'
updatedAt: '2026-05-21T10:21:39.246Z'
---

## Reason

Capture the curation runtime instructions and operational constraints from the current RLM context.

## Raw Concept

**Task:**
Document the RLM curation runtime conventions used for this session.

**Changes:**
- Use single-pass mode when recon already recommends it
- Keep extraction timeout at 300000 for mapExtract calls made from code_exec
- Verify curation via applied file paths instead of readFile
- Use precomputed recon instead of recalculating it
- Proceed directly to extraction when suggestedMode is single-pass
- Verify curate output via applied file paths
- Use recon first, then choose single-pass or chunked extraction based on suggestedMode
- For chunked contexts, use tools.curation.mapExtract() with taskId passed as a bare variable
- Verify curation via result.applied[].filePath and result.summary.failed === 0
- Do not print raw context during curation
- Established that precomputed recon should be trusted
- Defined single-pass flow for small contexts
- Captured timeout and taskId requirements for mapExtract
- Recorded verification constraints for curate results
- Precomputed recon is available and must be reused.
- Single-pass mode is recommended for this small context.
- Verification must use applied file paths rather than readFile checks.
- Use recon-precomputed single-pass processing when suggestedMode is single-pass
- Use mapExtract with a 300000ms code_exec timeout when chunked extraction is needed
- Pass taskId as a bare variable for mapExtract calls
- Verify curated files through result.applied[].filePath rather than readFile
- Use the precomputed recon result instead of recomputing it
- Proceed directly to extraction in single-pass mode
- Pass the task ID as a bare variable when using mapExtract
- Verify curation through result.applied file paths rather than readFile
- Single-pass recon results should bypass chunking
- mapExtract timeout requirement is 300000 for code_exec calls
- Verification should rely on applied file paths rather than readFile
- Established single-pass handling when recon indicates a small context.
- Recorded mapExtract timeout and taskId passing requirements.
- Captured verification guidance for curate results.
- Recon is precomputed and single-pass should be used for this context
- mapExtract requires a bare taskId variable when chunking is needed
- Verification should rely on applied file paths instead of readFile
- Use pre-computed recon instead of calling recon again.
- Proceed directly to extraction for single-pass contexts.
- Enforce bare-variable taskId and 300000 ms timeout for mapExtract calls.
- Verify curation results via result.applied[].filePath without readFile.
- Use precomputed recon results instead of recomputing reconnaissance.
- Proceed directly to extraction when suggestedMode is single-pass.
- Verify curated outputs through applied file paths rather than read-back verification.

**Files:**
- .brv/context-tree/facts/conventions/rlm_curate_runtime_conventions.md

**Flow:**
precomputed recon -> extraction -> curate -> verify applied paths -> record progress

**Timestamp:** 2026-05-21T10:21:32.929Z

**Author:** ByteRover context engineer

**Patterns:**
- `timeout: 300000` - Required timeout for any code_exec call containing mapExtract
- `taskId: __taskId_*` - Pass taskId as a bare variable, not a string
- `result.applied[].filePath` - Verification source for curated file paths

## Narrative

### Structure

This note captures the operational rules for running RLM curation in single-pass mode, including the constraint to avoid printing raw context and the requirement to use the provided taskId for extraction when needed.

### Dependencies

Depends on precomputed recon data, the context/history/metadata variables, and the curated knowledge tree as the target store.

### Highlights

The run explicitly forbids calling tools.curation.recon again and instructs verification via result.applied[].filePath only.

### Rules

IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction.
For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_d37d89f0_90c3_484b_bc24_c0395c2fca73 (bare variable, not a string).
IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options).
Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples

The current recon result suggests single-pass mode with charCount 1472, lineCount 25, and messageCount 0.

## Facts

- **rlm_curation_mode**: This curation run uses the RLM approach with single-pass extraction. [convention]
- **curation_context_size**: The provided context is 4846 characters long and contains 53 lines. [project]
