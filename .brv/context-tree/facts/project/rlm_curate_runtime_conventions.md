---
title: RLM Curate Runtime Conventions
summary: RLM curation uses precomputed recon, single-pass processing for small contexts, mapExtract for chunked contexts, and verification via applied file paths.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T15:10:55.428Z'
updatedAt: '2026-05-20T17:07:06.627Z'
---
## Reason
Curate runtime conventions from RLM context

## Raw Concept
**Task:**
Document the runtime conventions for RLM curation workflows

**Changes:**
- The context variable is small enough for single-pass processing.
- Recon was already computed and should not be repeated.
- mapExtract is reserved for chunked extraction paths.
- Verification should rely on the curate result rather than filesystem reads.
- Recorded the recon-first workflow for RLM curation
- Captured the single-pass optimization path
- Preserved chunked extraction and verification constraints
- Stored task-specific execution requirements for mapExtract and timeout handling
- Established single-pass handling for small contexts
- Established mapExtract usage for chunked contexts
- Established verification via applied file paths

**Flow:**
precomputed recon -> choose suggested mode -> direct curate or mapExtract -> verify applied file paths

**Timestamp:** 2026-05-20T17:06:50.241Z

## Narrative
### Structure
The convention set governs how to process RLM curation inputs depending on recon output. Small contexts are handled in a single pass, while larger inputs use chunked extraction.

### Dependencies
Depends on precomputed recon metadata, taskId propagation, and curate result verification fields.

### Highlights
The workflow emphasizes no redundant recon call, no raw context printing, and explicit timeout requirements for mapExtract.

### Rules
Do NOT print raw context. Do NOT call tools.curation.recon when recon is already computed. For chunked extraction use tools.curation.mapExtract() and pass taskId as a bare variable. Verify via result.applied[].filePath and do NOT call readFile for verification.

## Facts
- **rlm_recon_precomputed**: For RLM curation, recon is precomputed and should not be called again when provided. [convention]
- **single_pass_mode**: When suggestedMode is single-pass, skip chunking and curate directly. [convention]
- **map_extract_usage**: When chunked extraction is needed, tools.curation.mapExtract() should be used with taskId passed as a bare variable. [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must use timeout 300000 on the code_exec tool call itself. [convention]
- **verification_method**: Verification should use result.applied[].filePath and must not use readFile for verification. [convention]
