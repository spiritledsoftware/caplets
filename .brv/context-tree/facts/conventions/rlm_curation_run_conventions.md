---
title: RLM Curation Run Conventions
summary: RLM curation run conventions for single-pass execution, mapExtract timeout, bare taskId usage, and verification via applied file paths
tags: []
related: [facts/conventions/rlm_curation_single_pass_mode.md, facts/conventions/rlm_single_pass_curation_run_requirements.md]
keywords: []
createdAt: '2026-05-24T18:39:19.487Z'
updatedAt: '2026-05-24T19:10:11.003Z'
---
## Reason
Document the observed RLM curation run rules and verification requirements

## Raw Concept
**Task:**
Document the RLM curation run conventions used for this session

**Changes:**
- Single-pass mode is used when recon suggests single-pass
- mapExtract calls require timeout 300000 on the code_exec call
- taskId must be passed as a bare variable
- Verification uses result.applied[].filePath instead of readFile
- Single-pass mode is used when recon recommends it
- Chunked extraction uses tools.curation.mapExtract
- Verification relies on result.applied[].filePath rather than readFile

**Flow:**
recon -> single-pass extract -> curate -> verify applied file paths

**Timestamp:** 2026-05-24T19:10:02.801Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This note captures the execution rules for RLM curation runs, including when to skip chunking and how to verify curated output.

### Dependencies
Depends on recon guidance, tools.curation.mapExtract for chunked extraction, and tools.curate for persistence.

### Highlights
Single-pass mode is recommended for small contexts; mapExtract calls require a 300000 ms timeout at the code_exec level; verification is based on applied file paths.

## Facts
- **rlm_curation_mode**: RLM curation uses a single-pass mode when recon suggests single-pass [convention]
- **rlm_curation_workflow**: For single-pass contexts, the workflow skips chunking and proceeds directly from recon to curate [convention]
- **rlm_curation_extraction**: When context is chunked, tools.curation.mapExtract is used for parallel extraction [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must use timeout 300000 on the tool call itself [convention]
- **mapextract_taskid**: The taskId must be passed as a bare variable, not a string, when calling mapExtract [convention]
- **curation_verification**: Curation verification should use result.applied[].filePath and should not call readFile for verification [convention]
