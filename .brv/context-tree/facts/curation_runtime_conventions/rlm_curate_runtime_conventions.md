---
title: RLM Curate Runtime Conventions
summary: RLM curation workflow conventions covering recon, single-pass extraction, chunked extraction, verification, and status reporting.
tags: []
related: []
keywords: []
createdAt: '2026-05-21T09:26:17.953Z'
updatedAt: '2026-05-21T09:26:17.953Z'
---

## Reason

Curate runtime conventions and workflow guidance from RLM context

## Raw Concept

**Task:**
Document the RLM curation workflow and runtime requirements for this session type.

**Changes:**
- Captured the single-pass recommendation for this context.
- Recorded the chunked extraction requirement for mapExtract with bare taskId.
- Recorded the 300000 ms timeout rule for code_exec calls that use mapExtract.
- Recorded the verification rule using result.applied[].filePath.

**Flow:**
recon -> single-pass extraction or mapExtract -> curate -> verify applied file paths -> report status

**Timestamp:** 2026-05-21T09:26:08.126Z

**Patterns:**
- `^taskId:\s*__taskId_[a-f0-9_]+$` - Task ID should be passed as a bare variable identifier in mapExtract calls

## Narrative

### Structure

This entry captures the operational curation flow used for RLM-based curation, including when to skip chunking and how to verify applied files.

### Dependencies

Depends on the precomputed recon result, the curation runtime helpers, and the task-id variable injected into the sandbox.

### Highlights

The guidance emphasizes not printing raw context, not recomputing recon, and verifying success via applied file paths rather than re-reading files.

### Rules

Do NOT print raw context. Do NOT call tools.curation.recon when recon has already been computed. For chunked extraction, pass taskId as a bare variable. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself. Verify via result.applied[].filePath and do NOT call readFile for verification.

## Facts

- **recon_suggested_mode**: Recon already computed suggestedMode=single-pass for this curation context. [convention]
- **curation_context_size**: The context size was 3162 chars, 69 lines, and 0 messages. [convention]
- **mapextract_taskid**: For chunked extraction, tools.curation.mapExtract() must receive taskId as a bare variable. [convention]
- **mapextract_timeout_requirement**: Any code_exec call containing mapExtract must use timeout: 300000 on the code_exec tool call itself. [convention]
- **verification_method**: Verification for curation should use result.applied[].filePath and must not call readFile for verification. [convention]
