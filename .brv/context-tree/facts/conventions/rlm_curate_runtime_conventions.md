---
title: RLM Curate Runtime Conventions
summary: RLM curation conventions for single-pass handling, mapExtract timeout requirements, and verification via applied file paths
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-20T14:24:21.257Z'
updatedAt: '2026-05-20T17:58:07.189Z'
---
## Reason
Record the runtime conventions for RLM curation execution

## Raw Concept
**Task:**
Document RLM curation runtime conventions for handling precomputed recon and extraction flow

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

**Files:**
- .brv/context-tree/facts/conventions/rlm_curate_runtime_conventions.md

**Flow:**
precomputed recon -> single-pass decision -> direct curate -> verify applied file paths

**Timestamp:** 2026-05-20T17:58:00.375Z

**Author:** ByteRover context engineer

## Narrative
### Structure
Captures the runtime rules governing RLM curation execution and verification.

### Dependencies
Depends on precomputed recon metadata and the curate result payload.

### Highlights
This task is single-pass and should not invoke recon again. The execution should preserve the verification rule that uses applied file paths.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been precomputed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_29a79f97_36be_4187_b8a0_0e24253814f2 (bare variable, not a string). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples
The current recon result suggests single-pass mode with charCount 1472, lineCount 25, and messageCount 0.

## Facts
- **rlm_curation_recon_step**: RLM curation tasks must start with tools.curation.recon, but recon was already precomputed for this task. [convention]
- **single_pass_mode**: When recon suggests single-pass, chunking and mapExtract are skipped. [convention]
- **mapextract_timeout**: For chunked extraction, tools.curation.mapExtract must be called with timeout 300000 on the code_exec call itself. [convention]
- **verification_method**: Verification of curation should use result.applied[].filePath and not readFile. [convention]
