---
title: RLM Curation Run Requirements
summary: RLM curation runs use pre-computed single-pass recon for small contexts, require mapExtract timeout at the tool-call level when used, and verify through applied file paths.
tags: []
related: [facts/conventions/rlm_curation_single_pass_mode.md, facts/conventions/rlm_curation_run_conventions.md, facts/conventions/context.md]
keywords: []
createdAt: '2026-05-25T10:03:04.676Z'
updatedAt: '2026-05-25T10:19:24.663Z'
---
## Reason
Capture explicit curation-run instructions and verification constraints from the provided context.

## Raw Concept
**Task:**
Document the required RLM curation run procedure for this session

**Changes:**
- Use recon-suggested single-pass mode for small contexts
- Pass taskId as a bare variable to mapExtract
- Set the outer code_exec timeout to 300000 ms for mapExtract
- Verify curation via result.applied[].filePath without readFile
- Captured the precomputed recon result usage for single-pass handling
- Captured the required timeout rule for mapExtract calls
- Captured the verification rule using applied file paths
- Recorded pre-computed recon usage for single-pass mode
- Recorded timeout requirement for mapExtract tool calls
- Recorded verification rule using applied file paths

**Flow:**
precomputed recon -> single-pass extraction -> curate -> verify applied file paths

**Timestamp:** 2026-05-25T10:19:14.056Z

**Author:** ByteRover context engineer

**Patterns:**
- `^single-pass$` - Suggested mode for the provided compact context

## Narrative
### Structure
This knowledge captures the run-level instructions governing how the current curation task must be processed.

### Dependencies
Depends on the pre-computed recon result and the provided context/history/metadata variables.

### Highlights
Single-pass mode is already suggested; mapExtract is only relevant for chunked extraction, and if used it requires a 300000 ms timeout at the code_exec call level.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction.
IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options).
Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **rlm_curation_mode**: Curation runs must use the RLM approach with pre-computed recon in single-pass mode for small contexts. [convention]
- **mapextract_timeout**: When mapExtract is used, the code_exec call containing it must use timeout 300000 at the tool-call level. [convention]
- **verification_method**: Verification must use result.applied[].filePath and must not call readFile for verification. [convention]
- **curation_context_size**: The context payload for this curation run is small: 1307 chars, 26 lines, and 0 messages. [project]
