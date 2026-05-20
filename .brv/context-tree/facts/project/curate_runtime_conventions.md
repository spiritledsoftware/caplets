---
title: Curate Runtime Conventions
summary: 'Runtime conventions for curation: use RLM recon first, prefer single-pass when suggested, use mapExtract for chunked contexts, and verify curated file paths via result.applied.'
tags: []
related: [facts/conventions/context.md, facts/project/context.md]
keywords: []
createdAt: '2026-05-20T14:16:38.968Z'
updatedAt: '2026-05-20T18:36:27.951Z'
---

## Reason

Persist runtime curation conventions from the provided context

## Raw Concept

**Task:**
Document runtime conventions for RLM-based curation of context variables.

**Changes:**
- Added a combined recon workflow recommendation
- Specified single-pass handling for small contexts
- Preserved verification requirements for curation results
- Use the precomputed recon result instead of calling tools.curation.recon again
- Proceed directly to extraction in single-pass mode when suggested
- Verify curation results through result.applied[].filePath
- Recorded recon-guided single-pass curation behavior
- Recorded mapExtract timeout requirement
- Recorded UPSERT preference and verification rule
- Captured the single-pass curation path for precomputed recon results
- Recorded tool usage constraints for recon, mapExtract, and verification
- Captured the required RLM curation workflow.
- Recorded the preferred UPSERT-based curation pattern.
- Preserved the verification rule using result.applied[].filePath.
- Use recon before curation when context is available
- Prefer single-pass handling when recon suggests it
- Use mapExtract for chunked contexts with taskId passed as a bare variable
- Verify curation via result.applied[].filePath
- Established recon-first curation workflow
- Preferred single-pass processing for small contexts
- Defined verification via curate results instead of rereading files
- Captured precomputed recon guidance
- Captured single-pass versus chunked extraction guidance
- Captured verification requirements

**Files:**
- .brv/context-tree/facts/conventions/context.md

**Flow:**
recon -> choose single-pass or chunked extraction -> curate -> verify applied file paths

**Timestamp:** 2026-05-20T18:36:17.812Z

**Author:** ByteRover context engineer

**Patterns:**
- `^single-pass$` - Suggested mode for small contexts
- `^chunked$` - Suggested mode for larger contexts

## Narrative

### Structure

The context describes how to process curation inputs using precomputed recon, then either direct single-pass curation or chunked mapExtract processing.

### Dependencies

Depends on precomputed recon output, tools.curation.mapExtract for chunked extraction, and tools.curate for persistence.

### Highlights

Suggested mode is single-pass for this context; do not print raw context and do not use recon again.

### Rules

Do not call tools.curation.recon again when recon is already computed. Do not print raw context. Verify via result.applied[].filePath and result.summary.failed.

## Facts

- **curation_workflow**: The curation workflow uses RLM approach with precomputed recon data when available. [convention]
- **single_pass_mode**: When recon suggests single-pass, chunking should be skipped. [convention]
- **map_extract_usage**: For chunked extraction, tools.curation.mapExtract() should be used with taskId passed as a bare variable. [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must set timeout to 300000 on the tool call itself. [convention]
- **verification_method**: Verification must use result.applied[].filePath and must not call readFile for verification. [convention]
