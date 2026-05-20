---
title: Curation Runtime Conventions
summary: 'Runtime conventions for curation workflows: use RLM variables, single-pass when suggested, do not print raw context, verify via curate result, and preserve detailed facts and structure.'
tags: []
related: []
keywords: []
createdAt: '2026-05-20T14:56:37.757Z'
updatedAt: '2026-05-20T17:10:10.808Z'
---
## Reason
Curate runtime instructions and task-specific curation rules from the provided RLM context

## Raw Concept
**Task:**
Document the curation runtime conventions for RLM-based context processing

**Changes:**
- Use precomputed recon results when available
- Proceed directly to extraction for single-pass contexts
- Verify curated outputs through applied file paths
- Defined immediate execution behavior for operations
- Established UPSERT as the preferred default curation action
- Captured RLM workflow guidance for variable-based curation prompts
- Recorded single-pass recon handling for small contexts
- Use the precomputed recon result instead of calling recon again
- Proceed directly to extraction in single-pass mode
- Use groupBySubject and dedup to organize extracted facts
- Verify curated outputs through result.applied[].filePath
- Established the single-pass path when recon recommends it
- Documented the required timeout for mapExtract-based extraction
- Captured the verification rule using result.applied[].filePath

**Flow:**
recon -> choose mode -> extract or curate -> verify via curate result

**Timestamp:** 2026-05-20T17:10:03.093Z

**Author:** ByteRover context engine

## Narrative
### Structure
This knowledge captures the operating rules for RLM curation runs, including mode selection and verification expectations.

### Dependencies
Relies on precomputed recon output and sandbox variables for context, history, metadata, and task ID.

### Highlights
The instructions emphasize not printing raw context, using single-pass when suggested, and preserving only compact summaries during curation.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId: __taskId_315cb313_abe8_40eb_97b1_c8fe949ba458 (bare variable, not a string). IMPORTANT: Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extractions. Verify via result.applied[].filePath — do NOT call readFile for verification.

## Facts
- **rlm_curation_workflow**: The current curation workflow uses the RLM approach with context, history, metadata, and task ID variables. [convention]
- **single_pass_mode**: When recon suggests single-pass, chunking should be skipped. [convention]
- **mapextract_timeout**: If mapExtract is used, the code_exec call must set timeout to 300000 milliseconds. [convention]
- **verification_method**: Verification should be done via result.applied[].filePath without reading files back. [convention]
