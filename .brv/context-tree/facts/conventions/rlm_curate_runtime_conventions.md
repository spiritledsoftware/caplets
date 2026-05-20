---
title: RLM Curate Runtime Conventions
summary: Runtime conventions for RLM curation, including precomputed recon usage and required sandbox variables.
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-20T14:24:21.257Z'
updatedAt: '2026-05-20T15:28:01.522Z'
---

## Reason

Capture the runtime curation instructions and variable conventions from the provided context

## Raw Concept

**Task:**
Document the runtime conventions for curation in RLM mode using the provided context variables and precomputed recon.

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

**Files:**
- .brv/context-tree/facts/conventions/rlm_curate_runtime_conventions.md

**Flow:**
context variable -> precomputed recon -> extraction -> curate -> verify via applied file paths

**Timestamp:** 2026-05-20T15:27:52.966Z

**Author:** ByteRover context engineer

**Patterns:**
- `^__curate_ctx_[a-f0-9_]+$` - Curate context variable naming pattern
- `^__curate_hist_[a-f0-9_]+$` - Curate history variable naming pattern
- `^__curate_meta_[a-f0-9_]+$` - Curate metadata variable naming pattern
- `^__taskId_[a-f0-9_]+$` - Curate task ID variable naming pattern

## Narrative

### Structure

This curation records the autonomous RLM workflow instructions, with emphasis on precomputed recon, single-pass processing, and direct verification from curate results.

### Dependencies

Depends on sandbox-injected context, history, metadata, task ID, and the precomputed recon result.

### Highlights

The input explicitly says not to call tools.curation.recon again and to avoid printing raw context.

### Rules

IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been precomputed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_29a79f97_36be_4187_b8a0_0e24253814f2 (bare variable, not a string). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples

The current recon result suggests single-pass mode with charCount 1472, lineCount 25, and messageCount 0.

## Facts

- **curate_workflow**: Curate using the RLM approach with precomputed recon. [convention]
- **context_variable**: The context variable is __curate_ctx_29a79f97_36be_4187_b8a0_0e24253814f2. [convention]
- **history_variable**: The history variable is __curate_hist_29a79f97_36be_4187_b8a0_0e24253814f2. [convention]
- **metadata_variable**: The metadata variable is __curate_meta_29a79f97_36be_4187_b8a0_0e24253814f2. [convention]
- **task_id_variable**: The task ID variable is __taskId_29a79f97_36be_4187_b8a0_0e24253814f2. [convention]
- **recon_mode**: Recon was already computed with suggestedMode single-pass and suggestedChunkCount 1. [convention]
