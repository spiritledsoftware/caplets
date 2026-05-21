---
title: Curation Runtime Conventions
summary: Curation runtime conventions for RLM-based context processing, including recon-first flow, silent reads, chunked extraction, verification, and UPSERT-first curation.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T14:56:37.757Z'
updatedAt: '2026-05-21T10:14:09.770Z'
---

## Reason

Capture runtime conventions and workflow constraints from the provided curation context

## Raw Concept

**Task:**
Document runtime conventions for RLM curation using the provided context variables and precomputed recon result.

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
- Prefer single-pass processing for compact contexts
- Verify curation via applied file paths
- Single-pass curation is recommended for compact contexts
- mapExtract requires timeout 300000 on the code_exec call when used
- Use tools.curation.groupBySubject() and tools.curation.dedup() to organize extracted facts
- Preserved the single-pass recommendation
- Captured mapExtract timeout and taskId invocation constraints
- Recorded verification guidance and extraction organization helpers

**Flow:**
recon already computed -> extract directly -> group and dedup facts -> curate -> verify by filePath

**Timestamp:** 2026-05-21T10:14:03.666Z

**Author:** ByteRover context engineering workflow

**Patterns:**
- `^timeout:\s*300000$` - Required timeout for code_exec calls containing mapExtract

## Narrative

### Structure

This note captures the operational conventions for curating RLM context: do not rerun recon when single-pass is suggested, keep extraction organized with grouping and deduplication, and verify by inspecting applied file paths.

### Dependencies

Depends on the precomputed recon result and the sandbox variables supplied for context, history, metadata, and task ID.

### Highlights

The workflow emphasizes immediate execution, single-pass handling for small contexts, and UPSERT-based curation with file-path verification.

### Rules

Do NOT print raw context. Do NOT call tools.curation.recon when recon is already precomputed. For chunked extraction, pass taskId as a bare variable. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself.

## Facts

- **rlm_curation_approach**: Curate tasks should use the RLM approach with the provided context, history, metadata, and task ID variables. [convention]
- **recon_single_pass**: Recon is already computed and should not be called again when suggestedMode is single-pass. [convention]
- **mapextract_task_id**: For chunked extraction, tools.curation.mapExtract requires taskId to be passed as a bare variable. [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must use timeout: 300000 on the code_exec tool call itself. [convention]
- **verification_via_file_path**: Verification should be done via result.applied[].filePath and should not use readFile for verification. [convention]
- **extraction_organization**: tools.curation.groupBySubject and tools.curation.dedup should be used to organize extractions. [convention]
