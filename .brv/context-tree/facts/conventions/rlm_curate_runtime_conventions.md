---
title: RLM Curate Runtime Conventions
summary: RLM curation runtime conventions covering single-pass handling, mapExtract timeout/taskId usage, and verification via applied file paths
tags: []
related: [facts/conventions/context.md, facts/project/context.md]
keywords: []
createdAt: '2026-05-20T14:24:21.257Z'
updatedAt: '2026-05-21T10:03:56.798Z'
---
## Reason
Capture runtime instructions and verification rules from the curation context

## Raw Concept
**Task:**
Document the runtime conventions for RLM curation execution and verification

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

**Files:**
- .brv/context-tree/facts/conventions/rlm_curate_runtime_conventions.md

**Flow:**
recon -> single-pass curate -> verify applied file paths -> record progress

**Timestamp:** 2026-05-21T10:03:50.667Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This knowledge captures execution constraints for RLM curation, including how to proceed when recon has already recommended single-pass processing.

### Dependencies
Depends on the curation sandbox helpers: tools.curate(), tools.curation.mapExtract(), and result.applied verification data.

### Highlights
Preserves the instruction set for autonomous curation, including the required timeout for mapExtract calls and the prohibition on readFile-based verification.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable, not a string. IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples
The current recon result suggests single-pass mode with charCount 1472, lineCount 25, and messageCount 0.

## Facts
- **rlm_curation_mode**: Context is a curated RLM curation workflow note with recon already computed and suggestedMode single-pass [convention]
- **map_extract_timeout_and_taskid**: For chunked extraction, tools.curation.mapExtract() must receive taskId as a bare variable and code_exec timeout must be 300000 [convention]
- **verification_method**: Verification should use result.applied[].filePath and must not call readFile for verification [convention]
