---
title: Curate Runtime Conventions
summary: Curation runtime conventions for using recon, single-pass processing, and verification via curate results.
tags: []
related: [facts/conventions/context.md, facts/project/context.md]
keywords: []
createdAt: '2026-05-20T14:16:38.968Z'
updatedAt: '2026-05-20T15:37:12.996Z'
---

## Reason

Preserve runtime conventions for curation workflow and verification

## Raw Concept

**Task:**
Document runtime conventions for RLM curation flow

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

**Files:**
- .brv/context-tree/facts/conventions/context.md

**Flow:**
recon -> mode selection -> direct curate -> verify applied file paths and summary

**Timestamp:** 2026-05-20T15:37:06.625Z

**Author:** ByteRover context engineer

**Patterns:**
- `^single-pass$` - Suggested mode for small contexts
- `^chunked$` - Suggested mode for larger contexts

## Narrative

### Structure

This knowledge captures how to curate context efficiently when recon already recommends single-pass processing.

### Dependencies

Depends on the precomputed recon result, the sandbox curate API, and the task/history metadata for traceability.

### Highlights

The workflow avoids chunking for small contexts and avoids file rereads by checking curate application results directly.

### Rules

Do not call tools.curation.recon again when recon is already computed. Do not print raw context. Verify via result.applied[].filePath and result.summary.failed.

## Facts

- **curate_recon**: Use recon before curation to assess context and choose a mode. [convention]
- **curate_mode**: When recon suggests single-pass, skip chunking and curate in two code_exec calls. [convention]
- **raw_context_output**: Do not print raw context during curation. [convention]
- **curate_verification**: Verify curation using result.applied[].filePath and result.summary.failed. [convention]
